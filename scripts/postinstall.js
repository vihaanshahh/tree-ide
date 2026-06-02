#!/usr/bin/env node
//
// Postinstall hook.
//
// node-pty is a native module. After `npm install` it's built against
// the system Node ABI — exactly what `tree-ide --serve` (plain Node)
// needs. The Electron desktop app, however, uses Electron's own V8
// ABI, so it requires a rebuild via `electron-rebuild`.
//
// Default behavior (laptops, dev machines): rebuild for Electron so
// `npm start` works. The system-Node-built copy is kept aside under
// node_modules/node-pty/build/Release-node so that bin/tree-ide-server
// can load it on the same machine without re-installing.
//
// Server-only installs (TREE_IDE_SERVER_ONLY=1, set by install.sh on
// hosts with no display): skip the Electron rebuild entirely. The Node
// build that npm just produced is all we need.

'use strict';

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

if (process.env.TREE_IDE_SERVER_ONLY === '1') {
  console.log('[tree-ide] TREE_IDE_SERVER_ONLY=1 — skipping electron-rebuild (server-only install).');
  process.exit(0);
}

const ptyRoot   = path.resolve(__dirname, '..', 'node_modules', 'node-pty');
const buildDir  = path.join(ptyRoot, 'build');
const releaseDir = path.join(buildDir, 'Release');
// Stash OUTSIDE build/ so electron-rebuild's `node-gyp clean` doesn't
// wipe it before we get to restore it.
const stagingDir = path.join(ptyRoot, '.tree-ide-node-abi');
const finalStash = path.join(buildDir, 'Release-node');
const ptyNode = path.join(releaseDir, 'pty.node');

function copyDirShallow(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (!entry.isFile()) continue;
    try { fs.copyFileSync(path.join(src, entry.name), path.join(dst, entry.name)); }
    catch {}
  }
}

let stashed = false;
if (fs.existsSync(ptyNode)) {
  try {
    fs.rmSync(stagingDir, { recursive: true, force: true });
    copyDirShallow(releaseDir, stagingDir);
    stashed = true;
    console.log('[tree-ide] stashed system-Node node-pty build for serve-mode use.');
  } catch (e) {
    console.warn(`[tree-ide] could not stash Node build of node-pty: ${e.message}`);
  }
}

const result = spawnSync('npx', ['--no-install', 'electron-rebuild', '-f', '-o', 'node-pty'], {
  stdio: 'inherit',
  shell: true,
  env: process.env,
});

if (result.status !== 0) {
  console.warn('[tree-ide] electron-rebuild failed; desktop mode (`npm start`) may not work, but `tree-ide --serve` should still run.');
  // Restore the Node build into Release (so node-pty is at least loadable)
  // and exit non-fatally.
  if (stashed) {
    try { copyDirShallow(stagingDir, releaseDir); } catch {}
  }
  try { fs.rmSync(stagingDir, { recursive: true, force: true }); } catch {}
  process.exit(0);
}

// Move the stashed Node build back to its standard location under build/
// so bin/tree-ide-server.js can find it.
if (stashed) {
  try {
    fs.rmSync(finalStash, { recursive: true, force: true });
    copyDirShallow(stagingDir, finalStash);
    fs.rmSync(stagingDir, { recursive: true, force: true });
    console.log('[tree-ide] kept system-Node node-pty build at build/Release-node for serve mode.');
  } catch (e) {
    console.warn(`[tree-ide] could not relocate Node build: ${e.message}`);
  }
}
