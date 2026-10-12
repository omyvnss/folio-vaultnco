#!/usr/bin/env node
/** Verifier tests — no network. Run: node engine/test.js */
const assert = require('assert');
const { discover, live, review, webpSize } = require('./steps.js');
const { extractJSON } = require('./openrouter.js');

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log('  ✓', name); };

const facts = { title: 'Jane Doe', description: '', text: 'Designer', words: 120, scripts: 3, images: 2, links: 6, bytes: 9000 };
const rv = (obj, f = facts) => review.verify({ reply: typeof obj === 'string' ? obj : JSON.stringify(obj), model: 'm:free' }, { facts: f });
const good = { verdict: 'accept', score: 8, kind: 'portfolio', name: 'Jane Doe', reason: 'Quiet typographic portfolio.' };

console.log('extractJSON');
t('reads fenced JSON', () => assert.deepStrictEqual(extractJSON('Sure!\n```json\n{"a":1}\n```'), { a: 1 }));
t('reads JSON inside chatter', () => assert.deepStrictEqual(extractJSON('Here: ["a.com"] done'), ['a.com']));

console.log('review verifier');
t('accepts a valid, high-score verdict', () => assert.ok(rv(good).ok));
t('rejects when AI rejects', () => assert.ok(rv({ ...good, verdict: 'reject', score: 3 }).reject));
t('rejects below MIN_SCORE', () => assert.ok(rv({ ...good, score: 6 }).reject));
t('rejects product sites', () => assert.ok(rv({ ...good, kind: 'product' }).reject));
t('retries on garbage', () => assert.ok(rv('I think it is nice').retry));
t('retries on out-of-range score', () => assert.ok(rv({ ...good, score: 14 }).retry));
t('retries on non-integer score', () => assert.ok(rv({ ...good, score: '8' }).retry));
t('retries on unknown verdict', () => assert.ok(rv({ ...good, verdict: 'maybe' }).retry));
t('retries on inconsistent accept+low score', () => assert.ok(rv({ ...good, score: 2 }).retry));
t('guard-rail: script-heavy page rejected even if AI accepts', () => assert.ok(rv(good, { ...facts, scripts: 99 }).reject));

console.log('discover verifier');
const ctx = { published: ['a.com'], rejected: { 'b.com': {} } };
t('filters published, rejected, invalid; normalises', () => {
  const v = discover.verify({ reply: '["a.com","b.com","https://www.New.design/about","not a domain","x.io"]', model: 'm' }, ctx);
  assert.deepStrictEqual(v.data.discovered, ['new.design', 'x.io']);
});
t('retries when nothing new', () => assert.ok(discover.verify({ reply: '["a.com"]' }, ctx).retry));

console.log('live verifier');
const page = (html, extra = {}) => live.verify({ status: 200, type: 'text/html', finalUrl: 'https://jane.design/', html, ...extra }, { url: 'jane.design' });
const body = '<title>Jane</title><p>' + 'word '.repeat(150) + '</p>';
t('passes a normal page', () => assert.ok(page(body).ok));
t('rejects 404', () => assert.ok(page(body, { status: 404 }).reject));
t('rejects parked domain', () => assert.ok(page('<title>jane.design is for sale</title><p>Buy this domain today. ' + 'x '.repeat(300) + '</p>').reject));
t('rejects cross-domain redirect', () => assert.ok(page(body, { finalUrl: 'https://linktr.ee/jane' }).reject));
t('rejects DNS failure as dead', () => assert.ok(live.verify({ error: 'getaddrinfo ENOTFOUND x' }, { url: 'x' }).reject));

console.log('webp parser');
t('reads VP8 dimensions', () => {
  const b = Buffer.alloc(30); b.write('RIFF', 0); b.write('WEBP', 8); b.write('VP8 ', 12);
  b.writeUInt16LE(1280, 26); b.writeUInt16LE(800, 28);
  assert.deepStrictEqual(webpSize(b), { w: 1280, h: 800 });
});

console.log(`\n${passed} passed`);
