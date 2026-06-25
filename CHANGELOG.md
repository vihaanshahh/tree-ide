# Changelog

All notable changes to Tree IDE.

## [0.4.4] - 2026-06-25

### Fixed

- macOS builds are now code-signed with a Developer ID and notarized, so the
  in-app "Update & restart" auto-update works on macOS (Squirrel.Mac rejects
  unsigned updates) and downloaded DMGs open without a Gatekeeper warning.
- CI builds the Intel (x64) mac on the `macos-15-intel` runner; the old
  `macos-13` runner was retired by GitHub in Dec 2025.

## [0.4.2] - 2026-06-24

### Added

- **Multi-window.** Open multiple windows, each mapping a different repo on the
  same machine. Every window runs its own backend + embedded server, so repos
  stay fully isolated (separate file tree, terminals, and watchers). New menu
  items: File → New Window (Cmd/Ctrl+N) and Open Repo in New Window…
  (Cmd/Ctrl+Shift+N). A second `tree-ide --open <repo>` invocation now opens a
  new window for that repo instead of focusing the existing one.

## [0.3.1] - 2026-06-01

### Added

- AST-assisted import/export extraction for JS, TS, TSX, Python, Go, and Rust,
  with smoke coverage across the graph engine and Electron renderer.
- Incremental graph patch broadcasts for filesystem changes, so the renderer can
  update nodes and edges without a full reload.
- Off-main-thread layout for large graphs, with a synchronous fallback.

### Fixed

- Avoid loading Tree-Sitter native bindings inside Electron unless explicitly
  enabled, preventing the native crash seen during renderer smoke tests.
- Preserve legacy regex edges when AST analysis is available, so the parser path
  cannot erase existing graph relationships.
- Connect non-code relationships such as HTML stylesheets/scripts, CSS imports,
  Sass partials, and same-name companion CSS modules.
- Serve the layout worker under the app's CSP-safe asset path.

## [0.3.0] - 2026-05-19

### Added

- **Remote SSH mode.** `tree-ide --serve` runs the IDE backend headless on
  any Linux host; reach the same UI in any browser over an SSH tunnel.
  Headless installs are auto-detected by `install.sh` (no `DISPLAY` →
  skip the Electron rebuild). [README → Open over SSH]
- **In-app "Connect Remote" picker.** File → Connect Remote… (⌘⇧R) or
  the Remote button in the titlebar. Enter `user@host`, optional remote
  path, optional identity file; Electron spawns
  `ssh -L … bash -lc 'tree-ide --serve …'` for you, parses the URL from
  stdout, and navigates the window to your remote workspace. Key-based
  SSH auth required.
- **Agent rename.** Double-click an agent's name to rename inline.
  Enter saves, Esc cancels, blur saves.
- **Visible error toasts.** New `window.treeNotify` surfaces wired into
  the WebSocket transport (lost-connection / reconnected), the SSH
  picker (failures, tunnel-died), and the graph (resize / render
  errors). No more silent freezes.

### Changed

- **Graph layout — module-based map.** The diagram is no longer four
  kind-buckets side-by-side that grew sideways without bound. Each
  top-level folder becomes a **panel**; panels stack into **tier rows**
  by longest-path through the import DAG (entry points on top, leaves
  on the bottom). Within a tier, modules are barycenter-ordered so
  cross-tier edges trend vertically instead of crisscrossing. Files
  inside a panel still group by kind. The result reads as a real
  architecture map.
- Electron desktop mode now serves the renderer over its own
  in-process HTTP + WebSocket server (loopback, per-launch random
  token). Same codepath used by `--serve`.

### Fixed

- **Fullscreen-induced renderer crashes.** Window resize is now
  rAF-coalesced (one relayout per animation frame, no matter how many
  resize events fire during a macOS fullscreen transition); the graph's
  `frame()` and canvas resize are wrapped in try/catch so a transient
  bad rect can't take down the loop; main captures
  `render-process-gone` so the next failure leaves a breadcrumb.

### Internal

- New module split: `src/backend.js` (provider-agnostic core), `src/server.js`
  (HTTP + WebSocket bridge), `renderer/transport.js` (browser-side WS
  client). Electron is now a thin wrapper around the same server.
- New CLI: `bin/tree-ide-server.js`; `--serve` flag added to
  `bin/tree-ide.js` for spawn-via-tree-ide.
- New `scripts/postinstall.js` handles the node-pty Electron/Node-ABI
  dual-build (stashes the system-Node binary so `--serve` can swap it
  in at runtime; `TREE_IDE_SERVER_ONLY=1` skips the Electron rebuild
  entirely for headless installs).

## [0.2.3] - 2026-05-14

UI: show every node + grow sideways, smarter labels, in-app updater.
Linux/WSL: render reliably out of the box. `install.sh` fixes for Node ≥ 18.

## [0.2.0] - 2026-05-12

Embedded agents, live filesystem reactivity, branded titlebar.

[0.3.1]: https://github.com/vihaanshahh/tree-ide/releases/tag/v0.3.1
[0.3.0]: https://github.com/vihaanshahh/tree-ide/releases/tag/v0.3.0
[0.2.3]: https://github.com/vihaanshahh/tree-ide/releases/tag/v0.2.3
[0.2.0]: https://github.com/vihaanshahh/tree-ide/releases/tag/v0.2.0
