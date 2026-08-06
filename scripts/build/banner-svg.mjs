/**
 * AMM README banner — terminal wordmark (v8.0).
 *
 * Source of truth for docs/banner.png, rendered by make-banner.mjs. The
 * concept: a shell prompt whose "$" is also the brand mark, so the banner
 * reads as both a command line and the logo.
 *
 * Type color splits three ways on purpose — "Munyun" carries the brand green,
 * the hyphens drop back so the three words separate, and the rest stays near
 * white. Monospace means the capitalized wordmark occupies exactly the same
 * width as the lowercase one, so the cursor block never needs repositioning.
 *
 * NOTE ON FONTS: this renders with whatever monospace the rasterizing machine
 * resolves (Consolas on Windows, Menlo on macOS, DejaVu Sans Mono on most
 * Linux CI images). The output PNG is committed, so viewers all see the same
 * image — but regenerating on a different OS will shift the glyphs slightly.
 * That's why the artwork ships as a raster and not as an inline SVG: GitHub
 * would otherwise render it with each visitor's own fonts.
 */

export const BANNER_W = 880;
export const BANNER_H = 200;

const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, "DejaVu Sans Mono", monospace';

export const COLORS = {
  bg:      '#0D1117', // matches the dashboard's dark surface
  brand:   '#3FB950', // the logo green
  text:    '#E6EDF3',
  hyphen:  '#39414B',
  caption: '#5A6673',
  chrome:  '#2A3038'  // the window dots
};

export function bannerSvg() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${BANNER_W} ${BANNER_H}" width="${BANNER_W}" height="${BANNER_H}">
  <rect width="${BANNER_W}" height="${BANNER_H}" fill="${COLORS.bg}"/>
  <circle cx="30" cy="26" r="5.5" fill="${COLORS.chrome}"/>
  <circle cx="50" cy="26" r="5.5" fill="${COLORS.chrome}"/>
  <circle cx="70" cy="26" r="5.5" fill="${COLORS.chrome}"/>
  <text x="42" y="112" font-family='${MONO}' font-size="42" font-weight="700" fill="${COLORS.brand}">$</text>
  <text id="wordmark" x="76" y="112" font-family='${MONO}' font-size="42" font-weight="700" fill="${COLORS.text}">Automatic<tspan fill="${COLORS.hyphen}">-</tspan><tspan fill="${COLORS.brand}">Munyun</tspan><tspan fill="${COLORS.hyphen}">-</tspan>Machine</text>
  <!-- x is set at render time from the wordmark's measured width (make-banner.mjs):
       monospace advance widths differ per font, so a hardcoded position drifts
       away from the text on any machine with a different mono installed. -->
  <rect id="cursor" x="686" y="82" width="17" height="38" fill="${COLORS.brand}"/>
  <text x="44" y="152" font-family='${MONO}' font-size="17" fill="${COLORS.caption}">50–200 jobs ranked against your resume · every morning · local-only</text>
</svg>`;
}
