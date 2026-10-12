/**
 * Pipeline steps. Every step is { name, attempts, run(ctx, attempt), verify(out, ctx) }.
 *
 * `verify` is plain deterministic code — never another LLM call. It returns:
 *   { ok: true, data }              step passed; `data` is merged into ctx
 *   { ok: false, reject: reason }   candidate is unsuitable → drop it, try next
 *   { ok: false, retry: reason }    output was bad → re-run the step (next model / next try)
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const http = require('http');
const os = require('os');
const { execFileSync } = require('child_process');

const core = require('../server.js');
const shots = require('../cache-screenshots.js');
const ai = require('./openrouter.js');

const DOMAIN_RE = /^(?!-)[a-z0-9-]{1,63}(?<!-)(\.(?!-)[a-z0-9-]{1,63}(?<!-))+$/i;
const PARKED_RE = /domain (?:name )?(?:is )?for sale|buy this domain|this domain (?:may be|is) for sale|parked (?:free|domain)|hugedomains|sedo\.com|dan\.com|godaddy|coming soon|under construction|website is not available|account (?:has been )?suspended/i;
const MIN_SCORE = parseInt(process.env.MIN_SCORE || '7', 10);
const KINDS = ['portfolio', 'personal', 'studio', 'blog', 'product', 'other'];

/* ------------------------------------------------------------------ */
/*  helpers                                                            */
/* ------------------------------------------------------------------ */

function fetchPage(url, limit = 1_500_000, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const follow = (target, hops = 0) => {
      if (hops > 5) return reject(new Error('too many redirects'));
      const mod = target.startsWith('https') ? https : http;
      const req = mod.get(target, { timeout: timeoutMs, headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml',
      } }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          return follow(new URL(res.headers.location, target).href, hops + 1);
        }
        let size = 0; const chunks = [];
        res.on('data', (c) => { size += c.length; if (size <= limit) chunks.push(c); else res.destroy(); });
        res.on('close', () => resolve({
          status: res.statusCode, finalUrl: target,
          type: String(res.headers['content-type'] || ''),
          html: Buffer.concat(chunks).toString('utf8'),
        }));
      });
      req.on('timeout', () => req.destroy(new Error('timeout')));
      req.on('error', reject);
    };
    follow(`https://${url}`);
  });
}

function pageFacts(html) {
  const pick = (re) => (html.match(re)?.[1] || '').replace(/\s+/g, ' ').trim();
  const text = html
    .replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z#0-9]+;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return {
    title: pick(/<title[^>]*>([\s\S]*?)<\/title>/i).slice(0, 120),
    description: pick(/<meta[^>]+name=["']description["'][^>]+content=["']([^"']*)/i).slice(0, 300),
    text: text.slice(0, 2500),
    words: text ? text.split(' ').length : 0,
    scripts: (html.match(/<script\b/gi) || []).length,
    images: (html.match(/<img\b/gi) || []).length,
    links: (html.match(/<a\b/gi) || []).length,
    bytes: Buffer.byteLength(html),
  };
}

/** Read width/height from a WebP header (VP8, VP8L, VP8X). */
function webpSize(buf) {
  if (!shots.isWebP(buf)) return null;
  const chunk = buf.slice(12, 16).toString();
  if (chunk === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
  if (chunk === 'VP8L') {
    const b = buf.readUInt32LE(21);
    return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 };
  }
  if (chunk === 'VP8X') return { w: buf.readUIntLE(24, 3) + 1, h: buf.readUIntLE(27, 3) + 1 };
  return null;
}

async function askModels({ messages, vision = false, attempt }) {
  const models = await ai.freeModels({ vision });
  if (!models.length) throw new Error(`no free ${vision ? 'vision ' : ''}models available`);
  // each attempt starts at a different model so retries don't hit the same one
  const order = [...models.slice(attempt - 1), ...models.slice(0, attempt - 1)].slice(0, 4);
  const errors = [];
  for (const model of order) {
    try { return { model, reply: await ai.chat(model, messages) }; }
    catch (e) { errors.push(e.message); }
  }
  throw new Error('all models failed: ' + errors.join(' | '));
}

/* ------------------------------------------------------------------ */
/*  1. discover — only used when the sheet queue is empty               */
/* ------------------------------------------------------------------ */

const discover = {
  name: 'discover',
  attempts: 3,
  async run(ctx, attempt) {
    if (!ai.hasKey()) return { skipped: 'no OPENROUTER_API_KEY' };
    const sample = ctx.published.slice(-25).join(', ');
    const { model, reply } = await askModels({ attempt, messages: [
      { role: 'system', content: 'You curate an archive of exceptionally minimal personal websites (designer/engineer portfolios and personal homepages). You only name real, currently-live domains you are confident exist.' },
      { role: 'user', content: `Already in the archive (do not repeat): ${sample}\n\nSuggest 15 more real personal/portfolio websites in the same minimal, typographic, restrained style. Reply with ONLY a JSON array of bare domains, e.g. ["example.com","name.design"].` },
    ] });
    return { model, reply };
  },
  verify(out, ctx) {
    if (out.skipped) return { ok: false, reject: out.skipped };
    let list;
    try { list = ai.extractJSON(out.reply); } catch (e) { return { ok: false, retry: 'unparseable reply: ' + e.message }; }
    if (!Array.isArray(list)) return { ok: false, retry: 'reply is not an array' };
    const seen = new Set([...ctx.published, ...Object.keys(ctx.rejected)]);
    const fresh = [...new Set(list
      .filter((d) => typeof d === 'string')
      .map((d) => d.trim().toLowerCase().replace(/^https?:\/\//, '').replace(/^www\./, '').replace(/\/.*$/, ''))
      .filter((d) => DOMAIN_RE.test(d) && !seen.has(d)))];
    if (!fresh.length) return { ok: false, retry: 'no new valid domains in reply' };
    return { ok: true, data: { discovered: fresh, discoverModel: out.model } };
  },
};

/* ------------------------------------------------------------------ */
/*  2. live — reachable, real HTML, not parked                          */
/* ------------------------------------------------------------------ */

const live = {
  name: 'live',
  attempts: 2,
  async run(ctx) {
    try { return await fetchPage(ctx.url); }
    catch (e) { return { error: e.message }; }
  },
  verify(out, ctx) {
    if (out.error) {
      const dead = out.error.match(/ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EPROTO|CERT_|SSL|certificate|EHOSTUNREACH/i);
      return dead ? { ok: false, reject: `dead (${dead[0]})` } : { ok: false, retry: out.error.slice(0, 120) };
    }
    if (out.status >= 500) return { ok: false, retry: `HTTP ${out.status}` };
    if (out.status >= 400) return { ok: false, reject: `HTTP ${out.status}` };
    if (!/html/i.test(out.type)) return { ok: false, reject: `not HTML (${out.type || 'no content-type'})` };
    const facts = pageFacts(out.html);
    if (facts.bytes < 400) return { ok: false, reject: 'page is nearly empty' };
    const parkedTitle = /\bis for sale\b|^(?:coming soon|under construction|index of \/)/i.test(facts.title);
    if (parkedTitle || PARKED_RE.test(facts.title) || (facts.words < 400 && PARKED_RE.test(facts.text))) {
      return { ok: false, reject: 'parked / placeholder domain' };
    }
    const host = new URL(out.finalUrl).hostname.replace(/^www\./, '');
    const want = ctx.url.split('/')[0].replace(/^www\./, '');
    if (host !== want && !host.endsWith('.' + want) && !want.endsWith('.' + host)) {
      return { ok: false, reject: `redirects to another domain (${host})` };
    }
    return { ok: true, data: { facts, finalHost: host } };
  },
};

/* ------------------------------------------------------------------ */
/*  3. screenshot — real 1280×800 WebP, not blank                       */
/* ------------------------------------------------------------------ */

const screenshot = {
  name: 'screenshot',
  attempts: 2,
  async run(ctx, attempt) {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'folio-'));
    const raw = path.join(tmp, 'raw');
    const dest = path.join(tmp, 'shot.webp');
    if (attempt === 1) {
      await core.downloadScreenshot(ctx.url, raw); // Microlink (waits for loaders)
      if (fs.existsSync(raw)) {
        try { shots.toWebP(raw, dest); } catch (e) { return { error: 'cwebp: ' + e.message }; }
      }
    } else {
      const chrome = shots.findChrome();
      if (!chrome) return { error: 'no Chrome for fallback capture' };
      shots.capture(chrome, ctx.url, dest);
    }
    return { file: fs.existsSync(dest) ? dest : null };
  },
  verify(out, ctx) {
    if (out.error) return { ok: false, retry: out.error };
    if (!out.file) return { ok: false, retry: 'no screenshot produced' };
    const buf = fs.readFileSync(out.file);
    const dim = webpSize(buf);
    if (!dim) return { ok: false, retry: 'file is not a valid WebP' };
    if (dim.w !== 1280 || dim.h !== 800) return { ok: false, retry: `wrong size ${dim.w}×${dim.h}` };
    if (buf.length < shots.BLANK_BYTES) return { ok: false, retry: `looks blank (${buf.length} bytes)` };
    return { ok: true, data: { shotTmp: out.file } };
  },
};

/* ------------------------------------------------------------------ */
/*  4. review — free vision model judges fit; code validates the verdict */
/* ------------------------------------------------------------------ */

const REVIEW_PROMPT = `You are the curator of Folio VaultnCo, an archive of exceptionally minimal personal websites.
Accept ONLY: personal sites / portfolios / small studios with restrained, typographic, uncluttered design (lots of whitespace, few elements, no ads, no cookie walls, no marketing-heavy SaaS landing pages, no e-commerce, no news sites).
Judge from the screenshot first, then the page facts.

Reply with ONLY this JSON:
{"verdict":"accept"|"reject","score":<integer 0-10 for minimalism and craft>,"kind":"portfolio"|"personal"|"studio"|"blog"|"product"|"other","name":"<person or studio name, max 60 chars>","reason":"<one sentence, max 200 chars>"}`;

const review = {
  name: 'review',
  attempts: 3,
  async run(ctx, attempt) {
    if (!ai.hasKey()) return { heuristic: true };
    const f = ctx.facts;
    const facts = `URL: ${ctx.url}\nTitle: ${f.title}\nDescription: ${f.description}\nWords: ${f.words} | scripts: ${f.scripts} | images: ${f.images} | links: ${f.links} | HTML bytes: ${f.bytes}\nVisible text (truncated): ${f.text.slice(0, 1500)}`;
    const image = `data:image/webp;base64,${fs.readFileSync(ctx.shotTmp).toString('base64')}`;
    try {
      return await askModels({ attempt, vision: true, messages: [
        { role: 'system', content: REVIEW_PROMPT },
        { role: 'user', content: [{ type: 'text', text: facts }, { type: 'image_url', image_url: { url: image } }] },
      ] });
    } catch (e) {
      // no vision model answered — fall back to text-only review
      return await askModels({ attempt, messages: [
        { role: 'system', content: REVIEW_PROMPT },
        { role: 'user', content: facts + '\n(Screenshot unavailable — judge from facts.)' },
      ] });
    }
  },
  verify(out, ctx) {
    const f = ctx.facts;
    // deterministic guard-rails apply regardless of the model's opinion
    if (f.words > 6000) return { ok: false, reject: `too much content for a minimal site (${f.words} words)` };
    if (f.scripts > 60) return { ok: false, reject: `too script-heavy (${f.scripts} scripts)` };

    if (out.heuristic) return { ok: true, data: { review: { verdict: 'accept', score: null, kind: 'personal', name: f.title.slice(0, 60), reason: 'heuristic only (no API key)', model: null } } };

    let r;
    try { r = ai.extractJSON(out.reply); } catch (e) { return { ok: false, retry: 'unparseable reply: ' + e.message }; }
    if (!r || typeof r !== 'object' || Array.isArray(r)) return { ok: false, retry: 'reply is not an object' };
    if (!['accept', 'reject'].includes(r.verdict)) return { ok: false, retry: `bad verdict "${r.verdict}"` };
    if (!Number.isInteger(r.score) || r.score < 0 || r.score > 10) return { ok: false, retry: `bad score "${r.score}"` };
    if (!KINDS.includes(r.kind)) return { ok: false, retry: `bad kind "${r.kind}"` };
    if (typeof r.reason !== 'string' || !r.reason.trim()) return { ok: false, retry: 'missing reason' };
    if (typeof r.name !== 'string') r.name = f.title;
    // internally inconsistent answers are treated as bad output, not as a decision
    if (r.verdict === 'accept' && r.score < 5) return { ok: false, retry: 'accepted with a failing score (inconsistent)' };
    if (r.verdict === 'reject' && r.score >= 9) return { ok: false, retry: 'rejected with a top score (inconsistent)' };

    const verdict = { ...r, name: r.name.trim().slice(0, 60), reason: r.reason.trim().slice(0, 200), model: out.model };
    if (r.verdict !== 'accept') return { ok: false, reject: `AI: ${verdict.reason}`, data: { review: verdict } };
    if (r.score < MIN_SCORE) return { ok: false, reject: `AI score ${r.score} < ${MIN_SCORE}: ${verdict.reason}`, data: { review: verdict } };
    if (['product', 'other'].includes(r.kind)) return { ok: false, reject: `kind "${r.kind}" not curated`, data: { review: verdict } };
    return { ok: true, data: { review: verdict } };
  },
};

/* ------------------------------------------------------------------ */
/*  5. publish — append + re-read and prove the archive is consistent   */
/* ------------------------------------------------------------------ */

const publish = {
  name: 'publish',
  attempts: 1,
  async run(ctx) {
    const json = JSON.parse(fs.readFileSync(core.SITE_JSON, 'utf8'));
    const before = json.sites.length;
    const today = new Date().toISOString().slice(0, 10);
    const shotPath = path.join(core.SCREENSHOT_DIR, core.safeFilename(ctx.url) + '.webp');
    fs.copyFileSync(ctx.shotTmp, shotPath);

    json.sites.push({
      url: ctx.url,
      date: ctx.sheetDate || today,
      added: today,
      name: ctx.review.name || undefined,
      source: ctx.source,
      score: ctx.review.score ?? undefined,
    });
    json.count = json.sites.length;
    if (ctx.sheetTotal) json.total = ctx.sheetTotal;
    json.updated = new Date().toISOString();

    fs.writeFileSync(core.SITE_JSON, JSON.stringify(json, null, 2));
    fs.writeFileSync(core.SITE_CSV, 'Website URL,Date Added,Published\n' + json.sites.map((s) => `${s.url},${s.date || ''},${s.added || ''}`).join('\n'));
    const hist = path.join(core.DATA_DIR, 'history');
    fs.mkdirSync(hist, { recursive: true });
    fs.copyFileSync(core.SITE_CSV, path.join(hist, `${today}.csv`));
    return { before, shotPath };
  },
  verify(out, ctx) {
    let json;
    try { json = JSON.parse(fs.readFileSync(core.SITE_JSON, 'utf8')); } catch (e) { return { ok: false, retry: 'sites.json unreadable after write' }; }
    const urls = json.sites.map((s) => s.url);
    if (json.sites.length !== out.before + 1) return { ok: false, retry: `expected ${out.before + 1} sites, found ${json.sites.length}` };
    if (json.count !== json.sites.length) return { ok: false, retry: 'count field out of sync' };
    if (urls[urls.length - 1] !== ctx.url) return { ok: false, retry: 'new site is not last entry' };
    if (new Set(urls).size !== urls.length) return { ok: false, retry: 'duplicate URL in archive' };
    if (!shots.isWebP(fs.readFileSync(out.shotPath))) return { ok: false, retry: 'published screenshot is not WebP' };
    const csvRows = fs.readFileSync(core.SITE_CSV, 'utf8').trim().split('\n').length - 1;
    if (csvRows !== json.sites.length) return { ok: false, retry: `CSV has ${csvRows} rows, JSON has ${json.sites.length}` };
    return { ok: true, data: {} };
  },
};

/** Restore sites.json/csv if publish verification fails, so a bad write never ships. */
function snapshotArchive() {
  const files = [core.SITE_JSON, core.SITE_CSV].map((f) => [f, fs.readFileSync(f)]);
  return () => files.forEach(([f, buf]) => fs.writeFileSync(f, buf));
}

module.exports = { discover, live, screenshot, review, publish, snapshotArchive, DOMAIN_RE, webpSize, pageFacts };
