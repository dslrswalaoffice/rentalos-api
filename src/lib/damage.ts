// ============================================================================
// src/lib/damage.ts (Sub-slice 2.3) — first-class damage incidents (Item 4)
// ----------------------------------------------------------------------------
// A damage incident is a PARALLEL workflow to the order: it captures damage with
// structured evidence (photos), operational continuity ("Save The Shoot"), and a
// financial resolution, all decoupled from the order lifecycle (an order can
// close while an incident stays open).
//
// Three levers, kept separate:
//   1. OPERATIONAL  — Save The Shoot: what happens to the SHOOT right now
//      (substitute / dispatch replacement / early return / continue / full return).
//      `substitute_with_another_unit` auto-creates a linked Substitution.
//   2. FINANCIAL    — liability + resolution + deposit action. Gated by
//      damage.resolve_financial (staff/warehouse can propose, never commit).
//   3. APPROVAL     — severity ≥ major OR cost > ₹15k OR insurance > ₹50k OR
//      customer disputed OR deposit forfeit > 50% (all policy-configurable).
//
// auto_customer_liability_by_type maps incident_type → default liability at report
// time (frozen into policy_applied_snapshot). Notifications AWAITED (Rule H).
// ============================================================================

import { sql, query } from '../db.js';
import { audit } from './audit.js';
import { emitNotification, emitCustomerNotification } from './notify.js';
import { createSubstitution } from './substitutions.js';

export const INCIDENT_TYPES = [
  'accidental_drop', 'impact_damage', 'liquid_damage', 'electrical_damage', 'operational_failure',
  'theft', 'loss', 'third_party_damage', 'weather', 'misuse', 'wear_and_tear_dispute', 'other',
] as const;
export type IncidentType = typeof INCIDENT_TYPES[number];

export const SEVERITIES = ['cosmetic', 'minor', 'major', 'total_loss', 'catastrophic'] as const;
export type Severity = typeof SEVERITIES[number];
const SEVERITY_RANK: Record<Severity, number> = { cosmetic: 0, minor: 1, major: 2, total_loss: 3, catastrophic: 4 };

export const REPORTED_BY_TYPES = ['customer_whatsapp', 'staff_observation', 'on_rent_check_in', 'inspection_at_return', 'third_party'] as const;
export const OPERATIONAL_DECISIONS = ['substitute_with_another_unit', 'dispatch_replacement_keep_damaged', 'early_return_damaged_only', 'continue_with_damaged', 'full_early_return', 'pending'] as const;
export const CUSTOMER_LIABILITIES = ['yes', 'no', 'partial', 'pending_investigation'] as const;
export const FINANCIAL_RESOLUTIONS = ['customer_pays', 'insurance_claim', 'warranty_coverage', 'business_absorbs', 'partial_split', 'deposit_only', 'deposit_plus_additional', 'pending'] as const;
export const DEPOSIT_ACTIONS = ['hold', 'adjust', 'forfeit_partial', 'forfeit_full', 'no_change'] as const;

function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; message?: string } | null;
  if (!err) return false;
  if (err.code === '23505') return true;
  return `${err.message ?? ''}`.toLowerCase().includes('duplicate key');
}
function inr(paise: number): string {
  return '₹' + new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(Number(paise) / 100));
}

type DamagePolicy = {
  auto_customer_liability_by_type: Record<string, string>;
  approval_required: { severity_major_or_higher?: boolean; cost_over_paise?: number; insurance_claim_over_paise?: number; customer_disputed?: boolean; deposit_forfeit_over_percent?: number };
  min_photos_required_per_incident: number;
  customer_notification_default: boolean;
  notify_owner_severity_threshold: string;
};
function readDamagePolicy(settings: Record<string, any> | null | undefined): DamagePolicy {
  const p = settings?.damage_policy ?? {};
  return {
    auto_customer_liability_by_type: p.auto_customer_liability_by_type ?? {},
    approval_required: p.approval_required ?? {},
    min_photos_required_per_incident: Number(p.min_photos_required_per_incident ?? 3),
    customer_notification_default: p.customer_notification_default !== false,
    notify_owner_severity_threshold: String(p.notify_owner_severity_threshold ?? 'major'),
  };
}

/** Does this incident require approval per policy? (evaluated at report + at
 *  financial-resolution). Returns {requires, reasons}. */
function evaluateDamageApproval(policy: DamagePolicy, input: {
  severity: Severity; estimatedCostPaise?: number | null; finalCostPaise?: number | null;
  insuranceEligible?: boolean; insuranceAmountPaise?: number | null; customerDisputed?: boolean;
  depositForfeitPercent?: number | null;
}): { requires: boolean; reasons: string[] } {
  const ar = policy.approval_required;
  const reasons: string[] = [];
  if (ar.severity_major_or_higher !== false && SEVERITY_RANK[input.severity] >= SEVERITY_RANK.major) reasons.push('severity_major_or_higher');
  const cost = Math.max(Number(input.finalCostPaise ?? 0), Number(input.estimatedCostPaise ?? 0));
  if (Number(ar.cost_over_paise ?? Infinity) > 0 && cost > Number(ar.cost_over_paise ?? Infinity)) reasons.push('cost_over_threshold');
  if (input.insuranceEligible && Number(input.insuranceAmountPaise ?? 0) > Number(ar.insurance_claim_over_paise ?? Infinity)) reasons.push('insurance_over_threshold');
  if (ar.customer_disputed !== false && input.customerDisputed) reasons.push('customer_disputed');
  if (Number(input.depositForfeitPercent ?? 0) > Number(ar.deposit_forfeit_over_percent ?? 100)) reasons.push('deposit_forfeit_over_percent');
  return { requires: reasons.length > 0, reasons };
}

async function loadOrderContext(workspaceId: string, orderId: string) {
  return (await query<{
    order_number: number; status: string; customer_person_id: string;
    customer_name: string | null; customer_phone: string | null; customer_email: string | null;
  }>(sql`
    SELECT o.order_number, o.status::text AS status, o.customer_person_id,
           p.display_name AS customer_name, p.phone AS customer_phone, p.email AS customer_email
    FROM orders o JOIN people p ON p.id = o.customer_person_id
    WHERE o.id = ${orderId}::uuid AND o.workspace_id = ${workspaceId}::uuid AND o.deleted_at IS NULL LIMIT 1
  `))[0] ?? null;
}

/** Append a timeline event (denormalized actor_name for display). */
export async function addDamageEvent(args: {
  workspaceId: string; damageIncidentId: string; eventType: string;
  actorType: 'user' | 'system' | 'customer'; actorId?: string | null; actorName: string;
  title: string; body?: string | null; data?: Record<string, unknown>;
}): Promise<void> {
  await sql`
    INSERT INTO damage_incident_events (workspace_id, damage_incident_id, event_type, actor_type, actor_id, actor_name, title, body, data)
    VALUES (${args.workspaceId}::uuid, ${args.damageIncidentId}::uuid, ${args.eventType}::text, ${args.actorType}::text,
      ${args.actorId ?? null}::uuid, ${args.actorName}::text, ${args.title}::text, ${args.body ?? null}::text, ${JSON.stringify(args.data ?? {})}::jsonb)
  `;
}

export type AffectedItemInput = {
  order_item_id: string; asset_id?: string | null; severity: Severity;
  photos_after?: Array<Record<string, unknown>>; photos_before?: Array<Record<string, unknown>>;
  estimated_repair_cost_paise?: number | null; disposition?: string | null; repair_notes?: string | null;
};

export type CreateDamageArgs = {
  workspaceId: string; orderId: string; actorUserId: string; actorName: string;
  reportedByType: string; occurredAt: string; incidentType: IncidentType; severity: Severity;
  description: string; photos?: Array<Record<string, unknown>>;
  affectedItems: AffectedItemInput[];
  estimatedCostPaise?: number | null;
  ip?: string | null; userAgent?: string | null;
};

export type CreateDamageResult =
  | { ok: true; incident: any; requires_approval: boolean }
  | { ok: false; error: string; min_photos?: number; provided?: number };

/** Report a damage incident: incident + per-asset rows + timeline, auto-liability
 *  from policy, approval routing, min-photo enforcement, notifications. */
export async function createDamageIncident(args: CreateDamageArgs): Promise<CreateDamageResult> {
  const orderCtx = await loadOrderContext(args.workspaceId, args.orderId);
  if (!orderCtx) return { ok: false, error: 'order_not_found' };
  if (!args.affectedItems || args.affectedItems.length === 0) return { ok: false, error: 'no_affected_items' };

  const settings = (await query<{ settings: Record<string, any> | null }>(sql`SELECT settings FROM workspaces WHERE id = ${args.workspaceId}::uuid LIMIT 1`))[0]?.settings ?? {};
  const policy = readDamagePolicy(settings);

  // Min photos: total across incident-level + per-asset "after" photos.
  const incidentPhotos = args.photos ?? [];
  const assetPhotoCount = args.affectedItems.reduce((n, it) => n + (it.photos_after?.length ?? 0), 0);
  const totalPhotos = incidentPhotos.length + assetPhotoCount;
  if (totalPhotos < policy.min_photos_required_per_incident) {
    return { ok: false, error: 'min_photos_required', min_photos: policy.min_photos_required_per_incident, provided: totalPhotos };
  }

  // Auto customer_liability from policy map (frozen into the snapshot).
  const autoLiability = policy.auto_customer_liability_by_type[args.incidentType] ?? 'pending_investigation';
  const approval = evaluateDamageApproval(policy, { severity: args.severity, estimatedCostPaise: args.estimatedCostPaise });
  const policySnapshot = {
    damage_policy: settings?.damage_policy ?? {},
    auto_liability_applied: autoLiability,
    approval_reasons: approval.reasons,
  };

  const year = new Date().getUTCFullYear();
  const MAX_ATTEMPTS = 4;
  let incident: any;
  for (let attempt = 1; ; attempt++) {
    const seq = Number((await query<{ n: number }>(sql`SELECT COUNT(*)::int AS n FROM damage_incidents WHERE workspace_id = ${args.workspaceId}::uuid`))[0]?.n ?? 0) + 1;
    const incidentNumber = `DI-${year}-${String(orderCtx.order_number).padStart(4, '0')}-${String(seq).padStart(3, '0')}`;
    try {
      incident = (await query<any>(sql`
        INSERT INTO damage_incidents (
          workspace_id, order_id, incident_number, reported_by_type, occurred_at, incident_type, severity,
          description, photos, customer_liability, estimated_cost_paise, financial_resolution, deposit_action,
          status, requires_approval, created_by, policy_applied_snapshot)
        VALUES (
          ${args.workspaceId}::uuid, ${args.orderId}::uuid, ${incidentNumber}::text, ${args.reportedByType}::text,
          ${args.occurredAt}::timestamptz, ${args.incidentType}::text, ${args.severity}::text, ${args.description}::text,
          ${JSON.stringify(incidentPhotos)}::jsonb, ${autoLiability}::text, ${args.estimatedCostPaise ?? null}::bigint,
          'pending'::text, 'no_change'::text, 'reported'::text, ${approval.requires}::boolean, ${args.actorUserId}::uuid,
          ${JSON.stringify(policySnapshot)}::jsonb)
        RETURNING *
      `))[0];
      break;
    } catch (e) {
      if (isUniqueViolation(e) && attempt < MAX_ATTEMPTS) continue;
      throw e;
    }
  }

  // Per-asset rows.
  for (const it of args.affectedItems) {
    await sql`
      INSERT INTO damage_incident_assets (workspace_id, damage_incident_id, order_item_id, asset_id, severity, photos_before, photos_after, estimated_repair_cost_paise, disposition, repair_notes)
      VALUES (${args.workspaceId}::uuid, ${incident.id}::uuid, ${it.order_item_id}::uuid, ${it.asset_id ?? null}::uuid, ${it.severity}::text,
        ${JSON.stringify(it.photos_before ?? [])}::jsonb, ${JSON.stringify(it.photos_after ?? [])}::jsonb,
        ${it.estimated_repair_cost_paise ?? null}::bigint, ${it.disposition ?? null}::text, ${it.repair_notes ?? null}::text)
    `;
  }

  await addDamageEvent({ workspaceId: args.workspaceId, damageIncidentId: incident.id, eventType: 'reported', actorType: 'user', actorId: args.actorUserId, actorName: args.actorName, title: 'Incident reported', body: `${args.severity} · ${args.incidentType} · via ${args.reportedByType}`, data: { affected_count: args.affectedItems.length } });
  // Mirror onto the ORDER timeline so Order 360 shows it.
  await sql`
    INSERT INTO order_events (workspace_id, order_id, event_type, payload, actor_user_id)
    VALUES (${args.workspaceId}::uuid, ${args.orderId}::uuid, 'order.damage.reported', ${JSON.stringify({ damage_incident_id: incident.id, incident_number: incident.incident_number, severity: args.severity, incident_type: args.incidentType })}::jsonb, ${args.actorUserId}::uuid)
  `;
  await audit({ workspaceId: args.workspaceId, actorUserId: args.actorUserId, eventType: 'damage_incidents.created', targetType: 'damage_incident', targetId: incident.id, payload: { order_id: args.orderId, incident_number: incident.incident_number, severity: args.severity, incident_type: args.incidentType, requires_approval: approval.requires }, ipAddress: args.ip ?? null, userAgent: args.userAgent ?? null });

  const itemSummary = `${args.affectedItems.length} item(s)`;
  // Internal feed (awaited, fail-open).
  try {
    await emitNotification({
      workspaceId: args.workspaceId, actorUserId: args.actorUserId, eventType: 'damage_incident_reported_internal',
      targetType: 'order', targetId: args.orderId, linkUrl: `/order-360.html?id=${args.orderId}`,
      metadata: { order_number: orderCtx.order_number, incident_number: incident.incident_number, severity: args.severity, incident_type: args.incidentType, actor_name: args.actorName },
    });
  } catch { /* fail-open */ }
  // Customer notification (policy default).
  if (policy.customer_notification_default) {
    try {
      await emitCustomerNotification({
        workspaceId: args.workspaceId, orderId: args.orderId, personId: orderCtx.customer_person_id, eventType: 'damage_incident_reported',
        message: `We've logged a damage report (${incident.incident_number}) on your order #${orderCtx.order_number}.`,
        channels: ['whatsapp', 'email'], contact: { phone: orderCtx.customer_phone, email: orderCtx.customer_email }, settings,
        variables: { customer_name: orderCtx.customer_name ?? 'there', incident_number: incident.incident_number, order_number: orderCtx.order_number, item_summary: itemSummary, severity: args.severity },
      });
      await sql`UPDATE damage_incidents SET customer_notified = true, updated_at = now() WHERE id = ${incident.id}::uuid AND workspace_id = ${args.workspaceId}::uuid`;
    } catch { /* fail-open */ }
  }

  return { ok: true, incident, requires_approval: approval.requires };
}

/** Save The Shoot — record the operational decision. substitute_with_another_unit
 *  auto-creates a linked Substitution (source_type = 'damage_incident'). */
export async function saveTheShoot(args: {
  workspaceId: string; orderId: string; damageIncidentId: string; actorUserId: string; actorName: string;
  operationalDecision: string; substitution?: {
    originalOrderItemId: string; originalAssetId?: string | null; replacementProductId?: string | null;
    replacementAssetId?: string | null; substitutionType: string; timing: string;
  } | null; ip?: string | null; userAgent?: string | null;
}): Promise<{ ok: boolean; error?: string; linked_substitution_id?: string | null }> {
  const incident = (await query<{ id: string; incident_number: string; status: string }>(sql`SELECT id, incident_number, status FROM damage_incidents WHERE id = ${args.damageIncidentId}::uuid AND workspace_id = ${args.workspaceId}::uuid LIMIT 1`))[0];
  if (!incident) return { ok: false, error: 'not_found' };

  let linkedSubstitutionId: string | null = null;
  if (args.operationalDecision === 'substitute_with_another_unit') {
    if (!args.substitution) return { ok: false, error: 'substitution_details_required' };
    const sub = await createSubstitution({
      workspaceId: args.workspaceId, orderId: args.orderId, actorUserId: args.actorUserId,
      originalOrderItemId: args.substitution.originalOrderItemId, originalAssetId: args.substitution.originalAssetId ?? null,
      replacementProductId: args.substitution.replacementProductId ?? null, replacementAssetId: args.substitution.replacementAssetId ?? null,
      substitutionType: (args.substitution.substitutionType as any) ?? 'same_product_swap',
      reasonTag: 'unit_damaged_in_rental', reasonNotes: `Save The Shoot for ${incident.incident_number}`,
      timing: args.substitution.timing ?? 'rush_mid_rental', sourceType: 'damage_incident', sourceId: args.damageIncidentId,
      ip: args.ip, userAgent: args.userAgent,
    });
    if (!sub.ok) return { ok: false, error: `substitution_failed:${sub.error}` };
    linkedSubstitutionId = sub.substitution.id;
  }

  await sql`
    UPDATE damage_incidents SET operational_decision = ${args.operationalDecision}::text, operational_decided_at = now(),
      operational_decided_by = ${args.actorUserId}::uuid, linked_substitution_id = ${linkedSubstitutionId}::uuid,
      status = CASE WHEN status = 'reported' THEN 'investigating' ELSE status END, updated_at = now()
    WHERE id = ${args.damageIncidentId}::uuid AND workspace_id = ${args.workspaceId}::uuid
  `;
  await addDamageEvent({ workspaceId: args.workspaceId, damageIncidentId: args.damageIncidentId, eventType: 'save_the_shoot', actorType: 'user', actorId: args.actorUserId, actorName: args.actorName, title: 'Save The Shoot decision', body: args.operationalDecision, data: { linked_substitution_id: linkedSubstitutionId } });
  await audit({ workspaceId: args.workspaceId, actorUserId: args.actorUserId, eventType: 'damage_incidents.save_the_shoot', targetType: 'damage_incident', targetId: args.damageIncidentId, payload: { order_id: args.orderId, incident_number: incident.incident_number, operational_decision: args.operationalDecision, linked_substitution_id: linkedSubstitutionId }, ipAddress: args.ip ?? null, userAgent: args.userAgent ?? null });
  return { ok: true, linked_substitution_id: linkedSubstitutionId };
}

/** Record the financial resolution (liability + resolution + deposit action).
 *  Re-evaluates approval; sets status resolution_proposed (or pending if approval). */
export async function recordFinancialResolution(args: {
  workspaceId: string; orderId: string; damageIncidentId: string; actorUserId: string; actorName: string;
  customerLiability: string; liabilityPercent?: number | null; finalCostPaise?: number | null;
  financialResolution: string; depositAction: string; depositForfeitAmountPaise?: number | null;
  insuranceEligible?: boolean | null; customerDisputed?: boolean | null; ip?: string | null; userAgent?: string | null;
}): Promise<{ ok: boolean; error?: string; requires_approval?: boolean }> {
  const incident = (await query<any>(sql`SELECT * FROM damage_incidents WHERE id = ${args.damageIncidentId}::uuid AND workspace_id = ${args.workspaceId}::uuid LIMIT 1`))[0];
  if (!incident) return { ok: false, error: 'not_found' };
  const orderCtx = await loadOrderContext(args.workspaceId, args.orderId);
  const settings = (await query<{ settings: Record<string, any> | null }>(sql`SELECT settings FROM workspaces WHERE id = ${args.workspaceId}::uuid LIMIT 1`))[0]?.settings ?? {};
  const policy = readDamagePolicy(settings);

  // Deposit forfeit percent (of the order's held deposit) for the approval check.
  const depositRequired = Number((await query<{ d: number }>(sql`SELECT COALESCE(deposit_required_paise,0)::bigint AS d FROM orders WHERE id = ${args.orderId}::uuid AND workspace_id = ${args.workspaceId}::uuid`))[0]?.d ?? 0);
  const forfeitPct = depositRequired > 0 ? (Number(args.depositForfeitAmountPaise ?? 0) / depositRequired) * 100 : 0;

  const approval = evaluateDamageApproval(policy, {
    severity: incident.severity, estimatedCostPaise: incident.estimated_cost_paise, finalCostPaise: args.finalCostPaise,
    insuranceEligible: args.insuranceEligible ?? false, customerDisputed: args.customerDisputed ?? false, depositForfeitPercent: forfeitPct,
  });
  const newStatus = approval.requires ? 'resolution_proposed' : 'financial_settled';

  await sql`
    UPDATE damage_incidents SET customer_liability = ${args.customerLiability}::text, liability_percent = ${args.liabilityPercent ?? null}::int,
      final_cost_paise = ${args.finalCostPaise ?? null}::bigint, financial_resolution = ${args.financialResolution}::text,
      financial_resolved_at = now(), financial_resolved_by = ${args.actorUserId}::uuid, deposit_action = ${args.depositAction}::text,
      deposit_forfeit_amount_paise = ${args.depositForfeitAmountPaise ?? 0}::bigint, insurance_eligible = ${args.insuranceEligible ?? null}::boolean,
      customer_disputed = ${args.customerDisputed ?? false}::boolean, requires_approval = ${approval.requires}::boolean,
      status = ${newStatus}::text, updated_at = now()
    WHERE id = ${args.damageIncidentId}::uuid AND workspace_id = ${args.workspaceId}::uuid
  `;
  await addDamageEvent({ workspaceId: args.workspaceId, damageIncidentId: args.damageIncidentId, eventType: 'financial_resolution_proposed', actorType: 'user', actorId: args.actorUserId, actorName: args.actorName, title: 'Financial resolution', body: `${args.financialResolution} · liability ${args.customerLiability}`, data: { deposit_action: args.depositAction, final_cost_paise: args.finalCostPaise ?? null, requires_approval: approval.requires } });
  await audit({ workspaceId: args.workspaceId, actorUserId: args.actorUserId, eventType: 'damage_incidents.financial_resolution', targetType: 'damage_incident', targetId: args.damageIncidentId, payload: { order_id: args.orderId, incident_number: incident.incident_number, financial_resolution: args.financialResolution, customer_liability: args.customerLiability, deposit_action: args.depositAction, requires_approval: approval.requires }, ipAddress: args.ip ?? null, userAgent: args.userAgent ?? null });

  const resolutionSummary = `${args.financialResolution} (liability: ${args.customerLiability}).`;
  if (approval.requires) {
    try {
      await emitNotification({
        workspaceId: args.workspaceId, actorUserId: args.actorUserId, eventType: 'damage_incident_pending_approval',
        targetType: 'order', targetId: args.orderId, linkUrl: `/order-360.html?id=${args.orderId}`,
        metadata: { order_number: orderCtx?.order_number ?? '', incident_number: incident.incident_number, resolution_summary: resolutionSummary, actor_name: args.actorName },
      });
    } catch { /* fail-open */ }
  }
  if (orderCtx && policy.customer_notification_default) {
    try {
      await emitCustomerNotification({
        workspaceId: args.workspaceId, orderId: args.orderId, personId: orderCtx.customer_person_id, eventType: 'damage_incident_financial_resolution_proposed',
        message: `We've proposed a resolution for damage ${incident.incident_number} on your order #${orderCtx.order_number}.`,
        channels: ['whatsapp', 'email'], contact: { phone: orderCtx.customer_phone, email: orderCtx.customer_email }, settings,
        variables: { customer_name: orderCtx.customer_name ?? 'there', incident_number: incident.incident_number, order_number: orderCtx.order_number, resolution_summary: resolutionSummary, amount: inr(Number(args.finalCostPaise ?? 0)) },
      });
    } catch { /* fail-open */ }
  }
  return { ok: true, requires_approval: approval.requires };
}

export async function approveDamageIncident(args: { workspaceId: string; orderId: string; damageIncidentId: string; actorUserId: string; actorName: string; ip?: string | null; userAgent?: string | null }): Promise<{ ok: boolean; error?: string }> {
  const inc = (await query<{ status: string; incident_number: string }>(sql`SELECT status, incident_number FROM damage_incidents WHERE id = ${args.damageIncidentId}::uuid AND workspace_id = ${args.workspaceId}::uuid LIMIT 1`))[0];
  if (!inc) return { ok: false, error: 'not_found' };
  if (!inc.status || !['resolution_proposed', 'reported', 'investigating'].includes(inc.status)) return { ok: false, error: 'not_approvable' };
  await sql`UPDATE damage_incidents SET approved_by = ${args.actorUserId}::uuid, approved_at = now(), requires_approval = false, status = 'financial_settled', updated_at = now() WHERE id = ${args.damageIncidentId}::uuid AND workspace_id = ${args.workspaceId}::uuid`;
  await addDamageEvent({ workspaceId: args.workspaceId, damageIncidentId: args.damageIncidentId, eventType: 'approved', actorType: 'user', actorId: args.actorUserId, actorName: args.actorName, title: 'Resolution approved' });
  await audit({ workspaceId: args.workspaceId, actorUserId: args.actorUserId, eventType: 'damage_incidents.approved', targetType: 'damage_incident', targetId: args.damageIncidentId, payload: { order_id: args.orderId, incident_number: inc.incident_number }, ipAddress: args.ip ?? null, userAgent: args.userAgent ?? null });
  return { ok: true };
}

export async function rejectDamageIncident(args: { workspaceId: string; orderId: string; damageIncidentId: string; actorUserId: string; actorName: string; reason?: string | null; ip?: string | null; userAgent?: string | null }): Promise<{ ok: boolean; error?: string }> {
  const inc = (await query<{ status: string; incident_number: string }>(sql`SELECT status, incident_number FROM damage_incidents WHERE id = ${args.damageIncidentId}::uuid AND workspace_id = ${args.workspaceId}::uuid LIMIT 1`))[0];
  if (!inc) return { ok: false, error: 'not_found' };
  await sql`UPDATE damage_incidents SET requires_approval = false, status = 'investigating', updated_at = now() WHERE id = ${args.damageIncidentId}::uuid AND workspace_id = ${args.workspaceId}::uuid`;
  await addDamageEvent({ workspaceId: args.workspaceId, damageIncidentId: args.damageIncidentId, eventType: 'rejected', actorType: 'user', actorId: args.actorUserId, actorName: args.actorName, title: 'Resolution rejected', body: args.reason ?? null });
  await audit({ workspaceId: args.workspaceId, actorUserId: args.actorUserId, eventType: 'damage_incidents.rejected', targetType: 'damage_incident', targetId: args.damageIncidentId, payload: { order_id: args.orderId, incident_number: inc.incident_number, reason: args.reason ?? null }, ipAddress: args.ip ?? null, userAgent: args.userAgent ?? null });
  return { ok: true };
}

export async function closeDamageIncident(args: { workspaceId: string; orderId: string; damageIncidentId: string; actorUserId: string; actorName: string; ip?: string | null; userAgent?: string | null }): Promise<{ ok: boolean; error?: string }> {
  const inc = (await query<{ status: string; incident_number: string; requires_approval: boolean; customer_person_id: string | null }>(sql`
    SELECT di.status, di.incident_number, di.requires_approval, o.customer_person_id
    FROM damage_incidents di JOIN orders o ON o.id = di.order_id
    WHERE di.id = ${args.damageIncidentId}::uuid AND di.workspace_id = ${args.workspaceId}::uuid LIMIT 1`))[0];
  if (!inc) return { ok: false, error: 'not_found' };
  if (inc.status === 'closed') return { ok: false, error: 'already_closed' };
  if (inc.requires_approval) return { ok: false, error: 'approval_required_before_close' };
  await sql`UPDATE damage_incidents SET status = 'closed', updated_at = now() WHERE id = ${args.damageIncidentId}::uuid AND workspace_id = ${args.workspaceId}::uuid`;
  await addDamageEvent({ workspaceId: args.workspaceId, damageIncidentId: args.damageIncidentId, eventType: 'closed', actorType: 'user', actorId: args.actorUserId, actorName: args.actorName, title: 'Incident closed' });
  await sql`INSERT INTO order_events (workspace_id, order_id, event_type, payload, actor_user_id) VALUES (${args.workspaceId}::uuid, ${args.orderId}::uuid, 'order.damage.closed', ${JSON.stringify({ damage_incident_id: args.damageIncidentId, incident_number: inc.incident_number })}::jsonb, ${args.actorUserId}::uuid)`;
  await audit({ workspaceId: args.workspaceId, actorUserId: args.actorUserId, eventType: 'damage_incidents.closed', targetType: 'damage_incident', targetId: args.damageIncidentId, payload: { order_id: args.orderId, incident_number: inc.incident_number }, ipAddress: args.ip ?? null, userAgent: args.userAgent ?? null });

  const orderCtx = await loadOrderContext(args.workspaceId, args.orderId);
  const settings = (await query<{ settings: Record<string, any> | null }>(sql`SELECT settings FROM workspaces WHERE id = ${args.workspaceId}::uuid LIMIT 1`))[0]?.settings ?? {};
  if (orderCtx && readDamagePolicy(settings).customer_notification_default) {
    try {
      await emitCustomerNotification({
        workspaceId: args.workspaceId, orderId: args.orderId, personId: orderCtx.customer_person_id, eventType: 'damage_incident_closed',
        message: `Damage report ${inc.incident_number} on your order #${orderCtx.order_number} is now closed.`,
        channels: ['whatsapp', 'email'], contact: { phone: orderCtx.customer_phone, email: orderCtx.customer_email }, settings,
        variables: { customer_name: orderCtx.customer_name ?? 'there', incident_number: inc.incident_number, order_number: orderCtx.order_number },
      });
    } catch { /* fail-open */ }
  }
  return { ok: true };
}

/** Full incident detail (incident + affected assets + linked substitution). */
export async function loadDamageIncident(workspaceId: string, incidentId: string): Promise<any | null> {
  const incident = (await query<any>(sql`SELECT * FROM damage_incidents WHERE id = ${incidentId}::uuid AND workspace_id = ${workspaceId}::uuid LIMIT 1`))[0];
  if (!incident) return null;
  const assets = await query<any>(sql`SELECT * FROM damage_incident_assets WHERE damage_incident_id = ${incidentId}::uuid AND workspace_id = ${workspaceId}::uuid ORDER BY created_at ASC`);
  return { ...incident, affected_assets: assets };
}

export async function loadDamageTimeline(workspaceId: string, incidentId: string): Promise<any[]> {
  return await query<any>(sql`SELECT id, event_type, actor_type, actor_id, actor_name, title, body, data, created_at FROM damage_incident_events WHERE damage_incident_id = ${incidentId}::uuid AND workspace_id = ${workspaceId}::uuid ORDER BY created_at DESC`);
}
