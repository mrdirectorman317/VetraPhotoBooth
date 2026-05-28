// ===== CONSTANTS =====
const PHOTO_COUNT    = 3;
const BETWEEN_MS     = 3000;  // pause between photos (ms)
const LAST_PHOTO_MS  = 1200;  // shorter pause after the final photo
const SHARE_TIMER_S  = 180;   // 3-minute auto-reset on share screen

// ===== STATE =====
let state = 'SLEEP';

// ===== DOM =====
const $ = id => document.getElementById(id);
const sleepScreen      = $('sleep-screen');
const liveScreen       = $('live-screen');
const countdownScreen  = $('countdown-screen');
const processingScreen = $('processing-screen');
const shareScreen      = $('share-screen');
const errorOverlay     = $('error-overlay');
const liveCanvas       = $('live-canvas');
const countdownCanvas  = $('countdown-canvas');
const countdownUI      = $('countdown-ui');
const countdownNumber  = $('countdown-number');
const photoCounter     = $('photo-counter');
const betweenOverlay   = $('between-overlay');
const betweenImg       = $('between-img');
const betweenLabel     = $('between-label');
const flashOverlay     = $('flash-overlay');
const processingStatus = $('processing-status');
const shareStripImage  = $('share-strip-image');
const shareQRImage     = $('share-qr-image');
const timerBar         = $('timer-bar');
const timerLabel       = $('timer-label');
const clockEl          = $('clock');

let liveCtx       = null;
let countdownCtx  = null;
let shareTimerRAF = null;
let clockInterval = null;
let captureSequenceRunning = false;

// ===== AUDIO (Web Audio API) =====
let audioCtx = null;

function initAudio() {
  if (!audioCtx) audioCtx = new AudioContext();
}

function beep(freq = 880, durationMs = 220, volume = 0.6) {
  if (!audioCtx) return;
  const osc  = audioCtx.createOscillator();
  const gain = audioCtx.createGain();
  osc.connect(gain);
  gain.connect(audioCtx.destination);
  osc.type = 'sine';
  osc.frequency.value = freq;
  gain.gain.setValueAtTime(volume, audioCtx.currentTime);
  gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + durationMs / 1000);
  osc.start();
  osc.stop(audioCtx.currentTime + durationMs / 1000);
}

// Ascending beeps for 3-2-1, then a distinct snap
const BEEP_FREQS = { 3: 550, 2: 660, 1: 880, snap: 1320 };

// ===== UTILITIES =====
const sleep = ms => new Promise(r => setTimeout(r, ms));

function formatMM_SS(totalSeconds) {
  const m = Math.floor(totalSeconds / 60);
  const s = totalSeconds % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

// ===== CANVAS SETUP =====
function setupCanvases() {
  if (liveCanvas) {
    liveCanvas.width  = window.innerWidth;
    liveCanvas.height = window.innerHeight;
    liveCtx = liveCanvas.getContext('2d');
  }
  if (countdownCanvas) {
    countdownCanvas.width  = window.innerWidth;
    countdownCanvas.height = window.innerHeight;
    countdownCtx = countdownCanvas.getContext('2d');
  }
}

// ===== SCREEN SWITCHER =====
function showScreen(el) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  if (el) el.classList.add('active');
}

// ===== CLOCK =====
function updateClock() {
  if (!clockEl) return;
  const now = new Date();
  clockEl.textContent =
    String(now.getHours()).padStart(2, '0') + ':' +
    String(now.getMinutes()).padStart(2, '0');
}

// ===== LIVE VIEW RENDERING =====
window.booth.onLiveViewFrame(base64 => {
  const ctx    = state === 'LIVE' ? liveCtx : countdownCtx;
  const canvas = state === 'LIVE' ? liveCanvas : countdownCanvas;
  if (!ctx || !canvas) return;

  const img = new Image();
  img.onload = () => {
    const scale = Math.max(canvas.width / img.width, canvas.height / img.height);
    const x = (canvas.width  - img.width  * scale) / 2;
    const y = (canvas.height - img.height * scale) / 2;
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, x, y, img.width * scale, img.height * scale);
  };
  img.src = 'data:image/jpeg;base64,' + base64;
});

// ===== FLASH =====
function triggerFlash() {
  flashOverlay.style.transition = 'none';
  flashOverlay.style.opacity    = '1';
  flashOverlay.style.visibility = 'visible';
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      flashOverlay.style.transition = 'opacity 0.5s ease-out';
      flashOverlay.style.opacity    = '0';
    });
  });
  setTimeout(() => { flashOverlay.style.visibility = 'hidden'; }, 600);
}

// ===== PROGRESS DOTS =====
function fillDot(index) {
  const dot = $(`dot-${index}`);
  if (dot) dot.classList.add('filled');
}

function resetDots() {
  for (let i = 1; i <= PHOTO_COUNT; i++) {
    const dot = $(`dot-${i}`);
    if (dot) dot.classList.remove('filled');
  }
}

// ===== WAIT FOR photo-captured IPC =====
function waitForPhotoCaptured(expectedIndex) {
  return new Promise(resolve => {
    // Re-register once listener each time (preload uses ipcRenderer.once per call)
    window.booth.onPhotoCaptured(data => {
      if (data.photoIndex === expectedIndex) resolve(data);
    });
  });
}

// ===== CAPTURE SEQUENCE =====
async function startCaptureSequence() {
  if (captureSequenceRunning) return;
  captureSequenceRunning = true;
  resetDots();

  for (let i = 1; i <= PHOTO_COUNT; i++) {
    // — Countdown: show numbers 3 → 2 → 1 —
    countdownUI.classList.remove('hidden');
    betweenOverlay.classList.add('hidden');
    photoCounter.textContent = `PHOTO ${i} OF ${PHOTO_COUNT}`;

    for (let n = 3; n >= 1; n--) {
      countdownNumber.textContent = n;
      countdownNumber.classList.remove('pop');
      void countdownNumber.offsetWidth; // force reflow for animation restart
      countdownNumber.classList.add('pop');
      beep(BEEP_FREQS[n], 220);
      await sleep(1000);
    }

    // — Flash + capture —
    countdownUI.classList.add('hidden');
    triggerFlash();
    beep(BEEP_FREQS.snap, 100, 0.8);
    window.booth.requestCapture(i);

    // — Wait for main process to confirm file saved —
    const photoData = await waitForPhotoCaptured(i);
    fillDot(i);

    // — Between-photo: show the captured image —
    betweenLabel.textContent = `PHOTO ${i} OF ${PHOTO_COUNT}  ✓`;
    if (photoData.filePath) {
      betweenImg.src = 'file://' + photoData.filePath;
    } else {
      betweenImg.src = '';  // capture failed; still show the label
    }
    betweenOverlay.classList.remove('hidden');

    const pauseMs = i < PHOTO_COUNT ? BETWEEN_MS : LAST_PHOTO_MS;
    await sleep(pauseMs);
    betweenOverlay.classList.add('hidden');
  }

  captureSequenceRunning = false;
  transitionToState('PROCESSING');
}

// ===== SHARE TIMER =====
function startShareTimer() {
  stopShareTimer();
  const startMs = Date.now();
  const totalMs = SHARE_TIMER_S * 1000;

  const tick = () => {
    const elapsed   = Date.now() - startMs;
    const remaining = Math.max(0, totalMs - elapsed);
    const secs      = Math.ceil(remaining / 1000);
    const pct       = (remaining / totalMs) * 100;

    timerBar.style.width   = pct + '%';
    timerLabel.textContent = `Restarting in ${formatMM_SS(secs)}`;

    if (remaining > 0) shareTimerRAF = requestAnimationFrame(tick);
  };

  shareTimerRAF = requestAnimationFrame(tick);
}

function stopShareTimer() {
  if (shareTimerRAF) { cancelAnimationFrame(shareTimerRAF); shareTimerRAF = null; }
}

// ===== STATE MACHINE =====
function transitionToState(newState) {
  if (state === newState) return;
  state = newState;

  switch (newState) {
    case 'SLEEP':
      showScreen(sleepScreen);
      stopShareTimer();
      betweenOverlay.classList.add('hidden');
      countdownUI.classList.remove('hidden');
      resetDots();
      break;

    case 'LIVE':
      showScreen(liveScreen);
      break;

    case 'COUNTDOWN':
      captureSequenceRunning = false;
      showScreen(countdownScreen);
      startCaptureSequence();
      break;

    case 'PROCESSING':
      showScreen(processingScreen);
      window.booth.startProcessing();
      break;

    case 'SHARE':
      showScreen(shareScreen);
      startShareTimer();
      break;
  }
}

// ===== IPC FROM MAIN PROCESS =====
window.booth.onStateChange(newState => transitionToState(newState));

window.booth.onProcessingStatus(msg => {
  if (processingStatus) processingStatus.textContent = msg;
});

window.booth.onSessionComplete(data => {
  if (!data) return;
  if (shareStripImage && data.vPath) shareStripImage.src = 'file://' + data.vPath;
  if (shareQRImage    && data.qrDataUrl) shareQRImage.src = data.qrDataUrl;
});

window.booth.onCameraError(msg => {
  const el = $('error-message');
  if (el) el.textContent = msg;
  errorOverlay.classList.add('active');
  setTimeout(() => errorOverlay.classList.remove('active'), 6000);
});

// ===== KEYBOARD =====
document.addEventListener('keydown', e => {
  if (e.code !== 'Space') return;
  e.preventDefault();
  initAudio(); // must be inside user gesture for AudioContext

  if (state === 'SLEEP') {
    window.booth.wakeFromSleep();
  } else if (state === 'LIVE') {
    window.booth.startSession();
  } else if (state === 'SHARE') {
    window.booth.cancelToSleep();
  }
});

// ===== INIT =====
window.addEventListener('load', () => {
  setupCanvases();
  clockInterval = setInterval(updateClock, 1000);
  updateClock();
  transitionToState('SLEEP');
});

window.addEventListener('resize', setupCanvases);
