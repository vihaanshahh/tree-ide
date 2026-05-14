const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('tree', {
  openFolder: () => ipcRenderer.invoke('dialog:openFolder'),
  scanRepo:   (root) => ipcRenderer.invoke('repo:scan', root),
  readFile:   (rel) => ipcRenderer.invoke('file:read', rel),
  detectProviders: () => ipcRenderer.invoke('providers:detect'),
  getStartupRoot: () => ipcRenderer.invoke('app:startup-root'),
  onOpenRoot: (cb) => {
    const fn = (_e, evt) => cb(evt);
    ipcRenderer.on('app:open-root', fn);
    return () => ipcRenderer.removeListener('app:open-root', fn);
  },

  // Embedded PTY agents (shell/codex use these; claude can fall back to external)
  ptySpawn:  (payload) => ipcRenderer.invoke('pty:spawn', payload),
  // ptyWrite uses send (fire-and-forget) to avoid the invoke→ack round-trip
  // for every keystroke — important for typing latency.
  ptyWrite:  (agentId, data) => ipcRenderer.send('pty:write', { agentId, data }),
  ptyResize: (agentId, cols, rows) => ipcRenderer.send('pty:resize', { agentId, cols, rows }),
  ptyKill:   (agentId) => ipcRenderer.invoke('pty:kill', agentId),
  onPtyData: (cb) => {
    const fn = (_e, evt) => cb(evt);
    ipcRenderer.on('pty:data', fn);
    return () => ipcRenderer.removeListener('pty:data', fn);
  },
  onPtyExit: (cb) => {
    const fn = (_e, evt) => cb(evt);
    ipcRenderer.on('pty:exit', fn);
    return () => ipcRenderer.removeListener('pty:exit', fn);
  },
  // External terminal launcher — fallback for TUIs that need a real terminal
  launchAgent: (payload) => ipcRenderer.invoke('agent:launch', payload),

  // Filesystem watcher — drives the graph animation
  watchFs:   (root) => ipcRenderer.invoke('fs:watch', root),
  onFsEvent: (cb) => {
    const fn = (_e, evt) => cb(evt);
    ipcRenderer.on('fs:event', fn);
    return () => ipcRenderer.removeListener('fs:event', fn);
  },

  onScanProgress: (cb) => {
    const fn = (_e, evt) => cb(evt);
    ipcRenderer.on('repo:scan-progress', fn);
    return () => ipcRenderer.removeListener('repo:scan-progress', fn);
  },
  onMenuOpenFolder: (cb) => { ipcRenderer.on('menu:open-folder', () => cb()); },

  // Update check — surfaces a Restart/Update affordance in the titlebar
  // when the local version is behind the latest GitHub release.
  checkUpdate: () => ipcRenderer.invoke('app:check-update'),
  relaunchApp: () => ipcRenderer.invoke('app:relaunch'),
  updateAndRelaunch: () => ipcRenderer.invoke('app:update-and-relaunch'),
  onUpdateProgress: (cb) => {
    const fn = (_e, evt) => cb(evt);
    ipcRenderer.on('app:update-progress', fn);
    return () => ipcRenderer.removeListener('app:update-progress', fn);
  },
});
