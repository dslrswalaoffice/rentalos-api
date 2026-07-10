import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { sql, query } from '../db.js';
import { audit } from '../lib/audit.js';
import {
  sessionMiddleware,
  requireAuth,
  type SessionUser,
  type SessionWorkspace,
} from '../middleware/session.js';

// ============================================================================
// src/routes/downtimes.ts  (Sub-turn 8a) — mounted at /api/downtimes
// ----------------------------------------------------------------------------
// Maintenance windows that block a product's capacity. A downtime with a
// location_id blocks that location only (tracked products); a NULL location_id
// blocks every location (and is the only kind that applies to bulk products).
// Availability treats an intersecting downtime as a full-capacity block
// (src/lib/availability.ts). Creation is advisory — it reports overlapping
// bookings but never blocks. Any authenticated member can manage downtimes.
// ============================================================================

type SessionVar = {
  sessionId: string;
  user: SessionUser;
  workspace: SessionWorkspace;
} | null;

type Env = { Variables: { session: SessionVar } };

export const downtimes = new Hono<Env>();
downtimes.use('*', sessionMiddleware, requireAuth);

function clientCtx(c: Context) {
  const ipAddress =
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    c.req.header('x-real-ip') ?? null;
  const userAgent = c.req.header('user-agent') ?? null;
  return { ipAddress, userAgent };
}

type DowntimeRow = {
  id: string;
  workspace_id: string;
  product_id: string;
  location_id: string | null;
  start_at: string;
  end_at: string;
  reason: string;
  created_by_user_id: string | null;
  created_at: string;
  updated_at: string;
  location_name?: string | null;
};

// ============================================================================
// GET /api/downtimes/products/:productId — downtimes for one product
// ?upcoming=1 limits to windows that haven't ended yet.
// ============================================================================
downtimes.get('/products/:productId', async (c) => {
  const session = c.get('session')!;
  const productId = c.req.param('productId');
  const upcomingOnly = c.req.query('upcoming') === '1';

  const rows = await query<DowntimeRow>(sql`
    SELECT d.id, d.workspace_id, d.product_id, d.location_id, d.start_at, d.end_at,
           d.reason, d.created_by_user_id, d.created_at, d.updated_at,
           l.name AS location_name
    FROM product_downtimes d
    LEFT JOIN locations l ON l.id = d.location_id
    WHERE d.workspace_id = ${session.workspace.id}::uuid
      AND d.product_id = ${productId}::uuid
      AND (${upcomingOnly}::boolean = false OR d.end_at > now())
    ORDER BY d.start_at ASC
  `);
  return c.json({ downtimes: rows });
});

// ============================================================================
// POST /api/downtimes — create a downtime (advisory: reports booking overlaps)
// ============================================================================
const createSchema = z.object({
  product_id: z.string().uuid(),
  location_id: z.string().uuid().nullable().optional(),
  start_at: z.string().datetime(),
  end_at: z.string().datetime(),
  reason: z.string().min(1).max(500),
});

downtimes.post('/', async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);

  const body = await c.req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  const input = parsed.data;

  if (new Date(input.end_at) <= new Date(input.start_at)) {
    return c.json({ error: 'invalid_range', reason: 'end_must_be_after_start' }, 400);
  }

  // Product must belong to the workspace.
  const prod = await query<{ id: string }>(sql`
    SELECT id FROM products
    WHERE id = ${input.product_id}::uuid AND workspace_id = ${session.workspace.id}::uuid
      AND deleted_at IS NULL
    LIMIT 1
  `);
  if (!prod.length) return c.json({ error: 'product_not_found' }, 404);

  // Location (if given) must belong to the workspace.
  if (input.location_id) {
    const loc = await query<{ id: string }>(sql`
      SELECT id FROM locations
      WHERE id = ${input.location_id}::uuid AND workspace_id = ${session.workspace.id}::uuid
      LIMIT 1
    `);
    if (!loc.length) return c.json({ error: 'location_not_found' }, 404);
  }

  const inserted = await query<DowntimeRow>(sql`
    INSERT INTO product_downtimes
      (workspace_id, product_id, location_id, start_at, end_at, reason, created_by_user_id)
    VALUES (
      ${session.workspace.id}::uuid, ${input.product_id}::uuid,
      ${input.location_id ?? null}::uuid,
      ${input.start_at}::timestamptz, ${input.end_at}::timestamptz,
      ${input.reason}::text, ${session.user.id}::uuid
    )
    RETURNING id, workspace_id, product_id, location_id, start_at, end_at, reason,
              created_by_user_id, created_at, updated_at
  `);
  const row = inserted[0]!;

  // Advisory: which reserving-status bookings overlap this window? (Same
  // reserving statuses as availability; location-scoped downtimes only clash
  // with bookings picked up at that location.)
  const conflicts = await query<{
    id: string; order_number: number; customer_name: string | null;
    rental_start: string; rental_end: string; quantity: number;
  }>(sql`
    SELECT o.id, o.order_number, p.display_name AS customer_name,
           o.rental_start, o.rental_end, oi.quantity
    FROM order_items oi
    INNER JOIN orders o ON o.id = oi.order_id
    LEFT JOIN people p ON p.id = o.customer_person_id
    WHERE oi.workspace_id = ${session.workspace.id}::uuid
      AND oi.product_id = ${input.product_id}::uuid
      AND oi.item_type = 'rental'
      AND o.deleted_at IS NULL
      AND o.status::text IN ('confirmed', 'dispatched', 'active', 'returned')
      AND (${input.location_id ?? null}::uuid IS NULL
           OR o.pickup_location_id = ${input.location_id ?? null}::uuid)
      AND o.rental_start < ${input.end_at}::timestamptz
      AND o.rental_end   > ${input.start_at}::timestamptz
    ORDER BY o.rental_start ASC
  `);

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'downtimes.created',
    targetType: 'product',
    targetId: input.product_id,
    payload: {
      downtime_id: row.id, reason: input.reason,
      start_at: input.start_at, end_at: input.end_at,
      location_id: input.location_id ?? null,
      conflicts_count: conflicts.length,
    },
    ipAddress, userAgent,
  });

  return c.json({ downtime: row, booking_conflicts: conflicts }, 201);
});

// ============================================================================
// PATCH /api/downtimes/:id — change dates / reason / location
// ============================================================================
const updateSchema = z.object({
  start_at: z.string().datetime().optional(),
  end_at: z.string().datetime().optional(),
  reason: z.string().min(1).max(500).optional(),
  location_id: z.string().uuid().nullable().optional(),
});

downtimes.patch('/:id', async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');

  const body = await c.req.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  const p = parsed.data;

  const existing = await query<DowntimeRow>(sql`
    SELECT id, product_id, start_at, end_at FROM product_downtimes
    WHERE id = ${id}::uuid AND workspace_id = ${session.workspace.id}::uuid
    LIMIT 1
  `);
  if (!existing.length) return c.json({ error: 'not_found' }, 404);

  // Validate the merged window.
  const nextStart = p.start_at ?? existing[0]!.start_at;
  const nextEnd = p.end_at ?? existing[0]!.end_at;
  if (new Date(nextEnd) <= new Date(nextStart)) {
    return c.json({ error: 'invalid_range', reason: 'end_must_be_after_start' }, 400);
  }

  const updated = await query<DowntimeRow>(sql`
    UPDATE product_downtimes SET
      start_at    = COALESCE(${p.start_at ?? null}::timestamptz, start_at),
      end_at      = COALESCE(${p.end_at   ?? null}::timestamptz, end_at),
      reason      = COALESCE(${p.reason   ?? null}::text, reason),
      location_id = CASE WHEN ${p.location_id !== undefined}::boolean
                         THEN ${p.location_id ?? null}::uuid ELSE location_id END,
      updated_at  = now()
    WHERE id = ${id}::uuid AND workspace_id = ${session.workspace.id}::uuid
    RETURNING id, workspace_id, product_id, location_id, start_at, end_at, reason,
              created_by_user_id, created_at, updated_at
  `);
  if (!updated.length) return c.json({ error: 'not_found' }, 404);

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'downtimes.updated',
    targetType: 'product',
    targetId: updated[0]!.product_id,
    payload: { downtime_id: id, fields: Object.keys(p) },
    ipAddress, userAgent,
  });

  return c.json({ downtime: updated[0] });
});

// ============================================================================
// DELETE /api/downtimes/:id — hard delete (downtimes have no soft-delete)
// ============================================================================
downtimes.delete('/:id', async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');

  const deleted = await query<{ product_id: string; reason: string }>(sql`
    DELETE FROM product_downtimes
    WHERE id = ${id}::uuid AND workspace_id = ${session.workspace.id}::uuid
    RETURNING product_id, reason
  `);
  if (!deleted.length) return c.json({ error: 'not_found' }, 404);

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'downtimes.deleted',
    targetType: 'product',
    targetId: deleted[0]!.product_id,
    payload: { downtime_id: id, reason: deleted[0]!.reason },
    ipAddress, userAgent,
  });

  return c.json({ ok: true });
});
