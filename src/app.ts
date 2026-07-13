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
import { integrations } from './routes/integrations.js';
import { reminders } from './routes/reminders.js';
import { customFields } from './routes/custom_fields.js';
import { locations } from './routes/locations.js';
import { analytics } from './routes/analytics.js';
import { downtimes } from './routes/downtimes.js';
import { tags } from './routes/tags.js';
import { coupons } from './routes/coupons.js';
import { pricing } from './routes/pricing.js';
import { recommendations } from './routes/recommendations.js';
import { invitations } from './routes/invitations.js';
import { members } from './routes/members.js';
import { config } from './lib/config.js';
import { sql } from './db.js';
import { analyticsMiddleware } from './middleware/analytics.js';
export const app = new Hono();
// Request logging in dev only. Prod: rely on Vercel logs.
if (config.isDev) {
  app.use('*', logger());
}
// Vercel Web Analytics middleware to track API requests
app.use('*', analyticsMiddleware);
// Global security headers. Keep this small; add more as we know we need them.
app.use('*', async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('X-Frame-Options', 'DENY');
  c.header('Referrer-Policy', 'strict-origin-when-cross-origin');
});
// Health check — Neon/Vercel probes + the keep-warm cron hit this. No auth
// (registered before any session middleware). The SELECT 1 exercises the Neon
// HTTP driver so an external pinger keeps the DATABASE compute awake too, not
// just the Vercel function — an autosuspended Neon compute wakes on this query.
// A DB failure returns 503 (ok:false) so the pinger/monitoring can see it
// instead of a health check that lies about a dead database.
app.get('/api/health', async (c) => {
  try {
    await sql`SELECT 1`;
    return c.json({ ok: true, ts: new Date().toISOString() });
  } catch {
    return c.json({ ok: false, ts: new Date().toISOString(), error: 'db_unreachable' }, 503);
  }
});
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
app.route('/api/integrations', integrations);
app.route('/api/reminders', reminders);
app.route('/api/custom-fields', customFields);
app.route('/api/locations', locations);
app.route('/api/analytics', analytics);
app.route('/api/downtimes', downtimes);
app.route('/api/tags', tags);
app.route('/api/coupons', coupons);
app.route('/api/pricing', pricing);
app.route('/api/recommendations', recommendations);
app.route('/api/invitations', invitations);
app.route('/api/members', members);
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
