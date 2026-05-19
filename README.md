# Tree IDE

A graph-first IDE. You don't read code — you watch the AI navigate it.

Open any repo. Tree IDE walks the filesystem, parses imports, and renders the
codebase as a live force-directed map. A central **AI** node sits at the center.
Ask it anything — every file Claude reads or edits draws a glowing line from the
AI to that file in real time.

## Run

```bash
npm install
npm start
```

Tree IDE uses your Claude **subscription** (Pro / Max) via the `claude` CLI — no
API key needed. If you haven't already:

```bash
npm i -g @anthropic-ai/claude-code
claude   # sign in once; credentials are reused after that
```

Then **Open Repo** (or `⌘O`) and pick any folder.

## What you get

- **Live graph** of files, imports, and external deps. Drag, zoom, pan.
- **Click a node** to focus it — Claude will receive that file as context.
- **Right-click any node** for one-click prompts (explain, audit, refactor).
- **Ask AI** mode is read-only. Switch to **Edit** mode to let Claude modify files.
- **Activity log** records every tool call. **File** tab shows source on demand.

## Open over SSH

Tree IDE can run as a headless HTTP + WebSocket server on a remote Linux
box. You reach the UI from any browser on your laptop over an SSH tunnel —
same UI as the desktop app, but the filesystem, scanner, and PTYs all live
on the remote.

On the remote (one-time):

```bash
curl -fsSL https://raw.githubusercontent.com/vihaanshahh/tree-ide/main/install.sh | sh
# Headless installs are auto-detected (no DISPLAY) and skip the Electron rebuild.
```

To use:

```bash
# On the remote, in a shell on the box:
tree-ide --serve --port 7878 /path/to/repo
# → tree-ide ready: http://127.0.0.1:7878/?token=...

# On your laptop, in a separate terminal:
ssh -L 7878:127.0.0.1:7878 user@host

# Then paste the printed URL into a browser. That's it.
```

Notes:

- The server binds to `127.0.0.1` by default and protects the WebSocket
  with a per-launch random token, so the surface area is the SSH tunnel
  plus a token check.
- Pass `--host 0.0.0.0` only if you've got a firewall in front of it —
  the token is the only thing standing between an open port and a shell.
- xterm.js, the force-directed graph, file watcher, and agent grid all
  work identically in the browser. The Electron-only bits (native folder
  picker, in-app self-update) just hide themselves in serve mode.

## Architecture

- `main.js` — Electron main process. Boots the in-process HTTP+WS server
  and points the BrowserWindow at it.
- `src/backend.js` — provider-agnostic core: scan, file read, PTY agents,
  filesystem watcher, provider detection. Shared by Electron and headless modes.
- `src/server.js` — HTTP server + WebSocket bridge. Serves the renderer
  and exposes every backend method over a tiny JSON-RPC protocol.
- `src/scanner.js` — language-agnostic import extractor + walker.
- `bin/tree-ide-server.js` — standalone CLI for serve mode (no Electron).
- `renderer/transport.js` — WebSocket client; the renderer talks the same
  protocol whether it's in Electron or in a remote browser.
- `renderer/graph.js` — custom canvas force-directed graph engine, no deps.
- `renderer/app.js` — UI wiring + agent stream → graph animations.

## Notes

- Works on top of any repo — your repo is never modified unless you switch to Edit mode.
- The graph engine is hand-rolled on canvas (no D3/Cytoscape/etc.), so it stays
  fast even on 1000+ file repos and works fully offline.
