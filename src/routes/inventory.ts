import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { sql, query } from '../db.js';
import { audit } from '../lib/audit.js';
import { put, del } from '@vercel/blob';
import { loadCustomFieldValues, upsertCustomFieldValues } from '../lib/custom_fields.js';
import { getDefaultLocationId } from '../lib/availability.js';
import { loadRecommendations } from '../lib/recommendations.js';
import {
  loadTagsForEntity,
  loadTagsForEntities,
  filterEntityIdsByTags,
  parseTagIdsParam,
  replaceEntityTags,
} from '../lib/tags.js';
import {
  sessionMiddleware,
  requireAuth,
  type SessionUser,
  type SessionWorkspace,
} from '../middleware/session.js';
import { requirePermission, can } from '../lib/permissions.js';

type SessionVar = {
  sessionId: string;
  user: SessionUser;
  workspace: SessionWorkspace;
} | null;

type Env = {
  Variables: {
    session: SessionVar;
  };
};

export const inventory = new Hono<Env>();

// Every route in this module requires an authenticated session.
inventory.use('*', sessionMiddleware, requireAuth);

// Grab client IP + UA once for audit rows.
function clientCtx(c: Context) {
  const ipAddress =
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    c.req.header('x-real-ip') ??
    null;
  const userAgent = c.req.header('user-agent') ?? null;
  return { ipAddress, userAgent };
}

// ============================================================================
// SKU generation. Human-readable, URL-safe, workspace-unique.
// "Sony FX3 Body" → "SONY-FX3-BODY"
// ============================================================================
function generateSku(name: string): string {
  return name
    .toUpperCase()
    .replace(/&/g, ' AND ')
    .replace(/[^A-Z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60) || 'UNNAMED';
}

/**
 * Build a list of asset codes starting at index N.
 * assetCodesFor('SONY-FX3-BODY', 3, 1) → ['SONY-FX3-BODY-01', ..-02, ..-03]
 */
function assetCodesFor(sku: string, count: number, startAt = 1): string[] {
  return Array.from({ length: count }, (_, i) =>
    `${sku}-${String(startAt + i).padStart(2, '0')}`
  );
}

// The row shape we return for product list rows (with unit counts).
type ProductRow = {
  id: string;
  sku: string;
  name: string;
  category: string;
  description: string | null;
  daily_rate: number;
  deposit: number;
  replacement_value: number | null;
  specifications: Record<string, unknown>;
  notes: string | null;
  image_url: string | null;
  hsn_code: string | null;
  buffer_before_hours: number;
  buffer_after_hours: number;
  shortage_limit: number;
  default_purchase_cost_paise: number | null; // Sub-turn 11 — fallback unit cost
  nature: string;                    // Sub-turn 13
  tracking_method: string | null;
  pricing_method: string;
  base_price_paise: number | null;
  charge_period: string | null;
  gst_rate_bps: number | null;
  is_taxable: boolean;
  security_deposit_value_paise: number | null;
  gst_rate_missing: boolean;
  is_active: boolean;
  is_kit: boolean;
  component_count: number;
  created_at: string;
  updated_at: string;
  total_units: number;
  available_units: number;
  rented_units: number;
  offline_units: number;
  effective_capacity: number;
  location_names?: string | null; // Sub-turn 6i — distinct asset locations (list view)
};

// Max rows returned by the products list. Kept in sync with the `LIMIT` in the
// query below. When the filtered set exceeds this, the response reports the true
// total so the client can flag truncation (full pagination is a later item).
const LIST_LIMIT = 200;

// ============================================================================
// GET /api/inventory/products — list products for current workspace
// Query params: ?search=fx3 &category=Camera%20Body &include_archived=true
// ============================================================================
inventory.get('/products', async (c) => {
  const session = c.get('session')!;
  const search = c.req.query('search')?.trim() || null;
  const category = c.req.query('category')?.trim() || null;
  const includeArchived = c.req.query('include_archived') === 'true';
  const locationId = c.req.query('location_id')?.trim() || null; // Sub-turn 6i
  const searchPattern = search ? `%${search}%` : null;

  // Tag filter (Sub-turn 8a) — AND semantics. Resolve matching product ids up
  // front (the driver can't nest sql fragments), then constrain the main query.
  const tagIds = parseTagIdsParam(c.req.queries('tag_ids'));
  let tagMatchCsv: string | null = null;
  if (tagIds.length) {
    const ids = await filterEntityIdsByTags(session.workspace.id, 'product', tagIds);
    if (ids.length === 0) {
      return c.json({ products: [], total: 0, returned: 0, limit: LIST_LIMIT, by_category: {} });
    }
    tagMatchCsv = ids.join(',');
  }

  const products = await query<ProductRow>(sql`
    SELECT
      p.id, p.sku, p.name, p.category, p.description,
      p.daily_rate, p.deposit, p.replacement_value,
      p.specifications, p.notes, p.image_url, p.hsn_code,
      p.buffer_before_hours, p.buffer_after_hours, p.shortage_limit,
      p.default_purchase_cost_paise,
      -- Sub-turn 13: product model + per-product GST. gst_rate_missing warns the
      -- UI that a taxable product has no rate (it's billed at the workspace
      -- default until set — never 0%, which would be a compliance violation).
      p.nature::text AS nature, p.tracking_method::text AS tracking_method,
      p.pricing_method::text AS pricing_method, p.base_price_paise, p.charge_period::text AS charge_period,
      p.pricing_structure_id, p.pricing_ruleset_id,
      p.gst_rate_bps, p.is_taxable, p.security_deposit_value_paise,
      (p.is_taxable AND p.gst_rate_bps IS NULL) AS gst_rate_missing,
      p.is_active, p.is_kit,
      (SELECT COUNT(*) FROM product_kit_items pki WHERE pki.kit_product_id = p.id)::int AS component_count,
      p.created_at, p.updated_at,
      COALESCE(a.total,     0)::int AS total_units,
      COALESCE(a.available, 0)::int AS available_units,
      COALESCE(a.rented,    0)::int AS rented_units,
      COALESCE(a.offline, 0)::int AS offline_units,
      (CASE WHEN p.tracking_method = 'bulk'
            THEN COALESCE((SELECT SUM(sl.quantity)::int FROM stock_levels sl JOIN locations l ON l.id = sl.location_id
                           WHERE sl.product_id = p.id AND l.workspace_id = p.workspace_id), 0)
            ELSE COALESCE(a.total, 0) END)::int AS effective_capacity,
      a.location_names,
      COUNT(*) OVER()::int AS full_total
    FROM products p
    LEFT JOIN LATERAL (
      -- Sub-turn 12b: counts are now TRUTHFUL — asset.status is written at
      -- dispatch/return. available = on the shelf (status 'available' AND no
      -- active offline block); rented = 'out' with a customer; offline = on
      -- the shelf but held by an active asset-level repair/maintenance
      -- downtime. (Retired units are soft-deleted, excluded by deleted_at.)
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE ast.status = 'available' AND NOT EXISTS (
          SELECT 1 FROM product_downtimes d
          WHERE d.asset_id = ast.id AND d.status IN ('scheduled','started')
            AND d.start_at <= now() AND d.end_at > now()
        )) AS available,
        COUNT(*) FILTER (WHERE ast.status = 'out') AS rented,
        COUNT(*) FILTER (WHERE ast.status = 'available' AND EXISTS (
          SELECT 1 FROM product_downtimes d
          WHERE d.asset_id = ast.id AND d.status IN ('scheduled','started')
            AND d.start_at <= now() AND d.end_at > now()
        )) AS offline,
        string_agg(DISTINCT loc.name, ', ' ORDER BY loc.name) AS location_names
      FROM assets ast
      LEFT JOIN locations loc ON loc.id = ast.location_id
      WHERE ast.product_id = p.id AND ast.deleted_at IS NULL
    ) a ON true
    WHERE p.workspace_id = ${session.workspace.id}
      AND p.deleted_at IS NULL
      AND (${includeArchived}::boolean OR p.is_active = true)
      AND (${searchPattern}::text IS NULL
           OR p.name ILIKE ${searchPattern}::text
           OR p.sku  ILIKE ${searchPattern}::text)
      AND (${category}::text IS NULL OR p.category = ${category}::text)
      AND (${locationId}::uuid IS NULL OR EXISTS (
        SELECT 1 FROM assets af
        WHERE af.product_id = p.id AND af.deleted_at IS NULL
          AND af.location_id = ${locationId}::uuid
      ))
      AND (${tagMatchCsv}::text IS NULL
           OR p.id = ANY(string_to_array(${tagMatchCsv}::text, ',')::uuid[]))
    ORDER BY p.category ASC, p.name ASC
    LIMIT 200
  `);

  // Batch-load tags for this page (Sub-turn 8a) so each row carries its chips.
  const tagMap = await loadTagsForEntities(
    session.workspace.id, 'product', products.map((p) => p.id),
  );
  for (const p of products) (p as ProductRow & { tags: unknown }).tags = tagMap.get(p.id) ?? [];

  // Aggregate a category → count map for the sidebar/filter chips.
  const byCategory: Record<string, number> = {};
  for (const p of products) byCategory[p.category] = (byCategory[p.category] || 0) + 1;

  // True count of the filtered set. COUNT(*) OVER() is evaluated before LIMIT,
  // so `full_total` is the real match count even though we only return up to
  // LIST_LIMIT rows. When total > returned, the client surfaces a truncation
  // notice so products past the cap aren't SILENTLY invisible (the pre-existing
  // behaviour). Full pagination is a deferred follow-up. `full_total` is a
  // per-row artefact of the window function — strip it from the payload.
  const fullTotal = products.length
    ? Number((products[0] as unknown as { full_total: number }).full_total)
    : 0;
  for (const p of products) delete (p as Partial<{ full_total: number }>).full_total;

  return c.json({
    products,
    total: fullTotal,
    returned: products.length,
    limit: LIST_LIMIT,
    by_category: byCategory,
  });
});

// ============================================================================
// GET /api/inventory/products/:id — single product with counts
// ============================================================================
inventory.get('/products/:id', async (c) => {
  const session = c.get('session')!;
  const id = c.req.param('id');

  const rows = await query<ProductRow>(sql`
    SELECT
      p.id, p.sku, p.name, p.category, p.description,
      p.daily_rate, p.deposit, p.replacement_value,
      p.specifications, p.notes, p.image_url, p.hsn_code,
      p.buffer_before_hours, p.buffer_after_hours, p.shortage_limit,
      p.default_purchase_cost_paise,
      -- Sub-turn 13: product model + per-product GST. gst_rate_missing warns the
      -- UI that a taxable product has no rate (it's billed at the workspace
      -- default until set — never 0%, which would be a compliance violation).
      p.nature::text AS nature, p.tracking_method::text AS tracking_method,
      p.pricing_method::text AS pricing_method, p.base_price_paise, p.charge_period::text AS charge_period,
      p.pricing_structure_id, p.pricing_ruleset_id,
      p.gst_rate_bps, p.is_taxable, p.security_deposit_value_paise,
      (p.is_taxable AND p.gst_rate_bps IS NULL) AS gst_rate_missing,
      p.is_active, p.is_kit,
      (SELECT COUNT(*) FROM product_kit_items pki WHERE pki.kit_product_id = p.id)::int AS component_count,
      p.created_at, p.updated_at,
      COALESCE(a.total,     0)::int AS total_units,
      COALESCE(a.available, 0)::int AS available_units,
      COALESCE(a.rented,    0)::int AS rented_units,
      COALESCE(a.offline, 0)::int AS offline_units,
      (CASE WHEN p.tracking_method = 'bulk'
            THEN COALESCE((SELECT SUM(sl.quantity)::int FROM stock_levels sl JOIN locations l ON l.id = sl.location_id
                           WHERE sl.product_id = p.id AND l.workspace_id = p.workspace_id), 0)
            ELSE COALESCE(a.total, 0) END)::int AS effective_capacity
    FROM products p
    LEFT JOIN LATERAL (
      -- Sub-turn 12b: truthful physical counts (see the list query above).
      SELECT
        COUNT(*) AS total,
        COUNT(*) FILTER (WHERE assets.status = 'available' AND NOT EXISTS (
          SELECT 1 FROM product_downtimes d
          WHERE d.asset_id = assets.id AND d.status IN ('scheduled','started')
            AND d.start_at <= now() AND d.end_at > now()
        )) AS available,
        COUNT(*) FILTER (WHERE assets.status = 'out') AS rented,
        COUNT(*) FILTER (WHERE assets.status = 'available' AND EXISTS (
          SELECT 1 FROM product_downtimes d
          WHERE d.asset_id = assets.id AND d.status IN ('scheduled','started')
            AND d.start_at <= now() AND d.end_at > now()
        )) AS offline
      FROM assets
      WHERE product_id = p.id AND deleted_at IS NULL
    ) a ON true
    WHERE p.id = ${id}
      AND p.workspace_id = ${session.workspace.id}
      AND p.deleted_at IS NULL
    LIMIT 1
  `);

  const product = rows[0];
  if (!product) return c.json({ error: 'not_found' }, 404);

  // Individual live assets + a per-location roll-up (Sub-turn 6i). Bulk products
  // have no asset rows, so both come back empty.
  const assets = await query<{
    id: string; asset_code: string; status: string;
    location_id: string; location_name: string | null;
    purchase_cost_paise: number | null; purchase_date: string | null;
    effective_cost_paise: number | null; cost_source: 'asset' | 'product' | 'none';
  }>(sql`
    SELECT a.id, a.asset_code, a.status::text AS status,
           a.location_id, l.name AS location_name,
           a.purchase_cost_paise, a.purchase_date,
           -- Resolved at read time — the product default stays live (Sub-turn 11).
           COALESCE(a.purchase_cost_paise, pr.default_purchase_cost_paise) AS effective_cost_paise,
           CASE WHEN a.purchase_cost_paise IS NOT NULL THEN 'asset'
                WHEN pr.default_purchase_cost_paise IS NOT NULL THEN 'product'
                ELSE 'none' END AS cost_source
    FROM assets a
    JOIN products pr ON pr.id = a.product_id
    LEFT JOIN locations l ON l.id = a.location_id
    WHERE a.product_id = ${id}::uuid
      AND a.workspace_id = ${session.workspace.id}::uuid
      AND a.deleted_at IS NULL
    ORDER BY a.asset_code ASC
  `);
  const assets_by_location = await query<{
    location_id: string; location_name: string | null; count: number;
  }>(sql`
    SELECT a.location_id, l.name AS location_name, COUNT(*)::int AS count
    FROM assets a
    LEFT JOIN locations l ON l.id = a.location_id
    WHERE a.product_id = ${id}::uuid
      AND a.workspace_id = ${session.workspace.id}::uuid
      AND a.deleted_at IS NULL
    GROUP BY a.location_id, l.name
    ORDER BY l.name ASC
  `);

  const custom_fields = await loadCustomFieldValues(session.workspace.id, 'product', id);
  const tags = await loadTagsForEntity(session.workspace.id, 'product', id);
  // Upcoming/active downtimes (Sub-turn 8a) — windows that haven't ended yet.
  const downtimes = await query<{
    id: string; location_id: string | null; location_name: string | null;
    start_at: string; end_at: string; reason: string;
  }>(sql`
    SELECT d.id, d.location_id, l.name AS location_name, d.start_at, d.end_at, d.reason
    FROM product_downtimes d
    LEFT JOIN locations l ON l.id = d.location_id
    WHERE d.workspace_id = ${session.workspace.id}::uuid
      AND d.product_id = ${id}::uuid
      AND d.end_at > now()
    ORDER BY d.start_at ASC
  `);
  // Combined manual + co-rental recommendations preview (Sub-turn 8c).
  const recommendations = await loadRecommendations(session.workspace.id, id, 6);
  // Sub-turn 13 chunk 9 — per-location on-hand for BULK products (capacity for
  // rental-bulk, stock for sale-bulk). Powers the per-location stepper UI. Tracked
  // products have no stock_levels rows (their capacity is COUNT(assets)).
  const stock_levels = await query<{ location_id: string; location_name: string | null; quantity: number }>(sql`
    SELECT sl.location_id, l.name AS location_name, sl.quantity
    FROM stock_levels sl
    LEFT JOIN locations l ON l.id = sl.location_id
    WHERE sl.product_id = ${id}::uuid
      AND l.workspace_id = ${session.workspace.id}::uuid
    ORDER BY l.name ASC
  `);
  return c.json({ product, assets, assets_by_location, stock_levels, custom_fields, tags, downtimes, recommendations });
});

// ============================================================================
// GET /api/inventory/categories — distinct category values in the workspace.
// Powers the inventory category filter + the edit-modal autocomplete.
// ============================================================================
inventory.get('/categories', async (c) => {
  const session = c.get('session')!;
  const rows = await query<{ category: string }>(sql`
    SELECT DISTINCT category
    FROM products
    WHERE workspace_id = ${session.workspace.id}
      AND category IS NOT NULL
      AND deleted_at IS NULL
    ORDER BY category ASC
  `);
  return c.json({ categories: rows.map((r) => r.category) });
});

// ============================================================================
// PATCH /api/inventory/products/:id/stock — set per-location BULK stock
// (Sub-turn 13). stock_levels is the ONLY source of truth for bulk capacity
// (the legacy products.stock_quantity column was dropped in the contract phase).
// ============================================================================
const stockSchema = z.object({ location_id: z.string().uuid(), quantity: z.number().int().min(0) });
inventory.patch('/products/:id/stock', requirePermission('inventory.manage'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');
  const parsed = stockSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  const { location_id, quantity } = parsed.data;

  const prod = await query<{ tracking_method: string | null }>(sql`
    SELECT tracking_method::text AS tracking_method FROM products
    WHERE id = ${id}::uuid AND workspace_id = ${session.workspace.id}::uuid AND deleted_at IS NULL LIMIT 1
  `);
  if (!prod.length) return c.json({ error: 'not_found' }, 404);
  if (prod[0]!.tracking_method !== 'bulk') {
    return c.json({ error: 'not_a_bulk_product' }, 400);
  }
  const loc = await query<{ id: string }>(sql`
    SELECT id FROM locations WHERE id = ${location_id}::uuid AND workspace_id = ${session.workspace.id}::uuid LIMIT 1
  `);
  if (!loc.length) return c.json({ error: 'location_not_found' }, 404);

  await sql`
    INSERT INTO stock_levels (product_id, location_id, quantity)
    VALUES (${id}::uuid, ${location_id}::uuid, ${quantity}::int)
    ON CONFLICT (product_id, location_id) DO UPDATE SET quantity = EXCLUDED.quantity
  `;
  await audit({
    workspaceId: session.workspace.id, actorUserId: session.user.id,
    eventType: 'inventory.stock.updated', targetType: 'product', targetId: id,
    payload: { location_id, quantity }, ipAddress, userAgent,
  });
  return c.json({ ok: true, product_id: id, location_id, quantity });
});

// ============================================================================
// POST /api/inventory/products — create product (+ optional N assets)
// Only owner / manager can create.
// ============================================================================
const createSchema = z.object({
  name: z.string().min(1).max(200),
  sku: z.string().min(1).max(100).regex(/^[A-Za-z0-9-]+$/).optional(),
  category: z.string().min(1).max(100),
  description: z.string().max(2000).optional(),
  // All monetary values in paise (rupees × 100).
  daily_rate: z.number().int().positive(),
  deposit: z.number().int().min(0).default(0),
  replacement_value: z.number().int().positive().optional(),
  default_purchase_cost_paise: z.number().int().min(0).nullable().optional(), // Sub-turn 11
  specifications: z.record(z.unknown()).optional(),
  notes: z.string().max(2000).optional(),
  is_kit: z.boolean().default(false),
  // How many physical units to create right now (asset rows). Ignored for bulk.
  initial_units: z.number().int().min(0).max(50).default(1),
  // Bulk products need a starting on-hand quantity — it seeds stock_levels (the
  // legacy products.stock_quantity column is gone; this is an input, not a column).
  stock_quantity: z.number().int().min(0).nullable().optional(),
  // Sub-turn 6i — which location the initial tracked assets live at. Omitted →
  // the workspace default location.
  location_id: z.string().uuid().optional(),
  // Sub-turn 13 — product model (nature + tracking are set ONLY here; immutable
  // after). service ⇒ tracking forced to 'none'; base price defaults to daily_rate.
  nature: z.enum(['rental', 'service', 'sale']).default('rental'),
  tracking_method: z.enum(['serialized', 'bulk', 'none']).optional(),
  base_price_paise: z.number().int().min(0).optional(),
  pricing_method: z.enum(['fixed_fee', 'fixed_price', 'structure']).default('fixed_fee'),
  charge_period: z.enum(['hour', 'day', 'week', 'month']).default('day'),
  gst_rate_bps: z.number().int().min(0).max(5000).nullable().optional(),
  is_taxable: z.boolean().default(true),
  security_deposit_value_paise: z.number().int().min(0).nullable().optional(),
});

inventory.post('/products', requirePermission('inventory.manage'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);

  const body = await c.req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }
  const input = parsed.data;

  // Derive the model (Sub-turn 13). tracking_method is the source of truth.
  // nature=service forces 'none' (no units). isBulk drives the asset + stock logic.
  let trackingMethod: 'serialized' | 'bulk' | 'none' = input.tracking_method ?? 'serialized';
  if (input.nature === 'service') trackingMethod = 'none';
  const isBulk = trackingMethod === 'bulk';
  const basePrice = input.base_price_paise ?? input.daily_rate;
  // service / none products carry no serialized units.
  const initialUnits = trackingMethod === 'none' ? 0 : input.initial_units;

  // Bulk ⇒ starting on-hand required (seeds stock_levels); non-bulk ⇒ no stock qty.
  if (isBulk) {
    if (input.stock_quantity == null) return c.json({ error: 'stock_quantity_required' }, 400);
  } else if (input.stock_quantity != null) {
    return c.json({ error: 'stock_quantity_not_allowed_for_tracked' }, 400);
  }

  // Resolve the location the new tracked assets belong to (Sub-turn 6i). Bulk
  // products have no asset rows, so location is irrelevant there.
  let assetLocationId: string | null = null;
  if (!isBulk) {
    if (input.location_id) {
      const locRows = await query<{ id: string; is_active: boolean }>(sql`
        SELECT id, is_active FROM locations
        WHERE id = ${input.location_id}::uuid AND workspace_id = ${session.workspace.id}::uuid
        LIMIT 1
      `);
      if (!locRows.length) return c.json({ error: 'location_not_found' }, 404);
      if (!locRows[0]!.is_active) return c.json({ error: 'location_inactive' }, 400);
      assetLocationId = locRows[0]!.id;
    } else {
      assetLocationId = await getDefaultLocationId(session.workspace.id);
      if (!assetLocationId) return c.json({ error: 'no_default_location' }, 400);
    }
  }

  const sku = (input.sku ?? generateSku(input.name)).toUpperCase();

  // 1. Check SKU uniqueness upfront (nicer error than a bare constraint violation)
  const existing = await query<{ id: string }>(sql`
    SELECT id FROM products
    WHERE workspace_id = ${session.workspace.id} AND sku = ${sku} AND deleted_at IS NULL
    LIMIT 1
  `);
  if (existing.length > 0) {
    return c.json({ error: 'sku_taken', sku }, 409);
  }

  // 2. Insert product + asset rows in a single atomic CTE.
  //    If either step fails, both roll back. Bulk products get NO asset rows.
  const codes = isBulk ? [] : assetCodesFor(sku, initialUnits);
  const inserted = await query<ProductRow & { asset_ids: string[] | null }>(sql`
    WITH new_product AS (
      INSERT INTO products (
        workspace_id, sku, name, category, description,
        daily_rate, deposit, replacement_value,
        default_purchase_cost_paise,
        specifications, notes, is_kit, created_by,
        nature, tracking_method, base_price_paise, pricing_method, charge_period,
        gst_rate_bps, is_taxable, security_deposit_value_paise
      ) VALUES (
        ${session.workspace.id},
        ${sku},
        ${input.name},
        ${input.category},
        ${input.description ?? null},
        ${input.daily_rate},
        ${input.deposit},
        ${input.replacement_value ?? null},
        ${input.default_purchase_cost_paise ?? null}::bigint,
        ${JSON.stringify(input.specifications ?? {})}::jsonb,
        ${input.notes ?? null},
        ${input.is_kit},
        ${session.user.id},
        ${input.nature}::product_nature,
        ${trackingMethod}::tracking_method,
        ${basePrice}::bigint,
        ${input.pricing_method}::pricing_method,
        ${input.charge_period}::charge_period,
        ${input.gst_rate_bps ?? null}::int,
        ${input.is_taxable}::boolean,
        ${input.security_deposit_value_paise ?? null}::bigint
      )
      RETURNING *
    ),
    new_assets AS (
      INSERT INTO assets (workspace_id, product_id, asset_code, condition, status, location_id)
      SELECT
        ${session.workspace.id},
        (SELECT id FROM new_product),
        code_val,
        'excellent'::asset_condition,
        'available'::asset_status,
        ${assetLocationId}::uuid
      FROM jsonb_array_elements_text(${JSON.stringify(codes)}::jsonb) AS code_val
      RETURNING id
    )
    SELECT
      np.*,
      (SELECT COUNT(*) FROM new_assets)::int AS total_units,
      (SELECT COUNT(*) FROM new_assets)::int AS available_units,
      0::int AS rented_units,
      0::int AS offline_units,
      0::int AS component_count,
      (SELECT COUNT(*) FROM new_assets)::int AS effective_capacity,
      (SELECT array_agg(id) FROM new_assets) AS asset_ids
    FROM new_product np
  `);

  const product = inserted[0];
  if (!product) {
    return c.json({ error: 'create_failed' }, 500);
  }
  // Bulk capacity is stock_levels, not asset rows — reflect the seed value.
  if (isBulk) product.effective_capacity = input.stock_quantity ?? 0;

  // Sub-turn 13: a bulk product's initial stock lands at one location's
  // stock_levels — the ONLY source of truth for bulk capacity.
  if (isBulk) {
    const stockLocId = input.location_id ?? (await getDefaultLocationId(session.workspace.id));
    if (stockLocId) {
      await sql`
        INSERT INTO stock_levels (product_id, location_id, quantity)
        VALUES (${product.id}::uuid, ${stockLocId}::uuid, ${input.stock_quantity ?? 0}::int)
        ON CONFLICT (product_id, location_id) DO UPDATE SET quantity = EXCLUDED.quantity
      `;
    }
  }

  // 3. Audit — one event per mutation type.
  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'inventory.product.created',
    targetType: 'product',
    targetId: product.id,
    payload: { sku, name: input.name, category: input.category, initial_units: input.initial_units },
    ipAddress, userAgent,
  });
  if (product.asset_ids && product.asset_ids.length > 0) {
    await audit({
      workspaceId: session.workspace.id,
      actorUserId: session.user.id,
      eventType: 'inventory.asset.created',
      targetType: 'product',
      targetId: product.id,
      payload: { asset_ids: product.asset_ids, codes },
      ipAddress, userAgent,
    });
  }

  // Strip internal-only fields before returning.
  const { asset_ids: _asset_ids, ...clean } = product;
  return c.json({ product: clean }, 201);
});

// ============================================================================
// PATCH /api/inventory/products/:id — partial update
// ============================================================================
const updateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  category: z.string().min(1).max(100).optional(),
  description: z.string().max(2000).optional(),
  daily_rate: z.number().int().positive().optional(),
  deposit: z.number().int().min(0).optional(),
  replacement_value: z.number().int().positive().optional(),
  // Sub-turn 11 — nullable: omit preserves, explicit null clears (handled below).
  default_purchase_cost_paise: z.number().int().min(0).nullable().optional(),
  specifications: z.record(z.unknown()).optional(),
  notes: z.string().max(2000).optional(),
  image_url: z.string().max(2000).optional(),
  hsn_code: z.string().max(8).optional(),
  buffer_before_hours: z.number().int().min(0).max(72).optional(),
  buffer_after_hours: z.number().int().min(0).max(72).optional(),
  shortage_limit: z.number().int().min(0).max(100).optional(),
  is_active: z.boolean().optional(),
  is_kit: z.boolean().optional(),
  custom_fields: z.array(z.object({ definition_id: z.string().uuid(), value: z.string().nullable() })).optional(),
  tag_ids: z.array(z.string().uuid()).optional(), // Sub-turn 8a — replace-all
  // Sub-turn 13 — pricing / GST / deposit config (nature + tracking are IMMUTABLE
  // after creation; sending a different value is rejected below).
  nature: z.enum(['rental', 'service', 'sale']).optional(),
  tracking_method: z.enum(['serialized', 'bulk', 'none']).optional(),
  pricing_method: z.enum(['fixed_fee', 'fixed_price', 'structure']).optional(),
  base_price_paise: z.number().int().min(0).optional(),
  charge_period: z.enum(['hour', 'day', 'week', 'month']).optional(),
  pricing_structure_id: z.string().uuid().nullable().optional(),
  pricing_ruleset_id: z.string().uuid().nullable().optional(),
  gst_rate_bps: z.number().int().min(0).max(5000).nullable().optional(),
  is_taxable: z.boolean().optional(),
  security_deposit_value_paise: z.number().int().min(0).nullable().optional(),
  charge_for_product: z.boolean().optional(),
  eligible_for_discounts: z.boolean().optional(),
});

inventory.patch('/products/:id', requirePermission('inventory.manage'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');

  const body = await c.req.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }
  const p = parsed.data;

  // Fetch existing to make sure it belongs to this workspace before touching it.
  const existing = await query<{ id: string; is_active: boolean; name: string; is_kit: boolean; nature: string; tracking_method: string | null }>(sql`
    SELECT id, is_active, name, is_kit, nature::text AS nature, tracking_method::text AS tracking_method FROM products
    WHERE id = ${id} AND workspace_id = ${session.workspace.id} AND deleted_at IS NULL
    LIMIT 1
  `);
  if (existing.length === 0) return c.json({ error: 'not_found' }, 404);

  // Sub-turn 13: nature and tracking are IMMUTABLE (they change availability +
  // pricing semantics). Reject a differing value; the UI renders them read-only.
  if (p.nature !== undefined && p.nature !== existing[0]!.nature) {
    return c.json({ error: 'nature_immutable', reason: 'delete_and_recreate' }, 409);
  }
  if (p.tracking_method !== undefined && p.tracking_method !== (existing[0]!.tracking_method ?? '')) {
    return c.json({ error: 'tracking_immutable', reason: 'delete_and_recreate' }, 409);
  }
  const before = existing[0]!;

  // Un-kitting a product with components would orphan the bundle. Block it.
  if (p.is_kit === false && before.is_kit) {
    const comps = await query<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n FROM product_kit_items
      WHERE kit_product_id = ${id} AND workspace_id = ${session.workspace.id}
    `);
    if ((comps[0]?.n ?? 0) > 0) {
      return c.json({ error: 'kit_has_components', reason: 'remove_components_first' }, 409);
    }
  }

  // Cost is the one field that must support explicit-null-to-clear (Sub-turn 11):
  // omitting it preserves, sending `null` clears it. Zod .optional() drops the key
  // when omitted, so `in p` distinguishes "omitted" from "sent as null".
  const costProvided = 'default_purchase_cost_paise' in p;
  const costValue = costProvided ? (p.default_purchase_cost_paise ?? null) : null;

  // Sub-turn 12a: editing a product needs inventory.manage (route-gated), but
  // touching the purchase COST is a distinct capability (inventory.costs — owner
  // by default, not in the manager preset).
  if (costProvided && !can(session, 'inventory.costs')) {
    return c.json({ error: 'forbidden', required_permission: ['inventory.costs'] }, 403);
  }

  // Nullable clearables (Sub-turn 13): `in p` distinguishes omit from explicit null.
  const hasStructure = 'pricing_structure_id' in p;
  const hasRuleset = 'pricing_ruleset_id' in p;
  const hasGstRate = 'gst_rate_bps' in p;
  const hasSecDep = 'security_deposit_value_paise' in p;

  // COALESCE-based partial update: any field the caller omits is preserved.
  // We deliberately do NOT support clearing other nullable fields via PATCH.
  const updated = await query<ProductRow>(sql`
    UPDATE products SET
      default_purchase_cost_paise = CASE WHEN ${costProvided}::boolean
                                         THEN ${costValue}::bigint
                                         ELSE default_purchase_cost_paise END,
      name              = COALESCE(${p.name              ?? null}::text,    name),
      category          = COALESCE(${p.category          ?? null}::text,    category),
      description       = COALESCE(${p.description       ?? null}::text,    description),
      daily_rate        = COALESCE(${p.daily_rate        ?? null}::integer, daily_rate),
      deposit           = COALESCE(${p.deposit           ?? null}::integer, deposit),
      replacement_value = COALESCE(${p.replacement_value ?? null}::integer, replacement_value),
      specifications    = COALESCE(${p.specifications ? JSON.stringify(p.specifications) : null}::jsonb, specifications),
      notes             = COALESCE(${p.notes             ?? null}::text,    notes),
      image_url           = COALESCE(${p.image_url           ?? null}::text,    image_url),
      hsn_code            = COALESCE(${p.hsn_code            ?? null}::text,    hsn_code),
      buffer_before_hours = COALESCE(${p.buffer_before_hours ?? null}::integer, buffer_before_hours),
      buffer_after_hours  = COALESCE(${p.buffer_after_hours  ?? null}::integer, buffer_after_hours),
      shortage_limit      = COALESCE(${p.shortage_limit      ?? null}::integer, shortage_limit),
      is_active           = COALESCE(${p.is_active           ?? null}::boolean, is_active),
      is_kit              = COALESCE(${p.is_kit              ?? null}::boolean, is_kit),
      -- Sub-turn 13 pricing/GST/deposit config.
      pricing_method      = COALESCE(${p.pricing_method      ?? null}::pricing_method, pricing_method),
      base_price_paise    = COALESCE(${p.base_price_paise    ?? null}::bigint, base_price_paise),
      charge_period       = COALESCE(${p.charge_period       ?? null}::charge_period, charge_period),
      is_taxable          = COALESCE(${p.is_taxable          ?? null}::boolean, is_taxable),
      charge_for_product  = COALESCE(${p.charge_for_product  ?? null}::boolean, charge_for_product),
      eligible_for_discounts = COALESCE(${p.eligible_for_discounts ?? null}::boolean, eligible_for_discounts),
      pricing_structure_id = CASE WHEN ${hasStructure}::boolean THEN ${p.pricing_structure_id ?? null}::uuid ELSE pricing_structure_id END,
      pricing_ruleset_id   = CASE WHEN ${hasRuleset}::boolean   THEN ${p.pricing_ruleset_id ?? null}::uuid   ELSE pricing_ruleset_id END,
      gst_rate_bps         = CASE WHEN ${hasGstRate}::boolean   THEN ${p.gst_rate_bps ?? null}::int          ELSE gst_rate_bps END,
      security_deposit_value_paise = CASE WHEN ${hasSecDep}::boolean THEN ${p.security_deposit_value_paise ?? null}::bigint ELSE security_deposit_value_paise END
    WHERE id = ${id} AND workspace_id = ${session.workspace.id}
    RETURNING
      id, sku, name, category, description,
      daily_rate, deposit, replacement_value,
      specifications, notes, image_url, hsn_code,
      buffer_before_hours, buffer_after_hours, shortage_limit,
      default_purchase_cost_paise,
      nature::text AS nature, tracking_method::text AS tracking_method,
      pricing_method::text AS pricing_method, base_price_paise, charge_period::text AS charge_period,
      gst_rate_bps, is_taxable, security_deposit_value_paise,
      (is_taxable AND gst_rate_bps IS NULL) AS gst_rate_missing,
      is_active, is_kit, created_at, updated_at,
      0::int AS total_units, 0::int AS available_units,
      0::int AS rented_units, 0::int AS offline_units,
      (CASE WHEN tracking_method = 'bulk'
            THEN COALESCE((SELECT SUM(sl.quantity)::int FROM stock_levels sl JOIN locations l ON l.id = sl.location_id
                           WHERE sl.product_id = products.id AND l.workspace_id = products.workspace_id), 0)
            ELSE 0 END)::int AS effective_capacity,
      (SELECT COUNT(*) FROM product_kit_items pki WHERE pki.kit_product_id = products.id)::int AS component_count
  `);

  if (updated.length === 0) return c.json({ error: 'not_found' }, 404);

  const changed = Object.keys(p);
  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: p.is_active === false && before.is_active
      ? 'inventory.product.archived'
      : p.is_active === true && !before.is_active
      ? 'inventory.product.restored'
      : 'inventory.product.updated',
    targetType: 'product',
    targetId: id,
    payload: { fields: changed },
    ipAddress, userAgent,
  });

  if (p.custom_fields) {
    await upsertCustomFieldValues({
      workspaceId: session.workspace.id, entityType: 'product', entityId: id,
      actorUserId: session.user.id, values: p.custom_fields,
    });
  }

  // Tag assignments (Sub-turn 8a) — replace-all when provided inline.
  if (p.tag_ids) {
    await replaceEntityTags(session.workspace.id, 'product', id, session.user.id, p.tag_ids);
  }

  return c.json({ product: updated[0] });
});

// ============================================================================
// DELETE /api/inventory/products/:id — soft delete (archive)
// Refuses if any asset is currently rented.
// ============================================================================
inventory.delete('/products/:id', requirePermission('inventory.manage'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');

  // Sub-turn 12b: a unit physically with a customer is status 'out' (was the
  // never-written 'rented'). This guard is now real — you can't delete a product
  // whose units are out on an active rental.
  const out = await query<{ n: number }>(sql`
    SELECT COUNT(*)::int AS n
    FROM assets
    WHERE product_id = ${id}
      AND workspace_id = ${session.workspace.id}
      AND status = 'out'
      AND deleted_at IS NULL
  `);
  if ((out[0]?.n ?? 0) > 0) {
    return c.json({ error: 'has_out_assets', out_count: out[0]!.n }, 409);
  }

  const deleted = await query<{ id: string }>(sql`
    UPDATE products
    SET deleted_at = now(), is_active = false
    WHERE id = ${id}
      AND workspace_id = ${session.workspace.id}
      AND deleted_at IS NULL
    RETURNING id
  `);
  if (deleted.length === 0) return c.json({ error: 'not_found' }, 404);

  // Also archive the assets so they don't show up in "available".
  await sql`
    UPDATE assets
    SET deleted_at = now(), status = 'retired'
    WHERE product_id = ${id}
      AND workspace_id = ${session.workspace.id}
      AND deleted_at IS NULL
  `;

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'inventory.product.archived',
    targetType: 'product',
    targetId: id,
    payload: { via: 'delete' },
    ipAddress, userAgent,
  });

  return c.json({ ok: true });
});

// ============================================================================
// PATCH /api/inventory/assets/:id/location — relocate one asset (Sub-turn 6i)
// ----------------------------------------------------------------------------
// Moving an asset shifts which location reserves it for availability. Owner /
// manager only. Target must be an active location in this workspace.
// ============================================================================
const relocateSchema = z.object({ location_id: z.string().uuid() });

inventory.patch('/assets/:id/location', requirePermission('inventory.manage'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const assetId = c.req.param('id');

  const body = await c.req.json().catch(() => null);
  const parsed = relocateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  const { location_id } = parsed.data;

  const assetRows = await query<{ id: string; location_id: string | null; product_id: string }>(sql`
    SELECT id, location_id, product_id FROM assets
    WHERE id = ${assetId}::uuid AND workspace_id = ${session.workspace.id}::uuid
      AND deleted_at IS NULL
    LIMIT 1
  `);
  if (!assetRows.length) return c.json({ error: 'not_found' }, 404);
  const from = assetRows[0]!;

  const locRows = await query<{ id: string; is_active: boolean }>(sql`
    SELECT id, is_active FROM locations
    WHERE id = ${location_id}::uuid AND workspace_id = ${session.workspace.id}::uuid
    LIMIT 1
  `);
  if (!locRows.length) return c.json({ error: 'location_not_found' }, 404);
  if (!locRows[0]!.is_active) return c.json({ error: 'location_inactive' }, 400);

  await sql`
    UPDATE assets SET location_id = ${location_id}::uuid, updated_at = now()
    WHERE id = ${assetId}::uuid AND workspace_id = ${session.workspace.id}::uuid
  `;

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'inventory.asset.relocated',
    targetType: 'asset',
    targetId: assetId,
    payload: { from_location_id: from.location_id, to_location_id: location_id, product_id: from.product_id },
    ipAddress, userAgent,
  });

  return c.json({ ok: true });
});

// ============================================================================
// PATCH /api/inventory/assets/bulk-cost — Sub-turn 11. Bulk purchase-cost entry.
// Owner/manager ONLY (financial data). Registered BEFORE /assets/:id so the
// literal path isn't captured by the :id param. Partial success: one bad row
// never discards the good ones. One audit event per changed asset.
// ============================================================================
const bulkCostSchema = z.object({
  updates: z.array(z.object({
    asset_id: z.string().uuid(),
    // Loose here (no .min) so a negative value becomes a REPORTED per-row failure
    // rather than a 400 that discards every good row.
    purchase_cost_paise: z.number().int().nullable().optional(),
    purchase_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
  })).min(1).max(500),
});

inventory.patch('/assets/bulk-cost', requirePermission('inventory.costs'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);

  const body = await c.req.json().catch(() => null);
  const parsed = bulkCostSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  const { updates } = parsed.data;

  const failed: { asset_id: string; reason: string }[] = [];

  // Per-row validation that must report, not reject.
  const candidate = updates.filter((u) => {
    if (u.purchase_cost_paise != null && u.purchase_cost_paise < 0) {
      failed.push({ asset_id: u.asset_id, reason: 'negative_cost' }); return false;
    }
    return true;
  });

  // Which candidate assets actually belong to this workspace?
  const ids = candidate.map((u) => u.asset_id);
  const owned = ids.length
    ? await query<{ id: string }>(sql`
        SELECT id FROM assets
        WHERE id = ANY(${'{' + ids.join(',') + '}'}::uuid[])
          AND workspace_id = ${session.workspace.id}::uuid
          AND deleted_at IS NULL
      `)
    : [];
  const ownedSet = new Set(owned.map((r) => r.id));
  const toApply = candidate.filter((u) => {
    if (!ownedSet.has(u.asset_id)) { failed.push({ asset_id: u.asset_id, reason: 'not_found' }); return false; }
    return true;
  });

  if (toApply.length) {
    // One set-based UPDATE for every good row. COALESCE keeps a field the row
    // omitted (bulk entry never destroys an existing value — clearing is done
    // via the single-asset PATCH).
    const payload = JSON.stringify(toApply.map((u) => ({
      asset_id: u.asset_id,
      cost: u.purchase_cost_paise ?? null,
      pdate: u.purchase_date ?? null,
    })));
    await sql`
      UPDATE assets a SET
        purchase_cost_paise = COALESCE(u.cost, a.purchase_cost_paise),
        purchase_date       = COALESCE(u.pdate, a.purchase_date),
        updated_at          = now()
      FROM jsonb_to_recordset(${payload}::jsonb) AS u(asset_id uuid, cost bigint, pdate date)
      WHERE a.id = u.asset_id AND a.workspace_id = ${session.workspace.id}::uuid
    `;
    // One audit event per changed asset (financially material).
    await Promise.all(toApply.map((u) => audit({
      workspaceId: session.workspace.id,
      actorUserId: session.user.id,
      eventType: 'inventory.asset.updated',
      targetType: 'asset',
      targetId: u.asset_id,
      payload: { fields: ['purchase_cost_paise', 'purchase_date'], via: 'bulk-cost' },
      ipAddress, userAgent,
    })));
  }

  return c.json({ updated: toApply.length, failed });
});

// ============================================================================
// PATCH /api/inventory/assets/:id — Sub-turn 11. Per-unit cost override + date.
// Owner/manager only. Explicit null clears (reverts to the product default).
// ============================================================================
const assetCostSchema = z.object({
  purchase_cost_paise: z.number().int().min(0).nullable().optional(),
  purchase_date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
});

inventory.patch('/assets/:id', requirePermission('inventory.costs'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const assetId = c.req.param('id');

  const body = await c.req.json().catch(() => null);
  const parsed = assetCostSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  const p = parsed.data;

  const costProvided = 'purchase_cost_paise' in p;
  const dateProvided = 'purchase_date' in p;
  const costValue = costProvided ? (p.purchase_cost_paise ?? null) : null;
  const dateValue = dateProvided ? (p.purchase_date ?? null) : null;

  const updated = await query<{
    id: string; asset_code: string; purchase_cost_paise: number | null;
    purchase_date: string | null; effective_cost_paise: number | null;
    cost_source: 'asset' | 'product' | 'none';
  }>(sql`
    WITH upd AS (
      UPDATE assets a SET
        purchase_cost_paise = CASE WHEN ${costProvided}::boolean THEN ${costValue}::bigint ELSE a.purchase_cost_paise END,
        purchase_date       = CASE WHEN ${dateProvided}::boolean THEN ${dateValue}::date  ELSE a.purchase_date END,
        updated_at          = now()
      WHERE a.id = ${assetId}::uuid AND a.workspace_id = ${session.workspace.id}::uuid AND a.deleted_at IS NULL
      RETURNING a.id, a.asset_code, a.product_id, a.purchase_cost_paise, a.purchase_date
    )
    SELECT upd.id, upd.asset_code, upd.purchase_cost_paise, upd.purchase_date,
           COALESCE(upd.purchase_cost_paise, pr.default_purchase_cost_paise) AS effective_cost_paise,
           CASE WHEN upd.purchase_cost_paise IS NOT NULL THEN 'asset'
                WHEN pr.default_purchase_cost_paise IS NOT NULL THEN 'product'
                ELSE 'none' END AS cost_source
    FROM upd JOIN products pr ON pr.id = upd.product_id
  `);
  if (!updated.length) return c.json({ error: 'not_found' }, 404);

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'inventory.asset.updated',
    targetType: 'asset',
    targetId: assetId,
    payload: { fields: Object.keys(p) },
    ipAddress, userAgent,
  });

  return c.json({ asset: updated[0] });
});

// ============================================================================
// Kit components (Sub-turn 5c-2)
// ----------------------------------------------------------------------------
// A kit product (is_kit=true) bundles other products via product_kit_items.
// Kit capacity is derived at check time (see src/lib/availability.ts); these
// endpoints just CRUD the component list. Nested kits are blocked both here and
// by the check_no_nested_kits DB trigger.
// ============================================================================

async function loadKit(workspaceId: string, kitId: string) {
  const rows = await query<{ id: string; name: string; sku: string; is_kit: boolean }>(sql`
    SELECT id, name, sku, is_kit FROM products
    WHERE id = ${kitId} AND workspace_id = ${workspaceId} AND deleted_at IS NULL
    LIMIT 1
  `);
  return rows[0] ?? null;
}

// GET /api/inventory/products/:id/kit-components
inventory.get('/products/:id/kit-components', async (c) => {
  const session = c.get('session')!;
  const id = c.req.param('id');

  const kit = await loadKit(session.workspace.id, id);
  if (!kit) return c.json({ error: 'not_found' }, 404);
  if (!kit.is_kit) return c.json({ error: 'not_a_kit' }, 400);

  const components = await query<{
    id: string; component_product_id: string; component_name: string;
    component_sku: string; quantity: number;
  }>(sql`
    SELECT pki.id, pki.component_product_id,
           p.name AS component_name, p.sku AS component_sku, pki.quantity
    FROM product_kit_items pki
    JOIN products p ON p.id = pki.component_product_id
    WHERE pki.kit_product_id = ${id} AND pki.workspace_id = ${session.workspace.id}
    ORDER BY p.name ASC
  `);

  return c.json({
    kit: { id: kit.id, name: kit.name, sku: kit.sku },
    components,
  });
});

// POST /api/inventory/products/:id/kit-components — add a component
const kitAddSchema = z.object({
  component_product_id: z.string().uuid(),
  quantity: z.number().int().positive(),
});

inventory.post('/products/:id/kit-components', requirePermission('inventory.manage'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');

  const body = await c.req.json().catch(() => null);
  const parsed = kitAddSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  const input = parsed.data;

  const kit = await loadKit(session.workspace.id, id);
  if (!kit) return c.json({ error: 'not_found' }, 404);
  if (!kit.is_kit) return c.json({ error: 'not_a_kit' }, 400);
  if (input.component_product_id === id) return c.json({ error: 'kit_cannot_contain_itself' }, 400);

  const comp = await query<{ id: string; is_kit: boolean }>(sql`
    SELECT id, is_kit FROM products
    WHERE id = ${input.component_product_id} AND workspace_id = ${session.workspace.id} AND deleted_at IS NULL
    LIMIT 1
  `);
  if (comp.length === 0) return c.json({ error: 'component_not_found' }, 404);
  if (comp[0]!.is_kit) return c.json({ error: 'nested_kits_not_allowed' }, 400);

  const dup = await query<{ id: string }>(sql`
    SELECT id FROM product_kit_items
    WHERE kit_product_id = ${id} AND component_product_id = ${input.component_product_id}
      AND workspace_id = ${session.workspace.id}
    LIMIT 1
  `);
  if (dup.length > 0) return c.json({ error: 'component_already_in_kit', reason: 'update_instead' }, 409);

  const inserted = await query<{ id: string; component_product_id: string; quantity: number }>(sql`
    INSERT INTO product_kit_items (workspace_id, kit_product_id, component_product_id, quantity)
    VALUES (${session.workspace.id}, ${id}, ${input.component_product_id}, ${input.quantity})
    RETURNING id, component_product_id, quantity
  `);

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'inventory.kit.component_added',
    targetType: 'product',
    targetId: id,
    payload: { component_product_id: input.component_product_id, quantity: input.quantity },
    ipAddress, userAgent,
  });

  return c.json({ component: inserted[0] });
});

// PATCH /api/inventory/products/:id/kit-components/:componentId — update qty
const kitQtySchema = z.object({ quantity: z.number().int().positive() });

inventory.patch('/products/:id/kit-components/:componentId', requirePermission('inventory.manage'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');
  const componentId = c.req.param('componentId');

  const body = await c.req.json().catch(() => null);
  const parsed = kitQtySchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);

  const updated = await query<{ id: string; component_product_id: string; quantity: number }>(sql`
    UPDATE product_kit_items SET quantity = ${parsed.data.quantity}, updated_at = now()
    WHERE id = ${componentId} AND kit_product_id = ${id} AND workspace_id = ${session.workspace.id}
    RETURNING id, component_product_id, quantity
  `);
  if (updated.length === 0) return c.json({ error: 'not_found' }, 404);

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'inventory.kit.component_updated',
    targetType: 'product',
    targetId: id,
    payload: { kit_item_id: componentId, quantity: parsed.data.quantity },
    ipAddress, userAgent,
  });

  return c.json({ component: updated[0] });
});

// DELETE /api/inventory/products/:id/kit-components/:componentId — remove
inventory.delete('/products/:id/kit-components/:componentId', requirePermission('inventory.manage'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');
  const componentId = c.req.param('componentId');

  const deleted = await query<{ id: string; component_product_id: string }>(sql`
    DELETE FROM product_kit_items
    WHERE id = ${componentId} AND kit_product_id = ${id} AND workspace_id = ${session.workspace.id}
    RETURNING id, component_product_id
  `);
  if (deleted.length === 0) return c.json({ error: 'not_found' }, 404);

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'inventory.kit.component_removed',
    targetType: 'product',
    targetId: id,
    payload: { kit_item_id: componentId, component_product_id: deleted[0]!.component_product_id },
    ipAddress, userAgent,
  });

  return c.json({ ok: true });
});

// ============================================================================
// Product image upload (Sub-turn 5f) — Vercel Blob, with URL-paste fallback
// ----------------------------------------------------------------------------
// image_url may be an owned Blob URL (auto-cleaned on replace/delete) or an
// external URL (never touched). The existing PATCH still accepts image_url for
// the URL-paste path. Requires BLOB_READ_WRITE_TOKEN in the Vercel project.
// ============================================================================
const IMAGE_ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const IMAGE_MAX_BYTES = 5 * 1024 * 1024;

function buildBlobPath(workspaceId: string, productId: string): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).slice(2, 8);
  return `workspaces/${workspaceId}/products/${productId}-${timestamp}-${random}.jpg`;
}

// Only our own Vercel Blob URLs may be deleted — external URLs are left alone.
function isOwnedBlob(url: string | null): boolean {
  if (!url) return false;
  return url.includes('.blob.vercel-storage.com');
}

async function loadProductForImage(workspaceId: string, productId: string) {
  const rows = await query<{ id: string; image_url: string | null }>(sql`
    SELECT id, image_url FROM products
    WHERE id = ${productId} AND workspace_id = ${workspaceId} AND deleted_at IS NULL
    LIMIT 1
  `);
  return rows[0] ?? null;
}

// POST /api/inventory/products/:id/image — multipart upload (field name "image")
inventory.post('/products/:id/image', requirePermission('inventory.manage'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const productId = c.req.param('id');

  const product = await loadProductForImage(session.workspace.id, productId);
  if (!product) return c.json({ error: 'product_not_found' }, 404);

  let file: File | null = null;
  try {
    const form = await c.req.formData();
    const raw = form.get('image');
    if (raw instanceof File) file = raw;
  } catch {
    return c.json({ error: 'invalid_multipart' }, 400);
  }
  if (!file) return c.json({ error: 'no_file' }, 400);

  if (!IMAGE_ALLOWED_TYPES.includes(file.type)) {
    return c.json({ error: 'invalid_file_type', allowed: IMAGE_ALLOWED_TYPES }, 400);
  }
  if (file.size > IMAGE_MAX_BYTES) {
    return c.json({ error: 'file_too_large', max_bytes: IMAGE_MAX_BYTES, got_bytes: file.size }, 400);
  }

  const path = buildBlobPath(session.workspace.id, productId);
  let blob;
  try {
    blob = await put(path, file, {
      access: 'public',
      contentType: file.type,
      addRandomSuffix: false, // path already carries a random suffix
    });
  } catch (err) {
    console.error('blob upload failed', err);
    return c.json({ error: 'upload_failed' }, 500);
  }

  // Best-effort cleanup of the previous owned blob (never external URLs).
  const oldUrl = product.image_url;
  if (isOwnedBlob(oldUrl)) {
    try { await del(oldUrl!); }
    catch (err) { console.warn('failed to delete old blob (non-fatal)', err); }
  }

  await sql`
    UPDATE products
    SET image_url = ${blob.url}, updated_at = now()
    WHERE id = ${productId} AND workspace_id = ${session.workspace.id}
  `;

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'inventory.product.image_uploaded',
    targetType: 'product',
    targetId: productId,
    payload: {
      new_url: blob.url,
      old_url: oldUrl,
      old_was_owned: isOwnedBlob(oldUrl),
      file_type: file.type,
      file_size: file.size,
    },
    ipAddress, userAgent,
  });

  return c.json({ image_url: blob.url, old_url_removed: isOwnedBlob(oldUrl) });
});

// DELETE /api/inventory/products/:id/image — clear image (delete blob if owned)
inventory.delete('/products/:id/image', requirePermission('inventory.manage'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const productId = c.req.param('id');

  const product = await loadProductForImage(session.workspace.id, productId);
  if (!product) return c.json({ error: 'product_not_found' }, 404);
  if (!product.image_url) return c.json({ ok: true, already_empty: true });

  const oldUrl = product.image_url;
  const wasOwned = isOwnedBlob(oldUrl);
  if (wasOwned) {
    try { await del(oldUrl); }
    catch (err) { console.warn('failed to delete blob (non-fatal)', err); }
  }

  await sql`
    UPDATE products
    SET image_url = NULL, updated_at = now()
    WHERE id = ${productId} AND workspace_id = ${session.workspace.id}
  `;

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'inventory.product.image_removed',
    targetType: 'product',
    targetId: productId,
    payload: { removed_url: oldUrl, was_owned: wasOwned },
    ipAddress, userAgent,
  });

  return c.json({ ok: true, was_owned: wasOwned });
});
