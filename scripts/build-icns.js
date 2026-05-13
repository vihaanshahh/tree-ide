#!/usr/bin/env node
// Generate build/icon.icns (macOS) and build/icon.png (Linux/Windows fallback)
// from the same sand-rounded-badge directory-tree logo used at runtime.
// No image deps — RGBA buffer → PNG → iconutil.

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execSync } = require('child_process');

const ROOT = path.join(__dirname, '..');
const BUILD = path.join(ROOT, 'build');
const ICONSET = path.join(BUILD, 'icon.iconset');

function buildLogoPngBuffer(size) {
  const W = size, H = size;
  const px = Buffer.alloc(W * H * 4);
  const sand  = [231, 222, 209, 255];
  const black = [0, 0, 0, 255];

  const pad = Math.round(size * 0.055);
  const inner = size - pad * 2;
  const scale = inner / 24;
  const r = Math.round(inner * 0.225);
  const x0 = pad, y0 = pad;
  const x1 = pad + inner, y1 = pad + inner;

  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      let cx = x, cy = y, corner = false;
      if      (x < x0 + r && y < y0 + r)   { cx = x0 + r; cy = y0 + r; corner = true; }
      else if (x >= x1 - r && y < y0 + r)  { cx = x1 - r; cy = y0 + r; corner = true; }
      else if (x < x0 + r && y >= y1 - r)  { cx = x0 + r; cy = y1 - r; corner = true; }
      else if (x >= x1 - r && y >= y1 - r) { cx = x1 - r; cy = y1 - r; corner = true; }
      if (corner) {
        const dx = x - cx, dy = y - cy;
        if (dx*dx + dy*dy > r*r) continue;
      }
      const i = (y * W + x) * 4;
      px[i]=sand[0]; px[i+1]=sand[1]; px[i+2]=sand[2]; px[i+3]=255;
    }
  }

  const fillRect = (lx, ly, lw, lh, c) => {
    const px0 = Math.floor(x0 + lx * scale);
    const py0 = Math.floor(y0 + ly * scale);
    const px1 = Math.floor(x0 + (lx + lw) * scale);
    const py1 = Math.floor(y0 + (ly + lh) * scale);
    for (let y = py0; y < py1; y++) {
      for (let x = px0; x < px1; x++) {
        const i = (y * W + x) * 4;
        if (px[i+3] === 0) continue;
        px[i]=c[0]; px[i+1]=c[1]; px[i+2]=c[2]; px[i+3]=c[3];
      }
    }
  };
  fillRect(3,  4,  3, 3,    black);
  fillRect(10, 4,  3, 3,    black);
  fillRect(10, 11, 3, 3,    black);
  fillRect(17, 11, 3, 3,    black);
  fillRect(17, 17, 3, 3,    black);
  fillRect(4,  7,  1, 11.5, black);
  fillRect(4,  5.5, 6, 1,   black);
  fillRect(4,  12.5, 6, 1,  black);
  fillRect(11, 14, 1, 4.5,  black);
  fillRect(11, 12.5, 6, 1,  black);
  fillRect(11, 18.5, 6, 1,  black);

  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0);
  ihdr.writeUInt32BE(H, 4);
  ihdr[8]  = 8;
  ihdr[9]  = 6;
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const raw = Buffer.alloc(H * (1 + W * 4));
  for (let y = 0; y < H; y++) {
    raw[y * (1 + W * 4)] = 0;
    px.copy(raw, y * (1 + W * 4) + 1, y * W * 4, (y + 1) * W * 4);
  }
  const idat = zlib.deflateSync(raw);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'ascii');
    const body = Buffer.concat([t, data]);
    const crcBuf = Buffer.alloc(4);
    crcBuf.writeUInt32BE(zlib.crc32(body) >>> 0, 0);
    return Buffer.concat([len, body, crcBuf]);
  };
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }

function main() {
  ensureDir(BUILD);
  ensureDir(ICONSET);

  // Apple iconset spec — sizes for each retina pair.
  const SPECS = [
    { name: 'icon_16x16.png',      size: 16 },
    { name: 'icon_16x16@2x.png',   size: 32 },
    { name: 'icon_32x32.png',      size: 32 },
    { name: 'icon_32x32@2x.png',   size: 64 },
    { name: 'icon_128x128.png',    size: 128 },
    { name: 'icon_128x128@2x.png', size: 256 },
    { name: 'icon_256x256.png',    size: 256 },
    { name: 'icon_256x256@2x.png', size: 512 },
    { name: 'icon_512x512.png',    size: 512 },
    { name: 'icon_512x512@2x.png', size: 1024 },
  ];

  for (const s of SPECS) {
    const out = path.join(ICONSET, s.name);
    fs.writeFileSync(out, buildLogoPngBuffer(s.size));
    process.stdout.write(`  wrote ${path.relative(ROOT, out)} (${s.size}px)\n`);
  }

  // 512px PNG as Linux/Windows fallback (electron-builder picks it up).
  const pngFallback = path.join(BUILD, 'icon.png');
  fs.writeFileSync(pngFallback, buildLogoPngBuffer(512));
  process.stdout.write(`  wrote ${path.relative(ROOT, pngFallback)} (512px)\n`);

  // Run macOS's iconutil — only available on darwin.
  if (process.platform === 'darwin') {
    const icns = path.join(BUILD, 'icon.icns');
    execSync(`iconutil -c icns "${ICONSET}" -o "${icns}"`, { stdio: 'inherit' });
    process.stdout.write(`  wrote ${path.relative(ROOT, icns)}\n`);
  } else {
    process.stdout.write(`  skipping icon.icns (iconutil is macOS-only)\n`);
  }
}

main();
