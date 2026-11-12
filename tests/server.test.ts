import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { createApp, type Env } from '../server/app.ts';
import { thinkingFor } from '../server/gemini.ts';
import { FixedWindow, GenerateLimiter } from '../server/ratelimit.ts';

/** A fetch stub that answers like Gemini and records the request bodies it received. */
function gemini(reply: unknown, status = 200) {
  const calls: { url: string; body: any; headers: Record<string, string> }[] = [];
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, body: JSON.parse(String(init.body)), headers: init.headers as Record<string, string> });
    const text = typeof reply === 'string' ? reply : JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(reply) }] } }] });
    return new Response(text, { status });
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function makeApp(env: Env, fetchImpl?: typeof fetch, now = () => 1_700_000_000_000) {
  return createApp({ getEnv: () => env, getIp: (c) => c.req.header('x-test-ip') ?? '10.0.0.1', fetchImpl, now });
}

const KEY: Env = { GEMINI_API_KEY: 'test-key' };
const post = (app: ReturnType<typeof makeApp>, body: unknown, ip = '10.0.0.1') =>
  app.request('/api/generate', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-test-ip': ip },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });
const ok = { prompt: 'astronomy', format: 'prose', length: 'short' };
const PROSE = { title: 'Stars', text: 'Stars are born in clouds of gas and dust that collapse under their own gravity.' };

describe('GET /api/health', () => {
  test('reports whether a key is configured', async () => {
    assert.deepEqual(await (await makeApp({}).request('/api/health')).json(), { ai: false });
    assert.deepEqual(await (await makeApp(KEY).request('/api/health')).json(), { ai: true });
  });
});

describe('POST /api/generate validation', () => {
  const { fetchImpl, calls } = gemini(PROSE);
  const app = makeApp({ ...KEY, RATE_PER_MINUTE: '1000', RATE_PER_DAY: '1000' }, fetchImpl);

  test('503 disabled without a key', async () => {
    const res = await post(makeApp({}), ok);
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error, 'disabled');
  });

  const cases: [string, unknown, number][] = [
    ['invalid JSON', '{nope', 400],
    ['non-object JSON', 'null', 400],
    ['missing prompt', { format: 'prose', length: 'short' }, 400],
    ['blank prompt', { ...ok, prompt: '   \n ' }, 400],
    ['prompt too long', { ...ok, prompt: 'x'.repeat(241) }, 400],
    ['unknown format', { ...ok, format: 'poem' }, 400],
    ['unknown length', { ...ok, length: 'huge' }, 400],
    ['oversized body', { ...ok, pad: 'x'.repeat(3000) }, 413],
  ];
  for (const [name, body, status] of cases) {
    test(`${status} for ${name}`, async () => {
      const res = await post(app, body);
      assert.equal(res.status, status);
      assert.equal((await res.json()).error, 'bad_request');
    });
  }

  test('rejected requests never reach Gemini', () => {
    assert.equal(calls.length, 0);
  });

  test('whitespace in the prompt is collapsed and counted after collapsing', async () => {
    const res = await post(app, { ...ok, prompt: `  ${'a '.repeat(120)}  ` });
    assert.equal(res.status, 200);
    assert.equal(calls.at(-1)!.body.contents[0].parts[0].text, `Request: ${'a '.repeat(120).trim()}`);
  });
});

describe('POST /api/generate with Gemini', () => {
  const env: Env = { ...KEY, RATE_PER_MINUTE: '1000', RATE_PER_DAY: '1000' };

  test('returns normalized prose and sends the key only in a header', async () => {
    const { fetchImpl, calls } = gemini({ title: '“Stars”', text: 'Stars  are “born”\n in clouds — of gas and dust, collapsing slowly.' });
    const res = await post(makeApp(env, fetchImpl), ok);
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.deepEqual(body, {
      title: '"Stars"',
      format: 'prose',
      length: 'short',
      language: null,
      text: 'Stars are "born" in clouds - of gas and dust, collapsing slowly.',
    });
    assert.ok(!calls[0].url.includes('test-key'));
    assert.equal(calls[0].headers['x-goog-api-key'], 'test-key');
    assert.equal(calls[0].body.generationConfig.responseMimeType, 'application/json');
  });

  test('code: maps language aliases and strips fences', async () => {
    const { fetchImpl } = gemini({ title: 'Loop', language: 'Py', text: '```python\n    for i in range(3):\n        print(i)\n```' });
    const res = await post(makeApp(env, fetchImpl), { ...ok, format: 'code' });
    const body = await res.json();
    assert.equal(body.language, 'python');
    assert.equal(body.text, 'for i in range(3):\n    print(i)');
  });

  test('words: joins the array and clamps to maxChars', async () => {
    const { fetchImpl } = gemini({ title: 'W', words: Array.from({ length: 200 }, (_, i) => `word${i}`) });
    const res = await post(makeApp(env, fetchImpl), { ...ok, format: 'words' });
    const body = await res.json();
    assert.ok(body.text.length <= 260);
    assert.ok(body.text.startsWith('word0 word1 '));
  });

  test('Gemini 429 → 429 quota', async () => {
    const { fetchImpl } = gemini('{"error":{"code":429}}', 429);
    const res = await post(makeApp(env, fetchImpl), ok);
    assert.equal(res.status, 429);
    assert.equal((await res.json()).error, 'quota');
  });

  test('Gemini 500 → 502 upstream without leaking details', async () => {
    const { fetchImpl } = gemini('{"error":"internal secret detail"}', 500);
    const res = await post(makeApp(env, fetchImpl), ok);
    assert.equal(res.status, 502);
    const body = await res.json();
    assert.equal(body.error, 'upstream');
    assert.ok(!body.message.includes('secret'));
  });

  test('malformed model output → 502 upstream', async () => {
    const { fetchImpl } = gemini(JSON.stringify({ candidates: [{ content: { parts: [{ text: '{"title": "cut off' }] }, finishReason: 'MAX_TOKENS' }] }));
    const res = await post(makeApp(env, fetchImpl), ok);
    assert.equal(res.status, 502);
    assert.match((await res.json()).message, /malformed output \(it ran out of tokens\)/);
  });

  test('too little text → 502 upstream', async () => {
    const { fetchImpl } = gemini({ title: 'x', text: 'Too short.' });
    const res = await post(makeApp(env, fetchImpl), ok);
    assert.equal(res.status, 502);
  });
});

describe('rate limiting', () => {
  test('per-IP minute limit, with Retry-After, independent per IP', async () => {
    const { fetchImpl } = gemini(PROSE);
    const app = makeApp({ ...KEY, RATE_PER_MINUTE: '2', RATE_PER_DAY: '100' }, fetchImpl);
    assert.equal((await post(app, ok)).status, 200);
    assert.equal((await post(app, ok)).status, 200);
    const third = await post(app, ok);
    assert.equal(third.status, 429);
    assert.equal((await third.json()).error, 'limit');
    assert.ok(Number(third.headers.get('retry-after')) > 0);
    assert.equal((await post(app, ok, '10.0.0.2')).status, 200);
  });

  test('invalid requests do not consume the limit', async () => {
    const { fetchImpl } = gemini(PROSE);
    const app = makeApp({ ...KEY, RATE_PER_MINUTE: '1' }, fetchImpl);
    for (let i = 0; i < 3; i++) assert.equal((await post(app, { ...ok, format: 'bad' })).status, 400);
    assert.equal((await post(app, ok)).status, 200);
  });

  test('global daily cap applies across IPs', async () => {
    const { fetchImpl } = gemini(PROSE);
    const app = makeApp({ ...KEY, DAILY_GENERATION_LIMIT: '2' }, fetchImpl);
    assert.equal((await post(app, ok, 'a')).status, 200);
    assert.equal((await post(app, ok, 'b')).status, 200);
    const res = await post(app, ok, 'c');
    assert.equal(res.status, 429);
    assert.match((await res.json()).message, /on this server/);
  });

  test('a Workers rate-limit binding is consulted first', async () => {
    const { fetchImpl, calls } = gemini(PROSE);
    const keys: string[] = [];
    const app = makeApp({ ...KEY, GENERATE_LIMITER: { limit: async ({ key }) => (keys.push(key), { success: false }) } }, fetchImpl);
    assert.equal((await post(app, ok, '203.0.113.9')).status, 429);
    assert.deepEqual(keys, ['203.0.113.9']);
    assert.equal(calls.length, 0);
  });

  test('windows reset at their boundary', () => {
    const w = new FixedWindow({ limit: 1, ms: 1000 });
    w.take('k', 5000);
    assert.equal(w.check('k', 5999).ok, false);
    assert.equal(w.check('k', 5999).retryAfterMs, 1);
    assert.equal(w.check('k', 6000).ok, true);
  });

  test('a rejected request consumes nothing', () => {
    const l = new GenerateLimiter({ perMinute: 1, perDay: 2, globalPerDay: 100 });
    const t = 0;
    assert.equal(l.take('ip', t).ok, true);
    assert.equal(l.take('ip', t + 1).rule, 'minute');
    assert.equal(l.take('ip', t + 60_000).ok, true); // the minute rejection did not count toward the day
    assert.equal(l.take('ip', t + 120_000).rule, 'day');
  });
});

describe('thinking config', () => {
  test('2.5 Flash models turn thinking off with a zero budget', () => {
    assert.deepEqual(thinkingFor('gemini-2.5-flash-lite'), { config: { thinkingBudget: 0 }, extraTokens: 0 });
    assert.deepEqual(thinkingFor('models/gemini-2.5-flash'), { config: { thinkingBudget: 0 }, extraTokens: 0 });
  });

  test('3.5 / 3.6 Flash (and Flash-Lite) use the minimal thinking level', () => {
    for (const m of ['gemini-3.6-flash', 'gemini-3.5-flash', 'gemini-3.5-flash-lite'])
      assert.deepEqual(thinkingFor(m), { config: { thinkingLevel: 'minimal' }, extraTokens: 256 }, m);
  });

  test('other models omit the config and get output headroom', () => {
    for (const m of ['gemini-2.5-pro', 'gemini-3.8-flash', 'gemini-3-flash-preview', 'some-future-model']) {
      const t = thinkingFor(m);
      assert.equal(t.config, undefined, m);
      assert.ok(t.extraTokens > 0, m);
    }
  });

  test('an explicit level is passed as thinkingLevel', () => {
    assert.deepEqual(thinkingFor('gemini-3-flash', ' Minimal '), { config: { thinkingLevel: 'minimal' }, extraTokens: 256 });
  });

  test('the request carries the config and the raised token cap', async () => {
    const { fetchImpl, calls } = gemini(PROSE);
    await post(makeApp({ ...KEY, GEMINI_MODEL: 'gemini-3.8-flash' }, fetchImpl), ok);
    const cfg = calls[0].body.generationConfig;
    assert.equal(cfg.thinkingConfig, undefined);
    assert.equal(cfg.maxOutputTokens, 300 + 1024);
    assert.equal(cfg.temperature, undefined);
    assert.match(calls[0].url, /gemini-3\.8-flash:generateContent$/);
  });

  test('the default model is 3.6 Flash with minimal thinking', async () => {
    const { fetchImpl, calls } = gemini(PROSE);
    await post(makeApp(KEY, fetchImpl), ok);
    assert.match(calls[0].url, /\/models\/gemini-3\.6-flash:generateContent$/);
    assert.deepEqual(calls[0].body.generationConfig.thinkingConfig, { thinkingLevel: 'minimal' });
  });

  test('a hung model call times out with a user-facing upstream error', async () => {
    // a fetch that never answers; the interval stands in for the open socket that keeps the process alive
    const hang = ((_: string, init: RequestInit) =>
      new Promise((_, reject) => {
        const socket = setInterval(() => {}, 1000);
        init.signal!.addEventListener('abort', () => {
          clearInterval(socket);
          reject(init.signal!.reason);
        });
      })) as typeof fetch;
    const { generate } = await import('../server/gemini.ts');
    await assert.rejects(
      generate({ prompt: 'x', format: 'prose', length: 'short' }, { apiKey: 'k', model: 'm', timeoutMs: 50, fetchImpl: hang }),
      (e: any) => e.code === 'upstream' && e.userFacing && /too long/.test(e.message),
    );
  });
});
