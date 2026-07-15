// ============================================================================
// src/lib/order_actions.ts (Sub-slice 2.1) — shared extension/cancellation effects
// ----------------------------------------------------------------------------
// The effects of applying an extension or a cancellation are needed in TWO
// places: the direct endpoint (no approval required) and the approval-decide
// endpoint (approved). Factoring them here keeps the two paths byte-identical
// and avoids a circular import between orders.ts and approvals.ts.
//
// Both are fail-open on their notification / invoice side effects — a revision
// or send error never leaves the order half-applied.
// ============================================================================

import { sql, query } from '../db.js';
import { audit } from './audit.js';
import { recomputeOrderTotals } from './pricing.js';
import { generateInvoice } from '../routes/invoices.js';
import { emitNotification, emitCustomerNotification } from './notify.js';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

type Ctx = { ipAddress: string | null; userAgent: string | null };

type OrderLite = {
  id: string; order_number: number; status: string;
  customer_person_id: string; rental_start: string | null; rental_end: string | null;
  total_paise: number; balance_paise: number;
  customer_name: string | null; customer_phone: string | null; customer_email: string | null;
};

async function loadOrderLite(orderId: string, workspaceId: string): Promise<OrderLite | null> {
  const rows = await query<OrderLite>(sql`
    SELECT o.id, o.order_number, o.status::text AS status, o.customer_person_id,
           o.rental_start, o.rental_end, o.total_paise, o.balance_paise,
           p.display_name AS customer_name, p.phone AS customer_phone, p.email AS customer_email
    FROM orders o JOIN people p ON p.id = o.customer_person_id
    WHERE o.id = ${orderId}::uuid AND o.workspace_id = ${workspaceId}::uuid AND o.deleted_at IS NULL
    LIMIT 1
  `);
  return rows[0] ?? null;
}

async function recordOrderEvent(input: {
  workspaceId: string; orderId: string; eventType: string;
  fromStatus?: string | null; toStatus?: string | null;
  payload?: Record<string, unknown>; actorUserId: string;
}): Promise<string | null> {
  const rows = await query<{ id: string }>(sql`
    INSERT INTO order_events (workspace_id, order_id, event_type, from_status, to_status, payload, actor_user_id)
    VALUES (${input.workspaceId}::uuid, ${input.orderId}::uuid, ${input.eventType}::text,
            ${input.fromStatus ?? null}::order_status, ${input.toStatus ?? null}::order_status,
            ${JSON.stringify(input.payload ?? {})}::jsonb, ${input.actorUserId}::uuid)
    RETURNING id
  `);
  return rows[0]?.id ?? null;
}

function inr(paise: number): string {
  return '₹' + new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(Number(paise) / 100));
}
function fmtDate(iso: string | null): string {
  if (!iso) return '—';
  const t = new Date(iso);
  if (isNaN(t.getTime())) return '—';
  return t.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'Asia/Kolkata' });
}

// ----------------------------------------------------------------------------
// applyExtensionEffects — move rental_end, reprice, revise invoice, emit. Reads
// everything from the persisted order_extensions row so both call sites match.
// Marks the extension row approved + effective. Returns a summary for the caller.
// ----------------------------------------------------------------------------
export async function applyExtensionEffects(args: {
  workspaceId: string; orderId: string; actorUserId: string; extensionId: string;
  approvedByUserId?: string | null; ctx: Ctx;
}): Promise<{
  ok: boolean; delta_days: number; delta_paise: number; new_total_paise: number;
  new_rental_end: string | null;
  invoice_revision: { revised: boolean; new_invoice_id: string | null; new_revision_number: number | null };
}> {
  const ext = (await query<{
    new_rental_end_at: string; original_rental_end_at: string; additional_days: number;
    reason_notes: string | null;
  }>(sql`
    SELECT new_rental_end_at, original_rental_end_at, additional_days, reason_notes
    FROM order_extensions WHERE id = ${args.extensionId}::uuid AND workspace_id = ${args.workspaceId}::uuid LIMIT 1
  `))[0];
  const order = await loadOrderLite(args.orderId, args.workspaceId);
  const invoice_revision = { revised: false, new_invoice_id: null as string | null, new_revision_number: null as number | null };
  if (!ext || !order) return { ok: false, delta_days: 0, delta_paise: 0, new_total_paise: 0, new_rental_end: null, invoice_revision };

  const oldTotal = Number(order.total_paise);
  const newEnd = new Date(ext.new_rental_end_at);

  await sql`
    UPDATE orders SET rental_end = ${newEnd.toISOString()}::timestamptz, updated_at = now()
    WHERE id = ${args.orderId}::uuid AND workspace_id = ${args.workspaceId}::uuid
  `;

  try {
    await recomputeOrderTotals(args.orderId, args.workspaceId, args.actorUserId);
  } catch (err) { console.error('recompute after extension failed', err); }

  const fresh = (await loadOrderLite(args.orderId, args.workspaceId)) ?? order;
  const newTotal = Number(fresh.total_paise);
  const deltaPaise = newTotal - oldTotal;

  // Invoice revision (Booqable): revise an existing invoice on a running order.
  try {
    const existingInv = (await query<{ n: number; seq: number | null }>(sql`
      SELECT COUNT(*)::int AS n, MIN(sequence)::int AS seq FROM invoices
      WHERE order_id = ${args.orderId}::uuid AND workspace_id = ${args.workspaceId}::uuid
    `))[0];
    if ((existingInv?.n ?? 0) > 0 && fresh.status !== 'closed') {
      const gen = await generateInvoice({
        workspaceId: args.workspaceId, userId: args.actorUserId, orderId: args.orderId,
        sequence: Number(existingInv?.seq ?? 1),
        notes: ext.reason_notes ? `Extension: ${ext.reason_notes}` : 'Auto-revision on rental extension',
        ipAddress: args.ctx.ipAddress, userAgent: args.ctx.userAgent, bypassReadiness: true,
      });
      if (gen.ok) {
        invoice_revision.revised = true;
        invoice_revision.new_invoice_id = gen.invoice.id as string;
        invoice_revision.new_revision_number = gen.revision;
      }
    }
  } catch (err) { console.error('invoice revision on extension failed', err); }

  await sql`
    UPDATE order_extensions SET
      status = 'approved', approved_at = now(), effective_at = now(),
      additional_charges_paise = ${deltaPaise > 0 ? deltaPaise : 0}::bigint,
      approved_by_user_id = ${args.approvedByUserId ?? null}::uuid,
      customer_notified_at = now(), updated_at = now()
    WHERE id = ${args.extensionId}::uuid AND workspace_id = ${args.workspaceId}::uuid
  `;

  const payload = {
    old_rental_end: ext.original_rental_end_at, new_rental_end: newEnd.toISOString(),
    delta_days: ext.additional_days, delta_paise: deltaPaise, reason: ext.reason_notes ?? null,
    invoice_revised: invoice_revision.revised, new_invoice_id: invoice_revision.new_invoice_id,
    new_revision_number: invoice_revision.new_revision_number, extension_id: args.extensionId,
  };
  await recordOrderEvent({
    workspaceId: args.workspaceId, orderId: args.orderId, eventType: 'order.extended',
    fromStatus: order.status as any, toStatus: order.status as any, payload, actorUserId: args.actorUserId,
  });
  await audit({
    workspaceId: args.workspaceId, actorUserId: args.actorUserId, eventType: 'orders.extended',
    targetType: 'order', targetId: args.orderId, payload,
    ipAddress: args.ctx.ipAddress, userAgent: args.ctx.userAgent,
  });

  emitNotification({
    workspaceId: args.workspaceId, actorUserId: args.actorUserId, eventType: 'order.extended',
    targetType: 'order', targetId: args.orderId, linkUrl: `/order-360.html?id=${args.orderId}`,
    metadata: { order_number: order.order_number, delta_days: ext.additional_days, customer_name: order.customer_name ?? '', actor_name: '' },
  }).catch(() => {});

  emitCustomerNotification({
    workspaceId: args.workspaceId, orderId: args.orderId, personId: order.customer_person_id,
    eventType: 'extension_confirmed',
    message: `Hi ${order.customer_name ?? 'there'}, your order #${order.order_number} has been extended to ${fmtDate(newEnd.toISOString())}. `
      + (deltaPaise > 0 ? `Additional charges: ${inr(deltaPaise)}. ` : '') + 'Thank you.',
    channels: ['whatsapp', 'email'],
    contact: { phone: order.customer_phone, email: order.customer_email },
    variables: {
      customer_name: order.customer_name ?? 'there', order_number: order.order_number,
      new_end_date: fmtDate(newEnd.toISOString()), additional_charges: deltaPaise > 0 ? inr(deltaPaise) : inr(0),
    },
  }).catch(() => {});

  return {
    ok: true, delta_days: ext.additional_days, delta_paise: deltaPaise, new_total_paise: newTotal,
    new_rental_end: newEnd.toISOString(), invoice_revision,
  };
}

// ----------------------------------------------------------------------------
// applyCancellationEffects — flip the order to cancelled (which alone releases
// availability: a cancelled order is outside RESERVING_STATUSES), record the
// financial resolution + refund tracking, emit. Deposit release/forfeit stays
// operator-driven (the deposit ledger is the source of truth — CLAUDE.md's
// "no auto-release" discipline). Reads the persisted order_cancellations row.
// ----------------------------------------------------------------------------
export async function applyCancellationEffects(args: {
  workspaceId: string; orderId: string; actorUserId: string; cancellationId: string;
  approvedByUserId?: string | null; settings: Record<string, any>; ctx: Ctx;
}): Promise<{ ok: boolean; status: string; refund_expected_credit_by: string | null }> {
  const cancel = (await query<{
    reason_tag: string; refund_amount_paise: number; forfeit_amount_paise: number;
    deposit_refunded_paise: number; deposit_forfeited_paise: number;
  }>(sql`
    SELECT reason_tag, refund_amount_paise, forfeit_amount_paise, deposit_refunded_paise, deposit_forfeited_paise
    FROM order_cancellations WHERE id = ${args.cancellationId}::uuid AND workspace_id = ${args.workspaceId}::uuid LIMIT 1
  `))[0];
  const order = await loadOrderLite(args.orderId, args.workspaceId);
  if (!cancel || !order) return { ok: false, status: 'rejected', refund_expected_credit_by: null };

  const fromStatus = order.status;
  await sql`
    UPDATE orders SET status = 'cancelled'::order_status, updated_at = now()
    WHERE id = ${args.orderId}::uuid AND workspace_id = ${args.workspaceId}::uuid
  `;

  // Refund tracking on the cancellation row.
  const cp = args.settings.cancellation_policy ?? {};
  const autoInit = cp.refund_processing?.auto_initiate_on_confirm !== false;
  const expectedDays = Number(cp.refund_processing?.expected_business_days ?? 7);
  const refundAmt = Number(cancel.refund_amount_paise);
  const willProcessRefund = autoInit && refundAmt > 0;
  const finalStatus = willProcessRefund ? 'refund_processing' : 'confirmed';
  // Compute timing in JS — the Neon HTTP driver can't nest sql fragments, so we
  // pass plain timestamptz params (or NULL) rather than a conditional now()/interval.
  const refundInitiatedAt = willProcessRefund ? new Date().toISOString() : null;
  const creditBy = willProcessRefund ? new Date(Date.now() + expectedDays * MS_PER_DAY).toISOString() : null;

  await sql`
    UPDATE order_cancellations SET
      status = ${finalStatus}::text, confirmed_at = now(),
      approved_by_user_id = ${args.approvedByUserId ?? null}::uuid,
      refund_initiated_at = ${refundInitiatedAt}::timestamptz,
      refund_expected_credit_by = ${creditBy}::timestamptz,
      updated_at = now()
    WHERE id = ${args.cancellationId}::uuid AND workspace_id = ${args.workspaceId}::uuid
  `;

  const payload = {
    reason_tag: cancel.reason_tag, from_status: fromStatus,
    refund_amount_paise: refundAmt, forfeit_amount_paise: Number(cancel.forfeit_amount_paise),
    deposit_refunded_paise: Number(cancel.deposit_refunded_paise),
    deposit_forfeited_paise: Number(cancel.deposit_forfeited_paise),
    cancellation_id: args.cancellationId, refund_expected_credit_by: creditBy,
  };
  // Timeline: a status change (drives the stepper) AND a dedicated cancellation event.
  await recordOrderEvent({
    workspaceId: args.workspaceId, orderId: args.orderId, eventType: 'order.status.changed',
    fromStatus: fromStatus as any, toStatus: 'cancelled', payload: { canonical: true, reason: cancel.reason_tag },
    actorUserId: args.actorUserId,
  });
  await recordOrderEvent({
    workspaceId: args.workspaceId, orderId: args.orderId, eventType: 'order.cancelled',
    fromStatus: fromStatus as any, toStatus: 'cancelled', payload, actorUserId: args.actorUserId,
  });
  await audit({
    workspaceId: args.workspaceId, actorUserId: args.actorUserId, eventType: 'orders.cancelled',
    targetType: 'order', targetId: args.orderId, payload,
    ipAddress: args.ctx.ipAddress, userAgent: args.ctx.userAgent,
  });

  emitNotification({
    workspaceId: args.workspaceId, actorUserId: args.actorUserId, eventType: 'order.cancelled',
    targetType: 'order', targetId: args.orderId, linkUrl: `/order-360.html?id=${args.orderId}`,
    metadata: { order_number: order.order_number, customer_name: order.customer_name ?? '', reason_tag: cancel.reason_tag },
  }).catch(() => {});

  const totalToCustomer = refundAmt + Number(cancel.deposit_refunded_paise);
  const refundTimeline = willProcessRefund ? ` within ${expectedDays} business days` : '';
  emitCustomerNotification({
    workspaceId: args.workspaceId, orderId: args.orderId, personId: order.customer_person_id,
    eventType: 'cancellation_confirmed',
    message: `Hi ${order.customer_name ?? 'there'}, your order #${order.order_number} has been cancelled. `
      + (totalToCustomer > 0
        ? `A refund of ${inr(totalToCustomer)} will be processed${refundTimeline}. `
        : '') + 'Sorry to see this order go.',
    channels: ['whatsapp', 'email'],
    contact: { phone: order.customer_phone, email: order.customer_email },
    settings: args.settings,
    variables: {
      customer_name: order.customer_name ?? 'there', order_number: order.order_number,
      refund_amount: inr(totalToCustomer), refund_timeline: refundTimeline,
    },
  }).catch(() => {});

  return { ok: true, status: finalStatus, refund_expected_credit_by: creditBy };
}
