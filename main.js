const {
  app,
  BrowserWindow,
  ipcMain,
  globalShortcut,
} = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');
const sharp = require('sharp');
const QRCode = require('qrcode');
const axios = require('axios');
const FormData = require('form-data');
const chokidar = require('chokidar');

// ===== ENVIRONMENT SETUP =====
const isDev = process.env.BOOTH_DEV === 'true';
const envFile = path.join(__dirname, '.env');
const env = {};

if (fs.existsSync(envFile)) {
  const envContent = fs.readFileSync(envFile, 'utf-8');
  envContent.split('\n').forEach(line => {
    const [key, value] = line.split('=');
    if (key && value) {
      env[key.trim()] = value.trim();
    }
  });
}

const CLOUDINARY_CLOUD_NAME = env.CLOUDINARY_CLOUD_NAME || '';
const CLOUDINARY_UPLOAD_PRESET = env.CLOUDINARY_UPLOAD_PRESET || '';

// ===== PATHS =====
const outputDir = path.join(__dirname, 'output');
const assetsDir = path.join(__dirname, 'assets');
const logFile = path.join(outputDir, 'booth.log');

if (!fs.existsSync(outputDir)) {
  fs.mkdirSync(outputDir, { recursive: true });
}

// ===== STATE VARIABLES =====
let mainWindow;
let currentState = 'SLEEP';
let sessionLayout = null;
let sessionFolder = null;
let sessionPhotos = [];
let liveViewProcess = null;
let fileWatcher = null;
let sessionStartTime = null;
let lastActivityTime = Date.now();
let inactivityTimer = null;
let sessionsCompleted = 0;
let spaceKeyIgnore = false;

// ===== LOGGING =====
function log(message) {
  const timestamp = new Date().toISOString();
  const logMessage = `[${timestamp}] ${message}`;
  console.log(logMessage);

  try {
    fs.appendFileSync(logFile, logMessage + '\n');
  } catch (e) {
    console.error('Failed to write to log:', e.message);
  }
}

// ===== UTILITY FUNCTIONS =====
function executeCommand(command, args = []) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';

    proc.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    proc.on('close', (code) => {
      if (code === 0) {
        resolve(stdout);
      } else {
        reject(new Error(`${command} failed: ${stderr}`));
      }
    });

    proc.on('error', (err) => {
      reject(err);
    });
  });
}

async function checkGphoto2() {
  try {
    await executeCommand('gphoto2', ['--version']);
    return true;
  } catch (e) {
    log('ERROR: gphoto2 not found: ' + e.message);
    return false;
  }
}

async function checkCamera() {
  try {
    const output = await executeCommand('gphoto2', ['--auto-detect']);
    return output.includes('FUJIFILM') || output.includes('USB');
  } catch (e) {
    log('Camera detection failed: ' + e.message);
    return false;
  }
}

function resetSessionVariables() {
  sessionLayout = null;
  sessionFolder = null;
  sessionPhotos = [];
  sessionStartTime = null;
}

function stopLiveView() {
  if (liveViewProcess) {
    try {
      liveViewProcess.kill();
      liveViewProcess = null;
    } catch (e) {
      log('Error killing live view: ' + e.message);
    }
  }
}

function stopFileWatcher() {
  if (fileWatcher) {
    fileWatcher.close();
    fileWatcher = null;
  }
}

function startActivityTimer() {
  if (inactivityTimer) clearTimeout(inactivityTimer);

  inactivityTimer = setTimeout(() => {
    if (currentState === 'LAYOUT_SELECT' || currentState === 'SHARE') {
      log(`Auto-timeout from ${currentState} due to inactivity`);
      transitionToSleep();
    }
  }, 120000);
}

function clearActivityTimer() {
  if (inactivityTimer) {
    clearTimeout(inactivityTimer);
    inactivityTimer = null;
  }
}

function recordActivity() {
  lastActivityTime = Date.now();
  clearActivityTimer();
  if (currentState === 'LAYOUT_SELECT' || currentState === 'SHARE') {
    startActivityTimer();
  }
}

// ===== CAMERA CONTROL =====
function startLiveView() {
  stopLiveView();

  try {
    liveViewProcess = spawn('gphoto2', ['--stdout', '--capture-movie'], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let frameBuffer = Buffer.alloc(0);
    let inFrame = false;

    liveViewProcess.stdout.on('data', (chunk) => {
      frameBuffer = Buffer.concat([frameBuffer, chunk]);

      while (true) {
        const startIdx = frameBuffer.indexOf(Buffer.from([0xff, 0xd8]));

        if (startIdx === -1) {
          frameBuffer = frameBuffer.slice(frameBuffer.length > 1000000 ? frameBuffer.length - 1000000 : 0);
          break;
        }

        if (startIdx > 0) {
          frameBuffer = frameBuffer.slice(startIdx);
        }

        const endIdx = frameBuffer.indexOf(Buffer.from([0xff, 0xd9]), 2);

        if (endIdx === -1) {
          break;
        }

        const jpegFrame = frameBuffer.slice(0, endIdx + 2);
        frameBuffer = frameBuffer.slice(endIdx + 2);

        if (mainWindow && mainWindow.webContents) {
          try {
            mainWindow.webContents.send('live-view-frame', jpegFrame.toString('base64'));
          } catch (e) {
            log('Error sending frame: ' + e.message);
          }
        }
      }
    });

    liveViewProcess.stderr.on('data', (data) => {
      log('gphoto2 stderr: ' + data.toString());
    });

    liveViewProcess.on('error', (err) => {
      log('Live view error: ' + err.message);
      if (mainWindow) {
        mainWindow.webContents.send('camera-error', 'Live view stream failed');
      }
    });
  } catch (e) {
    log('Failed to start live view: ' + e.message);
    if (mainWindow) {
      mainWindow.webContents.send('camera-error', 'Failed to start live view');
    }
  }
}

async function capturePhoto(outputPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('gphoto2', [
      '--capture-image-and-download',
      '--filename',
      outputPath,
      '--force-overwrite',
    ]);

    let completed = false;

    proc.on('close', (code) => {
      if (!completed) {
        completed = true;
        if (code === 0) {
          resolve();
        } else {
          reject(new Error(`Capture failed with code ${code}`));
        }
      }
    });

    proc.on('error', (err) => {
      if (!completed) {
        completed = true;
        reject(err);
      }
    });

    setTimeout(() => {
      if (!completed) {
        completed = true;
        proc.kill();
        reject(new Error('Capture timeout'));
      }
    }, 15000);
  });
}

// ===== IMAGE PROCESSING =====
async function createBlackPlaceholder(width, height) {
  return sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  })
    .jpeg({ quality: 92 })
    .toBuffer();
}

async function resizePhotoForSlot(photoPath, slotWidth, slotHeight) {
  return sharp(photoPath)
    .resize(slotWidth, slotHeight, {
      fit: 'cover',
      position: 'center',
    })
    .toBuffer();
}

async function compositeStrip(layout) {
  if (!sessionFolder) {
    throw new Error('No session folder set');
  }

  const isVertical = layout === 'vertical';
  const canvasWidth = isVertical ? 1200 : 3600;
  const canvasHeight = isVertical ? 3600 : 1200;
  const slotWidth = isVertical ? 1080 : 810;
  const slotHeight = isVertical ? 810 : 1080;

  const slots = isVertical
    ? [
        { x: 60, y: 60 },
        { x: 60, y: 930 },
        { x: 60, y: 1800 },
        { x: 60, y: 2670 },
      ]
    : [
        { x: 60, y: 60 },
        { x: 930, y: 60 },
        { x: 1800, y: 60 },
        { x: 2670, y: 60 },
      ];

  let composite = sharp({
    create: {
      width: canvasWidth,
      height: canvasHeight,
      channels: 3,
      background: { r: 0, g: 0, b: 0 },
    },
  });

  const layers = [];

  for (let i = 0; i < 4; i++) {
    const photoPath = path.join(sessionFolder, `photo_${i + 1}.jpg`);
    let photoBuffer;

    if (fs.existsSync(photoPath)) {
      try {
        photoBuffer = await resizePhotoForSlot(photoPath, slotWidth, slotHeight);
      } catch (e) {
        log(`Error processing photo ${i + 1}: ${e.message}`);
        photoBuffer = await createBlackPlaceholder(slotWidth, slotHeight);
      }
    } else {
      log(`Photo ${i + 1} missing, using black placeholder`);
      photoBuffer = await createBlackPlaceholder(slotWidth, slotHeight);
    }

    layers.push({
      input: photoBuffer,
      left: slots[i].x,
      top: slots[i].y,
    });
  }

  composite = composite.composite(layers);

  const templatePath = isVertical
    ? path.join(assetsDir, 'template-vertical.png')
    : path.join(assetsDir, 'template-horizontal.png');

  if (fs.existsSync(templatePath)) {
    try {
      const templateBuffer = await sharp(templatePath)
        .resize(canvasWidth, canvasHeight, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
        .toBuffer();

      composite = composite.composite([
        {
          input: templateBuffer,
          left: 0,
          top: 0,
        },
      ]);
    } catch (e) {
      log(`Error compositing template: ${e.message}`);
    }
  }

  const outputFileName = isVertical ? 'strip_vertical.jpg' : 'strip_horizontal.jpg';
  const outputPath = path.join(sessionFolder, outputFileName);

  await composite.jpeg({ quality: 92 }).toFile(outputPath);

  return outputPath;
}

// ===== CLOUDINARY UPLOAD =====
async function uploadToCloudinary(filePath) {
  if (!CLOUDINARY_CLOUD_NAME || !CLOUDINARY_UPLOAD_PRESET) {
    log('Cloudinary not configured');
    return 'UPLOAD_FAILED';
  }

  try {
    const fileStream = fs.createReadStream(filePath);
    const formData = new FormData();
    formData.append('file', fileStream);
    formData.append('upload_preset', CLOUDINARY_UPLOAD_PRESET);

    const response = await axios.post(
      `https://api.cloudinary.com/v1_1/${CLOUDINARY_CLOUD_NAME}/image/upload`,
      formData,
      {
        headers: formData.getHeaders(),
        timeout: 30000,
      }
    );

    log(`Upload successful: ${response.data.secure_url}`);
    return response.data.secure_url;
  } catch (error) {
    log(`Cloudinary upload failed: ${error.message}`);
    return 'UPLOAD_FAILED';
  }
}

// ===== STATE TRANSITIONS =====
function transitionToState(newState) {
  if (currentState === newState) return;

  log(`State transition: ${currentState} → ${newState}`);
  currentState = newState;

  if (newState === 'SLEEP') {
    stopLiveView();
    stopFileWatcher();
    clearActivityTimer();
    resetSessionVariables();
    spaceKeyIgnore = false;
  } else if (newState === 'LAYOUT_SELECT') {
    startActivityTimer();
    recordActivity();
  } else if (newState === 'LIVE') {
    startLiveView();
    clearActivityTimer();
  } else if (newState === 'COUNTDOWN') {
    clearActivityTimer();
    startLiveView();
  } else if (newState === 'PROCESSING') {
    stopLiveView();
    stopFileWatcher();
    clearActivityTimer();
  } else if (newState === 'SHARE') {
    stopLiveView();
    startActivityTimer();
    sessionsCompleted++;
    if (sessionsCompleted % 10 === 0) {
      log(`BATTERY CHECK: consider swapping battery. Sessions completed: ${sessionsCompleted}`);
    }
  }

  if (mainWindow && mainWindow.webContents) {
    mainWindow.webContents.send('state-change', newState);
  }
}

function transitionToSleep() {
  transitionToState('SLEEP');
}

// ===== PROCESSING PIPELINE =====
async function processSession() {
  if (!sessionFolder || !sessionLayout) {
    log('Error: Session not properly initialized');
    return;
  }

  try {
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('processing-status', 'Developing your photos…');
    }

    const stripPath = await compositeStrip(sessionLayout);

    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('processing-status', 'Uploading…');
    }

    const cloudinaryUrl = await uploadToCloudinary(stripPath);

    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('processing-status', 'Generating your QR code…');
    }

    let qrDataUrl = null;
    if (cloudinaryUrl !== 'UPLOAD_FAILED') {
      qrDataUrl = await QRCode.toDataURL(cloudinaryUrl, {
        width: 400,
        margin: 2,
        color: { dark: '#ffffff', light: '#000000' },
      });
    }

    const sessionInfo = {
      timestamp: new Date().toISOString(),
      layout: sessionLayout,
      cloudinary_url: cloudinaryUrl,
      photos: sessionPhotos,
      strip: path.basename(stripPath),
    };

    fs.writeFileSync(
      path.join(sessionFolder, 'session_info.json'),
      JSON.stringify(sessionInfo, null, 2)
    );

    transitionToState('SHARE');

    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('session-complete', {
        stripPath,
        cloudinaryUrl,
        qrDataUrl,
        sessionInfo,
      });
    }
  } catch (error) {
    log(`Processing error: ${error.message}`);
    if (mainWindow && mainWindow.webContents) {
      mainWindow.webContents.send('processing-status', `Error: ${error.message}`);
    }
  }
}

// ===== IPC HANDLERS =====
ipcMain.on('layout-selected', (event, layout) => {
  recordActivity();
  sessionLayout = layout;
  sessionStartTime = new Date();
  const timestamp = sessionStartTime
    .toISOString()
    .replace(/[:.]/g, '-')
    .split('T')[0] + '_' +
    sessionStartTime
      .toISOString()
      .split('T')[1]
      .split('.')[0]
      .replace(/:/g, '-');
  sessionFolder = path.join(outputDir, timestamp);
  sessionPhotos = [];

  if (!fs.existsSync(sessionFolder)) {
    fs.mkdirSync(sessionFolder, { recursive: true });
  }

  log(`Session created: ${sessionFolder} (${layout})`);

  fileWatcher = chokidar.watch(sessionFolder, {
    persistent: true,
    awaitWriteFinish: { stabilityThreshold: 600, pollInterval: 100 },
  });

  transitionToState('LIVE');
});

ipcMain.on('session-started', (event) => {
  spaceKeyIgnore = true;
  transitionToState('COUNTDOWN');
});

ipcMain.on('request-capture', (event, photoIndex) => {
  if (!sessionFolder) return;

  const outputPath = path.join(sessionFolder, `photo_${photoIndex}.jpg`);
  capturePhoto(outputPath).catch((err) => {
    log(`Capture error for photo ${photoIndex}: ${err.message}`);
  });
});

ipcMain.on('processing-start', (event) => {
  processSession().catch((err) => {
    log(`Processing pipeline error: ${err.message}`);
  });
});

ipcMain.on('cancel-to-sleep', (event) => {
  transitionToSleep();
});

// ===== KEYBOARD HANDLING =====
function registerKeyboardShortcuts() {
  globalShortcut.register('Space', () => {
    if (!spaceKeyIgnore && mainWindow && mainWindow.webContents) {
      recordActivity();
      mainWindow.webContents.send('space-pressed');
    }
    spaceKeyIgnore = false;
  });

  globalShortcut.register('CommandOrControl+W', () => {});
  globalShortcut.register('CommandOrControl+Q', () => {});
  globalShortcut.register('CommandOrControl+H', () => {});
  globalShortcut.register('CommandOrControl+M', () => {});
  globalShortcut.register('Alt+Tab', () => {});
  globalShortcut.register('CommandOrControl+Tab', () => {});

  if (isDev) {
    globalShortcut.register('CommandOrControl+Shift+Q', () => {
      app.quit();
    });
  }
}

// ===== ELECTRON APP SETUP =====
async function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1920,
    height: 1080,
    fullscreen: true,
    kiosk: true,
    frame: false,
    alwaysOnTop: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      nodeIntegration: false,
      contextIsolation: true,
      enableRemoteModule: false,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));

  if (isDev) {
    mainWindow.webContents.openDevTools();
  }

  mainWindow.on('blur', () => {
    mainWindow.focus();
  });

  const gphoto2Available = await checkGphoto2();
  if (!gphoto2Available) {
    const { dialog } = require('electron');
    dialog.showErrorBox(
      'gphoto2 Not Found',
      'gphoto2 is not installed. Run: brew install gphoto2\n\nThen restart the app.'
    );
    app.quit();
    return;
  }

  const cameraAvailable = await checkCamera();
  if (!cameraAvailable) {
    log('WARNING: Camera not detected at startup');
  }

  registerKeyboardShortcuts();
}

app.on('ready', createWindow);

app.on('window-all-closed', () => {
  globalShortcut.unregisterAll();
  stopLiveView();
  stopFileWatcher();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

process.on('exit', () => {
  globalShortcut.unregisterAll();
  stopLiveView();
  stopFileWatcher();
});
