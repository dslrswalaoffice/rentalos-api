import { Hono } from 'hono';
import { z } from 'zod';
import { sql, query } from '../db.js';
import { checkAvailability, AvailabilityError, RESERVING_STATUSES } from '../lib/availability.js';
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
//   → every active rental product with total / reserved / available counts
//     for that specific window. Used by the gear picker in new-order.html.
//
// GET /api/availability/:product_id?from=ISO&to=ISO
//   → one product plus the list of orders blocking availability
//     (order_number, customer, status, quantity).
//
// Reservation model (Sub-turn 1):
//   Assets aren't allocated to specific units until dispatch (order_assets
//   materialises in Sub-turn 3). Until then, availability is measured at the
//   product level:
//
//     total_units    = COUNT(assets) not soft-deleted
//     reserved_units = SUM(order_items.quantity) on rental-type items of
//                      orders whose window overlaps [from, to] and whose
//                      status is in RESERVING_STATUSES
//     available      = MAX(0, total - reserved)
//
//   draft + quoted do NOT reserve — matches the "nothing reserved until
//   confirmed booking + advance paid" decision. This lives in RESERVING_STATUSES
//   so it can move to workspace.settings when we monetise.
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
// Kept inline in the SQL below (Neon HTTP driver doesn't cleanly serialise a
// JS array to a Postgres enum array). If this list grows, hardcode both here
// and in the SQL — the two need to match.
// Single source of truth: the canonical reserving statuses live in
// src/lib/availability.ts. This route imports the constant so the two
// availability code paths can never drift apart again (Sub-turn 5g).
const RESERVING_STATUS_LABEL = RESERVING_STATUSES.join(' / ');
const RESERVING_STATUS_CSV = RESERVING_STATUSES.join(',');

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
    SELECT
      p.id, p.name, p.sku, p.category, p.daily_rate,
      COALESCE(a.total, 0)::int          AS total_units,
      COALESCE(r.reserved, 0)::int       AS reserved_units,
      GREATEST(COALESCE(a.total, 0) - COALESCE(r.reserved, 0), 0)::int AS available_units
    FROM products p
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS total
      FROM assets
      WHERE product_id = p.id
        AND workspace_id = p.workspace_id
        AND deleted_at IS NULL
    ) a ON true
    LEFT JOIN LATERAL (
      SELECT COALESCE(SUM(oi.quantity), 0) AS reserved
      FROM order_items oi
      JOIN orders o ON o.id = oi.order_id
      WHERE oi.product_id = p.id
        AND oi.workspace_id = p.workspace_id
        AND oi.item_type = 'rental'
        AND o.workspace_id = p.workspace_id
        AND o.deleted_at IS NULL
        AND o.status::text = ANY(string_to_array(${RESERVING_STATUS_CSV}::text, ','))
        AND o.rental_start < ${to}::timestamptz
        AND o.rental_end   > ${from}::timestamptz
    ) r ON true
    WHERE p.workspace_id = ${session.workspace.id}
      AND p.is_active = true
      AND p.deleted_at IS NULL
    ORDER BY p.category ASC, p.name ASC
  `);

  return c.json({
    from,
    to,
    reserving_statuses: RESERVING_STATUS_LABEL,
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
      COALESCE(a.total, 0)::int AS total_units
    FROM products p
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS total
      FROM assets
      WHERE product_id = p.id
        AND workspace_id = p.workspace_id
        AND deleted_at IS NULL
    ) a ON true
    WHERE p.id = ${productId}
      AND p.workspace_id = ${session.workspace.id}
      AND p.deleted_at IS NULL
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
      AND o.status::text IN ('confirmed', 'dispatched', 'active')
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
    reserving_statuses: RESERVING_STATUS_LABEL,
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

// ============================================================================
// POST /api/availability/check  (Sub-turn 4d-1)
// ----------------------------------------------------------------------------
// Point-check one product + quantity against a specific window using the shared
// availability engine (src/lib/availability.ts). Warn, don't block — this never
// rejects a booking, it just reports conflicts. `exclude_order_id` drops an
// order's own bookings so editing an existing order doesn't conflict with self.
// Read-only; no audit event.
// ============================================================================
const MAX_CHECK_RANGE_DAYS = 90;
const CHECK_MS_PER_DAY = 24 * 60 * 60 * 1000;

const checkSchema = z.object({
  product_id: z.string().uuid(),
  quantity: z.number().int().positive(),
  start: z.string().datetime(),
  end: z.string().datetime(),
  exclude_order_id: z.string().uuid().optional(),
  // Sub-turn 6i — which location to check tracked-asset capacity against. When
  // omitted the engine falls back to the workspace default location.
  location_id: z.string().uuid().optional(),
});

availability.post('/check', async (c) => {
  const session = c.get('session')!;

  const body = await c.req.json().catch(() => null);
  const parsed = checkSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }
  const input = parsed.data;

  const start = new Date(input.start);
  const end = new Date(input.end);
  if (end.getTime() <= start.getTime()) {
    return c.json({ error: 'invalid_range', reason: 'end_must_be_after_start' }, 400);
  }
  if (end.getTime() - start.getTime() > MAX_CHECK_RANGE_DAYS * CHECK_MS_PER_DAY) {
    return c.json({ error: 'range_too_large', max_days: MAX_CHECK_RANGE_DAYS }, 400);
  }

  try {
    const check = await checkAvailability({
      workspaceId: session.workspace.id,
      productId: input.product_id,
      quantity: input.quantity,
      start,
      end,
      excludeOrderId: input.exclude_order_id,
      locationId: input.location_id,
    });
    return c.json({ check });
  } catch (err) {
    if (err instanceof AvailabilityError && err.code === 'product_not_found') {
      return c.json({ error: 'product_not_found' }, 404);
    }
    throw err;
  }
});
