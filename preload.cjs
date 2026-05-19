// preload.cjs — runs inside every Electron BrowserWindow's renderer.
//
// In the new architecture, the renderer talks to the backend over a
// WebSocket served by src/server.js (which the main process spins up
// before loading the page). The preload's only remaining job is to
// expose the handful of natives that *only* the desktop shell can do —
// today that's the folder picker plus the SSH connector that wraps
// `ssh -L … tree-ide --serve` for the in-app "Connect Remote" picker.
//
// transport.js looks for window.electronNative; if absent, it falls
// back to in-page UX (path prompt). That gates the entire renderer's
// Electron-vs-browser awareness behind one boolean.

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronNative', {
  pickFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  connectSsh: (opts) => ipcRenderer.invoke('ssh:connect', opts || {}),
  disconnectSsh: () => ipcRenderer.invoke('ssh:disconnect'),
  onSshGone: (cb) => {
    const handler = (_e, info) => { try { cb(info); } catch {} };
    ipcRenderer.on('ssh:gone', handler);
    return () => ipcRenderer.off('ssh:gone', handler);
  },
});
