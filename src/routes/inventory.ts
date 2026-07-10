import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { sql, query } from '../db.js';
import { audit } from '../lib/audit.js';
import { put, del } from '@vercel/blob';
import { loadCustomFieldValues, upsertCustomFieldValues } from '../lib/custom_fields.js';
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
  hsn_code: string | null;
  buffer_before_hours: number;
  buffer_after_hours: number;
  shortage_limit: number;
  tracking_mode: string;
  stock_quantity: number | null;
  is_active: boolean;
  is_kit: boolean;
  component_count: number;
  created_at: string;
  updated_at: string;
  total_units: number;
  available_units: number;
  rented_units: number;
  in_repair_units: number;
  effective_capacity: number;
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
      p.specifications, p.notes, p.image_url, p.hsn_code,
      p.buffer_before_hours, p.buffer_after_hours, p.shortage_limit,
      p.tracking_mode, p.stock_quantity,
      p.is_active, p.is_kit,
      (SELECT COUNT(*) FROM product_kit_items pki WHERE pki.kit_product_id = p.id)::int AS component_count,
      p.created_at, p.updated_at,
      COALESCE(a.total,     0)::int AS total_units,
      COALESCE(a.available, 0)::int AS available_units,
      COALESCE(a.rented,    0)::int AS rented_units,
      COALESCE(a.in_repair, 0)::int AS in_repair_units,
      (CASE WHEN p.tracking_mode = 'bulk' THEN COALESCE(p.stock_quantity, 0) ELSE COALESCE(a.total, 0) END)::int AS effective_capacity
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
      p.specifications, p.notes, p.image_url, p.hsn_code,
      p.buffer_before_hours, p.buffer_after_hours, p.shortage_limit,
      p.tracking_mode, p.stock_quantity,
      p.is_active, p.is_kit,
      (SELECT COUNT(*) FROM product_kit_items pki WHERE pki.kit_product_id = p.id)::int AS component_count,
      p.created_at, p.updated_at,
      COALESCE(a.total,     0)::int AS total_units,
      COALESCE(a.available, 0)::int AS available_units,
      COALESCE(a.rented,    0)::int AS rented_units,
      COALESCE(a.in_repair, 0)::int AS in_repair_units,
      (CASE WHEN p.tracking_mode = 'bulk' THEN COALESCE(p.stock_quantity, 0) ELSE COALESCE(a.total, 0) END)::int AS effective_capacity
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
  const custom_fields = await loadCustomFieldValues(session.workspace.id, 'product', id);
  return c.json({ product, custom_fields });
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
  is_kit: z.boolean().default(false),
  // How many physical units to create right now (asset rows). Ignored for bulk.
  initial_units: z.number().int().min(0).max(50).default(1),
  // Tracking mode (Sub-turn 6h): 'tracked' (asset rows) or 'bulk' (stock_quantity).
  tracking_mode: z.enum(['tracked', 'bulk']).default('tracked'),
  stock_quantity: z.number().int().min(0).nullable().optional(),
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

  // Tracking-mode / stock-quantity coupling (mirrors the DB constraint).
  if (input.tracking_mode === 'bulk') {
    if (input.stock_quantity == null) return c.json({ error: 'stock_quantity_required' }, 400);
  } else if (input.stock_quantity != null) {
    return c.json({ error: 'stock_quantity_not_allowed_for_tracked' }, 400);
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
  const codes = input.tracking_mode === 'bulk' ? [] : assetCodesFor(sku, input.initial_units);
  const inserted = await query<ProductRow & { asset_ids: string[] | null }>(sql`
    WITH new_product AS (
      INSERT INTO products (
        workspace_id, sku, name, category, description,
        daily_rate, weekly_rate, monthly_rate, deposit, replacement_value,
        specifications, notes, is_kit, tracking_mode, stock_quantity, created_by
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
        ${input.is_kit},
        ${input.tracking_mode}::text,
        ${input.stock_quantity ?? null}::int,
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
      0::int AS component_count,
      (CASE WHEN np.tracking_mode = 'bulk' THEN COALESCE(np.stock_quantity, 0)
            ELSE (SELECT COUNT(*) FROM new_assets) END)::int AS effective_capacity,
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
  image_url: z.string().max(2000).optional(),
  hsn_code: z.string().max(8).optional(),
  buffer_before_hours: z.number().int().min(0).max(72).optional(),
  buffer_after_hours: z.number().int().min(0).max(72).optional(),
  shortage_limit: z.number().int().min(0).max(100).optional(),
  tracking_mode: z.enum(['tracked', 'bulk']).optional(),
  stock_quantity: z.number().int().min(0).nullable().optional(),
  is_active: z.boolean().optional(),
  is_kit: z.boolean().optional(),
  custom_fields: z.array(z.object({ definition_id: z.string().uuid(), value: z.string().nullable() })).optional(),
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
  const existing = await query<{ id: string; is_active: boolean; name: string; is_kit: boolean; tracking_mode: string; stock_quantity: number | null }>(sql`
    SELECT id, is_active, name, is_kit, tracking_mode, stock_quantity FROM products
    WHERE id = ${id} AND workspace_id = ${session.workspace.id} AND deleted_at IS NULL
    LIMIT 1
  `);
  if (existing.length === 0) return c.json({ error: 'not_found' }, 404);
  const before = existing[0]!;

  // Tracking mode is immutable after creation (Sub-turn 6h).
  if (p.tracking_mode && p.tracking_mode !== before.tracking_mode) {
    return c.json({ error: 'tracking_mode_immutable', reason: 'Delete and recreate the product to change tracking mode.' }, 409);
  }
  // Only bulk products carry a stock_quantity.
  if (p.stock_quantity != null && before.tracking_mode !== 'bulk') {
    return c.json({ error: 'stock_quantity_not_allowed_for_tracked' }, 409);
  }

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
      image_url           = COALESCE(${p.image_url           ?? null}::text,    image_url),
      hsn_code            = COALESCE(${p.hsn_code            ?? null}::text,    hsn_code),
      buffer_before_hours = COALESCE(${p.buffer_before_hours ?? null}::integer, buffer_before_hours),
      buffer_after_hours  = COALESCE(${p.buffer_after_hours  ?? null}::integer, buffer_after_hours),
      shortage_limit      = COALESCE(${p.shortage_limit      ?? null}::integer, shortage_limit),
      stock_quantity      = COALESCE(${p.stock_quantity      ?? null}::integer, stock_quantity),
      is_active           = COALESCE(${p.is_active           ?? null}::boolean, is_active),
      is_kit              = COALESCE(${p.is_kit              ?? null}::boolean, is_kit)
    WHERE id = ${id} AND workspace_id = ${session.workspace.id}
    RETURNING
      id, sku, name, category, description,
      daily_rate, weekly_rate, monthly_rate, deposit, replacement_value,
      specifications, notes, image_url, hsn_code,
      buffer_before_hours, buffer_after_hours, shortage_limit,
      tracking_mode, stock_quantity,
      is_active, is_kit, created_at, updated_at,
      0::int AS total_units, 0::int AS available_units,
      0::int AS rented_units, 0::int AS in_repair_units,
      (CASE WHEN tracking_mode = 'bulk' THEN COALESCE(stock_quantity, 0) ELSE 0 END)::int AS effective_capacity,
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

inventory.post('/products/:id/kit-components', requireRole('owner', 'manager'), async (c) => {
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

inventory.patch('/products/:id/kit-components/:componentId', requireRole('owner', 'manager'), async (c) => {
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
inventory.delete('/products/:id/kit-components/:componentId', requireRole('owner', 'manager'), async (c) => {
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
inventory.post('/products/:id/image', requireRole('owner', 'manager'), async (c) => {
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
inventory.delete('/products/:id/image', requireRole('owner', 'manager'), async (c) => {
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
