import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { sql, query } from '../db.js';
import { audit } from '../lib/audit.js';
import { recomputeOrderTotals } from '../lib/pricing.js';
import {
  sessionMiddleware,
  requireAuth,
  type SessionUser,
  type SessionWorkspace,
} from '../middleware/session.js';

// ============================================================================
// src/routes/orders.ts
// ----------------------------------------------------------------------------
// Sub-turn 1 scope:
//   * Create draft orders (customer + rental window)
//   * List / detail with filters
//   * Update draft
//   * Add / update / remove order items
//   * Advisory state transitions (draft -> quoted -> confirmed -> ...)
//   * Every mutation writes to order_events AND audit_events
//
// Explicitly NOT here yet (later sub-turns):
//   * Pricing engine — Sub-turn 2 (src/lib/pricing.ts)
//   * Payment endpoints — Sub-turn 2
//   * Invoice generation — Sub-turn 2
//   * OTP handover, dispatch, return — Sub-turn 3
//   * Availability endpoint — separate file src/routes/availability.ts
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

export const orders = new Hono<Env>();
orders.use('*', sessionMiddleware, requireAuth);

// ----------------------------------------------------------------------------
// State machine (advisory — recorded, not enforced)
// ----------------------------------------------------------------------------
// Non-canonical jumps are allowed with { force: true } and logged distinctly.
// This matches rental reality: walk-ins skip quotes, repeat customers skip
// confirmation, B2B negotiations bounce back and forth. Enforcement can be
// flipped on later via workspace.settings without a schema change.

const ORDER_STATUSES = [
  'draft', 'quoted', 'confirmed', 'dispatched',
  'active', 'returned', 'closed', 'cancelled',
] as const;
type OrderStatus = typeof ORDER_STATUSES[number];

const CANONICAL_NEXT: Record<OrderStatus, OrderStatus[]> = {
  draft:      ['quoted', 'confirmed', 'cancelled'],
  quoted:     ['confirmed', 'draft', 'cancelled'],
  confirmed:  ['dispatched', 'cancelled'],
  dispatched: ['returned', 'active'],
  active:     ['returned'],
  returned:   ['closed'],
  closed:     [],
  cancelled:  [],
};

function isCanonical(from: OrderStatus, to: OrderStatus): boolean {
  return CANONICAL_NEXT[from]?.includes(to) ?? false;
}

const ITEM_TYPES = [
  'rental', 'delivery_fee', 'late_fee', 'damage',
  'discount', 'tax', 'deposit', 'other',
] as const;

const DISPATCH_TYPES = ['pickup', 'delivery'] as const;
const CHANNELS = ['walk_in', 'planned', 'whatsapp', 'phone', 'other'] as const;

// ----------------------------------------------------------------------------
// Item-level status machine (advisory — mirrors order.status)
// ----------------------------------------------------------------------------
// pending_dispatch is initial; the last four are terminal; dispatched is a
// non-terminal middle state. Non-canonical jumps require { force: true }.
const ITEM_STATUSES = [
  'pending_dispatch',
  'dispatched',
  'returned',
  'returned_with_damage',
  'not_returned_chargeable',
  'not_returned_non_chargeable',
  'missing',
] as const;
type OrderItemStatus = typeof ITEM_STATUSES[number];

const CANONICAL_ITEM_TRANSITIONS: Record<OrderItemStatus, OrderItemStatus[]> = {
  pending_dispatch:            ['dispatched', 'not_returned_non_chargeable', 'missing'],
  dispatched:                  ['returned', 'returned_with_damage', 'not_returned_chargeable', 'missing'],
  returned:                    ['returned_with_damage'],   // damage discovered post-return
  returned_with_damage:        [],
  not_returned_chargeable:     ['returned'],               // customer eventually returns it
  not_returned_non_chargeable: ['returned'],               // customer eventually returns it
  missing:                     ['returned'],               // recovered
};

const TERMINAL_ITEM_STATUSES: readonly OrderItemStatus[] = [
  'returned',
  'returned_with_damage',
  'not_returned_chargeable',
  'not_returned_non_chargeable',
  'missing',
];

function isCanonicalItem(from: OrderItemStatus, to: OrderItemStatus): boolean {
  return CANONICAL_ITEM_TRANSITIONS[from]?.includes(to) ?? false;
}

// Computed on read — an order can finalize only when every item is terminal.
function deriveCanFinalize(items: OrderItemRow[]): boolean {
  if (items.length === 0) return false; // empty order can't finalize
  return items.every((item) =>
    (TERMINAL_ITEM_STATUSES as readonly string[]).includes(item.status),
  );
}

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function clientCtx(c: Context) {
  const ipAddress =
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    c.req.header('x-real-ip') ??
    null;
  const userAgent = c.req.header('user-agent') ?? null;
  return { ipAddress, userAgent };
}

type OrderRow = {
  id: string;
  workspace_id: string;
  order_number: number;
  customer_person_id: string;
  status: OrderStatus;
  rental_start: string | null;
  rental_end: string | null;
  dispatch_type: string;
  delivery_address: string | null;
  channel: string;
  subtotal_paise: number;
  tax_paise: number;
  discount_paise: number;
  total_paise: number;
  deposit_paise: number;
  paid_paise: number;
  balance_paise: number;
  notes: string | null;
  internal_notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  customer_name?: string;
  customer_phone?: string;
  customer_email?: string | null;
};

type OrderItemRow = {
  id: string;
  order_id: string;
  workspace_id: string;
  parent_item_id: string | null;
  item_type: string;
  product_id: string | null;
  description: string;
  quantity: number;
  daily_rate_paise: number | null;
  billable_days: number | null;
  unit_amount_paise: number;
  total_amount_paise: number;
  manual_price: boolean;
  status: OrderItemStatus;
  dispatched_at: string | null;
  returned_at: string | null;
  condition_notes: string | null;
  handed_to: string | null;
  received_by_user_id: string | null;
  dispatch_notes: string | null;
  received_by_name?: string | null;
  returned_by_user_id: string | null;
  returned_from: string | null;
  returned_by_name?: string | null;
  sort_order: number;
  created_at: string;
  updated_at: string;
  product_name?: string | null;
  product_sku?: string | null;
};

async function nextOrderNumber(workspaceId: string): Promise<number> {
  // Atomic: bump the counter and return the value we consumed.
  const rows = await query<{ n: number }>(sql`
    UPDATE workspaces
       SET next_order_number = next_order_number + 1
     WHERE id = ${workspaceId}
     RETURNING next_order_number - 1 AS n
  `);
  return Number(rows[0]!.n);
}

async function loadOrder(orderId: string, workspaceId: string) {
  const rows = await query<OrderRow>(sql`
    SELECT
      o.*,
      p.display_name AS customer_name,
      p.phone        AS customer_phone,
      p.email        AS customer_email
    FROM orders o
    JOIN people p ON p.id = o.customer_person_id
    WHERE o.id = ${orderId}
      AND o.workspace_id = ${workspaceId}
      AND o.deleted_at IS NULL
    LIMIT 1
  `);
  return rows[0] ?? null;
}

async function loadItems(orderId: string) {
  return await query<OrderItemRow>(sql`
    SELECT
      oi.*,
      pr.name AS product_name,
      pr.sku  AS product_sku,
      ru.display_name AS received_by_name,
      rt.display_name AS returned_by_name
    FROM order_items oi
    LEFT JOIN products pr ON pr.id = oi.product_id
    LEFT JOIN users ru ON ru.id = oi.received_by_user_id
    LEFT JOIN users rt ON rt.id = oi.returned_by_user_id
    WHERE oi.order_id = ${orderId}
    ORDER BY oi.sort_order ASC, oi.created_at ASC
  `);
}

async function loadEvents(orderId: string) {
  return await query<{
    id: string; event_type: string;
    from_status: string | null; to_status: string | null;
    payload: unknown; occurred_at: string;
    actor_name: string | null;
  }>(sql`
    SELECT
      oe.id, oe.event_type, oe.from_status::text AS from_status,
      oe.to_status::text AS to_status,
      oe.payload, oe.occurred_at,
      u.display_name AS actor_name
    FROM order_events oe
    LEFT JOIN users u ON u.id = oe.actor_user_id
    WHERE oe.order_id = ${orderId}
    ORDER BY oe.occurred_at DESC
    LIMIT 200
  `);
}

async function recordOrderEvent(input: {
  workspaceId: string;
  orderId: string;
  eventType: string;
  fromStatus?: OrderStatus | null;
  toStatus?: OrderStatus | null;
  payload?: Record<string, unknown>;
  actorUserId: string;
}) {
  await sql`
    INSERT INTO order_events
      (workspace_id, order_id, event_type, from_status, to_status, payload, actor_user_id)
    VALUES (
      ${input.workspaceId},
      ${input.orderId},
      ${input.eventType},
      ${input.fromStatus ?? null}::order_status,
      ${input.toStatus ?? null}::order_status,
      ${JSON.stringify(input.payload ?? {})}::jsonb,
      ${input.actorUserId}
    )
  `;
}

// ============================================================================
// GET /api/orders — list with filters
// ============================================================================
orders.get('/', async (c) => {
  const session = c.get('session')!;

  const status = c.req.query('status')?.trim() || null;
  const q      = c.req.query('q')?.trim() || null;
  const from   = c.req.query('from')?.trim() || null;
  const to     = c.req.query('to')?.trim() || null;
  const limit  = Math.min(Number(c.req.query('limit') || 50), 200);
  const offset = Math.max(Number(c.req.query('offset') || 0), 0);

  const searchPattern = q ? `%${q}%` : null;

  const rows = await query<OrderRow>(sql`
    SELECT
      o.id, o.workspace_id, o.order_number, o.customer_person_id, o.status,
      o.rental_start, o.rental_end, o.dispatch_type, o.delivery_address,
      o.channel,
      o.subtotal_paise, o.tax_paise, o.discount_paise, o.total_paise,
      o.deposit_paise, o.paid_paise, o.balance_paise,
      o.notes, o.internal_notes, o.created_by,
      o.created_at, o.updated_at, o.deleted_at,
      p.display_name AS customer_name,
      p.phone        AS customer_phone
    FROM orders o
    JOIN people p ON p.id = o.customer_person_id
    WHERE o.workspace_id = ${session.workspace.id}
      AND o.deleted_at IS NULL
      AND (${status}::text IS NULL OR o.status::text = ${status}::text)
      AND (${searchPattern}::text IS NULL
           OR p.display_name ILIKE ${searchPattern}::text
           OR CAST(o.order_number AS text) = ${q}::text)
      AND (${from}::timestamptz IS NULL OR o.rental_start >= ${from}::timestamptz)
      AND (${to}::timestamptz   IS NULL OR o.rental_end   <= ${to}::timestamptz)
    ORDER BY o.created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `);

  const totals = await query<{
    total: number; drafts: number; quoted: number; confirmed: number;
    dispatched: number; returned: number; closed: number;
  }>(sql`
    SELECT
      COUNT(*)::int                                        AS total,
      COUNT(*) FILTER (WHERE status = 'draft')::int        AS drafts,
      COUNT(*) FILTER (WHERE status = 'quoted')::int       AS quoted,
      COUNT(*) FILTER (WHERE status = 'confirmed')::int    AS confirmed,
      COUNT(*) FILTER (WHERE status = 'dispatched')::int   AS dispatched,
      COUNT(*) FILTER (WHERE status = 'returned')::int     AS returned,
      COUNT(*) FILTER (WHERE status = 'closed')::int       AS closed
    FROM orders
    WHERE workspace_id = ${session.workspace.id}
      AND deleted_at IS NULL
  `);

  return c.json({ orders: rows, counts: totals[0] });
});

// ============================================================================
// GET /api/orders/:id — detail with items + timeline
// ============================================================================
orders.get('/:id', async (c) => {
  const session = c.get('session')!;
  const id = c.req.param('id');

  const order = await loadOrder(id, session.workspace.id);
  if (!order) return c.json({ error: 'not_found' }, 404);

  const [items, events] = await Promise.all([
    loadItems(id),
    loadEvents(id),
  ]);

  const canFinalize = deriveCanFinalize(items);
  return c.json({ order, items, events, can_finalize: canFinalize });
});

// ============================================================================
// POST /api/orders — create a draft
// ============================================================================
const createSchema = z.object({
  customer_person_id: z.string().uuid(),
  rental_start:       z.string().datetime().optional(),
  rental_end:         z.string().datetime().optional(),
  dispatch_type:      z.enum(DISPATCH_TYPES).default('pickup'),
  delivery_address:   z.string().max(500).optional(),
  channel:            z.enum(CHANNELS).default('planned'),
  notes:              z.string().max(2000).optional(),
  internal_notes:     z.string().max(2000).optional(),
});

orders.post('/', async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);

  const body = await c.req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }
  const input = parsed.data;

  // Verify customer belongs to workspace.
  const customer = await query<{ id: string; display_name: string }>(sql`
    SELECT id, display_name FROM people
    WHERE id = ${input.customer_person_id}
      AND workspace_id = ${session.workspace.id}
      AND deleted_at IS NULL
    LIMIT 1
  `);
  if (customer.length === 0) {
    return c.json({ error: 'customer_not_found' }, 404);
  }

  if (input.rental_start && input.rental_end &&
      new Date(input.rental_end) <= new Date(input.rental_start)) {
    return c.json({ error: 'invalid_request', reason: 'end_before_start' }, 400);
  }

  const orderNumber = await nextOrderNumber(session.workspace.id);

  const inserted = await query<OrderRow>(sql`
    INSERT INTO orders (
      workspace_id, order_number, customer_person_id, status,
      rental_start, rental_end, dispatch_type, delivery_address,
      channel, notes, internal_notes, created_by
    ) VALUES (
      ${session.workspace.id},
      ${orderNumber},
      ${input.customer_person_id},
      'draft'::order_status,
      ${input.rental_start ?? null}::timestamptz,
      ${input.rental_end   ?? null}::timestamptz,
      ${input.dispatch_type}::text,
      ${input.delivery_address ?? null},
      ${input.channel}::text,
      ${input.notes ?? null},
      ${input.internal_notes ?? null},
      ${session.user.id}
    )
    RETURNING *
  `);

  const order = inserted[0]!;

  await recordOrderEvent({
    workspaceId: session.workspace.id,
    orderId: order.id,
    eventType: 'order.created',
    toStatus: 'draft',
    payload: {
      order_number: order.order_number,
      customer_name: customer[0]!.display_name,
      channel: order.channel,
    },
    actorUserId: session.user.id,
  });

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'orders.order.created',
    targetType: 'order',
    targetId: order.id,
    payload: { order_number: order.order_number },
    ipAddress, userAgent,
  });

  return c.json({ order }, 201);
});

// ============================================================================
// PATCH /api/orders/:id — update non-terminal order (COALESCE pattern)
// ============================================================================
const updateSchema = z.object({
  customer_person_id: z.string().uuid().optional(),
  rental_start:       z.string().datetime().optional(),
  rental_end:         z.string().datetime().optional(),
  dispatch_type:      z.enum(DISPATCH_TYPES).optional(),
  delivery_address:   z.string().max(500).optional(),
  channel:            z.enum(CHANNELS).optional(),
  notes:              z.string().max(2000).optional(),
  internal_notes:     z.string().max(2000).optional(),
});

orders.patch('/:id', async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');

  const body = await c.req.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }
  const p = parsed.data;

  const before = await loadOrder(id, session.workspace.id);
  if (!before) return c.json({ error: 'not_found' }, 404);
  if (before.status === 'closed' || before.status === 'cancelled') {
    return c.json({ error: 'locked', reason: `status_${before.status}` }, 409);
  }

  // Customer swap only on drafts.
  if (p.customer_person_id && before.status !== 'draft') {
    return c.json({ error: 'customer_locked_after_draft' }, 409);
  }
  if (p.customer_person_id) {
    const check = await query<{ id: string }>(sql`
      SELECT id FROM people
      WHERE id = ${p.customer_person_id}
        AND workspace_id = ${session.workspace.id}
        AND deleted_at IS NULL
      LIMIT 1
    `);
    if (check.length === 0) return c.json({ error: 'customer_not_found' }, 404);
  }

  // Cross-field validation with merged values.
  const nextStart = p.rental_start ?? before.rental_start;
  const nextEnd   = p.rental_end   ?? before.rental_end;
  if (nextStart && nextEnd && new Date(nextEnd) <= new Date(nextStart)) {
    return c.json({ error: 'invalid_request', reason: 'end_before_start' }, 400);
  }

  const updated = await query<OrderRow>(sql`
    UPDATE orders SET
      customer_person_id = COALESCE(${p.customer_person_id ?? null}::uuid,        customer_person_id),
      rental_start       = COALESCE(${p.rental_start       ?? null}::timestamptz, rental_start),
      rental_end         = COALESCE(${p.rental_end         ?? null}::timestamptz, rental_end),
      dispatch_type      = COALESCE(${p.dispatch_type      ?? null}::text,        dispatch_type),
      delivery_address   = COALESCE(${p.delivery_address   ?? null}::text,        delivery_address),
      channel            = COALESCE(${p.channel            ?? null}::text,        channel),
      notes              = COALESCE(${p.notes              ?? null}::text,        notes),
      internal_notes     = COALESCE(${p.internal_notes     ?? null}::text,        internal_notes),
      updated_at         = now()
    WHERE id = ${id}
      AND workspace_id = ${session.workspace.id}
    RETURNING *
  `);

  if (updated.length === 0) return c.json({ error: 'not_found' }, 404);
  const changedFields = Object.keys(p);

  await recordOrderEvent({
    workspaceId: session.workspace.id,
    orderId: id,
    eventType: 'order.updated',
    fromStatus: before.status,
    toStatus: before.status,
    payload: { fields: changedFields },
    actorUserId: session.user.id,
  });

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'orders.order.updated',
    targetType: 'order',
    targetId: id,
    payload: { fields: changedFields },
    ipAddress, userAgent,
  });

  // Moving the rental window changes billable days -> recompute rental pricing.
  const windowMoved =
    updated[0]!.rental_start !== before.rental_start ||
    updated[0]!.rental_end !== before.rental_end;
  if (windowMoved) {
    const { order } = await recomputeOrderTotals(id, session.workspace.id, session.user.id);
    return c.json({ order });
  }

  return c.json({ order: updated[0] });
});

// ============================================================================
// POST /api/orders/:id/items — add a line item
// ============================================================================
const addItemSchema = z.object({
  item_type:         z.enum(ITEM_TYPES),
  product_id:        z.string().uuid().optional(),
  parent_item_id:    z.string().uuid().optional(),
  description:       z.string().min(1).max(500),
  quantity:          z.number().int().positive().default(1),
  unit_amount_paise: z.number().int().default(0),
  daily_rate_paise:  z.number().int().optional(),
  billable_days:     z.number().int().positive().optional(),
  sort_order:        z.number().int().default(0),
});

orders.post('/:id/items', async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');

  const body = await c.req.json().catch(() => null);
  const parsed = addItemSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }
  const input = parsed.data;

  const order = await loadOrder(id, session.workspace.id);
  if (!order) return c.json({ error: 'not_found' }, 404);
  if (order.status === 'closed' || order.status === 'cancelled') {
    return c.json({ error: 'locked' }, 409);
  }

  // Rental items must have a valid product from this workspace.
  if (input.item_type === 'rental') {
    if (!input.product_id) {
      return c.json({ error: 'invalid_request', reason: 'product_id_required_for_rental' }, 400);
    }
    const p = await query<{ id: string }>(sql`
      SELECT id FROM products
      WHERE id = ${input.product_id}
        AND workspace_id = ${session.workspace.id}
        AND deleted_at IS NULL
      LIMIT 1
    `);
    if (p.length === 0) return c.json({ error: 'product_not_found' }, 404);
  }

  const totalAmount = input.unit_amount_paise * input.quantity;

  const inserted = await query<OrderItemRow>(sql`
    INSERT INTO order_items (
      workspace_id, order_id, parent_item_id, item_type, product_id,
      description, quantity, daily_rate_paise, billable_days,
      unit_amount_paise, total_amount_paise, sort_order
    ) VALUES (
      ${session.workspace.id},
      ${id},
      ${input.parent_item_id ?? null}::uuid,
      ${input.item_type}::order_item_type,
      ${input.product_id ?? null}::uuid,
      ${input.description},
      ${input.quantity},
      ${input.daily_rate_paise ?? null},
      ${input.billable_days ?? null},
      ${input.unit_amount_paise},
      ${totalAmount},
      ${input.sort_order}
    )
    RETURNING *
  `);

  await recordOrderEvent({
    workspaceId: session.workspace.id,
    orderId: id,
    eventType: 'order.item.added',
    fromStatus: order.status,
    toStatus: order.status,
    payload: {
      item_id: inserted[0]!.id,
      item_type: input.item_type,
      description: input.description,
    },
    actorUserId: session.user.id,
  });

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'orders.item.added',
    targetType: 'order_item',
    targetId: inserted[0]!.id,
    payload: { order_id: id, item_type: input.item_type },
    ipAddress, userAgent,
  });

  // Auto-recompute pricing so totals reflect the new line before we respond.
  const { items } = await recomputeOrderTotals(id, session.workspace.id, session.user.id);
  const fresh = items.find((it) => it.id === inserted[0]!.id) ?? inserted[0];

  return c.json({ item: fresh }, 201);
});

// ============================================================================
// PATCH /api/orders/:id/items/:itemId — update a line item
// ============================================================================
const updateItemSchema = z.object({
  description:       z.string().min(1).max(500).optional(),
  quantity:          z.number().int().positive().optional(),
  unit_amount_paise: z.number().int().optional(),
  daily_rate_paise:  z.number().int().optional(),
  billable_days:     z.number().int().positive().optional(),
  sort_order:        z.number().int().optional(),
  parent_item_id:    z.string().uuid().optional(),
  manual_price:      z.boolean().optional(),
});

orders.patch('/:id/items/:itemId', async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');
  const itemId = c.req.param('itemId');

  const body = await c.req.json().catch(() => null);
  const parsed = updateItemSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }
  const p = parsed.data;

  const order = await loadOrder(id, session.workspace.id);
  if (!order) return c.json({ error: 'not_found' }, 404);
  if (order.status === 'closed' || order.status === 'cancelled') {
    return c.json({ error: 'locked' }, 409);
  }

  const existing = await query<OrderItemRow>(sql`
    SELECT * FROM order_items
    WHERE id = ${itemId}
      AND order_id = ${id}
      AND workspace_id = ${session.workspace.id}
    LIMIT 1
  `);
  if (existing.length === 0) return c.json({ error: 'not_found' }, 404);

  const nextQty  = p.quantity          ?? existing[0]!.quantity;
  const nextUnit = p.unit_amount_paise ?? existing[0]!.unit_amount_paise;
  const nextTotal = nextQty * nextUnit;

  // Manual-price detection:
  //   * explicit { manual_price: false } reverts the line to engine control
  //   * editing unit_amount_paise on a rental line locks it as a manual override
  //   * explicit { manual_price: true } also locks it
  // A null here means "leave manual_price as-is" (COALESCE below preserves it).
  const isRental = existing[0]!.item_type === 'rental';
  const wantsRevert = p.manual_price === false;
  const wantsOverride =
    !wantsRevert &&
    ((p.unit_amount_paise !== undefined && isRental) || p.manual_price === true);
  const manualPriceToSet: boolean | null = wantsRevert
    ? false
    : wantsOverride
      ? true
      : null;

  const updated = await query<OrderItemRow>(sql`
    UPDATE order_items SET
      description       = COALESCE(${p.description       ?? null}::text, description),
      quantity          = COALESCE(${p.quantity          ?? null}::int,  quantity),
      unit_amount_paise = COALESCE(${p.unit_amount_paise ?? null}::bigint, unit_amount_paise),
      daily_rate_paise  = COALESCE(${p.daily_rate_paise  ?? null}::bigint, daily_rate_paise),
      billable_days     = COALESCE(${p.billable_days     ?? null}::int,  billable_days),
      sort_order        = COALESCE(${p.sort_order        ?? null}::int,  sort_order),
      parent_item_id    = COALESCE(${p.parent_item_id    ?? null}::uuid, parent_item_id),
      manual_price      = COALESCE(${manualPriceToSet    ?? null}::boolean, manual_price),
      total_amount_paise = ${nextTotal},
      updated_at         = now()
    WHERE id = ${itemId}
      AND workspace_id = ${session.workspace.id}
    RETURNING *
  `);

  if (updated.length === 0) return c.json({ error: 'not_found' }, 404);

  const priceOverridden = wantsOverride && p.unit_amount_paise !== undefined && isRental;
  const auditEventType = priceOverridden
    ? 'orders.item.price_overridden'
    : wantsRevert
      ? 'orders.item.price_reverted'
      : 'orders.item.updated';

  await recordOrderEvent({
    workspaceId: session.workspace.id,
    orderId: id,
    eventType: 'order.item.updated',
    fromStatus: order.status,
    toStatus: order.status,
    payload: {
      item_id: itemId,
      fields: Object.keys(p),
      price_overridden: priceOverridden,
      price_reverted: wantsRevert,
    },
    actorUserId: session.user.id,
  });

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: auditEventType,
    targetType: 'order_item',
    targetId: itemId,
    payload: priceOverridden
      ? {
          order_id: id,
          old_unit_amount_paise: existing[0]!.unit_amount_paise,
          new_unit_amount_paise: p.unit_amount_paise,
        }
      : { order_id: id, fields: Object.keys(p) },
    ipAddress, userAgent,
  });

  // Auto-recompute so the override / revert is reflected in totals immediately.
  const { items } = await recomputeOrderTotals(id, session.workspace.id, session.user.id);
  const fresh = items.find((it) => it.id === itemId) ?? updated[0];

  return c.json({ item: fresh });
});

// ============================================================================
// DELETE /api/orders/:id/items/:itemId — remove a line item
// ============================================================================
orders.delete('/:id/items/:itemId', async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');
  const itemId = c.req.param('itemId');

  const order = await loadOrder(id, session.workspace.id);
  if (!order) return c.json({ error: 'not_found' }, 404);
  if (order.status === 'closed' || order.status === 'cancelled') {
    return c.json({ error: 'locked' }, 409);
  }

  const deleted = await query<{ id: string; description: string }>(sql`
    DELETE FROM order_items
    WHERE id = ${itemId}
      AND order_id = ${id}
      AND workspace_id = ${session.workspace.id}
    RETURNING id, description
  `);
  if (deleted.length === 0) return c.json({ error: 'not_found' }, 404);

  await recordOrderEvent({
    workspaceId: session.workspace.id,
    orderId: id,
    eventType: 'order.item.removed',
    fromStatus: order.status,
    toStatus: order.status,
    payload: { item_id: itemId, description: deleted[0]!.description },
    actorUserId: session.user.id,
  });

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'orders.item.removed',
    targetType: 'order_item',
    targetId: itemId,
    payload: { order_id: id },
    ipAddress, userAgent,
  });

  // Auto-recompute so cached totals drop the removed line.
  await recomputeOrderTotals(id, session.workspace.id, session.user.id);

  return c.json({ ok: true });
});

// ============================================================================
// PATCH /api/orders/:id/items/:itemId/status — advisory item-status change
// Body: { to, reason?, force?, condition_notes? }
// ============================================================================
// Physical lifecycle of a single line item. Does NOT touch order.status (that
// stays operator-driven) and does NOT recompute pricing (money is settled by
// the invoice module, Sub-turn 2.4). Non-canonical jumps need { force: true }.
const itemStatusSchema = z.object({
  to:              z.enum(ITEM_STATUSES),
  reason:          z.string().max(500).optional(),
  force:           z.boolean().default(false),
  condition_notes: z.string().max(2000).optional(),
});

orders.patch('/:id/items/:itemId/status', async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');
  const itemId = c.req.param('itemId');

  const body = await c.req.json().catch(() => null);
  const parsed = itemStatusSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }
  const { to, reason, force, condition_notes } = parsed.data;

  const order = await loadOrder(id, session.workspace.id);
  if (!order) return c.json({ error: 'not_found' }, 404);
  if (order.status === 'closed' || order.status === 'cancelled') {
    return c.json({ error: 'order_locked' }, 409);
  }

  const existing = await query<OrderItemRow>(sql`
    SELECT * FROM order_items
    WHERE id = ${itemId}
      AND order_id = ${id}
      AND workspace_id = ${session.workspace.id}
    LIMIT 1
  `);
  if (existing.length === 0) return c.json({ error: 'not_found' }, 404);

  const from = existing[0]!.status;
  if (from === to) {
    return c.json({ item: existing[0], unchanged: true });
  }

  const canonical = isCanonicalItem(from, to);
  if (!canonical && !force) {
    return c.json({
      error: 'non_canonical_transition',
      from,
      to,
      hint: 'resubmit with { "force": true } to override — reason recommended',
    }, 409);
  }

  // Side-effects: stamp timestamps (once) for the relevant transitions.
  const setDispatched = to === 'dispatched';
  const setReturned = to === 'returned' || to === 'returned_with_damage';

  const updated = await query<OrderItemRow>(sql`
    UPDATE order_items SET
      status          = ${to}::order_item_status,
      dispatched_at   = CASE WHEN ${setDispatched}::boolean THEN COALESCE(dispatched_at, now()) ELSE dispatched_at END,
      returned_at     = CASE WHEN ${setReturned}::boolean   THEN COALESCE(returned_at, now())   ELSE returned_at   END,
      condition_notes = COALESCE(${condition_notes ?? null}::text, condition_notes),
      updated_at      = now()
    WHERE id = ${itemId}
      AND workspace_id = ${session.workspace.id}
    RETURNING *
  `);
  if (updated.length === 0) return c.json({ error: 'not_found' }, 404);

  const eventPayload: Record<string, unknown> = { item_id: itemId, from, to, canonical };
  if (reason) eventPayload.reason = reason;
  if (condition_notes) eventPayload.condition_notes = condition_notes;

  await recordOrderEvent({
    workspaceId: session.workspace.id,
    orderId: id,
    eventType: canonical ? 'order.item.status.changed' : 'order.item.status.forced',
    payload: eventPayload,
    actorUserId: session.user.id,
  });

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: canonical ? 'orders.item.status.changed' : 'orders.item.status.forced',
    targetType: 'order_item',
    targetId: itemId,
    payload: {
      order_id: id,
      item_id: itemId,
      from,
      to,
      canonical,
      reason: reason ?? null,
      condition_notes: condition_notes ?? null,
    },
    ipAddress, userAgent,
  });

  return c.json({ item: updated[0], canonical });
});

// ============================================================================
// POST /api/orders/:id/recompute — force a pricing recompute
// ============================================================================
orders.post('/:id/recompute', async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');

  const order = await loadOrder(id, session.workspace.id);
  if (!order) return c.json({ error: 'not_found' }, 404);
  if (order.status === 'closed' || order.status === 'cancelled') {
    return c.json({ error: 'order_locked' }, 409);
  }

  const { order: fresh, items, changed } = await recomputeOrderTotals(
    id,
    session.workspace.id,
    session.user.id,
  );

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'orders.pricing.recomputed',
    targetType: 'order',
    targetId: id,
    payload: { changed },
    ipAddress, userAgent,
  });

  return c.json({ order: fresh, items, changed });
});

// ============================================================================
// POST /api/orders/:id/transitions — advisory state change
// Body: { to, reason?, force? }
// ============================================================================
const transitionSchema = z.object({
  to:     z.enum(ORDER_STATUSES),
  reason: z.string().max(500).optional(),
  force:  z.boolean().default(false),
});

orders.post('/:id/transitions', async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');

  const body = await c.req.json().catch(() => null);
  const parsed = transitionSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }
  const { to, reason, force } = parsed.data;

  const order = await loadOrder(id, session.workspace.id);
  if (!order) return c.json({ error: 'not_found' }, 404);

  if (order.status === to) {
    return c.json({ order, unchanged: true });
  }

  let canonical = isCanonical(order.status, to);
  let finalizeViaCanFinalize = false;

  // Closing is canonical from ANY status once every item is in a terminal state.
  // Computed server-side from ground truth (item statuses) — never trusted from
  // the client. This lets the "Ready to close" banner close cleanly without a
  // forced transition.
  if (to === 'closed' && !canonical) {
    const items = await loadItems(id);
    if (deriveCanFinalize(items)) {
      canonical = true;
      finalizeViaCanFinalize = true;
    }
  }

  // Advisory: non-canonical needs explicit { force: true }. UI shows a warning.
  if (!canonical && !force) {
    return c.json({
      error: 'non_canonical_transition',
      from: order.status,
      to,
      hint: 'resubmit with { "force": true } to override — reason recommended',
    }, 409);
  }

  const updated = await query<OrderRow>(sql`
    UPDATE orders
       SET status = ${to}::order_status,
           updated_at = now()
     WHERE id = ${id}
       AND workspace_id = ${session.workspace.id}
    RETURNING *
  `);

  await recordOrderEvent({
    workspaceId: session.workspace.id,
    orderId: id,
    eventType: canonical ? 'order.status.changed' : 'order.status.forced',
    fromStatus: order.status,
    toStatus: to,
    payload: { canonical, forced: !canonical, reason: reason ?? null, finalize_via_can_finalize: finalizeViaCanFinalize },
    actorUserId: session.user.id,
  });

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: canonical ? 'orders.status.changed' : 'orders.status.forced',
    targetType: 'order',
    targetId: id,
    payload: { from: order.status, to, canonical, reason: reason ?? null, finalize_via_can_finalize: finalizeViaCanFinalize },
    ipAddress, userAgent,
  });

  return c.json({ order: updated[0], canonical });
});

// ============================================================================
// POST /api/orders/:id/dispatch — batch hand-over of pending items
// ============================================================================
// Transitions a chosen subset of pending_dispatch items to dispatched in one
// request, stamps hand-over metadata, and (if the order is still pre-dispatch)
// advances order.status to 'dispatched'. Records ONE batch order_event + audit
// row — not per-item events (those would be noise).
const dispatchSchema = z.object({
  item_ids:            z.array(z.string().uuid()).min(1),
  handed_to:           z.string().max(200).optional(),
  received_by_user_id: z.string().uuid().optional(),
  dispatch_notes:      z.string().max(1000).optional(),
});

orders.post('/:id/dispatch', async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');

  const body = await c.req.json().catch(() => null);
  const parsed = dispatchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }
  const { handed_to, dispatch_notes } = parsed.data;
  const requested = [...new Set(parsed.data.item_ids)];

  const order = await loadOrder(id, session.workspace.id);
  if (!order) return c.json({ error: 'not_found' }, 404);
  if (order.status === 'closed' || order.status === 'cancelled') {
    return c.json({ error: 'order_locked' }, 409);
  }

  const allItems = await loadItems(id);
  const byId = new Map(allItems.map((it) => [it.id, it]));

  const missing = requested.filter((x) => !byId.has(x));
  if (missing.length) {
    return c.json({ error: 'invalid_item_ids', item_ids: missing }, 400);
  }

  const notPending = requested
    .map((x) => byId.get(x)!)
    .filter((it) => it.status !== 'pending_dispatch');
  if (notPending.length) {
    return c.json({
      error: 'items_not_pending',
      items: notPending.map((it) => ({ id: it.id, status: it.status })),
    }, 409);
  }

  // Resolve the staff member — default to the session user; if supplied, verify
  // they're a member of this workspace.
  let receivedBy = session.user.id;
  if (parsed.data.received_by_user_id) {
    const u = await query<{ id: string }>(sql`
      SELECT u.id FROM users u
      JOIN workspace_memberships wm ON wm.user_id = u.id
      WHERE u.id = ${parsed.data.received_by_user_id}::uuid
        AND wm.workspace_id = ${session.workspace.id}::uuid
      LIMIT 1
    `);
    if (u.length === 0) return c.json({ error: 'invalid_user' }, 400);
    receivedBy = parsed.data.received_by_user_id;
  }

  // Per-item UPDATE (avoids the JS-array-param serialization gotcha called out
  // in CLAUDE.md). The status guard makes each write idempotent against a race.
  for (const itemId of requested) {
    await sql`
      UPDATE order_items SET
        status              = 'dispatched'::order_item_status,
        dispatched_at       = now(),
        handed_to           = ${handed_to ?? null}::text,
        received_by_user_id = ${receivedBy}::uuid,
        dispatch_notes      = ${dispatch_notes ?? null}::text,
        updated_at          = now()
      WHERE id = ${itemId}::uuid
        AND workspace_id = ${session.workspace.id}::uuid
        AND status = 'pending_dispatch'::order_item_status
    `;
  }

  // Auto-advance order status if it's still pre-dispatch.
  const orderStatusChanged = ['draft', 'quoted', 'confirmed'].includes(order.status);
  if (orderStatusChanged) {
    await sql`
      UPDATE orders SET status = 'dispatched'::order_status, updated_at = now()
      WHERE id = ${id}::uuid AND workspace_id = ${session.workspace.id}::uuid
    `;
  }

  const payload: Record<string, unknown> = {
    item_ids: requested,
    count: requested.length,
    handed_to: handed_to ?? null,
    received_by_user_id: receivedBy,
    dispatch_notes: dispatch_notes ?? null,
    auto_order_status_transition: orderStatusChanged,
  };

  await recordOrderEvent({
    workspaceId: session.workspace.id,
    orderId: id,
    eventType: 'order.dispatch.batch',
    fromStatus: order.status,
    toStatus: orderStatusChanged ? 'dispatched' : order.status,
    payload,
    actorUserId: session.user.id,
  });

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'orders.dispatch.batch',
    targetType: 'order',
    targetId: id,
    payload,
    ipAddress, userAgent,
  });

  const freshOrder = await loadOrder(id, session.workspace.id);
  const freshItems = await loadItems(id);
  const dispatched = freshItems
    .filter((it) => requested.includes(it.id))
    .map((it) => ({
      id: it.id,
      description: it.description,
      status: it.status,
      handed_to: it.handed_to,
      received_by_user_id: it.received_by_user_id,
      dispatched_at: it.dispatched_at,
      dispatch_notes: it.dispatch_notes,
    }));

  return c.json({
    order: freshOrder,
    items_dispatched: dispatched,
    order_status_changed: orderStatusChanged,
  });
});

// ============================================================================
// POST /api/orders/:id/return — batch check-in of dispatched items
// ============================================================================
// The mirror of dispatch: each dispatched item is classified into one of five
// terminal outcomes. condition_notes is required for damage / not-returned-
// chargeable / missing. When every item on the order becomes terminal, the
// order auto-advances to 'returned'. Pricing is recomputed so chargeable_paise
// (0 for waived items) and the tax breakdown refresh. ONE batch event + audit.
const RETURN_OUTCOMES = [
  'returned', 'returned_with_damage', 'not_returned_chargeable',
  'not_returned_non_chargeable', 'missing',
] as const;
const NOTES_REQUIRED_OUTCOMES = new Set([
  'returned_with_damage', 'not_returned_chargeable', 'missing',
]);

const returnSchema = z.object({
  items: z.array(z.object({
    item_id:         z.string().uuid(),
    outcome:         z.enum(RETURN_OUTCOMES),
    condition_notes: z.string().max(2000).optional(),
  })).min(1),
  received_from:       z.string().max(200).optional(),
  returned_by_user_id: z.string().uuid().optional(),
});

orders.post('/:id/return', async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');

  const body = await c.req.json().catch(() => null);
  const parsed = returnSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }
  const { items: reqItems, received_from } = parsed.data;

  const order = await loadOrder(id, session.workspace.id);
  if (!order) return c.json({ error: 'not_found' }, 404);
  if (order.status === 'closed' || order.status === 'cancelled') {
    return c.json({ error: 'order_locked' }, 409);
  }

  const allItems = await loadItems(id);
  const byId = new Map(allItems.map((it) => [it.id, it]));

  const missing = reqItems.map((r) => r.item_id).filter((x) => !byId.has(x));
  if (missing.length) {
    return c.json({ error: 'invalid_item_ids', item_ids: [...new Set(missing)] }, 400);
  }

  const notDispatched = reqItems.filter((r) => byId.get(r.item_id)!.status !== 'dispatched');
  if (notDispatched.length) {
    return c.json({
      error: 'items_not_dispatched',
      items: notDispatched.map((r) => ({ id: r.item_id, status: byId.get(r.item_id)!.status })),
    }, 409);
  }

  const notesMissing = reqItems.filter(
    (r) => NOTES_REQUIRED_OUTCOMES.has(r.outcome) && (r.condition_notes ?? '').trim().length < 5,
  );
  if (notesMissing.length) {
    return c.json({
      error: 'condition_notes_required',
      item_ids: notesMissing.map((r) => r.item_id),
    }, 400);
  }

  // Resolve the staff member — default to session user; if supplied, verify.
  let returnedBy = session.user.id;
  if (parsed.data.returned_by_user_id) {
    const u = await query<{ id: string }>(sql`
      SELECT u.id FROM users u
      JOIN workspace_memberships wm ON wm.user_id = u.id
      WHERE u.id = ${parsed.data.returned_by_user_id}::uuid
        AND wm.workspace_id = ${session.workspace.id}::uuid
      LIMIT 1
    `);
    if (u.length === 0) return c.json({ error: 'invalid_user' }, 400);
    returnedBy = parsed.data.returned_by_user_id;
  }

  // Per-item UPDATE (each item gets its own outcome). Loop avoids the JS-array
  // param gotcha; the status guard keeps each write race-safe. Pre-existing
  // condition_notes is preserved when this batch doesn't supply one.
  for (const r of reqItems) {
    await sql`
      UPDATE order_items SET
        status              = ${r.outcome}::order_item_status,
        returned_at         = now(),
        returned_by_user_id = ${returnedBy}::uuid,
        returned_from       = ${received_from ?? null}::text,
        condition_notes     = COALESCE(${r.condition_notes ?? null}::text, condition_notes),
        updated_at          = now()
      WHERE id = ${r.item_id}::uuid
        AND workspace_id = ${session.workspace.id}::uuid
        AND status = 'dispatched'::order_item_status
    `;
  }

  // Auto-advance to 'returned' once every item is terminal (and the order is
  // still mid-rental).
  const afterItems = await loadItems(id);
  const allTerminal = deriveCanFinalize(afterItems);
  const orderStatusChanged = allTerminal && ['dispatched', 'active'].includes(order.status);
  if (orderStatusChanged) {
    await sql`
      UPDATE orders SET status = 'returned'::order_status, updated_at = now()
      WHERE id = ${id}::uuid AND workspace_id = ${session.workspace.id}::uuid
    `;
  }

  // Refresh chargeable_paise + tax breakdown + cached totals (order isn't locked).
  await recomputeOrderTotals(id, session.workspace.id, session.user.id);

  const terminalCount = afterItems.filter(
    (it) => (TERMINAL_ITEM_STATUSES as readonly string[]).includes(it.status),
  ).length;

  const payload: Record<string, unknown> = {
    items: reqItems.map((r) => ({
      item_id: r.item_id,
      outcome: r.outcome,
      condition_notes: r.condition_notes ?? null,
    })),
    received_from: received_from ?? null,
    returned_by_user_id: returnedBy,
    auto_order_status_transition: orderStatusChanged,
    terminal_items_count: terminalCount,
    total_items_count: afterItems.length,
  };

  await recordOrderEvent({
    workspaceId: session.workspace.id,
    orderId: id,
    eventType: 'order.return.batch',
    fromStatus: order.status,
    toStatus: orderStatusChanged ? 'returned' : order.status,
    payload,
    actorUserId: session.user.id,
  });

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'orders.return.batch',
    targetType: 'order',
    targetId: id,
    payload,
    ipAddress, userAgent,
  });

  const freshOrder = await loadOrder(id, session.workspace.id);
  const freshItems = await loadItems(id);
  const requestedIds = new Set(reqItems.map((r) => r.item_id));
  const returned = freshItems
    .filter((it) => requestedIds.has(it.id))
    .map((it) => ({
      id: it.id,
      description: it.description,
      status: it.status,
      returned_at: it.returned_at,
      returned_by_user_id: it.returned_by_user_id,
      returned_from: it.returned_from,
      condition_notes: it.condition_notes,
    }));

  return c.json({
    order: freshOrder,
    items_returned: returned,
    order_status_changed: orderStatusChanged,
    can_finalize: deriveCanFinalize(freshItems),
  });
});

// ============================================================================
// DELETE /api/orders/:id — soft delete (only drafts)
// ============================================================================
orders.delete('/:id', async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');

  const order = await loadOrder(id, session.workspace.id);
  if (!order) return c.json({ error: 'not_found' }, 404);

  if (order.status !== 'draft') {
    return c.json({
      error: 'not_deletable',
      reason: 'use_cancel_transition_for_non_drafts',
    }, 409);
  }

  await sql`
    UPDATE orders
       SET deleted_at = now(),
           updated_at = now()
     WHERE id = ${id}
       AND workspace_id = ${session.workspace.id}
  `;

  await recordOrderEvent({
    workspaceId: session.workspace.id,
    orderId: id,
    eventType: 'order.deleted',
    fromStatus: order.status,
    payload: { order_number: order.order_number },
    actorUserId: session.user.id,
  });

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'orders.order.deleted',
    targetType: 'order',
    targetId: id,
    payload: { order_number: order.order_number },
    ipAddress, userAgent,
  });

  return c.json({ ok: true });
});
