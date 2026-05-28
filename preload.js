const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('booth', {
  // Renderer → Main
  wakeFromSleep:   ()      => ipcRenderer.send('wake-from-sleep'),
  startSession:    ()      => ipcRenderer.send('start-session'),
  requestCapture:  (index) => ipcRenderer.send('request-capture', index),
  startProcessing: ()      => ipcRenderer.send('start-processing'),
  cancelToSleep:   ()      => ipcRenderer.send('cancel-to-sleep'),

  // Main → Renderer  (persistent subscriptions)
  onStateChange:     (cb) => ipcRenderer.on('state-change',      (_, v) => cb(v)),
  onLiveViewFrame:   (cb) => ipcRenderer.on('live-view-frame',   (_, v) => cb(v)),
  onProcessingStatus:(cb) => ipcRenderer.on('processing-status', (_, v) => cb(v)),
  onSessionComplete: (cb) => ipcRenderer.on('session-complete',  (_, v) => cb(v)),
  onCameraError:     (cb) => ipcRenderer.on('camera-error',      (_, v) => cb(v)),

  // One-shot: fires once per capture
  onPhotoCaptured: (cb) => ipcRenderer.once('photo-captured', (_, v) => cb(v)),
});
