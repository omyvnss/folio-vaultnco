#!/usr/bin/env node
/**
 * MNMM.CLONE — local backend + data sync
 *
 * Usage:
 *   node server.js          # start http://localhost:3000
 *   node server.js sync     # one-shot sync from Google Sheet, then exit
 */

const http  = require('http');
const fs    = require('fs');
const path  = require('path');
const https = require('https');

const PORT     = process.env.PORT || 3000;
const ROOT     = __dirname;
const DATA_DIR = path.join(ROOT, 'data');
const SITE_JSON = path.join(DATA_DIR, 'sites.json');
const SITE_CSV  = path.join(DATA_DIR, 'sites.csv');

const SHEET_CSV =
  'https://docs.google.com/spreadsheets/d/1XALmHbWxrLTg1hVp4tSzk_3p3vpWoDGXVjwgmSsjjcA/export?format=csv';

const SCREENSHOT_DIR = path.join(DATA_DIR, 'screenshots');

const microlinkSrc = (url) =>
  `https://api.microlink.io/?url=https://${encodeURIComponent(url)}&screenshot=true&meta=false&embed=screenshot.url`;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.csv':  'text/csv; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.webp': 'image/webp',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
};

/* ------------------------------------------------------------------ */
/*  CSV parsing                                                        */
/* ------------------------------------------------------------------ */

function parseCSV(text) {
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      row.push(field); field = '';
      if (row.length > 1 || row[0].trim()) rows.push(row);
      row = [];
    } else field += c;
  }
  row.push(field);
  if (row.length > 1 || row[0].trim()) rows.push(row);
  return rows;
}

function csvToSites(csv) {
  const rows = parseCSV(csv);
  if (rows.length < 2) throw new Error('CSV has no data rows');
  return rows.slice(1)
    .map(([url, date]) => ({
      url: String(url ?? '').trim().replace(/^https?:\/\//i, '').replace(/\/+$/, ''),
      date: /^\d{4}-\d{2}-\d{2}$/.test(String(date ?? '').trim()) ? date.trim() : null,
    }))
    .filter(s => /^[a-z0-9-]+(\.[a-z0-9-]+)+/i.test(s.url));
}

/* ------------------------------------------------------------------ */
/*  Screenshot pre-caching                                             */
/* ------------------------------------------------------------------ */

function safeFilename(url) {
  return url.replace(/[^a-z0-9.-]/gi, '_').replace(/\.{2,}/g, '.');
}

function downloadScreenshot(url, dest) {
  return new Promise((resolve, reject) => {
    if (fs.existsSync(dest)) return resolve('skip');
    https.get(microlinkSrc(url), { headers: { 'User-Agent': 'mnmm-clone/1.0' } }, (res) => {
      if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
        res.resume();
        const loc = res.headers.location.startsWith('http')
          ? res.headers.location
          : new URL(res.headers.location, microlinkSrc(url)).href;
        return downloadScreenshot(url, dest).then(resolve, reject);
      }
      if (res.statusCode !== 200) { res.resume(); return resolve('skip'); }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        // microlink sometimes returns JSON error instead of image
        if (buf[0] === 0x7b || buf[0] === 0x3c) return resolve('skip');
        fs.writeFileSync(dest, buf);
        resolve('ok');
      });
      res.on('error', () => resolve('skip'));
    }).on('error', () => resolve('skip'));
  });
}

async function cacheScreenshots(sites, concurrency = 6) {
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  let cached = 0, skipped = 0;
  const queue = [...sites];
  async function worker() {
    while (queue.length) {
      const site = queue.shift();
      const dest = path.join(SCREENSHOT_DIR, safeFilename(site.url) + '.webp');
      const result = await downloadScreenshot(site.url, dest);
      if (result === 'ok') cached++;
      else skipped++;
    }
  }
  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);
  return { cached, skipped };
}

/* ------------------------------------------------------------------ */
/*  Fetch CSV from Google (server-side, no CORS issues)                 */
/* ------------------------------------------------------------------ */

function fetchSheet() {
  return new Promise((resolve, reject) => {
    const follow = (url) => {
      https.get(url, { headers: { 'User-Agent': 'mnmm-clone/1.0' } }, (res) => {
        if ([301, 302, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          return follow(new URL(res.headers.location, url).href);
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
        res.on('error', reject);
      }).on('error', reject);
    };
    follow(SHEET_CSV);
  });
}

/* ------------------------------------------------------------------ */
/*  URL health check — verify each site is actually live                */
/* ------------------------------------------------------------------ */

function checkUrl(url, timeout = 8000) {
  return new Promise((resolve) => {
    let resolved = false;
    const done = (status) => { if (!resolved) { resolved = true; resolve(status); } };

    const timer = setTimeout(() => done('dead'), timeout);

    function follow(targetUrl, redirects = 0) {
      if (redirects > 5) { clearTimeout(timer); done('dead'); return; }
      const mod = targetUrl.startsWith('https') ? https : require('http');
      mod.get(targetUrl, { timeout: timeout - 1000, headers: { 'User-Agent': 'Mozilla/5.0' } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          const loc = res.headers.location.startsWith('http')
            ? res.headers.location
            : new URL(res.headers.location, targetUrl).href;
          return follow(loc, redirects + 1);
        }
        res.resume();
        clearTimeout(timer);
        done(res.statusCode >= 200 && res.statusCode < 400 ? 'ok' : 'dead');
      }).on('error', () => { clearTimeout(timer); done('dead'); })
        .on('timeout', () => { clearTimeout(timer); done('dead'); });
    }

    follow(url.startsWith('http') ? url : `https://${url}`);
  });
}

async function verifySites(sites, concurrency = 10) {
  let live = 0, dead = 0;
  const queue = [...sites];
  async function worker() {
    while (queue.length) {
      const site = queue.shift();
      site.status = await checkUrl(site.url);
      if (site.status === 'ok') live++;
      else { dead++; console.log(`  ✗ ${site.url} (${site.status})`); }
    }
  }
  const workers = Array.from({ length: concurrency }, () => worker());
  await Promise.all(workers);
  return { live, dead };
}

/* ------------------------------------------------------------------ */
/*  Sync: pull sheet -> verify -> write JSON + CSV + history            */
/* ------------------------------------------------------------------ */

async function sync() {
  let raw = '';
  for (let attempt = 1; attempt <= 3; attempt++) {
    raw = await fetchSheet();
    if (!/^\s*<(?:!doctype|html)/i.test(raw)) break;
    await new Promise((r) => setTimeout(r, attempt * 2000));
  }
  if (/^\s*<(?:!doctype|html)/i.test(raw)) throw new Error('Got HTML instead of CSV (sheet not public?)');
  if (!raw.trim()) throw new Error('Empty response from Google');

  const allSites = csvToSites(raw);
  console.log(`Found ${allSites.length} sites in sheet. Verifying...`);

  // verify each site is actually live
  const { live, dead } = await verifySites(allSites);
  console.log(`Verification: ${live} live, ${dead} dead/unpublished.`);

  const sites = allSites.filter((s) => s.status === 'ok');
  fs.mkdirSync(DATA_DIR, { recursive: true });

  const payload = JSON.stringify(
    { count: sites.length, total: allSites.length, dead, updated: new Date().toISOString(), sites },
    null,
    2
  );
  fs.writeFileSync(SITE_JSON, payload);
  fs.writeFileSync(SITE_CSV, 'Website URL,Date Added\n' + sites.map((s) => `${s.url},${s.date || ''}`).join('\n'));

  // dated archive snapshot
  const historyDir = path.join(DATA_DIR, 'history');
  fs.mkdirSync(historyDir, { recursive: true });
  fs.copyFileSync(SITE_CSV, path.join(historyDir, `${new Date().toISOString().slice(0, 10)}.csv`));

  // pre-cache screenshots only for live sites
  console.log('Caching screenshots...');
  const { cached, skipped } = await cacheScreenshots(sites);
  console.log(`Screenshots: ${cached} downloaded, ${skipped} skipped/cached.`);

  console.log(`Synced ${sites.length} live sites (filtered from ${allSites.length}).`);
  return sites;
}

/* ------------------------------------------------------------------ */
/*  Static + API server                                                */
/* ------------------------------------------------------------------ */

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (url === '/api/sites') {
    sendFile(res, SITE_JSON);
    return;
  }
  if (url.includes('..')) { res.writeHead(403); res.end(); return; }
  sendFile(res, path.join(ROOT, url === '/' ? 'index.html' : url));
});

/* ------------------------------------------------------------------ */
/*  Main                                                               */
/* ------------------------------------------------------------------ */

(async () => {
  if (process.argv[2] === 'sync') {
    try { await sync(); }
    catch (e) { console.error('Sync failed:', e.message); process.exit(1); }
    return;
  }

  if (!fs.existsSync(SITE_JSON)) {
    console.log('No local data found - syncing from the sheet...');
    try { await sync(); }
    catch (e) { console.warn('Initial sync failed:', e.message, '(site will show its error state)'); }
  }

  let siteCount = 0;
  try { siteCount = JSON.parse(fs.readFileSync(SITE_JSON, 'utf8')).count || 0; } catch (_) {}

  server.listen(PORT, () => {
    const addr = server.address();
    console.log(`\n  mnmm.clone is live:`);
    console.log(`    -> http://localhost:${PORT}`);
    console.log(`    -> http://127.0.0.1:${PORT}`);
    console.log(`  (${addr.family === 'IPv6' ? 'IPv6+IPv4 dual-stack' : addr.address}, ${siteCount} sites loaded)\n`);
  });
})();
