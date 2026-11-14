// Cloudflare Workers entry (optional deployment target).
// Static files from dist/ are served by Workers Static Assets (see wrangler.toml);
// only /api/* reaches this code. Set the key with: npx wrangler secret put GEMINI_API_KEY

import { createApp, type Env } from './app.ts';

const app = createApp({
  getEnv: (c) => c.env as Env,
  // set by Cloudflare's edge, not spoofable by the client
  getIp: (c) => c.req.header('cf-connecting-ip') ?? null,
});

export default app;
