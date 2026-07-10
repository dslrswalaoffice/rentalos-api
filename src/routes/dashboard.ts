import { Hono } from 'hono';
import { sql, query } from '../db.js';
import { checkAvailability } from '../lib/availability.js';
import {
  sessionMiddleware,
  requireAuth,
  type SessionUser,
  type SessionWorkspace,
} from '../middleware/session.js';

// ============================================================================
// src/routes/dashboard.ts  (Sub-turn 5a — Command Center)
// ----------------------------------------------------------------------------
// GET /api/dashboard — one call, six operator-briefing widgets:
//   1. returning_today    2. dispatching_today   3. overdue_returns
//   4. overbook_warnings  5. unpaid_balance      6. revenue_week
//
// Read-only, session-scoped, no audit. All widget queries run in parallel.
//
// Item-status note: order_item_status has NO 'active' value (that's an *order*
// status). The only non-terminal, awaiting-return item state is 'dispatched',
// so "still out" is `oi.status = 'dispatched'` (spec's ...IN('dispatched',
// 'active') adapted to the real enum).
// ============================================================================

type SessionVar = {
  sessionId: string;
  user: SessionUser;
  workspace: SessionWorkspace;
} | null;

type Env = { Variables: { session: SessionVar } };

export const dashboard = new Hono<Env>();
dashboard.use('*', sessionMiddleware, requireAuth);

// ----------------------------------------------------------------------------
// Timezone helpers.
// TODO: fetch timezone from workspace.settings.timezone once that field is
// added. Hardcoded IST for DSLRSWALA workspace #1.
// ----------------------------------------------------------------------------
const IST_OFFSET_HOURS = 5.5;
const IST_MS = IST_OFFSET_HOURS * 3600 * 1000;

function getKolkataDayBounds(date: Date): { start: Date; end: Date } {
  const istNow = new Date(date.getTime() + IST_MS);
  const y = istNow.getUTCFullYear();
  const m = istNow.getUTCMonth();
  const d = istNow.getUTCDate();
  const dayStartIST = new Date(Date.UTC(y, m, d, 0, 0, 0)); // 00:00 IST as UTC clock
  const dayStartUTC = new Date(dayStartIST.getTime() - IST_MS);
  const dayEndUTC = new Date(dayStartUTC.getTime() + 24 * 3600 * 1000 - 1);
  return { start: dayStartUTC, end: dayEndUTC };
}

function getKolkataWeekStart(date: Date): Date {
  const istNow = new Date(date.getTime() + IST_MS);
  const dow = istNow.getUTCDay();          // 0 = Sunday
  const daysFromMonday = (dow + 6) % 7;    // Monday = 0
  const y = istNow.getUTCFullYear();
  const m = istNow.getUTCMonth();
  const d = istNow.getUTCDate() - daysFromMonday;
  const mondayIST = new Date(Date.UTC(y, m, d, 0, 0, 0));
  return new Date(mondayIST.getTime() - IST_MS);
}

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------
type OrderWidgetRow = {
  id: string;
  order_number: number;
  rental_start: string;
  rental_end: string;
  customer_name: string;
  status: string;
  pending_count: number;
  days_overdue?: number;
};

type Warning = {
  product_id: string;
  product_name: string;
  conflict_start: string;
  conflict_end: string;
  total_units: number;
  requested_units: number;
};

// ----------------------------------------------------------------------------
// Widget 4: overbook sweep over the next 14 days, sourced from the shared
// availability engine (single source of truth for reserving statuses + buffer).
// ----------------------------------------------------------------------------
async function overbookWarnings(workspaceId: string, from: Date, to: Date): Promise<Warning[]> {
  const products = await query<{ id: string; name: string }>(sql`
    SELECT id, name
    FROM products
    WHERE workspace_id = ${workspaceId}::uuid
      AND is_active = true
      AND deleted_at IS NULL
    ORDER BY name ASC
  `);

  const results = await Promise.all(
    products.map((p) =>
      checkAvailability({
        workspaceId,
        productId: p.id,
        quantity: 1, // ignored — we only read `.conflicts` / `.capacity`
        start: from,
        end: to,
      }).catch(() => null),
    ),
  );

  const warnings: Warning[] = [];
  products.forEach((p, i) => {
    const res = results[i];
    if (!res) return;
    const events: { t: number; d: number }[] = [];
    for (const c of res.conflicts) {
      events.push({ t: new Date(c.start).getTime(), d: c.quantity });
      events.push({ t: new Date(c.end).getTime(), d: -c.quantity });
    }
    events.sort((a, b) => a.t - b.t || a.d - b.d); // releases before reservations at a tie
    let running = 0;
    let open: { start: number; peak: number } | null = null;
    for (const e of events) {
      running += e.d;
      if (running > res.capacity) {
        if (!open) open = { start: e.t, peak: running };
        else open.peak = Math.max(open.peak, running);
      } else if (open) {
        warnings.push({
          product_id: p.id,
          product_name: p.name,
          conflict_start: new Date(open.start).toISOString(),
          conflict_end: new Date(e.t).toISOString(),
          total_units: res.capacity,
          requested_units: open.peak,
        });
        open = null;
      }
    }
  });
  return warnings;
}

// ============================================================================
// GET /api/dashboard
// ============================================================================
dashboard.get('/', async (c) => {
  const session = c.get('session')!;
  const wsId = session.workspace.id;

  const now = new Date();
  const today = getKolkataDayBounds(now);
  const thisMonday = getKolkataWeekStart(now);
  const lastMonday = new Date(thisMonday.getTime() - 7 * 24 * 3600 * 1000);
  const in14Days = new Date(now.getTime() + 14 * 24 * 3600 * 1000);

  const todayStart = today.start.toISOString();
  const todayEnd = today.end.toISOString();
  const thisMondayIso = thisMonday.toISOString();
  const lastMondayIso = lastMonday.toISOString();
  const nowIso = now.toISOString();

  const [
    returningToday,
    dispatchingToday,
    overdueReturns,
    warnings,
    unpaidAgg,
    unpaidTop5,
    revThisWeek,
    revLastWeek,
  ] = await Promise.all([
    // Widget 1 — returning today (rental_end today, still-out items)
    query<OrderWidgetRow>(sql`
      SELECT o.id, o.order_number, o.rental_start, o.rental_end,
             p.display_name AS customer_name, o.status::text AS status,
             COUNT(oi.id) FILTER (WHERE oi.status = 'dispatched')::int AS pending_count
      FROM orders o
      JOIN people p ON p.id = o.customer_person_id
      JOIN order_items oi ON oi.order_id = o.id
      WHERE o.workspace_id = ${wsId}::uuid
        AND o.deleted_at IS NULL
        AND o.status::text NOT IN ('draft', 'cancelled', 'closed')
        AND o.rental_end >= ${todayStart}::timestamptz
        AND o.rental_end <= ${todayEnd}::timestamptz
      GROUP BY o.id, p.display_name
      HAVING COUNT(oi.id) FILTER (WHERE oi.status = 'dispatched') > 0
      ORDER BY o.rental_end ASC
    `),

    // Widget 2 — dispatching today (rental_start today, pending-dispatch items)
    query<OrderWidgetRow>(sql`
      SELECT o.id, o.order_number, o.rental_start, o.rental_end,
             p.display_name AS customer_name, o.status::text AS status,
             COUNT(oi.id) FILTER (WHERE oi.status = 'pending_dispatch')::int AS pending_count
      FROM orders o
      JOIN people p ON p.id = o.customer_person_id
      JOIN order_items oi ON oi.order_id = o.id
      WHERE o.workspace_id = ${wsId}::uuid
        AND o.deleted_at IS NULL
        AND o.status::text IN ('confirmed', 'dispatched', 'active')
        AND o.rental_start >= ${todayStart}::timestamptz
        AND o.rental_start <= ${todayEnd}::timestamptz
      GROUP BY o.id, p.display_name
      HAVING COUNT(oi.id) FILTER (WHERE oi.status = 'pending_dispatch') > 0
      ORDER BY o.rental_start ASC
    `),

    // Widget 3 — overdue returns (rental_end < now, still-out items)
    query<OrderWidgetRow>(sql`
      SELECT o.id, o.order_number, o.rental_start, o.rental_end,
             p.display_name AS customer_name, o.status::text AS status,
             COUNT(oi.id) FILTER (WHERE oi.status = 'dispatched')::int AS pending_count,
             (EXTRACT(EPOCH FROM (now() - o.rental_end)) / 86400)::float8 AS days_overdue
      FROM orders o
      JOIN people p ON p.id = o.customer_person_id
      JOIN order_items oi ON oi.order_id = o.id
      WHERE o.workspace_id = ${wsId}::uuid
        AND o.deleted_at IS NULL
        AND o.status::text NOT IN ('draft', 'cancelled', 'closed')
        AND o.rental_end < now()
      GROUP BY o.id, p.display_name
      HAVING COUNT(oi.id) FILTER (WHERE oi.status = 'dispatched') > 0
      ORDER BY o.rental_end ASC
    `),

    // Widget 4 — overbook warnings (next 14 days)
    overbookWarnings(wsId, now, in14Days),

    // Widget 5 — unpaid balance aggregate
    query<{ total_unpaid: number }>(sql`
      SELECT COALESCE(SUM(balance_paise), 0)::bigint AS total_unpaid
      FROM orders
      WHERE workspace_id = ${wsId}::uuid
        AND deleted_at IS NULL
        AND status::text IN ('dispatched', 'active', 'returned', 'closed')
        AND balance_paise > 0
    `),

    // Widget 5 — unpaid balance top 5
    query<{
      id: string; order_number: number; rental_start: string; rental_end: string;
      customer_name: string; balance_paise: number; total_paise: number; status: string;
    }>(sql`
      SELECT o.id, o.order_number, o.rental_start, o.rental_end,
             p.display_name AS customer_name,
             o.balance_paise, o.total_paise, o.status::text AS status
      FROM orders o
      JOIN people p ON p.id = o.customer_person_id
      WHERE o.workspace_id = ${wsId}::uuid
        AND o.deleted_at IS NULL
        AND o.status::text IN ('dispatched', 'active', 'returned', 'closed')
        AND o.balance_paise > 0
      ORDER BY o.balance_paise DESC
      LIMIT 5
    `),

    // Widget 6 — this week's revenue (net completed payments)
    query<{ revenue: number }>(sql`
      SELECT COALESCE(SUM(CASE WHEN direction = 'in' THEN amount_paise ELSE -amount_paise END), 0)::bigint AS revenue
      FROM payments
      WHERE workspace_id = ${wsId}::uuid
        AND status = 'completed'
        AND occurred_at >= ${thisMondayIso}::timestamptz
        AND occurred_at <= ${nowIso}::timestamptz
    `),

    // Widget 6 — last week's revenue (Monday..this Monday)
    query<{ revenue: number }>(sql`
      SELECT COALESCE(SUM(CASE WHEN direction = 'in' THEN amount_paise ELSE -amount_paise END), 0)::bigint AS revenue
      FROM payments
      WHERE workspace_id = ${wsId}::uuid
        AND status = 'completed'
        AND occurred_at >= ${lastMondayIso}::timestamptz
        AND occurred_at < ${thisMondayIso}::timestamptz
    `),
  ]);

  const thisWeek = Number(revThisWeek[0]?.revenue ?? 0);
  const lastWeek = Number(revLastWeek[0]?.revenue ?? 0);
  const deltaPct = lastWeek > 0
    ? Math.round(((thisWeek - lastWeek) / lastWeek) * 1000) / 10
    : null; // null → "no baseline" (frontend renders a grey dash)

  return c.json({
    generated_at: nowIso,
    returning_today: { orders: returningToday, count: returningToday.length },
    dispatching_today: { orders: dispatchingToday, count: dispatchingToday.length },
    overdue_returns: { orders: overdueReturns, count: overdueReturns.length },
    overbook_warnings: { warnings, count: warnings.length },
    unpaid_balance: {
      total_unpaid_paise: Number(unpaidAgg[0]?.total_unpaid ?? 0),
      top_5: unpaidTop5.map((r) => ({ ...r, balance_paise: Number(r.balance_paise), total_paise: Number(r.total_paise) })),
    },
    revenue_week: {
      this_week_paise: thisWeek,
      last_week_paise: lastWeek,
      delta_pct: deltaPct,
    },
  });
});
