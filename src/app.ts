import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { auth } from './routes/auth.js';
import { inventory } from './routes/inventory.js';
import { people } from './routes/people.js';
import { orders } from './routes/orders.js';
import { payments } from './routes/payments.js';
import { invoices } from './routes/invoices.js';
import { workspace } from './routes/workspace.js';
import { dashboard } from './routes/dashboard.js';
import { notifications } from './routes/notifications.js';
import { calendar } from './routes/calendar.js';
import { availability } from './routes/availability.js';
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
app.route('/api/people', people);
app.route('/api/orders', orders);
app.route('/api/order-payments', payments);
app.route('/api/order-invoices', invoices);
app.route('/api/workspace', workspace);
app.route('/api/dashboard', dashboard);
app.route('/api/notifications', notifications);
app.route('/api/calendar', calendar);
app.route('/api/availability', availability);
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
