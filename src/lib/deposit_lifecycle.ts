// ============================================================================
// src/lib/deposit_lifecycle.ts (Slice 7 Session 2) — deposit auto-release
// orchestration.
// ----------------------------------------------------------------------------
// The Money Engine's deposit-lifecycle consumer. When a return inspection PASSES
// and the workspace opts in (deposit_policy.auto_release_on_inspection_pass), we
// initiate the deposit refund automatically: a deposit_refund payment is created
// with status='pending' (Q2 — Accounts marks it 'completed' after settling the
// bank transfer out-of-band), and the customer is notified.
//
// DRY: this REUSES the shipped money primitives — the deposit_refund row is a
// normal payments write, run through commitPaymentAndReconcile so the deposit
// state / invoice reconcile invariants hold in one place. No new money math.
//
// A 'pending' deposit_refund does NOT change orders.deposit_status yet
// (computeDepositStatus sums 'completed' rows only), so the deposit reads 'held'
// until Accounts completes the payment — which is exactly the "release initiated
// -> awaiting settlement -> released" lifecycle.
//
// Fail-soft by contract: the caller (inspection complete) wraps this so an
// auto-release error never blocks inspection completion.
// ============================================================================

import { sql, query } from '../db.js';
import { audit } from './audit.js';
import { emitCustomerNotification, type CustomerChannel } from './notify.js';
import { commitPaymentAndReconcile } from './payment_commit.js';

export type AutoReleaseResult = {
  triggered: boolean;
  skipped_reason?: string;
  payment_id?: string;
  amount_paise?: number;
  notification_sent?: boolean;
};

type WsSettings = Record<string, any> | null;

// Net deposit still held = completed deposits - completed refunds - completed
// forfeits. Only a positive net is releasable.
async function netHeldDepositPaise(orderId: string, workspaceId: string): Promise<number> {
  const rows = await query<{ kind: string; s: number }>(sql`
    SELECT payment_kind AS kind, COALESCE(SUM(amount_paise), 0)::bigint AS s
    FROM payments
    WHERE order_id = ${orderId}::uuid AND workspace_id = ${workspaceId}::uuid
      AND status = 'completed'
      AND payment_kind IN ('deposit', 'deposit_refund', 'deposit_forfeit')
    GROUP BY payment_kind
  `);
  const sum = (k: string) => Number(rows.find((r) => r.kind === k)?.s ?? 0);
  return sum('deposit') - sum('deposit_refund') - sum('deposit_forfeit');
}

// Q1: deposit_policy is the source of truth; fall back to the legacy
// dispatch_return_policy key for one release cycle (deprecation window).
export function autoReleaseEnabled(settings: WsSettings): boolean {
  const dp = settings?.deposit_policy?.auto_release_on_inspection_pass;
  if (dp === true) return true;
  if (dp === false) return false;
  // new key absent -> legacy fallback
  return settings?.dispatch_return_policy?.auto_release_deposit_on_inspection_pass === true;
}

/**
 * Initiate an automatic deposit release after a passed inspection. Idempotent
 * per inspection: a second call for the same inspection_event_id is a no-op.
 * Returns a structured outcome; NEVER throws (the inspection flow is fail-soft).
 */
export async function triggerDepositAutoRelease(args: {
  workspaceId: string;
  orderId: string;
  inspectionEventId: string;
  actorUserId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}): Promise<AutoReleaseResult> {
  const { workspaceId, orderId, inspectionEventId, actorUserId } = args;
  const ipAddress = args.ipAddress ?? null;
  const userAgent = args.userAgent ?? null;
  try {
    const wsRows = await query<{ settings: WsSettings }>(sql`
      SELECT settings FROM workspaces WHERE id = ${workspaceId}::uuid LIMIT 1
    `);
    const settings = wsRows[0]?.settings ?? {};
    if (!autoReleaseEnabled(settings)) return { triggered: false, skipped_reason: 'policy_disabled' };

    const netHeld = await netHeldDepositPaise(orderId, workspaceId);
    if (netHeld <= 0) return { triggered: false, skipped_reason: 'no_held_deposit' };

    // Idempotency: one auto-release per inspection. The reference carries the
    // inspection id so a re-run of inspection-complete can't double-refund.
    const reference = `AUTO_RELEASE_${inspectionEventId}`;
    const existing = await query<{ id: string }>(sql`
      SELECT id FROM payments
      WHERE order_id = ${orderId}::uuid AND workspace_id = ${workspaceId}::uuid
        AND payment_kind = 'deposit_refund' AND reference = ${reference}::text
      LIMIT 1
    `);
    if (existing.length) return { triggered: false, skipped_reason: 'already_initiated', payment_id: existing[0]!.id };

    const method = String(settings?.deposit_policy?.auto_release_method ?? 'bank_transfer');
    const etaDays = Number(settings?.deposit_policy?.settlement_eta_days ?? 7);

    // A deposit_refund returns money (direction 'out'). status='pending' — the
    // deposit stays 'held' in the denormalised status until Accounts completes it.
    const inserted = await query<{ id: string }>(sql`
      INSERT INTO payments (
        workspace_id, order_id, amount_paise, direction, method, payment_kind,
        reference, status, notes, received_by, occurred_at
      ) VALUES (
        ${workspaceId}::uuid, ${orderId}::uuid, ${netHeld}::bigint,
        'out'::payment_direction, ${method}::payment_method, 'deposit_refund'::text,
        ${reference}::text, 'pending'::payment_status,
        'Auto-released after inspection pass. Awaiting settlement.'::text,
        ${actorUserId}::uuid, now()
      )
      RETURNING id
    `);
    const paymentId = inserted[0]!.id;

    // Reuse the shared commit (recompute + deposit-status + invoice reconcile).
    // A pending deposit_refund is a no-op for all three, but we keep the invariant
    // "every payment write goes through the commit" rather than special-casing.
    await commitPaymentAndReconcile({ workspaceId, orderId, actorUserId, isDeposit: true, ipAddress, userAgent });

    // Order timeline + audit (the two-row rule).
    const orderRow = await query<{ order_number: number; person_id: string | null; phone: string | null; email: string | null; name: string | null }>(sql`
      SELECT o.order_number, o.customer_person_id AS person_id, p.phone, p.email, p.display_name AS name
      FROM orders o LEFT JOIN people p ON p.id = o.customer_person_id
      WHERE o.id = ${orderId}::uuid AND o.workspace_id = ${workspaceId}::uuid LIMIT 1
    `);
    const orderNumber = orderRow[0]?.order_number ?? 0;

    await sql`
      INSERT INTO order_events (workspace_id, order_id, event_type, payload, actor_user_id)
      VALUES (${workspaceId}::uuid, ${orderId}::uuid, 'order.deposit.auto_release_initiated'::text,
        ${JSON.stringify({ payment_id: paymentId, inspection_event_id: inspectionEventId, amount_paise: netHeld, method, status: 'pending' })}::jsonb,
        ${actorUserId}::uuid)
    `;
    await audit({
      workspaceId, actorUserId, eventType: 'deposits.auto_release_initiated',
      targetType: 'payment', targetId: paymentId,
      payload: { order_id: orderId, inspection_event_id: inspectionEventId, amount_paise: netHeld, method, status: 'pending' },
      ipAddress, userAgent,
    });

    // Customer notification (fail-open). Rupees for display (paise/100).
    let notificationSent = false;
    const channels = ((settings?.dispatch_return_policy?.customer_notification_channels ?? ['whatsapp', 'email']) as string[])
      .filter((ch): ch is CustomerChannel => ch === 'whatsapp' || ch === 'email');
    const notify = await emitCustomerNotification({
      workspaceId, orderId, personId: orderRow[0]?.person_id ?? null,
      eventType: 'deposit_released',
      message: `Your deposit refund of Rs. ${(netHeld / 100).toLocaleString('en-IN')} for order #${orderNumber} has been initiated via ${method}. Expected settlement within ${etaDays} days.`,
      channels, contact: { phone: orderRow[0]?.phone ?? null, email: orderRow[0]?.email ?? null }, settings,
      variables: {
        order_number: orderNumber, customer_name: orderRow[0]?.name ?? '',
        deposit_amount: (netHeld / 100).toLocaleString('en-IN'),
        refund_method: method, settlement_eta_days: etaDays,
      },
    });
    notificationSent = notify.deliveries.some((d) => d.status === 'sent');

    return { triggered: true, payment_id: paymentId, amount_paise: netHeld, notification_sent: notificationSent };
  } catch (e) {
    console.error('[deposit_lifecycle] auto-release failed', e);
    return { triggered: false, skipped_reason: 'error' };
  }
}
