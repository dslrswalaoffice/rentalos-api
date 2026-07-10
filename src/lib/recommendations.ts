import { sql, query } from '../db.js';

// ============================================================================
// src/lib/recommendations.ts  (Sub-turn 8c) — "customers also rented"
// ----------------------------------------------------------------------------
// Two sources, merged (manual first, then co-rental auto-fill up to a cap):
//   * Manual — workspace-curated rows in product_recommendations.
//   * Co-rental — computed on demand from the last 180 days of completed
//     orders, cached 24h per (workspace, product). No cron, no pre-aggregation.
//
// Both sources exclude inactive / soft-deleted products (locked decision #11).
// At low order volume the co-rental side is legitimately empty — manual
// curation covers the gap until real history accumulates.
// ============================================================================

// Order statuses that count as a realised rental (mirrors the analytics basis)
// are inlined in the SQL below: 'dispatched', 'active', 'returned', 'closed'.

const CO_RENTAL_WINDOW_DAYS = 180; // hardcoded in MVP
const CO_RENTAL_MIN_OCCURRENCES = 2; // below this = statistical noise
const MAX_RECOMMENDATIONS = 6;

// ---------------------------------------------------------------------------
// 24h in-process cache (best-effort; Vercel recycles instances).
// ---------------------------------------------------------------------------
type CacheEntry = { value: unknown; expiresAt: number };
const cache = new Map<string, CacheEntry>();
const CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function cacheKey(workspaceId: string, productId: string): string {
  return `reco:${workspaceId}:${productId}`;
}

async function withCache<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const hit = cache.get(key);
  if (hit && hit.expiresAt > Date.now()) return hit.value as T;
  const value = await fn();
  cache.set(key, { value, expiresAt: Date.now() + CACHE_TTL_MS });
  return value;
}

/** Drop cached recommendations for one product, or the whole workspace. Called
 *  after any manual-curation mutation so the combined list refreshes at once. */
export function invalidateRecommendationsCache(workspaceId: string, productId?: string): void {
  if (productId) {
    cache.delete(cacheKey(workspaceId, productId));
    return;
  }
  const prefix = `reco:${workspaceId}:`;
  for (const k of cache.keys()) {
    if (k.startsWith(prefix)) cache.delete(k);
  }
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
export type ManualRecommendation = {
  product_id: string;
  name: string;
  category: string | null;
  image_url: string | null;
  daily_rate: number | null;
  source: 'manual';
  note: string | null;
  sort_order: number;
};

export type CoRentalRecommendation = {
  product_id: string;
  name: string;
  category: string | null;
  image_url: string | null;
  daily_rate: number | null;
  source: 'co_rental';
  confidence: number; // 0.00–1.00
  co_occurrences: number;
  base_orders: number;
};

export type Recommendation = ManualRecommendation | CoRentalRecommendation;

// ---------------------------------------------------------------------------
// Manual recommendations
// ---------------------------------------------------------------------------
export async function loadManualRecommendations(
  workspaceId: string,
  sourceProductId: string,
): Promise<ManualRecommendation[]> {
  const rows = await query<{
    product_id: string; sort_order: number; note: string | null;
    product_name: string; category: string | null; image_url: string | null;
    daily_rate: number | null;
  }>(sql`
    SELECT
      pr.recommended_product_id AS product_id,
      pr.sort_order,
      pr.note,
      p.name AS product_name,
      p.category,
      p.image_url,
      p.daily_rate
    FROM product_recommendations pr
    INNER JOIN products p ON p.id = pr.recommended_product_id
    WHERE pr.workspace_id = ${workspaceId}::uuid
      AND pr.source_product_id = ${sourceProductId}::uuid
      AND p.deleted_at IS NULL
      AND p.is_active = true
    ORDER BY pr.sort_order ASC, p.name ASC
  `);
  return rows.map((r) => ({
    product_id: r.product_id,
    name: r.product_name,
    category: r.category,
    image_url: r.image_url,
    daily_rate: r.daily_rate != null ? Number(r.daily_rate) : null,
    source: 'manual' as const,
    note: r.note,
    sort_order: Number(r.sort_order),
  }));
}

// ---------------------------------------------------------------------------
// Co-rental (computed on demand)
// ---------------------------------------------------------------------------
export async function computeCoRentalRecommendations(
  workspaceId: string,
  sourceProductId: string,
  limit = 10,
): Promise<CoRentalRecommendation[]> {
  const cutoff = new Date(Date.now() - CO_RENTAL_WINDOW_DAYS * 24 * 60 * 60 * 1000).toISOString();

  // How many completed orders included this product in the window?
  const baseRows = await query<{ c: number }>(sql`
    SELECT COUNT(DISTINCT o.id)::int AS c
    FROM order_items oi
    INNER JOIN orders o ON o.id = oi.order_id
    WHERE oi.workspace_id = ${workspaceId}::uuid
      AND oi.product_id = ${sourceProductId}::uuid
      AND oi.item_type = 'rental'
      AND o.status::text IN ('dispatched', 'active', 'returned', 'closed')
      AND o.deleted_at IS NULL
      AND o.rental_start >= ${cutoff}::timestamptz
  `);
  const baseCount = Number(baseRows[0]?.c ?? 0);
  if (baseCount < CO_RENTAL_MIN_OCCURRENCES) return [];

  // For every OTHER product co-appearing in those orders, count co-occurrences.
  const coRows = await query<{
    product_id: string; product_name: string; category: string | null;
    image_url: string | null; daily_rate: number | null; co_occurrences: number;
  }>(sql`
    SELECT
      oi2.product_id,
      p.name AS product_name,
      p.category,
      p.image_url,
      p.daily_rate,
      COUNT(DISTINCT o.id)::int AS co_occurrences
    FROM order_items oi
    INNER JOIN orders o ON o.id = oi.order_id
    INNER JOIN order_items oi2 ON oi2.order_id = o.id
      AND oi2.workspace_id = oi.workspace_id
      AND oi2.product_id != oi.product_id
      AND oi2.item_type = 'rental'
    INNER JOIN products p ON p.id = oi2.product_id
    WHERE oi.workspace_id = ${workspaceId}::uuid
      AND oi.product_id = ${sourceProductId}::uuid
      AND oi.item_type = 'rental'
      AND o.status::text IN ('dispatched', 'active', 'returned', 'closed')
      AND o.deleted_at IS NULL
      AND o.rental_start >= ${cutoff}::timestamptz
      AND p.deleted_at IS NULL
      AND p.is_active = true
    GROUP BY oi2.product_id, p.name, p.category, p.image_url, p.daily_rate
    HAVING COUNT(DISTINCT o.id) >= ${CO_RENTAL_MIN_OCCURRENCES}::int
    ORDER BY co_occurrences DESC, p.name ASC
    LIMIT ${limit}::int
  `);

  return coRows.map((r) => ({
    product_id: r.product_id,
    name: r.product_name,
    category: r.category,
    image_url: r.image_url,
    daily_rate: r.daily_rate != null ? Number(r.daily_rate) : null,
    source: 'co_rental' as const,
    confidence: Math.round((Number(r.co_occurrences) / baseCount) * 100) / 100,
    co_occurrences: Number(r.co_occurrences),
    base_orders: baseCount,
  }));
}

// ---------------------------------------------------------------------------
// Combined (cached): manual first, then co-rental auto-fill, deduped, capped.
// ---------------------------------------------------------------------------
export async function loadRecommendations(
  workspaceId: string,
  sourceProductId: string,
  maxTotal: number = MAX_RECOMMENDATIONS,
): Promise<Recommendation[]> {
  // Always cache the canonical MAX_RECOMMENDATIONS-length list per
  // (workspace, product); callers slice to their own smaller limit so the
  // cache key stays stable regardless of the requested size.
  const full = await withCache(cacheKey(workspaceId, sourceProductId), async () => {
    const manual = await loadManualRecommendations(workspaceId, sourceProductId);
    if (manual.length >= MAX_RECOMMENDATIONS) return manual.slice(0, MAX_RECOMMENDATIONS);

    const manualIds = new Set(manual.map((m) => m.product_id));
    const remaining = MAX_RECOMMENDATIONS - manual.length;
    // Over-fetch so the dedup filter still leaves enough to fill the slots.
    const coRental = await computeCoRentalRecommendations(workspaceId, sourceProductId, remaining * 2 + 2);
    const filtered = coRental.filter((r) => !manualIds.has(r.product_id)).slice(0, remaining);
    return [...manual, ...filtered] as Recommendation[];
  });
  return full.slice(0, Math.max(0, Math.min(maxTotal, MAX_RECOMMENDATIONS)));
}
