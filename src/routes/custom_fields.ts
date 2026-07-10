import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { sql, query } from '../db.js';
import { audit } from '../lib/audit.js';
import { loadCustomFieldValues, upsertCustomFieldValues, type CustomFieldEntity } from '../lib/custom_fields.js';
import {
  sessionMiddleware,
  requireAuth,
  requireRole,
  type SessionUser,
  type SessionWorkspace,
} from '../middleware/session.js';

// ============================================================================
// src/routes/custom_fields.ts  (Sub-turn 6g) — workspace-defined custom fields
// ----------------------------------------------------------------------------
//   GET    /api/custom-fields/definitions?entity_type=order   active defs
//   POST   /api/custom-fields/definitions                     create (owner/manager)
//   PATCH  /api/custom-fields/definitions/:id                 update (owner/manager)
//   DELETE /api/custom-fields/definitions/:id                 soft-delete (owner/manager)
//   GET    /api/custom-fields/values?entity_type=&entity_id=  values for a record
//   PUT    /api/custom-fields/values                          bulk upsert values
// ============================================================================

type SessionVar = {
  sessionId: string;
  user: SessionUser;
  workspace: SessionWorkspace;
} | null;

type Env = { Variables: { session: SessionVar } };

export const customFields = new Hono<Env>();
customFields.use('*', sessionMiddleware, requireAuth);

function clientCtx(c: Context) {
  const ipAddress =
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    c.req.header('x-real-ip') ?? null;
  const userAgent = c.req.header('user-agent') ?? null;
  return { ipAddress, userAgent };
}

const ENTITY_TYPES = ['order', 'person', 'product'] as const;
const FIELD_TYPES = ['text', 'number', 'date', 'checkbox', 'dropdown'] as const;

type DefinitionRow = {
  id: string;
  entity_type: string;
  field_key: string;
  label: string;
  field_type: string;
  options: string[] | null;
  is_required: boolean;
  help_text: string | null;
  sort_order: number;
};

// ============================================================================
// GET /api/custom-fields/definitions?entity_type=order
// ============================================================================
customFields.get('/definitions', async (c) => {
  const session = c.get('session')!;
  const entityType = c.req.query('entity_type');
  if (!entityType || !(ENTITY_TYPES as readonly string[]).includes(entityType)) {
    return c.json({ error: 'invalid_entity_type' }, 400);
  }
  const definitions = await query<DefinitionRow>(sql`
    SELECT id, entity_type, field_key, label, field_type, options, is_required, help_text, sort_order
    FROM custom_field_definitions
    WHERE workspace_id = ${session.workspace.id}::uuid
      AND entity_type = ${entityType}::text
      AND is_active = true
    ORDER BY sort_order ASC, created_at ASC
  `);
  return c.json({ definitions });
});

// ============================================================================
// POST /api/custom-fields/definitions — create (owner/manager)
// ============================================================================
const createSchema = z.object({
  entity_type: z.enum(ENTITY_TYPES),
  field_key: z.string().regex(/^[a-z][a-z0-9_]{0,49}$/, 'Must start with a lowercase letter; lowercase alphanumeric + underscore only'),
  label: z.string().min(1).max(200),
  field_type: z.enum(FIELD_TYPES),
  options: z.array(z.string().max(200)).optional(),
  is_required: z.boolean().default(false),
  help_text: z.string().max(500).optional(),
  sort_order: z.number().int().default(0),
});

customFields.post('/definitions', requireRole('owner', 'manager'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);

  const body = await c.req.json().catch(() => null);
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  const input = parsed.data;

  if (input.field_type === 'dropdown' && (!input.options || input.options.length === 0)) {
    return c.json({ error: 'dropdown_options_required' }, 400);
  }

  const existing = await query<{ id: string }>(sql`
    SELECT id FROM custom_field_definitions
    WHERE workspace_id = ${session.workspace.id}::uuid
      AND entity_type = ${input.entity_type}::text
      AND field_key = ${input.field_key}::text
    LIMIT 1
  `);
  if (existing.length) return c.json({ error: 'field_key_taken', field_key: input.field_key }, 409);

  const optionsJson = input.field_type === 'dropdown' ? JSON.stringify(input.options ?? []) : null;
  const inserted = await query<DefinitionRow>(sql`
    INSERT INTO custom_field_definitions
      (workspace_id, entity_type, field_key, label, field_type, options, is_required, help_text, sort_order, created_by_user_id)
    VALUES (
      ${session.workspace.id}::uuid, ${input.entity_type}::text, ${input.field_key}::text, ${input.label}::text,
      ${input.field_type}::text, ${optionsJson}::jsonb, ${input.is_required}::boolean,
      ${input.help_text ?? null}::text, ${input.sort_order}::int, ${session.user.id}::uuid
    )
    RETURNING id, entity_type, field_key, label, field_type, options, is_required, help_text, sort_order
  `);

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'custom_fields.definition_created',
    targetType: 'custom_field_definition',
    targetId: inserted[0]!.id,
    payload: { entity_type: input.entity_type, field_key: input.field_key, field_type: input.field_type },
    ipAddress, userAgent,
  });

  return c.json({ definition: inserted[0] });
});

// ============================================================================
// PATCH /api/custom-fields/definitions/:id — update (owner/manager)
// entity_type + field_key are immutable (protects existing values).
// ============================================================================
const updateSchema = z.object({
  label: z.string().min(1).max(200).optional(),
  field_type: z.enum(FIELD_TYPES).optional(),
  options: z.array(z.string().max(200)).optional(),
  is_required: z.boolean().optional(),
  help_text: z.string().max(500).nullable().optional(),
  sort_order: z.number().int().optional(),
});

customFields.patch('/definitions/:id', requireRole('owner', 'manager'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');

  const body = await c.req.json().catch(() => null);
  const parsed = updateSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  const p = parsed.data;

  const existing = await query<{ id: string; field_type: string }>(sql`
    SELECT id, field_type FROM custom_field_definitions
    WHERE id = ${id}::uuid AND workspace_id = ${session.workspace.id}::uuid
    LIMIT 1
  `);
  if (!existing.length) return c.json({ error: 'not_found' }, 404);

  const effectiveType = p.field_type ?? existing[0]!.field_type;
  if (effectiveType === 'dropdown' && p.options !== undefined && p.options.length === 0) {
    return c.json({ error: 'dropdown_options_required' }, 400);
  }
  const optionsJson = p.options !== undefined ? JSON.stringify(p.options) : null;

  const updated = await query<DefinitionRow>(sql`
    UPDATE custom_field_definitions SET
      label       = COALESCE(${p.label ?? null}::text, label),
      field_type  = COALESCE(${p.field_type ?? null}::text, field_type),
      options     = COALESCE(${optionsJson}::jsonb, options),
      is_required = COALESCE(${p.is_required ?? null}::boolean, is_required),
      help_text   = CASE WHEN ${p.help_text !== undefined}::boolean THEN ${p.help_text ?? null}::text ELSE help_text END,
      sort_order  = COALESCE(${p.sort_order ?? null}::int, sort_order),
      updated_at  = now()
    WHERE id = ${id}::uuid AND workspace_id = ${session.workspace.id}::uuid
    RETURNING id, entity_type, field_key, label, field_type, options, is_required, help_text, sort_order
  `);
  if (!updated.length) return c.json({ error: 'not_found' }, 404);

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'custom_fields.definition_updated',
    targetType: 'custom_field_definition',
    targetId: id,
    payload: { fields: Object.keys(p) },
    ipAddress, userAgent,
  });

  return c.json({ definition: updated[0] });
});

// ============================================================================
// DELETE /api/custom-fields/definitions/:id — soft-delete (owner/manager)
// ============================================================================
customFields.delete('/definitions/:id', requireRole('owner', 'manager'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');

  const updated = await query<{ id: string }>(sql`
    UPDATE custom_field_definitions SET is_active = false, updated_at = now()
    WHERE id = ${id}::uuid AND workspace_id = ${session.workspace.id}::uuid AND is_active = true
    RETURNING id
  `);
  if (!updated.length) return c.json({ error: 'not_found' }, 404);

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'custom_fields.definition_removed',
    targetType: 'custom_field_definition',
    targetId: id,
    payload: {},
    ipAddress, userAgent,
  });

  return c.json({ ok: true });
});

// ============================================================================
// GET /api/custom-fields/values?entity_type=order&entity_id=<uuid>
// ============================================================================
customFields.get('/values', async (c) => {
  const session = c.get('session')!;
  const entityType = c.req.query('entity_type');
  const entityId = c.req.query('entity_id');
  if (!entityType || !(ENTITY_TYPES as readonly string[]).includes(entityType)) {
    return c.json({ error: 'invalid_entity_type' }, 400);
  }
  if (!entityId) return c.json({ error: 'entity_id_required' }, 400);

  const values = await loadCustomFieldValues(session.workspace.id, entityType as CustomFieldEntity, entityId);
  return c.json({ values });
});

// ============================================================================
// PUT /api/custom-fields/values — bulk upsert values for an entity
// ============================================================================
const valuesSchema = z.object({
  entity_type: z.enum(ENTITY_TYPES),
  entity_id: z.string().uuid(),
  values: z.array(z.object({
    definition_id: z.string().uuid(),
    value: z.string().nullable(),
  })),
});

customFields.put('/values', async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);

  const body = await c.req.json().catch(() => null);
  const parsed = valuesSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  const input = parsed.data;

  const { applied } = await upsertCustomFieldValues({
    workspaceId: session.workspace.id,
    entityType: input.entity_type,
    entityId: input.entity_id,
    actorUserId: session.user.id,
    values: input.values,
  });

  await audit({
    workspaceId: session.workspace.id,
    actorUserId: session.user.id,
    eventType: 'custom_fields.values_updated',
    targetType: input.entity_type,
    targetId: input.entity_id,
    payload: { count: applied },
    ipAddress, userAgent,
  });

  const values = await loadCustomFieldValues(session.workspace.id, input.entity_type, input.entity_id);
  return c.json({ values });
});
