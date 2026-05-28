const { app, BrowserWindow, ipcMain, globalShortcut } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const sharp = require('sharp');
const QRCode = require('qrcode');
const axios = require('axios');
const FormData = require('form-data');
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const os = require('os');

// ===== CONFIG =====
const isDev = process.env.BOOTH_DEV === 'true';
const env = {};
const envFile = path.join(__dirname, '.env');
if (fs.existsSync(envFile)) {
  fs.readFileSync(envFile, 'utf-8').split('\n').forEach(line => {
    const [k, v] = line.split('=');
    if (k && v) env[k.trim()] = v.trim();
  });
}
const CLOUDINARY_CLOUD_NAME    = env.CLOUDINARY_CLOUD_NAME    || '';
const CLOUDINARY_UPLOAD_PRESET = env.CLOUDINARY_UPLOAD_PRESET || '';
const HTTP_PORT      = parseInt(env.PORT || '3000', 10);
const INACTIVITY_MS  = 3 * 60 * 1000; // 3 minutes

// ===== PATHS =====
const outputDir = path.join(__dirname, 'output');
const assetsDir = path.join(__dirname, 'assets');
const logFile   = path.join(outputDir, 'booth.log');
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

// ===== LOCAL IP =====
function getLocalIP() {
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name]) {
      if (net.family === 'IPv4' && !net.internal) return net.address;
    }
  }
  return 'localhost';
}
const localIP = getLocalIP();

// ===== LOCAL HTTP SERVER FOR SAVE PAGE =====
// Phones on the same WiFi network use this to view and save their strips.
const httpApp = express();
httpApp.use('/photos', express.static(outputDir));
httpApp.get('/save/:sessionId', (_req, res) =>
  res.sendFile(path.join(__dirname, 'renderer', 'save.html'))
);
httpApp.get('/api/session/:sessionId', (req, res) => {
  const dir = path.join(outputDir, req.params.sessionId);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'not found' });
  res.json({
    vertical:   `/photos/${req.params.sessionId}/strip_vertical.jpg`,
    horizontal: `/photos/${req.params.sessionId}/strip_horizontal.jpg`,
  });
});
httpApp.listen(HTTP_PORT, '0.0.0.0');

// ===== STATE =====
let mainWindow;
let currentState  = 'SLEEP';
let sessionId     = null;
let sessionFolder = null;
let liveViewProcess = null;
let inactivityTimer = null;
let sessionsCompleted = 0;

// ===== LOGGING =====
function log(msg) {
  const line = `[${new Date().toISOString()}] ${msg}`;
  console.log(line);
  try { fs.appendFileSync(logFile, line + '\n'); } catch (_) {}
}

// ===== UTILITIES =====
function executeCommand(cmd, args = []) {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '', err = '';
    proc.stdout.on('data', d => { out += d; });
    proc.stderr.on('data', d => { err += d; });
    proc.on('close', code => code === 0 ? resolve(out) : reject(new Error(`${cmd}: ${err}`)));
    proc.on('error', reject);
  });
}

async function checkGphoto2() {
  try { await executeCommand('gphoto2', ['--version']); return true; }
  catch (e) { log('ERROR: gphoto2 not found – ' + e.message); return false; }
}

async function checkCamera() {
  try {
    const out = await executeCommand('gphoto2', ['--auto-detect']);
    return out.includes('FUJIFILM') || out.includes('USB');
  } catch (e) { log('Camera check failed: ' + e.message); return false; }
}

// ===== CAMERA =====
function stopLiveView() {
  if (liveViewProcess) {
    try { liveViewProcess.kill(); } catch (_) {}
    liveViewProcess = null;
  }
}

function startLiveView() {
  stopLiveView();
  try {
    liveViewProcess = spawn('gphoto2', ['--stdout', '--capture-movie'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let buf = Buffer.alloc(0);

    liveViewProcess.stdout.on('data', chunk => {
      buf = Buffer.concat([buf, chunk]);
      while (true) {
        const start = buf.indexOf(Buffer.from([0xff, 0xd8]));
        if (start === -1) { buf = buf.slice(Math.max(0, buf.length - 1_000_000)); break; }
        if (start > 0) buf = buf.slice(start);
        const end = buf.indexOf(Buffer.from([0xff, 0xd9]), 2);
        if (end === -1) break;
        const frame = buf.slice(0, end + 2);
        buf = buf.slice(end + 2);
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.webContents.send('live-view-frame', frame.toString('base64'));
        }
      }
    });

    liveViewProcess.stderr.on('data', d => log('gphoto2 stderr: ' + d.toString().trim()));
    liveViewProcess.on('error', err => { log('Live view error: ' + err.message); send('camera-error', 'Live view failed'); });
  } catch (e) {
    log('Failed to start live view: ' + e.message);
    send('camera-error', 'Could not start camera');
  }
}

async function capturePhoto(photoIndex) {
  if (!sessionFolder) { send('photo-captured', { photoIndex, filePath: null }); return; }
  const outPath = path.join(sessionFolder, `photo_${photoIndex}.jpg`);

  return new Promise(resolve => {
    const proc = spawn('gphoto2', ['--capture-image-and-download', '--filename', outPath, '--force-overwrite']);
    let done = false;

    const finish = (ok) => {
      if (done) return;
      done = true;
      if (ok) { log(`Photo ${photoIndex} saved: ${outPath}`); send('photo-captured', { photoIndex, filePath: outPath }); }
      else     { log(`Photo ${photoIndex} capture failed`);    send('photo-captured', { photoIndex, filePath: null }); }
      resolve();
    };

    proc.on('close', code => finish(code === 0));
    proc.on('error', ()  => finish(false));
    setTimeout(() => finish(false), 20_000);
  });
}

// ===== IMAGE PROCESSING =====
async function blackBuffer(w, h) {
  return sharp({ create: { width: w, height: h, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .jpeg({ quality: 92 }).toBuffer();
}

async function resizePhoto(p, w, h) {
  return sharp(p).resize(w, h, { fit: 'cover', position: 'center' }).toBuffer();
}

// 3-photo strip layout:
//   Vertical  – canvas 1200×2440, slots 1080×720
//   Horizontal – canvas 3480×960, slots 1080×720
async function buildStrip(isVertical) {
  const canvasW = isVertical ? 1200 : 3480;
  const canvasH = isVertical ? 2440 :  960;
  const slotW   = 1080, slotH = 720;

  const slots = isVertical
    ? [{ x:   60, y:   80 }, { x:   60, y:  860 }, { x:   60, y: 1640 }]
    : [{ x:   60, y:  120 }, { x: 1200, y:  120 }, { x: 2340, y:  120 }];

  const layers = [];
  for (let i = 1; i <= 3; i++) {
    const p = path.join(sessionFolder, `photo_${i}.jpg`);
    let buf;
    try { buf = fs.existsSync(p) ? await resizePhoto(p, slotW, slotH) : await blackBuffer(slotW, slotH); }
    catch (e) { log(`Strip resize error photo ${i}: ${e.message}`); buf = await blackBuffer(slotW, slotH); }
    layers.push({ input: buf, left: slots[i - 1].x, top: slots[i - 1].y });
  }

  let composite = sharp({
    create: { width: canvasW, height: canvasH, channels: 3, background: { r: 0, g: 0, b: 0 } },
  }).composite(layers);

  const tplName = isVertical ? 'template-vertical.png' : 'template-horizontal.png';
  const tplPath = path.join(assetsDir, tplName);
  if (fs.existsSync(tplPath)) {
    try {
      const tpl = await sharp(tplPath)
        .resize(canvasW, canvasH, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .toBuffer();
      composite = composite.composite([{ input: tpl, left: 0, top: 0 }]);
    } catch (e) { log('Template error: ' + e.message); }
  }

  const outName = isVertical ? 'strip_vertical.jpg' : 'strip_horizontal.jpg';
  const outPath = path.join(sessionFolder, outName);
  await composite.jpeg({ quality: 92 }).toFile(outPath);
  log('Strip: ' + outPath);
  return outPath;
}

// ===== CLOUDINARY (best-effort, non-blocking) =====
function uploadToCloudinary(filePath) {
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_UPLOAD_PRESET) return;
  const fd = new FormData();
  fd.append('file', fs.createReadStream(filePath));
  fd.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);
  axios.post(`https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`, fd,
    { headers: fd.getHeaders(), timeout: 30_000 })
    .then(r => log('Cloudinary OK: ' + r.data.secure_url))
    .catch(e => log('Cloudinary failed: ' + e.message));
}

// ===== PROCESSING PIPELINE =====
async function processSession() {
  try {
    send('processing-status', 'Developing your photos…');
    const [vPath, hPath] = await Promise.all([buildStrip(true), buildStrip(false)]);

    send('processing-status', 'Generating your QR code…');

    // QR always points to local save page (works on same WiFi, no internet required)
    const folderName = path.basename(sessionFolder);
    const saveUrl    = `http://${localIP}:${HTTP_PORT}/save/${folderName}`;
    const qrDataUrl  = await QRCode.toDataURL(saveUrl, {
      width: 360, margin: 2, color: { dark: '#000000', light: '#ffffff' },
    });

    // Background Cloudinary upload (optional, for backup)
    uploadToCloudinary(vPath);

    fs.writeFileSync(path.join(sessionFolder, 'session.json'),
      JSON.stringify({ timestamp: new Date().toISOString(), saveUrl }, null, 2));

    transitionToState('SHARE');
    send('session-complete', { vPath, hPath, qrDataUrl, saveUrl });
  } catch (err) {
    log('Processing pipeline error: ' + err.message);
    send('processing-status', 'Something went wrong — please see the attendant.');
  }
}

// ===== STATE MACHINE =====
function send(channel, data) {
  if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, data);
}

function startInactivityTimer() {
  clearInactivityTimer();
  inactivityTimer = setTimeout(() => {
    if (currentState === 'SHARE') { log('Auto-reset: inactivity'); transitionToState('SLEEP'); }
  }, INACTIVITY_MS);
}

function clearInactivityTimer() {
  if (inactivityTimer) { clearTimeout(inactivityTimer); inactivityTimer = null; }
}

function transitionToState(newState) {
  if (currentState === newState) return;
  log(`State: ${currentState} → ${newState}`);
  currentState = newState;

  switch (newState) {
    case 'SLEEP':
      stopLiveView();
      clearInactivityTimer();
      sessionId = null; sessionFolder = null;
      break;
    case 'LIVE':
      startLiveView();
      break;
    case 'PROCESSING':
      stopLiveView();
      clearInactivityTimer();
      break;
    case 'SHARE':
      stopLiveView();
      sessionsCompleted++;
      if (sessionsCompleted % 10 === 0) log(`Battery check: ${sessionsCompleted} sessions done`);
      startInactivityTimer();
      break;
  }

  send('state-change', newState);
}

// ===== IPC HANDLERS =====
ipcMain.on('wake-from-sleep', () => {
  if (currentState !== 'SLEEP') return;
  // Assign a fresh session folder using timestamp + short UUID
  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  sessionId     = uuidv4().slice(0, 8);
  sessionFolder = path.join(outputDir, `${ts}_${sessionId}`);
  fs.mkdirSync(sessionFolder, { recursive: true });
  log('New session: ' + sessionFolder);
  transitionToState('LIVE');
});

ipcMain.on('start-session', () => {
  if (currentState !== 'LIVE') return;
  transitionToState('COUNTDOWN');
});

ipcMain.on('request-capture', (_e, photoIndex) => {
  capturePhoto(photoIndex);
});

ipcMain.on('start-processing', () => {
  transitionToState('PROCESSING');
  processSession();
});

ipcMain.on('cancel-to-sleep', () => transitionToState('SLEEP'));

// ===== KEYBOARD SHORTCUTS =====
function registerShortcuts() {
  // Block common quit/minimize shortcuts in kiosk mode
  ['CommandOrControl+W', 'CommandOrControl+Q', 'CommandOrControl+H',
   'CommandOrControl+M', 'Alt+Tab', 'CommandOrControl+Tab'].forEach(k => {
    try { globalShortcut.register(k, () => {}); } catch (_) {}
  });
  if (isDev) {
    globalShortcut.register('CommandOrControl+Shift+Q', () => app.quit());
    globalShortcut.register('CommandOrControl+Shift+I', () => {
      if (mainWindow) mainWindow.webContents.toggleDevTools();
    });
  }
}

// ===== ELECTRON WINDOW =====
async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1920, height: 1080,
    fullscreen: !isDev,
    kiosk: !isDev,
    frame: isDev,
    alwaysOnTop: !isDev,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (isDev) mainWindow.webContents.openDevTools();
  mainWindow.on('blur', () => { if (!isDev) mainWindow.focus(); });

  if (!(await checkGphoto2())) {
    const { dialog } = require('electron');
    dialog.showErrorBox('gphoto2 not found', 'Install: brew install gphoto2\nThen restart the app.');
    app.quit(); return;
  }
  if (!(await checkCamera())) log('WARNING: Camera not detected at startup');

  registerShortcuts();
  log(`Ready — network save page: http://${localIP}:${HTTP_PORT}`);
}

app.on('ready', createWindow);
app.on('window-all-closed', () => { globalShortcut.unregisterAll(); stopLiveView(); if (process.platform !== 'darwin') app.quit(); });
app.on('activate', () => { if (!mainWindow) createWindow(); });
process.on('exit', () => { globalShortcut.unregisterAll(); stopLiveView(); });
