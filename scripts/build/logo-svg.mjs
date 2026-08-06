/**
 * AMM brand mark — the golden dollar sign (v7.12).
 *
 * Single source of truth for the logo artwork. Every shipped icon (dashboard
 * favicon, installer icon, tray icon, and the yellow/red/gray status variants)
 * is rasterized from this one SVG by scripts/build/make-logos.mjs, so the
 * silhouette is identical everywhere and only the glyph color changes.
 *
 * The "$" is drawn as PATHS, deliberately — not as <text>. A text-based glyph
 * would render with whatever font the build machine happens to have, so the
 * icon would come out one shape on the maintainer's Windows box and a
 * different shape in CI on Ubuntu. Paths render byte-identically anywhere.
 *
 * Geometry lives in a 48x48 viewBox: a rounded tile, a vertical stem, and an
 * S-curve stroked over it. Round caps keep the strokes readable once the whole
 * mark is scaled down to a 16px tray icon.
 */

// Flat, single-value colors. No gradients: the gold-gradient-on-black look is
// exactly what made the old logo read as AI-generated, and gradients turn to
// mud at 16px anyway.
export const PALETTE = {
  // v7.13: the brand mark is green — the same green the dashboard already uses
  // for "strong match" meters, so the icon and the product read as one thing.
  brand:  '#3FB950', // healthy / brand — the default mark
  yellow: '#D9A62E', // stale heartbeat
  red:    '#F85149', // dead bot
  gray:   '#8B949E'  // paused / stopped
};

export const TILE_BG = '#0D1117'; // neutral near-black; keeps green legible on any taskbar

/**
 * @param {string} glyph  fill color for the $ (see PALETTE)
 * @param {object} [opts]
 * @param {boolean} [opts.tile=true]  draw the rounded background tile
 * @returns {string} standalone SVG markup
 */
export function logoSvg(glyph = PALETTE.brand, { tile = true } = {}) {
  const bg = tile
    ? `<rect width="48" height="48" rx="11" fill="${TILE_BG}"/>`
    : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="48" height="48">
  ${bg}
  <g stroke="${glyph}" fill="none" stroke-linecap="round" stroke-linejoin="round">
    <!-- stem: runs past the bowls top and bottom, like a real dollar sign -->
    <path d="M24 8.5 V39.5" stroke-width="3.4"/>
    <!-- S-curve: top bowl opens left, bottom bowl opens right -->
    <path d="M31.5 17.2
             C31.5 13.9 28.2 12.1 24 12.1
             C19.8 12.1 16.5 13.9 16.5 17.4
             C16.5 21.1 19.8 22.3 24 23.4
             C28.2 24.5 31.5 25.7 31.5 29.4
             C31.5 32.9 28.2 34.7 24 34.7
             C19.8 34.7 16.5 32.9 16.5 29.6"
          stroke-width="4.6"/>
  </g>
</svg>`;
}

// The variants that get shipped as icon files. `green` is the legacy
// "running, Telegram off" state icon that icons.go still embeds — now the
// same artwork as the brand mark, since the brand mark itself is green.
export const VARIANTS = {
  logo:   PALETTE.brand,
  yellow: PALETTE.yellow,
  red:    PALETTE.red,
  gray:   PALETTE.gray,
  green:  PALETTE.brand
};
