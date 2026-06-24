#!/usr/bin/env node
//
// Merge per-arch `latest-mac-<arch>.yml` files into a single `latest-mac.yml`
// that electron-updater can consume for both Apple Silicon and Intel.
//
// We build each macOS arch on its own native runner (so node-pty / tree-sitter
// natives match the CPU), which means electron-builder emits one update-metadata
// file per arch. electron-updater expects a single `latest-mac.yml` whose
// `files` array lists every downloadable build; it then picks the entry that
// matches the running machine's architecture. This script unions those entries.
//
// Usage: node scripts/merge-mac-latest-yml.js <dir-containing-the-yml-files>
'use strict';

const fs = require('fs');
const path = require('path');
const yaml = require('js-yaml');

const dir = process.argv[2] || '.';
const inputs = fs
  .readdirSync(dir)
  .filter((f) => /^latest-mac-.+\.yml$/.test(f))
  .sort(); // deterministic order (arm64 before x64)

if (inputs.length === 0) {
  console.error(`[merge-yml] no latest-mac-*.yml files found in ${dir}`);
  process.exit(1);
}

let base = null;
const filesByUrl = new Map();
for (const f of inputs) {
  const doc = yaml.load(fs.readFileSync(path.join(dir, f), 'utf8'));
  if (!base) base = doc;
  for (const file of doc.files || []) filesByUrl.set(file.url, file);
}

base.files = [...filesByUrl.values()];
// `path` / `sha512` are legacy single-file fields; point them at the first entry.
if (base.files[0]) {
  base.path = base.files[0].url;
  base.sha512 = base.files[0].sha512;
}

const out = path.join(dir, 'latest-mac.yml');
fs.writeFileSync(out, yaml.dump(base, { lineWidth: -1 }));
console.log(`[merge-yml] wrote ${out} listing ${base.files.length} build(s): ${base.files.map((f) => f.url).join(', ')}`);
