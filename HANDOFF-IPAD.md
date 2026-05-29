# Vetra Standalone iPad Photo Booth Kiosk – Handoff Document

**Purpose:** This document describes the architecture, file structure, configurations, and deployment steps for the **100% standalone iPad Web Photo Booth Kiosk**. This client-side HTML5/JavaScript application replaces the Mac Electron version for events, running directly in Safari or Chrome on the iPad, with no Mac laptop or local server required.

---

## 🚀 Deployment & App Location
- **Local Source Files:** Located in `/renderer/` directory:
  - Main HTML: [ipad.html](file:///Users/brandonrose/VetraPhotoBooth/renderer/ipad.html)
  - Styling: [ipad-styles.css](file:///Users/brandonrose/VetraPhotoBooth/renderer/ipad-styles.css)
  - JavaScript logic: [ipad.js](file:///Users/brandonrose/VetraPhotoBooth/renderer/ipad.js)
- **Live URL:** Served via GitHub Pages at:  
  `https://mrdirectorman317.github.io/VetraPhotoBooth/renderer/ipad.html`

---

## 🛠️ Architecture & Flow
The application operates as a single-page web app with a state machine driving 5 distinct full-screen states:
`SLEEP ➔ LIVE ➔ COUNTDOWN ➔ PROCESSING ➔ SHARE ➔ (Auto-reset back to SLEEP after 180s)`

1. **Sleep Screen:** Displays the greeting and a large "Begin" button. Interaction triggers Safari `AudioContext` activation to allow audio playbacks.
2. **Live Screen:** Boots up camera preview using `getUserMedia`. Defaults to the **front-facing camera** (`user`). Allows manual switching to rear-camera using a toggle.
3. **Countdown Screen:** Shows a clean fullscreen preview overlayed with the countdown digits (`3`, `2`, `1`) and plays timing beeps. On capture, it performs a visual screen flash, triggers a shutter click sound, and captures the frame to a canvas.
4. **Processing Screen:** Composites the 3 captured pictures onto a 1200×2440 digital strip template using HTML5 canvas APIs, then uploads the main strip to Cloudinary.
5. **Share Screen:** Displays the main vertical strip, generating a dynamic QR code for download. Simultaneously, it kicks off sequential Gemini AI transformations in the background to build and display a "Bonus Strip" with a corresponding QR code.

---

## 🧠 Gemini Generative AI Sequential Pipeline
To avoid Gemini API free-tier rate limits (429 Too Many Requests), the app processes the three captured photos **sequentially** with a **1.2s delay** between API requests.

### Index-Based AI Prompts (defined in `getFunnyPromptForIndex`):
Every API call includes strict negative instructions to prevent Gemini from hallucinating or generating fake background people:
> `Do NOT add any new people, figures, characters, or background elements to the image. Only edit the existing person or people in the photo, keeping the background identical.`

- **Photo 1 (Index 0):** Adds a cute baby bonnet on each person's head.
- **Photo 2 (Index 1):** Adds a baby pacifier in each person's mouth.
- **Photo 3 (Index 2):** Adds a baby bib around each person's neck with messy baby food smeared on the bib and on their faces.

---

## 🔒 Configuration & Credentials (localStorage)
To avoid committing API keys or Cloudinary presets to Git:
1. Tap the **floating gear icon** on the bottom right of the **Sleep Screen** to access the **Settings Modal**.
2. Credentials can be manually edited and saved here. They are securely persisted in the iPad's browser `localStorage`:
   - `cloudinaryCloudName`
   - `cloudinaryUploadPreset`
   - `geminiApiKey`
3. Default fallbacks are coded in [ipad.js](file:///Users/brandonrose/VetraPhotoBooth/renderer/ipad.js) as fallback parameters.

---

## 📱 iPad Standalone Setup Checklist
To prepare the iPad for the kiosk event:
1. **Load the URL:** In Safari on the iPad, navigate to `https://mrdirectorman317.github.io/VetraPhotoBooth/renderer/ipad.html`.
2. **Save to Home Screen:** Tap Safari's **Share** button ➔ select **Add to Home Screen**. This lets it launch as an immersive, full-screen PWA without address bars.
3. **Configure Settings:** Open the Home Screen app, tap the gear icon, ensure API Keys and Cloudinary credentials are valid, then tap save.
4. **Guided Access (Kiosk mode):**
   - Go to iPad **Settings > Accessibility > Guided Access** and toggle it ON.
   - Triple-click the iPad Home/Power button inside the photo booth app to lock the screen, ensuring guests cannot swipe out.

---

## ⚡ Developer Handoff Notes
- **Safari Audio Bypass:** Sound effects must be preceded by a user click/tap to bypass Safari's autoplay policies. The event listener on the "Begin" button activates the shared `AudioContext` via `initAudio()`.
- **Mirroring:** The camera preview is automatically mirrored when using the front-facing camera (`user`), and unmirrored for the rear camera. Captured frames are adjusted accordingly.
- **Cache Refreshing:** When pushing new HTML/CSS/JS updates to GitHub Pages, the iPad Home Screen app may cache older versions. **You must delete the app shortcut from the iPad Home Screen and re-add it** to force Safari to fetch the latest code.
