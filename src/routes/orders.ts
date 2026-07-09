// ============================================================================
// src/routes/orders.ts
// ----------------------------------------------------------------------------
// Sub-turn 1 scope:
//   * Create draft orders (customer + rental window + gear lines)
//   * List / detail with filters
//   * Update draft
//   * Add / update / remove order items
//   * Advisory state transitions (draft -> quoted -> confirmed -> ... )
//   * Every mutation emits an order_events row + an audit_events row
//
// Explicitly NOT here yet (later sub-turns):
//   * Pricing engine (billable-day calc lives in src/lib/pricing.ts — Sub-turn 2)
//   * Payment recording endpoints (Sub-turn 2)
//   * Invoice generation (Sub-turn 2)
//   * OTP handover + dispatch/return endpoints (Sub-turn 3)
//   * Availability endpoint (separate file src/routes/availability.ts)
// ============================================================================

import { Hono } from 'hono';
import { sql } from '../lib/db';
import { requireSession } from '../lib/auth';
import { audit } from '../lib/audit';

const app = new Hono();

// ----------------------------------------------------------------------------
// State machine (advisory — recorded, not enforced)
// ----------------------------------------------------------------------------
// We warn on non-canonical transitions but do not block, matching the rental
// business reality where repeat customers skip quote, walk-ins skip 3 states,
// and B2B negotiations bounce back and forth. The audit log is the source of
// truth. If a workspace ever wants strict enforcement, we flip a setting.

type OrderStatus =
  | 'draft'
  | 'quoted'
  | 'confirmed'
  | 'dispatched'
  | 'active'
  | 'returned'
  | 'closed'
  | 'cancelled';

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

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------
function ipOf(c: any): string | null {
  return (
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ||
    c.req.header('x-real-ip') ||
    null
  );
}

function uaOf(c: any): string | null {
  return c.req.header('user-agent') || null;
}

async function nextOrderNumber(workspaceId: string): Promise<number> {
  // Atomic: bump the counter and return the value we consumed.
  const rows = await sql`
    UPDATE workspaces
       SET next_order_number = next_order_number + 1
     WHERE id = ${workspaceId}
     RETURNING next_order_number - 1 AS n
  `;
  return Number(rows[0].n);
}

async function loadOrder(orderId: string, workspaceId: string) {
  const rows = await sql`
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
  `;
  return rows[0] ?? null;
}

async function loadItems(orderId: string) {
  return await sql`
    SELECT
      oi.*,
      pr.name  AS product_name,
      pr.sku   AS product_sku
    FROM order_items oi
    LEFT JOIN products pr ON pr.id = oi.product_id
    WHERE oi.order_id = ${orderId}
    ORDER BY oi.sort_order ASC, oi.created_at ASC
  `;
}

async function loadEvents(orderId: string) {
  return await sql`
    SELECT
      oe.id, oe.event_type, oe.from_status, oe.to_status,
      oe.payload, oe.occurred_at,
      u.display_name AS actor_name
    FROM order_events oe
    LEFT JOIN users u ON u.id = oe.actor_user_id
    WHERE oe.order_id = ${orderId}
    ORDER BY oe.occurred_at DESC
    LIMIT 200
  `;
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
    VALUES
      (${input.workspaceId}, ${input.orderId}, ${input.eventType},
       ${input.fromStatus ?? null}, ${input.toStatus ?? null},
       ${JSON.stringify(input.payload ?? {})}::jsonb,
       ${input.actorUserId})
  `;
}

// ============================================================================
// GET /api/orders  — list with filters
// ============================================================================
app.get('/', async (c) => {
  const session = await requireSession(c);
  if (!session) return c.json({ error: 'unauthorized' }, 401);

  const url = new URL(c.req.url);
  const status  = url.searchParams.get('status');            // e.g. 'draft'
  const q       = url.searchParams.get('q');                 // customer or number
  const from    = url.searchParams.get('from');              // ISO date
  const to      = url.searchParams.get('to');                // ISO date
  const limit   = Math.min(Number(url.searchParams.get('limit') || 50), 200);
  const offset  = Math.max(Number(url.searchParams.get('offset') || 0), 0);

  // Note: sql template tags handle parameterisation; no injection risk.
  const rows = await sql`
    SELECT
      o.id, o.order_number, o.status,
      o.rental_start, o.rental_end, o.dispatch_type, o.channel,
      o.total_paise, o.paid_paise, o.balance_paise,
      o.created_at, o.updated_at,
      p.display_name AS customer_name,
      p.phone        AS customer_phone
    FROM orders o
    JOIN people p ON p.id = o.customer_person_id
    WHERE o.workspace_id = ${session.workspace.id}
      AND o.deleted_at IS NULL
      AND (${status}::text IS NULL OR o.status::text = ${status})
      AND (${q}::text IS NULL
           OR p.display_name ILIKE '%' || ${q} || '%'
           OR CAST(o.order_number AS text) = ${q})
      AND (${from}::timestamptz IS NULL OR o.rental_start >= ${from}::timestamptz)
      AND (${to}::timestamptz   IS NULL OR o.rental_end   <= ${to}::timestamptz)
    ORDER BY o.created_at DESC
    LIMIT ${limit} OFFSET ${offset}
  `;

  const totals = await sql`
    SELECT
      COUNT(*)                                        AS total,
      COUNT(*) FILTER (WHERE status = 'draft')        AS drafts,
      COUNT(*) FILTER (WHERE status = 'quoted')       AS quoted,
      COUNT(*) FILTER (WHERE status = 'confirmed')    AS confirmed,
      COUNT(*) FILTER (WHERE status = 'dispatched')   AS dispatched,
      COUNT(*) FILTER (WHERE status = 'returned')     AS returned,
      COUNT(*) FILTER (WHERE status = 'closed')       AS closed
    FROM orders
    WHERE workspace_id = ${session.workspace.id}
      AND deleted_at IS NULL
  `;

  return c.json({ orders: rows, counts: totals[0] });
});

// ============================================================================
// GET /api/orders/:id  — detail with items + timeline
// ============================================================================
app.get('/:id', async (c) => {
  const session = await requireSession(c);
  if (!session) return c.json({ error: 'unauthorized' }, 401);

  const id = c.req.param('id');
  const order = await loadOrder(id, session.workspace.id);
  if (!order) return c.json({ error: 'not_found' }, 404);

  const [items, events] = await Promise.all([
    loadItems(id),
    loadEvents(id),
  ]);

  return c.json({ order, items, events });
});

// ============================================================================
// POST /api/orders  — create a draft
// ============================================================================
app.post('/', async (c) => {
  const session = await requireSession(c);
  if (!session) return c.json({ error: 'unauthorized' }, 401);

  const body = await c.req.json().catch(() => ({} as any));
  const {
    customer_person_id,
    rental_start,
    rental_end,
    dispatch_type,
    delivery_address,
    channel,
    notes,
    internal_notes,
  } = body;

  if (!customer_person_id) {
    return c.json({ error: 'validation', field: 'customer_person_id' }, 422);
  }

  // Verify customer belongs to workspace
  const customer = await sql`
    SELECT id, display_name FROM people
    WHERE id = ${customer_person_id}
      AND workspace_id = ${session.workspace.id}
      AND deleted_at IS NULL
    LIMIT 1
  `;
  if (customer.length === 0) {
    return c.json({ error: 'customer_not_found' }, 404);
  }

  if (rental_start && rental_end && new Date(rental_end) <= new Date(rental_start)) {
    return c.json({ error: 'validation', field: 'rental_end', reason: 'end_before_start' }, 422);
  }

  const orderNumber = await nextOrderNumber(session.workspace.id);

  const inserted = await sql`
    INSERT INTO orders (
      workspace_id, order_number, customer_person_id, status,
      rental_start, rental_end, dispatch_type, delivery_address,
      channel, notes, internal_notes, created_by
    ) VALUES (
      ${session.workspace.id},
      ${orderNumber},
      ${customer_person_id},
      'draft',
      ${rental_start ?? null},
      ${rental_end ?? null},
      ${dispatch_type ?? 'pickup'},
      ${delivery_address ?? null},
      ${channel ?? 'planned'},
      ${notes ?? null},
      ${internal_notes ?? null},
      ${session.user.id}
    )
    RETURNING *
  `;

  const order = inserted[0];

  await recordOrderEvent({
    workspaceId: session.workspace.id,
    orderId: order.id,
    eventType: 'order.created',
    toStatus: 'draft',
    payload: {
      order_number: order.order_number,
      customer_name: customer[0].display_name,
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
    ipAddress: ipOf(c),
    userAgent: uaOf(c),
  });

  return c.json({ order }, 201);
});

// ============================================================================
// PATCH /api/orders/:id  — update a draft (or non-terminal order)
// ============================================================================
app.patch('/:id', async (c) => {
  const session = await requireSession(c);
  if (!session) return c.json({ error: 'unauthorized' }, 401);

  const id = c.req.param('id');
  const before = await loadOrder(id, session.workspace.id);
  if (!before) return c.json({ error: 'not_found' }, 404);

  if (['closed', 'cancelled'].includes(before.status)) {
    return c.json({ error: 'locked', reason: `status_${before.status}` }, 409);
  }

  const body = await c.req.json().catch(() => ({} as any));
  const patch: Record<string, unknown> = {};

  const editable = [
    'rental_start', 'rental_end', 'dispatch_type', 'delivery_address',
    'channel', 'notes', 'internal_notes',
  ];
  for (const k of editable) {
    if (k in body) patch[k] = body[k];
  }

  // Customer swap allowed on drafts only
  if ('customer_person_id' in body && before.status === 'draft') {
    const check = await sql`
      SELECT id FROM people
      WHERE id = ${body.customer_person_id}
        AND workspace_id = ${session.workspace.id}
        AND deleted_at IS NULL
      LIMIT 1
    `;
    if (check.length === 0) return c.json({ error: 'customer_not_found' }, 404);
    patch.customer_person_id = body.customer_person_id;
  }

  if (Object.keys(patch).length === 0) {
    return c.json({ order: before });
  }

  if (
    (patch.rental_end ?? before.rental_end) &&
    (patch.rental_start ?? before.rental_start) &&
    new Date(patch.rental_end ?? before.rental_end as string) <=
    new Date(patch.rental_start ?? before.rental_start as string)
  ) {
    return c.json({ error: 'validation', field: 'rental_end', reason: 'end_before_start' }, 422);
  }

  // Assemble the SET clause manually — sql template doesn't support dynamic keys.
  // Whitelisted above, so no injection risk.
  const fragments: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  for (const [k, v] of Object.entries(patch)) {
    fragments.push(`${k} = $${i++}`);
    values.push(v);
  }
  fragments.push(`updated_at = now()`);

  const updated = await sql.unsafe(
    `UPDATE orders SET ${fragments.join(', ')}
     WHERE id = $${i} AND workspace_id = $${i + 1}
     RETURNING *`,
    [...values, id, session.workspace.id]
  );

  await recordOrderEvent({
    workspaceId: session.workspace.id,
    orderId: id,
    eventType: 'order.updated',
    fromStatus: before.status,
    toStatus: before.status,
    payload: { fields: Object.keys(patch) },
    actorUserId: session.user.id,
  });

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'orders.order.updated',
    targetType: 'order',
    targetId: id,
    payload: { fields: Object.keys(patch) },
    ipAddress: ipOf(c),
    userAgent: uaOf(c),
  });

  return c.json({ order: updated[0] });
});

// ============================================================================
// POST /api/orders/:id/items  — add a line item
// ============================================================================
app.post('/:id/items', async (c) => {
  const session = await requireSession(c);
  if (!session) return c.json({ error: 'unauthorized' }, 401);

  const id = c.req.param('id');
  const order = await loadOrder(id, session.workspace.id);
  if (!order) return c.json({ error: 'not_found' }, 404);
  if (['closed', 'cancelled'].includes(order.status)) {
    return c.json({ error: 'locked' }, 409);
  }

  const body = await c.req.json().catch(() => ({} as any));
  const {
    item_type,
    product_id,
    parent_item_id,
    description,
    quantity,
    unit_amount_paise,
    daily_rate_paise,
    billable_days,
    sort_order,
  } = body;

  if (!item_type) return c.json({ error: 'validation', field: 'item_type' }, 422);
  if (!description) return c.json({ error: 'validation', field: 'description' }, 422);

  // For 'rental' items, product_id is required and must belong to workspace
  if (item_type === 'rental') {
    if (!product_id) return c.json({ error: 'validation', field: 'product_id' }, 422);
    const p = await sql`
      SELECT id FROM products
      WHERE id = ${product_id}
        AND workspace_id = ${session.workspace.id}
        AND deleted_at IS NULL
      LIMIT 1
    `;
    if (p.length === 0) return c.json({ error: 'product_not_found' }, 404);
  }

  const qty  = Number(quantity ?? 1);
  const unit = Number(unit_amount_paise ?? 0);
  const total = unit * qty;

  const inserted = await sql`
    INSERT INTO order_items (
      workspace_id, order_id, parent_item_id, item_type, product_id,
      description, quantity, daily_rate_paise, billable_days,
      unit_amount_paise, total_amount_paise, sort_order
    ) VALUES (
      ${session.workspace.id},
      ${id},
      ${parent_item_id ?? null},
      ${item_type},
      ${product_id ?? null},
      ${description},
      ${qty},
      ${daily_rate_paise ?? null},
      ${billable_days ?? null},
      ${unit},
      ${total},
      ${sort_order ?? 0}
    )
    RETURNING *
  `;

  await recordOrderEvent({
    workspaceId: session.workspace.id,
    orderId: id,
    eventType: 'order.item.added',
    fromStatus: order.status,
    toStatus: order.status,
    payload: { item_id: inserted[0].id, item_type, description },
    actorUserId: session.user.id,
  });

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'orders.item.added',
    targetType: 'order_item',
    targetId: inserted[0].id,
    payload: { order_id: id, item_type },
    ipAddress: ipOf(c),
    userAgent: uaOf(c),
  });

  return c.json({ item: inserted[0] }, 201);
});

// ============================================================================
// PATCH /api/orders/:id/items/:itemId  — update a line item
// ============================================================================
app.patch('/:id/items/:itemId', async (c) => {
  const session = await requireSession(c);
  if (!session) return c.json({ error: 'unauthorized' }, 401);

  const id = c.req.param('id');
  const itemId = c.req.param('itemId');

  const order = await loadOrder(id, session.workspace.id);
  if (!order) return c.json({ error: 'not_found' }, 404);
  if (['closed', 'cancelled'].includes(order.status)) {
    return c.json({ error: 'locked' }, 409);
  }

  const existing = await sql`
    SELECT * FROM order_items
    WHERE id = ${itemId} AND order_id = ${id} AND workspace_id = ${session.workspace.id}
    LIMIT 1
  `;
  if (existing.length === 0) return c.json({ error: 'not_found' }, 404);

  const body = await c.req.json().catch(() => ({} as any));
  const patch: Record<string, unknown> = {};
  const editable = [
    'description', 'quantity', 'unit_amount_paise', 'daily_rate_paise',
    'billable_days', 'sort_order', 'parent_item_id',
  ];
  for (const k of editable) if (k in body) patch[k] = body[k];

  if (Object.keys(patch).length === 0) {
    return c.json({ item: existing[0] });
  }

  // Recompute total if qty or unit changed
  const nextQty  = Number(patch.quantity          ?? existing[0].quantity);
  const nextUnit = Number(patch.unit_amount_paise ?? existing[0].unit_amount_paise);
  patch.total_amount_paise = nextQty * nextUnit;

  const fragments: string[] = [];
  const values: unknown[] = [];
  let i = 1;
  for (const [k, v] of Object.entries(patch)) {
    fragments.push(`${k} = $${i++}`);
    values.push(v);
  }
  fragments.push(`updated_at = now()`);

  const updated = await sql.unsafe(
    `UPDATE order_items SET ${fragments.join(', ')}
     WHERE id = $${i} AND workspace_id = $${i + 1}
     RETURNING *`,
    [...values, itemId, session.workspace.id]
  );

  await recordOrderEvent({
    workspaceId: session.workspace.id,
    orderId: id,
    eventType: 'order.item.updated',
    fromStatus: order.status,
    toStatus: order.status,
    payload: { item_id: itemId, fields: Object.keys(patch) },
    actorUserId: session.user.id,
  });

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'orders.item.updated',
    targetType: 'order_item',
    targetId: itemId,
    payload: { order_id: id, fields: Object.keys(patch) },
    ipAddress: ipOf(c),
    userAgent: uaOf(c),
  });

  return c.json({ item: updated[0] });
});

// ============================================================================
// DELETE /api/orders/:id/items/:itemId  — remove a line item
// ============================================================================
app.delete('/:id/items/:itemId', async (c) => {
  const session = await requireSession(c);
  if (!session) return c.json({ error: 'unauthorized' }, 401);

  const id = c.req.param('id');
  const itemId = c.req.param('itemId');

  const order = await loadOrder(id, session.workspace.id);
  if (!order) return c.json({ error: 'not_found' }, 404);
  if (['closed', 'cancelled'].includes(order.status)) {
    return c.json({ error: 'locked' }, 409);
  }

  const existing = await sql`
    SELECT id, item_type, description FROM order_items
    WHERE id = ${itemId} AND order_id = ${id} AND workspace_id = ${session.workspace.id}
    LIMIT 1
  `;
  if (existing.length === 0) return c.json({ error: 'not_found' }, 404);

  await sql`
    DELETE FROM order_items
    WHERE id = ${itemId} AND workspace_id = ${session.workspace.id}
  `;

  await recordOrderEvent({
    workspaceId: session.workspace.id,
    orderId: id,
    eventType: 'order.item.removed',
    fromStatus: order.status,
    toStatus: order.status,
    payload: { item_id: itemId, description: existing[0].description },
    actorUserId: session.user.id,
  });

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'orders.item.removed',
    targetType: 'order_item',
    targetId: itemId,
    payload: { order_id: id },
    ipAddress: ipOf(c),
    userAgent: uaOf(c),
  });

  return c.json({ ok: true });
});

// ============================================================================
// POST /api/orders/:id/transitions  — advisory state change
// ============================================================================
// Body: { to: 'quoted' | 'confirmed' | ..., reason?: string, force?: boolean }
app.post('/:id/transitions', async (c) => {
  const session = await requireSession(c);
  if (!session) return c.json({ error: 'unauthorized' }, 401);

  const id = c.req.param('id');
  const order = await loadOrder(id, session.workspace.id);
  if (!order) return c.json({ error: 'not_found' }, 404);

  const body = await c.req.json().catch(() => ({} as any));
  const to = body.to as OrderStatus;
  const reason = body.reason as string | undefined;
  const force  = Boolean(body.force);

  const validStates: OrderStatus[] = [
    'draft', 'quoted', 'confirmed', 'dispatched',
    'active', 'returned', 'closed', 'cancelled',
  ];
  if (!validStates.includes(to)) {
    return c.json({ error: 'validation', field: 'to' }, 422);
  }

  if (order.status === to) {
    return c.json({ order, unchanged: true });
  }

  const canonical = isCanonical(order.status as OrderStatus, to);

  // Advisory model: if not canonical, require { force: true } so the UI
  // has a chance to warn the operator first. This lets the DB stay flexible
  // while still nudging toward the happy path.
  if (!canonical && !force) {
    return c.json({
      error: 'non_canonical_transition',
      from: order.status,
      to,
      hint: 'resubmit with { "force": true } to override — reason recommended',
    }, 409);
  }

  const updated = await sql`
    UPDATE orders
       SET status = ${to}::order_status,
           updated_at = now()
     WHERE id = ${id} AND workspace_id = ${session.workspace.id}
    RETURNING *
  `;

  await recordOrderEvent({
    workspaceId: session.workspace.id,
    orderId: id,
    eventType: canonical ? 'order.status.changed' : 'order.status.forced',
    fromStatus: order.status,
    toStatus: to,
    payload: { canonical, forced: !canonical, reason: reason ?? null },
    actorUserId: session.user.id,
  });

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: canonical ? 'orders.status.changed' : 'orders.status.forced',
    targetType: 'order',
    targetId: id,
    payload: { from: order.status, to, canonical, reason: reason ?? null },
    ipAddress: ipOf(c),
    userAgent: uaOf(c),
  });

  return c.json({ order: updated[0], canonical });
});

// ============================================================================
// DELETE /api/orders/:id  — soft delete (only drafts)
// ============================================================================
app.delete('/:id', async (c) => {
  const session = await requireSession(c);
  if (!session) return c.json({ error: 'unauthorized' }, 401);

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
       SET deleted_at = now(), updated_at = now()
     WHERE id = ${id} AND workspace_id = ${session.workspace.id}
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
    ipAddress: ipOf(c),
    userAgent: uaOf(c),
  });

  return c.json({ ok: true });
});

export default app;
