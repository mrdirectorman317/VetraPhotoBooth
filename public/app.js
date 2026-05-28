/* ─── Constants ───────────────────────────────────────────────── */
const PHOTO_COUNT      = 3;
const COUNTDOWN_FROM   = 3;
const BETWEEN_MS       = 3000;   // pause between photos (ms)
const LAST_PHOTO_MS    = 1200;   // brief pause after final photo
const IDLE_TIMEOUT_MS  = 3 * 60 * 1000;  // 3 minutes

// Capture canvas size
const CAP_W = 640;
const CAP_H = 480;

// Vertical strip layout
const VS = {
  padX:    52, padTop:  88,
  padBot:  64, gap:     18,
  photoW: 500, photoH: 375,
};
VS.canvasW = VS.photoW + VS.padX * 2;
VS.canvasH = VS.padTop + (VS.photoH + VS.gap) * PHOTO_COUNT - VS.gap + VS.padBot;

// Horizontal strip layout
const HS = {
  padX:    46, padTop: 62,
  padBot:  62, gap:   16,
  photoW: 480, photoH: 360,
};
HS.canvasW = HS.padX * 2 + (HS.photoW + HS.gap) * PHOTO_COUNT - HS.gap;
HS.canvasH = HS.padTop + HS.photoH + HS.padBot;

/* ─── Helpers ─────────────────────────────────────────────────── */
const sleep = ms => new Promise(r => setTimeout(r, ms));

function formatMM_SS(ms) {
  const s   = Math.ceil(ms / 1000);
  const min = Math.floor(s / 60);
  const sec = s % 60;
  return `${min}:${sec.toString().padStart(2, '0')}`;
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload  = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

/* ─── PhotoBooth class ────────────────────────────────────────── */
class PhotoBooth {
  constructor() {
    this.state     = 'idle';
    this.stream    = null;
    this.photos    = [];       // data URLs of captured frames
    this.busy      = false;    // prevents double-triggers
    this.audioCtx  = null;
    this.idleTimer = null;
    this.qrRaf     = null;

    /* DOM refs */
    this.video         = document.getElementById('main-video');
    this.capCanvas     = document.getElementById('capture-canvas');
    this.capCtx        = this.capCanvas.getContext('2d');
    this.capCanvas.width  = CAP_W;
    this.capCanvas.height = CAP_H;

    this.stripVCanvas  = document.getElementById('strip-v-canvas');

    this.$ = id => document.getElementById(id);

    document.addEventListener('keydown',    e => this._onKey(e));
    document.addEventListener('click',      () => this._onActivity());
    document.addEventListener('touchstart', () => this._onActivity(), { passive: true });
  }

  /* ── Input handling ────────────────────────────────────────── */

  _onActivity() {
    if (this.state === 'qr') this._resetIdleTimer();
  }

  async _onKey(e) {
    if (e.code !== 'Space') return;
    e.preventDefault();
    if (this.busy) return;
    this._onActivity();

    if (this.state === 'idle')    { await this._toPreview();    return; }
    if (this.state === 'preview') { await this._startSession(); return; }
    if (this.state === 'qr')      { this._toIdle();             return; }
  }

  /* ── Screen management ─────────────────────────────────────── */

  _showScreen(id) {
    ['screen-idle','screen-preview','screen-capturing',
     'screen-processing','screen-qr'].forEach(s => {
      document.getElementById(s).classList.toggle('active', s === id);
    });
    // Video is visible only during camera screens
    const needsVideo = id === 'screen-preview' || id === 'screen-capturing';
    this.video.style.display = needsVideo ? 'block' : 'none';
  }

  _showOverlay(id)  { this.$(id).classList.remove('hidden'); }
  _hideOverlay(id)  { this.$(id).classList.add('hidden');    }

  _showError(msg, hint = '') {
    this.$('error-message').textContent = msg;
    this.$('error-hint').textContent    = hint;
    this.$('error-overlay').classList.remove('hidden');
  }
  _hideError() { this.$('error-overlay').classList.add('hidden'); }

  /* ── Camera ────────────────────────────────────────────────── */

  async _startCamera() {
    this.stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' },
      audio: false,
    });
    this.video.srcObject = this.stream;
    await new Promise(res => { this.video.onloadedmetadata = res; });
    await this.video.play();
  }

  _stopCamera() {
    if (this.stream) {
      this.stream.getTracks().forEach(t => t.stop());
      this.stream = null;
      this.video.srcObject = null;
    }
  }

  /* ── State transitions ─────────────────────────────────────── */

  _toIdle() {
    this.state  = 'idle';
    this.photos = [];
    this.busy   = false;
    this._stopCamera();
    this._clearIdleTimer();
    this._clearQrRaf();
    this._hideOverlay('countdown-overlay');
    this._hideOverlay('between-overlay');
    this.$('flash-overlay').classList.remove('flashing');
    this._hideError();
    this._showScreen('screen-idle');
  }

  async _toPreview() {
    this.busy = true;
    // First user gesture – init audio & request fullscreen
    this._initAudio();
    try {
      if (document.documentElement.requestFullscreen)
        await document.documentElement.requestFullscreen().catch(() => {});
    } catch (_) {}

    try {
      await this._startCamera();
    } catch (err) {
      this._showError(
        'Camera access is required.',
        'Please allow camera access in your browser, then press SPACE BAR.'
      );
      this.busy = false;
      return;
    }

    this.state = 'preview';
    this.busy  = false;
    this._showScreen('screen-preview');
  }

  async _startSession() {
    if (this.busy) return;
    this.busy   = true;
    this.state  = 'capturing';
    this.photos = [];
    this._showScreen('screen-capturing');
    await this._runCaptureSequence();
  }

  async _runCaptureSequence() {
    for (let i = 0; i < PHOTO_COUNT; i++) {
      const num = i + 1;
      await this._doCountdown(num);
      const dataUrl = await this._flashAndCapture();
      this.photos.push(dataUrl);

      const pause = i < PHOTO_COUNT - 1 ? BETWEEN_MS : LAST_PHOTO_MS;
      await this._showBetween(dataUrl, num, pause);
    }

    await this._toProcessing();
  }

  async _doCountdown(photoNum) {
    this._hideOverlay('between-overlay');
    this.$('photo-label').textContent = `PHOTO ${photoNum} OF ${PHOTO_COUNT}`;
    this._showOverlay('countdown-overlay');

    for (let n = COUNTDOWN_FROM; n >= 1; n--) {
      this.$('countdown-number').textContent = n;
      this._beep(n > 1 ? 660 : 880, 220);
      await sleep(1000);
    }

    this._hideOverlay('countdown-overlay');
  }

  async _flashAndCapture() {
    // Shutter beep (higher, shorter)
    this._beep(1320, 100, 0.9);

    const flashEl = this.$('flash-overlay');
    flashEl.classList.remove('flashing');
    void flashEl.offsetWidth; // force reflow to restart animation
    flashEl.classList.add('flashing');

    // Capture while flash is bright
    this.capCtx.drawImage(this.video, 0, 0, CAP_W, CAP_H);
    const dataUrl = this.capCanvas.toDataURL('image/jpeg', 0.92);

    await sleep(560);
    flashEl.classList.remove('flashing');
    return dataUrl;
  }

  async _showBetween(src, num, duration) {
    this.$('between-img').src    = src;
    this.$('between-text').textContent = `PHOTO ${num} OF ${PHOTO_COUNT}  ✓`;
    this._showOverlay('between-overlay');
    await sleep(duration);
    this._hideOverlay('between-overlay');
  }

  async _toProcessing() {
    this.state = 'processing';
    this._stopCamera();
    this._showScreen('screen-processing');

    try {
      const strips = await this._composeStrips();
      const res    = await fetch('/api/upload', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(strips),
      });
      if (!res.ok) throw new Error('Upload failed');
      const data = await res.json();
      this._toQR(data.qr);
    } catch (err) {
      console.error(err);
      // Still go to QR screen; show strip without download URL
      this._toQROffline();
    }
  }

  /* ── Strip composition ─────────────────────────────────────── */

  async _composeStrips() {
    const imgs = await Promise.all(this.photos.map(loadImage));

    // Vertical
    this.stripVCanvas.width  = VS.canvasW;
    this.stripVCanvas.height = VS.canvasH;
    this._drawVertical(this.stripVCanvas.getContext('2d'), imgs);

    // Horizontal (off-screen canvas)
    const hCanvas = document.createElement('canvas');
    hCanvas.width  = HS.canvasW;
    hCanvas.height = HS.canvasH;
    this._drawHorizontal(hCanvas.getContext('2d'), imgs);

    return {
      vertical:   this.stripVCanvas.toDataURL('image/jpeg', 0.93),
      horizontal: hCanvas.toDataURL('image/jpeg', 0.93),
    };
  }

  _drawVertical(ctx, imgs) {
    const date = new Date().toLocaleDateString('en-US',
      { month: 'long', day: 'numeric', year: 'numeric' });

    // Background
    ctx.fillStyle = '#181818';
    ctx.fillRect(0, 0, VS.canvasW, VS.canvasH);

    // Sprocket holes
    this._drawSprockets(ctx, VS);

    // Header
    ctx.fillStyle    = '#f0c060';
    ctx.font         = 'bold 30px "Arial Black", Arial, sans-serif';
    ctx.textAlign    = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText('VETRA PHOTO BOOTH', VS.canvasW / 2, VS.padTop / 2);

    // Photos
    imgs.forEach((img, i) => {
      const x = VS.padX;
      const y = VS.padTop + i * (VS.photoH + VS.gap);
      // White mat border
      ctx.fillStyle = '#fff';
      ctx.fillRect(x - 4, y - 4, VS.photoW + 8, VS.photoH + 8);
      ctx.drawImage(img, x, y, VS.photoW, VS.photoH);
    });

    // Footer
    ctx.fillStyle    = '#555';
    ctx.font         = '18px Arial, sans-serif';
    ctx.textBaseline = 'middle';
    ctx.fillText(date, VS.canvasW / 2, VS.canvasH - VS.padBot / 2);
  }

  _drawHorizontal(ctx, imgs) {
    const date = new Date().toLocaleDateString('en-US',
      { month: 'long', day: 'numeric', year: 'numeric' });

    ctx.fillStyle = '#181818';
    ctx.fillRect(0, 0, HS.canvasW, HS.canvasH);

    // Header left
    ctx.fillStyle    = '#f0c060';
    ctx.font         = 'bold 26px "Arial Black", Arial, sans-serif';
    ctx.textAlign    = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillText('VETRA PHOTO BOOTH', HS.padX, HS.padTop / 2);

    // Date right
    ctx.fillStyle  = '#555';
    ctx.font       = '18px Arial, sans-serif';
    ctx.textAlign  = 'right';
    ctx.fillText(date, HS.canvasW - HS.padX, HS.padTop / 2);

    // Photos
    imgs.forEach((img, i) => {
      const x = HS.padX + i * (HS.photoW + HS.gap);
      const y = HS.padTop;
      ctx.fillStyle = '#fff';
      ctx.fillRect(x - 4, y - 4, HS.photoW + 8, HS.photoH + 8);
      ctx.drawImage(img, x, y, HS.photoW, HS.photoH);
    });
  }

  _drawSprockets(ctx, s) {
    const hw = 11, hh = 17, r = 3, spacing = 42, margin = 10;
    ctx.fillStyle = '#050505';
    for (let y = 24; y < s.canvasH - 10; y += spacing) {
      roundRect(ctx, margin, y, hw, hh, r);              ctx.fill();
      roundRect(ctx, s.canvasW - margin - hw, y, hw, hh, r); ctx.fill();
    }
  }

  /* ── QR screen ─────────────────────────────────────────────── */

  _toQR(qrDataUrl) {
    this.state = 'qr';
    this.$('qr-image').src = qrDataUrl;
    this.$('qr-scan-text').textContent = '📱 Scan with your phone to save';
    this._showScreen('screen-qr');
    this._startIdleTimer();
    this._startQrCountdown();
  }

  _toQROffline() {
    this.state = 'qr';
    this.$('qr-image').src = '';
    this.$('qr-scan-text').textContent = 'Upload unavailable – see the attendant';
    this.$('qr-box').style.display = 'none';
    this._showScreen('screen-qr');
    this._startIdleTimer();
    this._startQrCountdown();
  }

  /* ── Idle / QR timer ───────────────────────────────────────── */

  _startIdleTimer() {
    this._clearIdleTimer();
    this.idleTimer = setTimeout(() => this._toIdle(), IDLE_TIMEOUT_MS);
  }

  _clearIdleTimer() {
    if (this.idleTimer) { clearTimeout(this.idleTimer); this.idleTimer = null; }
  }

  _resetIdleTimer() {
    this._startIdleTimer();
  }

  _startQrCountdown() {
    this._clearQrRaf();
    const start = Date.now();

    const tick = () => {
      const elapsed   = Date.now() - start;
      const remaining = Math.max(0, IDLE_TIMEOUT_MS - elapsed);
      const pct       = (remaining / IDLE_TIMEOUT_MS) * 100;

      this.$('qr-timer-bar').style.width    = pct + '%';
      this.$('qr-timer-label').textContent  = `Restarting in ${formatMM_SS(remaining)}`;

      if (remaining > 0) this.qrRaf = requestAnimationFrame(tick);
    };

    this.qrRaf = requestAnimationFrame(tick);
  }

  _clearQrRaf() {
    if (this.qrRaf) { cancelAnimationFrame(this.qrRaf); this.qrRaf = null; }
  }

  /* ── Audio ─────────────────────────────────────────────────── */

  _initAudio() {
    if (!this.audioCtx) {
      this.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
  }

  _beep(freq = 880, dur = 180, vol = 0.55) {
    if (!this.audioCtx) return;
    const osc  = this.audioCtx.createOscillator();
    const gain = this.audioCtx.createGain();
    osc.connect(gain);
    gain.connect(this.audioCtx.destination);
    osc.type = 'sine';
    osc.frequency.setValueAtTime(freq, this.audioCtx.currentTime);
    gain.gain.setValueAtTime(vol, this.audioCtx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, this.audioCtx.currentTime + dur / 1000);
    osc.start(this.audioCtx.currentTime);
    osc.stop(this.audioCtx.currentTime + dur / 1000);
  }
}

/* ─── Boot ────────────────────────────────────────────────────── */
new PhotoBooth();
