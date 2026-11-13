import http from 'node:http';
import https from 'node:https';
import { lookup } from 'node:dns/promises';
import { chromium } from 'playwright-core';
import { resolveBrowser } from './browser-launcher.mjs';
import { directApplyUrl } from './hcafe-apply-links.mjs';

export function publicIPv4(address) {
  const parts = String(address).split('.').map(Number);
  if (parts.length !== 4 || parts.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b, c] = parts;
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || b === 2))
    || (a === 100 && b >= 64 && b <= 127) || (a === 198 && [18, 19].includes(b))
    || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113));
}

// Resolve and pin each connection, including redirects and page subresources.
// Uploaded URLs cannot reach localhost, LAN services, or user browser sessions.
export async function publicPageRequest(value, { resolve = lookup, timeoutMs = 12000 } = {}) {
  const valid = directApplyUrl(value);
  if (!valid) throw new Error('This application link is not a public employer URL.');
  const url = new URL(valid);
  if (url.port && !['80', '443'].includes(url.port)) throw new Error('Unsupported employer page port.');
  const addresses = await resolve(url.hostname, { all: true, family: 4 });
  if (!addresses.length || addresses.some(a => !publicIPv4(a.address))) throw new Error('Employer page resolved to a private or unsupported address.');
  return new Promise((resolveResult, reject) => {
    const request = (url.protocol === 'https:' ? https : http).request(url, {
      method: 'GET', agent: false,
      lookup: (_host, options, callback) => options?.all ? callback(null, [addresses[0]]) : callback(null, addresses[0].address, 4),
      headers: { 'User-Agent': 'Mozilla/5.0 AMM job description reader', Accept: 'text/html,application/json,*/*', 'Accept-Encoding': 'identity' },
    }, response => {
      const chunks = []; let bytes = 0;
      response.on('data', chunk => { bytes += chunk.length; if (bytes > 5 * 1024 * 1024) request.destroy(new Error('Employer page is too large.')); else chunks.push(chunk); });
      response.on('end', () => resolveResult({ status: response.statusCode, body: Buffer.concat(chunks), headers: response.headers }));
      response.on('error', reject);
    });
    const deadline = setTimeout(() => request.destroy(new Error('Employer page timed out. Try again later.')), timeoutMs);
    request.once('close', () => clearTimeout(deadline));
    request.setTimeout(timeoutMs, () => request.destroy(new Error('Employer page timed out. Try again later.')));
    request.on('error', reject); request.end();
  });
}

function htmlText(value) {
  return String(value || '').replace(/<script\b[^>]*>[\s\S]*?<\/script>|<style\b[^>]*>[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]*>/g, ' ').replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (_, entity) => {
      if (entity.startsWith('#')) {
        const code = parseInt(entity.slice(/^#x/i.test(entity) ? 2 : 1), /^#x/i.test(entity) ? 16 : 10);
        return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : ' ';
      }
      return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' })[entity.toLowerCase()];
    }).replace(/\s+/g, ' ').trim();
}

// Standard JobPosting data is already the full employer description. Reading it
// directly avoids loading scripts, analytics, images and browser navigation.
export function staticEmployerDescription(html, { url, title = '' }) {
  const postings = [];
  const visit = item => {
    if (!item || typeof item !== 'object') return;
    if ([item['@type']].flat().includes('JobPosting')) postings.push(item);
    else for (const child of Object.values(item)) if (Array.isArray(child)) child.forEach(visit); else if (child && typeof child === 'object') visit(child);
  };
  for (const match of String(html).matchAll(/<script\b[^>]*type\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi)) {
    try { visit(JSON.parse(match[1])); } catch {}
  }
  const sameUrl = value => { try { const a = new URL(value, url), b = new URL(url); return a.hostname === b.hostname && a.pathname.replace(/\/$/, '') === b.pathname.replace(/\/$/, ''); } catch { return false; } };
  const matches = postings.filter(p => p.url || p['@id'] ? sameUrl(p.url || p['@id']) : title && String(p.title).toLowerCase().trim() === title.toLowerCase().trim());
  const posting = matches.length === 1 ? matches[0] : postings.length === 1 && !postings[0].url && !postings[0]['@id'] ? postings[0] : null;
  if (!posting) return null;
  if (posting.validThrough && Date.parse(posting.validThrough) < Date.now()) throw new Error('This posting has expired.');
  const jdText = htmlText(posting.description);
  return jdText.length >= 250 ? { jdText, title: String(posting.title || ''), company: String(posting.hiringOrganization?.name || ''), descriptionQuality: 'full' } : null;
}

export function employerPostingApi(value) {
  const url = new URL(value), parts = url.pathname.split('/').filter(Boolean);
  if (['boards.greenhouse.io', 'job-boards.greenhouse.io'].includes(url.hostname) && parts[1] === 'jobs' && /^\d+$/.test(parts[2] || '')) {
    return { type: 'greenhouse', url: `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(parts[0])}/jobs/${parts[2]}` };
  }
  if (['jobs.lever.co', 'jobs.eu.lever.co'].includes(url.hostname) && parts.length >= 2 && /^[a-f0-9-]{36}$/.test(parts[1])) {
    return { type: 'lever', url: `https://${url.hostname === 'jobs.eu.lever.co' ? 'api.eu.lever.co' : 'api.lever.co'}/v0/postings/${encodeURIComponent(parts[0])}/${parts[1]}?mode=json` };
  }
  return null;
}

export function employerBoardPosting(value, sourceId = '') {
  let url;
  try { url = new URL(value); } catch { return null; }
  const parts = url.pathname.split('/').filter(Boolean), token = encodeURIComponent(parts[0] || '');
  if (['boards.greenhouse.io', 'job-boards.greenhouse.io'].includes(url.hostname) && parts[1] === 'jobs' && /^\d+$/.test(parts[2] || '')) {
    return { type: 'greenhouse', id: parts[2], url: `https://boards-api.greenhouse.io/v1/boards/${token}/jobs?content=true` };
  }
  // HiringCafe keeps the original ATS identity even when an employer uses a
  // branded careers site. Require the same posting ID in both identities.
  const greenhouse = /^grnhse___([a-z0-9_-]+)___(\d+)$/i.exec(sourceId);
  if (greenhouse && url.searchParams.get('gh_jid') === greenhouse[2]) {
    return { type: 'greenhouse', id: greenhouse[2], url: `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(greenhouse[1])}/jobs?content=true` };
  }
  if (['jobs.lever.co', 'jobs.eu.lever.co'].includes(url.hostname) && /^[a-f0-9-]{36}$/i.test(parts[1] || '')) {
    return { type: 'lever', id: parts[1], url: `https://${url.hostname === 'jobs.eu.lever.co' ? 'api.eu.lever.co' : 'api.lever.co'}/v0/postings/${token}?mode=json` };
  }
  if (url.hostname === 'jobs.ashbyhq.com' && /^[a-f0-9-]{36}$/i.test(parts[1] || '')) {
    return { type: 'ashby', id: parts[1], url: `https://api.ashbyhq.com/posting-api/job-board/${token}` };
  }
  return null;
}

// A board feed supplies full descriptions for many distinct openings in one
// public request. Cache the in-flight request too; workers share it by board.
export function createBoardDescriptionReader(request = publicPageRequest) {
  const boards = new Map();
  return async job => {
    const board = employerBoardPosting(job.directUrl, job.sourceId);
    if (!board) return null;
    if (!boards.has(board.url)) boards.set(board.url, (async () => {
      const response = await request(board.url);
      if (response.status !== 200) return [];
      const data = JSON.parse(response.body.toString('utf8'));
      return Array.isArray(data) ? data : Array.isArray(data.jobs) ? data.jobs : [];
    })().catch(() => []));
    const postings = await boards.get(board.url);
    const posting = postings.find(p => {
      if (board.type !== 'ashby') return String(p.id) === board.id;
      try { return new URL(p.jobUrl || p.applyUrl).pathname.split('/').filter(Boolean)[1] === board.id; } catch { return false; }
    });
    if (!posting || posting.isListed === false) return null;
    const text = board.type === 'greenhouse' ? htmlText(posting.content) : board.type === 'ashby'
      ? posting.descriptionPlain || htmlText(posting.descriptionHtml) : [posting.descriptionPlain || htmlText(posting.description),
        ...(posting.lists || []).map(list => `${list.text || ''} ${htmlText(list.content)}`), posting.additionalPlain || htmlText(posting.additional)].filter(Boolean).join('\n');
    if (text.length < 250) return null;
    return { jdText: text.slice(0, 40000), title: posting.title || posting.text || job.title, directUrl: job.directUrl, descriptionQuality: 'full' };
  };
}

export async function readEmployerDescription(job, request = publicPageRequest) {
  let url = directApplyUrl(job.directUrl);
  if (!url) throw new Error('No direct employer link. Import a CSV with a full job description.');
  const api = employerPostingApi(url);
  if (api) {
    const response = await request(api.url);
    if (response.status === 200) {
      try {
        const data = JSON.parse(response.body.toString('utf8'));
        const jdText = api.type === 'greenhouse' ? htmlText(data.content) : [data.descriptionPlain || htmlText(data.description),
          ...(data.lists || []).map(list => `${list.text || ''} ${htmlText(list.content)}`), data.additionalPlain || htmlText(data.additional)].filter(Boolean).join('\n');
        if (jdText.length >= 250) return { result: { jdText, title: data.title || data.text || job.title, descriptionQuality: 'full', directUrl: url } };
      } catch {}
    } else if ([403, 429, 503].includes(response.status)) throw new Error(`Employer description API returned HTTP ${response.status}. Retry later.`);
  }
  for (let redirects = 0; redirects <= 5; redirects++) {
    const response = await request(url);
    if ([301, 302, 303, 307, 308].includes(response.status) && response.headers.location) {
      url = new URL(response.headers.location, url).href;
      if (!directApplyUrl(url)) throw new Error('Employer redirected to an unsupported application link.');
      continue;
    }
    if (response.status < 200 || response.status >= 300) throw new Error(`Employer page returned HTTP ${response.status}.`);
    const html = response.body.toString('utf8');
    const result = staticEmployerDescription(html, { url, title: job.title });
    if (result) return { result: { ...result, directUrl: job.directUrl } };
    if (/verify you are human|<title>\s*(?:just a moment|access denied)/i.test(html.slice(0, 30000))) throw new Error('Employer page requires human verification. Retry later.');
    return { url, response };
  }
  throw new Error('Employer page redirected too many times.');
}

// Runs in the isolated page. Prefer the requested posting's structured data;
// multiple unrelated JobPosting records must not select a recommendation.
export function extractEmployerDescription({ url, title }) {
  const textOf = html => { const node = document.createElement('div'); node.innerHTML = String(html || ''); node.querySelectorAll('script,style').forEach(e => e.remove()); return node.textContent.trim(); };
  const clean = text => String(text || '').replace(/\s+/g, ' ').trim();
  const sameUrl = value => { try { const a = new URL(value, url), b = new URL(url); return a.hostname === b.hostname && a.pathname.replace(/\/$/, '') === b.pathname.replace(/\/$/, ''); } catch { return false; } };
  const postings = [];
  const visit = value => {
    if (!value || typeof value !== 'object') return;
    if ([value['@type']].flat().includes('JobPosting')) postings.push(value);
    else for (const child of Object.values(value)) { if (Array.isArray(child)) child.forEach(visit); else if (child && typeof child === 'object') visit(child); }
  };
  document.querySelectorAll('script[type="application/ld+json"]').forEach(node => { try { visit(JSON.parse(node.textContent)); } catch {} });
  const matches = postings.filter(p => p.url || p['@id'] ? sameUrl(p.url || p['@id']) : title && clean(p.title).toLowerCase() === clean(title).toLowerCase());
  const posting = matches.length === 1 ? matches[0] : postings.length === 1 && !postings[0].url && !postings[0]['@id'] ? postings[0] : null;
  if (posting) {
    if (posting.validThrough && Date.parse(posting.validThrough) < Date.now()) throw new Error('This posting has expired.');
    const jdText = textOf(posting.description);
    if (jdText.length >= 250) return { jdText, title: clean(posting.title), company: clean(posting.hiringOrganization?.name), descriptionQuality: 'full' };
  }
  const titleWords = clean(title).toLowerCase().match(/[a-z0-9]{3,}/g) || [];
  const headings = [...document.querySelectorAll('h1,h2,h3')].map(node => clean(node.textContent));
  const heading = headings.find(text => titleWords.length && titleWords.filter(word => text.toLowerCase().includes(word)).length / titleWords.length >= 0.6)
    || clean(document.querySelector('h1')?.textContent);
  if (titleWords.length && title !== '(untitled)' && titleWords.filter(word => heading.toLowerCase().includes(word)).length / titleWords.length < 0.6) return null;
  const pageText = document.body?.innerText || '';
  if (/job (?:is no longer|not|has been).*available|position (?:has been filled|is closed)|job not found|verify you are human|access denied/i.test(pageText.slice(0, 5000))) return null;
  for (const selector of ['[data-automation-id="jobPostingDescription"]', '[data-qa="job-description"]', '.jv-job-detail-description', '.posting-page .content', '.job__description', '#job-description', '#jobDescription', '.job-description', '#content', '[itemprop="description"]', '.job-opportunity-wrapper', 'article', 'main', '[role="main"]']) {
    const node = document.querySelector(selector);
    const jdText = node?.innerText?.trim();
    if (heading && jdText?.length >= 250 && /responsibilit|qualification|requirements|experience|duties|what you|about (?:the|this) role/i.test(jdText)) return { jdText, title: heading, descriptionQuality: 'full' };
  }
  return null;
}

export function createEmployerDescriptionLoader() {
  let browser, context, opening, starts = 0;
  const boardDescription = createBoardDescriptionReader();
  const loadOnce = async job => {
    const directUrl = directApplyUrl(job.directUrl);
    if (!directUrl) throw new Error('No direct employer link. Import a CSV with a full job description.');
    const fromBoard = await boardDescription(job);
    if (fromBoard) return fromBoard;
    const prefetched = await readEmployerDescription(job);
    if (prefetched.result) return prefetched.result;
    opening ||= (async () => {
      if (++starts > 3) throw Object.assign(new Error('The employer description browser stopped repeatedly. Completed work is saved; continue to retry.'), { code: 'DESCRIPTION_WORKER_FAILED' });
      const resolved = await resolveBrowser();
      browser = await chromium.launch({ ...resolved.launchOptions, headless: true });
      context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
      // WebSocket traffic is not covered by HTTP routing. Block it before
      // loading untrusted employer pages; older browsers use static HTML.
      if (typeof context.routeWebSocket === 'function') await context.routeWebSocket('**/*', socket => socket.close());
      else { await context.close(); context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: 'block', acceptDownloads: false }); }
      const ready = context, activeBrowser = browser;
      ready.on('close', () => { if (context === ready) opening = null; });
      activeBrowser.on('disconnected', () => { if (browser === activeBrowser) opening = null; });
      return ready;
    })();
    const ready = await opening;
    const page = await ready.newPage(); let requests = 0;
    await page.route('**/*', async route => {
      const request = route.request();
      if (request.method() !== 'GET' || ['image', 'media', 'font', 'websocket'].includes(request.resourceType()) || ++requests > 80) return route.abort();
      try {
        const response = request.url() === prefetched.url ? prefetched.response : await publicPageRequest(request.url());
        const headers = { 'content-type': response.headers['content-type'] || 'text/html' };
        if (response.headers.location) headers.location = response.headers.location;
        for (const name of ['access-control-allow-origin', 'content-encoding']) if (response.headers[name]) headers[name] = response.headers[name];
        await route.fulfill({ status: response.status, headers, body: response.body });
      } catch { await route.abort().catch(() => {}); }
    });
    try {
      const response = await page.goto(prefetched.url, { waitUntil: 'domcontentloaded', timeout: 15000 });
      if (response && !response.ok()) throw new Error(`Employer page returned HTTP ${response.status()}.`);
      let result;
      for (let attempt = 0; attempt < 4; attempt++) {
        result = await page.evaluate(extractEmployerDescription, { url: page.url(), title: job.title });
        if (result) break;
        await page.waitForTimeout(800);
      }
      if (!result) throw new Error('Full description unavailable on employer page. Retry later or import a CSV with a Description column.');
      return { ...result, directUrl, jdText: result.jdText.slice(0, 40000) };
    } finally { await page.close().catch(() => {}); }
  };
  const load = async job => {
    for (let attempt = 0; attempt < 2; attempt++) {
      try { return await loadOnce(job); }
      catch (error) {
        if (error.code === 'DESCRIPTION_WORKER_FAILED' || !/has been closed|browser.*closed|context.*closed|disconnected/i.test(String(error.message)) || attempt) throw error;
        const failed = browser; opening = null;
        await failed?.close().catch(() => {});
      }
    }
  };
  load.close = async () => { await opening?.catch(() => {}); await browser?.close(); browser = context = opening = null; };
  return load;
}
