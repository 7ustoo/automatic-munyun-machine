#!/usr/bin/env node
/**
 * Atomic config.json read/write helper.
 *
 * Ensures multi-process safety (bot + scrape may both touch config.json) by
 * using temp-file + rename. All writes are atomic — no partial writes.
 *
 * Used by every Telegram /settings, /yoe, /salary, /clearance, /skip, /jobs add,
 * etc. command handler.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const CFG_PATH = path.join(ROOT, 'config.json');
const CFG_EXAMPLE = path.join(ROOT, 'config.example.json');

export function read() {
  if (!fs.existsSync(CFG_PATH)) {
    if (fs.existsSync(CFG_EXAMPLE)) fs.copyFileSync(CFG_EXAMPLE, CFG_PATH);
    else throw new Error('config.json not found and no example to copy from');
  }
  return JSON.parse(fs.readFileSync(CFG_PATH, 'utf8'));
}

function atomicWrite(obj) {
  const tmp = CFG_PATH + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, CFG_PATH);
}

// dot-path setter: set('user.salaryFloorUsd', 90000)
export function set(dotPath, value) {
  const cfg = read();
  const keys = dotPath.split('.');
  let cur = cfg;
  for (let i = 0; i < keys.length - 1; i++) {
    if (cur[keys[i]] === undefined || cur[keys[i]] === null || typeof cur[keys[i]] !== 'object') {
      cur[keys[i]] = {};
    }
    cur = cur[keys[i]];
  }
  cur[keys[keys.length - 1]] = value;
  atomicWrite(cfg);
  return cfg;
}

// dot-path getter
export function get(dotPath, fallback = undefined) {
  const cfg = read();
  return dotPath.split('.').reduce((o, k) => (o == null ? o : o[k]), cfg) ?? fallback;
}

// array append (no duplicates by .toLowerCase)
export function appendUnique(dotPath, item) {
  const cfg = read();
  const keys = dotPath.split('.');
  let cur = cfg;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!cur[keys[i]]) cur[keys[i]] = {};
    cur = cur[keys[i]];
  }
  const last = keys[keys.length - 1];
  if (!Array.isArray(cur[last])) cur[last] = [];
  const norm = (x) => (typeof x === 'string' ? x.toLowerCase() : JSON.stringify(x).toLowerCase());
  const exists = cur[last].some(x => norm(x) === norm(item));
  if (exists) { atomicWrite(cfg); return { added: false, list: cur[last] }; }
  cur[last].push(item);
  atomicWrite(cfg);
  return { added: true, list: cur[last] };
}

// array remove (case-insensitive match for strings)
export function removeFromArray(dotPath, predicateOrValue) {
  const cfg = read();
  const keys = dotPath.split('.');
  let cur = cfg;
  for (let i = 0; i < keys.length - 1; i++) {
    if (!cur[keys[i]]) return { removed: 0, list: [] };
    cur = cur[keys[i]];
  }
  const last = keys[keys.length - 1];
  if (!Array.isArray(cur[last])) return { removed: 0, list: [] };
  const before = cur[last].length;
  const pred = typeof predicateOrValue === 'function'
    ? predicateOrValue
    : (item) => {
        if (typeof item === 'string' && typeof predicateOrValue === 'string') {
          return item.toLowerCase() === predicateOrValue.toLowerCase();
        }
        if (item && typeof item === 'object' && typeof predicateOrValue === 'string') {
          // for queries: { key, term } — match by term
          return (item.term || '').toLowerCase() === predicateOrValue.toLowerCase();
        }
        return JSON.stringify(item) === JSON.stringify(predicateOrValue);
      };
  cur[last] = cur[last].filter(x => !pred(x));
  atomicWrite(cfg);
  return { removed: before - cur[last].length, list: cur[last] };
}
