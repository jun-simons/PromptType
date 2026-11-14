// Fixed-window rate limiting for /api/generate.
//
// In-memory counters are exact on a single Node process. On Cloudflare Workers
// each isolate has its own memory, so these limits are best-effort there; use
// the Workers Rate Limiting binding (see wrangler.toml) for per-IP limits, and
// rely on the no-billing Gemini key as the real ceiling.

export interface Window {
  /** max hits per window */
  limit: number;
  /** window length in ms */
  ms: number;
}

export interface LimitResult {
  ok: boolean;
  /** which rule rejected the request */
  rule?: 'minute' | 'day' | 'global';
  /** ms until the rejecting window resets */
  retryAfterMs?: number;
}

/** Counts hits per key in fixed windows aligned to `ms` boundaries. */
export class FixedWindow {
  private hits = new Map<string, { start: number; n: number }>();

  constructor(
    readonly win: Window,
    private maxKeys = 10_000,
  ) {}

  /** Remaining hits for a key, without consuming one. */
  check(key: string, now: number): { ok: boolean; retryAfterMs: number } {
    const start = now - (now % this.win.ms);
    const h = this.hits.get(key);
    const n = h && h.start === start ? h.n : 0;
    return { ok: n < this.win.limit, retryAfterMs: start + this.win.ms - now };
  }

  take(key: string, now: number): void {
    const start = now - (now % this.win.ms);
    const h = this.hits.get(key);
    if (h && h.start === start) h.n++;
    else this.hits.set(key, { start, n: 1 });
    if (this.hits.size > this.maxKeys) this.prune(now);
  }

  private prune(now: number) {
    const start = now - (now % this.win.ms);
    for (const [k, h] of this.hits) if (h.start !== start) this.hits.delete(k);
    // still too many distinct keys in the current window: drop the oldest entries
    for (const k of this.hits.keys()) {
      if (this.hits.size <= this.maxKeys) break;
      this.hits.delete(k);
    }
  }
}

export interface LimiterConfig {
  perMinute: number;
  perDay: number;
  globalPerDay: number;
}

const MINUTE = 60_000;
const DAY = 86_400_000;

/** Per-IP minute + day windows and one global daily window. A request consumes a hit only if all pass. */
export class GenerateLimiter {
  private minute: FixedWindow;
  private day: FixedWindow;
  private global: FixedWindow;

  constructor(readonly cfg: LimiterConfig) {
    this.minute = new FixedWindow({ limit: cfg.perMinute, ms: MINUTE });
    this.day = new FixedWindow({ limit: cfg.perDay, ms: DAY });
    this.global = new FixedWindow({ limit: cfg.globalPerDay, ms: DAY }, 1);
  }

  take(ip: string, now = Date.now()): LimitResult {
    const g = this.global.check('*', now);
    if (!g.ok) return { ok: false, rule: 'global', retryAfterMs: g.retryAfterMs };
    const d = this.day.check(ip, now);
    if (!d.ok) return { ok: false, rule: 'day', retryAfterMs: d.retryAfterMs };
    const m = this.minute.check(ip, now);
    if (!m.ok) return { ok: false, rule: 'minute', retryAfterMs: m.retryAfterMs };
    this.global.take('*', now);
    this.day.take(ip, now);
    this.minute.take(ip, now);
    return { ok: true };
  }
}

const num = (v: string | undefined, fallback: number) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

export function limiterConfig(env: { RATE_PER_MINUTE?: string; RATE_PER_DAY?: string; DAILY_GENERATION_LIMIT?: string }): LimiterConfig {
  return {
    perMinute: num(env.RATE_PER_MINUTE, 5),
    perDay: num(env.RATE_PER_DAY, 40),
    globalPerDay: num(env.DAILY_GENERATION_LIMIT, 400),
  };
}
