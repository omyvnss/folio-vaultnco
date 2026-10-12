/**
 * OpenRouter client — free models only.
 *
 * The free catalogue changes often, so models are discovered at runtime from
 * /api/v1/models (ids ending in ":free"), ranked by preference, and tried in
 * order until one returns a usable answer.
 *
 * Env:
 *   OPENROUTER_API_KEY   required for AI steps
 *   OPENROUTER_MODEL     optional, pin a model (still must be :free)
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

async function freeModels({ vision = false } = {}) {
  if (!cache) {
    const res = await fetch(`${API}/models`);
    if (!res.ok) throw new Error(`OpenRouter /models HTTP ${res.status}`);
    const { data } = await res.json();
    cache = data
      .filter((m) => m.id.endsWith(':free') && !AVOID.test(m.id))
      .map((m) => ({
        id: m.id,
        vision: (m.architecture?.input_modalities || []).includes('image'),
        rank: (() => { const i = PREFERRED.findIndex((re) => re.test(m.id)); return i < 0 ? 99 : i; })(),
      }))
      .sort((a, b) => a.rank - b.rank);
  }
  const pinned = process.env.OPENROUTER_MODEL;
  let list = vision ? cache.filter((m) => m.vision) : cache;
  if (pinned) list = [{ id: pinned }, ...list.filter((m) => m.id !== pinned)];
  return list.map((m) => m.id);
}

async function chat(model, messages, { timeoutMs = 90000 } = {}) {
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
      body: JSON.stringify({ model, messages, temperature: 0.2, max_tokens: 1200 }),
    });
    const body = await res.json().catch(() => ({}));
    if (!res.ok || body.error) throw new Error(`${model}: ${body.error?.message || 'HTTP ' + res.status}`);
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

module.exports = { freeModels, chat, extractJSON, hasKey };
