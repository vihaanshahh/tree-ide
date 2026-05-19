// renderer/transport.js — browser-side WebSocket client.
//
// Exposes window.tree with the same surface preload.cjs used to provide,
// so app.js works unchanged in both:
//   - Electron desktop mode: page is loaded from http://127.0.0.1:N/?token=…
//     served by the embedded backend; the BrowserWindow still loads
//     preload.cjs which adds a few Electron-only natives at
//     window.electronNative (folder picker).
//   - Headless serve mode: same HTTP page reached over an SSH tunnel,
//     no Electron, no preload; the browser fallbacks kick in.
//
// Wire protocol is intentionally tiny:
//   client → server: { id, method, params }     (request)
//   client → server: { method, params }         (fire-and-forget; no id)
//   server → client: { id, result|error }       (response)
//   server → client: { event, data }            (broadcast)

(function () {
  // Token comes from either window.__TREE_TOKEN__ (injected by the server
  // into index.html when the request had ?token=…) or, as a last
  // resort, the current URL's query string.
  function getToken() {
    if (typeof window.__TREE_TOKEN__ === 'string' && window.__TREE_TOKEN__) {
      return window.__TREE_TOKEN__;
    }
    try {
      const q = new URL(window.location.href).searchParams;
      return q.get('token') || '';
    } catch { return ''; }
  }

  const TOKEN = getToken();
  const WS_PROTO = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const WS_URL = `${WS_PROTO}//${window.location.host}/ws?token=${encodeURIComponent(TOKEN)}`;

  let ws = null;
  let nextId = 1;
  const pending = new Map();           // id → {resolve, reject}
  const eventListeners = new Map();    // eventName → Set<fn>
  // Messages queued while the socket is (re)connecting. Once `open`
  // fires we flush them in order so a method called during the brief
  // gap doesn't disappear.
  const sendQueue = [];
  let connectedOnce = false;
  let reconnectDelay = 250;

  function emit(name, data) {
    const set = eventListeners.get(name);
    if (!set) return;
    for (const fn of set) {
      try { fn(data); } catch (e) { console.error(`[tree] listener for ${name} threw:`, e); }
    }
  }

  function on(name, fn) {
    let set = eventListeners.get(name);
    if (!set) { set = new Set(); eventListeners.set(name, set); }
    set.add(fn);
    return () => set.delete(fn);
  }

  function rawSend(payload) {
    const s = JSON.stringify(payload);
    if (ws && ws.readyState === 1) {
      ws.send(s);
    } else {
      sendQueue.push(s);
    }
  }

  function request(method, params) {
    const id = nextId++;
    return new Promise((resolve, reject) => {
      pending.set(id, { resolve, reject });
      rawSend({ id, method, params });
    });
  }

  function notify(method, params) {
    rawSend({ method, params });
  }

  function connect() {
    ws = new WebSocket(WS_URL);
    ws.onopen = () => {
      connectedOnce = true;
      reconnectDelay = 250;
      while (sendQueue.length) {
        try { ws.send(sendQueue.shift()); } catch { break; }
      }
      emit('__transport_open__', null);
    };
    ws.onmessage = (e) => {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }
      if (msg.event) {
        emit(msg.event, msg.data);
        return;
      }
      if (msg.id != null) {
        const slot = pending.get(msg.id);
        if (!slot) return;
        pending.delete(msg.id);
        if (msg.error) slot.reject(new Error(msg.error));
        else slot.resolve(msg.result);
      }
    };
    ws.onclose = () => {
      // Fail in-flight requests so callers don't hang forever on a
      // server that's gone away. Reconnect with exponential backoff
      // capped at a few seconds — a remote box dropping a TCP idle
      // connection shouldn't take down the whole app.
      for (const [, slot] of pending) slot.reject(new Error('WebSocket closed'));
      pending.clear();
      const delay = reconnectDelay;
      reconnectDelay = Math.min(reconnectDelay * 2, 4000);
      setTimeout(connect, delay);
      emit('__transport_close__', null);
    };
    ws.onerror = () => {
      // onclose will fire next and handle reconnect; just log so the
      // first failure is visible in DevTools.
      if (!connectedOnce) console.warn('[tree] initial WebSocket connect failed; will retry');
    };
  }

  connect();

  // ----------------------------------------------------------------
  // window.tree — same surface preload.cjs exposed. Methods that
  // existed before keep their exact names and signatures.
  // ----------------------------------------------------------------
  const native = window.electronNative || null;

  async function openFolder() {
    // Electron preload provides a native folder picker; in pure browser
    // mode the renderer falls back to a path-input prompt.
    if (native && typeof native.pickFolder === 'function') {
      try { return await native.pickFolder(); } catch {}
    }
    const fromServer = await request('openFolder', []);
    if (fromServer) return fromServer;
    const typed = window.prompt(
      'Enter an absolute path on this host:\n(no native picker available in browser mode)'
    );
    return typed ? typed.trim() : null;
  }

  window.tree = {
    openFolder,
    scanRepo:        (root) => request('scanRepo', [root]),
    readFile:        (rel)  => request('readFile', [rel]),
    detectProviders: ()     => request('detectProviders', []),
    getStartupRoot:  ()     => request('getStartupRoot', []),
    watchFs:         (root) => request('watchFs', [root]),

    ptySpawn:        (payload)            => request('ptySpawn', [payload]),
    ptyWrite:        (agentId, data)      => notify('ptyWrite',  [agentId, data]),
    ptyResize:       (agentId, cols, rows) => notify('ptyResize', [agentId, cols, rows]),
    ptyKill:         (agentId)            => request('ptyKill', [agentId]),
    launchAgent:     (payload)            => request('launchAgent', [payload]),

    checkUpdate:        ()                => request('checkUpdate', []),
    relaunchApp:        ()                => request('relaunchApp', []),
    updateAndRelaunch:  ()                => request('updateAndRelaunch', []),

    onPtyData:        (cb) => on('pty:data', cb),
    onPtyExit:        (cb) => on('pty:exit', cb),
    onFsEvent:        (cb) => on('fs:event', cb),
    onScanProgress:   (cb) => on('repo:scan-progress', cb),
    onOpenRoot:       (cb) => on('app:open-root', cb),
    onUpdateProgress: (cb) => on('app:update-progress', cb),
    onMenuOpenFolder: (cb) => on('menu:open-folder', cb),
    onMenuOpenSsh:    (cb) => on('menu:open-ssh', cb),

    // Diagnostic-only — lets the page know whether it's wired up.
    onTransportOpen:  (cb) => on('__transport_open__', cb),
    onTransportClose: (cb) => on('__transport_close__', cb),
  };
})();
