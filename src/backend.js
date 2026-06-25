// Tree IDE backend — provider-agnostic core extracted from main.js.
//
// Everything the renderer needs (scan, file read, PTY, watcher, provider
// detection, external terminal launch, update check) lives here as plain
// functions on a Backend instance. The same instance is used both by:
//
//   - main.js (Electron desktop mode): wraps Backend with HTTP+WS server,
//     then loads http://127.0.0.1:PORT/ in BrowserWindow.
//   - bin/tree-ide-server.js (headless serve mode): runs the same server
//     on a remote host, user SSH-tunnels in and opens a browser.
//
// Events fire on backend.events (an EventEmitter). The HTTP+WS server
// forwards them to every connected client.

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const { EventEmitter } = require('events');
const { spawn, execSync } = require('child_process');
const chokidar = require('chokidar');
const { buildGraph } = require('./scanner');
const { UsageService } = require('./usage/service');

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

function isTooBroad(p) {
  const norm = path.resolve(p);
  const home = os.homedir();
  if (norm === '/' || norm === home) return true;
  const broad = new Set(['/home', '/Users', '/mnt', '/mnt/c', '/mnt/d', '/root', '/tmp']);
  if (broad.has(norm)) return true;
  return false;
}

// node-pty is loaded lazily so the server can survive on remotes where the
// native build failed (file reads + scan still work; only PTY breaks).
function loadPty() {
  try {
    return require('node-pty');
  } catch (e) {
    return { _error: e };
  }
}

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
    const out = execSync(`command -v ${bin}`, {
      shell: '/bin/zsh',
      env: { ...process.env, PATH: candidates.map(c => path.dirname(c)).join(':') + ':' + (process.env.PATH || '') },
    }).toString().trim();
    if (out && fs.existsSync(out)) return out;
  } catch {}
  return null;
}

function shellQuote(s) {
  return `'${String(s).replace(/'/g, `'\\''`)}'`;
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableJson(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function graphState(graph = {}) {
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : [];
  const edges = Array.isArray(graph.edges) ? graph.edges : [];
  return {
    nodes,
    edges,
    nodesById: new Map(nodes.map(n => [n.id, n])),
    edgesById: new Map(edges.map(e => [e.id, e])),
    nodeSigById: new Map(nodes.map(n => [n.id, stableJson(n)])),
    edgeSigById: new Map(edges.map(e => [e.id, stableJson(e)])),
  };
}

function diffGraphStates(prev, next, meta = {}) {
  const patch = {
    ...meta,
    nodes: { add: [], update: [], remove: [] },
    edges: { add: [], update: [], remove: [] },
  };

  for (const [id, node] of next.nodesById) {
    if (!prev.nodesById.has(id)) patch.nodes.add.push(node);
    else if (prev.nodeSigById.get(id) !== next.nodeSigById.get(id)) patch.nodes.update.push(node);
  }
  for (const id of prev.nodesById.keys()) {
    if (!next.nodesById.has(id)) patch.nodes.remove.push(id);
  }

  for (const [id, edge] of next.edgesById) {
    if (!prev.edgesById.has(id)) patch.edges.add.push(edge);
    else if (prev.edgeSigById.get(id) !== next.edgeSigById.get(id)) patch.edges.update.push(edge);
  }
  for (const id of prev.edgesById.keys()) {
    if (!next.edgesById.has(id)) patch.edges.remove.push(id);
  }

  patch.empty = !patch.nodes.add.length && !patch.nodes.update.length && !patch.nodes.remove.length &&
    !patch.edges.add.length && !patch.edges.update.length && !patch.edges.remove.length;
  return patch;
}

class Backend {
  constructor(opts = {}) {
    this.events = new EventEmitter();
    // Bump the listener cap — each connected WS client subscribes to every
    // event channel; with multiple browser tabs open the default 10 limit
    // would fire noisy warnings even though there's no leak.
    this.events.setMaxListeners(0);
    this.startupRoot = opts.startupRoot || null;
    this.currentRoot = null;
    this.fsWatcher = null;
    this.ptyAgents = new Map();
    this.usage = opts.usageService || new UsageService(opts.usage || {});
    this.usageUpdateTimer = null;
    // Set by main.js when running inside Electron; lets us still expose
    // app-level features (folder picker, relaunch) over the RPC channel
    // when the host process can implement them.
    this.electronHooks = opts.electronHooks || null;
    this.pkg = opts.pkg || { version: '0.0.0' };
    this.updateRepo = opts.updateRepo || 'vihaanshahh/tree-ide';
    this.currentGraph = graphState({ nodes: [], edges: [] });
    this.graphPatchTimer = null;
    this.graphPatchInFlight = false;
    this.graphPatchPending = false;
    this.graphPatchSeq = 0;
  }

  // -------------------------------------------------------------------
  // Repo scan + file read
  // -------------------------------------------------------------------
  resolveRepoFile(relPath) {
    if (!this.currentRoot) return { error: 'No repo loaded' };
    if (typeof relPath !== 'string' || !relPath.trim()) return { error: 'Missing file path' };
    if (path.isAbsolute(relPath)) return { error: 'Path escapes root' };

    const root = path.resolve(this.currentRoot);
    const full = path.resolve(root, relPath);
    if (full !== root && !full.startsWith(root + path.sep)) return { error: 'Path escapes root' };
    return { root, full };
  }

  async scanRepo(rootPath) {
    if (!rootPath || !fs.existsSync(rootPath)) return { error: 'Path does not exist' };
    if (isTooBroad(rootPath)) {
      return { error: `${rootPath} is too broad — open a single project folder instead.` };
    }
    this.currentRoot = rootPath;
    this.events.emit('repo:scan-progress', { status: 'scanning', root: rootPath });
    try {
      const graph = await buildGraph(rootPath, {
        concurrency: 64,
        includeFnEdges: true,
        onProgress: (done, total) => {
          if (done === total || done % 50 === 0) {
            this.events.emit('repo:scan-progress', { status: 'reading', done, total });
          }
        },
      });
      this.currentGraph = graphState(graph);
      this.events.emit('repo:scan-progress', { status: 'done', count: graph.fileCount, ms: graph.elapsedMs });
      this.startFsWatcher(rootPath);
      return graph;
    } catch (e) {
      return { error: e.message };
    }
  }

  async readFile(relPath, opts = {}) {
    const resolved = this.resolveRepoFile(relPath);
    if (resolved.error) return { error: resolved.error };
    try {
      const content = fs.readFileSync(resolved.full, 'utf8');
      const maxChars = Math.max(1, Number(opts?.maxChars) || 200_000);
      const truncated = content.length > maxChars;
      return {
        content: truncated ? content.slice(0, maxChars) : content,
        truncated,
        size: Buffer.byteLength(content, 'utf8'),
      };
    } catch (e) {
      return { error: e.message };
    }
  }

  async writeFile(relPath, content) {
    const resolved = this.resolveRepoFile(relPath);
    if (resolved.error) return { error: resolved.error };
    if (typeof content !== 'string') return { error: 'File content must be text' };
    try {
      fs.writeFileSync(resolved.full, content, 'utf8');
      this.scheduleGraphPatch('change');
      return {
        ok: true,
        size: Buffer.byteLength(content, 'utf8'),
        savedAt: new Date().toISOString(),
      };
    } catch (e) {
      return { error: e.message };
    }
  }

  detectProviders() {
    return {
      claude: searchPathFor('claude'),
      codex:  searchPathFor('codex'),
      shell:  process.env.SHELL || '/bin/zsh',
    };
  }

  getStartupRoot() {
    return this.startupRoot;
  }

  setStartupRoot(root) {
    this.startupRoot = normalizeOpenRoot(root);
    if (this.startupRoot) this.events.emit('app:open-root', { root: this.startupRoot });
  }

  usageAgentsSnapshot() {
    const now = Date.now();
    return [...this.ptyAgents.entries()].map(([id, r]) => ({
      id,
      provider: r.provider,
      cwd: r.cwd,
      program: r.program,
      pid: r.term?.pid || null,
      ageSeconds: r.startedAt ? Math.max(0, (now - r.startedAt) / 1000) : null,
      lastOutputAgeSeconds: r.lastOutputAt ? Math.max(0, (now - r.lastOutputAt) / 1000) : null,
    }));
  }

  async getUsage(payload = {}) {
    return this.usage.snapshot({
      range: payload?.range || '7d',
      force: Boolean(payload?.force),
      agents: this.usageAgentsSnapshot(),
      // Push live "reading Codex / reading Claude / …" stages to the renderer so
      // the (slow, ~50s cold) snapshot shows real progress instead of a spinner.
      onProgress: (evt) => this.events.emit('usage:progress', evt),
    });
  }

  async refreshUsage(payload = {}) {
    return this.getUsage({ ...payload, force: true });
  }

  scheduleUsageUpdate(force = false) {
    clearTimeout(this.usageUpdateTimer);
    this.usageUpdateTimer = setTimeout(async () => {
      this.usageUpdateTimer = null;
      try {
        this.events.emit('usage:update', await this.getUsage({ force }));
      } catch (e) {
        this.events.emit('usage:update', {
          ok: false,
          status: 'error',
          generatedAt: new Date().toISOString(),
          error: e.message || String(e),
          activeAgents: this.usageAgentsSnapshot(),
        });
      }
    }, 250);
  }

  // -------------------------------------------------------------------
  // FS watcher
  // -------------------------------------------------------------------
  startFsWatcher(root) {
    if (this.fsWatcher) {
      try { this.fsWatcher.close(); } catch {}
      this.fsWatcher = null;
    }
    try {
      this.fsWatcher = chokidar.watch(root, {
        ignored: FS_SKIP,
        ignoreInitial: true,
        persistent: true,
        awaitWriteFinish: { stabilityThreshold: 120, pollInterval: 100 },
      });
      const emit = (type) => (full) => {
        const rel = path.relative(root, full);
        if (!rel || rel.startsWith('..')) return;
        this.events.emit('fs:event', { type, path: rel, fullPath: full, at: Date.now() });
        this.scheduleGraphPatch(type);
      };
      this.fsWatcher.on('add',    emit('add'));
      this.fsWatcher.on('change', emit('change'));
      this.fsWatcher.on('unlink', emit('unlink'));
    } catch (e) {
      this.events.emit('fs:event', { type: 'error', error: e.message });
    }
  }

  watchFs(root) {
    this.startFsWatcher(root || this.currentRoot);
    return { ok: true };
  }

  scheduleGraphPatch(type = 'change') {
    if (!this.currentRoot) return;
    const delay = type === 'change' ? 550 : 180;
    this.graphPatchPending = true;
    clearTimeout(this.graphPatchTimer);
    this.graphPatchTimer = setTimeout(() => {
      this.graphPatchTimer = null;
      this.rebuildGraphPatch();
    }, delay);
  }

  async rebuildGraphPatch() {
    if (!this.currentRoot) return;
    if (this.graphPatchInFlight) {
      this.graphPatchPending = true;
      return;
    }
    const root = this.currentRoot;
    const seq = ++this.graphPatchSeq;
    this.graphPatchPending = false;
    this.graphPatchInFlight = true;
    this.events.emit('repo:scan-progress', { status: 'patching', root });
    try {
      const graph = await buildGraph(root, {
        concurrency: 64,
        includeFnEdges: true,
        onProgress: (done, total) => {
          if (done === total || done % 100 === 0) {
            this.events.emit('repo:scan-progress', { status: 'patching', done, total });
          }
        },
      });
      if (root !== this.currentRoot) return;
      const next = graphState(graph);
      const patch = diffGraphStates(this.currentGraph, next, {
        seq,
        root,
        files: graph.files || [],
        fileCount: graph.fileCount,
        elapsedMs: graph.elapsedMs,
      });
      this.currentGraph = next;
      this.events.emit('graph:patch', patch);
      this.events.emit('repo:scan-progress', { status: 'done', count: graph.fileCount, ms: graph.elapsedMs, patch: true });
    } catch (e) {
      this.events.emit('repo:scan-progress', { status: 'error', error: e.message });
    } finally {
      this.graphPatchInFlight = false;
      if (this.graphPatchPending && root === this.currentRoot) this.scheduleGraphPatch('change');
    }
  }

  // -------------------------------------------------------------------
  // PTY agents
  // -------------------------------------------------------------------
  ptySpawn(payload) {
    const { agentId, provider = 'shell', cwd: cwdOpt, cols = 100, rows = 32, cliPath: cliOverride } = payload || {};
    if (!agentId) return { error: 'agentId required' };
    if (this.ptyAgents.has(agentId)) return { error: 'agent exists' };

    const pty = loadPty();
    if (pty._error) return { error: `node-pty unavailable: ${pty._error.message}` };

    const providers = this.detectProviders();
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

    const cwd = cwdOpt || this.currentRoot || process.env.HOME || process.cwd();

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

    const record = { term, provider, cwd, program, startedAt: Date.now(), lastOutputAt: 0 };
    this.ptyAgents.set(agentId, record);
    term.onData((data) => {
      if (data) record.lastOutputAt = Date.now();
      this.events.emit('pty:data', { agentId, data });
    });
    term.onExit(({ exitCode, signal }) => {
      this.ptyAgents.delete(agentId);
      this.events.emit('pty:exit', { agentId, exitCode, signal });
      this.scheduleUsageUpdate(false);
    });
    this.scheduleUsageUpdate(false);
    return { ok: true, provider, program, cwd, pid: term.pid };
  }

  ptyWrite(agentId, data) {
    const r = this.ptyAgents.get(agentId);
    if (!r) return;
    try { r.term.write(data); } catch {}
  }

  ptyResize(agentId, cols, rows) {
    const r = this.ptyAgents.get(agentId);
    if (!r) return;
    try { r.term.resize(Math.max(2, cols|0), Math.max(2, rows|0)); } catch {}
  }

  ptyKill(agentId) {
    const r = this.ptyAgents.get(agentId);
    if (!r) return { error: 'no such agent' };
    try { r.term.kill(); } catch {}
    this.ptyAgents.delete(agentId);
    this.scheduleUsageUpdate(false);
    return { ok: true };
  }

  // -------------------------------------------------------------------
  // External terminal launcher — fallback for TUIs that don't render
  // nicely inside an embedded PTY. Skipped in headless serve mode (no
  // local desktop session to pop a window into).
  // -------------------------------------------------------------------
  async launchAgent(payload) {
    const { provider = 'shell', cwd: cwdOpt } = payload || {};
    const cwd = cwdOpt || this.currentRoot || process.env.HOME || process.cwd();
    const providers = this.detectProviders();
    if (provider === 'claude' && !providers.claude)
      return { error: 'claude CLI not found. Install: npm i -g @anthropic-ai/claude-code' };
    if (provider === 'codex' && !providers.codex)
      return { error: 'codex CLI not found. Install: npm i -g @openai/codex' };
    const cmds = provider === 'shell'
      ? [`cd ${shellQuote(cwd)}`]
      : [`cd ${shellQuote(cwd)}`, provider];
    const cmd = cmds.join(' && ');

    if (process.env.TREE_IDE_HEADLESS === '1') {
      return { error: 'External terminal launch not available in headless serve mode.' };
    }

    if (process.platform === 'darwin') {
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
        p.on('exit', (code) => resolve({ ok: code === 0, app, provider, cwd, cmd }));
        p.on('error', (err) => resolve({ ok: false, error: err.message, provider, cwd, cmd }));
      });
    }
    if (process.platform === 'linux') {
      return new Promise((resolve) => {
        const p = spawn('x-terminal-emulator', ['-e', 'bash', '-lc', cmd], { stdio: 'ignore' });
        p.on('exit', (code) => resolve({ ok: code === 0, provider, cwd, cmd }));
        p.on('error', (err) => resolve({ ok: false, error: err.message, provider, cwd, cmd }));
      });
    }
    if (process.platform === 'win32') {
      return new Promise((resolve) => {
        const p = spawn('wt.exe', ['-d', process.env.USERPROFILE, 'cmd', '/k', cmd], { stdio: 'ignore' });
        p.on('exit', (code) => resolve({ ok: code === 0, provider, cwd, cmd }));
        p.on('error', () => {
          const p2 = spawn('cmd.exe', ['/c', 'start', 'cmd', '/k', cmd], { stdio: 'ignore' });
          p2.on('exit', (c) => resolve({ ok: c === 0, provider, cwd, cmd }));
          p2.on('error', (err) => resolve({ ok: false, error: err.message, provider, cwd, cmd }));
        });
      });
    }
    return { ok: false, error: `Unsupported platform: ${process.platform}`, provider, cwd, cmd };
  }

  // -------------------------------------------------------------------
  // Update check — Electron-only. In serve mode these become no-ops so
  // the renderer just hides the update banner.
  // -------------------------------------------------------------------
  async checkUpdate() {
    if (this.electronHooks?.checkUpdate) {
      try { return await this.electronHooks.checkUpdate(); }
      catch (e) { return { current: this.pkg.version, error: e.message || String(e) }; }
    }
    try {
      const latest = await fetchLatestRelease(this.updateRepo);
      const current = this.pkg.version;
      const isNewer = !!latest.tag && compareVersions(latest.tag, current) > 0;
      return { current, latest: latest.tag, isNewer, htmlUrl: latest.htmlUrl, gitCheckout: false, serveMode: true };
    } catch (e) {
      return { current: this.pkg.version, error: e.message || String(e) };
    }
  }

  async relaunchApp() {
    if (this.electronHooks?.relaunch) {
      this.electronHooks.relaunch();
      return { ok: true };
    }
    return { error: 'Relaunch only available in desktop mode.' };
  }

  async updateAndRelaunch() {
    if (this.electronHooks?.updateAndRelaunch) {
      return this.electronHooks.updateAndRelaunch();
    }
    return { error: 'Self-update only available in desktop mode. Re-run install.sh on this host to upgrade.' };
  }

  // -------------------------------------------------------------------
  // Folder picker — Electron-only. In browser mode the renderer falls
  // back to a path input.
  // -------------------------------------------------------------------
  async openFolder() {
    if (this.electronHooks?.openFolder) return this.electronHooks.openFolder();
    return null;
  }

  // -------------------------------------------------------------------
  // Lifecycle
  // -------------------------------------------------------------------
  shutdown() {
    clearTimeout(this.usageUpdateTimer);
    for (const [, r] of this.ptyAgents) { try { r.term.kill(); } catch {} }
    this.ptyAgents.clear();
    if (this.fsWatcher) {
      try { this.fsWatcher.close(); } catch {}
      this.fsWatcher = null;
    }
  }
}

function compareVersions(a, b) {
  const split = (v) => String(v || '').replace(/^v/, '').split(/[.-]/).map(s => /^\d+$/.test(s) ? parseInt(s, 10) : s);
  const pa = split(a), pb = split(b);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const x = pa[i] ?? 0, y = pb[i] ?? 0;
    if (typeof x === 'number' && typeof y === 'number') {
      if (x !== y) return x - y;
    } else if (String(x) !== String(y)) {
      return String(x) < String(y) ? -1 : 1;
    }
  }
  return 0;
}

function fetchLatestRelease(repo) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      `https://api.github.com/repos/${repo}/releases/latest`,
      { headers: { 'User-Agent': 'tree-ide-update-check', 'Accept': 'application/vnd.github+json' } },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`HTTP ${res.statusCode}`));
        }
        let body = '';
        res.on('data', (c) => body += c);
        res.on('end', () => {
          try {
            const j = JSON.parse(body);
            resolve({
              tag: String(j.tag_name || '').replace(/^v/, ''),
              htmlUrl: j.html_url || `https://github.com/${repo}/releases`,
            });
          } catch (e) { reject(e); }
        });
      }
    );
    req.setTimeout(8000, () => req.destroy(new Error('timeout')));
    req.on('error', reject);
  });
}

module.exports = { Backend, normalizeOpenRoot, isTooBroad, expandHome, compareVersions, fetchLatestRelease };
