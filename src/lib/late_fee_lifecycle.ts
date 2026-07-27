// ============================================================================
// src/lib/late_fee_lifecycle.ts (Phase 1 completion Session 1) — late-return fee.
// ----------------------------------------------------------------------------
// The Money Engine gains a late_fee capability as a canonical routine, mirroring
// the Slice 11 damage_lifecycle shape (compute -> apply -> describe) and reusing
// every existing engine:
//   * recomputeOrderTotals (pricing)  — folds the late_fee line into subtotal +
//     GST + total for free (late_fee is already in SUBTOTAL_TYPES/TAXABLE_TYPES).
//   * generateInvoice (Slice 6)       — revises an existing invoice, running-order
//     safe (bypassReadiness), exactly as the extension flow does.
//   * emitCustomerNotification (Slice 10) — order.late_fee_applied to the customer.
//
// Late fees are SUGGEST-ONLY (Q1): computeLateFeeAtReturn surfaces a proposal,
// the operator applies it (suggested or a custom amount) via applyLateFeeToOrder.
// Nothing auto-posts. applyLateFeeToOrder is intentionally NOT idempotent — an
// operator may legitimately apply, dispute/remove, and re-apply; retry-safety is
// the Idempotency-Key middleware's job at the route layer.
// ============================================================================

import { sql, query } from '../db.js';
import { audit } from './audit.js';
import { recomputeOrderTotals } from './pricing.js';
import { generateInvoice } from '../routes/invoices.js';
import { emitCustomerNotification } from './notify.js';

function inr(paise: number): string {
  return '₹' + new Intl.NumberFormat('en-IN', { maximumFractionDigits: 0 }).format(Math.round(Number(paise) / 100));
}

// Where the late-fee line sorts among adjustments (after damage 8600, before the
// 9000 discount / 9999 auto-tax lines the pricing engine appends).
const LATE_FEE_SORT_ORDER = 8700;

// ---------------------------------------------------------------------------
// Types.
// ---------------------------------------------------------------------------
export type PerItemLateFee = {
  order_item_id: string;
  product_id: string | null;
  description: string;
  daily_rate_paise: number;
  qty: number;
  computed_fee_paise: number;
};

export type ComputedLateFee = {
  hours_late: number;               // raw fractional hours past rental_end
  billable_hours: number;           // ceil(hours_late) - grace (>= 1 once past grace)
  grace_hours_applied: number;
  percent: number;                  // per-hour percent of daily rate
  per_item_fees: PerItemLateFee[];
  total_computed_fee_paise: number;
  effective_hourly_rate_paise: number; // total / billable_hours (for display)
  calculation_metadata: { rental_end: string; actual_return_at: string; formula: string };
};

export type AppliedLateFee = {
  order_item_id: string;
  applied_amount_paise: number;
  updated_total_paise: number;
  notification_sent: boolean;
  notification_reason: string | null;
  invoice_revision: { revised: boolean; new_invoice_id: string | null; new_revision_number: number | null };
};

// ---------------------------------------------------------------------------
// describe — the invoice line text. Baked at line-creation so it flows through
// the invoice snapshot + PDF verbatim (invoice_pdf renders li.description). The
// per-hour rate shown is the EFFECTIVE late-fee rate (daily/24 * percent), so
// billable_hours * rate == the charged amount (transparent math on the invoice).
// ---------------------------------------------------------------------------
export function renderLateFeeDescription(billableHours: number, hourlyRatePaise: number | null): string {
  const h = Math.max(0, Math.round(billableHours));
  const base = `Late return fee — ${h} hour(s) late`;
  return hourlyRatePaise && hourlyRatePaise > 0 ? `${base} (${inr(hourlyRatePaise)}/hr)` : base;
}

// The effective late-fee rate charged per billable hour for one unit of a
// product: (daily_rate / 24) * (percent / 100). Exported for the suggest UI.
export function lateFeeHourlyRatePaise(dailyRatePaise: number, percent: number): number {
  return Math.round((Number(dailyRatePaise) / 24) * (Number(percent) / 100));
}

// ---------------------------------------------------------------------------
// compute — deterministic + idempotent (same inputs => same output). Reads the
// order's rental_end, its rental lines (rate = booked daily_rate_paise, falling
// back to the product default), and the workspace policy. Returns null when
// within the grace window (Q2). Grace is a DEDUCTIBLE free window: only the
// hours BEYOND grace are billable (Rule F: 3h late, grace 2 -> 1h billable).
// ---------------------------------------------------------------------------
export async function computeLateFeeAtReturn(
  workspaceId: string,
  orderId: string,
  actualReturnAtIso: string,
): Promise<ComputedLateFee | null> {
  const ord = (await query<{ rental_end: string | null; grace: number; percent: number }>(sql`
    SELECT o.rental_end,
           COALESCE((w.settings->'dispatch_return_policy'->>'late_return_fee_grace_hours')::numeric, 2) AS grace,
           COALESCE((w.settings->'dispatch_return_policy'->>'late_return_fee_per_hour_percent')::numeric, 10) AS percent
    FROM orders o
    JOIN workspaces w ON w.id = o.workspace_id
    WHERE o.id = ${orderId}::uuid AND o.workspace_id = ${workspaceId}::uuid AND o.deleted_at IS NULL
    LIMIT 1
  `))[0];
  if (!ord || !ord.rental_end) return null;

  const rentalEnd = new Date(ord.rental_end);
  const actual = new Date(actualReturnAtIso);
  if (isNaN(rentalEnd.getTime()) || isNaN(actual.getTime())) return null;

  const graceHours = Number(ord.grace);
  const percent = Number(ord.percent);
  const hoursLate = (actual.getTime() - rentalEnd.getTime()) / 3.6e6;
  if (hoursLate <= graceHours) return null; // within grace -> no fee

  // Billable = the hours BEYOND grace, rounded UP to whole hours (a started hour
  // beyond grace is charged — standard late-fee convention). The 1e-6 epsilon
  // absorbs sub-second processing drift so an EXACTLY-N-hour-late return is stable
  // (without it, "3h late" measured as 3h+2ms would ceil to 4 and bill an extra
  // hour — Rule F: 3h late, grace 2 => exactly 1 billable hour).
  const billableHours = Math.max(0, Math.ceil(hoursLate - graceHours - 1e-6));
  if (billableHours <= 0) return null;

  // Rental lines that carry a reservation (booked rate snapshot, product fallback).
  const items = await query<{ id: string; product_id: string | null; description: string; quantity: number; rate: number }>(sql`
    SELECT oi.id, oi.product_id, oi.description, oi.quantity,
           COALESCE(oi.daily_rate_paise, p.daily_rate, 0)::bigint AS rate
    FROM order_items oi
    LEFT JOIN products p ON p.id = oi.product_id AND p.workspace_id = oi.workspace_id
    WHERE oi.order_id = ${orderId}::uuid AND oi.workspace_id = ${workspaceId}::uuid
      AND oi.item_type = 'rental'
  `);

  const per_item_fees: PerItemLateFee[] = [];
  let total = 0;
  for (const it of items) {
    const rate = Number(it.rate);
    const qty = Number(it.quantity);
    const fee = Math.round(billableHours * (rate / 24) * (percent / 100) * qty);
    if (fee <= 0) continue;
    per_item_fees.push({
      order_item_id: it.id, product_id: it.product_id, description: it.description,
      daily_rate_paise: rate, qty, computed_fee_paise: fee,
    });
    total += fee;
  }
  if (total <= 0) return null;

  return {
    hours_late: Math.round(hoursLate * 100) / 100,
    billable_hours: billableHours,
    grace_hours_applied: graceHours,
    percent,
    per_item_fees,
    total_computed_fee_paise: total,
    effective_hourly_rate_paise: Math.round(total / billableHours),
    calculation_metadata: {
      rental_end: rentalEnd.toISOString(),
      actual_return_at: actual.toISOString(),
      formula: 'ceil(hours_late - grace) * (daily_rate/24) * (percent/100) * qty, summed per rental line',
    },
  };
}

// ---------------------------------------------------------------------------
// apply — insert the single late_fee line, recompute totals, revise an existing
// invoice (Slice 6 pattern), notify the customer (Slice 10), and audit as an
// item-add sub-variant (payload flag late_fee=true, per the CLAUDE.md convention
// of encoding sub-variants in payload flags, not new event_types).
//
// NOT idempotent (see the module header). Fail-soft on invoice + notification:
// neither can fail the fee application (the order line is the source of truth).
// ---------------------------------------------------------------------------
export async function applyLateFeeToOrder(args: {
  workspaceId: string;
  orderId: string;
  feeAmountPaise: number;
  actorUserId: string;
  reason: string;
  hoursLate: number | null;
  billableHours: number | null;
  hourlyRatePaise: number | null;
  computedFeePaise: number | null;
  ip?: string | null;
  userAgent?: string | null;
}): Promise<AppliedLateFee> {
  const result: AppliedLateFee = {
    order_item_id: '', applied_amount_paise: args.feeAmountPaise, updated_total_paise: 0,
    notification_sent: false, notification_reason: null,
    invoice_revision: { revised: false, new_invoice_id: null, new_revision_number: null },
  };

  const description = renderLateFeeDescription(args.billableHours ?? args.hoursLate ?? 0, args.hourlyRatePaise);

  // (a) The late_fee line. price_breakdown carries the structured provenance
  //     (no dedicated column exists; late_fee lines are never re-priced, so
  //     price_breakdown is inert here — a safe, queryable home for the metadata).
  const ins = (await query<{ id: string }>(sql`
    INSERT INTO order_items
      (workspace_id, order_id, item_type, description, quantity,
       unit_amount_paise, total_amount_paise, sort_order, price_breakdown)
    VALUES (${args.workspaceId}::uuid, ${args.orderId}::uuid, 'late_fee'::order_item_type,
            ${description}::text, 1,
            ${args.feeAmountPaise}::bigint, ${args.feeAmountPaise}::bigint, ${LATE_FEE_SORT_ORDER},
            ${JSON.stringify({
              late_fee: {
                hours_late: args.hoursLate, billable_hours: args.billableHours,
                hourly_rate_paise: args.hourlyRatePaise, computed_fee_paise: args.computedFeePaise,
                applied_fee_paise: args.feeAmountPaise, reason: args.reason, applied_by: args.actorUserId,
              },
            })}::jsonb)
    RETURNING id
  `))[0]!;
  result.order_item_id = ins.id;

  // (b) Recompute — folds the line into subtotal + GST + total.
  try {
    const rec = await recomputeOrderTotals(args.orderId, args.workspaceId, args.actorUserId);
    result.updated_total_paise = Number(rec.order.total_paise);
  } catch (e) { console.error('[late_fee] recompute failed', e); }

  // (c) Timeline + audit. order_events carries a dedicated timeline type; audit
  //     reuses orders.item.added with a payload flag (sub-variant convention).
  const payload = {
    order_item_id: ins.id, item_type: 'late_fee', late_fee: true,
    amount_paise: args.feeAmountPaise, computed_fee_paise: args.computedFeePaise,
    hours_late: args.hoursLate, billable_hours: args.billableHours, reason: args.reason,
  };
  await sql`
    INSERT INTO order_events (workspace_id, order_id, event_type, payload, actor_user_id)
    VALUES (${args.workspaceId}::uuid, ${args.orderId}::uuid, 'order.late_fee_applied'::text, ${JSON.stringify(payload)}::jsonb, ${args.actorUserId}::uuid)
  `;
  await audit({
    workspaceId: args.workspaceId, actorUserId: args.actorUserId, eventType: 'orders.item.added',
    targetType: 'order', targetId: args.orderId, payload,
    ipAddress: args.ip ?? null, userAgent: args.userAgent ?? null,
  });

  // (d) Invoice revision (Slice 6 / extension pattern) — fail-open.
  try {
    const existingInv = (await query<{ n: number; seq: number | null }>(sql`
      SELECT COUNT(*)::int AS n, MIN(sequence)::int AS seq FROM invoices
      WHERE order_id = ${args.orderId}::uuid AND workspace_id = ${args.workspaceId}::uuid
    `))[0];
    const status = (await query<{ status: string }>(sql`SELECT status::text AS status FROM orders WHERE id = ${args.orderId}::uuid AND workspace_id = ${args.workspaceId}::uuid LIMIT 1`))[0]?.status;
    if ((existingInv?.n ?? 0) > 0 && status !== 'closed') {
      const gen = await generateInvoice({
        workspaceId: args.workspaceId, userId: args.actorUserId, orderId: args.orderId,
        sequence: Number(existingInv?.seq ?? 1), notes: 'Auto-revision on late fee',
        ipAddress: args.ip ?? null, userAgent: args.userAgent ?? null, bypassReadiness: true,
      });
      if (gen.ok) {
        result.invoice_revision = { revised: true, new_invoice_id: gen.invoice.id as string, new_revision_number: gen.revision };
      }
    }
  } catch (e) { console.error('[late_fee] invoice revision failed', e); }

  // (e) Customer notification (Slice 10) — fail-soft.
  try {
    const cust = (await query<{ order_number: number; person_id: string | null; phone: string | null; email: string | null; name: string | null }>(sql`
      SELECT o.order_number, o.customer_person_id AS person_id, p.phone, p.email, p.display_name AS name
      FROM orders o LEFT JOIN people p ON p.id = o.customer_person_id
      WHERE o.id = ${args.orderId}::uuid AND o.workspace_id = ${args.workspaceId}::uuid LIMIT 1
    `))[0];
    if (cust) {
      const notify = await emitCustomerNotification({
        workspaceId: args.workspaceId, orderId: args.orderId, personId: cust.person_id,
        eventType: 'order.late_fee_applied',
        message: `A late return fee of ${inr(args.feeAmountPaise)} has been added to your order #${cust.order_number}.`
          + (args.hoursLate != null ? ` The equipment was returned ${Math.round(args.hoursLate)} hour(s) after the scheduled return time.` : '')
          + ' This appears on your next invoice.',
        channels: ['whatsapp', 'email'],
        contact: { phone: cust.phone, email: cust.email },
        variables: {
          customer_name: cust.name ?? 'there', order_number: cust.order_number,
          amount: inr(args.feeAmountPaise), hours_late: args.hoursLate != null ? String(Math.round(args.hoursLate)) : '',
          reason: args.reason,
        },
      });
      result.notification_sent = notify.deliveries.some((x) => x.status === 'sent');
      result.notification_reason = result.notification_sent ? null
        : (notify.deliveries.find((x) => x.reason === 'no_active_adapter' || x.reason === 'noop_adapter') ? 'provider_not_configured' : (notify.deliveries[0]?.reason ?? 'not_sent'));
    }
  } catch (e) { console.error('[late_fee] notification failed', e); }

  return result;
}
