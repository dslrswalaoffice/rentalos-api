// ============================================================================
// src/lib/invoice_reconcile.ts (Slice 7 Session 1) — invoice auto-reconciliation.
// ----------------------------------------------------------------------------
// The Money Engine's revenue-chain closer: a payment that drives the order
// balance to zero auto-transitions the LATEST issued invoice sent -> paid
// (Q5/Q6, policy-gated by invoice_policy.auto_mark_paid_on_zero_balance). The
// inverse also holds: a refund that reopens a positive balance reverts a
// previously auto-marked invoice paid -> sent, so the invoice status never
// lies about an order that is no longer fully paid.
//
// Reconciled to shipped reality: this reuses the SAME invoice status machine as
// the manual POST .../transitions handler (sent<->paid, paid_at stamping) — it
// does NOT invent a new column or state. It is called from commitPaymentAnd
// Reconcile after recomputeOrderPayments has refreshed orders.balance_paise, so
// it reads ground truth, never a stale cache.
//
// Fail-open by contract: the caller wraps this so a reconcile error never fails
// the underlying payment; internally each step is guarded too.
// ============================================================================

import { sql, query } from '../db.js';
import { audit } from './audit.js';
import { emitNotification } from './notify.js';

export type ReconcileAction = 'marked_paid' | 'reopened' | null;

export type ReconcileResult = {
  reconciled: boolean;
  action: ReconcileAction;
  invoice_id: string | null;
  invoice_number: string | null;
  from: string | null;
  to: string | null;
  reason?: string;
};

const NO_OP: ReconcileResult = {
  reconciled: false, action: null, invoice_id: null, invoice_number: null, from: null, to: null,
};

async function autoMarkEnabled(workspaceId: string): Promise<boolean> {
  const rows = await query<{ v: boolean | null }>(sql`
    SELECT (settings->'invoice_policy'->>'auto_mark_paid_on_zero_balance')::boolean AS v
    FROM workspaces WHERE id = ${workspaceId}::uuid LIMIT 1
  `);
  // Default true when the key is absent (matches the migration 061 default).
  return rows[0]?.v ?? true;
}

/**
 * Reconcile the latest issued invoice against the order's CURRENT cached balance.
 * Call AFTER recomputeOrderPayments so orders.balance_paise is fresh.
 *
 *   balance <= 0  &&  latest invoice is 'sent'  -> mark 'paid'   (marked_paid)
 *   balance  > 0  &&  latest invoice is 'paid'  -> revert 'sent' (reopened)
 *   otherwise -> no-op
 *
 * "Latest" = highest (sequence, revision) among non-cancelled invoices (Q6).
 */
export async function reconcileInvoiceForOrder(args: {
  workspaceId: string;
  orderId: string;
  actorUserId: string;
  ipAddress?: string | null;
  userAgent?: string | null;
}): Promise<ReconcileResult> {
  const { workspaceId, orderId, actorUserId } = args;
  const ipAddress = args.ipAddress ?? null;
  const userAgent = args.userAgent ?? null;

  if (!(await autoMarkEnabled(workspaceId))) return { ...NO_OP, reason: 'policy_disabled' };

  // Order's current balance (ground truth cache, just recomputed) + number.
  const orderRows = await query<{ balance_paise: number; order_number: number }>(sql`
    SELECT balance_paise, order_number FROM orders
    WHERE id = ${orderId}::uuid AND workspace_id = ${workspaceId}::uuid AND deleted_at IS NULL
    LIMIT 1
  `);
  const order = orderRows[0];
  if (!order) return { ...NO_OP, reason: 'order_not_found' };
  const fullyPaid = Number(order.balance_paise) <= 0;

  // Latest non-cancelled invoice for the order (the reconcile target).
  const invRows = await query<{ id: string; status: string; invoice_number: string }>(sql`
    SELECT id, status::text AS status, invoice_number FROM invoices
    WHERE order_id = ${orderId}::uuid AND workspace_id = ${workspaceId}::uuid
      AND status <> 'cancelled'::invoice_status
    ORDER BY sequence DESC, revision DESC
    LIMIT 1
  `);
  const inv = invRows[0];
  if (!inv) return { ...NO_OP, reason: 'no_invoice' };

  // Decide the transition. Only sent<->paid is auto-driven; draft/revised are
  // left alone (an un-issued invoice isn't a claim the customer has seen).
  let to: 'paid' | 'sent' | null = null;
  let action: ReconcileAction = null;
  if (fullyPaid && inv.status === 'sent') { to = 'paid'; action = 'marked_paid'; }
  else if (!fullyPaid && inv.status === 'paid') { to = 'sent'; action = 'reopened'; }
  if (!to) return { ...NO_OP, reason: 'no_transition' };

  const from = inv.status;
  const setPaid = to === 'paid';

  await sql`
    UPDATE invoices SET
      status  = ${to}::invoice_status,
      paid_at = CASE WHEN ${setPaid}::boolean THEN now() ELSE NULL END
    WHERE id = ${inv.id}::uuid AND workspace_id = ${workspaceId}::uuid
      AND status = ${from}::invoice_status
  `;

  // Order timeline event so the operator sees WHY the invoice flipped (auto,
  // not a manual click). Kept distinct from the manual status.changed event.
  await sql`
    INSERT INTO order_events (workspace_id, order_id, event_type, payload, actor_user_id)
    VALUES (${workspaceId}::uuid, ${orderId}::uuid,
      ${action === 'marked_paid' ? 'order.invoice.marked_paid' : 'order.invoice.reopened'}::text,
      ${JSON.stringify({ invoice_id: inv.id, invoice_number: inv.invoice_number, from, to, auto: true, balance_paise: Number(order.balance_paise) })}::jsonb,
      ${actorUserId}::uuid)
  `;

  await audit({
    workspaceId,
    actorUserId,
    eventType: action === 'marked_paid' ? 'orders.invoice.auto_marked_paid' : 'orders.invoice.auto_reopened',
    targetType: 'invoice',
    targetId: inv.id,
    payload: { order_id: orderId, invoice_id: inv.id, from, to, auto: true, balance_paise: Number(order.balance_paise) },
    ipAddress, userAgent,
  });

  // In-product notification to other members (fail-open) — only on the positive
  // paid transition; a refund reopen is already implied by the refund event.
  if (action === 'marked_paid') {
    emitNotification({
      workspaceId,
      actorUserId,
      eventType: 'invoice.marked_paid',
      targetType: 'invoice', targetId: inv.id,
      linkUrl: `/order.html?id=${orderId}`,
      metadata: { invoice_number: inv.invoice_number, order_number: order.order_number, auto: true },
    }).catch(() => {});
  }

  return { reconciled: true, action, invoice_id: inv.id, invoice_number: inv.invoice_number, from, to };
}
