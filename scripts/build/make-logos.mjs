#!/usr/bin/env node
/**
 * Regenerate every shipped icon from the one SVG in logo-svg.mjs (v7.12).
 *
 *   node scripts/build/make-logos.mjs
 *
 * Writes into wrapper/ (all of these are embedded into the binary at build
 * time by icons.go / dashboard.go):
 *
 *   logo.png        master mark — dashboard favicon + sidebar, Mac/Linux tray
 *   logo.ico        installer + uninstall entry     (PNG-compressed ICO)
 *   logo-tray.ico   Windows tray, healthy state     (BMP/DIB ICO)
 *   icon-<state>.png / .ico   yellow / red / gray / green status variants
 *
 * Two ICO encoders exist for a real reason (see make-tray-ico.mjs): Inno Setup
 * and browsers read PNG-compressed ICO fine, but the Win32 system-tray loader
 * does NOT — it needs classic BMP/DIB or it fails with "unable to load icon
 * from file". So anything the tray touches goes through make-tray-ico.mjs and
 * only logo.ico uses the PNG-compressed encoder.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { resolveBrowser } from '../browser-launcher.mjs';
import { logoSvg, VARIANTS } from './logo-svg.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const WRAPPER = path.join(ROOT, 'wrapper');
const MASTER_PX = 512;

// Rasterize each variant's SVG once at MASTER_PX. omitBackground keeps the
// rounded tile's corners transparent instead of filling them white.
const browser = await resolveBrowser();
console.log(`Rasterizing with ${browser.label}…`);
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amm-logos-'));
const ctx = await chromium.launchPersistentContext(profileDir, { ...browser.launchOptions, headless: true });

const masters = {};
let winres256;
try {
  const page = ctx.pages()[0] || await ctx.newPage();
  const render = async (color, px) => {
    const svg = logoSvg(color).replace('width="48" height="48"', `width="${px}" height="${px}"`);
    await page.setContent(`<body style="margin:0;background:transparent">${svg}</body>`, { waitUntil: 'load' });
    return (await page.$('svg')).screenshot({ omitBackground: true });
  };
  for (const [name, color] of Object.entries(VARIANTS)) {
    masters[name] = await render(color, MASTER_PX);
    console.log(`  ${name}: ${MASTER_PX}px master (${masters[name].length} bytes)`);
  }
  // The AMM.exe icon is built by go-winres from winres/logo-256.png on every
  // Windows build (see wrapper/Makefile build-win) — regenerate that source
  // too, or the executable keeps the previous branding forever.
  winres256 = await render(VARIANTS.logo, 256);
} finally {
  await ctx.close().catch(() => {});
  fs.rmSync(profileDir, { recursive: true, force: true });
}

// PNG outputs. `logo` is the brand mark; the rest are tray status variants.
const pngPath = (name) => path.join(WRAPPER, name === 'logo' ? 'logo.png' : `icon-${name}.png`);
for (const [name, buf] of Object.entries(masters)) {
  fs.writeFileSync(pngPath(name), buf);
  console.log(`  wrote ${path.relative(ROOT, pngPath(name))}`);
}

// Source image for the embedded AMM.exe icon.
const winresPath = path.join(WRAPPER, 'winres', 'logo-256.png');
fs.writeFileSync(winresPath, winres256);
console.log(`  wrote ${path.relative(ROOT, winresPath)}`);

// ICO outputs, via the two existing encoders.
function run(script, input, output) {
  const r = spawnSync(process.execPath, [path.join(__dirname, script), input, output], { stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`${script} failed for ${path.basename(output)}`);
}

// Installer / uninstall icon — PNG-compressed is correct here.
run('make-ico.mjs', pngPath('logo'), path.join(WRAPPER, 'logo.ico'));

// Everything the tray loads must be BMP/DIB.
run('make-tray-ico.mjs', pngPath('logo'), path.join(WRAPPER, 'logo-tray.ico'));
for (const name of Object.keys(VARIANTS)) {
  if (name === 'logo') continue;
  run('make-tray-ico.mjs', pngPath(name), path.join(WRAPPER, `icon-${name}.ico`));
}

console.log('\nAll icons regenerated from scripts/build/logo-svg.mjs');
