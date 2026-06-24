#!/usr/bin/env node
/**
 * PNG → Windows-tray-compatible .ico (v2.3).
 *
 *   node scripts/build/make-tray-ico.mjs <input.png> <output.ico>
 *
 * Why this exists separately from make-ico.mjs: that one writes PNG-compressed
 * ICO entries (fine for Inno Setup + browser favicons). The system-tray icon
 * loader (fyne/systray → Win32) can NOT load PNG-compressed entries — it
 * needs classic BMP/DIB. Loading logo.ico in the tray failed with "unable to
 * load icon from file". This encoder rasterizes the source at tray sizes and
 * writes uncompressed 32-bit BMP/DIB entries, which Win32 loads reliably.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright-core';
import { resolveBrowser } from '../browser-launcher.mjs';

const SIZES = [16, 24, 32, 48, 64];

const [, , inputPath, outputPath] = process.argv;
if (!inputPath || !outputPath) {
  console.error('Usage: node scripts/build/make-tray-ico.mjs <input.png> <output.ico>');
  process.exit(2);
}

const srcB64 = fs.readFileSync(inputPath).toString('base64');

const browser = await resolveBrowser();
console.log(`Rasterizing with ${browser.label}…`);
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amm-tray-ico-'));
const ctx = await chromium.launchPersistentContext(profileDir, { ...browser.launchOptions, headless: true });

let pixels;
try {
  const page = ctx.pages()[0] || await ctx.newPage();
  pixels = await page.evaluate(async ({ b64, sizes }) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const out = {};
    for (const size of sizes) {
      const c = document.createElement('canvas');
      c.width = size; c.height = size;
      const cx = c.getContext('2d');
      cx.imageSmoothingEnabled = true;
      cx.imageSmoothingQuality = 'high';
      cx.drawImage(img, 0, 0, size, size);
      out[size] = Array.from(cx.getImageData(0, 0, size, size).data); // RGBA, top-down
    }
    return out;
  }, { b64: srcB64, sizes: SIZES });
} finally {
  await ctx.close().catch(() => {});
  fs.rmSync(profileDir, { recursive: true, force: true });
}

// One 32-bit BMP/DIB ICO image: BITMAPINFOHEADER (height doubled for the AND
// mask) + bottom-up BGRA pixels + a zeroed 1bpp AND mask (alpha does the work).
function bmpEntry(rgba, w, h) {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0);   // biSize
  header.writeInt32LE(w, 4);     // biWidth
  header.writeInt32LE(h * 2, 8); // biHeight (color rows + mask rows)
  header.writeUInt16LE(1, 12);   // biPlanes
  header.writeUInt16LE(32, 14);  // biBitCount
  header.writeUInt32LE(0, 16);   // biCompression = BI_RGB
  const color = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++) {
    const dstY = h - 1 - y; // bottom-up
    for (let x = 0; x < w; x++) {
      const s = (y * w + x) * 4;
      const d = (dstY * w + x) * 4;
      color[d] = rgba[s + 2];     // B
      color[d + 1] = rgba[s + 1]; // G
      color[d + 2] = rgba[s];     // R
      color[d + 3] = rgba[s + 3]; // A
    }
  }
  const maskRowBytes = Math.ceil(w / 32) * 4;
  const mask = Buffer.alloc(maskRowBytes * h); // zeros = fully opaque; alpha handles transparency
  return Buffer.concat([header, color, mask]);
}

const blobs = SIZES.map(s => bmpEntry(Buffer.from(pixels[s]), s, s));
const dir = Buffer.alloc(6);
dir.writeUInt16LE(0, 0);
dir.writeUInt16LE(1, 2);            // type 1 = icon
dir.writeUInt16LE(SIZES.length, 4);

const entries = [];
let offset = 6 + 16 * SIZES.length;
for (let i = 0; i < SIZES.length; i++) {
  const s = SIZES[i], blob = blobs[i];
  const e = Buffer.alloc(16);
  e.writeUInt8(s >= 256 ? 0 : s, 0); // width
  e.writeUInt8(s >= 256 ? 0 : s, 1); // height
  e.writeUInt8(0, 2);                // palette
  e.writeUInt8(0, 3);                // reserved
  e.writeUInt16LE(1, 4);             // planes
  e.writeUInt16LE(32, 6);            // bpp
  e.writeUInt32LE(blob.length, 8);
  e.writeUInt32LE(offset, 12);
  entries.push(e);
  offset += blob.length;
}

fs.writeFileSync(outputPath, Buffer.concat([dir, ...entries, ...blobs]));
console.log(`✓ Wrote ${outputPath} (${(fs.statSync(outputPath).size / 1024).toFixed(1)} KB, BMP/DIB, sizes: ${SIZES.join('/')})`);
