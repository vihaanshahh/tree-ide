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

let mainWindow = null;
let serverHandle = null;
let backend = null;

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
    const root = parseOpenRootArg(argv);
    if (root && backend) backend.setStartupRoot(root);
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
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
  const emit = (payload) => { try { backend?.events.emit('app:update-progress', payload); } catch {} };
  autoUpdater.on('download-progress', (p) => emit({ status: 'downloading', percent: Math.round(p.percent || 0) }));
  autoUpdater.on('update-downloaded', () => {
    emit({ status: 'relaunching' });
    setImmediate(() => { try { autoUpdater.quitAndInstall(); } catch {} });
  });
  autoUpdater.on('error', (err) => emit({ status: 'error', error: String(err?.message || err) }));
}

function buildElectronHooks() {
  return {
    openFolder: async () => {
      if (!mainWindow) return null;
      const result = await dialog.showOpenDialog(mainWindow, {
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
          backend.events.emit('app:update-progress', { status: 'fetching' });
          const result = await autoUpdater.checkForUpdates();
          if (!result || !result.updateInfo) return { error: 'No update metadata found on the release.' };
          backend.events.emit('app:update-progress', { status: 'downloading', percent: 0 });
          await autoUpdater.downloadUpdate();   // 'update-downloaded' triggers quitAndInstall
          return { ok: true };
        } catch (e) {
          backend.events.emit('app:update-progress', { status: 'error', error: String(e?.message || e) });
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
        backend.events.emit('app:update-progress', { status: 'fetching' });
        await run('git', ['fetch', '--tags', '--quiet']);
        backend.events.emit('app:update-progress', { status: 'pulling' });
        await run('git', ['pull', '--ff-only', '--quiet']);
        backend.events.emit('app:update-progress', { status: 'installing' });
        await run('npm', ['install', '--no-audit', '--no-fund', '--silent']);
        backend.events.emit('app:update-progress', { status: 'relaunching' });
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
ipcMain.handle('dialog:openFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
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
let currentSshChild = null;
let localServerUrl = null; // First URL we ever loaded — used to "Disconnect"

function killCurrentSsh() {
  if (!currentSshChild) return;
  const child = currentSshChild;
  currentSshChild = null;
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

ipcMain.handle('ssh:connect', async (_e, opts) => {
  killCurrentSsh();
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
    currentSshChild = child;

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
      if (currentSshChild === child) currentSshChild = null;
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
      if (currentSshChild === child) currentSshChild = null;
      if (!settled) {
        const tail = (stderr || stdout).trim().split('\n').slice(-4).join('\n').slice(-500);
        finishErr(`ssh exited (code ${code}${sig ? `, signal ${sig}` : ''}).\n${tail || 'No output.'}`);
      } else if (mainWindow && !mainWindow.isDestroyed()) {
        // Tunnel died after we navigated. Tell the renderer so it can toast.
        try { mainWindow.webContents.send('ssh:gone', { code, sig }); } catch {}
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

ipcMain.handle('ssh:disconnect', async () => {
  killCurrentSsh();
  if (mainWindow && localServerUrl) {
    try { mainWindow.loadURL(localServerUrl); } catch {}
  }
  return { ok: true };
});

// =======================================================================
// Window
// =======================================================================
function createWindow() {
  mainWindow = new BrowserWindow({
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

  // The page is served by our embedded HTTP server. Token is appended
  // so the page's transport.js can authenticate its WebSocket on load.
  if (!serverHandle) {
    console.error('[tree] server handle missing — refusing to open a window.');
    return;
  }
  localServerUrl = `http://127.0.0.1:${serverHandle.port}/?token=${encodeURIComponent(serverHandle.token)}`;
  mainWindow.loadURL(localServerUrl);

  // Diagnostics: catch renderer death (crashed/killed/oom/launch-failed)
  // and stalls. Without these, a fullscreen-triggered renderer kill just
  // looks like a blank window with no trail.
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.error('[tree] renderer gone:', details && details.reason, 'exitCode:', details && details.exitCode);
  });
  mainWindow.webContents.on('unresponsive', () => {
    console.warn('[tree] renderer unresponsive');
  });
  mainWindow.webContents.on('responsive', () => {
    console.log('[tree] renderer responsive again');
  });

  if (process.argv.includes('--devtools') || process.env.TREE_DEVTOOLS === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

// =======================================================================
// Boot — start backend + server before opening any window so the
// renderer never sees a half-initialized state.
// =======================================================================
async function boot() {
  backend = new Backend({
    startupRoot,
    pkg,
    updateRepo: UPDATE_REPO,
    electronHooks: buildElectronHooks(),
  });
  serverHandle = await startServer({ backend, host: '127.0.0.1', port: 0 });
  console.log(`[tree] embedded server: ${serverHandle.url}`);
}

if (gotSingleInstanceLock) app.whenReady().then(async () => {
  try { app.setName('Tree'); } catch {}
  if (process.platform === 'darwin' && app.dock) {
    try { app.dock.setIcon(getAppIcon()); } catch {}
  }
  await boot();
  setupAutoUpdater();
  createWindow();
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open Repo…', accelerator: 'CmdOrCtrl+O', click: () => {
          if (backend) backend.events.emit('menu:open-folder', {});
        } },
        { label: 'Connect Remote…', accelerator: 'CmdOrCtrl+Shift+R', click: () => {
          if (backend) backend.events.emit('menu:open-ssh', {});
        } },
        { label: 'Disconnect Remote', click: () => {
          killCurrentSsh();
          if (mainWindow && localServerUrl) {
            try { mainWindow.loadURL(localServerUrl); } catch {}
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

app.on('window-all-closed', async () => {
  killCurrentSsh();
  if (backend) try { backend.shutdown(); } catch {}
  if (serverHandle) try { await serverHandle.close(); } catch {}
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', killCurrentSsh);

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
