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

## Architecture

- `main.js` — Electron main, repo scanner, Claude Agent SDK runner.
- `src/scanner.js` — language-agnostic import extractor + walker.
- `renderer/graph.js` — custom canvas force-directed graph engine, no deps.
- `renderer/app.js` — UI wiring + Claude event stream → graph animations.

## Notes

- Works on top of any repo — your repo is never modified unless you switch to Edit mode.
- The graph engine is hand-rolled on canvas (no D3/Cytoscape/etc.), so it stays
  fast even on 1000+ file repos and works fully offline.
