// ===== STATE MANAGEMENT =====
let state = 'SLEEP';
let sessionLayout = null;
let photosCaptured = 0;
let liveCanvasContext = null;
let countdownCanvasContext = null;
let countdownActive = false;
let shareTimerInterval = null;
let clockUpdateInterval = null;

// ===== DOM ELEMENTS =====
const rootElement = document.getElementById('root');
const sleepScreen = document.getElementById('sleep-screen');
const layoutScreen = document.getElementById('layout-screen');
const liveScreen = document.getElementById('live-screen');
const countdownScreen = document.getElementById('countdown-screen');
const processingScreen = document.getElementById('processing-screen');
const shareScreen = document.getElementById('share-screen');
const errorOverlay = document.getElementById('error-overlay');

// ===== CANVAS SETUP =====
function setupCanvases() {
  const liveCanvas = document.getElementById('live-canvas');
  const countdownCanvas = document.getElementById('countdown-canvas');

  if (liveCanvas) {
    liveCanvas.width = window.innerWidth;
    liveCanvas.height = window.innerHeight;
    liveCanvasContext = liveCanvas.getContext('2d');
  }

  if (countdownCanvas) {
    countdownCanvas.width = window.innerWidth;
    countdownCanvas.height = window.innerHeight;
    countdownCanvasContext = countdownCanvas.getContext('2d');
  }
}

// ===== STATE TRANSITIONS =====
function showScreen(screenElement) {
  const allScreens = rootElement.querySelectorAll('.screen');
  allScreens.forEach((screen) => {
    screen.classList.remove('active');
  });
  if (screenElement) {
    screenElement.classList.add('active');
  }
}

function transitionToState(newState) {
  if (state === newState) return;

  state = newState;

  switch (newState) {
    case 'SLEEP':
      showScreen(sleepScreen);
      stopShareTimer();
      stopClockUpdate();
      startClockUpdate();
      break;
    case 'LAYOUT_SELECT':
      showScreen(layoutScreen);
      break;
    case 'LIVE':
      showScreen(liveScreen);
      updateLayoutIndicator();
      break;
    case 'COUNTDOWN':
      photosCaptured = 0;
      showScreen(countdownScreen);
      startCountdownSequence();
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

// ===== CLOCK DISPLAY =====
function updateClock() {
  const clockElement = document.getElementById('clock');
  if (!clockElement) return;

  const now = new Date();
  const hours = String(now.getHours()).padStart(2, '0');
  const minutes = String(now.getMinutes()).padStart(2, '0');
  clockElement.textContent = `${hours}:${minutes}`;
}

function startClockUpdate() {
  clockUpdateInterval = setInterval(updateClock, 1000);
  updateClock();
}

function stopClockUpdate() {
  if (clockUpdateInterval) {
    clearInterval(clockUpdateInterval);
    clockUpdateInterval = null;
  }
}

// ===== LIVE VIEW RENDERING =====
window.booth.onLiveViewFrame((base64Frame) => {
  if (state !== 'LIVE' && state !== 'COUNTDOWN') return;

  const canvas = state === 'LIVE'
    ? document.getElementById('live-canvas')
    : document.getElementById('countdown-canvas');
  const ctx = state === 'LIVE' ? liveCanvasContext : countdownCanvasContext;

  if (!ctx || !canvas) return;

  const img = new Image();
  img.onload = () => {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    const scale = Math.max(
      canvas.width / img.width,
      canvas.height / img.height
    );
    const x = (canvas.width - img.width * scale) / 2;
    const y = (canvas.height - img.height * scale) / 2;
    ctx.drawImage(img, x, y, img.width * scale, img.height * scale);
  };
  img.onerror = () => {
    console.error('Failed to load frame');
  };
  img.src = 'data:image/jpeg;base64,' + base64Frame;
});

// ===== LAYOUT INDICATOR =====
function updateLayoutIndicator() {
  const indicator = document.getElementById('layout-indicator');
  if (indicator) {
    indicator.textContent = sessionLayout === 'vertical' ? 'V' : 'H';
  }
}

// ===== COUNTDOWN SEQUENCE =====
async function startCountdownSequence() {
  const countdownNumber = document.getElementById('countdown-number');
  const photoCounter = document.getElementById('photo-counter');

  for (let photoIndex = 1; photoIndex <= 4; photoIndex++) {
    const countdownSeconds = photoIndex === 1 ? 5 : 3;

    for (let i = countdownSeconds; i > 0; i--) {
      if (countdownNumber) {
        countdownNumber.textContent = String(i);
        countdownNumber.style.animation = 'none';
        void countdownNumber.offsetWidth;
        countdownNumber.style.animation = 'countdown-pulse 1s ease-out';
      }
      await sleep(1000);
    }

    triggerFlash();
    window.booth.requestCapture(photoIndex);

    if (photoCounter) {
      photoCounter.textContent = `📸 ${photoIndex} of 4`;
    }

    updateProgressDots(photoIndex);

    await sleep(2000);
  }

  transitionToState('PROCESSING');
}

function triggerFlash() {
  const flashOverlay = document.getElementById('flash-overlay');
  if (!flashOverlay) return;

  flashOverlay.style.opacity = '1';
  flashOverlay.style.visibility = 'visible';

  setTimeout(() => {
    flashOverlay.style.transition = 'opacity 0.08s ease-out';
    flashOverlay.style.opacity = '0';
  }, 120);

  setTimeout(() => {
    flashOverlay.style.transition = 'none';
  }, 200);
}

function updateProgressDots(photoIndex) {
  const dots = document.querySelectorAll('.progress-dots .dot');
  dots.forEach((dot, idx) => {
    if (idx < photoIndex) {
      dot.classList.add('filled');
    }
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ===== SHARE TIMER =====
function startShareTimer() {
  let timeRemaining = 120;
  const timerElement = document.getElementById('timer-countdown');

  if (timerElement) {
    timerElement.textContent = String(timeRemaining);
  }

  shareTimerInterval = setInterval(() => {
    timeRemaining--;

    if (timerElement) {
      timerElement.textContent = String(timeRemaining);
    }

    if (timeRemaining <= 0) {
      stopShareTimer();
      window.booth.cancelToSleep();
    }
  }, 1000);
}

function stopShareTimer() {
  if (shareTimerInterval) {
    clearInterval(shareTimerInterval);
    shareTimerInterval = null;
  }
}

// ===== SESSION COMPLETE HANDLER =====
window.booth.onSessionComplete((data) => {
  if (!data) return;

  const stripImage = document.getElementById('share-strip-image');
  const qrImage = document.getElementById('share-qr-image');
  const urlElement = document.getElementById('cloudinary-url');

  if (stripImage && data.stripPath) {
    stripImage.src = 'file://' + data.stripPath;
  }

  if (qrImage && data.qrDataUrl) {
    qrImage.src = data.qrDataUrl;
  }

  if (urlElement) {
    if (data.sessionInfo.cloudinary_url === 'UPLOAD_FAILED') {
      urlElement.textContent = 'QR unavailable — upload failed';
      urlElement.classList.add('error');
    } else {
      const url = data.sessionInfo.cloudinary_url;
      const truncated = url.length > 50 ? url.substring(0, 50) + '…' : url;
      urlElement.textContent = truncated;
      urlElement.classList.remove('error');
    }
  }
});

// ===== PROCESSING STATUS =====
window.booth.onProcessingStatus((message) => {
  const statusElement = document.getElementById('processing-status');
  if (statusElement) {
    statusElement.textContent = message;
  }
});

// ===== KEYBOARD INPUT =====
document.addEventListener('keydown', (e) => {
  if (e.code === 'Space') {
    e.preventDefault();
    window.booth.onSpacePressed(() => {
      if (state === 'LAYOUT_SELECT') {
        window.booth.cancelToSleep();
      } else if (state === 'LIVE') {
        window.booth.startSession();
      } else if (state === 'SHARE') {
        window.booth.cancelToSleep();
      }
    });
  } else if (e.code === 'Digit1' && state === 'LAYOUT_SELECT') {
    e.preventDefault();
    selectLayout('vertical');
  } else if (e.code === 'Digit2' && state === 'LAYOUT_SELECT') {
    e.preventDefault();
    selectLayout('horizontal');
  }
});

// ===== LAYOUT SELECTION =====
function selectLayout(layout) {
  sessionLayout = layout;
  window.booth.selectLayout(layout);
}

// Layout option click handlers
const layoutVertical = document.getElementById('layout-vertical');
const layoutHorizontal = document.getElementById('layout-horizontal');

if (layoutVertical) {
  layoutVertical.addEventListener('click', () => {
    selectLayout('vertical');
  });
}

if (layoutHorizontal) {
  layoutHorizontal.addEventListener('click', () => {
    selectLayout('horizontal');
  });
}

// ===== ERROR DISPLAY =====
window.booth.onCameraError((message) => {
  showError(message);
});

function showError(message) {
  const errorMsg = document.getElementById('error-message');
  if (errorMsg) {
    errorMsg.textContent = message;
  }
  errorOverlay.classList.add('active');

  setTimeout(() => {
    errorOverlay.classList.remove('active');
  }, 5000);
}

// ===== STATE CHANGE LISTENER =====
window.booth.onStateChange((newState) => {
  transitionToState(newState);
});

// ===== INITIALIZATION =====
window.addEventListener('load', () => {
  setupCanvases();
  transitionToState('SLEEP');
});

window.addEventListener('resize', () => {
  setupCanvases();
});
