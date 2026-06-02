# Tree IDE Graph Engine Hardening

This branch turns the original rewrite proposal into a safer incremental upgrade. The goal is still the same: make large repositories feel less fragile and less blocking without throwing away the behavior that already works.

## What Changed

### AST-Assisted Parsing

Tree-Sitter is now used as an enhancement for JavaScript, TypeScript, TSX, Python, Go, and Rust in the Node server/runtime path. The scanner still runs the existing extractors and merges the AST results into them.

That fallback is intentional. If a grammar is missing, a query misses a syntax form, or a remote install cannot load a native parser, Tree IDE keeps building the graph with the legacy path instead of dropping imports or exports.

Electron currently skips Tree-Sitter by default because native grammar modules must be rebuilt for Electron's Node ABI. This avoids startup crashes from loading a Node-built `tree_sitter_runtime_binding.node` into Electron. Enable it only after an Electron rebuild with `TREE_IDE_ENABLE_ELECTRON_TREE_SITTER=1`.

### Async Repository Walk

The repository walker now uses `fs.promises` for directory traversal and file stats. This removes the old synchronous walk from the scan path.

The hard 5,000-file cap was removed, but "unlimited" is not a useful claim. Large repos are still bounded by scan time, memory, ignored directories, and how many useful source files a user actually wants to visualize.

### Backend Graph Patches

The backend now keeps the last scanned graph in memory. File watcher events schedule a debounced graph rebuild, diff the new graph against the previous one, and emit a `graph:patch` event with changed nodes and edges.

The renderer applies those patches to its cached graph data and reloads the graph from that updated cache. This keeps WebSocket updates smaller while preserving the existing renderer invariants.

### Large-Graph Layout Worker

`renderer/layout.worker.js` is now served by the local HTTP server and used by `Graph` for large graph relayouts. Small and medium graphs keep using the existing canvas-measured layout because it is more precise.

If worker startup or message processing fails, the graph falls back to the synchronous layout path.

## Why This Shape

The original rewrite attempted to replace too much at once and made claims the code did not satisfy. In particular, AST parsing was replacing working TypeScript import detection, `graph:patch` was listened for but never emitted, and the layout worker file was not loaded.

This version favors staged correctness:

- AST parsing improves coverage but cannot erase legacy results.
- Patch sync is produced by the backend, not just declared in the protocol.
- Large layout work can move off the main thread without changing the small-repo rendering path.
- Smoke tests cover TypeScript import edges and backend graph patch emission.

## Verification

Run:

```sh
npm test
```

For an offscreen Electron renderer smoke test:

```sh
npm run test:renderer
```

Current smoke coverage checks:

- TypeScript imports and exports still produce graph nodes, import metadata, and edges.
- Backend graph rebuilds emit `graph:patch` with added nodes and edges.
- The local server serves `layout.worker.js` and broadcasts graph patches over WebSocket.
- The Electron renderer loads a repo, applies a graph patch, and completes large-graph worker layout.

## Remaining Work

This is not a full parser migration yet. More language-specific Tree-Sitter extraction can be added over time, but each new rule should be covered by a fixture before it replaces a heuristic.

The layout worker uses estimated text measurement because browser workers do not have the canvas context used by the precise layout. That is acceptable for large graph responsiveness, but the synchronous layout remains the source of the most accurate small-graph rendering.
