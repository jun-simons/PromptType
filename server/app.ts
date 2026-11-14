// Runtime-agnostic HTTP app (works on Node and Cloudflare Workers).

import { Hono, type Context } from 'hono';
import { FORMATS, LENGTHS, MAX_PROMPT_CHARS, type Format, type GenerateError, type Length } from '../shared/types.ts';
import { DEFAULT_MODEL, generate, GenerationError } from './gemini.ts';
import { GenerateLimiter, limiterConfig, type LimiterConfig } from './ratelimit.ts';

/** Cloudflare Workers Rate Limiting binding (optional, see wrangler.toml). */
export interface RateLimitBinding {
  limit(opts: { key: string }): Promise<{ success: boolean }>;
}

export interface Env {
  GEMINI_API_KEY?: string;
  GEMINI_MODEL?: string;
  /** force a Gemini 3 thinkingLevel ("minimal", "low", ...); see thinkingFor() */
  GEMINI_THINKING_LEVEL?: string;
  /** override the Gemini endpoint origin (a proxy, or a mock for local testing) */
  GEMINI_BASE_URL?: string;
  /** global cap on generations per UTC day */
  DAILY_GENERATION_LIMIT?: string;
  /** per-IP caps */
  RATE_PER_MINUTE?: string;
  RATE_PER_DAY?: string;
  GENERATE_LIMITER?: RateLimitBinding;
}

export interface AppOptions {
  getEnv: (c: Context) => Env;
  /** client IP used for per-IP limits; return null when unknown */
  getIp: (c: Context) => string | null;
  fetchImpl?: typeof fetch;
  now?: () => number;
}

const MAX_BODY_BYTES = 2048;

export function createApp(opts: AppOptions) {
  const app = new Hono();
  const now = opts.now ?? Date.now;

  // one limiter per process/isolate; rebuilt only if the configured limits change
  let limiter: GenerateLimiter | null = null;
  const limiterFor = (cfg: LimiterConfig) => {
    const same = limiter && JSON.stringify(limiter.cfg) === JSON.stringify(cfg);
    if (!same) limiter = new GenerateLimiter(cfg);
    return limiter!;
  };

  app.get('/api/health', (c) => {
    const env = opts.getEnv(c);
    return c.json({ ai: Boolean(env.GEMINI_API_KEY) });
  });

  app.post('/api/generate', async (c) => {
    const env = opts.getEnv(c);
    const fail = (status: 400 | 413 | 429 | 502 | 503, err: GenerateError, retryAfterMs?: number) => {
      if (retryAfterMs) c.header('Retry-After', String(Math.ceil(retryAfterMs / 1000)));
      return c.json(err, status);
    };

    if (!env.GEMINI_API_KEY) return fail(503, { error: 'disabled', message: 'AI generation is not configured on this server.' });

    const raw = await c.req.text();
    if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return fail(413, { error: 'bad_request', message: 'Request too large.' });

    let body: { prompt?: unknown; format?: unknown; length?: unknown };
    try {
      body = JSON.parse(raw);
    } catch {
      return fail(400, { error: 'bad_request', message: 'Invalid JSON.' });
    }
    if (!body || typeof body !== 'object') return fail(400, { error: 'bad_request', message: 'Invalid JSON.' });

    const prompt = typeof body.prompt === 'string' ? body.prompt.replace(/\s+/g, ' ').trim() : '';
    if (!prompt) return fail(400, { error: 'bad_request', message: 'Prompt is required.' });
    if (prompt.length > MAX_PROMPT_CHARS)
      return fail(400, { error: 'bad_request', message: `Prompt must be at most ${MAX_PROMPT_CHARS} characters.` });
    if (!FORMATS.includes(body.format as Format)) return fail(400, { error: 'bad_request', message: 'Invalid format.' });
    if (!LENGTHS.includes(body.length as Length)) return fail(400, { error: 'bad_request', message: 'Invalid length.' });

    // rate limits, checked only for valid requests so typos don't burn quota
    const ip = opts.getIp(c) ?? 'unknown';
    if (env.GENERATE_LIMITER) {
      const { success } = await env.GENERATE_LIMITER.limit({ key: ip });
      if (!success) return fail(429, { error: 'limit', message: 'Too many generations, wait a minute. The library still works.' }, 60_000);
    }
    const verdict = limiterFor(limiterConfig(env)).take(ip, now());
    if (!verdict.ok) {
      const message =
        verdict.rule === 'minute'
          ? 'Too many generations, wait a minute. The library still works.'
          : verdict.rule === 'day'
            ? 'Daily generation limit reached for you. The library still works.'
            : 'Daily generation limit reached on this server. The library still works.';
      return fail(429, { error: 'limit', message }, verdict.retryAfterMs);
    }

    try {
      const content = await generate(
        { prompt, format: body.format as Format, length: body.length as Length },
        {
          apiKey: env.GEMINI_API_KEY,
          model: env.GEMINI_MODEL || DEFAULT_MODEL,
          thinkingLevel: env.GEMINI_THINKING_LEVEL,
          baseUrl: env.GEMINI_BASE_URL,
          fetchImpl: opts.fetchImpl,
        },
      );
      return c.json(content);
    } catch (e) {
      if (e instanceof GenerationError && e.code === 'quota') return fail(429, { error: 'quota', message: e.message });
      console.error('[generate]', e instanceof Error ? e.message : e);
      const message = e instanceof GenerationError && e.userFacing ? e.message : 'Generation failed. Please try again.';
      return fail(502, { error: 'upstream', message });
    }
  });

  return app;
}
