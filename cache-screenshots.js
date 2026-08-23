#!/usr/bin/env node
/**
 * Pre-cache Microlink screenshots using local Chrome headless.
 * Usage: node cache-screenshots.js [concurrency]
 */
const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const SCREENSHOT_DIR = path.join(DATA_DIR, 'screenshots');
const SITE_JSON = path.join(DATA_DIR, 'sites.json');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const CONCURRENCY = parseInt(process.argv[2]) || 4;
const WIDTH = 1280;
const HEIGHT = 800;

function safeFilename(url) {
  return url.replace(/[^a-z0-9.-]/gi, '_').replace(/\.{2,}/g, '.');
}

function takeScreenshot(url) {
  const dest = path.join(SCREENSHOT_DIR, safeFilename(url) + '.png');
  if (fs.existsSync(dest)) return 'skip';
  try {
    execSync(
      `"${CHROME}" --headless=new --disable-gpu --no-sandbox --disable-dev-shm-usage ` +
      `--screenshot="${dest}" --window-size=${WIDTH},${HEIGHT} --hide-scrollbars ` +
      `--virtual-time-budget=5000 ` +
      `"https://${url}"`,
      { timeout: 20000, stdio: 'pipe' }
    );
    return fs.existsSync(dest) ? 'ok' : 'fail';
  } catch {
    return 'fail';
  }
}

async function main() {
  const sites = JSON.parse(fs.readFileSync(SITE_JSON, 'utf8')).sites;
  fs.mkdirSync(SCREENSHOT_DIR, { recursive: true });

  const existing = fs.readdirSync(SCREENSHOT_DIR).filter(f => f.endsWith('.png'));
  const remaining = sites.filter(s => !fs.existsSync(path.join(SCREENSHOT_DIR, safeFilename(s.url) + '.png')));

  console.log(`${existing.length} already cached, ${remaining.length} to capture...`);

  let done = 0, failed = 0;
  for (let i = 0; i < remaining.length; i += CONCURRENCY) {
    const batch = remaining.slice(i, i + CONCURRENCY);
    const results = batch.map(s => {
      const r = takeScreenshot(s.url);
      if (r === 'ok') done++;
      else failed++;
      return r;
    });
    process.stdout.write(`\r  [${done + failed}/${remaining.length}] ok=${done} fail=${failed}`);
  }
  console.log(`\nDone: ${done} captured, ${failed} failed, ${existing.length} already existed.`);
}

main().catch(console.error);
