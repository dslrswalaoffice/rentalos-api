// ============================================================================
// src/lib/order_close.ts (Slice 6 Session 1) — the SHARED "close order" workflow.
// ----------------------------------------------------------------------------
// One place that transitions an order to 'closed' and runs the downstream
// invoice automation, called by BOTH close paths (Q1/Q11, Aamir-approved):
//   1. POST /api/inspections/:id/complete — auto-close when the LAST inspection
//      for the order passes and all items are terminal (policy-gated).
//   2. POST /api/orders/:id/transitions (to='closed') — the operator close.
//
// Reconciled to shipped reality: commitReturnToPhysicalState (Slice 5) is per-item
// and never closed orders, so the close+invoice automation lives HERE, at the
// order-workflow layer, not in that per-item helper.
//
// Idempotent: a re-entry on an already-closed order is a no-op (no double-emit,
// no duplicate invoice). Neon HTTP has no cross-statement transaction, so the
// steps run as a guarded sequence; each downstream step is fail-open (an invoice
// or delivery error is logged and reported, never rolls back the close).
// ============================================================================

import { sql, query } from '../db.js';
import { audit } from './audit.js';
import { generateInvoice } from '../routes/invoices.js';
import { generateAndStoreInvoicePdf } from './invoice_pdf.js';
import { deliverInvoice, type DeliveryChannel } from './invoice_deliver.js';

type InvoicePolicy = {
  auto_close_on_final_inspection_pass?: boolean;
  auto_generate_on_close?: boolean;
  auto_generate_pdf?: boolean;
  auto_send_on_issue?: boolean;
  send_channels_default?: string[];
};

export type CloseResult = {
  ok: boolean;
  order_status: string;
  already_closed: boolean;
  invoice_id: string | null;
  invoice_number: string | null;
  pdf_generated: boolean;
  issued: boolean;
  delivery: { any_sent: boolean; channels: unknown[] } | null;
  error?: string;
};

async function loadInvoicePolicy(workspaceId: string): Promise<InvoicePolicy> {
  const rows = await query<{ policy: InvoicePolicy | null }>(sql`
    SELECT settings->'invoice_policy' AS policy FROM workspaces WHERE id = ${workspaceId}::uuid LIMIT 1
  `);
  return rows[0]?.policy ?? {};
}

/**
 * Transition an order to 'closed' + run the policy-gated invoice automation.
 * `source` records which path closed it (inspection_complete | operator_close).
 */
export async function commitOrderToClosedState(args: {
  workspaceId: string;
  orderId: string;
  actorUserId: string;
  source: 'inspection_complete' | 'operator_close';
  ipAddress?: string | null;
  userAgent?: string | null;
}): Promise<CloseResult> {
  const { workspaceId, orderId, actorUserId, source } = args;
  const base: CloseResult = { ok: true, order_status: 'closed', already_closed: false, invoice_id: null, invoice_number: null, pdf_generated: false, issued: false, delivery: null };

  const orderRows = await query<{ status: string; order_number: number }>(sql`
    SELECT status::text AS status, order_number FROM orders WHERE id = ${orderId}::uuid AND workspace_id = ${workspaceId}::uuid LIMIT 1
  `);
  const order = orderRows[0];
  if (!order) return { ...base, ok: false, error: 'order_not_found' };
  if (order.status === 'cancelled') return { ...base, ok: false, order_status: 'cancelled', error: 'cannot_close_cancelled' };

  // Transition to closed ONLY if not already (the operator-close path transitions
  // + emits its own events before calling this — we must not double-emit). Either
  // way we fall through to the idempotent invoice automation below.
  if (order.status === 'closed') {
    base.already_closed = true;
  } else {
    const fromStatus = order.status;
    await sql`UPDATE orders SET status = 'closed'::order_status, updated_at = now() WHERE id = ${orderId}::uuid AND workspace_id = ${workspaceId}::uuid AND status <> 'closed'::order_status`;
    await sql`
      INSERT INTO order_events (workspace_id, order_id, event_type, from_status, to_status, payload, actor_user_id)
      VALUES (${workspaceId}::uuid, ${orderId}::uuid, 'order.status.changed'::text, ${fromStatus}::text, 'closed'::text, ${JSON.stringify({ source, auto: source === 'inspection_complete' })}::jsonb, ${actorUserId}::uuid)
    `;
    await audit({ workspaceId, actorUserId, eventType: 'orders.status.changed', targetType: 'order', targetId: orderId, payload: { from: fromStatus, to: 'closed', source }, ipAddress: args.ipAddress ?? null, userAgent: args.userAgent ?? null });
  }

  const policy = await loadInvoicePolicy(workspaceId);
  if (policy.auto_generate_on_close === false) return base;

  // Reuse any existing live (non-cancelled) invoice; else generate one. The order
  // is now 'closed', so generateInvoice's readiness gate passes.
  const existing = await query<{ id: string; invoice_number: string; status: string }>(sql`
    SELECT id, invoice_number, status::text AS status FROM invoices
    WHERE order_id = ${orderId}::uuid AND workspace_id = ${workspaceId}::uuid AND status <> 'cancelled'::invoice_status
    ORDER BY sequence DESC, revision DESC LIMIT 1
  `);
  let invoiceId: string | null = existing[0]?.id ?? null;
  let invoiceNumber: string | null = existing[0]?.invoice_number ?? null;
  let invoiceStatus: string | null = existing[0]?.status ?? null;

  if (!invoiceId) {
    try {
      const gen = await generateInvoice({ workspaceId, userId: actorUserId, orderId, sequence: 1, notes: null, ipAddress: args.ipAddress ?? null, userAgent: args.userAgent ?? null, bypassReadiness: false });
      if (gen.ok) { invoiceId = String((gen.invoice as { id: string }).id); invoiceNumber = gen.invoice_number; invoiceStatus = 'draft'; }
      else base.error = `invoice_gen:${gen.error}`;
    } catch (e) { console.error('[order_close] generateInvoice failed', e); base.error = 'invoice_gen_error'; }
  }
  if (!invoiceId) return base;
  base.invoice_id = invoiceId;
  base.invoice_number = invoiceNumber;

  // PDF (fail-open).
  if (policy.auto_generate_pdf !== false) {
    try { const r = await generateAndStoreInvoicePdf(workspaceId, invoiceId); base.pdf_generated = !('error' in r); }
    catch (e) { console.error('[order_close] pdf failed', e); }
  }

  // Issue + deliver (fail-open).
  if (policy.auto_send_on_issue !== false) {
    try {
      if (invoiceStatus === 'draft') {
        await sql`UPDATE invoices SET status = 'sent'::invoice_status, sent_at = now(), due_at = COALESCE(due_at, now()) WHERE id = ${invoiceId}::uuid AND workspace_id = ${workspaceId}::uuid AND status = 'draft'::invoice_status`;
        await sql`INSERT INTO order_events (workspace_id, order_id, event_type, payload, actor_user_id) VALUES (${workspaceId}::uuid, ${orderId}::uuid, 'order.invoice.issued'::text, ${JSON.stringify({ invoice_id: invoiceId, invoice_number: invoiceNumber, source })}::jsonb, ${actorUserId}::uuid)`;
        base.issued = true;
      }
      const channels = (policy.send_channels_default ?? ['whatsapp', 'email']).filter((ch): ch is DeliveryChannel => ch === 'whatsapp' || ch === 'email');
      const del = await deliverInvoice(workspaceId, invoiceId, { channels, actorUserId });
      base.delivery = { any_sent: del.any_sent, channels: del.channels };
    } catch (e) { console.error('[order_close] issue/deliver failed', e); }
  }

  return base;
}
