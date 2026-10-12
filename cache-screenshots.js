#!/usr/bin/env node
/**
 * Screenshot maintenance — runs locally and in CI.
 *
 *  1. Captures previews for sites with no screenshot (or a blank one, e.g. a
 *     loader frame) using headless Chrome.
 *  2. Normalises every preview to a real 1280×800 WebP. Microlink returns
 *     2560×1600 PNGs, which used to be saved with a .webp name (~1 MB each).
 *
 * Usage: node cache-screenshots.js
 * Env:   CHROME=/path/to/chrome   (auto-detected otherwise)
 * Needs: cwebp (brew install webp / apt-get install webp) for step 2.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const SCREENSHOT_DIR = path.join(DATA_DIR, 'screenshots');
const SITE_JSON = path.join(DATA_DIR, 'sites.json');
const WIDTH = 1280;
const HEIGHT = 800;
const BLANK_BYTES = 5000; // a real page preview is never this small

function safeFilename(url) {
  return url.replace(/[^a-z0-9.-]/gi, '_').replace(/\.{2,}/g, '.');
}

function which(bin) {
  try { return execFileSync('which', [bin], { stdio: 'pipe' }).toString().trim() || null; }
  catch { return null; }
}

function findChrome() {
  const candidates = [
    process.env.CHROME,
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    which('google-chrome'),
    which('google-chrome-stable'),
    which('chromium'),
    which('chromium-browser'),
  ];
  return candidates.find((c) => c && fs.existsSync(c)) || null;
}

const isWebP = (buf) => buf.slice(0, 4).toString() === 'RIFF' && buf.slice(8, 12).toString() === 'WEBP';

function toWebP(src, dest) {
  const tmp = dest + '.tmp.webp';
  execFileSync('cwebp', ['-quiet', '-q', '78', '-resize', String(WIDTH), String(HEIGHT), src, '-o', tmp], { stdio: 'pipe' });
  fs.renameSync(tmp, dest);
}

function capture(chrome, url, dest) {
  const png = dest.replace(/\.webp$/, '.capture.png');
  try {
    execFileSync(chrome, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--disable-dev-shm-usage',
      '--hide-scrollbars', `--window-size=${WIDTH},${HEIGHT}`,
      '--virtual-time-budget=12000', `--screenshot=${png}`, `https://${url}`,
    ], { timeout: 45000, stdio: 'pipe' });
    if (!fs.existsSync(png) || fs.statSync(png).size < BLANK_BYTES) return false;
    toWebP(png, dest);
    return true;
  } catch {
    return false;
  } finally {
    fs.rmSync(png, { force: true });
  }
}

function main() {
  const sites = JSON.parse(fs.readFileSync(SITE_JSON, 'utf8')).sites;
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });
  const hasCwebp = !!which('cwebp');
  const chrome = findChrome();
  if (!hasCwebp) console.warn('cwebp not found — skipping capture and normalisation.');

  let captured = 0, normalised = 0, failed = [];
  for (const { url } of sites) {
    const dest = path.join(SCREENSHOT_DIR, safeFilename(url) + '.webp');
    const exists = fs.existsSync(dest);

    if (!exists || fs.statSync(dest).size < BLANK_BYTES) {
      if (chrome && hasCwebp && capture(chrome, url, dest)) captured++;
      else if (!exists) failed.push(url);
      continue;
    }

    if (hasCwebp && !isWebP(fs.readFileSync(dest))) {
      try { toWebP(dest, dest); normalised++; }
      catch { failed.push(url); }
    }
  }

  console.log(`Screenshots: ${captured} captured, ${normalised} converted to WebP, ${sites.length - failed.length}/${sites.length} present.`);
  if (failed.length) console.log('Missing:\n' + failed.map((u) => '  - ' + u).join('\n'));
}

module.exports = { findChrome, which, isWebP, toWebP, capture, BLANK_BYTES };

if (require.main === module) main();
