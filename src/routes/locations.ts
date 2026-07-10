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

// ============================================================================
// src/routes/locations.ts  (Sub-turn 6i, Phase 1) — multi-location stock
// ----------------------------------------------------------------------------
//   GET    /api/locations                 all locations + counts (any member)
//   POST   /api/locations                 create (owner/manager)
//   PATCH  /api/locations/:id             update / set-default (owner/manager)
//   DELETE /api/locations/:id             soft- or hard-delete (owner/manager)
//
// Exactly one default per workspace (partial unique index + deactivate-then-set,
// since Neon HTTP has no cross-statement transactions). The default can't be
// deactivated or deleted — every workspace always has one.
// ============================================================================

type SessionVar = {
  sessionId: string;
  user: SessionUser;
  workspace: SessionWorkspace;
} | null;

type Env = { Variables: { session: SessionVar } };

export const locations = new Hono<Env>();
locations.use('*', sessionMiddleware, requireAuth);

function clientCtx(c: Context) {
  const ipAddress =
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    c.req.header('x-real-ip') ?? null;
  const userAgent = c.req.header('user-agent') ?? null;
  return { ipAddress, userAgent };
}

type LocationRow = {
  id: string;
  name: string;
  address_line1: string | null;
  address_line2: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  phone: string | null;
  email: string | null;
  is_default: boolean;
  is_active: boolean;
  asset_count: number;
  active_orders_count: number;
};

// ============================================================================
// GET /api/locations
// ============================================================================
locations.get('/', async (c) => {
  const session = c.get('session')!;
  const rows = await query<LocationRow>(sql`
    SELECT l.id, l.name, l.address_line1, l.address_line2, l.city, l.state,
           l.postal_code, l.phone, l.email, l.is_default, l.is_active,
           (SELECT COUNT(*)::int FROM assets a
            WHERE a.location_id = l.id AND a.deleted_at IS NULL) AS asset_count,
           (SELECT COUNT(*)::int FROM orders o
            WHERE (o.pickup_location_id = l.id OR o.return_location_id = l.id)
              AND o.deleted_at IS NULL
              AND o.status::text NOT IN ('closed', 'cancelled')) AS active_orders_count
    FROM locations l
    WHERE l.workspace_id = ${session.workspace.id}::uuid
    ORDER BY l.is_default DESC, l.is_active DESC, l.name ASC
  `);
  return c.json({ locations: rows });
});

// ============================================================================
// POST /api/locations — create (owner/manager)
// ============================================================================
const createSchema = z.object({
  name: z.string().min(1).max(200),
  address_line1: z.string().max(200).nullable().optional(),
  address_line2: z.string().max(200).nullable().optional(),
  city: z.string().max(100).nullable().optional(),
  state: z.string().max(100).nullable().optional(),
  postal_code: z.string().max(20).nullable().optional(),
  phone: z.string().max(30).nullable().optional(),
  email: z.string().email().max(200).nullable().optional(),
  is_default: z.boolean().default(false),
});

locations.post('/', requireRole('owner', 'manager'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);

  const body = await c.req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  const input = parsed.data;

  // Setting a new default? Clear the existing default first (partial unique index).
  if (input.is_default) {
    await sql`
      UPDATE locations SET is_default = false, updated_at = now()
      WHERE workspace_id = ${session.workspace.id}::uuid AND is_default = true
    `;
  }

  const inserted = await query<{ id: string }>(sql`
    INSERT INTO locations
      (workspace_id, name, address_line1, address_line2, city, state, postal_code,
       phone, email, is_default, created_by_user_id)
    VALUES (
      ${session.workspace.id}::uuid, ${input.name}::text,
      ${input.address_line1 ?? null}::text, ${input.address_line2 ?? null}::text,
      ${input.city ?? null}::text, ${input.state ?? null}::text, ${input.postal_code ?? null}::text,
      ${input.phone ?? null}::text, ${input.email ?? null}::text,
      ${input.is_default}::boolean, ${session.user.id}::uuid
    )
    RETURNING id
  `);

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'locations.created',
    targetType: 'location',
    targetId: inserted[0]!.id,
    payload: { name: input.name, is_default: input.is_default },
    ipAddress, userAgent,
  });

  return c.json({ location: { id: inserted[0]!.id, ...input } });
});

// ============================================================================
// PATCH /api/locations/:id — update / set default (owner/manager)
// ============================================================================
const updateSchema = z.object({
  name: z.string().min(1).max(200).optional(),
  address_line1: z.string().max(200).nullable().optional(),
  address_line2: z.string().max(200).nullable().optional(),
  city: z.string().max(100).nullable().optional(),
  state: z.string().max(100).nullable().optional(),
  postal_code: z.string().max(20).nullable().optional(),
  phone: z.string().max(30).nullable().optional(),
  email: z.string().email().max(200).nullable().optional(),
  is_default: z.boolean().optional(),
  is_active: z.boolean().optional(),
});

locations.patch('/:id', requireRole('owner', 'manager'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');

  const body = await c.req.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  const p = parsed.data;

  const existing = await query<{ id: string; is_default: boolean }>(sql`
    SELECT id, is_default FROM locations
    WHERE id = ${id}::uuid AND workspace_id = ${session.workspace.id}::uuid
    LIMIT 1
  `);
  if (!existing.length) return c.json({ error: 'not_found' }, 404);
  const before = existing[0]!;

  // The workspace always needs exactly one default that stays active.
  if (before.is_default && p.is_default === false) {
    return c.json({ error: 'must_have_default' }, 400);
  }
  if (before.is_default && p.is_active === false) {
    return c.json({ error: 'cannot_deactivate_default' }, 400);
  }

  // Promoting this one to default → demote the current default first.
  if (p.is_default === true && !before.is_default) {
    await sql`
      UPDATE locations SET is_default = false, updated_at = now()
      WHERE workspace_id = ${session.workspace.id}::uuid AND is_default = true
    `;
  }

  const updated = await query<{ id: string }>(sql`
    UPDATE locations SET
      name          = COALESCE(${p.name ?? null}::text, name),
      address_line1 = CASE WHEN ${p.address_line1 !== undefined}::boolean THEN ${p.address_line1 ?? null}::text ELSE address_line1 END,
      address_line2 = CASE WHEN ${p.address_line2 !== undefined}::boolean THEN ${p.address_line2 ?? null}::text ELSE address_line2 END,
      city          = CASE WHEN ${p.city !== undefined}::boolean THEN ${p.city ?? null}::text ELSE city END,
      state         = CASE WHEN ${p.state !== undefined}::boolean THEN ${p.state ?? null}::text ELSE state END,
      postal_code   = CASE WHEN ${p.postal_code !== undefined}::boolean THEN ${p.postal_code ?? null}::text ELSE postal_code END,
      phone         = CASE WHEN ${p.phone !== undefined}::boolean THEN ${p.phone ?? null}::text ELSE phone END,
      email         = CASE WHEN ${p.email !== undefined}::boolean THEN ${p.email ?? null}::text ELSE email END,
      is_default    = COALESCE(${p.is_default ?? null}::boolean, is_default),
      is_active     = COALESCE(${p.is_active ?? null}::boolean, is_active),
      updated_at    = now()
    WHERE id = ${id}::uuid AND workspace_id = ${session.workspace.id}::uuid
    RETURNING id
  `);
  if (!updated.length) return c.json({ error: 'not_found' }, 404);

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'locations.updated',
    targetType: 'location',
    targetId: id,
    payload: { fields: Object.keys(p) },
    ipAddress, userAgent,
  });

  return c.json({ ok: true });
});

// ============================================================================
// DELETE /api/locations/:id — soft-delete if referenced, else hard-delete
// ============================================================================
locations.delete('/:id', requireRole('owner', 'manager'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');

  const existing = await query<{ id: string; is_default: boolean }>(sql`
    SELECT id, is_default FROM locations
    WHERE id = ${id}::uuid AND workspace_id = ${session.workspace.id}::uuid
    LIMIT 1
  `);
  if (!existing.length) return c.json({ error: 'not_found' }, 404);
  if (existing[0]!.is_default) return c.json({ error: 'cannot_delete_default' }, 400);

  const deps = await query<{ asset_count: number; order_count: number }>(sql`
    SELECT
      (SELECT COUNT(*)::int FROM assets WHERE location_id = ${id}::uuid) AS asset_count,
      (SELECT COUNT(*)::int FROM orders WHERE pickup_location_id = ${id}::uuid OR return_location_id = ${id}::uuid) AS order_count
  `);
  const referenced = (deps[0]?.asset_count ?? 0) > 0 || (deps[0]?.order_count ?? 0) > 0;

  let softDeleted = false;
  if (referenced) {
    await sql`
      UPDATE locations SET is_active = false, updated_at = now()
      WHERE id = ${id}::uuid AND workspace_id = ${session.workspace.id}::uuid
    `;
    softDeleted = true;
  } else {
    await sql`
      DELETE FROM locations
      WHERE id = ${id}::uuid AND workspace_id = ${session.workspace.id}::uuid
    `;
  }

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'locations.deleted',
    targetType: 'location',
    targetId: id,
    payload: { soft_deleted: softDeleted },
    ipAddress, userAgent,
  });

  return c.json({ ok: true, soft_deleted: softDeleted });
});
