// Ponte mínima entre a página e o Electron: só o que o navegador não consegue fazer sozinho.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('cine', {
  isApp: true,
  pickFolder: (current) => ipcRenderer.invoke('pick-folder', current),
  showInFolder: (file) => ipcRenderer.invoke('show-in-folder', file),
  // mini player
  openMini: (state) => ipcRenderer.invoke('mini-open', state),
  closeMini: (action) => ipcRenderer.invoke('mini-close', action),
  reportMini: (state) => ipcRenderer.send('mini-state', state),
  miniAspect: (ratio) => ipcRenderer.invoke('mini-aspect', ratio),
  onMiniClosed: (cb) => ipcRenderer.on('mini-closed', (_e, state) => cb(state)),
});
