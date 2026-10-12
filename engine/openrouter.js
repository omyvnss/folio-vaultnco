/**
 * OpenRouter client — free models only.
 *
 * The free catalogue changes often, so models are discovered at runtime from
 * /api/v1/models (ids ending in ":free"), ranked by preference, and tried in
 * order until one returns a usable answer.
 *
 * FREE-ONLY GUARANTEE — four independent locks, any one blocks a paid call:
 *   1. Only models whose id ends in ":free" AND whose listed pricing is 0.
 *   2. Every request is re-checked against that list right before sending.
 *   3. Every response must come back from a ":free" model with cost 0,
 *      otherwise the engine aborts the whole run.
 *   4. Hard cap of MAX_AI_CALLS requests per run (default 20).
 *
 * Env:
 *   OPENROUTER_API_KEY   required for AI steps
 *   OPENROUTER_MODEL     optional, pin a model (ignored unless it is free)
 *   MAX_AI_CALLS         optional, per-run request cap (default 20)
 */

const API = 'https://openrouter.ai/api/v1';

// Preferred families, best first. Anything else free is used as a fallback.
const PREFERRED = [
  /^google\/gemma-4-31b/,
  /^google\/gemma/,
  /^thinkingmachines\/inkling:free/,
  /^nvidia\/nemotron-3-ultra/,
  /^nvidia\/nemotron-3-super/,
  /^meta-llama\//,
  /^deepseek\//,
  /^qwen\//,
  /^mistralai\//,
];
const AVOID = /content-safety|code|guard|embed/i;

let cache = null;
let calls = 0;
const MAX_AI_CALLS = parseInt(process.env.MAX_AI_CALLS || '20', 10);

class PaidModelError extends Error {}

const isZero = (v) => v === undefined || v === null || Number(v) === 0;
const isFreeListing = (m) =>
  m.id.endsWith(':free') &&
  ['prompt', 'completion', 'request', 'image', 'web_search', 'internal_reasoning']
    .every((k) => isZero(m.pricing?.[k]));

async function freeModels({ vision = false } = {}) {
  if (!cache) {
    const res = await fetch(`${API}/models`);
    if (!res.ok) throw new Error(`OpenRouter /models HTTP ${res.status}`);
    const { data } = await res.json();
    cache = data
      .filter((m) => isFreeListing(m) && !AVOID.test(m.id))
      .map((m) => ({
        id: m.id,
        vision: (m.architecture?.input_modalities || []).includes('image'),
        rank: (() => { const i = PREFERRED.findIndex((re) => re.test(m.id)); return i < 0 ? 99 : i; })(),
      }))
      .sort((a, b) => a.rank - b.rank);
  }
  const pinned = process.env.OPENROUTER_MODEL;
  let list = vision ? cache.filter((m) => m.vision) : cache;
  if (pinned && cache.some((m) => m.id === pinned)) list = [{ id: pinned }, ...list.filter((m) => m.id !== pinned)];
  else if (pinned) console.warn(`! OPENROUTER_MODEL "${pinned}" is not a free model — ignored`);
  return list.map((m) => m.id);
}

async function chat(model, messages, { timeoutMs = 90000 } = {}) {
  // lock 2: never send a request to anything outside the verified free list
  const free = await freeModels();
  if (!model.endsWith(':free') || !free.includes(model)) throw new PaidModelError(`refusing non-free model ${model}`);
  // lock 4: per-run request cap
  if (++calls > MAX_AI_CALLS) throw new PaidModelError(`AI call limit reached (${MAX_AI_CALLS}/run)`);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${API}/chat/completions`, {
      method: 'POST',
      signal: ctrl.signal,
      headers: {
        Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': 'https://folio.vaultnco.store',
        'X-Title': 'Folio VaultnCo engine',
      },
      // no `models`/fallback routing: OpenRouter may not reroute to a paid model
      body: JSON.stringify({ model, messages, temperature: 0.2, max_tokens: 1200, usage: { include: true } }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error) throw new Error(`${model}: ${body.error?.message || 'HTTP ' + res.status}`);
    // lock 3: the model that actually answered must be free and cost nothing
    if (body.model && !String(body.model).endsWith(':free') && !free.includes(body.model + ':free')) {
      throw new PaidModelError(`response came from non-free model ${body.model}`);
    }
    if (body.usage && !isZero(body.usage.cost)) throw new PaidModelError(`request cost ${body.usage.cost} credits`);
    const text = body.choices?.[0]?.message?.content;
    if (!text) throw new Error(`${model}: empty response`);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/** Pull the first JSON object/array out of a model reply (handles ``` fences and chatter). */
function extractJSON(text) {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const src = fenced ? fenced[1] : text;
  const start = src.search(/[[{]/);
  if (start < 0) throw new Error('no JSON in reply');
  const open = src[start], close = open === '{' ? '}' : ']';
  const end = src.lastIndexOf(close);
  return JSON.parse(src.slice(start, end + 1));
}

const hasKey = () => !!process.env.OPENROUTER_API_KEY;

module.exports = { freeModels, chat, extractJSON, hasKey, PaidModelError, isFreeListing };
