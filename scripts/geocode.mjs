#!/usr/bin/env node
/**
 * Geocoding via open-meteo's free API (no key required).
 *
 * Used by /city <name> bot command and wizard step 9.
 *
 * Usage as module:
 *   import { geocode } from './geocode.mjs';
 *   const { lat, lon, city, country, timezone } = await geocode('Atlanta');
 */

export async function geocode(query) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(query)}&count=5&language=en&format=json`;
  const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
  const j = await r.json();
  if (!j.results || !j.results.length) return null;
  // Top hit by population
  const top = j.results.sort((a, b) => (b.population || 0) - (a.population || 0))[0];
  return {
    lat: top.latitude,
    lon: top.longitude,
    city: top.name,
    admin: top.admin1 || '',
    country: top.country || '',
    timezone: top.timezone || 'auto'
  };
}

// CLI test: node scripts/geocode.mjs "Atlanta"
const file = process.argv[1] ? process.argv[1].replace(/\\/g, '/') : '';
const meta = import.meta.url.replace('file:///', '').replace(/\\/g, '/');
if (file === meta || file.endsWith('geocode.mjs')) {
  const q = process.argv[2];
  if (!q) { console.error('Usage: node geocode.mjs <city>'); process.exit(2); }
  const r = await geocode(q);
  if (!r) { console.error('No match for: ' + q); process.exit(1); }
  console.log(JSON.stringify(r, null, 2));
}
