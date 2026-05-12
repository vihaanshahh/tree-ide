const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { buildGraph } = require('./src/scanner');

let mainWindow = null;
let currentRoot = null;
// (single-agent state replaced by `agents` Map below)
let claudeCliPath = null;
let claudeSdkPromise = null; // cached dynamic ESM import

function loadClaudeSdk() {
  // The SDK ships as ESM (`sdk.mjs`) and Electron's CommonJS require() can't
  // load ESM. Use dynamic import() and cache the resulting module so we only
  // pay the load cost once.
  if (!claudeSdkPromise) {
    claudeSdkPromise = import('@anthropic-ai/claude-agent-sdk').catch((err) => {
      claudeSdkPromise = null;
      throw err;
    });
  }
  return claudeSdkPromise;
}

function findClaudeCli() {
  if (claudeCliPath) return claudeCliPath;
  const { execSync } = require('child_process');
  const candidates = [
    `${process.env.HOME}/.local/bin/claude`,
    '/opt/homebrew/bin/claude',
    '/usr/local/bin/claude',
  ];
  for (const c of candidates) {
    try { if (require('fs').existsSync(c)) { claudeCliPath = c; return c; } } catch {}
  }
  try {
    const out = execSync('command -v claude', {
      shell: '/bin/zsh',
      env: { ...process.env, PATH: `${process.env.HOME}/.local/bin:/opt/homebrew/bin:/usr/local/bin:${process.env.PATH || ''}` },
    }).toString().trim();
    if (out) { claudeCliPath = out; return out; }
  } catch {}
  return null;
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1500,
    height: 950,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0b0d12',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  if (process.argv.includes('--devtools')) {
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  }
}

function send(channel, payload) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload);
  }
}

ipcMain.handle('dialog:openFolder', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Open repo to map',
  });
  if (result.canceled || !result.filePaths[0]) return null;
  return result.filePaths[0];
});

ipcMain.handle('repo:scan', async (_evt, rootPath) => {
  if (!rootPath || !fs.existsSync(rootPath)) {
    return { error: 'Path does not exist' };
  }
  currentRoot = rootPath;
  send('repo:scan-progress', { status: 'scanning', root: rootPath });
  try {
    const graph = await buildGraph(rootPath, {
      concurrency: 96,
      includeFnEdges: false,
      onProgress: (done, total) => {
        // Throttle: only emit every 10% or every 50 files
        if (done === total || done % 50 === 0) {
          send('repo:scan-progress', { status: 'reading', done, total });
        }
      },
    });
    send('repo:scan-progress', { status: 'done', count: graph.fileCount, ms: graph.elapsedMs });
    return graph;
  } catch (e) {
    return { error: e.message };
  }
});

// Robust preflight: not only locate the `claude` CLI, but verify it actually
// works (the version probe spawns the binary the same way the SDK will).
// Returns { ok, cliPath, version, mode, error? } so the UI can show a real
// status instead of just "CLI present".
ipcMain.handle('claude:check', async () => {
  const cliPath = findClaudeCli();
  if (!cliPath) {
    return { ok: false, hasCli: false, mode: 'subscription',
             error: 'claude CLI not found. Install: npm i -g @anthropic-ai/claude-code' };
  }
  const { spawn } = require('child_process');
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  delete env.ANTHROPIC_AUTH_TOKEN;
  env.PATH = [
    `${process.env.HOME}/.local/bin`,
    '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin',
    env.PATH || '',
  ].filter(Boolean).join(':');
  const version = await new Promise((resolve) => {
    let out = '';
    const p = spawn(cliPath, ['--version'], { env, timeout: 5000 });
    p.stdout.on('data', (d) => (out += d.toString()));
    p.on('close', () => resolve(out.trim()));
    p.on('error', () => resolve(''));
  });
  return {
    ok: !!version,
    hasCli: true,
    cliPath,
    version: version || 'unknown',
    mode: 'subscription',
    error: version ? null : 'claude CLI failed to start (try running `claude` once to log in)',
  };
});

// Concurrent agents: each is its own Claude session with its own iterator,
// abort controller, and partial-streaming state. Keyed by agentId from the
// renderer.
const agents = new Map(); // agentId → { abort, query, sessionId, partial }

ipcMain.handle('claude:query', async (_evt, payload) => {
  const { agentId, prompt, mode = 'explore', focusNode = null, model, resume } = payload || {};
  if (!currentRoot) return { error: 'No repo loaded' };
  if (!agentId) return { error: 'agentId required' };
  if (agents.has(agentId)) return { error: 'This agent already has a query running — stop it first' };

  let sdk;
  try {
    sdk = await loadClaudeSdk();
  } catch (e) {
    return { error: 'Claude SDK failed to load: ' + (e && e.message ? e.message : String(e)) };
  }

  // Subscription-mode environment: drop API keys so the spawned `claude` CLI
  // uses its stored OAuth credentials. Make sure the CLI path is in PATH.
  const subEnv = { ...process.env };
  delete subEnv.ANTHROPIC_API_KEY;
  delete subEnv.ANTHROPIC_AUTH_TOKEN;
  subEnv.PATH = [
    `${process.env.HOME}/.local/bin`,
    '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin',
    subEnv.PATH || '',
  ].filter(Boolean).join(':');
  // Help observability platforms identify this app
  subEnv.CLAUDE_AGENT_SDK_CLIENT_APP = 'tree-ide/0.1.0';

  const cliPath = findClaudeCli();
  if (!cliPath) {
    return { error: 'claude CLI not found on PATH. Install with `npm i -g @anthropic-ai/claude-code` and run `claude` once to log in.' };
  }

  const focusBlock = focusNode
    ? `\nThe user has the file \`${focusNode}\` selected in the live graph. Start there when relevant.\n`
    : '';
  const fullPrompt = `${focusBlock}${prompt}`;

  // Modern systemPrompt: extend the default Claude Code preset rather than
  // replacing it. Keeps all the CLI's built-in tool-use guidance intact.
  const appendSystem =
    `You are working inside Tree IDE, a graph-first IDE.\n` +
    `The user is looking at a live blueprint of this codebase — every file you Read or Edit lights up on the map.\n` +
    `Be precise: cite files by their relative path. When you find something interesting (a bug, a dead API call, a structural smell), explain it concisely.\n` +
    `If the user references a "page", "endpoint", "table", or "store" they mean the corresponding node on the map.\n` +
    `Edits: only when explicitly asked. Otherwise read, analyze, suggest.`;

  const abort = new AbortController();
  const agentRec = { abort, query: null, sessionId: null, partial: new Map() };
  agents.set(agentId, agentRec);

  send('claude:event', { agentId, type: 'start', prompt: fullPrompt, mode });

  try {
    const options = {
      cwd: currentRoot,
      permissionMode: mode === 'edit' ? 'acceptEdits' : 'default',
      systemPrompt: { type: 'preset', preset: 'claude_code', append: appendSystem },
      env: subEnv,
      pathToClaudeCodeExecutable: cliPath,
      includePartialMessages: true,
      abortController: abort,
      allowedTools: mode === 'edit'
        ? ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash', 'TodoWrite']
        : ['Read', 'Grep', 'Glob', 'TodoWrite'],
    };
    if (model) options.model = model;
    if (resume) options.resume = resume;

    const iterator = sdk.query({ prompt: fullPrompt, options });
    agentRec.query = iterator;

    for await (const message of iterator) {
      if (abort.signal.aborted) break;
      handleSdkMessage(message, agentId, agentRec);
    }
    send('claude:event', { agentId, type: 'done' });
  } catch (err) {
    if (err && err.name === 'AbortError') {
      send('claude:event', { agentId, type: 'canceled' });
    } else {
      send('claude:event', {
        agentId,
        type: 'error',
        error: friendlyError(err),
      });
    }
  } finally {
    agents.delete(agentId);
  }
  return { ok: true };
});

function friendlyError(err) {
  const msg = err && (err.message || String(err)) || 'Unknown error';
  if (/ENOENT/.test(msg) && /claude/.test(msg)) {
    return 'claude CLI not found. Install: npm i -g @anthropic-ai/claude-code';
  }
  if (/EACCES/.test(msg)) return 'Permission denied running claude CLI.';
  if (/not authenticated|not logged in|unauthorized|401/i.test(msg)) {
    return 'Not signed in. Run `claude` in a terminal and sign in with your Anthropic subscription.';
  }
  if (/rate.?limit|429/i.test(msg)) return 'Rate limited by Anthropic — try again in a moment.';
  if (/network|ECONNREFUSED|ETIMEDOUT|getaddrinfo/i.test(msg)) {
    return 'Network error reaching Anthropic.';
  }
  return msg;
}

ipcMain.handle('claude:cancel', async (_evt, agentId) => {
  const rec = agentId ? agents.get(agentId) : null;
  if (rec) {
    try { rec.abort.abort(); } catch {}
    if (rec.query && typeof rec.query.interrupt === 'function') {
      try { await rec.query.interrupt(); } catch {}
    } else if (rec.query && typeof rec.query.return === 'function') {
      try { await rec.query.return(); } catch {}
    }
    agents.delete(agentId);
    send('claude:event', { agentId, type: 'canceled' });
  } else if (!agentId) {
    // Legacy: cancel all running agents
    for (const [id, r] of agents) {
      try { r.abort.abort(); } catch {}
      send('claude:event', { agentId: id, type: 'canceled' });
    }
    agents.clear();
  }
  return { ok: true };
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

function relPathFromAbs(absPath) {
  if (!absPath || !currentRoot) return absPath;
  if (absPath.startsWith(currentRoot)) {
    return path.relative(currentRoot, absPath) || absPath;
  }
  return absPath;
}

function extractFileTarget(toolName, input) {
  if (!input || typeof input !== 'object') return null;
  const candidates = [
    input.file_path, input.path, input.notebook_path,
    input.filePath, input.target_file,
  ];
  for (const c of candidates) {
    if (typeof c === 'string') return relPathFromAbs(c);
  }
  if (toolName === 'Glob' && input.pattern) return `glob:${input.pattern}`;
  if (toolName === 'Grep' && input.pattern) return `grep:${input.pattern}`;
  if (toolName === 'Bash' && input.command) {
    return `bash:${String(input.command).slice(0, 60)}`;
  }
  return null;
}

function handleSdkMessage(msg, agentId, agentRec) {
  const type = msg.type;
  const partial = agentRec ? agentRec.partial : null;

  if (type === 'system') {
    if (msg.subtype === 'init' && agentRec) agentRec.sessionId = msg.session_id || null;
    send('claude:event', { agentId, type: 'system', subtype: msg.subtype, data: msg });
    return;
  }

  if (type === 'stream_event' && msg.event) {
    const ev = msg.event;
    if (ev.type === 'content_block_delta' && ev.delta) {
      if (ev.delta.type === 'text_delta' && ev.delta.text) {
        send('claude:event', { agentId, type: 'text', text: ev.delta.text, streaming: true });
        if (partial) partial.set(ev.index, 'text');
      } else if (ev.delta.type === 'thinking_delta' && ev.delta.thinking) {
        send('claude:event', { agentId, type: 'thinking', text: ev.delta.thinking, streaming: true });
        if (partial) partial.set(ev.index, 'thinking');
      }
    } else if (ev.type === 'message_start') {
      if (partial) partial.clear();
    }
    return;
  }

  if (type === 'assistant' && msg.message) {
    const blocks = msg.message.content || [];
    for (let i = 0; i < blocks.length; i++) {
      const b = blocks[i];
      const alreadyStreamed = partial && partial.get(i) === b.type;
      if (b.type === 'text' && b.text && !alreadyStreamed) {
        send('claude:event', { agentId, type: 'text', text: b.text });
      } else if (b.type === 'thinking' && b.thinking && !alreadyStreamed) {
        send('claude:event', { agentId, type: 'thinking', text: b.thinking });
      } else if (b.type === 'tool_use') {
        const target = extractFileTarget(b.name, b.input);
        send('claude:event', {
          agentId, type: 'tool_use', tool: b.name, input: b.input, target, id: b.id,
        });
      }
    }
    return;
  }

  if (type === 'user' && msg.message) {
    const blocks = msg.message.content || [];
    for (const b of blocks) {
      if (b.type === 'tool_result') {
        const text = typeof b.content === 'string'
          ? b.content
          : Array.isArray(b.content)
            ? b.content.filter(c => c.type === 'text').map(c => c.text).join('\n')
            : '';
        send('claude:event', {
          agentId,
          type: 'tool_result',
          id: b.tool_use_id,
          ok: !b.is_error,
          text: text.slice(0, 800),
        });
      }
    }
    return;
  }

  if (type === 'result') {
    if (partial) partial.clear();
    send('claude:event', {
      agentId,
      type: 'result',
      subtype: msg.subtype,
      sessionId: msg.session_id || (agentRec && agentRec.sessionId) || null,
      cost: msg.total_cost_usd,
      duration: msg.duration_ms,
      turns: msg.num_turns,
    });
  }
}

app.whenReady().then(() => {
  createWindow();
  // Minimal app menu (keeps cmd+c/v/q working on macOS)
  const isMac = process.platform === 'darwin';
  const template = [
    ...(isMac ? [{ role: 'appMenu' }] : []),
    {
      label: 'File',
      submenu: [
        {
          label: 'Open Repo…',
          accelerator: 'CmdOrCtrl+O',
          click: () => send('menu:open-folder'),
        },
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
  if (process.platform !== 'darwin') app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
