const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tree', {
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  scanRepo: (root) => ipcRenderer.invoke('repo:scan', root),
  checkClaude: () => ipcRenderer.invoke('claude:check'),
  runClaude: (payload) => ipcRenderer.invoke('claude:query', payload),
  cancelClaude: (agentId) => ipcRenderer.invoke('claude:cancel', agentId),
  readFile: (rel) => ipcRenderer.invoke('file:read', rel),

  onClaudeEvent: (cb) => {
    const listener = (_e, evt) => cb(evt);
    ipcRenderer.on('claude:event', listener);
    return () => ipcRenderer.removeListener('claude:event', listener);
  },
  onScanProgress: (cb) => {
    const listener = (_e, evt) => cb(evt);
    ipcRenderer.on('repo:scan-progress', listener);
    return () => ipcRenderer.removeListener('repo:scan-progress', listener);
  },
  onMenuOpenFolder: (cb) => {
    ipcRenderer.on('menu:open-folder', () => cb());
  },
});
