#!/usr/bin/env node
/**
 * Render the README banner to docs/banner.png (v8.0).
 *
 *   node scripts/build/make-banner.mjs      (or: npm run build:banner)
 *
 * Rasterized at 2x so it stays sharp on retina displays — GitHub renders the
 * README column at roughly the banner's 1x width, so the extra pixels are
 * downscaled rather than upscaled. Same Playwright-based approach the icon
 * pipeline uses, so there's no new dependency.
 */

import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright-core';
import { resolveBrowser } from '../browser-launcher.mjs';
import { bannerSvg, BANNER_W, BANNER_H } from './banner-svg.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..', '..');
const OUT = path.join(ROOT, 'docs', 'banner.png');
const SCALE = 2;

const browser = await resolveBrowser();
console.log(`Rasterizing banner with ${browser.label}…`);
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'amm-banner-'));
const ctx = await chromium.launchPersistentContext(profileDir, {
  ...browser.launchOptions,
  headless: true,
  viewport: { width: BANNER_W, height: BANNER_H },
  deviceScaleFactor: SCALE
});

try {
  const page = ctx.pages()[0] || await ctx.newPage();
  await page.setContent(
    `<body style="margin:0">${bannerSvg()}</body>`,
    { waitUntil: 'load' }
  );
  await page.waitForTimeout(250); // let font resolution settle before capture
  // Sit the cursor block one character-width after the wordmark, measured from
  // the font that actually resolved rather than assumed metrics.
  const gap = await page.evaluate(() => {
    const w = document.getElementById('wordmark');
    const c = document.getElementById('cursor');
    const box = w.getBBox();
    const advance = box.width / w.textContent.length;
    const x = Math.round(box.x + box.width + advance * 0.6);
    c.setAttribute('x', String(x));
    return { width: Math.round(box.width), cursorX: x };
  });
  console.log(`  wordmark ${gap.width}px wide → cursor at x=${gap.cursorX}`);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  const buf = await (await page.$('svg')).screenshot();
  fs.writeFileSync(OUT, buf);
  console.log(`✓ Wrote ${path.relative(ROOT, OUT)} — ${BANNER_W * SCALE}x${BANNER_H * SCALE} (${(buf.length / 1024).toFixed(1)} KB)`);
} finally {
  await ctx.close().catch(() => {});
  fs.rmSync(profileDir, { recursive: true, force: true });
}
