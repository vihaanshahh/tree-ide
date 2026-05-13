#!/usr/bin/env node

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

function usage() {
  console.log(`tree-ide [dir]

Open Tree IDE in a directory.

Examples:
  tree-ide .
  tree-ide /mnt/c/Users/me/project
`);
}

function expandHome(p) {
  if (!p) return p;
  if (p === '~') return process.env.HOME || p;
  if (p.startsWith('~/')) return path.join(process.env.HOME || '', p.slice(2));
  return p;
}

const args = process.argv.slice(2);
if (args.includes('-h') || args.includes('--help')) {
  usage();
  process.exit(0);
}

const requested = args.find(arg => arg && !arg.startsWith('-')) || process.cwd();
const target = path.resolve(process.cwd(), expandHome(requested));

if (!fs.existsSync(target) || !fs.statSync(target).isDirectory()) {
  console.error(`tree-ide: not a directory: ${target}`);
  process.exit(1);
}

let electron;
try {
  electron = require('electron');
} catch {
  console.error('tree-ide: Electron runtime is missing. Reinstall Tree IDE with npm install -g tree-ide.');
  process.exit(1);
}

const appRoot = path.resolve(__dirname, '..');
const child = spawn(electron, [appRoot, '--open', target], {
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
