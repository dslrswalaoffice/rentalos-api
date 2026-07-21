// ============================================================================
// src/routes/inspections.ts (Slice 5 Session 1) — return inspection lifecycle.
// ----------------------------------------------------------------------------
// Wires the DORMANT migration-055 inspection_events / inspection_line_items tables
// (reconcile, don't rebuild — Aamir-approved) with the scheduling lifecycle added
// in migration 059. Id-scoped router with its own session + auth + idempotency.
//
// The PHYSICAL disposition is the SHARED commitReturnToPhysicalState
// (src/lib/return_commit.ts) — the same helper the legacy batch return calls, now
// invoked at inspection time:
//   pass       -> release the inspection-hold + asset 'available' ('returned' outcome);
//                 flag the deposit as ready to release (055's triggers_deposit_release +
//                 related infra). Actual auto-refund is gated on the policy flag
//                 auto_release_deposit_on_inspection_pass (default false — the shipped
//                 "no auto-release" principle); otherwise a signal is emitted.
//   fail_minor -> item stays 'returned', hold KEPT (unit awaits owner review), flagged.
//   fail_major -> item 'returned_with_damage', asset 'available' + a repair downtime
//                 (supersedes the hold); triggers_damage_incident (full damage
//                 workflow deferred to the Damage slice).
// ============================================================================

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
import { audit, type AuditEventType } from '../lib/audit.js';
import { emitNotification } from '../lib/notify.js';
import { commitReturnToPhysicalState, releaseInspectionHolds } from '../lib/return_commit.js';

type SessionVar = { sessionId: string; user: SessionUser; workspace: SessionWorkspace } | null;
type Env = { Variables: { session: SessionVar } };

function clientCtx(c: Context) {
  const ipAddress = c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? c.req.header('x-real-ip') ?? null;
  return { ipAddress, userAgent: c.req.header('user-agent') ?? null };
}

export const INSPECTION_RESULTS = ['pass', 'fail_minor', 'fail_major'] as const;

export const completeSchema = z.object({
  result: z.enum(INSPECTION_RESULTS),
  notes: z.string().max(2000).nullish(),
});
export const scheduleSchema = z.object({
  scheduled_for: z.string().datetime().optional(),
  inspector_user_id: z.string().uuid().nullish(),
});

const err = (code: string, message: string, reasons: unknown[] = []) => ({ error: { code, message, reasons } });

type InspectionRow = { id: string; workspace_id: string; order_id: string; order_item_id: string | null; status: string | null; inspection_number: string };

async function loadInspection(workspaceId: string, id: string): Promise<InspectionRow | null> {
  const rows = await query<InspectionRow>(sql`
    SELECT id, workspace_id, order_id, order_item_id, status, inspection_number
    FROM inspection_events WHERE id = ${id}::uuid AND workspace_id = ${workspaceId}::uuid LIMIT 1
  `);
  return rows[0] ?? null;
}

async function recordInspectionEvent(args: {
  workspaceId: string; orderId: string; actorUserId: string;
  timelineType: string; auditType: AuditEventType; payload: Record<string, unknown>; ip: string | null; ua: string | null;
}): Promise<void> {
  await sql`
    INSERT INTO order_events (workspace_id, order_id, event_type, payload, actor_user_id)
    VALUES (${args.workspaceId}::uuid, ${args.orderId}::uuid, ${args.timelineType}::text, ${JSON.stringify(args.payload)}::jsonb, ${args.actorUserId}::uuid)
  `;
  await audit({
    workspaceId: args.workspaceId, actorUserId: args.actorUserId, eventType: args.auditType,
    targetType: 'inspection', targetId: String(args.payload.inspection_id ?? ''), payload: args.payload, ipAddress: args.ip, userAgent: args.ua,
  });
}

export const inspections = new Hono<Env>();
inspections.use('*', sessionMiddleware, requireAuth);
inspections.use('*', idempotencyMiddleware);

inspections.get('/:inspectionId', async (c) => {
  const session = c.get('session')!;
  const rows = await query<Record<string, unknown>>(sql`
    SELECT ie.id, ie.order_id, ie.order_item_id, ie.status, ie.result, ie.scheduled_for, ie.completed_at,
           ie.inspection_number, ie.result_notes, ie.inspector_user_id, u.display_name AS inspector_name,
           oi.description AS item_description
    FROM inspection_events ie
    LEFT JOIN users u ON u.id = ie.inspector_user_id
    LEFT JOIN order_items oi ON oi.id = ie.order_item_id
    WHERE ie.id = ${c.req.param('inspectionId')}::uuid AND ie.workspace_id = ${session.workspace.id}::uuid LIMIT 1
  `);
  if (!rows.length) return c.json(err('inspection_not_found', 'Inspection not found'), 404);
  return c.json({ inspection: rows[0] }, 200);
});

// POST /:inspectionId/start — inspector claims it.
inspections.post('/:inspectionId/start', requirePermission('inspections.perform'), async (c) => {
  const session = c.get('session')!;
  const workspaceId = session.workspace.id;
  const { ipAddress, userAgent } = clientCtx(c);
  const insp = await loadInspection(workspaceId, c.req.param('inspectionId'));
  if (!insp) return c.json(err('inspection_not_found', 'Inspection not found'), 404);
  if (insp.status && !['scheduled', 'in_progress'].includes(insp.status)) return c.json(err('already_completed', `Inspection is ${insp.status}`), 409);

  await sql`
    UPDATE inspection_events SET status = 'in_progress'::text, inspector_user_id = ${session.user.id}::uuid, updated_at = now()
    WHERE id = ${insp.id}::uuid AND workspace_id = ${workspaceId}::uuid
  `;
  await recordInspectionEvent({
    workspaceId, orderId: insp.order_id, actorUserId: session.user.id,
    timelineType: 'order.inspection.started', auditType: 'inspections.started',
    payload: { inspection_id: insp.id, inspection_number: insp.inspection_number, order_item_id: insp.order_item_id }, ip: ipAddress, ua: userAgent,
  });
  return c.json({ status: 'in_progress', inspection_id: insp.id }, 200);
});

// POST /:inspectionId/schedule — set scheduled_for + optional assignee.
inspections.post('/:inspectionId/schedule', requirePermission('inspections.perform'), async (c) => {
  const session = c.get('session')!;
  const workspaceId = session.workspace.id;
  const { ipAddress, userAgent } = clientCtx(c);
  const insp = await loadInspection(workspaceId, c.req.param('inspectionId'));
  if (!insp) return c.json(err('inspection_not_found', 'Inspection not found'), 404);
  let body: unknown = {};
  try { body = await c.req.json(); } catch { body = {}; }
  const parsed = scheduleSchema.safeParse(body);
  if (!parsed.success) return c.json(err('invalid_body', 'Invalid schedule payload', parsed.error.issues), 400);

  await sql`
    UPDATE inspection_events SET status = 'scheduled'::text,
      scheduled_for = COALESCE(${parsed.data.scheduled_for ?? null}::timestamptz, scheduled_for),
      inspector_user_id = COALESCE(${parsed.data.inspector_user_id ?? null}::uuid, inspector_user_id), updated_at = now()
    WHERE id = ${insp.id}::uuid AND workspace_id = ${workspaceId}::uuid
  `;
  await recordInspectionEvent({
    workspaceId, orderId: insp.order_id, actorUserId: session.user.id,
    timelineType: 'order.inspection.scheduled', auditType: 'inspections.scheduled',
    payload: { inspection_id: insp.id, inspection_number: insp.inspection_number, scheduled_for: parsed.data.scheduled_for ?? null }, ip: ipAddress, ua: userAgent,
  });
  return c.json({ status: 'scheduled', inspection_id: insp.id }, 200);
});

// POST /:inspectionId/complete — record outcome + run the shared disposition.
inspections.post('/:inspectionId/complete', requirePermission('inspections.perform'), async (c) => {
  const session = c.get('session')!;
  const workspaceId = session.workspace.id;
  const { ipAddress, userAgent } = clientCtx(c);
  const insp = await loadInspection(workspaceId, c.req.param('inspectionId'));
  if (!insp) return c.json(err('inspection_not_found', 'Inspection not found'), 404);
  if (insp.status && ['pass', 'fail_minor', 'fail_major', 'skipped'].includes(insp.status)) return c.json(err('already_completed', `Inspection is already ${insp.status}`), 409);
  if (!insp.order_item_id) return c.json(err('no_item', 'Inspection is not linked to an order item'), 409);

  let body: unknown = {};
  try { body = await c.req.json(); } catch { body = {}; }
  const parsed = completeSchema.safeParse(body);
  if (!parsed.success) return c.json(err('invalid_body', 'Invalid complete payload', parsed.error.issues), 400);
  const result = parsed.data.result;

  // Workspace repair-downtime default + policy.
  const wsRows = await query<{ settings: any }>(sql`SELECT settings FROM workspaces WHERE id = ${workspaceId}::uuid LIMIT 1`);
  const rawRepair = Number(wsRows[0]?.settings?.downtime?.default_repair_days);
  const repairDays = Number.isFinite(rawRepair) && rawRepair > 0 ? rawRepair : 7;
  const policy = wsRows[0]?.settings?.dispatch_return_policy ?? {};
  const orderNumberRow = await query<{ order_number: number }>(sql`SELECT order_number FROM orders WHERE id = ${insp.order_id}::uuid LIMIT 1`);
  const orderNumber = Number(orderNumberRow[0]?.order_number ?? 0);

  let dispositions: unknown[] = [];
  let depositReadyToRelease = false;
  let triggersDamage = false;

  if (result === 'pass') {
    // Rejoin availability: cancel the inspection-hold, then dispose the unit 'returned'.
    await releaseInspectionHolds({ workspaceId, orderId: insp.order_id, itemId: insp.order_item_id });
    dispositions = await commitReturnToPhysicalState({ workspaceId, orderId: insp.order_id, orderNumber, itemId: insp.order_item_id, outcome: 'returned', actorUserId: session.user.id, repairDays });
    depositReadyToRelease = true;
  } else if (result === 'fail_minor') {
    // Item stays 'returned'; the inspection-hold is KEPT (unit awaits owner review).
    // No asset disposition — flagged for owner attention via the event below.
  } else {
    // fail_major: supersede the hold with a repair downtime; item -> returned_with_damage.
    await releaseInspectionHolds({ workspaceId, orderId: insp.order_id, itemId: insp.order_item_id });
    dispositions = await commitReturnToPhysicalState({ workspaceId, orderId: insp.order_id, orderNumber, itemId: insp.order_item_id, outcome: 'returned_with_damage', actorUserId: session.user.id, repairDays });
    await sql`UPDATE order_items SET status = 'returned_with_damage'::order_item_status, updated_at = now() WHERE id = ${insp.order_item_id}::uuid AND workspace_id = ${workspaceId}::uuid`;
    triggersDamage = true;
  }

  // Record the outcome on the 055 inspection_events row (both `result` + `status`).
  await sql`
    UPDATE inspection_events SET
      status = ${result}::text, result = ${result}::text,
      inspected_by_user_id = ${session.user.id}::uuid, inspected_at = now(), completed_at = now(),
      result_notes = ${parsed.data.notes ?? null}::text,
      triggers_deposit_release = ${depositReadyToRelease}::boolean,
      triggers_damage_claim = ${triggersDamage}::boolean,
      triggers_maintenance = ${triggersDamage}::boolean,
      updated_at = now()
    WHERE id = ${insp.id}::uuid AND workspace_id = ${workspaceId}::uuid
  `;

  // Deposit: honor the shipped "no auto-release" principle. Only auto-record a
  // refund when the workspace opts in; otherwise emit a "ready to release" signal.
  let depositAction: string | null = null;
  if (depositReadyToRelease) {
    depositAction = policy.auto_release_deposit_on_inspection_pass === true ? 'auto_release_requested' : 'ready_to_release_signal';
    // Auto-refund is intentionally NOT performed here (financial action stays
    // operator-triggered per Sub-turn 6d). The flag + notification make it visible.
    emitNotification({
      workspaceId, actorUserId: session.user.id, eventType: 'order.status.changed',
      targetType: 'order', targetId: insp.order_id, linkUrl: `/order-360.html?id=${insp.order_id}`,
      metadata: { order_number: orderNumber, new_status: 'inspection_passed', old_status: 'awaiting_inspection', customer_name: '' },
    });
  }

  await recordInspectionEvent({
    workspaceId, orderId: insp.order_id, actorUserId: session.user.id,
    timelineType: result === 'pass' ? 'order.inspection.passed' : result === 'fail_minor' ? 'order.inspection.fail_minor' : 'order.inspection.fail_major',
    auditType: 'inspections.completed',
    payload: { inspection_id: insp.id, inspection_number: insp.inspection_number, order_item_id: insp.order_item_id, result, dispositions, deposit_action: depositAction, triggers_damage: triggersDamage, needs_owner_review: result === 'fail_minor' },
    ip: ipAddress, ua: userAgent,
  });

  return c.json({
    status: result, inspection_id: insp.id, result,
    dispositions, deposit_ready_to_release: depositReadyToRelease, deposit_action: depositAction,
    triggers_damage: triggersDamage, needs_owner_review: result === 'fail_minor',
  }, 200);
});
