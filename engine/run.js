#!/usr/bin/env node
/**
 * Folio engine — publishes new verified sites every day.
 *
 *   candidate ─► live ─► screenshot ─► review (free AI) ─► publish
 *                 │          │              │                │
 *               verify     verify         verify           verify
 *
 * Candidates come from the Google Sheet queue first; when that runs dry the
 * engine asks a free OpenRouter model to discover new sites. Every step has a
 * deterministic code verifier: a step's output is only accepted once its
 * verifier passes. Bad output is retried; an unsuitable site is recorded in
 * data/rejected.json and never retried (dead links get another chance after
 * RETRY_DEAD_DAYS).
 *
 * Usage: node engine/run.js [--dry-run]
 * Env:   OPENROUTER_API_KEY, OPENROUTER_MODEL, PER_DAY (default 1),
 *        MAX_CANDIDATES (default 12), MIN_SCORE (default 7)
 */
const fs = require('fs');
const path = require('path');

const core = require('../server.js');
const ai = require('./openrouter.js');
const steps = require('./steps.js');

const PER_DAY = parseInt(process.env.PER_DAY || '1', 10);
const MAX_CANDIDATES = parseInt(process.env.MAX_CANDIDATES || '12', 10);
const RETRY_DEAD_DAYS = 7;
const DRY_RUN = process.argv.includes('--dry-run');
const REJECTED = path.join(core.DATA_DIR, 'rejected.json');
const RUN_LOG = path.join(core.DATA_DIR, 'engine-log.json');

const readJSON = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };
const log = (...a) => console.log(...a);

/** Run one step with its verifier. Returns { status: 'ok'|'reject'|'fail', reason, data, tries }. */
async function runStep(step, ctx, trace) {
  let last = 'no attempts';
  for (let attempt = 1; attempt <= step.attempts; attempt++) {
    let out;
    try { out = await step.run(ctx, attempt); }
    catch (e) {
      if (e instanceof ai.PaidModelError) throw e; // free-only lock tripped → stop everything
      last = e.message; trace.push({ step: step.name, attempt, result: 'error', reason: last }); continue; }

    const v = step.verify(out, ctx);
    if (v.data) Object.assign(ctx, v.data);
    if (v.ok) {
      trace.push({ step: step.name, attempt, result: 'pass', model: out?.model });
      return { status: 'ok' };
    }
    if (v.reject) {
      trace.push({ step: step.name, attempt, result: 'reject', reason: v.reject, model: out?.model });
      return { status: 'reject', reason: v.reject };
    }
    last = v.retry;
    trace.push({ step: step.name, attempt, result: 'retry', reason: v.retry, model: out?.model });
  }
  return { status: 'fail', reason: last };
}

async function main() {
  const archive = readJSON(core.SITE_JSON, { sites: [] });
  const rejected = readJSON(REJECTED, {});
  const published = archive.sites.map((s) => s.url);
  const publishedSet = new Set(published);
  const now = Date.now();

  const skip = (url) => {
    if (publishedSet.has(url)) return true;
    const r = rejected[url];
    if (!r) return false;
    if (r.step === 'live' && now - Date.parse(r.at) > RETRY_DEAD_DAYS * 86400000) return false;
    return true;
  };

  // ---- candidate queue: sheet first, AI discovery as fallback ----
  let queue = [];
  let sheetTotal = null;
  try {
    const sheet = core.csvToSites(await core.fetchSheet());
    sheetTotal = sheet.length;
    queue = sheet.filter((s) => !skip(s.url)).map((s) => ({ url: s.url, sheetDate: s.date, source: 'sheet' }));
  } catch (e) {
    log(`! sheet unavailable: ${e.message}`);
  }
  log(`AI: ${ai.hasKey() ? 'OpenRouter free models' : 'DISABLED (no OPENROUTER_API_KEY) — heuristic review only'}`);
  log(`Archive ${published.length} | sheet queue ${queue.length} | target today ${PER_DAY}`);

  const runTrace = [];
  if (queue.length < PER_DAY * 3) {
    const ctx = { published, rejected };
    const trace = [];
    const res = await runStep(steps.discover, ctx, trace);
    runTrace.push({ url: '(discovery)', trace });
    if (res.status === 'ok') {
      log(`Discovery (${ctx.discoverModel}) proposed ${ctx.discovered.length} new domains`);
      queue.push(...ctx.discovered.filter((u) => !skip(u)).map((url) => ({ url, source: 'ai' })));
    } else {
      log(`Discovery: ${res.reason}`);
    }
  }

  // ---- process candidates until PER_DAY are published ----
  const added = [];
  let tried = 0;
  while (added.length < PER_DAY && queue.length && tried < MAX_CANDIDATES) {
    const cand = queue.shift();
    tried++;
    const ctx = { ...cand, sheetTotal };
    const trace = [];
    log(`\n→ ${cand.url} (${cand.source})`);

    let outcome = 'published', reason = '', failedStep = null;
    const pipeline = [steps.live, steps.screenshot, steps.review];
    if (!DRY_RUN) pipeline.push(steps.publish);
    const restore = DRY_RUN ? null : steps.snapshotArchive();

    for (const step of pipeline) {
      const res = await runStep(step, ctx, trace);
      const t = trace[trace.length - 1];
      log(`   ${res.status === 'ok' ? '✓' : res.status === 'reject' ? '✗' : '!'} ${step.name}${t?.model ? ` [${t.model}]` : ''}${res.reason ? ' — ' + res.reason : ''}`);
      if (res.status === 'ok') continue;
      // a site that stays unreachable after retries is the site's problem, not ours
      outcome = res.status === 'reject' || step === steps.live ? 'rejected' : 'failed';
      reason = res.reason; failedStep = step.name;
      if (step === steps.publish && restore) restore();
      break;
    }

    if (ctx.shotTmp) fs.rmSync(path.dirname(ctx.shotTmp), { recursive: true, force: true });
    if (outcome === 'published') {
      if (DRY_RUN) outcome = 'would-publish';
      added.push(cand.url); publishedSet.add(cand.url);
    } else if (outcome === 'rejected') {
      rejected[cand.url] = { step: failedStep, reason, at: new Date().toISOString(), ...(ctx.review ? { score: ctx.review.score, model: ctx.review.model } : {}) };
    }
    // 'failed' = our side broke (API down, no screenshot) → not recorded, retried tomorrow
    runTrace.push({ url: cand.url, source: cand.source, outcome, reason, review: ctx.review, trace });
  }

  if (!DRY_RUN) {
    fs.writeFileSync(REJECTED, JSON.stringify(rejected, null, 2));
    const history = readJSON(RUN_LOG, []);
    history.unshift({ at: new Date().toISOString(), ai: ai.hasKey(), published: added, candidates: runTrace });
    fs.writeFileSync(RUN_LOG, JSON.stringify(history.slice(0, 60), null, 2));
  }

  writeSummary(added, runTrace);
  log(`\nDone. Published ${added.length}/${PER_DAY}: ${added.join(', ') || '—'}`);
  if (!added.length && !DRY_RUN) process.exitCode = 0; // an empty day is not a CI failure
}

function writeSummary(added, runTrace) {
  const file = process.env.GITHUB_STEP_SUMMARY;
  if (!file) return;
  const rows = runTrace.map((c) => `| ${c.url} | ${c.outcome || (c.trace.at(-1)?.result ?? '')} | ${(c.review?.score ?? '')} | ${(c.reason || c.review?.reason || '').replace(/\|/g, '/')} |`);
  fs.appendFileSync(file, [
    `## Folio engine — ${added.length} published`,
    '', '| Candidate | Outcome | AI score | Reason |', '|---|---|---|---|', ...rows, '',
  ].join('\n'));
}

main().catch((e) => { console.error('Engine crashed:', e); process.exit(1); });
