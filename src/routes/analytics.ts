import { Hono } from 'hono';
import type { Context } from 'hono';
import {
  sessionMiddleware,
  requireAuth,
  requireRole,
  type SessionUser,
  type SessionWorkspace,
} from '../middleware/session.js';
import {
  getRevenueAnalysis,
  getUtilization,
  getCustomerAnalytics,
  getOperationalHealth,
  getProductRoi,
  DEFAULT_ROI_THRESHOLDS,
  type RoiThresholds,
  cacheKey,
  withCache,
  toCSV,
} from '../lib/analytics.js';
import { sql, query } from '../db.js';

// ============================================================================
// src/routes/analytics.ts  (Sub-turn 7) — mounted at /api/analytics
// ----------------------------------------------------------------------------
// Owner/manager only. Read-only: no writes, no audit events for viewing.
// Four section endpoints + a CSV export per section. Every response is computed
// on demand and wrapped in a 5-minute in-process cache keyed on
// (workspace, section, range).
// ============================================================================

type SessionVar = {
  sessionId: string;
  user: SessionUser;
  workspace: SessionWorkspace;
} | null;

type Env = { Variables: { session: SessionVar } };

export const analytics = new Hono<Env>();

// Auth + role gate: owner/manager only. Staff / client / investor → 403.
analytics.use('*', sessionMiddleware, requireAuth, requireRole('owner', 'manager'));

// Default range = last 30 days. Custom range via ?start=ISO&end=ISO.
function parseRange(c: Context): { start: Date; end: Date } | null {
  const startStr = c.req.query('start');
  const endStr = c.req.query('end');

  const now = new Date();
  const defaultEnd = now;
  const defaultStart = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

  const start = startStr ? new Date(startStr) : defaultStart;
  const end = endStr ? new Date(endStr) : defaultEnd;

  if (isNaN(start.getTime()) || isNaN(end.getTime()) || start.getTime() >= end.getTime()) {
    return null;
  }
  return { start, end };
}

const rangeKey = (r: { start: Date; end: Date }) =>
  ({ s: r.start.toISOString(), e: r.end.toISOString() });

const csvFilename = (section: string, r: { start: Date; end: Date }) =>
  `${section}-${r.start.toISOString().slice(0, 10)}-to-${r.end.toISOString().slice(0, 10)}.csv`;

// ---------------------------------------------------------------------------
// Product ROI (Sub-turn 11). Owner/manager only (inherited from the mount).
// Not range-scoped (lifetime revenue). One settings query + two set-based
// aggregate queries = 3 total, constant regardless of product count. NOT cached
// (cost edits must reflect immediately).
// ---------------------------------------------------------------------------
analytics.get('/product-roi', async (c) => {
  const session = c.get('session')!;
  const wsRows = await query<{ settings: Record<string, any> | null }>(sql`
    SELECT settings FROM workspaces WHERE id = ${session.workspace.id}::uuid LIMIT 1
  `);
  const raw = wsRows[0]?.settings?.analytics?.roi_thresholds ?? {};
  const thresholds: RoiThresholds = {
    min_months: Number.isFinite(Number(raw.min_months)) ? Number(raw.min_months) : DEFAULT_ROI_THRESHOLDS.min_months,
    healthy_recovered_pct: Number.isFinite(Number(raw.healthy_recovered_pct)) ? Number(raw.healthy_recovered_pct) : DEFAULT_ROI_THRESHOLDS.healthy_recovered_pct,
    watch_recovered_pct: Number.isFinite(Number(raw.watch_recovered_pct)) ? Number(raw.watch_recovered_pct) : DEFAULT_ROI_THRESHOLDS.watch_recovered_pct,
  };
  const data = await getProductRoi(session.workspace.id, thresholds);
  return c.json({ ...data, thresholds });
});

// ---------------------------------------------------------------------------
// Section JSON endpoints
// ---------------------------------------------------------------------------
analytics.get('/revenue', async (c) => {
  const session = c.get('session')!;
  const range = parseRange(c);
  if (!range) return c.json({ error: 'invalid_range' }, 400);
  const { s, e } = rangeKey(range);
  const data = await withCache(cacheKey(session.workspace.id, 'revenue', s, e),
    () => getRevenueAnalysis(session.workspace.id, range.start, range.end));
  return c.json(data);
});

analytics.get('/utilization', async (c) => {
  const session = c.get('session')!;
  const range = parseRange(c);
  if (!range) return c.json({ error: 'invalid_range' }, 400);
  const { s, e } = rangeKey(range);
  const data = await withCache(cacheKey(session.workspace.id, 'utilization', s, e),
    () => getUtilization(session.workspace.id, range.start, range.end));
  return c.json(data);
});

analytics.get('/customers', async (c) => {
  const session = c.get('session')!;
  const range = parseRange(c);
  if (!range) return c.json({ error: 'invalid_range' }, 400);
  const { s, e } = rangeKey(range);
  const data = await withCache(cacheKey(session.workspace.id, 'customers', s, e),
    () => getCustomerAnalytics(session.workspace.id, range.start, range.end));
  return c.json(data);
});

analytics.get('/operational', async (c) => {
  const session = c.get('session')!;
  const range = parseRange(c);
  if (!range) return c.json({ error: 'invalid_range' }, 400);
  const { s, e } = rangeKey(range);
  const data = await withCache(cacheKey(session.workspace.id, 'operational', s, e),
    () => getOperationalHealth(session.workspace.id, range.start, range.end));
  return c.json(data);
});

// ---------------------------------------------------------------------------
// CSV exports. Content-Disposition attachment so the browser downloads.
// ---------------------------------------------------------------------------
function csvResponse(c: Context, section: string, range: { start: Date; end: Date }, csv: string) {
  return c.body(csv, 200, {
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${csvFilename(section, range)}"`,
  });
}

analytics.get('/revenue/csv', async (c) => {
  const session = c.get('session')!;
  const range = parseRange(c);
  if (!range) return c.json({ error: 'invalid_range' }, 400);
  const data = await getRevenueAnalysis(session.workspace.id, range.start, range.end);
  const csv = toCSV(data.daily_trend, ['date', 'paise']);
  return csvResponse(c, 'revenue', range, csv);
});

analytics.get('/utilization/csv', async (c) => {
  const session = c.get('session')!;
  const range = parseRange(c);
  if (!range) return c.json({ error: 'invalid_range' }, 400);
  const data = await getUtilization(session.workspace.id, range.start, range.end);
  const csv = toCSV(
    data.all_products,
    ['product_id', 'name', 'category', 'capacity', 'unit_days_rented', 'available_unit_days', 'utilization_pct'],
  );
  return csvResponse(c, 'utilization', range, csv);
});

analytics.get('/customers/csv', async (c) => {
  const session = c.get('session')!;
  const range = parseRange(c);
  if (!range) return c.json({ error: 'invalid_range' }, 400);
  const data = await getCustomerAnalytics(session.workspace.id, range.start, range.end);
  const csv = toCSV(data.top_customers, ['customer_id', 'name', 'tier', 'paise', 'order_count']);
  return csvResponse(c, 'customers', range, csv);
});
