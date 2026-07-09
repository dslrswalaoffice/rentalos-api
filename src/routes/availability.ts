import { Hono } from 'hono';
import { z } from 'zod';
import { sql, query } from '../db.js';
import {
  sessionMiddleware,
  requireAuth,
  type SessionUser,
  type SessionWorkspace,
} from '../middleware/session.js';

// ============================================================================
// src/routes/availability.ts
// ----------------------------------------------------------------------------
// GET /api/availability?from=ISO&to=ISO
//   → returns every rental product in the workspace with total / reserved /
//     available unit counts for that specific window. Used by the gear picker
//     in the new-order wizard.
//
// GET /api/availability/:product_id?from=ISO&to=ISO
//   → one product, plus the list of orders that are eating into the availability
//     (order_number, customer, status, quantity). Used when the operator wants
//     to see "why is this camera unavailable next weekend?"
//
// Reservation model (Sub-turn 1):
//   Order items point to products with a quantity — assets aren't allocated to
//   specific units until dispatch (Sub-turn 3 will materialise order_assets).
//   So availability = total active assets minus quantities on rental-type items
//   of orders whose window overlaps [from, to] and whose status counts as
//   "reserving" (confirmed, dispatched, active).
//
//   Draft and quoted orders do NOT reserve inventory — matches the locked-in
//   decision "nothing is reserved until confirmed booking + advance paid."
//   A future soft-hold feature can add 'quoted' to the reserving set per-order.
// ============================================================================

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

export const availability = new Hono<Env>();
availability.use('*', sessionMiddleware, requireAuth);

// Statuses that count as "this gear is committed" for availability purposes.
// Kept as a single source of truth so we can move it into workspace.settings
// later without hunting through the codebase.
const RESERVING_STATUSES = ['confirmed', 'dispatched', 'active'] as const;

const windowSchema = z.object({
  from: z.string().datetime(),
  to:   z.string().datetime(),
});

// ============================================================================
// GET /api/availability?from=...&to=...
// ============================================================================
availability.get('/', async (c) => {
  const session = c.get('session')!;

  const parsed = windowSchema.safeParse({
    from: c.req.query('from'),
    to:   c.req.query('to'),
  });
  if (!parsed.success) {
    return c.json({
      error: 'invalid_request',
      reason: 'from_and_to_required_as_iso_datetime',
      issues: parsed.error.issues,
    }, 400);
  }
  const { from, to } = parsed.data;

  if (new Date(to) <= new Date(from)) {
    return c.json({ error: 'invalid_request', reason: 'end_before_start' }, 400);
  }

  const rows = await query<{
    id: string;
    name: string;
    sku: string;
    category: string;
    daily_rate: number;
    total_units: number;
    reserved_units: number;
    available_units: number;
  }>(sql`
    WITH product_totals AS (
      SELECT
        p.id, p.name, p.sku, p.category, p.daily_rate,
        COALESCE(COUNT(a.id) FILTER (WHERE a.is_active = true AND a.deleted_at IS NULL), 0)::int AS total_units
      FROM products p
      LEFT JOIN assets a ON a.product_id = p.id AND a.workspace_id = p.workspace_id
      WHERE p.workspace_id = ${session.workspace.id}
        AND p.is_active = true
        AND p.deleted_at IS NULL
      GROUP BY p.id
    ),
    reserved AS (
      SELECT
        oi.product_id,
        COALESCE(SUM(oi.quantity), 0)::int AS reserved_units
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE oi.workspace_id = ${session.workspace.id}
        AND oi.item_type = 'rental'
        AND o.workspace_id = ${session.workspace.id}
        AND o.deleted_at IS NULL
        AND o.status = ANY(${RESERVING_STATUSES as unknown as string[]}::order_status[])
        AND o.rental_start < ${to}::timestamptz
        AND o.rental_end   > ${from}::timestamptz
      GROUP BY oi.product_id
    )
    SELECT
      pt.id, pt.name, pt.sku, pt.category, pt.daily_rate,
      pt.total_units,
      COALESCE(r.reserved_units, 0)::int AS reserved_units,
      GREATEST(pt.total_units - COALESCE(r.reserved_units, 0), 0)::int AS available_units
    FROM product_totals pt
    LEFT JOIN reserved r ON r.product_id = pt.id
    ORDER BY pt.name ASC
  `);

  return c.json({
    from,
    to,
    products: rows,
  });
});

// ============================================================================
// GET /api/availability/:product_id?from=...&to=...
// ============================================================================
availability.get('/:product_id', async (c) => {
  const session = c.get('session')!;
  const productId = c.req.param('product_id');

  const parsed = windowSchema.safeParse({
    from: c.req.query('from'),
    to:   c.req.query('to'),
  });
  if (!parsed.success) {
    return c.json({
      error: 'invalid_request',
      reason: 'from_and_to_required_as_iso_datetime',
      issues: parsed.error.issues,
    }, 400);
  }
  const { from, to } = parsed.data;

  if (new Date(to) <= new Date(from)) {
    return c.json({ error: 'invalid_request', reason: 'end_before_start' }, 400);
  }

  const productRows = await query<{
    id: string; name: string; sku: string; category: string;
    daily_rate: number; total_units: number;
  }>(sql`
    SELECT
      p.id, p.name, p.sku, p.category, p.daily_rate,
      COALESCE(COUNT(a.id) FILTER (WHERE a.is_active = true AND a.deleted_at IS NULL), 0)::int AS total_units
    FROM products p
    LEFT JOIN assets a ON a.product_id = p.id AND a.workspace_id = p.workspace_id
    WHERE p.id = ${productId}
      AND p.workspace_id = ${session.workspace.id}
      AND p.deleted_at IS NULL
    GROUP BY p.id
    LIMIT 1
  `);
  if (productRows.length === 0) {
    return c.json({ error: 'not_found' }, 404);
  }
  const product = productRows[0]!;

  const blockingRows = await query<{
    order_id: string; order_number: number; status: string;
    customer_name: string; quantity: number;
    rental_start: string; rental_end: string;
  }>(sql`
    SELECT
      o.id AS order_id,
      o.order_number,
      o.status::text AS status,
      p.display_name AS customer_name,
      SUM(oi.quantity)::int AS quantity,
      MIN(o.rental_start) AS rental_start,
      MIN(o.rental_end)   AS rental_end
    FROM order_items oi
    JOIN orders o ON o.id = oi.order_id
    JOIN people p ON p.id = o.customer_person_id
    WHERE oi.workspace_id = ${session.workspace.id}
      AND oi.product_id = ${productId}
      AND oi.item_type = 'rental'
      AND o.workspace_id = ${session.workspace.id}
      AND o.deleted_at IS NULL
      AND o.status = ANY(${RESERVING_STATUSES as unknown as string[]}::order_status[])
      AND o.rental_start < ${to}::timestamptz
      AND o.rental_end   > ${from}::timestamptz
    GROUP BY o.id, o.order_number, o.status, p.display_name
    ORDER BY o.rental_start ASC
  `);

  const reservedUnits = blockingRows.reduce((sum, r) => sum + Number(r.quantity), 0);
  const availableUnits = Math.max(product.total_units - reservedUnits, 0);

  return c.json({
    from,
    to,
    product: {
      id: product.id,
      name: product.name,
      sku: product.sku,
      category: product.category,
      daily_rate: product.daily_rate,
      total_units: product.total_units,
      reserved_units: reservedUnits,
      available_units: availableUnits,
    },
    blocked_by_orders: blockingRows,
  });
});
