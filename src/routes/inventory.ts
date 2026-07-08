import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { sql, query } from '../db.js';
import { audit } from '../lib/audit.js';
import {
  sessionMiddleware,
  requireAuth,
  requireRole,
  type SessionUser,
  type SessionWorkspace,
} from '../middleware/session.js';

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
  weekly_rate: number | null;
  monthly_rate: number | null;
  deposit: number;
  replacement_value: number | null;
  specifications: Record<string, unknown>;
  notes: string | null;
  image_url: string | null;
  is_active: boolean;
  created_at: string;
  updated_at: string;
  total_units: number;
  available_units: number;
  rented_units: number;
  in_repair_units: number;
};

// ============================================================================
// GET /api/inventory/products — list products for current workspace
// Query params: ?search=fx3 &category=Camera%20Body &include_archived=true
// ============================================================================
inventory.get('/products', async (c) => {
  const session = c.get('session')!;
  const search = c.req.query('search')?.trim() || null;
  const category = c.req.query('category')?.trim() || null;
  const includeArchived = c.req.query('include_archived') === 'true';
  const searchPattern = search ? `%${search}%` : null;

  const products = await query<ProductRow>(sql`
    SELECT
      p.id, p.sku, p.name, p.category, p.description,
      p.daily_rate, p.weekly_rate, p.monthly_rate, p.deposit, p.replacement_value,
      p.specifications, p.notes, p.image_url, p.is_active,
      p.created_at, p.updated_at,
      COALESCE(a.total,     0)::int AS total_units,
      COALESCE(a.available, 0)::int AS available_units,
      COALESCE(a.rented,    0)::int AS rented_units,
      COALESCE(a.in_repair, 0)::int AS in_repair_units
    FROM products p
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*)                                              AS total,
        COUNT(*) FILTER (WHERE status = 'available')          AS available,
        COUNT(*) FILTER (WHERE status = 'rented')             AS rented,
        COUNT(*) FILTER (WHERE status = 'in_repair')          AS in_repair
      FROM assets
      WHERE product_id = p.id AND deleted_at IS NULL
    ) a ON true
    WHERE p.workspace_id = ${session.workspace.id}
      AND p.deleted_at IS NULL
      AND (${includeArchived}::boolean OR p.is_active = true)
      AND (${searchPattern}::text IS NULL
           OR p.name ILIKE ${searchPattern}::text
           OR p.sku  ILIKE ${searchPattern}::text)
      AND (${category}::text IS NULL OR p.category = ${category}::text)
    ORDER BY p.category ASC, p.name ASC
    LIMIT 200
  `);

  // Aggregate a category → count map for the sidebar/filter chips.
  const byCategory: Record<string, number> = {};
  for (const p of products) byCategory[p.category] = (byCategory[p.category] || 0) + 1;

  return c.json({
    products,
    total: products.length,
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
      p.daily_rate, p.weekly_rate, p.monthly_rate, p.deposit, p.replacement_value,
      p.specifications, p.notes, p.image_url, p.is_active,
      p.created_at, p.updated_at,
      COALESCE(a.total,     0)::int AS total_units,
      COALESCE(a.available, 0)::int AS available_units,
      COALESCE(a.rented,    0)::int AS rented_units,
      COALESCE(a.in_repair, 0)::int AS in_repair_units
    FROM products p
    LEFT JOIN LATERAL (
      SELECT
        COUNT(*)                                              AS total,
        COUNT(*) FILTER (WHERE status = 'available')          AS available,
        COUNT(*) FILTER (WHERE status = 'rented')             AS rented,
        COUNT(*) FILTER (WHERE status = 'in_repair')          AS in_repair
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
  return c.json({ product });
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
  weekly_rate: z.number().int().positive().optional(),
  monthly_rate: z.number().int().positive().optional(),
  deposit: z.number().int().min(0).default(0),
  replacement_value: z.number().int().positive().optional(),
  specifications: z.record(z.unknown()).optional(),
  notes: z.string().max(2000).optional(),
  // How many physical units to create right now (asset rows).
  initial_units: z.number().int().min(0).max(50).default(1),
});

inventory.post('/products', requireRole('owner', 'manager'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);

  const body = await c.req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }
  const input = parsed.data;
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
  //    If either step fails, both roll back.
  const codes = assetCodesFor(sku, input.initial_units);
  const inserted = await query<ProductRow & { asset_ids: string[] | null }>(sql`
    WITH new_product AS (
      INSERT INTO products (
        workspace_id, sku, name, category, description,
        daily_rate, weekly_rate, monthly_rate, deposit, replacement_value,
        specifications, notes, created_by
      ) VALUES (
        ${session.workspace.id},
        ${sku},
        ${input.name},
        ${input.category},
        ${input.description ?? null},
        ${input.daily_rate},
        ${input.weekly_rate ?? null},
        ${input.monthly_rate ?? null},
        ${input.deposit},
        ${input.replacement_value ?? null},
        ${JSON.stringify(input.specifications ?? {})}::jsonb,
        ${input.notes ?? null},
        ${session.user.id}
      )
      RETURNING *
    ),
    new_assets AS (
      INSERT INTO assets (workspace_id, product_id, asset_code, condition, status)
      SELECT
        ${session.workspace.id},
        (SELECT id FROM new_product),
        code_val,
        'excellent'::asset_condition,
        'available'::asset_status
      FROM jsonb_array_elements_text(${JSON.stringify(codes)}::jsonb) AS code_val
      RETURNING id
    )
    SELECT
      np.*,
      (SELECT COUNT(*) FROM new_assets)::int AS total_units,
      (SELECT COUNT(*) FROM new_assets)::int AS available_units,
      0::int AS rented_units,
      0::int AS in_repair_units,
      (SELECT array_agg(id) FROM new_assets) AS asset_ids
    FROM new_product np
  `);

  const product = inserted[0];
  if (!product) {
    return c.json({ error: 'create_failed' }, 500);
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
  weekly_rate: z.number().int().positive().optional(),
  monthly_rate: z.number().int().positive().optional(),
  deposit: z.number().int().min(0).optional(),
  replacement_value: z.number().int().positive().optional(),
  specifications: z.record(z.unknown()).optional(),
  notes: z.string().max(2000).optional(),
  is_active: z.boolean().optional(),
});

inventory.patch('/products/:id', requireRole('owner', 'manager'), async (c) => {
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
  const existing = await query<{ id: string; is_active: boolean; name: string }>(sql`
    SELECT id, is_active, name FROM products
    WHERE id = ${id} AND workspace_id = ${session.workspace.id} AND deleted_at IS NULL
    LIMIT 1
  `);
  if (existing.length === 0) return c.json({ error: 'not_found' }, 404);
  const before = existing[0]!;

  // COALESCE-based partial update: any field the caller omits is preserved.
  // We deliberately do NOT support clearing nullable fields (setting to NULL) via
  // PATCH — that would require a different sentinel and adds error surface. Add a
  // dedicated /products/:id/clear-field endpoint later if the need is real.
  const updated = await query<ProductRow>(sql`
    UPDATE products SET
      name              = COALESCE(${p.name              ?? null}::text,    name),
      category          = COALESCE(${p.category          ?? null}::text,    category),
      description       = COALESCE(${p.description       ?? null}::text,    description),
      daily_rate        = COALESCE(${p.daily_rate        ?? null}::integer, daily_rate),
      weekly_rate       = COALESCE(${p.weekly_rate       ?? null}::integer, weekly_rate),
      monthly_rate      = COALESCE(${p.monthly_rate      ?? null}::integer, monthly_rate),
      deposit           = COALESCE(${p.deposit           ?? null}::integer, deposit),
      replacement_value = COALESCE(${p.replacement_value ?? null}::integer, replacement_value),
      specifications    = COALESCE(${p.specifications ? JSON.stringify(p.specifications) : null}::jsonb, specifications),
      notes             = COALESCE(${p.notes             ?? null}::text,    notes),
      is_active         = COALESCE(${p.is_active         ?? null}::boolean, is_active)
    WHERE id = ${id} AND workspace_id = ${session.workspace.id}
    RETURNING
      id, sku, name, category, description,
      daily_rate, weekly_rate, monthly_rate, deposit, replacement_value,
      specifications, notes, image_url, is_active, created_at, updated_at,
      0::int AS total_units, 0::int AS available_units,
      0::int AS rented_units, 0::int AS in_repair_units
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

  return c.json({ product: updated[0] });
});

// ============================================================================
// DELETE /api/inventory/products/:id — soft delete (archive)
// Refuses if any asset is currently rented.
// ============================================================================
inventory.delete('/products/:id', requireRole('owner', 'manager'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');

  const rented = await query<{ n: number }>(sql`
    SELECT COUNT(*)::int AS n
    FROM assets
    WHERE product_id = ${id}
      AND workspace_id = ${session.workspace.id}
      AND status = 'rented'
      AND deleted_at IS NULL
  `);
  if ((rented[0]?.n ?? 0) > 0) {
    return c.json({ error: 'has_rented_assets', rented_count: rented[0]!.n }, 409);
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
