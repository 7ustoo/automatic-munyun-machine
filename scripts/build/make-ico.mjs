#!/usr/bin/env node
/**
 * PNG → multi-size Windows .ico converter (v2.0.2).
 *
 * Usage: node scripts/build/make-ico.mjs <input.png> <output.ico>
 *
 * Rasterizes the source PNG at standard icon sizes using a headless
 * Chromium-family browser (via scripts/browser-launcher.mjs — no extra
 * dependencies; reuses playwright-core + the user's installed browser),
 * then assembles a PNG-compressed ICO container. PNG-compressed entries
 * are valid since Windows Vista; the repo's existing tray .ico files use
 * the same encoding, and Inno Setup 6 accepted it for SetupIconFile in
 * the v2.0.1 release build.
 *
 * Why a browser instead of an image library: the project has zero native
 * deps and we keep it that way — canvas in headless Chromium is the
 * highest-quality resampler we already ship around.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { chromium } from 'playwright-core';
import { resolveBrowser } from '../browser-launcher.mjs';

const SIZES = [256, 128, 64, 48, 32, 16];

const [, , inputPath, outputPath] = process.argv;
if (!inputPath || !outputPath) {
  console.error('Usage: node scripts/build/make-ico.mjs <input.png> <output.ico>');
  process.exit(2);
}
if (!fs.existsSync(inputPath)) {
  console.error(`Input not found: ${inputPath}`);
  process.exit(2);
}

const srcB64 = fs.readFileSync(inputPath).toString('base64');

const browser = await resolveBrowser();
console.log(`Rasterizing with ${browser.label}…`);
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amm-make-ico-'));
const ctx = await chromium.launchPersistentContext(profileDir, {
  ...browser.launchOptions,
  headless: true
});

let pngs;
try {
  const page = ctx.pages()[0] || await ctx.newPage();
  pngs = await page.evaluate(async ({ b64, sizes }) => {
    const img = new Image();
    img.src = 'data:image/png;base64,' + b64;
    await img.decode();
    const out = {};
    for (const size of sizes) {
      const canvas = document.createElement('canvas');
      canvas.width = size;
      canvas.height = size;
      const cx = canvas.getContext('2d');
      cx.imageSmoothingEnabled = true;
      cx.imageSmoothingQuality = 'high';
      // Cover the square canvas; source is expected square already.
      cx.drawImage(img, 0, 0, size, size);
      out[size] = canvas.toDataURL('image/png').split(',')[1];
    }
    return out;
  }, { b64: srcB64, sizes: SIZES });
} finally {
  await ctx.close().catch(() => {});
  fs.rmSync(profileDir, { recursive: true, force: true });
}

// Assemble the ICO container: ICONDIR + ICONDIRENTRY[] + PNG blobs.
const blobs = SIZES.map(size => ({ size, data: Buffer.from(pngs[size], 'base64') }));
const header = Buffer.alloc(6);
header.writeUInt16LE(0, 0);             // reserved
header.writeUInt16LE(1, 2);             // type: 1 = icon
header.writeUInt16LE(blobs.length, 4);  // image count

const entries = [];
let offset = 6 + 16 * blobs.length;
for (const { size, data } of blobs) {
  const e = Buffer.alloc(16);
  e.writeUInt8(size >= 256 ? 0 : size, 0);  // width  (0 = 256)
  e.writeUInt8(size >= 256 ? 0 : size, 1);  // height (0 = 256)
  e.writeUInt8(0, 2);                       // palette colors (0 = no palette)
  e.writeUInt8(0, 3);                       // reserved
  e.writeUInt16LE(1, 4);                    // color planes
  e.writeUInt16LE(32, 6);                   // bits per pixel
  e.writeUInt32LE(data.length, 8);          // image data size
  e.writeUInt32LE(offset, 12);              // image data offset
  entries.push(e);
  offset += data.length;
}

fs.writeFileSync(outputPath, Buffer.concat([header, ...entries, ...blobs.map(b => b.data)]));
const kb = (fs.statSync(outputPath).size / 1024).toFixed(1);
console.log(`✓ Wrote ${outputPath} (${kb} KB, sizes: ${SIZES.join('/')})`);
