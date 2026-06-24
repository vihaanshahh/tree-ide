// Tree IDE local server.
//
// One HTTP server, bound to 127.0.0.1 by default, that:
//   1. Serves the renderer (renderer/*) and the handful of npm assets it
//      needs (xterm + fit addon) under fixed `/vendor/...` routes.
//   2. Upgrades `/ws` connections to WebSocket, gated by a one-time token
//      passed as a `?token=` query parameter on the URL.
//   3. Routes each JSON-RPC message to a Backend method and pushes
//      backend events back to every connected client.
//
// Same code runs locally inside Electron's main process (loaded into a
// BrowserWindow) and standalone via `tree-ide --serve` on a remote
// machine that the user reaches over an SSH tunnel.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const url = require('url');
const { WebSocketServer } = require('ws');

const ROOT = path.resolve(__dirname, '..');

const STATIC_MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.mjs':  'application/javascript; charset=utf-8',
  '.cjs':  'application/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.json': 'application/json; charset=utf-8',
  '.ico':  'image/x-icon',
};

// Whitelisted server-relative paths inside renderer/. Anything outside this
// allow-list 404s — the server should not double as a generic file server.
const RENDERER_FILES = new Set([
  'index.html',
  'app.js',
  'graph.js',
  'layout.worker.js',
  'styles.css',
  'logo.svg',
  'transport.js',
]);

// Vendor mappings — bundled npm assets needed by the renderer.
const VENDOR = {
  'xterm.js':       'node_modules/@xterm/xterm/lib/xterm.js',
  'xterm.css':      'node_modules/@xterm/xterm/css/xterm.css',
  'addon-fit.js':   'node_modules/@xterm/addon-fit/lib/addon-fit.js',
};

function serveFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain' });
      res.end('Not found');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': STATIC_MIME[ext] || 'application/octet-stream',
      // Aggressive caching is fine since each tree-ide build ships its
      // own renderer assets; mismatched versions never load against
      // this server.
      'Cache-Control': 'no-cache',
    });
    res.end(data);
  });
}

// Token authoritative gate. We don't gate static HTML/CSS/JS (those leak
// no secrets and the renderer needs to load before it can present the
// token), but the WebSocket upgrade requires a valid token, and an
// Origin check rejects cross-site WS attempts in case someone's browser
// happens to be sitting on a malicious page that knows our port.
function validToken(provided, expected) {
  if (!provided || !expected) return false;
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(expected));
}

function safeSend(ws, payload) {
  if (ws.readyState !== 1) return;
  try { ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload)); }
  catch {}
}

// All backend RPC methods exposed over WS. Keys match the names the
// renderer uses (matches the surface preload.cjs used to expose).
function buildRouter(backend) {
  return {
    openFolder:       ()                 => backend.openFolder(),
    scanRepo:         (root)             => backend.scanRepo(root),
    readFile:         (rel, opts)        => backend.readFile(rel, opts),
    writeFile:        (rel, content)     => backend.writeFile(rel, content),
    detectProviders:  ()                 => backend.detectProviders(),
    getStartupRoot:   ()                 => backend.getStartupRoot(),
    watchFs:          (root)             => backend.watchFs(root),

    ptySpawn:         (payload)          => backend.ptySpawn(payload),
    // ptyWrite + ptyResize are fire-and-forget — the renderer sends them
    // without an id so we don't bother reading a return value.
    ptyWrite:         (agentId, data)    => { backend.ptyWrite(agentId, data); },
    ptyResize:        (agentId, c, r)    => { backend.ptyResize(agentId, c, r); },
    ptyKill:          (agentId)          => backend.ptyKill(agentId),
    launchAgent:      (payload)          => backend.launchAgent(payload),
    getUsage:         (payload)          => backend.getUsage(payload),
    refreshUsage:     (payload)          => backend.refreshUsage(payload),

    checkUpdate:      ()                 => backend.checkUpdate(),
    relaunchApp:      ()                 => backend.relaunchApp(),
    updateAndRelaunch:()                 => backend.updateAndRelaunch(),
  };
}

// Events the backend fires that get pushed to every connected client.
const BROADCAST_EVENTS = [
  'pty:data', 'pty:exit',
  'fs:event',
  'usage:update',
  'graph:patch',
  'repo:scan-progress',
  'app:open-root',
  'app:update-progress',
  'menu:open-folder',
  'menu:open-ssh',
];

async function startServer({ backend, host = '127.0.0.1', port = 0, token = null } = {}) {
  const sessionToken = token || crypto.randomBytes(24).toString('base64url');
  const router = buildRouter(backend);

  const httpServer = http.createServer((req, res) => {
    const parsed = url.parse(req.url || '/', true);
    const pathname = parsed.pathname || '/';

    // Health probe so users / scripts can confirm the server is up
    // without speaking the protocol.
    if (pathname === '/healthz') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok\n');
      return;
    }

    if (pathname === '/' || pathname === '/index.html') {
      // The renderer needs the token to open its WebSocket. We inject it
      // into a <script> in the served HTML so a fresh page load — even
      // one a human pasted into a browser — knows how to authenticate.
      fs.readFile(path.join(ROOT, 'renderer', 'index.html'), 'utf8', (err, html) => {
        if (err) {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Failed to read index.html: ' + err.message);
          return;
        }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' });
        res.end(html);
      });
      return;
    }

    // Renderer-relative files (e.g. /app.js, /styles.css, /transport.js).
    const rel = pathname.replace(/^\//, '');
    if (RENDERER_FILES.has(rel)) {
      serveFile(res, path.join(ROOT, 'renderer', rel));
      return;
    }

    // Vendor (xterm + addon).
    if (pathname.startsWith('/vendor/')) {
      const key = pathname.slice('/vendor/'.length);
      const target = VENDOR[key];
      if (target) {
        serveFile(res, path.join(ROOT, target));
        return;
      }
    }

    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not found');
  });

  // WebSocket server with manual upgrade handling so we can token-gate.
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on('upgrade', (req, socket, head) => {
    const parsed = url.parse(req.url || '/', true);
    if (parsed.pathname !== '/ws') {
      socket.destroy();
      return;
    }
    const provided = (parsed.query && parsed.query.token) || '';
    if (!validToken(String(provided), sessionToken)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    // Same-origin guard. Allow no-origin (e.g. node ws clients) and any
    // Origin whose host matches the bind host. For 127.0.0.1 binds
    // (the default) this also tolerates the user pointing the page at
    // http://localhost:PORT instead.
    const origin = req.headers.origin;
    if (origin) {
      try {
        const ohost = new URL(origin).hostname;
        const allowed = host === '0.0.0.0' || ohost === host || ohost === 'localhost' || ohost === '127.0.0.1';
        if (!allowed) {
          socket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
          socket.destroy();
          return;
        }
      } catch {
        socket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
        socket.destroy();
        return;
      }
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  wss.on('connection', (ws) => {
    // Subscribe this client to every backend broadcast. The unsubscribe
    // fns run on close so we don't pile up dead listeners across reloads.
    const unsubs = BROADCAST_EVENTS.map((evt) => {
      const fn = (data) => safeSend(ws, { event: evt, data });
      backend.events.on(evt, fn);
      return () => backend.events.off(evt, fn);
    });

    ws.on('message', async (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); }
      catch { return; }
      const { id, method, params } = msg || {};
      const handler = router[method];
      if (!handler) {
        if (id != null) safeSend(ws, { id, error: `Unknown method: ${method}` });
        return;
      }
      try {
        const out = await handler.apply(null, Array.isArray(params) ? params : [params]);
        if (id != null) safeSend(ws, { id, result: out });
      } catch (e) {
        if (id != null) safeSend(ws, { id, error: e && e.message ? e.message : String(e) });
      }
    });

    ws.on('close', () => {
      for (const u of unsubs) { try { u(); } catch {} }
    });
  });

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, host, () => {
      httpServer.off('error', reject);
      resolve();
    });
  });

  const addr = httpServer.address();
  const actualPort = typeof addr === 'object' && addr ? addr.port : port;
  const urlBase = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${actualPort}`;

  return {
    server: httpServer,
    wss,
    host,
    port: actualPort,
    token: sessionToken,
    url: `${urlBase}/?token=${sessionToken}`,
    close: () => new Promise((resolve) => {
      try {
        for (const client of wss.clients) try { client.terminate(); } catch {}
        wss.close(() => httpServer.close(() => resolve()));
      } catch {
        try { httpServer.close(() => resolve()); } catch { resolve(); }
      }
    }),
  };
}

module.exports = { startServer };
