// Node entry: API in dev; API + built frontend (dist/) in production.

import { serve } from '@hono/node-server';
import { getConnInfo } from '@hono/node-server/conninfo';
import { serveStatic } from '@hono/node-server/serve-static';
import { existsSync } from 'node:fs';
import { createApp, type Env } from './app.ts';
import { DEFAULT_MODEL } from './gemini.ts';

try {
  process.loadEnvFile('.env');
} catch {
  /* no .env file — fine */
}

// Behind a reverse proxy set TRUST_PROXY=1 so per-IP limits use X-Forwarded-For.
// Otherwise the header is ignored, since any client could spoof it.
const trustProxy = process.env.TRUST_PROXY === '1';

const app = createApp({
  getEnv: () => process.env as Env,
  getIp: (c) => {
    if (trustProxy) {
      const xff = c.req.header('x-forwarded-for')?.split(',')[0]?.trim();
      if (xff) return xff;
    }
    try {
      return getConnInfo(c).remote.address ?? null;
    } catch {
      return null;
    }
  },
});

if (process.env.NODE_ENV === 'production' && existsSync('dist')) {
  app.use('/*', serveStatic({ root: './dist' }));
  app.get('*', serveStatic({ path: './dist/index.html' }));
}

// Dev: always API_PORT (default 8787, where Vite proxies /api). PORT is ignored there because
// tools that launch `npm run dev` set it for the web server. Production: hosts set PORT.
const prod = process.env.NODE_ENV === 'production';
const port = Number(process.env.API_PORT ?? (prod ? process.env.PORT : undefined) ?? 8787);
serve({ fetch: app.fetch, port }, () => {
  const ai = process.env.GEMINI_API_KEY ? `AI on (${process.env.GEMINI_MODEL || DEFAULT_MODEL})` : 'AI off (no GEMINI_API_KEY)';
  console.log(`promptype api on http://localhost:${port} — ${ai}`);
});
