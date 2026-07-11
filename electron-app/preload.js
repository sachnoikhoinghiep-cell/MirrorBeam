const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mirror', {
  start: (options) => ipcRenderer.invoke('start-uxplay', options),
  stop: () => ipcRenderer.invoke('stop-uxplay'),
  getIP: () => ipcRenderer.invoke('get-ip'),
  openGuide: () => ipcRenderer.invoke('open-airplay-guide'),
  openLicenses: () => ipcRenderer.invoke('open-licenses'),
  repositionMirrorWindow: (options) => ipcRenderer.invoke('reposition-mirror-window', options),
  openMirrorFrame: () => ipcRenderer.invoke('open-mirror-frame'),
  mirrorHostResized: (bounds) => ipcRenderer.invoke('mirror-host-resized', bounds),
  setBrightness: (value) => ipcRenderer.invoke('set-brightness', value),
  setRotation: (options) => ipcRenderer.invoke('set-rotation', options),
  getDisplays: () => ipcRenderer.invoke('get-displays'),
  onDisplaysChanged: (callback) => ipcRenderer.on('displays-changed', () => callback()),
  onStatus: (callback) => ipcRenderer.on('uxplay-status', (event, data) => callback(data)),
  onLog: (callback) => ipcRenderer.on('uxplay-log', (event, data) => callback(data)),
  onEmbedStatus: (callback) => ipcRenderer.on('mirror-embed-status', (event, data) => callback(data)),
  onProjectorExited: (callback) => ipcRenderer.on('projector-exited', () => callback()),
});