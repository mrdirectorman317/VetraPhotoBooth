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
const GEMINI_API_KEY           = env.GEMINI_API_KEY           || '';
const GEMINI_MODEL             = env.GEMINI_MODEL             || 'gemini-2.5-flash-image';
const GEMINI_FUNNY_ENABLED     = env.GEMINI_FUNNY_ENABLED !== 'false' && !!GEMINI_API_KEY;
const { processFunnyPhotos }   = require('./lib/gemini-funny');
const HTTP_PORT      = parseInt(env.PORT || '3000', 10);
const INACTIVITY_MS  = 3 * 60 * 1000; // 3 minutes
// Live preview: poll interval (ms). Higher = cooler camera, lower = smoother preview.
const LIVEVIEW_MS         = parseInt(env.LIVEVIEW_MS || '350', 10);
// During idle (sleep screen): light USB ping so Fuji does not power off (0 = off).
const CAMERA_KEEPALIVE_MS = parseInt(env.CAMERA_KEEPALIVE_MS || '0', 10);
const CAMERA_WAKE_RETRIES = parseInt(env.CAMERA_WAKE_RETRIES || '3', 10);

// ===== PATHS =====
const outputDir = path.join(__dirname, 'output');
const assetsDir = path.join(__dirname, 'assets');
const logFile   = path.join(outputDir, 'booth.log');
const previewTmp = path.join(outputDir, '.live-preview.jpg');
if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });
if (!fs.existsSync(assetsDir)) fs.mkdirSync(assetsDir, { recursive: true });

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
httpApp.get('/ipad', (_req, res) =>
  res.sendFile(path.join(__dirname, 'renderer', 'ipad.html'))
);
httpApp.use(express.static(path.join(__dirname, 'renderer')));
httpApp.get('/save/:sessionId', (_req, res) =>
  res.sendFile(path.join(__dirname, 'renderer', 'save.html'))
);
httpApp.get('/api/session/:sessionId', (req, res) => {
  const dir = path.join(outputDir, req.params.sessionId);
  if (!fs.existsSync(dir)) return res.status(404).json({ error: 'not found' });
  const id = req.params.sessionId;
  let strip = `/photos/${id}/strip_vertical.jpg`;
  let stripFunny = null;
  const funnyLocal = path.join(dir, 'strip_vertical_funny.jpg');
  if (fs.existsSync(funnyLocal)) stripFunny = `/photos/${id}/strip_vertical_funny.jpg`;
  const metaPath = path.join(dir, 'session.json');
  if (fs.existsSync(metaPath)) {
    try {
      const meta = JSON.parse(fs.readFileSync(metaPath, 'utf-8'));
      if (meta.cloudinaryUrl) strip = meta.cloudinaryUrl;
      if (meta.cloudinaryUrlFunny) stripFunny = meta.cloudinaryUrlFunny;
    } catch (_) {}
  }
  res.json({ strip, stripFunny });
});
httpApp.listen(HTTP_PORT, '0.0.0.0');

// ===== STATE =====
let mainWindow;
let currentState  = 'SLEEP';
let sessionId     = null;
let sessionFolder = null;
let liveViewProcess = null;
let keepaliveTimer = null;
let liveViewActive = false;
let liveViewPaused = false;
let recoveryTimer = null;
let liveViewBootTimer = null;
let liveViewStallTimer = null;
let lastFrameAt = 0;
let inactivityTimer = null;
let sessionsCompleted = 0;

const IMAGE_FORMAT_CONFIG = '/main/imgsettings/imageformat';
const LIVE_BOOT_DELAY_MS = 1800;

const sleep = ms => new Promise(r => setTimeout(r, ms));

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

// Serialize gphoto2 — overlapping preview/keepalive/capture causes "Could not claim USB" on macOS.
let gphotoChain = Promise.resolve();
let lastUsbRelease = 0;

function killProcess(name) {
  return new Promise(resolve => {
    const p = spawn('killall', [name], { stdio: 'ignore' });
    p.on('close', () => resolve());
    p.on('error', () => resolve());
  });
}

async function releaseMacUsbConflict() {
  if (process.platform !== 'darwin') return;
  const now = Date.now();
  if (now - lastUsbRelease < 2500) return;
  lastUsbRelease = now;
  await killProcess('PTPCamera');
  await killProcess('mscamerad');
  await sleep(350);
}

function isUsbClaimError(err) {
  const m = (err && err.message) || '';
  return m.includes('Could not claim') || m.includes('No such file or directory');
}

function runGphoto(args, { releaseUsb = false } = {}) {
  const job = async () => {
    if (releaseUsb) await releaseMacUsbConflict();
    return executeCommand('gphoto2', args);
  };
  const next = gphotoChain.then(job, job);
  gphotoChain = next.catch(() => {});
  return next;
}

async function checkGphoto2() {
  try { await executeCommand('gphoto2', ['--version']); return true; }
  catch (e) { log('ERROR: gphoto2 not found – ' + e.message); return false; }
}

async function checkCamera() {
  try {
    const out = (await runGphoto(['--auto-detect'], { releaseUsb: true })).toLowerCase();
    return out.includes('fujifilm') || out.includes('fuji') || /usb:\d+/.test(out);
  } catch (e) { log('Camera check failed: ' + e.message); return false; }
}

// ===== CAMERA =====
// One continuous gphoto2 movie stream (Fuji X-T2 fails with rapid preview polling).

function stopMovieProcess() {
  if (liveViewProcess) {
    try { liveViewProcess.kill('SIGTERM'); } catch (_) {}
    liveViewProcess = null;
  }
}

function pauseLiveView() {
  liveViewPaused = true;
  stopMovieProcess();
}

function resumeLiveView() {
  if (!liveViewActive || !liveViewPaused) return;
  liveViewPaused = false;
  startMovieLiveView({ quick: currentState === 'COUNTDOWN' });
}

function clearRecoveryTimer() {
  if (recoveryTimer) { clearTimeout(recoveryTimer); recoveryTimer = null; }
}

function clearLiveViewBootTimer() {
  if (liveViewBootTimer) { clearTimeout(liveViewBootTimer); liveViewBootTimer = null; }
}

function clearLiveViewStallTimer() {
  if (liveViewStallTimer) { clearTimeout(liveViewStallTimer); liveViewStallTimer = null; }
}

function scheduleLiveViewStallCheck() {
  clearLiveViewStallTimer();
  if (!liveViewActive || liveViewPaused) return;
  if (currentState !== 'LIVE' && currentState !== 'COUNTDOWN') return;
  liveViewStallTimer = setTimeout(() => {
    liveViewStallTimer = null;
    if (!liveViewActive || liveViewPaused) return;
    if (currentState !== 'LIVE' && currentState !== 'COUNTDOWN') return;
    if (Date.now() - lastFrameAt < 2500) return;
    log('Live preview stalled — restarting stream');
    startMovieLiveView({ quick: currentState === 'COUNTDOWN' });
  }, 4000);
}

function scheduleLiveViewBoot(delayMs = LIVE_BOOT_DELAY_MS) {
  clearLiveViewBootTimer();
  liveViewBootTimer = setTimeout(() => {
    liveViewBootTimer = null;
    if (liveViewActive && !liveViewPaused && (currentState === 'LIVE' || currentState === 'COUNTDOWN')) {
      startMovieLiveView();
    }
  }, delayMs);
}

function scheduleLiveViewRecovery() {
  if (!liveViewActive || liveViewPaused || recoveryTimer) return;
  recoveryTimer = setTimeout(async () => {
    recoveryTimer = null;
    if (!liveViewActive || liveViewPaused) return;
    log('Restarting live view stream…');
    await startMovieLiveView();
  }, 2500);
}

async function startMovieLiveView({ quick = false } = {}) {
  if (!liveViewActive || liveViewPaused) return;
  stopMovieProcess();
  if (quick) {
    await sleep(180);
  } else {
    await releaseMacUsbConflict();
    await sleep(400);
  }

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
        if (mainWindow && !mainWindow.isDestroyed() && liveViewActive && !liveViewPaused) {
          const firstFrame = !lastFrameAt;
          send('live-view-frame', frame.toString('base64'));
          lastFrameAt = Date.now();
          if (firstFrame && currentState === 'LIVE') {
            send('camera-status', 'PRESS SPACE BAR TO START YOUR SESSION');
          }
          scheduleLiveViewStallCheck();
        }
      }
    });

    liveViewProcess.stderr.on('data', d => {
      const msg = d.toString().trim();
      if (msg && !msg.includes('Capturing preview')) log('gphoto2: ' + msg);
    });

    liveViewProcess.on('close', code => {
      liveViewProcess = null;
      if (liveViewActive && !liveViewPaused) {
        log('Live view stream ended (code ' + code + ')');
        scheduleLiveViewRecovery();
      }
    });

    liveViewProcess.on('error', err => {
      log('Live view error: ' + err.message);
      scheduleLiveViewRecovery();
    });
  } catch (e) {
    log('Failed to start live view: ' + e.message);
    send('camera-error', 'Could not start camera preview.');
    scheduleLiveViewRecovery();
  }
}

function stopLiveView() {
  liveViewActive = false;
  liveViewPaused = false;
  lastFrameAt = 0;
  clearRecoveryTimer();
  clearLiveViewBootTimer();
  clearLiveViewStallTimer();
  stopMovieProcess();
}

function startLiveView(delayMs = 0) {
  stopLiveView();
  liveViewActive = true;
  if (delayMs > 0) scheduleLiveViewBoot(delayMs);
  else startMovieLiveView();
}

async function wakeCamera() {
  await releaseMacUsbConflict();
  for (let attempt = 1; attempt <= CAMERA_WAKE_RETRIES; attempt++) {
    if (await checkCamera()) {
      log('Camera detected');
      return true;
    }
    log(`Wake attempt ${attempt}: camera not listed`);
    await releaseMacUsbConflict();
    await sleep(1500);
  }
  return false;
}

async function getImageFormatLabel() {
  try {
    const out = await runGphoto(['--get-config', IMAGE_FORMAT_CONFIG]);
    const m = out.match(/Current:\s*(.+)/);
    return m ? m[1].trim() : null;
  } catch (_) {
    return null;
  }
}

async function ensureJpegCaptureMode() {
  await sleep(600);
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      await runGphoto(['--set-config-index', `${IMAGE_FORMAT_CONFIG}=1`]);
      await sleep(400);
      const cur = await getImageFormatLabel();
      if (cur && /^JPEG /i.test(cur)) {
        log('Camera image format: ' + cur);
        return true;
      }
      await runGphoto(['--set-config', `${IMAGE_FORMAT_CONFIG}=JPEG Fine`]);
      await sleep(400);
      const cur2 = await getImageFormatLabel();
      if (cur2 && /^JPEG /i.test(cur2)) {
        log('Camera image format: ' + cur2);
        return true;
      }
    } catch (e) {
      log(`JPEG mode attempt ${attempt}/5: ${e.message.split('\n')[0]}`);
    }
    await sleep(1000);
  }
  log('WARNING: Camera still on RAW — will convert each capture with sips');
  return false;
}

async function convertRafToJpeg(filePath) {
  if (process.platform !== 'darwin') return false;
  const tmpPath = filePath + '.sips.jpg';
  try {
    await executeCommand('sips', ['-s', 'format', 'jpeg', '-Z', '2400', filePath, '--out', tmpPath]);
    if (!fs.existsSync(tmpPath)) return false;
    fs.renameSync(tmpPath, filePath);
    return true;
  } catch (e) {
    log('sips RAF→JPEG failed: ' + e.message);
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
    return false;
  }
}

async function ensurePhotoIsJpeg(filePath) {
  if (!fs.existsSync(filePath)) return false;
  try {
    await sharp(filePath).metadata();
    return true;
  } catch (_) {}
  if (await convertRafToJpeg(filePath)) {
    try {
      await sharp(filePath).metadata();
      log('Converted Fuji RAW to JPEG: ' + filePath);
      return true;
    } catch (e) {
      log('Converted file still unreadable: ' + e.message);
    }
  }
  return false;
}

async function ensureCameraReady() {
  send('camera-status', 'Getting camera ready…');
  const ok = await wakeCamera();
  if (!ok) {
    send('camera-error',
      'Camera not responding. Unplug USB, set tether mode, quit Photos, then press Space again.');
    return false;
  }
  await ensureJpegCaptureMode();
  return true;
}

async function cameraKeepalive() {
  if (currentState !== 'SLEEP' || liveViewActive) return;
  try {
    await runGphoto(['--capture-preview', '--filename', previewTmp, '--force-overwrite']);
  } catch (e) {
    log('Keepalive failed: ' + e.message);
    if (isUsbClaimError(e)) await releaseMacUsbConflict();
  }
}

function startKeepalive() {
  stopKeepalive();
  if (!CAMERA_KEEPALIVE_MS) return;
  keepaliveTimer = setInterval(cameraKeepalive, CAMERA_KEEPALIVE_MS);
}

function stopKeepalive() {
  if (keepaliveTimer) { clearInterval(keepaliveTimer); keepaliveTimer = null; }
}

function photoFileLooksValid(filePath) {
  try {
    return fs.existsSync(filePath) && fs.statSync(filePath).size > 80_000;
  } catch (_) {
    return false;
  }
}

async function capturePhoto(photoIndex) {
  if (!sessionFolder) { send('photo-captured', { photoIndex, filePath: null }); return; }
  const outPath = path.join(sessionFolder, `photo_${photoIndex}.jpg`);
  const resumeAfter = liveViewActive;
  if (!liveViewPaused) pauseLiveView();
  await sleep(200);

  let ok = false;
  try {
    await releaseMacUsbConflict();
    await runGphoto(['--capture-image-and-download', '--filename', outPath, '--force-overwrite']);
    ok = photoFileLooksValid(outPath);
    if (ok) log(`Photo ${photoIndex} saved: ${outPath}`);
    else log(`Photo ${photoIndex} capture failed`);
  } catch (e) {
    log(`Photo ${photoIndex} error: ${e.message}`);
    try {
      await runGphoto(['--capture-image-and-download', '--filename', outPath, '--force-overwrite']);
      ok = photoFileLooksValid(outPath);
      if (ok) log(`Photo ${photoIndex} saved on retry: ${outPath}`);
    } catch (e2) {
      log(`Photo ${photoIndex} retry failed: ${e2.message}`);
    }
  }

  if (resumeAfter) resumeLiveView();
  send('photo-captured', { photoIndex, filePath: ok ? outPath : null });
}

// ===== IMAGE PROCESSING =====
async function blackBuffer(w, h) {
  return sharp({ create: { width: w, height: h, channels: 3, background: { r: 0, g: 0, b: 0 } } })
    .jpeg({ quality: 92 }).toBuffer();
}

async function resizePhoto(p, w, h) {
  return sharp(p).rotate().resize(w, h, { fit: 'cover', position: 'center' }).toBuffer();
}

// Shrink 24MP Fuji files so USB download + strip build stay fast.
async function optimizeCapturedPhoto(filePath) {
  const tmpPath = filePath + '.opt.jpg';
  try {
    await sharp(filePath)
      .rotate()
      .resize(2400, 2400, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 88, mozjpeg: true })
      .toFile(tmpPath);
    fs.renameSync(tmpPath, filePath);
  } catch (e) {
    log('Photo optimize failed: ' + e.message);
    try { if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath); } catch (_) {}
  }
}

// Vertical strip: template base, photos composited ON TOP (template holes use black RGB + alpha 0;
// under-compositing shows black; over-compositing is correct).
async function buildStrip({ photoSuffix = '', outFile = 'strip_vertical.jpg' } = {}) {
  const canvasW = 1200, canvasH = 2440;
  const slotW = 1080, slotH = 720;
  const slots = [
    { x: 60, y: 80 },
    { x: 60, y: 860 },
    { x: 60, y: 1640 },
  ];

  const photoLayers = [];
  for (let i = 1; i <= 3; i++) {
    const p = path.join(sessionFolder, `photo_${i}${photoSuffix}.jpg`);
    let buf;
    try {
      if (fs.existsSync(p)) await ensurePhotoIsJpeg(p);
      buf = fs.existsSync(p) ? await resizePhoto(p, slotW, slotH) : await blackBuffer(slotW, slotH);
    } catch (e) {
      log(`Strip resize error photo ${i}: ${e.message}`);
      buf = await blackBuffer(slotW, slotH);
    }
    photoLayers.push({ input: buf, left: slots[i - 1].x, top: slots[i - 1].y });
  }

  const tplPath = path.join(assetsDir, 'template-vertical.png');
  let composite;
  if (fs.existsSync(tplPath)) {
    try {
      const tpl = await sharp(tplPath).resize(canvasW, canvasH, { fit: 'fill' }).toBuffer();
      composite = sharp(tpl).composite(photoLayers);
    } catch (e) {
      log('Template error: ' + e.message);
      composite = sharp({
        create: { width: canvasW, height: canvasH, channels: 3, background: { r: 0, g: 0, b: 0 } },
      }).composite(photoLayers);
    }
  } else {
    composite = sharp({
      create: { width: canvasW, height: canvasH, channels: 3, background: { r: 0, g: 0, b: 0 } },
    }).composite(photoLayers);
  }

  const outPath = path.join(sessionFolder, outFile);
  await composite.jpeg({ quality: 92 }).toFile(outPath);
  log('Strip: ' + outPath);
  return outPath;
}

async function buildFunnyStrip() {
  return buildStrip({ photoSuffix: '_funny', outFile: 'strip_vertical_funny.jpg' });
}

async function runFunnyStripPipeline() {
  if (!GEMINI_FUNNY_ENABLED || !sessionFolder) return;

  try {
    send('funny-strip-status', 'Creating bonus strip…');
    await processFunnyPhotos({
      apiKey: GEMINI_API_KEY,
      model: GEMINI_MODEL,
      sessionFolder,
      log,
    });
    const funnyPath = await buildFunnyStrip();
    send('funny-strip-ready', { funnyStripPath: funnyPath });

    const folderName = path.basename(sessionFolder);
    const cloudinaryUrlFunny = await uploadToCloudinary(funnyPath);
    const funnyPublicUrl = cloudinaryUrlFunny
      || `http://${localIP}:${HTTP_PORT}/photos/${folderName}/strip_vertical_funny.jpg`;

    const metaPath = path.join(sessionFolder, 'session.json');
    const meta = fs.existsSync(metaPath)
      ? JSON.parse(fs.readFileSync(metaPath, 'utf-8'))
      : {};
    meta.cloudinaryUrlFunny = cloudinaryUrlFunny || null;
    meta.funnySaveUrl = funnyPublicUrl;
    fs.writeFileSync(metaPath, JSON.stringify(meta, null, 2));

    const funnyQr = await QRCode.toDataURL(funnyPublicUrl, {
      width: 360, margin: 2, color: { dark: '#000000', light: '#ffffff' },
    });
    send('funny-qr-ready', { qrDataUrl: funnyQr, saveUrl: funnyPublicUrl });
    if (!cloudinaryUrlFunny) log('Bonus QR uses booth WiFi URL (Cloudinary upload failed)');
    send('funny-strip-status', null);
  } catch (e) {
    log('Funny strip failed: ' + e.message);
    send('funny-strip-status', null);
  }
}

async function finishSessionUploads(stripPath) {
  const folderName = path.basename(sessionFolder);
  const localSaveUrl = `http://${localIP}:${HTTP_PORT}/save/${folderName}`;

  const cloudinaryUrl = await uploadToCloudinary(stripPath);
  const saveUrl = cloudinaryUrl || localSaveUrl;
  if (!cloudinaryUrl) log('WARNING: Cloudinary upload failed — QR only works on same WiFi');

  const qrDataUrl = await QRCode.toDataURL(saveUrl, {
    width: 360, margin: 2, color: { dark: '#000000', light: '#ffffff' },
  });

  fs.writeFileSync(path.join(sessionFolder, 'session.json'),
    JSON.stringify({
      timestamp: new Date().toISOString(),
      saveUrl,
      localSaveUrl,
      cloudinaryUrl: cloudinaryUrl || null,
      cloudinaryUrlFunny: null,
    }, null, 2));

  send('qr-ready', { qrDataUrl, saveUrl });
}

// ===== CLOUDINARY (public QR links — guests use cellular, not booth WiFi) =====
async function uploadToCloudinary(filePath) {
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_UPLOAD_PRESET) return null;
  const fd = new FormData();
  fd.append('file', fs.createReadStream(filePath));
  fd.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);
  try {
    const r = await axios.post(
      `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`,
      fd,
      { headers: fd.getHeaders(), timeout: 45_000 }
    );
    log('Cloudinary OK: ' + r.data.secure_url);
    return r.data.secure_url;
  } catch (e) {
    log('Cloudinary failed: ' + e.message);
    return null;
  }
}

// ===== PROCESSING PIPELINE =====
async function processSession() {
  try {
    send('processing-status', 'Building your strip…');
    for (let i = 1; i <= 3; i++) {
      const p = path.join(sessionFolder, `photo_${i}.jpg`);
      if (fs.existsSync(p)) {
        await ensurePhotoIsJpeg(p);
        await optimizeCapturedPhoto(p);
      }
    }
    const stripPath = await buildStrip();

    const folderName = path.basename(sessionFolder);
    const localSaveUrl = `http://${localIP}:${HTTP_PORT}/save/${folderName}`;

    fs.writeFileSync(path.join(sessionFolder, 'session.json'),
      JSON.stringify({
        timestamp: new Date().toISOString(),
        saveUrl: null,
        localSaveUrl,
        cloudinaryUrl: null,
        cloudinaryUrlFunny: null,
      }, null, 2));

    transitionToState('SHARE');
    send('session-complete', {
      stripPath,
      qrPending: true,
      funnyStripPending: GEMINI_FUNNY_ENABLED,
    });

    finishSessionUploads(stripPath).catch(e => log('Upload error: ' + e.message));
    if (GEMINI_FUNNY_ENABLED) runFunnyStripPipeline();
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
      startKeepalive();
      break;
    case 'LIVE':
      stopKeepalive();
      send('camera-status', 'Starting camera preview…');
      startLiveView(LIVE_BOOT_DELAY_MS);
      break;
    case 'PROCESSING':
      stopLiveView();
      clearInactivityTimer();
      break;
    case 'COUNTDOWN':
      stopKeepalive();
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
ipcMain.on('wake-from-sleep', async () => {
  if (currentState !== 'SLEEP') return;
  const ts = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  sessionId     = uuidv4().slice(0, 8);
  sessionFolder = path.join(outputDir, `${ts}_${sessionId}`);
  fs.mkdirSync(sessionFolder, { recursive: true });
  log('New session: ' + sessionFolder);
  stopKeepalive();
  stopLiveView();
  const ok = await ensureCameraReady();
  if (!ok) return;
  await sleep(500);
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
  await releaseMacUsbConflict();
  if (!(await checkCamera())) {
    log('WARNING: Camera not detected at startup');
  } else {
    startKeepalive();
  }

  registerShortcuts();
  log(`Ready — network save page: http://${localIP}:${HTTP_PORT}`);
  if (GEMINI_FUNNY_ENABLED) log(`Gemini bonus strip: ON (${GEMINI_MODEL})`);
  else if (!GEMINI_API_KEY) log('Gemini bonus strip: OFF (set GEMINI_API_KEY in .env)');
  if (!fs.existsSync(path.join(assetsDir, 'template-vertical.png'))) {
    log('TIP: Add assets/template-vertical.png for your strip frame (see assets/README.md)');
  }
}

app.on('ready', createWindow);
app.on('window-all-closed', () => {
  globalShortcut.unregisterAll();
  stopLiveView();
  stopKeepalive();
  if (process.platform !== 'darwin') app.quit();
});
app.on('activate', () => { if (!mainWindow) createWindow(); });
process.on('exit', () => {
  globalShortcut.unregisterAll();
  stopLiveView();
  stopKeepalive();
});
