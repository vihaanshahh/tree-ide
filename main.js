// Tree IDE — Electron main process.
//
// Architecture (post-WebSocket refactor):
//   - Backend (src/backend.js) holds every operation the renderer can
//     invoke: scan, file read, PTY, watcher, providers, update check.
//   - Server (src/server.js) wraps the Backend in HTTP + WebSocket and
//     binds to 127.0.0.1:0 with a random per-launch token.
//   - This main process spawns the server in-process, then loads
//     `http://127.0.0.1:PORT/?token=…` into a BrowserWindow.
//
// The desktop UX is unchanged for users. What's new is that the same
// renderer + same backend can be reached from any browser when running
// in serve mode (`bin/tree-ide-server.js`) over an SSH tunnel.

const { app, BrowserWindow, ipcMain, dialog, Menu, nativeImage, shell } = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const https = require('https');
const { spawn } = require('child_process');
const net = require('net');
const { Backend, normalizeOpenRoot, compareVersions, fetchLatestRelease } = require('./src/backend');
const { startServer } = require('./src/server');
const pkg = require('./package.json');

// electron-updater is optional — required lazily so unsigned/dev builds and
// the headless server keep working even if it isn't installed.
let autoUpdater = null;
try { ({ autoUpdater } = require('electron-updater')); } catch { /* optional */ }

const UPDATE_REPO = 'vihaanshahh/tree-ide';

// =======================================================================
// Linux / WSL compatibility switches — must run before app.whenReady().
// =======================================================================
function isWSL() {
  if (process.platform !== 'linux') return false;
  if (process.env.WSL_DISTRO_NAME || process.env.WSL_INTEROP) return true;
  try { return /microsoft|WSL/i.test(fs.readFileSync('/proc/version', 'utf8')); }
  catch { return false; }
}
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('ozone-platform', 'x11');
}
if (isWSL()) {
  app.disableHardwareAcceleration();
  app.commandLine.appendSwitch('no-sandbox');
  app.commandLine.appendSwitch('disable-gpu');
}
app.commandLine.appendSwitch('js-flags', '--max-old-space-size=4096');

// =======================================================================
// Runtime-generated app icon (no SVG rasterizer, no extra deps).
// =======================================================================
function buildLogoPng(size = 512) {
  const W = size, H = size;
  const px = Buffer.alloc(W * H * 4);
  const sand  = [231, 222, 209, 255];
  const black = [0, 0, 0, 255];
  const pad = Math.round(size * 0.055);
  const inner = size - pad * 2;
  const scale = inner / 24;
  const r = Math.round(inner * 0.225);
  const x0 = pad, y0 = pad;
  const x1 = pad + inner, y1 = pad + inner;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      let cx = x, cy = y, corner = false;
      if      (x < x0 + r && y < y0 + r)         { cx = x0 + r; cy = y0 + r; corner = true; }
      else if (x >= x1 - r && y < y0 + r)        { cx = x1 - r; cy = y0 + r; corner = true; }
      else if (x < x0 + r && y >= y1 - r)        { cx = x0 + r; cy = y1 - r; corner = true; }
      else if (x >= x1 - r && y >= y1 - r)       { cx = x1 - r; cy = y1 - r; corner = true; }
      if (corner) {
        const dx = x - cx, dy = y - cy;
        if (dx*dx + dy*dy > r*r) continue;
      }
      const i = (y * W + x) * 4;
      px[i]=sand[0]; px[i+1]=sand[1]; px[i+2]=sand[2]; px[i+3]=255;
    }
  }
  const fillRect = (lx, ly, lw, lh, c) => {
    const px0 = Math.floor(x0 + lx * scale);
    const py0 = Math.floor(y0 + ly * scale);
    const px1 = Math.floor(x0 + (lx + lw) * scale);
    const py1 = Math.floor(y0 + (ly + lh) * scale);
    for (let y = py0; y < py1; y++) {
      for (let x = px0; x < px1; x++) {
        const i = (y * W + x) * 4;
        if (px[i+3] === 0) continue;
        px[i]=c[0]; px[i+1]=c[1]; px[i+2]=c[2]; px[i+3]=c[3];
      }
    }
  };
  fillRect(3,  4,  3, 3,    black);
  fillRect(10, 4,  3, 3,    black);
  fillRect(10, 11, 3, 3,    black);
  fillRect(17, 11, 3, 3,    black);
  fillRect(17, 17, 3, 3,    black);
  fillRect(4,  7,  1, 11.5, black);
  fillRect(4,  5.5, 6, 1,   black);
  fillRect(4,  12.5, 6, 1,  black);
  fillRect(11, 14, 1, 4.5,  black);
  fillRect(11, 12.5, 6, 1,  black);
  fillRect(11, 18.5, 6, 1,  black);
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8]  = 8;
  ihdr[9]  = 6;
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const raw = Buffer.alloc(H * (1 + W * 4));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 4)] = 0;
    px.copy(raw, y * (1 + W * 4) + 1, y * W * 4, (y + 1) * W * 4);
  }
  const idat = zlib.deflateSync(raw);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'ascii');
    const body = Buffer.concat([t, data]);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(zlib.crc32(body) >>> 0, 0);
    return Buffer.concat([len, body, crcBuf]);
  };
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

let APP_ICON = null;
function getAppIcon() {
  if (APP_ICON) return APP_ICON;
  try {
    APP_ICON = nativeImage.createFromBuffer(buildLogoPng(512));
  } catch {
    APP_ICON = nativeImage.createEmpty();
  }
  return APP_ICON;
}

// Multi-window: each window owns its own Backend + embedded server so it can
// map a different repo independently. A "record" bundles that per-window state:
//   { win, backend, server, localServerUrl, sshChild }
// Module-level singletons are gone — everything is looked up per window.
const windows = new Set();

function recordForWebContents(wc) {
  const win = wc ? BrowserWindow.fromWebContents(wc) : null;
  if (!win) return null;
  for (const r of windows) if (r.win === win) return r;
  return null;
}

function focusedRecord() {
  const win = BrowserWindow.getFocusedWindow();
  if (win) for (const r of windows) if (r.win === win) return r;
  // Fall back to the most recently opened window if none is focused.
  let last = null;
  for (const r of windows) last = r;
  return last;
}

function parseOpenRootArg(argv) {
  const args = (argv || []).slice(1);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--open' || arg === '--repo' || arg === '--folder') {
      return normalizeOpenRoot(args[i + 1]);
    }
    if (arg && arg.startsWith('--open=')) {
      return normalizeOpenRoot(arg.slice('--open='.length));
    }
  }
  return null;
}

const startupRoot = parseOpenRootArg(process.argv);
// TREE_IDE_DEV=1 lets a second Electron instance run alongside an
// already-installed copy (e.g. /Applications/Tree.app) — useful when
// testing local changes without quitting the production app.
const gotSingleInstanceLock = process.env.TREE_IDE_DEV === '1' || app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
}

if (gotSingleInstanceLock) {
  app.on('second-instance', (_event, argv) => {
    // A second `tree-ide --open <repo>` invocation opens that repo in a new
    // window instead of hijacking an existing one. With no path, just focus.
    const root = parseOpenRootArg(argv);
    if (root) { createWindow(root); return; }
    const r = focusedRecord();
    if (r && r.win) {
      if (r.win.isMinimized()) r.win.restore();
      r.win.focus();
    }
  });
}

// =======================================================================
// Electron hooks — bits of functionality only the desktop shell can do.
// Wired into Backend so the renderer can invoke them transparently
// (folder picker, self-update via git pull) over the same WS channel.
// =======================================================================
// Wire electron-updater download/install events to the renderer's update
// progress UI. Only meaningful in a packaged, signed build; a no-op otherwise.
let autoUpdaterReady = false;
function setupAutoUpdater() {
  if (!autoUpdater || !app.isPackaged || autoUpdaterReady) return;
  autoUpdaterReady = true;
  autoUpdater.autoDownload = false;          // download only when the user clicks
  autoUpdater.autoInstallOnAppQuit = true;
  // electron-updater is a process-global singleton; fan its progress out to
  // every open window so whichever one triggered the update sees it.
  const emit = (payload) => {
    for (const r of windows) { try { r.backend?.events.emit('app:update-progress', payload); } catch {} }
  };
  autoUpdater.on('download-progress', (p) => emit({ status: 'downloading', percent: Math.round(p.percent || 0) }));
  autoUpdater.on('update-downloaded', () => {
    emit({ status: 'relaunching' });
    setImmediate(() => { try { autoUpdater.quitAndInstall(); } catch {} });
  });
  autoUpdater.on('error', (err) => emit({ status: 'error', error: String(err?.message || err) }));
}

// getRecord() returns the per-window record this backend belongs to, so the
// hooks can target the right BrowserWindow / emit on the right backend.
function buildElectronHooks(getRecord) {
  const emitProgress = (payload) => {
    try { getRecord()?.backend?.events.emit('app:update-progress', payload); } catch {}
  };
  return {
    openFolder: async () => {
      const win = getRecord()?.win;
      if (!win) return null;
      const result = await dialog.showOpenDialog(win, {
        properties: ['openDirectory'],
        title: 'Open repo to map',
      });
      if (result.canceled || !result.filePaths[0]) return null;
      return result.filePaths[0];
    },

    checkUpdate: async () => {
      try {
        const latest = await fetchLatestRelease(UPDATE_REPO);
        const current = pkg.version;
        const isNewer = !!latest.tag && compareVersions(latest.tag, current) > 0;
        return { current, latest: latest.tag, isNewer, htmlUrl: latest.htmlUrl, gitCheckout: isGitCheckout() };
      } catch (e) {
        return { current: pkg.version, error: e.message || String(e) };
      }
    },

    relaunch: () => { app.relaunch(); app.exit(0); },

    updateAndRelaunch: async () => {
      // Packaged app: download + apply via electron-updater (background download,
      // then quit-and-install on relaunch). Requires a signed build on macOS.
      if (!isGitCheckout()) {
        if (!autoUpdater || !app.isPackaged) {
          try { await shell.openExternal(`https://github.com/${UPDATE_REPO}/releases/latest`); } catch {}
          return { error: 'In-app update unavailable in this build — opened the releases page.' };
        }
        try {
          setupAutoUpdater();
          emitProgress({ status: 'fetching' });
          const result = await autoUpdater.checkForUpdates();
          if (!result || !result.updateInfo) return { error: 'No update metadata found on the release.' };
          emitProgress({ status: 'downloading', percent: 0 });
          await autoUpdater.downloadUpdate();   // 'update-downloaded' triggers quitAndInstall
          return { ok: true };
        } catch (e) {
          emitProgress({ status: 'error', error: String(e?.message || e) });
          // Fall back to the releases page so the user can still grab the build.
          try { await shell.openExternal(`https://github.com/${UPDATE_REPO}/releases/latest`); } catch {}
          return { error: e?.message || String(e) };
        }
      }
      const run = (cmd, args) => new Promise((resolve, reject) => {
        const child = spawn(cmd, args, { cwd: __dirname, env: process.env });
        let stderr = '';
        child.stderr.on('data', (d) => stderr += d.toString());
        child.on('error', reject);
        child.on('exit', (code) => code === 0 ? resolve() : reject(new Error(`${cmd} exited ${code}: ${stderr.trim()}`)));
      });
      try {
        emitProgress({ status: 'fetching' });
        await run('git', ['fetch', '--tags', '--quiet']);
        emitProgress({ status: 'pulling' });
        await run('git', ['pull', '--ff-only', '--quiet']);
        emitProgress({ status: 'installing' });
        await run('npm', ['install', '--no-audit', '--no-fund', '--silent']);
        emitProgress({ status: 'relaunching' });
        app.relaunch();
        app.exit(0);
        return { ok: true };
      } catch (e) {
        return { error: e.message || String(e) };
      }
    },
  };
}

function isGitCheckout() {
  try { return fs.statSync(path.join(__dirname, '.git')).isDirectory() || fs.existsSync(path.join(__dirname, '.git')); }
  catch { return false; }
}

// Kept around for the (unlikely) preload-only IPC path. The renderer
// resolves window.electronNative.pickFolder via this. Server-side it
// resolves through the Backend hook above; both paths are equivalent.
ipcMain.handle('dialog:openFolder', async (event) => {
  const win = recordForWebContents(event.sender)?.win || BrowserWindow.getFocusedWindow();
  const result = await dialog.showOpenDialog(win, {
    properties: ['openDirectory'],
    title: 'Open repo to map',
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
});

// =======================================================================
// Remote / SSH
//
// "Connect to SSH" is just `ssh -L LOCAL:127.0.0.1:REMOTE user@host
// bash -lc 'tree-ide --serve --port REMOTE …'`. We pick a free local
// port, parse the URL the remote server prints, and navigate the
// BrowserWindow to it. The tunnel + token check is the whole security
// boundary, same as the CLI workflow documented in the README.
// =======================================================================
// SSH tunnels are per-window: record.sshChild holds the active `ssh -L …`
// child for that window, and record.localServerUrl is the local URL to
// navigate back to on disconnect.
function killSsh(record) {
  if (!record || !record.sshChild) return;
  const child = record.sshChild;
  record.sshChild = null;
  try { child.kill('SIGTERM'); } catch {}
}

function pickFreePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

// POSIX-safe single-quoting for a shell-string passed through ssh.
const shq = (s) => "'" + String(s).replace(/'/g, "'\\''") + "'";

ipcMain.handle('ssh:connect', async (event, opts) => {
  const record = recordForWebContents(event.sender);
  if (!record) return { error: 'No window for this SSH request.' };
  killSsh(record);
  const host       = (opts && opts.host       || '').trim();
  const remotePath = (opts && opts.path       || '').trim();
  const identity   = (opts && opts.identity   || '').trim();
  if (!host) return { error: 'SSH host is required (e.g. user@host).' };

  let port;
  try { port = await pickFreePort(); }
  catch (e) { return { error: 'Could not pick a free local port: ' + e.message }; }

  const treeCmd = `tree-ide --serve --host 127.0.0.1 --port ${port}` +
    (remotePath ? ` ${shq(remotePath)}` : '');
  const remoteShell = `bash -lc ${shq(treeCmd)}`;

  const sshArgs = [
    '-o', 'BatchMode=yes',                  // No interactive prompts — key auth only
    '-o', 'ExitOnForwardFailure=yes',
    '-o', 'ServerAliveInterval=30',
    '-o', 'ServerAliveCountMax=4',
    '-o', 'StrictHostKeyChecking=accept-new',
    ...(identity ? ['-i', identity] : []),
    '-L', `127.0.0.1:${port}:127.0.0.1:${port}`,
    host,
    remoteShell,
  ];

  return await new Promise((resolve) => {
    let child;
    try {
      child = spawn('ssh', sshArgs, { stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return resolve({ error: 'Failed to spawn ssh: ' + (e.message || e) });
    }
    record.sshChild = child;

    let stdout = '', stderr = '';
    let settled = false;
    const readyRe = /tree-ide ready:\s*(\S+)/;
    const timeoutMs = 30000;

    const finishOk = (url) => {
      if (settled) return;
      settled = true;
      resolve({ ok: true, url, port, host });
    };
    const finishErr = (msg) => {
      if (settled) return;
      settled = true;
      try { child.kill('SIGTERM'); } catch {}
      if (record.sshChild === child) record.sshChild = null;
      resolve({ error: msg });
    };

    child.stdout.on('data', (buf) => {
      stdout += buf.toString();
      const m = readyRe.exec(stdout);
      if (m) {
        // Rewrite to local port in case remote chose differently.
        const url = m[1].replace(/127\.0\.0\.1:\d+/, `127.0.0.1:${port}`);
        finishOk(url);
      }
    });
    child.stderr.on('data', (buf) => {
      const text = buf.toString();
      stderr += text;
      console.warn('[tree:ssh]', text.trimEnd());
    });
    child.on('error', (e) => finishErr('Failed to spawn ssh: ' + (e.message || e)));
    child.on('exit', (code, sig) => {
      if (record.sshChild === child) record.sshChild = null;
      if (!settled) {
        const tail = (stderr || stdout).trim().split('\n').slice(-4).join('\n').slice(-500);
        finishErr(`ssh exited (code ${code}${sig ? `, signal ${sig}` : ''}).\n${tail || 'No output.'}`);
      } else if (record.win && !record.win.isDestroyed()) {
        // Tunnel died after we navigated. Tell the renderer so it can toast.
        try { record.win.webContents.send('ssh:gone', { code, sig }); } catch {}
      }
    });

    setTimeout(() => finishErr(
      'Timed out after 30s waiting for tree-ide to start on the remote.\n' +
      '• Make sure ssh key-auth works (try `ssh ' + host + '` in a terminal).\n' +
      '• Make sure tree-ide is installed there (`curl -fsSL ' +
      'https://raw.githubusercontent.com/' + UPDATE_REPO + '/main/install.sh | sh`).'
    ), timeoutMs);
  });
});

ipcMain.handle('ssh:disconnect', async (event) => {
  const record = recordForWebContents(event.sender);
  if (!record) return { ok: true };
  killSsh(record);
  if (record.win && record.localServerUrl) {
    try { record.win.loadURL(record.localServerUrl); } catch {}
  }
  return { ok: true };
});

// =======================================================================
// Window
//
// Each window is fully self-contained: its own Backend + embedded HTTP/WS
// server, so it can map a different repo than its siblings. `openRoot`, if
// given, becomes that backend's startup root and the renderer auto-scans it.
// =======================================================================
async function createWindow(openRoot = null) {
  const record = { win: null, backend: null, server: null, localServerUrl: null, sshChild: null };
  windows.add(record);

  // Boot this window's backend + server before loading the page so the
  // renderer never sees a half-initialized state.
  try {
    record.backend = new Backend({
      startupRoot: normalizeOpenRoot(openRoot) || null,
      pkg,
      updateRepo: UPDATE_REPO,
      electronHooks: buildElectronHooks(() => record),
    });
    record.server = await startServer({ backend: record.backend, host: '127.0.0.1', port: 0 });
  } catch (e) {
    console.error('[tree] failed to start window backend/server:', e);
    windows.delete(record);
    return null;
  }
  console.log(`[tree] embedded server: ${record.server.url}`);

  const win = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#000000',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    icon: getAppIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  record.win = win;

  // The page is served by this window's embedded HTTP server. Token is
  // appended so transport.js can authenticate its WebSocket on load.
  record.localServerUrl = `http://127.0.0.1:${record.server.port}/?token=${encodeURIComponent(record.server.token)}`;
  win.loadURL(record.localServerUrl);

  // Diagnostics: catch renderer death (crashed/killed/oom/launch-failed)
  // and stalls. Without these, a fullscreen-triggered renderer kill just
  // looks like a blank window with no trail.
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error('[tree] renderer gone:', details && details.reason, 'exitCode:', details && details.exitCode);
  });
  win.webContents.on('unresponsive', () => {
    console.warn('[tree] renderer unresponsive');
  });
  win.webContents.on('responsive', () => {
    console.log('[tree] renderer responsive again');
  });

  // Tear down this window's backend + server (and any SSH tunnel) when it
  // closes, so windows don't leak watchers, PTYs, or listening ports.
  win.on('closed', () => {
    killSsh(record);
    try { record.backend?.shutdown(); } catch {}
    try { record.server?.close(); } catch {}
    windows.delete(record);
  });

  if (process.argv.includes('--devtools') || process.env.TREE_DEVTOOLS === '1') {
    win.webContents.openDevTools({ mode: 'detach' });
  }
  return record;
}

// Prompt for a folder (parented to the focused window) and open it in a new
// window. Cancelling the picker still opens an empty window.
async function newWindowWithPicker() {
  const parent = BrowserWindow.getFocusedWindow();
  const opts = { properties: ['openDirectory'], title: 'Open repo in new window' };
  const result = parent
    ? await dialog.showOpenDialog(parent, opts)
    : await dialog.showOpenDialog(opts);
  const root = (!result.canceled && result.filePaths[0]) ? result.filePaths[0] : null;
  return createWindow(root);
}

function dispatchRendererCommand(command) {
  const r = focusedRecord();
  if (!r || !r.win || r.win.isDestroyed()) return;
  const eventName = `tree:${command}`;
  const script = `window.dispatchEvent(new Event(${JSON.stringify(eventName)}));`;
  r.win.webContents.executeJavaScript(script).catch(() => {});
}

if (gotSingleInstanceLock) app.whenReady().then(async () => {
  try { app.setName('Tree'); } catch {}
  if (process.platform === 'darwin' && app.dock) {
    try { app.dock.setIcon(getAppIcon()); } catch {}
  }
  setupAutoUpdater();
  await createWindow(startupRoot);
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'New Window', accelerator: 'CmdOrCtrl+N', click: () => { createWindow(); } },
        { label: 'New Agent', accelerator: 'CmdOrCtrl+T', click: () => { dispatchRendererCommand('new-agent'); } },
        { label: 'Open Repo in New Window…', accelerator: 'CmdOrCtrl+Shift+N', click: () => { newWindowWithPicker(); } },
        { type: 'separator' },
        { label: 'Open Repo…', accelerator: 'CmdOrCtrl+O', click: () => {
          focusedRecord()?.backend.events.emit('menu:open-folder', {});
        } },
        { label: 'Connect Remote…', accelerator: 'CmdOrCtrl+Shift+R', click: () => {
          focusedRecord()?.backend.events.emit('menu:open-ssh', {});
        } },
        { label: 'Disconnect Remote', click: () => {
          const r = focusedRecord();
          if (!r) return;
          killSsh(r);
          if (r.win && r.localServerUrl) {
            try { r.win.loadURL(r.localServerUrl); } catch {}
          }
        } },
        { type: 'separator' },
        isMac ? { role: 'close' } : { role: 'quit' },
      ],
    },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
});

// Per-window cleanup happens in each window's 'closed' handler. On non-mac,
// closing the last window quits the app (macOS keeps it running, dockable).
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Belt-and-suspenders: ensure every window's backend/server/SSH is torn down
// on quit, even if a 'closed' event didn't fire.
app.on('before-quit', () => {
  for (const r of windows) {
    killSsh(r);
    try { r.backend?.shutdown(); } catch {}
    try { r.server?.close(); } catch {}
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
