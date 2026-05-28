# Vetra Booth — "What's The 661" Photo Booth

A production-ready Electron photo booth application for macOS (Apple Silicon M-series) that captures 4-photo strips using a Fujifilm X-T2 camera via USB tether.

## Quick Start

### Prerequisites

- **Mac**: Apple Silicon (M1, M2, M3, etc.) running macOS 11+
- **Camera**: Fujifilm X-T2 connected via Micro USB 3.0 to USB-C cable
- **Node.js**: v18 or later
- **gphoto2**: Installed via Homebrew

### One-Time Setup

1. **Install gphoto2**:
   ```bash
   brew install gphoto2
   ```

2. **Configure the Fujifilm X-T2**:
   - Mode dial: Set to **M (Manual)**
   - USB Mode in camera menu: Set to **USB Shooting** (not Mass Storage)
   - Image Quality: Set to **JPEG Fine Large** (no RAW)
   - Silent Mode: **Off** (X-T2 uses mechanical shutter; electronic shutter is not available)
   - Auto Power Off: **Off** (keep camera awake while tethered)
   - LCD Display: Press **DISP** button to cycle to viewfinder-only mode to save camera battery

3. **USB Cable**:
   - You need a **Micro USB 3.0 (Type-B) to USB-C cable**
   - The Micro USB 3.0 connector is wider than standard Micro USB — do not use a regular Micro USB cable
   - Search Amazon for "Micro USB 3.0 to USB-C cable" (~$10)

4. **Cloudinary Setup** (for QR code download links):
   - Create a free account at [cloudinary.com](https://cloudinary.com)
   - Go to **Settings** → **Upload**
   - Create an **unsigned upload preset** (required for browser uploads without backend)
   - Copy your **Cloud Name** and **Upload Preset** name

5. **Create `.env` file**:
   ```bash
   cp .env.example .env
   ```
   Edit `.env` and fill in your Cloudinary credentials:
   ```
   CLOUDINARY_CLOUD_NAME=your_cloud_name
   CLOUDINARY_UPLOAD_PRESET=your_unsigned_preset_name
   BOOTH_DEV=false
   ```

6. **Install dependencies**:
   ```bash
   npm install
   ```

7. **Run the app**:
   ```bash
   npm start
   ```

## Operation

### State Machine

The app follows this state flow:

1. **SLEEP**: Full black screen with "What's The 661" brand name and pulsing dot. Press Space to start.
2. **LAYOUT_SELECT**: Choose vertical or horizontal strip layout. Press 1/2 or click button.
3. **LIVE**: Live camera view with instruction "Press Space to start your session." Spacebar triggers countdown.
4. **COUNTDOWN**: 4-photo sequence with automatic countdowns (5-3-3-3 seconds) and flash animation.
5. **PROCESSING**: Compositing, Cloudinary upload, and QR code generation.
6. **SHARE**: Display final strip and QR code for download. Auto-returns to SLEEP after 120s or on spacebar.

### Keyboard Controls

- **Space**: Advance state (SLEEP→LAYOUT_SELECT, LAYOUT_SELECT→LIVE, LIVE→COUNTDOWN, SHARE→SLEEP)
- **1**: Select vertical layout (from LAYOUT_SELECT)
- **2**: Select horizontal layout (from LAYOUT_SELECT)
- **Escape**: Blocked (kiosk mode)
- **Cmd+Q**: Blocked (kiosk mode)
- **Cmd+Shift+Q**: Exit app (dev mode only, when `BOOTH_DEV=true`)

## Template Customization

### Vertical Strip (Default)

Canvas: **1200 × 3600 px** (2" × 6" at 600 DPI)

Photo slots (top to bottom):
- Slot 1: x=60, y=60, w=1080, h=810
- Slot 2: x=60, y=930, w=1080, h=810
- Slot 3: x=60, y=1800, w=1080, h=810
- Slot 4: x=60, y=2670, w=1080, h=810

Create a PNG file with **transparent holes** at these coordinates. Everything else (borders, logos, branding, background) is part of the image.

Save as: `assets/template-vertical.png`

### Horizontal Strip

Canvas: **3600 × 1200 px** (6" × 2" at 600 DPI)

Photo slots (left to right):
- Slot 1: x=60, y=60, w=810, h=1080
- Slot 2: x=930, y=60, w=810, h=1080
- Slot 3: x=1800, y=60, w=810, h=1080
- Slot 4: x=2670, y=60, w=810, h=1080

Save as: `assets/template-horizontal.png`

**Both must be PNG with RGBA transparency** (transparent holes, opaque branding).

To generate templates from Figma or Illustrator:
1. Create canvas at exact dimensions
2. Add photo frame outlines
3. Delete/make transparent the frame areas
4. Export as PNG with transparency

If templates are missing, the app will generate plain black photo strips.

## Output

Session output is saved to `output/` folder with structure:

```
output/
├── 2025-06-14_19-32-07/
│   ├── photo_1.jpg
│   ├── photo_2.jpg
│   ├── photo_3.jpg
│   ├── photo_4.jpg
│   ├── strip_vertical.jpg (or strip_horizontal.jpg)
│   └── session_info.json
├── 2025-06-14_19-35-22/
│   └── [same structure]
└── booth.log
```

### session_info.json

```json
{
  "timestamp": "2025-06-14T19:32:07.123Z",
  "layout": "vertical",
  "cloudinary_url": "https://res.cloudinary.com/...",
  "photos": ["photo_1.jpg", "photo_2.jpg", "photo_3.jpg", "photo_4.jpg"],
  "strip": "strip_vertical.jpg"
}
```

## Development

### Run in dev mode with DevTools:

```bash
npm run start:dev
```

In dev mode:
- DevTools are automatically opened
- Cmd+Shift+Q quits the app (escape hatch)
- Console logs appear in DevTools

### Logging

All activity is logged to `output/booth.log`:
- Camera commands and errors
- State transitions
- File operations
- Battery check warnings (every 10 sessions)

## Battery Management

**Critical for day-long events:**

1. **Turn off camera LCD**: Press **DISP** button on camera to cycle to viewfinder-only mode. This is the single biggest battery drain.
2. **Use fresh battery**: Start with a fully charged battery, have a spare charged and ready.
3. **Charge while tethered**: The MacBook can charge the camera via USB-C while shooting. Bring a power adapter.
4. **Monitor logs**: The app logs "BATTERY CHECK: consider swapping battery" every 10 completed sessions. Swap battery at those intervals.
5. **Live view control**: The app automatically kills the live view stream when entering SLEEP state to prevent constant USB drain.

## Kiosk Mode

The app runs in true macOS kiosk mode:

- **fullscreen**: Cannot minimize or resize
- **frame: false**: No window chrome
- **alwaysOnTop**: Stays in front
- All common exit shortcuts blocked (Cmd+Q, Cmd+W, Alt+Tab, etc.)
- Window auto-focuses if clicked away
- Only Cmd+Shift+Q exits (dev mode only)

Safe to run unattended at events.

## Camera Connection Troubleshooting

### "gphoto2 not found" error

```bash
brew install gphoto2
# Then restart the app
```

### "Camera not detected" on startup

1. Check USB cable is plugged into camera AND Mac
2. On camera, verify **USB Mode = USB Shooting** in menu
3. Run in terminal to debug:
   ```bash
   gphoto2 --auto-detect
   ```
4. If no output, try unplugging and replugging the USB cable
5. If still no luck, restart the camera

### Live view freezes or no frames

- Camera may have gone to sleep; press shutter button on camera to wake it
- If USB Shooting mode is off, camera will appear connected but won't stream; check camera menu
- Check camera battery isn't critically low

### Photos captured but stuck in "Developing"

- Check `output/booth.log` for errors
- Verify camera has free disk space
- Try restarting the camera

## Environment Variables

Create or edit `.env` file in project root:

```
CLOUDINARY_CLOUD_NAME=your_cloud_name
CLOUDINARY_UPLOAD_PRESET=your_unsigned_preset_name
BOOTH_DEV=false
```

- `BOOTH_DEV=true`: Enables DevTools and Cmd+Shift+Q exit. Never use in production.
- Cloudinary credentials are optional; if missing, uploads will fail gracefully and local file paths are displayed instead.

## Performance Notes

- **Live view**: Streams MJPEG from gphoto2 at native camera FPS (usually ~10 FPS on Fuji). Frames are parsed on the main process and sent to renderer as JPEG base64.
- **Image compositing**: sharp processes at full 1200×3600 (vertical) or 3600×1200 (horizontal) resolution. Completes in ~2–5 seconds.
- **Cloudinary upload**: Depends on network; typically 5–10 seconds for a 500 KB strip.
- **Total session time**: ~30 seconds from layout selection to SHARE screen (5s + 3s + 3s + 3s capture + ~2s pause + ~10s processing + upload).

## File Architecture

```
vetra-booth/
├── main.js                    ← Electron main process (camera, state, IPC)
├── preload.js                 ← Secure contextBridge
├── package.json               ← Dependencies
├── .env.example               ← Cloudinary config template
├── .env                       ← Your actual credentials (git-ignored)
├── README.md                  ← This file
├── renderer/
│   ├── index.html             ← UI markup
│   ├── booth.js               ← State machine & keyboard handling
│   └── styles.css             ← All styling
├── assets/
│   ├── template-vertical.png  ← User customization
│   ├── template-horizontal.png
│   └── sleep-bg.mp4           ← Optional (not used; CSS animation instead)
└── output/                    ← Generated per session
    ├── 2025-06-14_19-32-07/
    │   ├── photo_1.jpg
    │   ├── photo_2.jpg
    │   ├── photo_3.jpg
    │   ├── photo_4.jpg
    │   ├── strip_vertical.jpg
    │   └── session_info.json
    └── booth.log
```

## License

Proprietary — "What's The 661" Photo Booth.

## Support

For issues, check `output/booth.log` first. Common problems:

- No frames in live view: Camera USB Shooting mode off
- Photos not captured: Camera battery low or free space full
- Upload fails: Check Cloudinary credentials in `.env`
- App won't exit: You're in kiosk mode (intended). Use Cmd+Shift+Q in dev mode.