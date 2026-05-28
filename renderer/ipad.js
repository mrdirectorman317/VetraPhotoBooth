// ===== DEFAULT CONFIG FALLBACKS =====
const DEFAULTS = {
  cloudinaryCloudName: 'dpscec1f2',
  cloudinaryUploadPreset: 'vetra_booth',
  geminiApiKey: 'AIzaSyCw17tWYY3FhzCQa39_Stfw0yuBcLOra28',
  templateUrl: 'https://res.cloudinary.com/dpscec1f2/image/upload/v1779994991/nvt7amiptjrxbtpzy71y.png'
};

// ===== STATE =====
let config = {};
let state = 'SLEEP';
let currentStream = null;
let currentFacingMode = 'user'; // Front camera default for booth stand
let capturedPhotos = []; // Array of blobs or dataUrls
let funnyPhotos = [];
let mainStripBlob = null;
let funnyStripBlob = null;
let mainStripUrl = '';
let funnyStripUrl = '';
let countdownTimer = null;
let shareTimeoutTimer = null;
let shareTimerRAF = null;

// ===== CONSTANTS =====
const PHOTO_COUNT = 3;
const COUNTDOWN_TICK_MS = 850;
const SHARE_TIMER_S = 180;
const BEEP_FREQS = { 3: 550, 2: 660, 1: 880, snap: 1320 };

// ===== DOM SELECTORS =====
const $ = id => document.getElementById(id);
const sleepScreen = $('sleep-screen');
const liveScreen = $('live-screen');
const countdownScreen = $('countdown-screen');
const processingScreen = $('processing-screen');
const shareScreen = $('share-screen');
const settingsModal = $('settings-modal');
const errorOverlay = $('error-overlay');
const errorMessage = $('error-message');

const liveVideo = $('live-video');
const countdownVideo = $('countdown-video');
const countdownNumber = $('countdown-number');
const photoCounter = $('photo-counter');
const flashOverlay = $('flash-overlay');
const processingStatus = $('processing-status');
const processingSubstatus = $('processing-substatus');

const shareStripImage = $('share-strip-image');
const shareStripFunny = $('share-strip-funny');
const funnyStripWrap = $('funny-strip-wrap');
const funnyStripStatus = $('funny-strip-status');
const shareQRImage = $('share-qr-image');
const shareQrFunny = $('share-qr-funny');
const qrLoading = $('qr-loading');
const funnyQrLoading = $('funny-qr-loading');
const funnyQrBlock = $('funny-qr-block');
const timerBar = $('timer-bar');
const timerLabel = $('timer-label');

// Buttons
const sleepTriggerBtn = $('sleep-trigger-btn');
const settingsOpenBtn = $('settings-open-btn');
const settingsCancelBtn = $('settings-cancel-btn');
const settingsSaveBtn = $('settings-save-btn');
const cameraToggleBtn = $('camera-toggle-btn');
const liveActionBtn = $('live-action-btn');
const shareResetBtn = $('share-reset-btn');

// Input fields
const inputCloudinaryCloud = $('set-cloudinary-cloud');
const inputCloudinaryPreset = $('set-cloudinary-preset');
const inputGeminiKey = $('set-gemini-key');

// ===== AUDIO CONTEXT =====
let audioCtx = null;
function initAudio() {
  if (!audioCtx) {
    audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  if (audioCtx.state === 'suspended') {
    audioCtx.resume();
  }
}

function playBeep(freq = 880, durationMs = 220, volume = 0.6) {
  if (!audioCtx) return;
  try {
    const osc = audioCtx.createOscillator();
    const gain = audioCtx.createGain();
    osc.connect(gain);
    gain.connect(audioCtx.destination);
    osc.type = 'sine';
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(volume, audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + durationMs / 1000);
    osc.start();
    osc.stop(audioCtx.currentTime + durationMs / 1000);
  } catch (e) {
    console.error('Audio error:', e);
  }
}

// ===== CONFIGURATION MANAGEMENT =====
function loadConfig() {
  config = {
    cloudinaryCloudName: localStorage.getItem('cloudinaryCloudName') || DEFAULTS.cloudinaryCloudName,
    cloudinaryUploadPreset: localStorage.getItem('cloudinaryUploadPreset') || DEFAULTS.cloudinaryUploadPreset,
    geminiApiKey: localStorage.getItem('geminiApiKey') || DEFAULTS.geminiApiKey
  };
  
  // Populate form fields
  inputCloudinaryCloud.value = config.cloudinaryCloudName;
  inputCloudinaryPreset.value = config.cloudinaryUploadPreset;
  inputGeminiKey.value = config.geminiApiKey;
}

function saveConfig() {
  const cloud = inputCloudinaryCloud.value.trim();
  const preset = inputCloudinaryPreset.value.trim();
  const key = inputGeminiKey.value.trim();
  
  localStorage.setItem('cloudinaryCloudName', cloud);
  localStorage.setItem('cloudinaryUploadPreset', preset);
  localStorage.setItem('geminiApiKey', key);
  
  config.cloudinaryCloudName = cloud;
  config.cloudinaryUploadPreset = preset;
  config.geminiApiKey = key;
  
  hideSettings();
}

function showSettings() {
  settingsModal.classList.add('active');
}

function hideSettings() {
  settingsModal.classList.remove('active');
}

// ===== SCREEN ROUTING =====
function transitionToState(newState) {
  console.log(`Transition: ${state} -> ${newState}`);
  state = newState;
  
  // Hide all screens
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  
  switch(state) {
    case 'SLEEP':
      stopCamera();
      stopShareTimer();
      resetDots();
      sleepScreen.classList.add('active');
      break;
      
    case 'LIVE':
      liveScreen.classList.add('active');
      startCamera(liveVideo);
      break;
      
    case 'COUNTDOWN':
      countdownScreen.classList.add('active');
      // Pass the countdown video element to maintain active preview
      startCamera(countdownVideo).then(() => {
        runCaptureSequence();
      });
      break;
      
    case 'PROCESSING':
      processingScreen.classList.add('active');
      stopCamera();
      processSession();
      break;
      
    case 'SHARE':
      shareScreen.classList.add('active');
      startShareTimer();
      break;
  }
}

// ===== CAMERA SYSTEM =====
async function startCamera(videoElement) {
  stopCamera();
  
  // Set video transform based on mirror requirements
  if (currentFacingMode === 'user') {
    videoElement.classList.remove('no-mirror');
  } else {
    videoElement.classList.add('no-mirror');
  }

  try {
    const constraints = {
      video: {
        facingMode: currentFacingMode,
        width: { ideal: 1920 },
        height: { ideal: 1080 }
      },
      audio: false
    };
    
    currentStream = await navigator.mediaDevices.getUserMedia(constraints);
    videoElement.srcObject = currentStream;
    await videoElement.play();
  } catch (err) {
    console.error('Camera Access Error:', err);
    showError('Could not access camera. Please allow camera permissions and check connection.');
  }
}

function stopCamera() {
  if (currentStream) {
    currentStream.getTracks().forEach(track => track.stop());
    currentStream = null;
  }
  liveVideo.srcObject = null;
  countdownVideo.srcObject = null;
}

function toggleCamera() {
  currentFacingMode = (currentFacingMode === 'user') ? 'environment' : 'user';
  startCamera(liveVideo);
}

// ===== COUNTDOWN & SNAPSHOTS =====
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

function triggerFlash() {
  flashOverlay.style.transition = 'none';
  flashOverlay.style.opacity = '1';
  flashOverlay.style.visibility = 'visible';
  requestAnimationFrame(() => {
    requestAnimationFrame(() => {
      flashOverlay.style.transition = 'opacity 0.5s ease-out';
      flashOverlay.style.opacity = '0';
    });
  });
  setTimeout(() => { flashOverlay.style.visibility = 'hidden'; }, 600);
}

const sleepMs = ms => new Promise(r => setTimeout(r, ms));

async function runCaptureSequence() {
  capturedPhotos = [];
  resetDots();
  
  for (let i = 1; i <= PHOTO_COUNT; i++) {
    photoCounter.textContent = `PHOTO ${i} OF ${PHOTO_COUNT}`;
    
    const showBeat = n => {
      countdownNumber.textContent = String(n);
      countdownNumber.classList.remove('pop');
      void countdownNumber.offsetWidth; // Trigger reflow
      countdownNumber.classList.add('pop');
      playBeep(BEEP_FREQS[n], 160, 0.65);
    };
    
    // Beat 3 & 2
    for (let n = 3; n >= 2; n--) {
      showBeat(n);
      await sleepMs(COUNTDOWN_TICK_MS);
    }
    
    // Beat 1
    showBeat(1);
    await sleepMs(COUNTDOWN_TICK_MS - 200); // Shutter fires slightly early to catch action
    
    // Capture Moment
    triggerFlash();
    playBeep(BEEP_FREQS.snap, 90, 0.75);
    
    const blob = await captureVideoFrame(countdownVideo);
    capturedPhotos.push(blob);
    fillDot(i);
    
    await sleepMs(300); // Short pause after flash
  }
  
  transitionToState('PROCESSING');
}

// Capture video frame onto a canvas and return JPEG Blob
function captureVideoFrame(video) {
  return new Promise(resolve => {
    const canvas = document.createElement('canvas');
    canvas.width = video.videoWidth || 1920;
    canvas.height = video.videoHeight || 1080;
    
    const ctx = canvas.getContext('2d');
    
    // Mirror photo if front camera is used
    if (currentFacingMode === 'user') {
      ctx.translate(canvas.width, 0);
      ctx.scale(-1, 1);
    }
    
    ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
    canvas.toBlob(resolve, 'image/jpeg', 0.90);
  });
}

// ===== IMAGE COMPOSITING (HTML5 CANVAS) =====
function blobToImage(blob) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = URL.createObjectURL(blob);
  });
}

function loadImage(url) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = 'anonymous'; // Prevent tainted canvas issues on Cloudinary templates
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = url;
  });
}

async function buildStrip(photos, suffix = '') {
  const canvasW = 1200, canvasH = 2440;
  const slotW = 1080, slotH = 720;
  const slots = [
    { x: 60, y: 80 },
    { x: 60, y: 860 },
    { x: 60, y: 1640 },
  ];

  const canvas = document.createElement('canvas');
  canvas.width = canvasW;
  canvas.height = canvasH;
  const ctx = canvas.getContext('2d');

  // 1. Draw solid background
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, canvasW, canvasH);

  // 2. Draw Photos into slots (aspect-cover cropping)
  for (let i = 0; i < 3; i++) {
    if (!photos[i]) continue;
    const img = await blobToImage(photos[i]);
    const slot = slots[i];

    // Crop calculation (fit: cover)
    const imgAspect = img.width / img.height;
    const slotAspect = slotW / slotH;
    let sWidth, sHeight, sx, sy;

    if (imgAspect > slotAspect) {
      // Image is wider than slot
      sHeight = img.height;
      sWidth = img.height * slotAspect;
      sx = (img.width - sWidth) / 2;
      sy = 0;
    } else {
      // Image is taller than slot
      sWidth = img.width;
      sHeight = img.width / slotAspect;
      sx = 0;
      sy = (img.height - sHeight) / 2;
    }

    ctx.drawImage(img, sx, sy, sWidth, sHeight, slot.x, slot.y, slotW, slotH);
  }

  // 3. Overlay the PNG template
  try {
    const template = await loadImage(DEFAULTS.templateUrl);
    ctx.drawImage(template, 0, 0, canvasW, canvasH);
  } catch (e) {
    console.error('Failed to load template:', e);
  }

  // 4. Return as JPEG Blob
  return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.92));
}

// ===== CLOUDINARY UPLOAD CLIENT =====
async function uploadToCloudinary(blob) {
  if (!config.cloudinaryCloudName || !config.cloudinaryUploadPreset) {
    throw new Error('Cloudinary not configured');
  }

  const formData = new FormData();
  formData.append('file', blob);
  formData.append('upload_preset', config.cloudinaryUploadPreset);

  const res = await fetch(`https://api.cloudinary.com/v1_1/${config.cloudinaryCloudName}/image/upload`, {
    method: 'POST',
    body: formData
  });

  if (!res.ok) {
    const errorData = await res.json();
    throw new Error(errorData.error?.message || 'Upload to Cloudinary failed');
  }

  const data = await res.json();
  return data.secure_url;
}

// ===== GEMINI FUNNY GENERATIVE AI SERVICE =====
// Resize blob to maximum 1024 width/height for Gemini speed
async function resizeForGemini(blob) {
  const img = await blobToImage(blob);
  const canvas = document.createElement('canvas');
  const maxDim = 1024;
  let w = img.width;
  let h = img.height;
  
  if (w > maxDim || h > maxDim) {
    if (w > h) {
      h = Math.round((h * maxDim) / w);
      w = maxDim;
    } else {
      w = Math.round((w * maxDim) / h);
      h = maxDim;
    }
  }
  
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.drawImage(img, 0, 0, w, h);
  
  return new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.82));
}

function blobToBase64(blob) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64String = reader.result.split(',')[1];
      resolve(base64String);
    };
    reader.readAsDataURL(blob);
  });
}

function getFunnyPromptForIndex(index) {
  if (index === 0) {
    return "Add a cute baby bonnet on each person's head, funny photo booth style. Keep faces recognizable. Same background and pose. Photorealistic.";
  } else if (index === 1) {
    return "Add a baby pacifier in each person's mouth, funny photo booth style. Keep faces recognizable. Same background and pose. Photorealistic.";
  } else {
    return "Add a baby bib around each person's neck with messy baby food smeared on the bib and on their faces, funny photo booth style. Keep faces recognizable. Same background and pose. Photorealistic.";
  }
}

async function runGeminiFunnyFilter(blob, prompt) {
  if (!config.geminiApiKey) {
    throw new Error('Gemini API key missing');
  }

  const resizedBlob = await resizeForGemini(blob);
  const base64Data = await blobToBase64(resizedBlob);

  const payload = {
    contents: [{
      parts: [
        { text: prompt },
        { inlineData: { mimeType: 'image/jpeg', data: base64Data } }
      ]
    }],
    generationConfig: {
      responseModalities: ['TEXT', 'IMAGE']
    }
  };

  const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-image:generateContent?key=${config.geminiApiKey}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify(payload)
  });

  if (!res.ok) {
    throw new Error(`Gemini API returned status ${res.status}`);
  }

  const data = await res.json();
  
  // Extract image bytes from Candidates
  let base64Image = null;
  const parts = data.candidates?.[0]?.content?.parts || data.content?.parts;
  
  if (parts) {
    for (const part of parts) {
      const b64 = part.inlineData?.data || part.inline_data?.data;
      if (b64) {
        base64Image = b64;
        break;
      }
    }
  }

  if (!base64Image) {
    const reason = data.candidates?.[0]?.finishReason || 'unknown block';
    throw new Error(`Gemini did not return image. Reason: ${reason}`);
  }

  // Convert base64 back to Blob
  const byteCharacters = atob(base64Image);
  const byteNumbers = new Array(byteCharacters.length);
  for (let i = 0; i < byteCharacters.length; i++) {
    byteNumbers[i] = byteCharacters.charCodeAt(i);
  }
  const byteArray = new Uint8Array(byteNumbers);
  return new Blob([byteArray], { type: 'image/jpeg' });
}

// ===== PROCESSING CONTROL WORKFLOW =====
async function processSession() {
  try {
    // 1. Build main vertical strip locally
    processingStatus.textContent = 'Developing your photos...';
    processingSubstatus.textContent = 'Compositing film strip...';
    
    mainStripBlob = await buildStrip(capturedPhotos);
    shareStripImage.src = URL.createObjectURL(mainStripBlob);
    
    // Update Share view elements
    qrLoading.classList.remove('hidden');
    shareQRImage.classList.add('hidden');
    funnyStripWrap.classList.add('hidden');
    funnyQrBlock.classList.add('hidden');
    funnyStripStatus.classList.add('hidden');
    
    transitionToState('SHARE');

    // 2. Upload main strip to Cloudinary
    uploadToCloudinary(mainStripBlob).then(url => {
      mainStripUrl = url;
      console.log('Main strip Cloudinary URL:', url);
      
      // Update Main QR code
      const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(url)}`;
      shareQRImage.src = qrUrl;
      shareQRImage.classList.remove('hidden');
      qrLoading.classList.add('hidden');
    }).catch(err => {
      console.error('Main strip upload failed:', err);
      showError('Cloudinary upload failed. Check internet connection and upload presets in Settings.');
      qrLoading.textContent = 'Upload failed';
    });

    // 3. Build funny strip in background
    if (config.geminiApiKey) {
      runFunnyPipeline();
    }

  } catch (err) {
    console.error('Session processing error:', err);
    showError(`Error processing photos: ${err.message}`);
  }
}

async function runFunnyPipeline() {
  funnyStripStatus.classList.remove('hidden');
  funnyQrBlock.classList.remove('hidden');
  funnyQrLoading.classList.remove('hidden');
  shareQrFunny.classList.add('hidden');

  funnyPhotos = [];
  let geminiErrorMsg = null;
  
  for (let idx = 0; idx < capturedPhotos.length; idx++) {
    const photo = capturedPhotos[idx];
    try {
      funnyStripStatus.querySelector('span').textContent = `Creating bonus strip (photo ${idx+1}/${capturedPhotos.length})...`;
      const prompt = getFunnyPromptForIndex(idx);
      const funnyBlob = await runGeminiFunnyFilter(photo, prompt);
      funnyPhotos[idx] = funnyBlob;
      
      // Wait 1.2s between calls to prevent 429 concurrent limit
      if (idx < capturedPhotos.length - 1) {
        await sleepMs(1200);
      }
    } catch (e) {
      console.warn(`Gemini transformation failed for photo ${idx+1}. Using original.`, e);
      geminiErrorMsg = e.message;
      funnyPhotos[idx] = photo; // Fallback to original photo
    }
  }

  if (geminiErrorMsg) {
    showError(`AI Transform Failed: ${geminiErrorMsg}. Using original photos as fallback.`);
  }

  try {
    funnyStripStatus.querySelector('span').textContent = 'Compositing bonus strip...';
    
    funnyStripBlob = await buildStrip(funnyPhotos, '_funny');
    shareStripFunny.src = URL.createObjectURL(funnyStripBlob);
    funnyStripWrap.classList.remove('hidden');
    funnyStripStatus.classList.add('hidden');
    
    // Upload bonus strip
    uploadToCloudinary(funnyStripBlob).then(url => {
      funnyStripUrl = url;
      console.log('Bonus strip Cloudinary URL:', url);
      
      // Update Funny QR code
      const qrUrl = `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(url)}`;
      shareQrFunny.src = qrUrl;
      shareQrFunny.classList.remove('hidden');
      funnyQrLoading.classList.add('hidden');
    }).catch(err => {
      console.error('Bonus strip upload failed:', err);
      funnyQrLoading.textContent = 'Upload failed';
    });
  } catch (err) {
    console.error('Funny pipeline failure:', err);
    funnyStripStatus.classList.add('hidden');
    funnyQrBlock.classList.add('hidden');
  }
}

// ===== AUTO RESET TIMER (180s) =====
function startShareTimer() {
  stopShareTimer();
  const startMs = Date.now();
  const totalMs = SHARE_TIMER_S * 1000;

  const tick = () => {
    const elapsed = Date.now() - startMs;
    const remaining = Math.max(0, totalMs - elapsed);
    const secs = Math.ceil(remaining / 1000);
    const pct = (remaining / totalMs) * 100;

    timerBar.style.width = pct + '%';
    
    const m = Math.floor(secs / 60);
    const s = secs % 60;
    timerLabel.textContent = `Restarting in ${m}:${s.toString().padStart(2, '0')}`;

    if (remaining > 0) {
      shareTimerRAF = requestAnimationFrame(tick);
    } else {
      transitionToState('SLEEP');
    }
  };

  shareTimerRAF = requestAnimationFrame(tick);
}

function stopShareTimer() {
  if (shareTimerRAF) {
    cancelAnimationFrame(shareTimerRAF);
    shareTimerRAF = null;
  }
}

// ===== ERROR SYSTEM =====
function showError(msg) {
  errorMessage.textContent = msg;
  errorOverlay.classList.add('active');
  setTimeout(() => {
    errorOverlay.classList.remove('active');
  }, 6000);
}

// ===== INITIALIZE EVENT LISTENERS =====
window.addEventListener('load', () => {
  loadConfig();
  
  // Sleep start
  sleepTriggerBtn.addEventListener('click', () => {
    initAudio();
    transitionToState('LIVE');
  });

  // Settings
  settingsOpenBtn.addEventListener('click', showSettings);
  settingsCancelBtn.addEventListener('click', hideSettings);
  settingsSaveBtn.addEventListener('click', saveConfig);

  // Camera settings
  cameraToggleBtn.addEventListener('click', toggleCamera);
  liveActionBtn.addEventListener('click', () => {
    initAudio();
    transitionToState('COUNTDOWN');
  });

  // Share screen reset
  shareResetBtn.addEventListener('click', () => {
    transitionToState('SLEEP');
  });
});
