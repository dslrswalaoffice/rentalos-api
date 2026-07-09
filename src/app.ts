import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { auth } from './routes/auth.js';
import { inventory } from './routes/inventory.js';
import { admin } from './routes/admin.js';
import { config } from './lib/config.js';

export const app = new Hono();

// Request logging in dev only. Prod: rely on Vercel logs.
if (config.isDev) {
  app.use('*', logger());
}

// Global security headers. Keep this small; add more as we know we need them.
app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
});

// Health check — Neon/Vercel probes hit this.
app.get('/api/health', (c) => c.json({ ok: true, ts: new Date().toISOString() }));

// Modules
app.route('/api/auth', auth);
app.route('/api/inventory', inventory);
app.route('/api/admin', admin);

// Fallback for unknown /api/* — keep it JSON so clients can parse it.
app.notFound((c) => {
  if (c.req.path.startsWith('/api/')) {
    return c.json({ error: 'not_found', path: c.req.path }, 404);
  }
  return c.text('Not found', 404);
});

app.onError((err, c) => {
  console.error('[api error]', err);
  return c.json({ error: 'internal_error' }, 500);
});
