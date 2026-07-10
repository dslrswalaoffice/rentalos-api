import { sql, query } from '../db.js';

// ============================================================================
// src/lib/analytics.ts  (Sub-turn 7) — business-intelligence query helpers
// ----------------------------------------------------------------------------
// Analytics answers "how is the business performing?" (owner-facing, historical
// + comparative), as opposed to the Command Center's "what needs attention now?"
//
// Everything here is COMPUTED ON DEMAND from the live tables — no analytics
// tables, no pre-aggregation. A small in-process cache (5 min) per
// (workspace, section, range) key smooths repeat loads; it is best-effort only
// (Vercel serverless recycles instances often), which is fine since the queries
// are cheap and the data is non-critical-to-be-fresh.
//
// Revenue basis (locked decision): rental line items
// (order_items.item_type = 'rental', using the line's total_amount_paise) from
// orders whose status is in {dispatched, active, returned, closed} and whose
// rental_start falls in the range. NOTE the spec called this column
// `line_total_paise`; the real schema column is `total_amount_paise` (the line
// total). Deposits and non-rental line items are excluded.
// ============================================================================

// The order statuses that count as "realised business" for revenue/analytics.
// Draft/quoted haven't committed; cancelled didn't happen. Kept inline in each
// query (Neon HTTP mis-serialises JS arrays cast to enum[]), listed here for
// documentation only.
const COMPLETED_STATUSES = ['dispatched', 'active', 'returned', 'closed'] as const;

// ---------------------------------------------------------------------------
// In-process cache
// ---------------------------------------------------------------------------
type CacheEntry = { value: unknown; expiresAt: number };
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 5 * 60 * 1000;

export function cacheKey(workspaceId: string, section: string, rangeStart: string, rangeEnd: string): string {
  return `${workspaceId}:${section}:${rangeStart}:${rangeEnd}`;
}

export async function withCache<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value as T;
  const value = await fn();
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

// ---------------------------------------------------------------------------
// Shared types
// ---------------------------------------------------------------------------
export type RevenueDailyPoint = { date: string; paise: number };
export type RevenueTopProduct = {
  product_id: string; name: string; category: string | null;
  paise: number; order_count: number;
};
export type RevenueCategory = { category: string; paise: number; product_count: number };

export type RevenueAnalysis = {
  total_paise: number;
  previous_paise: number;
  delta_paise: number;
  delta_pct: number | null;
  daily_trend: RevenueDailyPoint[];
  top_products: RevenueTopProduct[];
  by_category: RevenueCategory[];
};

export type UtilizationProduct = {
  product_id: string; name: string; category: string | null;
  capacity: number; unit_days_rented: number;
  available_unit_days: number; utilization_pct: number;
};
export type UtilizationAnalysis = {
  avg_utilization_pct: number;
  top_utilized: UtilizationProduct[];
  least_utilized: UtilizationProduct[];
  idle_products: UtilizationProduct[];
  all_products: UtilizationProduct[];
};

export type TopCustomer = {
  customer_id: string; name: string; tier: string | null;
  paise: number; order_count: number;
};
export type CustomerAnalysis = {
  total_customers: number;
  new_customers: number;
  returning_customers: number;
  repeat_rate_pct: number;
  top_customers: TopCustomer[];
};

export type OperationalHealth = {
  total_orders: number;
  avg_rental_days: number;
  avg_order_value_paise: number;
  cancellation_rate_pct: number;
  late_return_count: number;
  damage_forfeit_count: number;
};

// Cast helper — Neon HTTP wants explicit timestamptz for reliable comparisons.
const iso = (d: Date) => d.toISOString();

// ===========================================================================
// Section 1: Revenue analysis
// ===========================================================================
export async function getRevenueAnalysis(
  workspaceId: string, rangeStart: Date, rangeEnd: Date,
): Promise<RevenueAnalysis> {
  const durationMs = rangeEnd.getTime() - rangeStart.getTime();
  const prevRangeEnd = new Date(rangeStart.getTime() - 1);
  const prevRangeStart = new Date(prevRangeEnd.getTime() - durationMs);

  const [currentRevenue, previousRevenue, dailyTrend, topProducts, byCategory] = await Promise.all([
    totalRevenueInRange(workspaceId, rangeStart, rangeEnd),
    totalRevenueInRange(workspaceId, prevRangeStart, prevRangeEnd),
    revenueByDay(workspaceId, rangeStart, rangeEnd),
    topProductsByRevenue(workspaceId, rangeStart, rangeEnd, 5),
    revenueByCategory(workspaceId, rangeStart, rangeEnd),
  ]);

  return {
    total_paise: currentRevenue,
    previous_paise: previousRevenue,
    delta_paise: currentRevenue - previousRevenue,
    delta_pct: previousRevenue > 0
      ? ((currentRevenue - previousRevenue) / previousRevenue) * 100
      : null,
    daily_trend: dailyTrend,
    top_products: topProducts,
    by_category: byCategory,
  };
}

async function totalRevenueInRange(workspaceId: string, start: Date, end: Date): Promise<number> {
  const rows = await query<{ total: string | number }>(sql`
    SELECT COALESCE(SUM(oi.total_amount_paise), 0)::bigint AS total
    FROM order_items oi
    INNER JOIN orders o ON o.id = oi.order_id
    WHERE oi.workspace_id = ${workspaceId}::uuid
      AND oi.item_type = 'rental'
      AND o.status::text IN ('dispatched', 'active', 'returned', 'closed')
      AND o.deleted_at IS NULL
      AND o.rental_start >= ${iso(start)}::timestamptz
      AND o.rental_start <  ${iso(end)}::timestamptz
  `);
  return Number(rows[0]?.total ?? 0);
}

async function revenueByDay(workspaceId: string, start: Date, end: Date): Promise<RevenueDailyPoint[]> {
  const rows = await query<{ day: string; paise: string | number }>(sql`
    SELECT
      date_trunc('day', o.rental_start)::date AS day,
      COALESCE(SUM(oi.total_amount_paise), 0)::bigint AS paise
    FROM order_items oi
    INNER JOIN orders o ON o.id = oi.order_id
    WHERE oi.workspace_id = ${workspaceId}::uuid
      AND oi.item_type = 'rental'
      AND o.status::text IN ('dispatched', 'active', 'returned', 'closed')
      AND o.deleted_at IS NULL
      AND o.rental_start >= ${iso(start)}::timestamptz
      AND o.rental_start <  ${iso(end)}::timestamptz
    GROUP BY day
    ORDER BY day ASC
  `);
  return rows.map((r) => ({ date: String(r.day), paise: Number(r.paise) }));
}

async function topProductsByRevenue(
  workspaceId: string, start: Date, end: Date, limit: number,
): Promise<RevenueTopProduct[]> {
  const rows = await query<{
    product_id: string; product_name: string; category: string | null;
    paise: string | number; order_count: number;
  }>(sql`
    SELECT
      oi.product_id,
      p.name AS product_name,
      p.category,
      COALESCE(SUM(oi.total_amount_paise), 0)::bigint AS paise,
      COUNT(DISTINCT o.id)::int AS order_count
    FROM order_items oi
    INNER JOIN orders o   ON o.id = oi.order_id
    INNER JOIN products p ON p.id = oi.product_id
    WHERE oi.workspace_id = ${workspaceId}::uuid
      AND oi.item_type = 'rental'
      AND o.status::text IN ('dispatched', 'active', 'returned', 'closed')
      AND o.deleted_at IS NULL
      AND o.rental_start >= ${iso(start)}::timestamptz
      AND o.rental_start <  ${iso(end)}::timestamptz
    GROUP BY oi.product_id, p.name, p.category
    ORDER BY paise DESC
    LIMIT ${limit}::int
  `);
  return rows.map((r) => ({
    product_id: r.product_id,
    name: r.product_name,
    category: r.category,
    paise: Number(r.paise),
    order_count: Number(r.order_count),
  }));
}

async function revenueByCategory(workspaceId: string, start: Date, end: Date): Promise<RevenueCategory[]> {
  const rows = await query<{ category: string; paise: string | number; product_count: number }>(sql`
    SELECT
      COALESCE(p.category, 'Uncategorized') AS category,
      COALESCE(SUM(oi.total_amount_paise), 0)::bigint AS paise,
      COUNT(DISTINCT p.id)::int AS product_count
    FROM order_items oi
    INNER JOIN orders o   ON o.id = oi.order_id
    INNER JOIN products p ON p.id = oi.product_id
    WHERE oi.workspace_id = ${workspaceId}::uuid
      AND oi.item_type = 'rental'
      AND o.status::text IN ('dispatched', 'active', 'returned', 'closed')
      AND o.deleted_at IS NULL
      AND o.rental_start >= ${iso(start)}::timestamptz
      AND o.rental_start <  ${iso(end)}::timestamptz
    GROUP BY category
    ORDER BY paise DESC
  `);
  return rows.map((r) => ({ category: r.category, paise: Number(r.paise), product_count: Number(r.product_count) }));
}

// ===========================================================================
// Section 2: Utilization
// ---------------------------------------------------------------------------
// unit_days_rented / (capacity × days_in_range). Capacity is mode-aware
// (bulk → stock_quantity; tracked → live asset count) and WORKSPACE-WIDE
// (all locations), matching the "how busy is the whole business" intent. We
// count assets across every location rather than calling getProductCapacity
// (which resolves to the default location only) so multi-location workspaces
// aren't undercounted. Kits are excluded — their capacity is derived from
// components, which are counted on their own.
// ===========================================================================
export async function getUtilization(
  workspaceId: string, rangeStart: Date, rangeEnd: Date,
): Promise<UtilizationAnalysis> {
  const daysInRange = Math.max(1, Math.ceil((rangeEnd.getTime() - rangeStart.getTime()) / (24 * 60 * 60 * 1000)));

  // One pass: every non-kit product, its mode-aware workspace-wide capacity,
  // and its in-range unit-days rented (overlap-clipped to the range). Doing it
  // in SQL avoids the per-product query fan-out the spec's pseudo-code implied.
  const rows = await query<{
    product_id: string; name: string; category: string | null;
    capacity: number; unit_days: string | number;
  }>(sql`
    SELECT
      p.id AS product_id,
      p.name,
      p.category,
      CASE WHEN p.tracking_mode = 'bulk'
           THEN COALESCE(p.stock_quantity, 0)
           ELSE COALESCE(ac.asset_count, 0)
      END::int AS capacity,
      COALESCE(u.unit_days, 0)::float AS unit_days
    FROM products p
    LEFT JOIN LATERAL (
      SELECT COUNT(*)::int AS asset_count
      FROM assets a
      WHERE a.workspace_id = p.workspace_id
        AND a.product_id = p.id
        AND a.deleted_at IS NULL
    ) ac ON true
    LEFT JOIN LATERAL (
      SELECT SUM(
        oi.quantity *
        GREATEST(1, EXTRACT(EPOCH FROM (
          LEAST(o.rental_end, ${iso(rangeEnd)}::timestamptz)
          - GREATEST(o.rental_start, ${iso(rangeStart)}::timestamptz)
        )) / 86400.0)
      ) AS unit_days
      FROM order_items oi
      INNER JOIN orders o ON o.id = oi.order_id
      WHERE oi.workspace_id = p.workspace_id
        AND oi.product_id = p.id
        AND oi.item_type = 'rental'
        AND o.status::text IN ('dispatched', 'active', 'returned', 'closed')
        AND o.deleted_at IS NULL
        AND o.rental_end   > ${iso(rangeStart)}::timestamptz
        AND o.rental_start < ${iso(rangeEnd)}::timestamptz
    ) u ON true
    WHERE p.workspace_id = ${workspaceId}::uuid
      AND p.deleted_at IS NULL
      AND p.is_kit = false
  `);

  const results: UtilizationProduct[] = [];
  for (const r of rows) {
    const capacity = Number(r.capacity);
    if (capacity === 0) continue; // no capacity → utilization undefined; skip
    const unitDays = Number(r.unit_days);
    const availableUnitDays = capacity * daysInRange;
    const utilizationPct = availableUnitDays > 0 ? (unitDays / availableUnitDays) * 100 : 0;
    results.push({
      product_id: r.product_id,
      name: r.name,
      category: r.category,
      capacity,
      unit_days_rented: Math.round(unitDays * 100) / 100,
      available_unit_days: availableUnitDays,
      // Cap DISPLAY at 150% — shortage/overbook can push a product above 100%.
      utilization_pct: Math.min(150, Math.round(utilizationPct * 10) / 10),
    });
  }

  const totalCapacityDays = results.reduce((s, r) => s + r.available_unit_days, 0);
  const totalUnitDaysRented = results.reduce((s, r) => s + r.unit_days_rented, 0);
  const avgUtilization = totalCapacityDays > 0 ? (totalUnitDaysRented / totalCapacityDays) * 100 : 0;

  results.sort((a, b) => b.utilization_pct - a.utilization_pct);

  const IDLE_THRESHOLD = 20;
  const idle = results.filter((r) => r.utilization_pct < IDLE_THRESHOLD);

  return {
    avg_utilization_pct: Math.round(avgUtilization * 10) / 10,
    top_utilized: results.slice(0, 5),
    least_utilized: results.slice(-5).reverse(),
    idle_products: idle,
    all_products: results,
  };
}

// ===========================================================================
// Section 3: Customer intelligence
// ===========================================================================
export async function getCustomerAnalytics(
  workspaceId: string, rangeStart: Date, rangeEnd: Date,
): Promise<CustomerAnalysis> {
  const [currentRows, priorRows, topRows] = await Promise.all([
    query<{ customer_person_id: string }>(sql`
      SELECT DISTINCT o.customer_person_id
      FROM orders o
      WHERE o.workspace_id = ${workspaceId}::uuid
        AND o.deleted_at IS NULL
        AND o.status::text IN ('dispatched', 'active', 'returned', 'closed')
        AND o.rental_start >= ${iso(rangeStart)}::timestamptz
        AND o.rental_start <  ${iso(rangeEnd)}::timestamptz
    `),
    query<{ customer_person_id: string }>(sql`
      SELECT DISTINCT o.customer_person_id
      FROM orders o
      WHERE o.workspace_id = ${workspaceId}::uuid
        AND o.deleted_at IS NULL
        AND o.status::text IN ('dispatched', 'active', 'returned', 'closed')
        AND o.rental_start < ${iso(rangeStart)}::timestamptz
    `),
    query<{
      customer_person_id: string; customer_name: string; tier: string | null;
      paise: string | number; order_count: number;
    }>(sql`
      SELECT
        o.customer_person_id,
        p.display_name AS customer_name,
        p.tier,
        COALESCE(SUM(oi.total_amount_paise), 0)::bigint AS paise,
        COUNT(DISTINCT o.id)::int AS order_count
      FROM order_items oi
      INNER JOIN orders o ON o.id = oi.order_id
      INNER JOIN people p ON p.id = o.customer_person_id
      WHERE oi.workspace_id = ${workspaceId}::uuid
        AND oi.item_type = 'rental'
        AND o.status::text IN ('dispatched', 'active', 'returned', 'closed')
        AND o.deleted_at IS NULL
        AND o.rental_start >= ${iso(rangeStart)}::timestamptz
        AND o.rental_start <  ${iso(rangeEnd)}::timestamptz
      GROUP BY o.customer_person_id, p.display_name, p.tier
      ORDER BY paise DESC
      LIMIT 10
    `),
  ]);

  const currentCustomerIds = new Set(currentRows.map((r) => r.customer_person_id));
  const priorCustomerIds = new Set(priorRows.map((r) => r.customer_person_id));

  let newCount = 0, returningCount = 0;
  for (const id of currentCustomerIds) {
    if (priorCustomerIds.has(id)) returningCount++;
    else newCount++;
  }

  const topCustomers: TopCustomer[] = topRows.map((r) => ({
    customer_id: r.customer_person_id,
    name: r.customer_name,
    tier: r.tier,
    paise: Number(r.paise),
    order_count: Number(r.order_count),
  }));

  // Repeat rate: of the customers active in range, how many have 2+ completed
  // orders across all time.
  const repeatRows = await query<{ c: number }>(sql`
    SELECT COUNT(*)::int AS c FROM (
      SELECT o.customer_person_id
      FROM orders o
      WHERE o.workspace_id = ${workspaceId}::uuid
        AND o.deleted_at IS NULL
        AND o.status::text IN ('dispatched', 'active', 'returned', 'closed')
        AND o.customer_person_id IN (
          SELECT DISTINCT customer_person_id FROM orders
          WHERE workspace_id = ${workspaceId}::uuid
            AND deleted_at IS NULL
            AND rental_start >= ${iso(rangeStart)}::timestamptz
            AND rental_start <  ${iso(rangeEnd)}::timestamptz
        )
      GROUP BY o.customer_person_id
      HAVING COUNT(*) >= 2
    ) sub
  `);
  const repeatCount = Number(repeatRows[0]?.c ?? 0);
  const repeatRate = currentCustomerIds.size > 0 ? (repeatCount / currentCustomerIds.size) * 100 : 0;

  return {
    total_customers: currentCustomerIds.size,
    new_customers: newCount,
    returning_customers: returningCount,
    repeat_rate_pct: Math.round(repeatRate * 10) / 10,
    top_customers: topCustomers,
  };
}

// ===========================================================================
// Section 4: Operational health
// ===========================================================================
export async function getOperationalHealth(
  workspaceId: string, rangeStart: Date, rangeEnd: Date,
): Promise<OperationalHealth> {
  const orderRows = await query<{
    id: string; status: string; total_paise: string | number;
    rental_start: string | null; rental_end: string | null; deposit_status: string;
  }>(sql`
    SELECT id, status::text AS status, total_paise, rental_start, rental_end, deposit_status
    FROM orders
    WHERE workspace_id = ${workspaceId}::uuid
      AND deleted_at IS NULL
      AND rental_start >= ${iso(rangeStart)}::timestamptz
      AND rental_start <  ${iso(rangeEnd)}::timestamptz
  `);

  const total = orderRows.length;
  if (total === 0) {
    return {
      total_orders: 0, avg_rental_days: 0, avg_order_value_paise: 0,
      cancellation_rate_pct: 0, late_return_count: 0, damage_forfeit_count: 0,
    };
  }

  const completedOrders = orderRows.filter((o) =>
    (COMPLETED_STATUSES as readonly string[]).includes(o.status),
  );
  const cancelledOrders = orderRows.filter((o) => o.status === 'cancelled');

  const durations = completedOrders
    .filter((o) => o.rental_start && o.rental_end)
    .map((o) => {
      const start = new Date(o.rental_start!).getTime();
      const end = new Date(o.rental_end!).getTime();
      return Math.max(1, (end - start) / (24 * 60 * 60 * 1000));
    });
  const avgDays = durations.length > 0 ? durations.reduce((s, d) => s + d, 0) / durations.length : 0;

  const values = completedOrders.map((o) => Number(o.total_paise));
  const avgValue = values.length > 0 ? values.reduce((s, v) => s + v, 0) / values.length : 0;

  const cancellationRate = total > 0 ? (cancelledOrders.length / total) * 100 : 0;

  // Late returns: a return-batch timeline event landed after the order's
  // rental_end. order_events uses `occurred_at` and the timeline event_type is
  // `order.return.batch` / `order.item.returned` (NOT `return.%`).
  const lateRows = await query<{ c: number }>(sql`
    SELECT COUNT(DISTINCT o.id)::int AS c
    FROM orders o
    WHERE o.workspace_id = ${workspaceId}::uuid
      AND o.deleted_at IS NULL
      AND o.rental_start >= ${iso(rangeStart)}::timestamptz
      AND o.rental_start <  ${iso(rangeEnd)}::timestamptz
      AND o.status::text IN ('returned', 'closed')
      AND o.rental_end IS NOT NULL
      AND EXISTS (
        SELECT 1 FROM order_events e
        WHERE e.order_id = o.id
          AND e.event_type LIKE 'order.return.%'
          AND e.occurred_at > o.rental_end
      )
  `);
  const lateReturnCount = Number(lateRows[0]?.c ?? 0);

  const damageForfeitCount = orderRows.filter((o) =>
    ['fully_forfeited', 'partial_forfeited'].includes(o.deposit_status),
  ).length;

  return {
    total_orders: total,
    avg_rental_days: Math.round(avgDays * 10) / 10,
    avg_order_value_paise: Math.round(avgValue),
    cancellation_rate_pct: Math.round(cancellationRate * 10) / 10,
    late_return_count: lateReturnCount,
    damage_forfeit_count: damageForfeitCount,
  };
}

// ===========================================================================
// CSV export helper
// ===========================================================================
export function toCSV(rows: Array<Record<string, unknown>>, columns: string[]): string {
  const escape = (val: unknown): string => {
    if (val == null) return '';
    const s = String(val);
    if (s.includes(',') || s.includes('"') || s.includes('\n')) {
      return `"${s.replace(/"/g, '""')}"`;
    }
    return s;
  };
  const header = columns.join(',');
  const lines = rows.map((row) => columns.map((col) => escape(row[col])).join(','));
  return [header, ...lines].join('\n');
}
