// ============================================================================
// src/lib/product_analytics.ts (Product analytics) — per-SKU utilization + YTD
// revenue, BATCHED for list endpoints.
// ----------------------------------------------------------------------------
// The product-grain sibling of src/lib/asset_analytics.ts. Same Reporting Engine,
// a different resource type — NOT a parallel engine. Two set-based queries for N
// products (never a per-row fan-out); the batch key idiom
// (= ANY(string_to_array(csv,',')::uuid[])) matches asset_analytics.ts.
//
// - Utilization = unit_days_rented / (capacity × days) over a trailing window,
//   reusing getUtilization()'s proven mode-aware capacity + overlap-clipped
//   unit-days SQL. Capacity is workspace-wide (all locations), mode-aware
//   (bulk → Σ stock_levels; tracked → live asset count). Kits are EXCLUDED here
//   (their capacity is derived from components) → the caller renders "—".
// - YTD revenue = SUM(order_items.total_amount_paise) GROUP BY product_id — a
//   line already carries its own product_id + total, so no cross-line attribution
//   is needed (unlike the per-asset line-share). Kits get their own revenue.
// - YTD boundary is Asia/Kolkata (the workspace's operating tz), NOT UTC — a UTC
//   year boundary skews the window ~5.5h at the edges. (Locked to Asia/Kolkata
//   this sub-turn; when multi-tenant matures this should read workspaces.timezone.)
//
// Never throws — a metrics failure yields an empty Map so the list still renders
// (fail-soft; the row shows null metrics, not an error).
// ============================================================================

import { sql, query } from '../db.js';

export type ProductMetrics = {
  // null = kit or zero-capacity (utilization undefined). Otherwise 0-150 (capped).
  utilization_percent: number | null;
  ytd_revenue_paise: number;
};

// Best-effort 5-min cache (matches asset_analytics.ts + analytics.ts posture;
// Vercel recycles instances, so this only smooths repeat loads).
const cache = new Map<string, { at: number; data: Map<string, ProductMetrics> }>();
const TTL_MS = 5 * 60 * 1000;

/**
 * Batch utilization + YTD revenue for a set of products. Returns a Map keyed by
 * product_id; products absent from a sub-result default to the zero/null shape
 * at the call site. Two set-based queries total, regardless of product count.
 * Kits are absent from the utilization query (→ utilization_percent null) but
 * present in the revenue query.
 */
export async function computeProductMetricsBatch(
  workspaceId: string,
  productIds: string[],
  days = 30,
  now = Date.now(),
): Promise<Map<string, ProductMetrics>> {
  const out = new Map<string, ProductMetrics>();
  if (!productIds.length) return out;

  const key = `${workspaceId}:${[...productIds].sort().join(',')}:${days}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < TTL_MS) return hit.data;

  const csv = productIds.join(',');
  try {
    // Query 1 — utilization. Reuses getUtilization()'s mode-aware capacity +
    // overlap-clipped unit-days, constrained to this page's products, over the
    // trailing `days` window. Kits excluded (is_kit = false).
    const util = await query<{ product_id: string; capacity: number; unit_days: number }>(sql`
      SELECT
        p.id AS product_id,
        CASE WHEN p.tracking_method = 'bulk'
             THEN COALESCE(sl.stock_total, 0)
             ELSE COALESCE(ac.asset_count, 0)
        END::int AS capacity,
        COALESCE(u.unit_days, 0)::float AS unit_days
      FROM products p
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS asset_count
        FROM assets a
        WHERE a.workspace_id = p.workspace_id AND a.product_id = p.id AND a.deleted_at IS NULL
      ) ac ON true
      LEFT JOIN LATERAL (
        SELECT COALESCE(SUM(sl2.quantity), 0)::int AS stock_total
        FROM stock_levels sl2
        JOIN locations l2 ON l2.id = sl2.location_id
        WHERE sl2.product_id = p.id AND l2.workspace_id = p.workspace_id
      ) sl ON true
      LEFT JOIN LATERAL (
        SELECT SUM(
          oi.quantity *
          GREATEST(1, EXTRACT(EPOCH FROM (
            LEAST(o.rental_end, now())
            - GREATEST(o.rental_start, now() - make_interval(days => ${days}::int))
          )) / 86400.0)
        ) AS unit_days
        FROM order_items oi
        INNER JOIN orders o ON o.id = oi.order_id
        WHERE oi.workspace_id = p.workspace_id
          AND oi.product_id = p.id
          AND oi.item_type = 'rental'
          AND o.status::text IN ('dispatched', 'active', 'returned', 'closed')
          AND o.deleted_at IS NULL
          AND o.rental_end   > now() - make_interval(days => ${days}::int)
          AND o.rental_start < now()
      ) u ON true
      WHERE p.workspace_id = ${workspaceId}::uuid
        AND p.deleted_at IS NULL
        AND p.is_kit = false
        AND p.id = ANY(string_to_array(${csv}::text, ',')::uuid[])
    `);

    // Query 2 — YTD revenue (Asia/Kolkata year boundary). Kits included.
    const rev = await query<{ product_id: string; ytd_revenue_paise: number }>(sql`
      SELECT oi.product_id,
             COALESCE(SUM(oi.total_amount_paise), 0)::bigint AS ytd_revenue_paise
      FROM order_items oi
      INNER JOIN orders o ON o.id = oi.order_id
      WHERE oi.workspace_id = ${workspaceId}::uuid
        AND oi.product_id = ANY(string_to_array(${csv}::text, ',')::uuid[])
        AND oi.item_type = 'rental'
        AND o.status::text IN ('dispatched', 'active', 'returned', 'closed')
        AND o.deleted_at IS NULL
        AND o.rental_start >= (date_trunc('year', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')
      GROUP BY oi.product_id
    `);
    const revMap = new Map(rev.map((r) => [r.product_id, Number(r.ytd_revenue_paise)]));

    for (const r of util) {
      const capacity = Number(r.capacity);
      const utilizationPercent = capacity > 0
        ? Math.min(150, Math.round(((Number(r.unit_days) / (capacity * days)) * 100) * 10) / 10)
        : null; // zero capacity → utilization undefined
      out.set(r.product_id, { utilization_percent: utilizationPercent, ytd_revenue_paise: revMap.get(r.product_id) ?? 0 });
    }
    // Products with revenue but no utilization row (kits, or excluded above).
    for (const [pid, paise] of revMap) {
      if (!out.has(pid)) out.set(pid, { utilization_percent: null, ytd_revenue_paise: paise });
    }

    cache.set(key, { at: now, data: out });
  } catch (e) {
    console.error('[product_analytics] batch metrics failed', e);
  }
  return out;
}

/**
 * Single-product convenience wrapper over the batch (for a future product detail
 * endpoint). Returns the zero/null shape if the product has no history.
 */
export async function computeSingleProductMetrics(
  workspaceId: string,
  productId: string,
  days = 30,
): Promise<ProductMetrics> {
  const map = await computeProductMetricsBatch(workspaceId, [productId], days);
  return map.get(productId) ?? { utilization_percent: null, ytd_revenue_paise: 0 };
}
