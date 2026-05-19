#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function usage() {
  console.log(`tree-ide [dir] [options]

Open Tree IDE in a directory, or run it as a headless server you reach
over SSH.

Examples:
  tree-ide .
  tree-ide /mnt/c/Users/me/project
  tree-ide --serve --port 7878             # headless, browser-accessible
  ssh -L 7878:127.0.0.1:7878 user@host \\
      tree-ide --serve --port 7878 .       # remote box; open URL locally

Options:
  --serve              Run a headless HTTP+WebSocket server (no Electron).
                       Useful on Linux remotes you SSH into.
  --port N             Port for --serve (default: 0 = OS-assigned).
  --host HOST          Bind address for --serve (default: 127.0.0.1).
  --token T            Override the random session token (--serve).
  --open DIR           Pre-select a repo (both modes).
  -h, --help           Show this help.
`);
}

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return process.env.HOME || p;
  if (p.startsWith('~/')) return path.join(process.env.HOME || '', p.slice(2));
  return p;
}

const argv = process.argv.slice(2);
if (argv.includes('-h') || argv.includes('--help')) {
  usage();
  process.exit(0);
}

// --serve delegates entirely to tree-ide-server. Pass remaining args
// through untouched so `tree-ide --serve --port N /path` works.
if (argv.includes('--serve')) {
  const serverArgs = argv.filter((a) => a !== '--serve');
  const serverEntry = path.resolve(__dirname, 'tree-ide-server.js');
  const child = spawn(process.execPath, [serverEntry, ...serverArgs], {
    stdio: 'inherit',
    env: process.env,
  });
  child.on('exit', (code, signal) => {
    if (signal) process.kill(process.pid, signal);
    process.exit(code == null ? 0 : code);
  });
  child.on('error', (err) => {
    console.error(`tree-ide: failed to launch server: ${err.message}`);
    process.exit(1);
  });
  return;
}

// Desktop mode (Electron). The positional arg is the directory to open.
let requested = null;
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  if (a === '--open' || a === '--repo' || a === '--folder') { requested = argv[++i]; }
  else if (a && a.startsWith('--open=')) requested = a.slice('--open='.length);
  else if (a && !a.startsWith('-') && !requested) requested = a;
}
if (!requested) requested = process.cwd();
const target = path.resolve(process.cwd(), expandHome(requested));

if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
  console.error(`tree-ide: not a directory: ${target}`);
  process.exit(1);
}

let electron;
try {
  electron = require('electron');
} catch {
  console.error('tree-ide: Electron runtime is missing. If this is a server, run `tree-ide --serve` instead, or reinstall with `npm install`.');
  process.exit(1);
}

const appRoot = path.resolve(__dirname, '..');
const child = spawn(electron, [
  '--js-flags=--max-old-space-size=4096',
  appRoot,
  '--open', target,
], {
  stdio: 'inherit',
  env: process.env,
});

child.on('error', (err) => {
  console.error(`tree-ide: failed to launch Electron: ${err.message}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code == null ? 0 : code);
});
