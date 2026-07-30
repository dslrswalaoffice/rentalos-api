// ============================================================================
// src/lib/asset_analytics.ts (Asset List S1) — per-unit utilization + revenue.
// ----------------------------------------------------------------------------
// The per-SKU analogue of src/lib/analytics.ts, at the ASSET grain. Reuses the
// same revenue basis (order_items.total_amount_paise on rental lines of earned
// orders) but ATTRIBUTES a line's revenue equally across the units assigned to
// it via order_assets (exact line-share, not a payments guess — payments are
// per-order and can't be split per unit). Utilization = unit days out / days in
// range. Everything is set-based + BATCHED (one query for N assets) so the list
// endpoint never loops per row. Never throws — a metrics failure yields zeros so
// one bad asset can't fail the whole list (fail-soft).
// ============================================================================

import { sql, query } from '../db.js';

// ---------------------------------------------------------------------------
// Asset lifecycle attention (Phase 2 S1) — warranty + maintenance-due flags.
// These are intrinsic per-asset DATE fields (not order-history), so they are a
// PURE date comparison against the workspace's asset_attention_policy thresholds.
// Kept as a shared helper so the assets LIST and the asset-360 DETAIL compute the
// exact same flags, and so it is unit-testable with no DB. Postgres DATE columns
// arrive over the Neon HTTP driver as 'YYYY-MM-DD' strings.
// ---------------------------------------------------------------------------
export type AssetAttentionPolicy = { warranty_expiring_days: number; maintenance_due_days: number };
export type AssetLifecycleFlags = {
  warranty_expiring: boolean;   // within threshold, not yet expired
  warranty_expired: boolean;    // past the date
  maintenance_due: boolean;     // within threshold, not yet overdue
  maintenance_overdue: boolean; // past the date
};

export const DEFAULT_ASSET_ATTENTION_POLICY: AssetAttentionPolicy = { warranty_expiring_days: 30, maintenance_due_days: 14 };

/** Read + validate the thresholds from workspace.settings (falls back to defaults). */
export function readAssetAttentionPolicy(settings: unknown): AssetAttentionPolicy {
  const p = (settings as Record<string, any> | null)?.asset_attention_policy ?? {};
  const num = (v: unknown, d: number) => { const x = Number(v); return Number.isFinite(x) && x >= 0 ? x : d; };
  return {
    warranty_expiring_days: num(p.warranty_expiring_days, DEFAULT_ASSET_ATTENTION_POLICY.warranty_expiring_days),
    maintenance_due_days: num(p.maintenance_due_days, DEFAULT_ASSET_ATTENTION_POLICY.maintenance_due_days),
  };
}

function dateOnlyUTC(d: Date): number {
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

/** Compute the four lifecycle flags for one asset. Null dates => all false (a unit
 *  with no warranty/service data never raises attention). "Expires today" counts
 *  as expiring, not expired. */
export function computeAssetLifecycleFlags(
  dates: { warranty_expiry?: string | null; next_service_due?: string | null },
  policy: AssetAttentionPolicy,
  now: Date = new Date(),
): AssetLifecycleFlags {
  const flags: AssetLifecycleFlags = { warranty_expiring: false, warranty_expired: false, maintenance_due: false, maintenance_overdue: false };
  const today = dateOnlyUTC(now);
  const DAY = 86400000;
  const parse = (s?: string | null): number | null => {
    if (!s) return null;
    const t = new Date(`${String(s).slice(0, 10)}T00:00:00Z`).getTime();
    return Number.isNaN(t) ? null : t;
  };
  const w = parse(dates.warranty_expiry);
  if (w != null) {
    if (w < today) flags.warranty_expired = true;
    else if (w <= today + policy.warranty_expiring_days * DAY) flags.warranty_expiring = true;
  }
  const s = parse(dates.next_service_due);
  if (s != null) {
    if (s < today) flags.maintenance_overdue = true;
    else if (s <= today + policy.maintenance_due_days * DAY) flags.maintenance_due = true;
  }
  return flags;
}

export type AssetMetrics = {
  utilization_percent: number;   // 0-100+ (a unit can't exceed 100 but we don't clamp)
  revenue_paise: number;         // line-share revenue in the window
  last_used_at: string | null;   // most recent dispatched_at
};

/**
 * Batch metrics for a set of assets over a trailing window (days). Returns a Map
 * keyed by asset_id; assets with no history are absent (caller defaults to zero).
 * Two set-based queries total, regardless of asset count.
 */
export async function computeAssetMetricsBatch(
  workspaceId: string,
  assetIds: string[],
  days = 30,
): Promise<Map<string, AssetMetrics>> {
  const out = new Map<string, AssetMetrics>();
  if (!assetIds.length) return out;
  const csv = assetIds.join(',');
  try {
    // Revenue (line-share) + last_used, windowed by dispatch date.
    const rev = await query<{ asset_id: string; revenue_paise: number; last_used_at: string | null }>(sql`
      SELECT oa.asset_id,
             COALESCE(SUM(oi.total_amount_paise::numeric / NULLIF(cnt.n, 0)), 0)::bigint AS revenue_paise,
             MAX(oa.dispatched_at) AS last_used_at
      FROM order_assets oa
      JOIN order_items oi ON oi.id = oa.order_item_id
      JOIN orders o ON o.id = oa.order_id
      JOIN (SELECT order_item_id, COUNT(*) AS n FROM order_assets WHERE workspace_id = ${workspaceId}::uuid GROUP BY order_item_id) cnt
        ON cnt.order_item_id = oa.order_item_id
      WHERE oa.workspace_id = ${workspaceId}::uuid
        AND oa.asset_id = ANY(string_to_array(${csv}::text, ',')::uuid[])
        AND oi.item_type = 'rental'
        AND o.status::text IN ('dispatched', 'active', 'returned', 'closed')
        AND oa.dispatched_at IS NOT NULL
        -- YTD boundary in Asia/Kolkata (the workspace operating tz), not UTC —
        -- a UTC year boundary skews the window ~5.5h at the edges. (Locked to
        -- Asia/Kolkata; should read workspaces.timezone when multi-tenant matures.)
        AND oa.dispatched_at >= (date_trunc('year', now() AT TIME ZONE 'Asia/Kolkata') AT TIME ZONE 'Asia/Kolkata')
      GROUP BY oa.asset_id
    `);
    // Utilization: unit-days out clipped to the trailing window / window days.
    const util = await query<{ asset_id: string; unit_days: number }>(sql`
      SELECT oa.asset_id,
             COALESCE(SUM(
               GREATEST(0, EXTRACT(EPOCH FROM (
                 LEAST(COALESCE(oa.returned_at, now()), now())
                 - GREATEST(oa.dispatched_at, now() - make_interval(days => ${days}::int))
               )) / 86400.0)
             ), 0) AS unit_days
      FROM order_assets oa
      WHERE oa.workspace_id = ${workspaceId}::uuid
        AND oa.asset_id = ANY(string_to_array(${csv}::text, ',')::uuid[])
        AND oa.dispatched_at IS NOT NULL
        AND oa.dispatched_at < now()
        AND COALESCE(oa.returned_at, now()) > now() - make_interval(days => ${days}::int)
      GROUP BY oa.asset_id
    `);
    const utilMap = new Map(util.map((u) => [u.asset_id, Number(u.unit_days)]));
    for (const r of rev) {
      out.set(r.asset_id, {
        revenue_paise: Number(r.revenue_paise),
        last_used_at: r.last_used_at,
        utilization_percent: Math.round(((utilMap.get(r.asset_id) ?? 0) / days) * 100),
      });
    }
    // Assets with utilization but no in-year revenue.
    for (const [id, ud] of utilMap) {
      if (!out.has(id)) out.set(id, { revenue_paise: 0, last_used_at: null, utilization_percent: Math.round((ud / days) * 100) });
    }
  } catch (e) {
    console.error('[asset_analytics] batch metrics failed', e);
  }
  return out;
}

export type AssetLifetimeMetrics = {
  total_revenue_paise: number;
  total_days_utilized: number;
  total_rentals_count: number;
  total_damage_incidents: number;
  total_maintenance_days: number;
  average_revenue_per_rental_paise: number;
};

// Best-effort 15-min cache (Vercel recycles instances — same posture as analytics.ts).
const lifetimeCache = new Map<string, { at: number; data: AssetLifetimeMetrics }>();
const LIFETIME_TTL_MS = 15 * 60 * 1000;

/** Full lifetime metrics for one asset (Asset-360). Never throws. */
export async function computeAssetLifetimeMetrics(
  workspaceId: string,
  assetId: string,
  now = Date.now(),
): Promise<AssetLifetimeMetrics> {
  const key = `${workspaceId}:${assetId}`;
  const hit = lifetimeCache.get(key);
  if (hit && now - hit.at < LIFETIME_TTL_MS) return hit.data;
  const zero: AssetLifetimeMetrics = { total_revenue_paise: 0, total_days_utilized: 0, total_rentals_count: 0, total_damage_incidents: 0, total_maintenance_days: 0, average_revenue_per_rental_paise: 0 };
  try {
    const rev = (await query<{ revenue_paise: number; rentals: number; days: number }>(sql`
      SELECT COALESCE(SUM(oi.total_amount_paise::numeric / NULLIF(cnt.n, 0)), 0)::bigint AS revenue_paise,
             COUNT(*)::int AS rentals,
             COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(oa.returned_at, now()) - oa.dispatched_at)) / 86400.0), 0) AS days
      FROM order_assets oa
      JOIN order_items oi ON oi.id = oa.order_item_id
      JOIN orders o ON o.id = oa.order_id
      JOIN (SELECT order_item_id, COUNT(*) AS n FROM order_assets WHERE workspace_id = ${workspaceId}::uuid GROUP BY order_item_id) cnt
        ON cnt.order_item_id = oa.order_item_id
      WHERE oa.workspace_id = ${workspaceId}::uuid AND oa.asset_id = ${assetId}::uuid
        AND oi.item_type = 'rental' AND o.status::text IN ('dispatched', 'active', 'returned', 'closed') AND oa.dispatched_at IS NOT NULL
    `))[0];
    const dmg = (await query<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM damage_incident_assets WHERE workspace_id = ${workspaceId}::uuid AND asset_id = ${assetId}::uuid
    `))[0];
    const maint = (await query<{ days: number }>(sql`
      SELECT COALESCE(SUM(EXTRACT(EPOCH FROM (COALESCE(end_at, now()) - start_at)) / 86400.0), 0) AS days
      FROM product_downtimes WHERE workspace_id = ${workspaceId}::uuid AND asset_id = ${assetId}::uuid
    `))[0];
    const rentals = Number(rev?.rentals ?? 0);
    const revenue = Number(rev?.revenue_paise ?? 0);
    const data: AssetLifetimeMetrics = {
      total_revenue_paise: revenue,
      total_days_utilized: Math.round(Number(rev?.days ?? 0)),
      total_rentals_count: rentals,
      total_damage_incidents: Number(dmg?.n ?? 0),
      total_maintenance_days: Math.round(Number(maint?.days ?? 0)),
      average_revenue_per_rental_paise: rentals > 0 ? Math.round(revenue / rentals) : 0,
    };
    lifetimeCache.set(key, { at: now, data });
    return data;
  } catch (e) {
    console.error('[asset_analytics] lifetime metrics failed', e);
    return zero;
  }
}
