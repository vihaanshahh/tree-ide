// Tree IDE main process.
//   - Walks any folder into the graph (src/scanner.js).
//   - Spawns provider CLIs (`claude`, `codex`, or your shell) as PTYs and
//     streams them to the renderer; renderer mounts each in an xterm.js
//     pane in the multi-agent grid.
//   - Watches the open repo for filesystem writes and forwards events so
//     the canvas can flash the touched nodes — provider-agnostic signal:
//     if a file changes on disk, the graph reflects it, no matter who
//     wrote it.

const { app, BrowserWindow, ipcMain, dialog, Menu, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const { spawn } = require('child_process');
const pty = require('node-pty');
const chokidar = require('chokidar');
const { buildGraph } = require('./src/scanner');

// =======================================================================
// Build the app icon (the same directory-tree logo used in the titlebar)
// as a PNG buffer at runtime — no extra deps, no SVG rasterizer needed.
// =======================================================================
function buildLogoPng(size = 512) {
  const W = size, H = size;
  const px = Buffer.alloc(W * H * 4); // RGBA, transparent by default
  const sand  = [231, 222, 209, 255];
  const black = [0, 0, 0, 255];

  // macOS Big Sur+ icon template: the rounded badge takes ~80% of the canvas
  // with transparent padding around it (so it sits inset from the dock edges).
  // Corner radius is ~22.5% of the badge's inner width.
  const pad = Math.round(size * 0.055);
  const inner = size - pad * 2;
  const scale = inner / 24;            // logical units → badge pixels
  const r = Math.round(inner * 0.225); // rounded corner radius

  const x0 = pad, y0 = pad;
  const x1 = pad + inner, y1 = pad + inner;

  // Fill the rounded badge with sand.
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      let cx = x, cy = y, corner = false;
      if      (x < x0 + r && y < y0 + r)         { cx = x0 + r; cy = y0 + r; corner = true; }
      else if (x >= x1 - r && y < y0 + r)        { cx = x1 - r; cy = y0 + r; corner = true; }
      else if (x < x0 + r && y >= y1 - r)        { cx = x0 + r; cy = y1 - r; corner = true; }
      else if (x >= x1 - r && y >= y1 - r)       { cx = x1 - r; cy = y1 - r; corner = true; }
      if (corner) {
        const dx = x - cx, dy = y - cy;
        if (dx*dx + dy*dy > r*r) continue; // outside the rounded corner
      }
      const i = (y * W + x) * 4;
      px[i]=sand[0]; px[i+1]=sand[1]; px[i+2]=sand[2]; px[i+3]=255;
    }
  }

  // Carve the tree inside the badge.
  const fillRect = (lx, ly, lw, lh, c) => {
    const px0 = Math.floor(x0 + lx * scale);
    const py0 = Math.floor(y0 + ly * scale);
    const px1 = Math.floor(x0 + (lx + lw) * scale);
    const py1 = Math.floor(y0 + (ly + lh) * scale);
    for (let y = py0; y < py1; y++) {
      for (let x = px0; x < px1; x++) {
        const i = (y * W + x) * 4;
        if (px[i+3] === 0) continue; // don't paint outside the badge
        px[i]=c[0]; px[i+1]=c[1]; px[i+2]=c[2]; px[i+3]=c[3];
      }
    }
  };
  fillRect(3,  4,  3, 3,    black);
  fillRect(10, 4,  3, 3,    black);
  fillRect(10, 11, 3, 3,    black);
  fillRect(17, 11, 3, 3,    black);
  fillRect(17, 17, 3, 3,    black);
  fillRect(4,  7,  1, 11.5, black); // trunk
  fillRect(4,  5.5, 6, 1,   black); // → top child
  fillRect(4,  12.5, 6, 1,  black); // → mid child
  fillRect(11, 14, 1, 4.5,  black); // sub-trunk
  fillRect(11, 12.5, 6, 1,  black); // sub child
  fillRect(11, 18.5, 6, 1,  black); // sub child

  // Build a PNG (signature + IHDR + IDAT + IEND chunks).
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8]  = 8;   // bit depth
  ihdr[9]  = 6;   // RGBA
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  // raw scanlines: 1 filter byte + W*4 RGBA per row
  const raw = Buffer.alloc(H * (1 + W * 4));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 4)] = 0; // None filter
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
let currentRoot = null;
let fsWatcher = null;

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return process.env.HOME || p;
  if (p.startsWith('~/')) return path.join(process.env.HOME || '', p.slice(2));
  return p;
}

function normalizeOpenRoot(p) {
  if (!p) return null;
  const full = path.resolve(process.cwd(), expandHome(p));
  try {
    if (!fs.existsSync(full)) return null;
    if (!fs.statSync(full).isDirectory()) return null;
    return full;
  } catch {
    return null;
  }
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

let startupRoot = parseOpenRootArg(process.argv);
const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
}

if (gotSingleInstanceLock) {
  app.on('second-instance', (_event, argv) => {
    const root = parseOpenRootArg(argv);
    if (root) {
      startupRoot = root;
      send('app:open-root', { root });
    }
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });
}

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
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (process.argv.includes('--devtools') || process.env.TREE_DEVTOOLS === '1') {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

// =======================================================================
// CLI discovery — provider lookup with sensible PATH fallbacks
// =======================================================================
function searchPathFor(bin) {
  const home = process.env.HOME || '';
  const candidates = [
    `${home}/.local/bin/${bin}`,
    `${home}/.npm-global/bin/${bin}`,
    `${home}/.claude/local/${bin}`,
    `${home}/.claude/bin/${bin}`,
    `/opt/homebrew/bin/${bin}`,
    `/usr/local/bin/${bin}`,
    `/usr/bin/${bin}`,
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  try {
    const { execSync } = require('child_process');
    const out = execSync(`command -v ${bin}`, {
      shell: '/bin/zsh',
      env: { ...process.env, PATH: candidates.map(c => path.dirname(c)).join(':') + ':' + (process.env.PATH || '') },
    }).toString().trim();
    if (out && fs.existsSync(out)) return out;
  } catch {}
  return null;
}

function detectProviders() {
  return {
    claude: searchPathFor('claude'),
    codex:  searchPathFor('codex'),
    shell:  process.env.SHELL || '/bin/zsh',
  };
}

ipcMain.handle('providers:detect', async () => detectProviders());
ipcMain.handle('app:startup-root', async () => startupRoot);

// =======================================================================
// Folder open + repo scan
// =======================================================================
ipcMain.handle('dialog:openFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Open repo to map',
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
});

ipcMain.handle('repo:scan', async (_evt, rootPath) => {
  if (!rootPath || !fs.existsSync(rootPath)) return { error: 'Path does not exist' };
  currentRoot = rootPath;
  send('repo:scan-progress', { status: 'scanning', root: rootPath });
  try {
    const graph = await buildGraph(rootPath, {
      concurrency: 64,
      includeFnEdges: false,
      onProgress: (done, total) => {
        if (done === total || done % 50 === 0) {
          send('repo:scan-progress', { status: 'reading', done, total });
        }
      },
    });
    send('repo:scan-progress', { status: 'done', count: graph.fileCount, ms: graph.elapsedMs });
    startFsWatcher(rootPath);
    return graph;
  } catch (e) {
    return { error: e.message };
  }
});

ipcMain.handle('file:read', async (_evt, relPath) => {
  if (!currentRoot) return { error: 'No repo loaded' };
  const full = path.join(currentRoot, relPath);
  if (!full.startsWith(currentRoot)) return { error: 'Path escapes root' };
  try {
    const content = fs.readFileSync(full, 'utf8');
    return { content: content.length > 200_000 ? content.slice(0, 200_000) : content };
  } catch (e) {
    return { error: e.message };
  }
});

// =======================================================================
// Filesystem watcher — drives the live graph animation
// =======================================================================
const FS_SKIP = [
  '**/node_modules/**', '**/.git/**', '**/dist/**', '**/build/**',
  '**/.next/**', '**/.nuxt/**', '**/.expo/**', '**/.cache/**',
  '**/.turbo/**', '**/.vercel/**', '**/.parcel-cache/**',
  '**/.svelte-kit/**', '**/.angular/**', '**/.docusaurus/**',
  '**/target/**', '**/out/**', '**/vendor/**', '**/.gradle/**',
  '**/Pods/**', '**/DerivedData/**', '**/.terraform/**', '**/cdk.out/**',
  '**/.output/**', '**/bower_components/**',
  '**/__pycache__/**', '**/venv/**', '**/.venv*/**', '**/coverage/**',
  '**/tmp/**', '**/temp/**', '**/.tmp/**', '**/uploads/**',
  '**/.DS_Store', '**/Thumbs.db',
];

function startFsWatcher(root) {
  if (fsWatcher) {
    try { fsWatcher.close(); } catch {}
    fsWatcher = null;
  }
  try {
    fsWatcher = chokidar.watch(root, {
      ignored: FS_SKIP,
      ignoreInitial: true,
      persistent: true,
      awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 100 },
    });
    const emit = (type) => (full) => {
      const rel = path.relative(root, full);
      if (!rel || rel.startsWith('..')) return;
      send('fs:event', { type, path: rel, fullPath: full, at: Date.now() });
    };
    fsWatcher.on('add',    emit('add'));
    fsWatcher.on('change', emit('change'));
    fsWatcher.on('unlink', emit('unlink'));
  } catch (e) {
    send('fs:event', { type: 'error', error: e.message });
  }
}

ipcMain.handle('fs:watch', async (_evt, root) => {
  startFsWatcher(root || currentRoot);
  return { ok: true };
});

// =======================================================================
// Embedded PTY agents (node-pty) — for shell + codex tiles
// =======================================================================
const ptyAgents = new Map();

ipcMain.handle('pty:spawn', async (_evt, payload) => {
  const { agentId, provider = 'shell', cwd: cwdOpt, cols = 100, rows = 32, cliPath: cliOverride } = payload || {};
  if (!agentId) return { error: 'agentId required' };
  if (ptyAgents.has(agentId)) return { error: 'agent exists' };

  const providers = detectProviders();
  let program, args;
  if (provider === 'claude') {
    program = cliOverride || providers.claude;
    if (!program) return { error: 'claude CLI not found. Install: npm i -g @anthropic-ai/claude-code' };
    args = [];
  } else if (provider === 'codex') {
    program = cliOverride || providers.codex;
    if (!program) return { error: 'codex CLI not found. Install: npm i -g @openai/codex' };
    args = [];
  } else {
    program = process.env.SHELL || '/bin/zsh';
    args = ['-l'];
  }

  const cwd = cwdOpt || currentRoot || process.env.HOME || process.cwd();

  const env = { ...process.env };
  if (provider === 'claude') {
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
  }
  env.PATH = [
    `${process.env.HOME}/.local/bin`,
    `${process.env.HOME}/.npm-global/bin`,
    `${process.env.HOME}/.claude/local`,
    '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin',
    env.PATH || '',
  ].filter(Boolean).join(':');
  env.TERM = 'xterm-256color';
  env.COLORTERM = 'truecolor';
  env.FORCE_COLOR = env.FORCE_COLOR || '1';
  env.LANG = env.LANG || 'en_US.UTF-8';
  env.LC_ALL = env.LC_ALL || env.LANG;
  env.CI = '';

  let term;
  try {
    term = pty.spawn(program, args, { name: 'xterm-256color', cols, rows, cwd, env });
  } catch (e) {
    return { error: `Failed to spawn ${provider}: ${e.message}` };
  }

  ptyAgents.set(agentId, { term, provider, cwd, program });
  term.onData((data) => send('pty:data', { agentId, data }));
  term.onExit(({ exitCode, signal }) => {
    ptyAgents.delete(agentId);
    send('pty:exit', { agentId, exitCode, signal });
  });
  return { ok: true, provider, program, cwd, pid: term.pid };
});

// Fire-and-forget channels for hot paths — no IPC ack per keystroke.
ipcMain.on('pty:write', (_evt, { agentId, data }) => {
  const r = ptyAgents.get(agentId);
  if (!r) return;
  try { r.term.write(data); } catch {}
});
ipcMain.on('pty:resize', (_evt, { agentId, cols, rows }) => {
  const r = ptyAgents.get(agentId);
  if (!r) return;
  try { r.term.resize(Math.max(2, cols|0), Math.max(2, rows|0)); } catch {}
});
ipcMain.handle('pty:kill', async (_evt, agentId) => {
  const r = ptyAgents.get(agentId);
  if (!r) return { error: 'no such agent' };
  try { r.term.kill(); } catch {}
  ptyAgents.delete(agentId);
  return { ok: true };
});

// =======================================================================
// External terminal launcher — fallback for CLIs whose TUIs don't play
// nicely inside an embedded PTY (e.g. claude). Opens Terminal.app / iTerm.
// =======================================================================
function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function buildLaunchCommand(provider, cwd) {
  const cmds = ['shell'].includes(provider)
    ? [`cd ${shellQuote(cwd)}`]
    : [`cd ${shellQuote(cwd)}`, provider];
  return cmds.join(' && ');
}

async function openInTerminalApp(cmd) {
  if (process.platform === 'darwin') {
    // Prefer iTerm if installed, else Terminal.app
    const iterm = '/Applications/iTerm.app';
    const useITerm = fs.existsSync(iterm);
    const app = useITerm ? 'iTerm' : 'Terminal';
    const escaped = cmd.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
    const script = useITerm
      ? `tell application "iTerm"
           create window with default profile
           tell current session of current window to write text "${escaped}"
           activate
         end tell`
      : `tell application "Terminal"
           do script "${escaped}"
           activate
         end tell`;
    return new Promise((resolve) => {
      const p = spawn('osascript', ['-e', script], { stdio: 'ignore' });
      p.on('exit', (code) => resolve({ ok: code === 0, app }));
      p.on('error', (err) => resolve({ ok: false, error: err.message }));
    });
  }
  if (process.platform === 'linux') {
    // gnome-terminal as a sensible default
    return new Promise((resolve) => {
      const p = spawn('x-terminal-emulator', ['-e', 'bash', '-lc', cmd], { stdio: 'ignore' });
      p.on('exit', (code) => resolve({ ok: code === 0 }));
      p.on('error', (err) => resolve({ ok: false, error: err.message }));
    });
  }
  if (process.platform === 'win32') {
    // Windows Terminal if present, fall back to cmd
    return new Promise((resolve) => {
      const p = spawn('wt.exe', ['-d', process.env.USERPROFILE, 'cmd', '/k', cmd], { stdio: 'ignore' });
      p.on('exit', (code) => resolve({ ok: code === 0 }));
      p.on('error', () => {
        const p2 = spawn('cmd.exe', ['/c', 'start', 'cmd', '/k', cmd], { stdio: 'ignore' });
        p2.on('exit', (c) => resolve({ ok: c === 0 }));
        p2.on('error', (err) => resolve({ ok: false, error: err.message }));
      });
    });
  }
  return { ok: false, error: `Unsupported platform: ${process.platform}` };
}

ipcMain.handle('agent:launch', async (_evt, payload) => {
  const { provider = 'shell', cwd: cwdOpt } = payload || {};
  const cwd = cwdOpt || currentRoot || process.env.HOME || process.cwd();
  const providers = detectProviders();
  if (provider === 'claude' && !providers.claude)
    return { error: 'claude CLI not found. Install: npm i -g @anthropic-ai/claude-code' };
  if (provider === 'codex' && !providers.codex)
    return { error: 'codex CLI not found. Install: npm i -g @openai/codex' };
  const cmd = buildLaunchCommand(provider, cwd);
  const r = await openInTerminalApp(cmd);
  return { ...r, provider, cwd, cmd };
});

// =======================================================================
// App lifecycle
// =======================================================================
if (gotSingleInstanceLock) app.whenReady().then(() => {
  // Brand the app as "Tree" in macOS menubar / About dialog / dock tooltip,
  // while keeping the long form "Tree IDE" in the package metadata.
  try { app.setName('Tree'); } catch {}
  if (process.platform === 'darwin' && app.dock) {
    try { app.dock.setIcon(getAppIcon()); } catch {}
  }
  createWindow();
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        { label: 'Open Repo…', accelerator: 'CmdOrCtrl+O', click: () => send('menu:open-folder') },
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

app.on('window-all-closed', () => {
  for (const [, r] of ptyAgents) { try { r.term.kill(); } catch {} }
  ptyAgents.clear();
  if (fsWatcher) { try { fsWatcher.close(); } catch {} fsWatcher = null; }
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
