import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { sql, query } from '../db.js';
import { audit } from '../lib/audit.js';
import { emitNotification } from '../lib/notify.js';
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

export const people = new Hono<Env>();
people.use('*', sessionMiddleware, requireAuth);

function clientCtx(c: Context) {
  const ipAddress =
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    c.req.header('x-real-ip') ??
    null;
  const userAgent = c.req.header('user-agent') ?? null;
  return { ipAddress, userAgent };
}

const VALID_ROLES = ['customer', 'staff', 'investor', 'vendor'] as const;
type Role = typeof VALID_ROLES[number];

const ID_PROOF_TYPES = ['aadhaar', 'pan', 'driving_license', 'passport'] as const;

// Shape returned from list/get queries: person row + array of active roles.
type PersonRow = {
  id: string;
  display_name: string;
  phone: string;
  phone_verified_at: string | null;
  email: string | null;
  id_proof_type: string | null;
  id_proof_number: string | null;
  address_line: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country_code: string;
  company_name: string | null;
  gstin: string | null;
  notes: string | null;
  created_at: string;
  updated_at: string;
  roles: Role[];
  // Sub-turn 5b additions (present on GET /:id + tier/trust patches).
  tier?: string | null;
  trust_score?: number | null;
  trust_score_updated_at?: string | null;
  billing_address?: string | null;
  shipping_address?: string | null;
  default_gst_state?: string | null;
};

// Reads a workspace feature flag (missing key → false).
async function featureEnabled(workspaceId: string, key: string): Promise<boolean> {
  const rows = await query<{ enabled: boolean }>(sql`
    SELECT COALESCE((settings->'features'->>${key}::text)::boolean, false) AS enabled
    FROM workspaces WHERE id = ${workspaceId}::uuid LIMIT 1
  `);
  return rows[0]?.enabled === true;
}

// ============================================================================
// GET /api/people — list, filterable by ?role=customer&search=rahul
// ============================================================================
people.get('/', async (c) => {
  const session = c.get('session')!;
  const search = c.req.query('search')?.trim() || null;
  const role = c.req.query('role')?.trim() || null;
  const includeArchived = c.req.query('include_archived') === 'true';
  const searchPattern = search ? `%${search}%` : null;

  const rows = await query<PersonRow>(sql`
    SELECT
      p.id, p.display_name, p.phone, p.phone_verified_at, p.email,
      p.id_proof_type, p.id_proof_number,
      p.address_line, p.city, p.state, p.postal_code, p.country_code,
      p.company_name, p.gstin, p.notes, p.tier,
      p.created_at, p.updated_at,
      COALESCE(
        (SELECT json_agg(pr.role ORDER BY pr.role)
         FROM person_roles pr
         WHERE pr.person_id = p.id AND pr.is_active = true),
        '[]'::json
      ) AS roles
    FROM people p
    WHERE p.workspace_id = ${session.workspace.id}
      AND (${includeArchived}::boolean OR p.deleted_at IS NULL)
      AND (${searchPattern}::text IS NULL
           OR p.display_name ILIKE ${searchPattern}::text
           OR p.phone        ILIKE ${searchPattern}::text
           OR p.email        ILIKE ${searchPattern}::text
           OR p.company_name ILIKE ${searchPattern}::text)
      AND (${role}::text IS NULL OR EXISTS (
        SELECT 1 FROM person_roles pr
        WHERE pr.person_id = p.id
          AND pr.role = ${role}::person_role
          AND pr.is_active = true
      ))
    ORDER BY p.display_name ASC
    LIMIT 500
  `);

  // Aggregate counts per role for filter chips.
  const roleCounts = await query<{ role: string; n: number }>(sql`
    SELECT pr.role::text AS role, COUNT(DISTINCT pr.person_id)::int AS n
    FROM person_roles pr
    JOIN people p ON p.id = pr.person_id
    WHERE pr.workspace_id = ${session.workspace.id}
      AND pr.is_active = true
      AND p.deleted_at IS NULL
    GROUP BY pr.role
  `);
  const byRole: Record<string, number> = {};
  for (const r of roleCounts) byRole[r.role] = r.n;

  return c.json({ people: rows, total: rows.length, by_role: byRole });
});

// ============================================================================
// GET /api/people/:id — single person
// ============================================================================
people.get('/:id', async (c) => {
  const session = c.get('session')!;
  const id = c.req.param('id');

  const rows = await query<PersonRow>(sql`
    SELECT
      p.id, p.display_name, p.phone, p.phone_verified_at, p.email,
      p.id_proof_type, p.id_proof_number,
      p.address_line, p.city, p.state, p.postal_code, p.country_code,
      p.company_name, p.gstin, p.notes,
      p.tier, p.trust_score, p.trust_score_updated_at,
      p.billing_address, p.shipping_address, p.default_gst_state,
      p.created_at, p.updated_at,
      COALESCE(
        (SELECT json_agg(pr.role ORDER BY pr.role)
         FROM person_roles pr
         WHERE pr.person_id = p.id AND pr.is_active = true),
        '[]'::json
      ) AS roles
    FROM people p
    WHERE p.id = ${id}
      AND p.workspace_id = ${session.workspace.id}
      AND p.deleted_at IS NULL
    LIMIT 1
  `);

  const person = rows[0];
  if (!person) return c.json({ error: 'not_found' }, 404);

  // Recent orders for this customer (most recent 20).
  const orders = await query<{
    id: string; order_number: number; rental_start: string; rental_end: string;
    status: string; total_paise: number; balance_paise: number;
  }>(sql`
    SELECT o.id, o.order_number, o.rental_start, o.rental_end,
           o.status::text AS status, o.total_paise, o.balance_paise
    FROM orders o
    WHERE o.customer_person_id = ${id}
      AND o.workspace_id = ${session.workspace.id}
      AND o.deleted_at IS NULL
    ORDER BY o.created_at DESC
    LIMIT 20
  `);

  // Recent payments across this customer's orders (most recent 20).
  const payments = await query<{
    id: string; amount_paise: number; direction: string; method: string;
    occurred_at: string; order_id: string; order_number: number;
  }>(sql`
    SELECT pay.id, pay.amount_paise, pay.direction::text AS direction,
           pay.method::text AS method, pay.occurred_at,
           pay.order_id, o.order_number
    FROM payments pay
    JOIN orders o ON o.id = pay.order_id
    WHERE o.customer_person_id = ${id}
      AND pay.workspace_id = ${session.workspace.id}
    ORDER BY pay.occurred_at DESC
    LIMIT 20
  `);

  // Recent communications (most recent 20).
  const communications = await query<{
    id: string; channel: string; direction: string; notes: string | null;
    occurred_at: string; logged_by_user_id: string | null; logged_by_name: string | null;
  }>(sql`
    SELECT com.id, com.channel, com.direction, com.notes, com.occurred_at,
           com.logged_by_user_id, u.display_name AS logged_by_name
    FROM person_communications com
    LEFT JOIN users u ON u.id = com.logged_by_user_id
    WHERE com.person_id = ${id}
      AND com.workspace_id = ${session.workspace.id}
    ORDER BY com.occurred_at DESC
    LIMIT 20
  `);

  const custom_fields = await loadCustomFieldValues(session.workspace.id, 'person', id);

  return c.json({ person, orders, payments, communications, custom_fields });
});

// ============================================================================
// POST /api/people — create with initial roles
// ============================================================================
const createSchema = z.object({
  display_name: z.string().min(1).max(200),
  phone: z.string().min(4).max(30),
  email: z.string().email().max(320).optional(),
  id_proof_type: z.enum(ID_PROOF_TYPES).optional(),
  id_proof_number: z.string().max(50).optional(),
  address_line: z.string().max(500).optional(),
  city: z.string().max(100).optional(),
  state: z.string().max(100).optional(),
  postal_code: z.string().max(20).optional(),
  country_code: z.string().length(2).default('IN'),
  company_name: z.string().max(200).optional(),
  gstin: z.string().max(15).optional(),
  notes: z.string().max(2000).optional(),
  roles: z.array(z.enum(VALID_ROLES)).min(1).default(['customer']),
});

people.post('/', requireRole('owner', 'manager'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);

  const body = await c.req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }
  const input = parsed.data;

  // Check phone uniqueness upfront for a nicer error.
  const existing = await query<{ id: string }>(sql`
    SELECT id FROM people
    WHERE workspace_id = ${session.workspace.id}
      AND phone = ${input.phone}
      AND deleted_at IS NULL
    LIMIT 1
  `);
  if (existing.length > 0) {
    return c.json({ error: 'phone_taken', phone: input.phone }, 409);
  }

  // Insert person + roles atomically via CTE.
  const uniqueRoles = Array.from(new Set(input.roles));
  const inserted = await query<PersonRow>(sql`
    WITH new_person AS (
      INSERT INTO people (
        workspace_id, display_name, phone, email,
        id_proof_type, id_proof_number,
        address_line, city, state, postal_code, country_code,
        company_name, gstin, notes, created_by
      ) VALUES (
        ${session.workspace.id},
        ${input.display_name},
        ${input.phone},
        ${input.email ?? null},
        ${input.id_proof_type ?? null},
        ${input.id_proof_number ?? null},
        ${input.address_line ?? null},
        ${input.city ?? null},
        ${input.state ?? null},
        ${input.postal_code ?? null},
        ${input.country_code},
        ${input.company_name ?? null},
        ${input.gstin ?? null},
        ${input.notes ?? null},
        ${session.user.id}
      )
      RETURNING *
    ),
    new_roles AS (
      INSERT INTO person_roles (person_id, workspace_id, role, added_by)
      SELECT
        (SELECT id FROM new_person),
        ${session.workspace.id},
        role_val::person_role,
        ${session.user.id}
      FROM unnest(${uniqueRoles as string[]}::text[]) AS role_val
      RETURNING role
    )
    SELECT
      np.*,
      (SELECT json_agg(role ORDER BY role) FROM new_roles) AS roles
    FROM new_person np
  `);

  const person = inserted[0];
  if (!person) return c.json({ error: 'create_failed' }, 500);

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'people.person.created',
    targetType: 'person',
    targetId: person.id,
    payload: {
      display_name: input.display_name,
      phone: input.phone,
      roles: uniqueRoles,
    },
    ipAddress, userAgent,
  });

  return c.json({ person }, 201);
});

// ============================================================================
// PATCH /api/people/:id — partial update. Does NOT touch roles (use role endpoints).
// COALESCE pattern: omitted fields preserved, sent fields overwrite.
// ============================================================================
const updateSchema = z.object({
  display_name: z.string().min(1).max(200).optional(),
  phone: z.string().min(4).max(30).optional(),
  email: z.string().email().max(320).optional(),
  id_proof_type: z.enum(ID_PROOF_TYPES).optional(),
  id_proof_number: z.string().max(50).optional(),
  address_line: z.string().max(500).optional(),
  city: z.string().max(100).optional(),
  state: z.string().max(100).optional(),
  postal_code: z.string().max(20).optional(),
  country_code: z.string().length(2).optional(),
  company_name: z.string().max(200).optional(),
  gstin: z.string().max(15).optional(),
  notes: z.string().max(2000).optional(),
  billing_address: z.string().max(1000).optional(),
  shipping_address: z.string().max(1000).optional(),
  custom_fields: z.array(z.object({ definition_id: z.string().uuid(), value: z.string().nullable() })).optional(),
});

people.patch('/:id', requireRole('owner', 'manager'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');

  const body = await c.req.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }
  const p = parsed.data;

  const existing = await query<{ id: string; phone: string }>(sql`
    SELECT id, phone FROM people
    WHERE id = ${id} AND workspace_id = ${session.workspace.id} AND deleted_at IS NULL
    LIMIT 1
  `);
  if (existing.length === 0) return c.json({ error: 'not_found' }, 404);

  // If phone is changing, check the new value isn't taken by someone else.
  if (p.phone && p.phone !== existing[0]!.phone) {
    const clash = await query<{ id: string }>(sql`
      SELECT id FROM people
      WHERE workspace_id = ${session.workspace.id}
        AND phone = ${p.phone}
        AND id != ${id}
        AND deleted_at IS NULL
      LIMIT 1
    `);
    if (clash.length > 0) return c.json({ error: 'phone_taken', phone: p.phone }, 409);
  }

  const updated = await query<PersonRow>(sql`
    UPDATE people SET
      display_name    = COALESCE(${p.display_name    ?? null}::text, display_name),
      phone           = COALESCE(${p.phone           ?? null}::text, phone),
      email           = COALESCE(${p.email           ?? null}::citext, email),
      id_proof_type   = COALESCE(${p.id_proof_type   ?? null}::text, id_proof_type),
      id_proof_number = COALESCE(${p.id_proof_number ?? null}::text, id_proof_number),
      address_line    = COALESCE(${p.address_line    ?? null}::text, address_line),
      city            = COALESCE(${p.city            ?? null}::text, city),
      state           = COALESCE(${p.state           ?? null}::text, state),
      postal_code     = COALESCE(${p.postal_code     ?? null}::text, postal_code),
      country_code    = COALESCE(${p.country_code    ?? null}::text, country_code),
      company_name    = COALESCE(${p.company_name    ?? null}::text, company_name),
      gstin           = COALESCE(${p.gstin           ?? null}::text, gstin),
      notes           = COALESCE(${p.notes           ?? null}::text, notes),
      billing_address  = COALESCE(${p.billing_address  ?? null}::text, billing_address),
      shipping_address = COALESCE(${p.shipping_address ?? null}::text, shipping_address)
    WHERE id = ${id} AND workspace_id = ${session.workspace.id}
    RETURNING
      id, display_name, phone, phone_verified_at, email,
      id_proof_type, id_proof_number,
      address_line, city, state, postal_code, country_code,
      company_name, gstin, notes,
      tier, trust_score, trust_score_updated_at,
      billing_address, shipping_address, default_gst_state,
      created_at, updated_at,
      (SELECT json_agg(role ORDER BY role) FROM person_roles
       WHERE person_id = people.id AND is_active = true) AS roles
  `);

  if (updated.length === 0) return c.json({ error: 'not_found' }, 404);

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'people.person.updated',
    targetType: 'person',
    targetId: id,
    payload: { fields: Object.keys(p) },
    ipAddress, userAgent,
  });

  if (p.custom_fields) {
    await upsertCustomFieldValues({
      workspaceId: session.workspace.id, entityType: 'person', entityId: id,
      actorUserId: session.user.id, values: p.custom_fields,
    });
  }

  return c.json({ person: updated[0] });
});

// ============================================================================
// DELETE /api/people/:id — soft archive
// ============================================================================
people.delete('/:id', requireRole('owner', 'manager'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');

  // Note: when Orders module ships, add a check here that refuses to archive
  // people with active orders (409 conflict). For now the check is trivial.
  const deleted = await query<{ id: string }>(sql`
    UPDATE people
    SET deleted_at = now()
    WHERE id = ${id}
      AND workspace_id = ${session.workspace.id}
      AND deleted_at IS NULL
    RETURNING id
  `);
  if (deleted.length === 0) return c.json({ error: 'not_found' }, 404);

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'people.person.archived',
    targetType: 'person',
    targetId: id,
    payload: {},
    ipAddress, userAgent,
  });

  return c.json({ ok: true });
});

// ============================================================================
// POST /api/people/:id/roles — add / re-activate a role
// ============================================================================
const roleAddSchema = z.object({
  role: z.enum(VALID_ROLES),
});

people.post('/:id/roles', requireRole('owner', 'manager'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');

  const body = await c.req.json().catch(() => null);
  const parsed = roleAddSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  const { role } = parsed.data;

  // Confirm person belongs to this workspace.
  const person = await query<{ id: string }>(sql`
    SELECT id FROM people
    WHERE id = ${id} AND workspace_id = ${session.workspace.id} AND deleted_at IS NULL
    LIMIT 1
  `);
  if (person.length === 0) return c.json({ error: 'not_found' }, 404);

  // Upsert — either fresh insert or re-activate.
  await sql`
    INSERT INTO person_roles (person_id, workspace_id, role, is_active, added_by, deactivated_at)
    VALUES (${id}, ${session.workspace.id}, ${role}::person_role, true, ${session.user.id}, NULL)
    ON CONFLICT (person_id, role) DO UPDATE SET
      is_active = true,
      deactivated_at = NULL,
      added_at = now(),
      added_by = ${session.user.id}
  `;

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'people.role.added',
    targetType: 'person',
    targetId: id,
    payload: { role },
    ipAddress, userAgent,
  });

  return c.json({ ok: true, role });
});

// ============================================================================
// DELETE /api/people/:id/roles/:role — deactivate (soft) a role
// ============================================================================
people.delete('/:id/roles/:role', requireRole('owner', 'manager'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');
  const role = c.req.param('role');

  if (!(VALID_ROLES as readonly string[]).includes(role)) {
    return c.json({ error: 'invalid_role', valid: VALID_ROLES }, 400);
  }

  const updated = await query<{ role: string }>(sql`
    UPDATE person_roles
    SET is_active = false, deactivated_at = now()
    WHERE person_id = ${id}
      AND workspace_id = ${session.workspace.id}
      AND role = ${role}::person_role
      AND is_active = true
    RETURNING role::text
  `);

  if (updated.length === 0) return c.json({ error: 'not_found_or_already_inactive' }, 404);

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'people.role.removed',
    targetType: 'person',
    targetId: id,
    payload: { role },
    ipAddress, userAgent,
  });

  return c.json({ ok: true });
});

// ============================================================================
// PATCH /api/people/:id/tier — set/clear customer tier (customer_tiers flag)
// ============================================================================
const tierSchema = z.object({
  tier: z.enum(['normal', 'premium', 'vip']).nullable(),
});

people.patch('/:id/tier', requireRole('owner', 'manager'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');

  const body = await c.req.json().catch(() => null);
  const parsed = tierSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }

  if (!(await featureEnabled(session.workspace.id, 'customer_tiers'))) {
    return c.json({ error: 'feature_disabled', feature: 'customer_tiers' }, 409);
  }

  const existing = await query<{ tier: string | null }>(sql`
    SELECT tier FROM people
    WHERE id = ${id} AND workspace_id = ${session.workspace.id} AND deleted_at IS NULL
    LIMIT 1
  `);
  if (existing.length === 0) return c.json({ error: 'not_found' }, 404);
  const from = existing[0]!.tier ?? null;
  const to = parsed.data.tier;

  const updated = await query<{ id: string; tier: string | null }>(sql`
    UPDATE people SET tier = ${to}::text
    WHERE id = ${id} AND workspace_id = ${session.workspace.id}
    RETURNING id, tier
  `);

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'people.tier.changed',
    targetType: 'person',
    targetId: id,
    payload: { from, to },
    ipAddress, userAgent,
  });

  return c.json({ person: updated[0] });
});

// ============================================================================
// PATCH /api/people/:id/trust-score — set/clear trust score (trust_score flag)
// ============================================================================
const trustSchema = z.object({
  trust_score: z.number().int().min(0).max(100).nullable(),
});

people.patch('/:id/trust-score', requireRole('owner', 'manager'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');

  const body = await c.req.json().catch(() => null);
  const parsed = trustSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }

  if (!(await featureEnabled(session.workspace.id, 'trust_score'))) {
    return c.json({ error: 'feature_disabled', feature: 'trust_score' }, 409);
  }

  const existing = await query<{ trust_score: number | null }>(sql`
    SELECT trust_score FROM people
    WHERE id = ${id} AND workspace_id = ${session.workspace.id} AND deleted_at IS NULL
    LIMIT 1
  `);
  if (existing.length === 0) return c.json({ error: 'not_found' }, 404);
  const from = existing[0]!.trust_score ?? null;
  const to = parsed.data.trust_score;

  const updated = await query<{ id: string; trust_score: number | null; trust_score_updated_at: string }>(sql`
    UPDATE people SET trust_score = ${to}::int, trust_score_updated_at = now()
    WHERE id = ${id} AND workspace_id = ${session.workspace.id}
    RETURNING id, trust_score, trust_score_updated_at
  `);

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'people.trust_score.changed',
    targetType: 'person',
    targetId: id,
    payload: { from, to },
    ipAddress, userAgent,
  });

  return c.json({ person: updated[0] });
});

// ============================================================================
// POST /api/people/:id/communications — log a manual communication
// ============================================================================
const commSchema = z.object({
  channel: z.enum(['call', 'whatsapp', 'email', 'other']),
  direction: z.enum(['in', 'out']),
  notes: z.string().max(2000).optional(),
  occurred_at: z.string().datetime().optional(),
});

people.post('/:id/communications', requireRole('owner', 'manager'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');

  const body = await c.req.json().catch(() => null);
  const parsed = commSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  }
  const input = parsed.data;

  const person = await query<{ id: string; display_name: string }>(sql`
    SELECT id, display_name FROM people
    WHERE id = ${id} AND workspace_id = ${session.workspace.id} AND deleted_at IS NULL
    LIMIT 1
  `);
  if (person.length === 0) return c.json({ error: 'not_found' }, 404);

  const created = await query<{
    id: string; channel: string; direction: string; notes: string | null;
    occurred_at: string; logged_by_user_id: string | null; created_at: string;
  }>(sql`
    INSERT INTO person_communications
      (workspace_id, person_id, channel, direction, notes, occurred_at, logged_by_user_id)
    VALUES (
      ${session.workspace.id}, ${id}, ${input.channel}, ${input.direction},
      ${input.notes ?? null}::text,
      COALESCE(${input.occurred_at ?? null}::timestamptz, now()),
      ${session.user.id}
    )
    RETURNING id, channel, direction, notes, occurred_at, logged_by_user_id, created_at
  `);

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'people.communication.logged',
    targetType: 'person',
    targetId: id,
    payload: { communication_id: created[0]!.id, channel: input.channel, direction: input.direction },
    ipAddress, userAgent,
  });

  emitNotification({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'people.communication.logged',
    targetType: 'person', targetId: id,
    linkUrl: `/person.html?id=${id}`,
    metadata: { customer_name: person[0]!.display_name, channel: input.channel, direction: input.direction },
  }).catch(() => {});

  return c.json({
    communication: { ...created[0], logged_by_name: session.user.displayName },
  });
});

// ============================================================================
// DELETE /api/people/:id/communications/:commId — 5-min own-entry correction
// ============================================================================
const COMM_DELETE_WINDOW_MS = 5 * 60 * 1000;

people.delete('/:id/communications/:commId', requireRole('owner', 'manager'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');
  const commId = c.req.param('commId');

  const rows = await query<{ logged_by_user_id: string | null; created_at: string }>(sql`
    SELECT logged_by_user_id, created_at
    FROM person_communications
    WHERE id = ${commId} AND person_id = ${id} AND workspace_id = ${session.workspace.id}
    LIMIT 1
  `);
  if (rows.length === 0) return c.json({ error: 'not_found' }, 404);

  const row = rows[0]!;
  if (row.logged_by_user_id !== session.user.id) {
    return c.json({ error: 'not_deletable', reason: 'not_your_entry' }, 409);
  }
  if (Date.now() - new Date(row.created_at).getTime() > COMM_DELETE_WINDOW_MS) {
    return c.json({ error: 'not_deletable', reason: 'window_expired' }, 409);
  }

  await sql`
    DELETE FROM person_communications
    WHERE id = ${commId} AND workspace_id = ${session.workspace.id}
  `;

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'people.communication.deleted',
    targetType: 'person',
    targetId: id,
    payload: { communication_id: commId },
    ipAddress, userAgent,
  });

  return c.json({ ok: true });
});
