const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('booth', {
  // Renderer → Main
  selectLayout: (layout) => ipcRenderer.send('layout-selected', layout),
  startSession: () => ipcRenderer.send('session-started'),
  requestCapture: (photoIndex) => ipcRenderer.send('request-capture', photoIndex),
  startProcessing: () => ipcRenderer.send('processing-start'),
  cancelToSleep: () => ipcRenderer.send('cancel-to-sleep'),

  // Main → Renderer
  onStateChange: (cb) => ipcRenderer.on('state-change', (_, state) => cb(state)),
  onSpacePressed: (cb) => ipcRenderer.on('space-pressed', () => cb()),
  onLiveViewFrame: (cb) =>
    ipcRenderer.on('live-view-frame', (_, base64Frame) => cb(base64Frame)),
  onProcessingStatus: (cb) =>
    ipcRenderer.on('processing-status', (_, msg) => cb(msg)),
  onSessionComplete: (cb) =>
    ipcRenderer.on('session-complete', (_, data) => cb(data)),
  onCameraError: (cb) =>
    ipcRenderer.on('camera-error', (_, msg) => cb(msg)),
});
