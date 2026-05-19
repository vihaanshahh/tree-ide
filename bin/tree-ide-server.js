#!/usr/bin/env node
//
// tree-ide-server — run Tree IDE as a headless HTTP+WebSocket server,
// no Electron required.
//
// Typical use is on a remote machine you SSH into:
//
//   $ tree-ide --serve [--port 7878] [--host 127.0.0.1] [--open /path/to/repo]
//   tree-ide ready: http://127.0.0.1:7878/?token=...
//
// Then from your laptop:
//
//   $ ssh -L 7878:127.0.0.1:7878 user@host
//   # open the printed URL in a browser.
//
// Binding to 127.0.0.1 is intentional: paired with the per-launch token
// and an Origin check it makes the surface area small while remaining
// trivial to reach over `ssh -L`.

'use strict';

const fs = require('fs');
const path = require('path');

// -----------------------------------------------------------------------
// node-pty ABI shim — only relevant on a machine that ran the desktop
// postinstall (electron-rebuild). That swaps `node-pty/build/Release`
// to the Electron ABI; system Node can't load it. postinstall.js keeps
// a Node-ABI copy in `build/Release-node`. We swap it into place before
// node-pty is first required so the standard loader finds the right
// binary, and (best-effort) restore the Electron build on exit so a
// subsequent `npm start` works without re-running `npm install`.
// On server-only installs (TREE_IDE_SERVER_ONLY=1) the Release dir
// already holds the Node build, no swap happens, no harm done.
// -----------------------------------------------------------------------
const PTY_ROOT = path.resolve(__dirname, '..', 'node_modules', 'node-pty');
const RELEASE_DIR  = path.join(PTY_ROOT, 'build', 'Release');
const NODE_STASH   = path.join(PTY_ROOT, 'build', 'Release-node');
const ELECTRON_STASH = path.join(PTY_ROOT, 'build', 'Release-electron-stash');
let ptySwapped = false;

function safeCopyDir(srcDir, dstDir) {
  try { fs.mkdirSync(dstDir, { recursive: true }); } catch {}
  let copied = false;
  for (const entry of fs.readdirSync(srcDir)) {
    try {
      fs.copyFileSync(path.join(srcDir, entry), path.join(dstDir, entry));
      copied = true;
    } catch {}
  }
  return copied;
}

function swapInNodeBuild() {
  if (!fs.existsSync(NODE_STASH) || !fs.existsSync(RELEASE_DIR)) return;
  // Save the current (Electron) Release dir so we can put it back on exit.
  try { fs.mkdirSync(ELECTRON_STASH, { recursive: true }); } catch {}
  if (safeCopyDir(RELEASE_DIR, ELECTRON_STASH)) {
    safeCopyDir(NODE_STASH, RELEASE_DIR);
    ptySwapped = true;
  }
}

function restoreElectronBuild() {
  if (!ptySwapped) return;
  if (fs.existsSync(ELECTRON_STASH)) {
    safeCopyDir(ELECTRON_STASH, RELEASE_DIR);
  }
}

function usage() {
  console.log(`tree-ide-server — Tree IDE headless server

Usage:
  tree-ide-server [--host HOST] [--port N] [--token TOKEN] [--open DIR]

Options:
  --host HOST    Bind address (default: 127.0.0.1)
  --port N       TCP port (default: 0 = OS-assigned)
  --token T      Override the random per-launch auth token
  --open DIR     Pre-select a repo so the page opens it immediately
  --help         Show this help

Reach it over SSH:
  ssh -L 7878:127.0.0.1:7878 user@host tree-ide-server --port 7878
  # then open the printed URL in your local browser.
`);
}

function parseArgs(argv) {
  const out = { host: '127.0.0.1', port: 0, token: null, open: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-h' || a === '--help') { usage(); process.exit(0); }
    else if (a === '--host') out.host = argv[++i];
    else if (a === '--port') out.port = parseInt(argv[++i], 10) || 0;
    else if (a === '--token') out.token = argv[++i];
    else if (a === '--open' || a === '--repo' || a === '--folder') out.open = argv[++i];
    else if (a && a.startsWith('--host=')) out.host = a.slice('--host='.length);
    else if (a && a.startsWith('--port=')) out.port = parseInt(a.slice('--port='.length), 10) || 0;
    else if (a && a.startsWith('--token=')) out.token = a.slice('--token='.length);
    else if (a && a.startsWith('--open=')) out.open = a.slice('--open='.length);
    else if (a && !a.startsWith('-') && !out.open) out.open = a;
    else if (a) console.error(`tree-ide-server: ignoring unknown argument: ${a}`);
  }
  return out;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));

  // Signal to Backend (e.g. launchAgent) that this process can't pop a
  // desktop terminal — there's no display.
  process.env.TREE_IDE_HEADLESS = '1';

  // Make sure node-pty resolves to the system-Node binary before any
  // module loads it. No-op on fresh server-only installs.
  swapInNodeBuild();

  const { Backend, normalizeOpenRoot } = require('../src/backend');
  const { startServer } = require('../src/server');
  const pkg = require('../package.json');

  const startupRoot = args.open ? normalizeOpenRoot(args.open) : null;
  if (args.open && !startupRoot) {
    console.error(`tree-ide-server: --open path not found: ${args.open}`);
    process.exit(1);
  }

  const backend = new Backend({ startupRoot, pkg, updateRepo: 'vihaanshahh/tree-ide' });
  let handle;
  try {
    handle = await startServer({
      backend,
      host: args.host,
      port: args.port,
      token: args.token || undefined,
    });
  } catch (e) {
    console.error(`tree-ide-server: failed to start: ${e.message}`);
    process.exit(1);
  }

  const exposed = args.host === '0.0.0.0' ? `http://<this-host>:${handle.port}/?token=${handle.token}` : handle.url;
  console.log(`tree-ide ready: ${exposed}`);
  if (args.host !== '0.0.0.0' && args.host !== '127.0.0.1' && args.host !== 'localhost') {
    console.log(`Bound to ${args.host}:${handle.port}.`);
  } else if (args.host === '0.0.0.0') {
    console.log(`Listening on all interfaces — protect this with a firewall or stick to SSH tunneling.`);
  } else {
    console.log(`SSH from your laptop:  ssh -L ${handle.port}:127.0.0.1:${handle.port} <user>@<host>`);
  }
  if (startupRoot) console.log(`Open repo on connect: ${startupRoot}`);

  const shutdown = async (signal) => {
    console.log(`\ntree-ide-server: ${signal} received, shutting down…`);
    try { backend.shutdown(); } catch {}
    try { await handle.close(); } catch {}
    try { restoreElectronBuild(); } catch {}
    process.exit(0);
  };
  process.on('SIGINT',  () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('exit',    () => { try { restoreElectronBuild(); } catch {} });
}

main().catch((e) => {
  console.error('tree-ide-server: fatal:', e && e.stack || e);
  process.exit(1);
});
