import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { sql, query } from '../db.js';
import {
  sessionMiddleware, requireAuth,
  type SessionUser, type SessionWorkspace,
} from '../middleware/session.js';
import { requirePermission } from '../lib/permissions.js';
import { idempotencyMiddleware } from '../lib/idempotency.js';
import {
  createDamageIncident, saveTheShoot, recordFinancialResolution, approveDamageIncident,
  rejectDamageIncident, closeDamageIncident, loadDamageIncident, loadDamageTimeline,
  INCIDENT_TYPES, SEVERITIES, REPORTED_BY_TYPES, OPERATIONAL_DECISIONS, CUSTOMER_LIABILITIES,
  FINANCIAL_RESOLUTIONS, DEPOSIT_ACTIONS, type IncidentType, type Severity,
} from '../lib/damage.js';

// ============================================================================
// src/routes/damage.ts (Sub-slice 2.3)
// ----------------------------------------------------------------------------
// orderDamage — order-scoped (/api/orders/:id/damage-incidents), FOLDED INTO the
//   orders router (no global middleware here).
// damageIncidents — id-scoped (/api/damage-incidents/:id/...), standalone prefix
//   with its own session + auth + idempotency.
//
// PERMISSIONS (warehouse/staff never touches money):
//   report                → damage.record (staff has it)
//   save-the-shoot        → damage.record (operational)
//   financial-resolution  → damage.resolve_financial (manager+; staff blocked)
//   approve               → damage.approve (owner-only; in no preset)
//   reject/close          → damage.resolve_financial
// ============================================================================
type SessionVar = { sessionId: string; user: SessionUser; workspace: SessionWorkspace } | null;
type Env = { Variables: { session: SessionVar } };

function clientCtx(c: Context) {
  const ipAddress = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? c.req.header('x-real-ip') ?? null;
  return { ipAddress, userAgent: c.req.header('user-agent') ?? null };
}
function actorName(session: { user: SessionUser }): string {
  return (session.user as { display_name?: string; email?: string }).display_name ?? (session.user as { email?: string }).email ?? 'Operator';
}

// No photos in 2.3 (Aamir Q1) — damage evidence lives in the Order Notes card.
const affectedItemSchema = z.object({
  order_item_id: z.string().uuid(),
  asset_id: z.string().uuid().nullish(),
  severity: z.enum(SEVERITIES),
  estimated_repair_cost_paise: z.number().int().min(0).nullish(),
  disposition: z.enum(['return_to_service', 'maintenance_required', 'retire', 'sell_as_used', 'scrap', 'pending_assessment']).nullish(),
  repair_notes: z.string().max(2000).nullish(),
});

// Rule A schemas.
export const damageCreateSchema = z.object({
  reported_by_type: z.enum(REPORTED_BY_TYPES),
  occurred_at: z.string().datetime(),
  incident_type: z.enum(INCIDENT_TYPES),
  severity: z.enum(SEVERITIES),
  description: z.string().min(1).max(4000),
  affected_items: z.array(affectedItemSchema).min(1),
  estimated_cost_paise: z.number().int().min(0).nullish(),
});
export const saveTheShootSchema = z.object({
  operational_decision: z.enum(OPERATIONAL_DECISIONS),
  substitution: z.object({
    original_order_item_id: z.string().uuid(),
    original_asset_id: z.string().uuid().nullish(),
    replacement_product_id: z.string().uuid().nullish(),
    replacement_asset_id: z.string().uuid().nullish(),
    substitution_type: z.string().max(50).default('same_product_swap'),
    timing: z.string().max(50).default('rush_mid_rental'),
  }).nullish(),
});
export const financialResolutionSchema = z.object({
  customer_liability: z.enum(CUSTOMER_LIABILITIES),
  liability_percent: z.number().int().min(0).max(100).nullish(),
  final_cost_paise: z.number().int().min(0).nullish(),
  financial_resolution: z.enum(FINANCIAL_RESOLUTIONS),
  deposit_action: z.enum(DEPOSIT_ACTIONS),
  deposit_forfeit_amount_paise: z.number().int().min(0).nullish(),
  insurance_eligible: z.boolean().nullish(),
  customer_disputed: z.boolean().nullish(),
});
export const damageRejectSchema = z.object({ reason: z.string().max(2000).nullish() });

// ---------------------------------------------------------------------------
// Order-scoped (folded).
// ---------------------------------------------------------------------------
export const orderDamage = new Hono<Env>();

async function orderExists(orderId: string, workspaceId: string): Promise<boolean> {
  const r = await query<{ id: string }>(sql`SELECT id FROM orders WHERE id = ${orderId}::uuid AND workspace_id = ${workspaceId}::uuid AND deleted_at IS NULL LIMIT 1`);
  return r.length > 0;
}

orderDamage.get('/:id/damage-incidents', async (c) => {
  const session = c.get('session')!;
  const rows = await query<any>(sql`
    SELECT id, incident_number, reported_by_type, occurred_at, incident_type, severity, status,
           operational_decision, customer_liability, financial_resolution, deposit_action,
           requires_approval, customer_notified, customer_disputed, linked_substitution_id, created_at
    FROM damage_incidents WHERE order_id = ${c.req.param('id')}::uuid AND workspace_id = ${session.workspace.id}::uuid
    ORDER BY created_at DESC
  `);
  return c.json({ damage_incidents: rows });
});

orderDamage.post('/:id/damage-incidents', requirePermission('damage.record'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');
  if (!(await orderExists(id, session.workspace.id))) return c.json({ error: 'not_found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const parsed = damageCreateSchema.safeParse(body ?? {});
  if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  const p = parsed.data;
  const r = await createDamageIncident({
    workspaceId: session.workspace.id, orderId: id, actorUserId: session.user.id, actorName: actorName(session),
    reportedByType: p.reported_by_type, occurredAt: p.occurred_at, incidentType: p.incident_type as IncidentType, severity: p.severity as Severity,
    description: p.description, estimatedCostPaise: p.estimated_cost_paise ?? null,
    affectedItems: p.affected_items.map((it) => ({
      order_item_id: it.order_item_id, asset_id: it.asset_id ?? null, severity: it.severity as Severity,
      estimated_repair_cost_paise: it.estimated_repair_cost_paise ?? null, disposition: it.disposition ?? null, repair_notes: it.repair_notes ?? null,
    })),
    ip: ipAddress, userAgent,
  });
  if (!r.ok) {
    const code = r.error === 'order_not_found' ? 404 : 409;
    return c.json({ error: r.error }, code);
  }
  return c.json({ damage_incident: r.incident, requires_approval: r.requires_approval }, 201);
});

// ---------------------------------------------------------------------------
// Id-scoped (standalone /api/damage-incidents).
// ---------------------------------------------------------------------------
export const damageIncidents = new Hono<Env>();
damageIncidents.use('*', sessionMiddleware, requireAuth);
damageIncidents.use('*', idempotencyMiddleware);

async function loadIncidentMeta(id: string, workspaceId: string): Promise<{ id: string; order_id: string } | null> {
  return (await query<{ id: string; order_id: string }>(sql`SELECT id, order_id FROM damage_incidents WHERE id = ${id}::uuid AND workspace_id = ${workspaceId}::uuid LIMIT 1`))[0] ?? null;
}

damageIncidents.get('/:id', async (c) => {
  const session = c.get('session')!;
  const incident = await loadDamageIncident(session.workspace.id, c.req.param('id'));
  if (!incident) return c.json({ error: 'not_found' }, 404);
  return c.json({ damage_incident: incident });
});

damageIncidents.get('/:id/timeline', async (c) => {
  const session = c.get('session')!;
  const meta = await loadIncidentMeta(c.req.param('id'), session.workspace.id);
  if (!meta) return c.json({ error: 'not_found' }, 404);
  const events = await loadDamageTimeline(session.workspace.id, c.req.param('id'));
  return c.json({ events });
});

damageIncidents.post('/:id/save-the-shoot', requirePermission('damage.record'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const meta = await loadIncidentMeta(c.req.param('id'), session.workspace.id);
  if (!meta) return c.json({ error: 'not_found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const parsed = saveTheShootSchema.safeParse(body ?? {});
  if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  const p = parsed.data;
  const r = await saveTheShoot({
    workspaceId: session.workspace.id, orderId: meta.order_id, damageIncidentId: meta.id, actorUserId: session.user.id, actorName: actorName(session),
    operationalDecision: p.operational_decision,
    substitution: p.substitution ? {
      originalOrderItemId: p.substitution.original_order_item_id, originalAssetId: p.substitution.original_asset_id ?? null,
      replacementProductId: p.substitution.replacement_product_id ?? null, replacementAssetId: p.substitution.replacement_asset_id ?? null,
      substitutionType: p.substitution.substitution_type, timing: p.substitution.timing,
    } : null,
    ip: ipAddress, userAgent,
  });
  if (!r.ok) return c.json({ error: r.error }, 409);
  return c.json({ ok: true, linked_substitution_id: r.linked_substitution_id ?? null });
});

damageIncidents.post('/:id/financial-resolution', requirePermission('damage.resolve_financial'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const meta = await loadIncidentMeta(c.req.param('id'), session.workspace.id);
  if (!meta) return c.json({ error: 'not_found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const parsed = financialResolutionSchema.safeParse(body ?? {});
  if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  const p = parsed.data;
  const r = await recordFinancialResolution({
    workspaceId: session.workspace.id, orderId: meta.order_id, damageIncidentId: meta.id, actorUserId: session.user.id, actorName: actorName(session),
    customerLiability: p.customer_liability, liabilityPercent: p.liability_percent ?? null, finalCostPaise: p.final_cost_paise ?? null,
    financialResolution: p.financial_resolution, depositAction: p.deposit_action, depositForfeitAmountPaise: p.deposit_forfeit_amount_paise ?? null,
    insuranceEligible: p.insurance_eligible ?? null, customerDisputed: p.customer_disputed ?? null, ip: ipAddress, userAgent,
  });
  if (!r.ok) return c.json({ error: r.error }, 409);
  return c.json({ ok: true, requires_approval: r.requires_approval });
});

damageIncidents.post('/:id/approve', requirePermission('damage.approve'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const meta = await loadIncidentMeta(c.req.param('id'), session.workspace.id);
  if (!meta) return c.json({ error: 'not_found' }, 404);
  const r = await approveDamageIncident({ workspaceId: session.workspace.id, orderId: meta.order_id, damageIncidentId: meta.id, actorUserId: session.user.id, actorName: actorName(session), ip: ipAddress, userAgent });
  if (!r.ok) return c.json({ error: r.error }, 409);
  return c.json({ approved: true });
});

damageIncidents.post('/:id/reject', requirePermission('damage.resolve_financial'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const meta = await loadIncidentMeta(c.req.param('id'), session.workspace.id);
  if (!meta) return c.json({ error: 'not_found' }, 404);
  const body = await c.req.json().catch(() => ({}));
  const parsed = damageRejectSchema.safeParse(body ?? {});
  if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  const r = await rejectDamageIncident({ workspaceId: session.workspace.id, orderId: meta.order_id, damageIncidentId: meta.id, actorUserId: session.user.id, actorName: actorName(session), reason: parsed.data.reason ?? null, ip: ipAddress, userAgent });
  if (!r.ok) return c.json({ error: r.error }, 409);
  return c.json({ rejected: true });
});

damageIncidents.post('/:id/close', requirePermission('damage.resolve_financial'), async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const meta = await loadIncidentMeta(c.req.param('id'), session.workspace.id);
  if (!meta) return c.json({ error: 'not_found' }, 404);
  const r = await closeDamageIncident({ workspaceId: session.workspace.id, orderId: meta.order_id, damageIncidentId: meta.id, actorUserId: session.user.id, actorName: actorName(session), ip: ipAddress, userAgent });
  if (!r.ok) return c.json({ error: r.error }, 409);
  return c.json({ closed: true });
});
