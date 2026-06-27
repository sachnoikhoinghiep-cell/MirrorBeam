const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('mirror', {
  start: (options) => ipcRenderer.invoke('start-uxplay', options),
  stop: () => ipcRenderer.invoke('stop-uxplay'),
  getIP: () => ipcRenderer.invoke('get-ip'),
  openGuide: () => ipcRenderer.invoke('open-airplay-guide'),
  openFrameOverlay: () => ipcRenderer.invoke('open-frame-overlay'),
  closeFrameOverlay: () => ipcRenderer.invoke('close-frame-overlay'),
  mirrorHostResized: (bounds) => ipcRenderer.invoke('mirror-host-resized', bounds),
  onStatus: (callback) => ipcRenderer.on('uxplay-status', (event, data) => callback(data)),
  onLog: (callback) => ipcRenderer.on('uxplay-log', (event, data) => callback(data)),
  onEmbedStatus: (callback) => ipcRenderer.on('mirror-embed-status', (event, data) => callback(data)),
});