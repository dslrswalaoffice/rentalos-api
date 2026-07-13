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
// src/routes/pricing.ts (Sub-turn 13, chunk 8) — mounted at /api/pricing
// ----------------------------------------------------------------------------
// CRUD for pricing STRUCTURES (+ tiers) and RULESETS (+ rules). Tiers/rules are
// saved replace-all with their parent (how the builder posts them). Reads are
// open to any member; writes require inventory.pricing (per 12a).
// SEED NO RULES — the workspace configures weekend/half-day itself.
// ============================================================================

type SessionVar = { sessionId: string; user: SessionUser; workspace: SessionWorkspace } | null;
type Env = { Variables: { session: SessionVar } };

export const pricing = new Hono<Env>();
pricing.use('*', sessionMiddleware, requireAuth);

function clientCtx(c: Context) {
  const ipAddress = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? c.req.header('x-real-ip') ?? null;
  const userAgent = c.req.header('user-agent') ?? null;
  return { ipAddress, userAgent };
}

const CHARGE_PERIODS = ['hour', 'day', 'week', 'month'] as const;

// ----------------------------------------------------------------------------
// STRUCTURES
// ----------------------------------------------------------------------------
const tierSchema = z.object({
  duration_value: z.number().int().positive(),
  duration_period: z.enum(CHARGE_PERIODS),
  multiplier: z.number().nonnegative(),
  sort_order: z.number().int().default(0),
});
const structureSchema = z.object({
  name: z.string().min(1).max(200),
  is_template: z.boolean().default(false),
  overflow_period: z.enum(CHARGE_PERIODS).nullable().optional(),
  overflow_multiplier: z.number().nonnegative().nullable().optional(),
  tiers: z.array(tierSchema).default([]),
});

async function loadStructures(workspaceId: string, id?: string) {
  const structs = await query<{
    id: string; name: string; is_template: boolean;
    overflow_period: string | null; overflow_multiplier: string | number | null;
  }>(sql`
    SELECT id, name, is_template, overflow_period::text AS overflow_period, overflow_multiplier
    FROM pricing_structures
    WHERE workspace_id = ${workspaceId}::uuid
      AND (${id ?? null}::uuid IS NULL OR id = ${id ?? null}::uuid)
    ORDER BY is_template DESC, name ASC
  `);
  if (structs.length === 0) return [];
  const ids = structs.map((s) => s.id).join(',');
  const tiers = await query<{
    id: string; structure_id: string; duration_value: number; duration_period: string;
    multiplier: string | number; sort_order: number;
  }>(sql`
    SELECT id, structure_id, duration_value, duration_period::text AS duration_period, multiplier, sort_order
    FROM pricing_tiers WHERE structure_id::text = ANY(string_to_array(${ids}::text, ','))
    ORDER BY sort_order ASC, duration_value ASC
  `);
  return structs.map((s) => ({
    ...s,
    overflow_multiplier: s.overflow_multiplier != null ? Number(s.overflow_multiplier) : null,
    tiers: tiers.filter((t) => t.structure_id === s.id).map((t) => ({ ...t, multiplier: Number(t.multiplier) })),
  }));
}

pricing.get('/structures', async (c) => {
  const session = c.get('session')!;
  return c.json({ structures: await loadStructures(session.workspace.id) });
});

pricing.post('/structures', requirePermission('inventory.pricing'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const parsed = structureSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  const p = parsed.data;

  const rows = await query<{ id: string }>(sql`
    INSERT INTO pricing_structures (workspace_id, name, is_template, overflow_period, overflow_multiplier)
    VALUES (${session.workspace.id}::uuid, ${p.name}::text, ${p.is_template}::boolean,
            ${p.overflow_period ?? null}::charge_period, ${p.overflow_multiplier ?? null}::numeric)
    RETURNING id
  `);
  const structureId = rows[0]!.id;
  await replaceTiers(structureId, p.tiers);
  await audit({
    workspaceId: session.workspace.id, actorUserId: session.user.id,
    eventType: 'pricing.structure.created', targetType: 'pricing_structure', targetId: structureId,
    payload: { name: p.name, is_template: p.is_template, tier_count: p.tiers.length }, ipAddress, userAgent,
  });
  const [structure] = await loadStructures(session.workspace.id, structureId);
  return c.json({ structure }, 201);
});

pricing.patch('/structures/:id', requirePermission('inventory.pricing'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');
  const parsed = structureSchema.partial().safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  const p = parsed.data;

  const updated = await query<{ id: string }>(sql`
    UPDATE pricing_structures SET
      name = COALESCE(${p.name ?? null}::text, name),
      is_template = COALESCE(${p.is_template ?? null}::boolean, is_template),
      overflow_period = ${p.overflow_period === undefined ? null : p.overflow_period}::charge_period,
      overflow_multiplier = ${p.overflow_multiplier === undefined ? null : p.overflow_multiplier}::numeric,
      updated_at = now()
    WHERE id = ${id}::uuid AND workspace_id = ${session.workspace.id}::uuid
    RETURNING id
  `);
  if (updated.length === 0) return c.json({ error: 'not_found' }, 404);
  if (p.tiers) await replaceTiers(id, p.tiers);
  await audit({
    workspaceId: session.workspace.id, actorUserId: session.user.id,
    eventType: 'pricing.structure.updated', targetType: 'pricing_structure', targetId: id,
    payload: { fields: Object.keys(p) }, ipAddress, userAgent,
  });
  const [structure] = await loadStructures(session.workspace.id, id);
  return c.json({ structure });
});

pricing.delete('/structures/:id', requirePermission('inventory.pricing'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');
  // Detach from any products first (SET NULL is already the FK, but be explicit).
  await sql`UPDATE products SET pricing_structure_id = NULL WHERE pricing_structure_id = ${id}::uuid AND workspace_id = ${session.workspace.id}::uuid`;
  const del = await query<{ id: string }>(sql`
    DELETE FROM pricing_structures WHERE id = ${id}::uuid AND workspace_id = ${session.workspace.id}::uuid RETURNING id
  `);
  if (del.length === 0) return c.json({ error: 'not_found' }, 404);
  await audit({
    workspaceId: session.workspace.id, actorUserId: session.user.id,
    eventType: 'pricing.structure.deleted', targetType: 'pricing_structure', targetId: id, payload: {}, ipAddress, userAgent,
  });
  return c.json({ ok: true });
});

async function replaceTiers(structureId: string, tiers: z.infer<typeof tierSchema>[]) {
  await sql`DELETE FROM pricing_tiers WHERE structure_id = ${structureId}::uuid`;
  for (const t of tiers) {
    await sql`
      INSERT INTO pricing_tiers (structure_id, duration_value, duration_period, multiplier, sort_order)
      VALUES (${structureId}::uuid, ${t.duration_value}::int, ${t.duration_period}::charge_period,
              ${t.multiplier}::numeric, ${t.sort_order}::int)
      ON CONFLICT (structure_id, duration_value, duration_period) DO UPDATE
        SET multiplier = EXCLUDED.multiplier, sort_order = EXCLUDED.sort_order
    `;
  }
}

// ----------------------------------------------------------------------------
// RULESETS
// ----------------------------------------------------------------------------
const ruleSchema = z.object({
  name: z.string().min(1).max(200),
  kind: z.enum(['adjust_charge_period', 'adjust_price']),
  sort_order: z.number().int().default(0),
  days_of_week: z.array(z.number().int().min(0).max(6)).nullable().optional(),
  date_from: z.string().nullable().optional(),
  date_until: z.string().nullable().optional(),
  time_from: z.string().nullable().optional(),
  time_until: z.string().nullable().optional(),
  price_adjustment_bps: z.number().int().nullable().optional(),
  charge_period_action: z.enum(['exclude_pickup_day', 'exclude_return_day', 'cap_at_one_day']).nullable().optional(),
});
const rulesetSchema = z.object({
  name: z.string().min(1).max(200),
  stacking: z.boolean().default(false),
  rules: z.array(ruleSchema).default([]),
});

async function loadRulesets(workspaceId: string, id?: string) {
  const sets = await query<{ id: string; name: string; stacking: boolean }>(sql`
    SELECT id, name, stacking FROM pricing_rulesets
    WHERE workspace_id = ${workspaceId}::uuid
      AND (${id ?? null}::uuid IS NULL OR id = ${id ?? null}::uuid)
    ORDER BY name ASC
  `);
  if (sets.length === 0) return [];
  const ids = sets.map((s) => s.id).join(',');
  const rules = await query<Record<string, unknown>>(sql`
    SELECT id, ruleset_id, name, kind::text AS kind, sort_order, days_of_week,
           date_from::text AS date_from, date_until::text AS date_until,
           time_from::text AS time_from, time_until::text AS time_until,
           price_adjustment_bps, charge_period_action
    FROM pricing_rules WHERE ruleset_id::text = ANY(string_to_array(${ids}::text, ','))
    ORDER BY sort_order ASC
  `);
  return sets.map((s) => ({ ...s, rules: rules.filter((r) => r.ruleset_id === s.id) }));
}

pricing.get('/rulesets', async (c) => {
  const session = c.get('session')!;
  return c.json({ rulesets: await loadRulesets(session.workspace.id) });
});

pricing.post('/rulesets', requirePermission('inventory.pricing'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const parsed = rulesetSchema.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  const p = parsed.data;
  const rows = await query<{ id: string }>(sql`
    INSERT INTO pricing_rulesets (workspace_id, name, stacking)
    VALUES (${session.workspace.id}::uuid, ${p.name}::text, ${p.stacking}::boolean) RETURNING id
  `);
  const rulesetId = rows[0]!.id;
  await replaceRules(rulesetId, p.rules);
  await audit({
    workspaceId: session.workspace.id, actorUserId: session.user.id,
    eventType: 'pricing.ruleset.created', targetType: 'pricing_ruleset', targetId: rulesetId,
    payload: { name: p.name, rule_count: p.rules.length }, ipAddress, userAgent,
  });
  const [ruleset] = await loadRulesets(session.workspace.id, rulesetId);
  return c.json({ ruleset }, 201);
});

pricing.patch('/rulesets/:id', requirePermission('inventory.pricing'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');
  const parsed = rulesetSchema.partial().safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  const p = parsed.data;
  const updated = await query<{ id: string }>(sql`
    UPDATE pricing_rulesets SET
      name = COALESCE(${p.name ?? null}::text, name),
      stacking = COALESCE(${p.stacking ?? null}::boolean, stacking),
      updated_at = now()
    WHERE id = ${id}::uuid AND workspace_id = ${session.workspace.id}::uuid RETURNING id
  `);
  if (updated.length === 0) return c.json({ error: 'not_found' }, 404);
  if (p.rules) await replaceRules(id, p.rules);
  await audit({
    workspaceId: session.workspace.id, actorUserId: session.user.id,
    eventType: 'pricing.ruleset.updated', targetType: 'pricing_ruleset', targetId: id,
    payload: { fields: Object.keys(p) }, ipAddress, userAgent,
  });
  const [ruleset] = await loadRulesets(session.workspace.id, id);
  return c.json({ ruleset });
});

pricing.delete('/rulesets/:id', requirePermission('inventory.pricing'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');
  await sql`UPDATE products SET pricing_ruleset_id = NULL WHERE pricing_ruleset_id = ${id}::uuid AND workspace_id = ${session.workspace.id}::uuid`;
  const del = await query<{ id: string }>(sql`
    DELETE FROM pricing_rulesets WHERE id = ${id}::uuid AND workspace_id = ${session.workspace.id}::uuid RETURNING id
  `);
  if (del.length === 0) return c.json({ error: 'not_found' }, 404);
  await audit({
    workspaceId: session.workspace.id, actorUserId: session.user.id,
    eventType: 'pricing.ruleset.deleted', targetType: 'pricing_ruleset', targetId: id, payload: {}, ipAddress, userAgent,
  });
  return c.json({ ok: true });
});

async function replaceRules(rulesetId: string, rules: z.infer<typeof ruleSchema>[]) {
  await sql`DELETE FROM pricing_rules WHERE ruleset_id = ${rulesetId}::uuid`;
  for (const r of rules) {
    const dows = r.days_of_week && r.days_of_week.length ? `{${r.days_of_week.join(',')}}` : null;
    await sql`
      INSERT INTO pricing_rules
        (ruleset_id, name, kind, sort_order, days_of_week, date_from, date_until,
         time_from, time_until, price_adjustment_bps, charge_period_action)
      VALUES (${rulesetId}::uuid, ${r.name}::text, ${r.kind}::price_rule_kind, ${r.sort_order}::int,
              ${dows}::int[], ${r.date_from ?? null}::date, ${r.date_until ?? null}::date,
              ${r.time_from ?? null}::time, ${r.time_until ?? null}::time,
              ${r.price_adjustment_bps ?? null}::int, ${r.charge_period_action ?? null}::text)
    `;
  }
}
