// ============================================================================
// src/lib/payment_commit.ts (Slice 7 Session 1) — the Money Engine's canonical
// commit-and-reconcile routine + the money primitives it stands on.
// ----------------------------------------------------------------------------
// Constitution Appendix A: Slice 7 graduates the payment primitives
// (recompute / applyDepositStatus) into ONE shared commit-and-reconcile routine
// that BOTH payment recording AND refunds call, so the revenue chain
// (payment -> zero balance -> invoice paid) closes in one place instead of two.
//
// The primitives below (loadOrderLite, netReceivedPaise, recomputeOrderPayments,
// computeDepositStatus, applyDepositStatus) were MOVED here verbatim from
// src/routes/payments.ts so a lib helper can reuse them without a route->lib->
// route import cycle (orders.ts also imports applyDepositStatus from here now).
//
// The route keeps the payment INSERT (deposit-number minting, cheque/custody
// metadata, the forfeit order-line) and its own audit + notification — those are
// per-op and validated in the handler. This helper owns the shared TAIL:
//   recompute order paid/balance  ->  (deposit? refresh deposit_status)
//   ->  reconcile the latest invoice against the new balance.
// ============================================================================

import { sql, query } from '../db.js';
import { audit } from './audit.js';
import { reconcileInvoiceForOrder, type ReconcileResult } from './invoice_reconcile.js';

// ----------------------------------------------------------------------------
// Types
// ----------------------------------------------------------------------------
export type OrderLite = {
  id: string;
  order_number: number;
  status: string;
  total_paise: number;
  paid_paise: number;
  balance_paise: number;
  deposit_required_paise: number;
  deposit_status: string;
  deleted_at: string | null;
};

// ----------------------------------------------------------------------------
// Money primitives (moved verbatim from routes/payments.ts)
// ----------------------------------------------------------------------------
export async function loadOrderLite(orderId: string, workspaceId: string): Promise<OrderLite | null> {
  const rows = await query<OrderLite>(sql`
    SELECT id, order_number, status::text AS status,
           total_paise, paid_paise, balance_paise,
           deposit_required_paise, deposit_status, deleted_at
    FROM orders
    WHERE id = ${orderId}::uuid
      AND workspace_id = ${workspaceId}::uuid
    LIMIT 1
  `);
  const o = rows[0];
  if (!o || o.deleted_at) return null;
  return o;
}

// RENTAL payments only — deposits (deposit / deposit_refund / deposit_forfeit)
// are refundable holdings, not sales, so they never touch the order's
// paid_paise / balance_paise.
export async function netReceivedPaise(orderId: string, workspaceId: string): Promise<number> {
  const rows = await query<{ net: number }>(sql`
    SELECT COALESCE(SUM(
      CASE WHEN direction = 'in' THEN amount_paise ELSE -amount_paise END
    ), 0)::bigint AS net
    FROM payments
    WHERE order_id = ${orderId}::uuid
      AND workspace_id = ${workspaceId}::uuid
      AND status = 'completed'
      AND payment_kind = 'rental'
  `);
  return Number(rows[0]?.net ?? 0);
}

// deposit_status is denormalised on orders and recomputed from the deposit-kind
// payments after every deposit write/delete. No soft-delete on payments (hard
// DELETE within the correction window), so we sum live rows only.
const DEPOSIT_KINDS = ['deposit', 'deposit_refund', 'deposit_forfeit'] as const;

export async function computeDepositStatus(
  orderId: string,
  workspaceId: string,
  requiredPaise: number,
): Promise<string> {
  if (Number(requiredPaise) === 0) return 'none';

  const rows = await query<{ payment_kind: string; amount_paise: number }>(sql`
    SELECT payment_kind, amount_paise
    FROM payments
    WHERE order_id = ${orderId}::uuid
      AND workspace_id = ${workspaceId}::uuid
      AND status = 'completed'
      AND payment_kind = ANY(string_to_array(${DEPOSIT_KINDS.join(',')}::text, ','))
  `);

  const sumOf = (kind: string) =>
    rows.filter((r) => r.payment_kind === kind).reduce((s, r) => s + Number(r.amount_paise), 0);
  const held = sumOf('deposit');
  const refunded = sumOf('deposit_refund');
  const forfeited = sumOf('deposit_forfeit');
  const netHeld = held - refunded - forfeited;

  if (held === 0) return 'pending';
  if (netHeld > 0) return 'held';
  if (forfeited > 0 && refunded > 0) return 'partial_forfeited';
  if (forfeited >= held) return 'fully_forfeited';
  if (refunded > 0) return 'released';
  return 'held';
}

// Recompute + persist deposit_status; audit on change. Returns { old, new }.
// Reused by the deposit-amount PATCH in orders.ts and by the payment routes.
export async function applyDepositStatus(args: {
  workspaceId: string;
  orderId: string;
  actorUserId: string;
  ipAddress: string | null;
  userAgent: string | null;
}): Promise<{ old: string; new: string } | null> {
  const order = await loadOrderLite(args.orderId, args.workspaceId);
  if (!order) return null;
  const oldStatus = order.deposit_status;
  const newStatus = await computeDepositStatus(
    args.orderId,
    args.workspaceId,
    Number(order.deposit_required_paise),
  );
  if (newStatus === oldStatus) return { old: oldStatus, new: newStatus };

  await sql`
    UPDATE orders SET deposit_status = ${newStatus}::text, updated_at = now()
    WHERE id = ${args.orderId}::uuid AND workspace_id = ${args.workspaceId}::uuid
  `;
  await audit({
    workspaceId: args.workspaceId,
    actorUserId: args.actorUserId,
    eventType: 'orders.deposit_status.changed',
    targetType: 'order',
    targetId: args.orderId,
    payload: { old: oldStatus, new: newStatus },
    ipAddress: args.ipAddress,
    userAgent: args.userAgent,
  });
  return { old: oldStatus, new: newStatus };
}

// Refresh paid_paise / balance_paise on the order from SUM(payments). Writes an
// order_events row (only) on change — never audit_events, matching the pricing
// auto-recompute convention.
export async function recomputeOrderPayments(
  orderId: string,
  workspaceId: string,
  actorUserId: string,
): Promise<{ paid_paise: number; balance_paise: number; changed: boolean }> {
  const order = await loadOrderLite(orderId, workspaceId);
  if (!order) throw new Error('not_found');

  const net = await netReceivedPaise(orderId, workspaceId);
  const paidPaise = net;
  const balancePaise = Number(order.total_paise) - paidPaise;

  const oldPaid = Number(order.paid_paise);
  const oldBalance = Number(order.balance_paise);
  const changed = oldPaid !== paidPaise || oldBalance !== balancePaise;

  if (changed) {
    await sql`
      UPDATE orders SET
        paid_paise    = ${paidPaise}::bigint,
        balance_paise = ${balancePaise}::bigint,
        updated_at    = now()
      WHERE id = ${orderId}::uuid
        AND workspace_id = ${workspaceId}::uuid
    `;

    const payload: Record<string, unknown> = {
      old: { paid_paise: oldPaid, balance_paise: oldBalance },
      new: { paid_paise: paidPaise, balance_paise: balancePaise },
    };
    await sql`
      INSERT INTO order_events
        (workspace_id, order_id, event_type, from_status, to_status, payload, actor_user_id)
      VALUES (
        ${workspaceId}::uuid,
        ${orderId}::uuid,
        'order.payments.recomputed',
        ${order.status}::order_status,
        ${order.status}::order_status,
        ${JSON.stringify(payload)}::jsonb,
        ${actorUserId}::uuid
      )
    `;
  }

  return { paid_paise: paidPaise, balance_paise: balancePaise, changed };
}

// ----------------------------------------------------------------------------
// The shared commit-and-reconcile TAIL (Slice 7).
// ----------------------------------------------------------------------------
export type CommitResult = {
  order: { paid_paise: number; balance_paise: number };
  changed: boolean;
  deposit_status: { old: string; new: string } | null;
  invoice_reconcile: ReconcileResult;
};

/**
 * Run the shared post-insert money commit for a payment/refund/deposit write:
 *   1. recompute the order's paid_paise / balance_paise from SUM(payments)
 *   2. if this write was a deposit-kind row, refresh deposit_status
 *   3. reconcile the latest invoice against the new balance (auto sent<->paid)
 *
 * Called by BOTH the record and refund routes AFTER their own INSERT + audit +
 * notification. Reconciliation is fail-open: an invoice reconcile error is
 * logged and reported, never rolls back the payment.
 */
export async function commitPaymentAndReconcile(args: {
  workspaceId: string;
  orderId: string;
  actorUserId: string;
  isDeposit: boolean;
  ipAddress?: string | null;
  userAgent?: string | null;
}): Promise<CommitResult> {
  const { workspaceId, orderId, actorUserId, isDeposit } = args;
  const ipAddress = args.ipAddress ?? null;
  const userAgent = args.userAgent ?? null;

  const rc = await recomputeOrderPayments(orderId, workspaceId, actorUserId);

  let depositStatus: { old: string; new: string } | null = null;
  if (isDeposit) {
    depositStatus = await applyDepositStatus({ workspaceId, orderId, actorUserId, ipAddress, userAgent });
  }

  let invoiceReconcile: ReconcileResult;
  try {
    invoiceReconcile = await reconcileInvoiceForOrder({ workspaceId, orderId, actorUserId, ipAddress, userAgent });
  } catch (e) {
    console.error('[payment_commit] invoice reconcile failed', e);
    invoiceReconcile = { reconciled: false, action: null, invoice_id: null, invoice_number: null, from: null, to: null, reason: 'reconcile_error' };
  }

  return {
    order: { paid_paise: rc.paid_paise, balance_paise: rc.balance_paise },
    changed: rc.changed,
    deposit_status: depositStatus,
    invoice_reconcile: invoiceReconcile,
  };
}
