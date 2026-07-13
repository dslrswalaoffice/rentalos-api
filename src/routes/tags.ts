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
import { requirePermission } from '../lib/permissions.js';

// ============================================================================
// src/routes/tags.ts  (Sub-turn 8a) — mounted at /api/tags
// ----------------------------------------------------------------------------
// Workspace-scoped labels for products / people / orders. Owner/manager can
// CRUD + reorder tags; ANY authenticated member can assign/unassign them.
// Soft-delete (is_active = false) preserves historical assignments. Colors are
// one of 8 presets, enforced at the DB CHECK level and mirrored in Zod.
// Neon HTTP has no cross-statement transactions, so reorder / bulk-set run as
// sequential statements; assignment inserts are idempotent via ON CONFLICT.
// ============================================================================

type SessionVar = {
  sessionId: string;
  user: SessionUser;
  workspace: SessionWorkspace;
} | null;

type Env = { Variables: { session: SessionVar } };

export const tags = new Hono<Env>();
tags.use('*', sessionMiddleware, requireAuth);

function clientCtx(c: Context) {
  const ipAddress =
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    c.req.header('x-real-ip') ?? null;
  const userAgent = c.req.header('user-agent') ?? null;
  return { ipAddress, userAgent };
}

const COLORS = ['red', 'orange', 'yellow', 'green', 'blue', 'purple', 'pink', 'gray'] as const;
const ENTITY_TYPES = ['product', 'person', 'order'] as const;

type TagRow = {
  id: string; workspace_id: string; name: string; color: string;
  sort_order: number; is_active: boolean; usage_count?: number;
  created_at: string; updated_at: string;
};

// ============================================================================
// GET /api/tags — active tags for the workspace (with usage counts)
// ============================================================================
tags.get('/', async (c) => {
  const session = c.get('session')!;
  const rows = await query<TagRow>(sql`
    SELECT t.id, t.workspace_id, t.name, t.color, t.sort_order, t.is_active,
           t.created_at, t.updated_at,
           (SELECT COUNT(*)::int FROM tag_assignments ta WHERE ta.tag_id = t.id) AS usage_count
    FROM tags t
    WHERE t.workspace_id = ${session.workspace.id}::uuid
      AND t.is_active = true
    ORDER BY t.sort_order ASC, t.name ASC
  `);
  // Tags rarely change; cache per navigation. `private` — workspace-scoped.
  // The only CRUD surface (settings.html) cache-busts its post-mutation reloads
  // so a just-saved tag shows immediately.
  c.header('Cache-Control', 'private, max-age=60, stale-while-revalidate=300');
  return c.json({ tags: rows });
});

// ============================================================================
// POST /api/tags — create (owner/manager)
// ============================================================================
const createSchema = z.object({
  name: z.string().min(1).max(50),
  color: z.enum(COLORS).default('gray'),
  sort_order: z.number().int().default(0),
});

tags.post('/', requirePermission('inventory.manage'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);

  const body = await c.req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  const input = parsed.data;

  // Name is unique per workspace (constraint covers active + inactive rows).
  const existing = await query<{ id: string }>(sql`
    SELECT id FROM tags
    WHERE workspace_id = ${session.workspace.id}::uuid AND name = ${input.name}::text
    LIMIT 1
  `);
  if (existing.length) return c.json({ error: 'name_taken' }, 409);

  const inserted = await query<TagRow>(sql`
    INSERT INTO tags (workspace_id, name, color, sort_order, created_by_user_id)
    VALUES (${session.workspace.id}::uuid, ${input.name}::text, ${input.color}::text,
            ${input.sort_order}::int, ${session.user.id}::uuid)
    RETURNING id, workspace_id, name, color, sort_order, is_active, created_at, updated_at
  `);

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'tags.created',
    targetType: 'tag',
    targetId: inserted[0]!.id,
    payload: { name: input.name, color: input.color },
    ipAddress, userAgent,
  });

  return c.json({ tag: { ...inserted[0], usage_count: 0 } }, 201);
});

// ============================================================================
// PATCH /api/tags/:id — rename / recolor (owner/manager)
// ============================================================================
const updateSchema = z.object({
  name: z.string().min(1).max(50).optional(),
  color: z.enum(COLORS).optional(),
});

// The :id is constrained to a UUID so the literal /assignments and /reorder
// paths can never be captured as an id (Hono matches in registration order).
tags.patch('/:id{[0-9a-fA-F-]{36}}', requirePermission('inventory.manage'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');

  const body = await c.req.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  const p = parsed.data;

  // If renaming, guard the unique constraint with a friendly error.
  if (p.name) {
    const clash = await query<{ id: string }>(sql`
      SELECT id FROM tags
      WHERE workspace_id = ${session.workspace.id}::uuid AND name = ${p.name}::text
        AND id != ${id}::uuid
      LIMIT 1
    `);
    if (clash.length) return c.json({ error: 'name_taken' }, 409);
  }

  const updated = await query<TagRow>(sql`
    UPDATE tags SET
      name       = COALESCE(${p.name  ?? null}::text, name),
      color      = COALESCE(${p.color ?? null}::text, color),
      updated_at = now()
    WHERE id = ${id}::uuid AND workspace_id = ${session.workspace.id}::uuid
    RETURNING id, workspace_id, name, color, sort_order, is_active, created_at, updated_at
  `);
  if (!updated.length) return c.json({ error: 'not_found' }, 404);

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'tags.updated',
    targetType: 'tag',
    targetId: id,
    payload: { fields: Object.keys(p) },
    ipAddress, userAgent,
  });

  return c.json({ tag: updated[0] });
});

// ============================================================================
// DELETE /api/tags/:id — soft-delete (owner/manager). Assignments preserved.
// ============================================================================
tags.delete('/:id{[0-9a-fA-F-]{36}}', requirePermission('inventory.manage'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');

  const updated = await query<{ id: string }>(sql`
    UPDATE tags SET is_active = false, updated_at = now()
    WHERE id = ${id}::uuid AND workspace_id = ${session.workspace.id}::uuid AND is_active = true
    RETURNING id
  `);
  if (!updated.length) return c.json({ error: 'not_found' }, 404);

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'tags.deleted',
    targetType: 'tag',
    targetId: id,
    payload: {},
    ipAddress, userAgent,
  });

  return c.json({ ok: true });
});

// ============================================================================
// POST /api/tags/reorder — batch sort_order (owner/manager)
// No transactions on Neon HTTP: sequential UPDATEs, workspace-scoped.
// ============================================================================
const reorderSchema = z.object({ tag_ids: z.array(z.string().uuid()).max(500) });

tags.post('/reorder', requirePermission('inventory.manage'), async (c) => {
  const session = c.get('session')!;
  const body = await c.req.json().catch(() => null);
  const parsed = reorderSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);

  const ids = parsed.data.tag_ids;
  for (let i = 0; i < ids.length; i++) {
    await sql`
      UPDATE tags SET sort_order = ${i}::int, updated_at = now()
      WHERE id = ${ids[i]}::uuid AND workspace_id = ${session.workspace.id}::uuid
    `;
  }
  return c.json({ ok: true });
});

// ============================================================================
// Assignment endpoints — ANY authenticated member. No per-assignment audit
// (too noisy); tag CRUD is audited instead.
// ============================================================================
const assignSchema = z.object({
  tag_id: z.string().uuid(),
  entity_type: z.enum(ENTITY_TYPES),
  entity_id: z.string().uuid(),
});

// Guard: the tag must belong to this workspace and be active.
async function tagInWorkspace(workspaceId: string, tagId: string): Promise<boolean> {
  const rows = await query<{ id: string }>(sql`
    SELECT id FROM tags
    WHERE id = ${tagId}::uuid AND workspace_id = ${workspaceId}::uuid AND is_active = true
    LIMIT 1
  `);
  return rows.length > 0;
}

// POST /api/tags/assignments — assign (idempotent)
// All members may tag entities (Sub-turn 8a design): tagging is lightweight
// metadata, not a privileged mutation. No permission gate by design.
tags.post('/assignments', async (c) => {
  const session = c.get('session')!;
  const body = await c.req.json().catch(() => null);
  const parsed = assignSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  const input = parsed.data;

  if (!(await tagInWorkspace(session.workspace.id, input.tag_id))) {
    return c.json({ error: 'tag_not_found' }, 404);
  }

  const inserted = await query<{ id: string }>(sql`
    INSERT INTO tag_assignments (workspace_id, tag_id, entity_type, entity_id, assigned_by_user_id)
    VALUES (${session.workspace.id}::uuid, ${input.tag_id}::uuid, ${input.entity_type}::text,
            ${input.entity_id}::uuid, ${session.user.id}::uuid)
    ON CONFLICT (workspace_id, tag_id, entity_type, entity_id) DO NOTHING
    RETURNING id
  `);
  return c.json({ ok: true, already_assigned: inserted.length === 0 });
});

// DELETE /api/tags/assignments — unassign
// All members (see POST /assignments) — untagging is symmetric with tagging.
tags.delete('/assignments', async (c) => {
  const session = c.get('session')!;
  const body = await c.req.json().catch(() => null);
  const parsed = assignSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  const input = parsed.data;

  await sql`
    DELETE FROM tag_assignments
    WHERE workspace_id = ${session.workspace.id}::uuid
      AND tag_id = ${input.tag_id}::uuid
      AND entity_type = ${input.entity_type}::text
      AND entity_id = ${input.entity_id}::uuid
  `;
  return c.json({ ok: true });
});

// PUT /api/tags/assignments — replace all tags on an entity
const replaceSchema = z.object({
  entity_type: z.enum(ENTITY_TYPES),
  entity_id: z.string().uuid(),
  tag_ids: z.array(z.string().uuid()).max(100),
});

// All members (see POST /assignments) — replace-all tag set on an entity.
tags.put('/assignments', async (c) => {
  const session = c.get('session')!;
  const body = await c.req.json().catch(() => null);
  const parsed = replaceSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  const input = parsed.data;

  // Only assign tags that actually belong to this workspace + are active.
  let validIds: string[] = [];
  if (input.tag_ids.length) {
    const csv = input.tag_ids.join(',');
    const rows = await query<{ id: string }>(sql`
      SELECT id FROM tags
      WHERE workspace_id = ${session.workspace.id}::uuid AND is_active = true
        AND id = ANY(string_to_array(${csv}::text, ',')::uuid[])
    `);
    validIds = rows.map((r) => r.id);
  }

  // Replace: clear then re-insert (no transaction on Neon HTTP).
  await sql`
    DELETE FROM tag_assignments
    WHERE workspace_id = ${session.workspace.id}::uuid
      AND entity_type = ${input.entity_type}::text
      AND entity_id = ${input.entity_id}::uuid
  `;
  for (const tagId of validIds) {
    await sql`
      INSERT INTO tag_assignments (workspace_id, tag_id, entity_type, entity_id, assigned_by_user_id)
      VALUES (${session.workspace.id}::uuid, ${tagId}::uuid, ${input.entity_type}::text,
              ${input.entity_id}::uuid, ${session.user.id}::uuid)
      ON CONFLICT (workspace_id, tag_id, entity_type, entity_id) DO NOTHING
    `;
  }
  return c.json({ ok: true, assigned: validIds.length });
});
