# Vetra Photo Booth – Handoff File

## What it is
Electron + gphoto2 + sharp photo booth kiosk app. Users press space bar → live preview from a Fujifilm X-T2 DSLR → takes 3 photos with beeping 3-2-1 countdown and camera flash → shows each photo for 3 seconds → composes vertical + horizontal film strips → generates QR code → phones scan to save strips locally (no internet needed, works on same WiFi).

## Current issue
**Black screen on launch, app unresponsive, had to force quit.**

Likely causes:
1. **Camera not detected** — gphoto2 fails to initialize, app crashes silently
2. **Window not rendering** — Electron main process error
3. **Dev mode keyboard shortcut not working** — can't exit with Cmd+Shift+Q

## What should happen
1. Launch: dark sleep screen with "PRESS SPACE BAR TO BEGIN" (pulsing)
2. Space bar: live video stream from camera appears
3. Space bar again: 3-photo capture sequence with beeps
4. After 3 photos: processing spinner → shows QR code on screen
5. Scan QR on phone: save page opens → "Save Vertical/Horizontal Strip" buttons

## To debug
1. **Check terminal output** — paste any errors from the console
2. **Verify gphoto2 installed**:
   ```bash
   gphoto2 --version
   gphoto2 --auto-detect
   ```
3. **Try without camera first** (app should still launch):
   ```bash
   npm run start:dev
   ```
   You should see the dark sleep screen. If you see a black screen instead, there's a render/init error.
4. **Exit dev mode**: Press **Cmd+Shift+Q** (not Cmd+Q)

## Key files
- `main.js` — Electron main process, camera control, state machine
- `renderer/booth.js` — UI state machine, countdown logic, Web Audio beeps
- `renderer/index.html` — screen structure (sleep, live, countdown, share)
- `.env` — Cloudinary credentials (optional; app works without it)

## Requirements
- macOS 11+
- Node 16+
- `gphoto2` (run `brew install gphoto2`)
- Fujifilm X-T2 camera (USB, in PC/MTP mode for production mode)

## Next steps
1. Run `npm run start:dev` again
2. Paste terminal output and what you see on screen
3. Try `gphoto2 --auto-detect` to verify camera setup
