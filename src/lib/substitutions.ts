// ============================================================================
// src/lib/substitutions.ts (Sub-slice 2.3) — first-class asset substitution
// ----------------------------------------------------------------------------
// A substitution is a swap event: an asset/line needs replacement at any point in
// an order's lifecycle. The ORIGINAL line is NEVER deleted — it goes to
// order_items.status = 'substituted_out' (migration 047), a TERMINAL, NON-
// RESERVING status (it's absent from RESERVING_ITEM_STATUSES, so the replacement
// line — not the swapped-out one — holds the capacity). The REPLACEMENT is a NEW
// order_items line. Mid-rental financial deltas materialise as NEW lines (a
// charge or a credit), never by mutating the original (pack rule).
//
// Two levels, never conflated (same discipline as dispatch/return): a reservation
// (order_items, a capacity claim) vs an assignment (a specific asset physically
// swapped). asset.status is written ONLY in dispatch/return flows and here (a
// substitution IS a return-of-original + dispatch-of-replacement).
//
// Approval: the substitution ROW is its own approval record (requires_approval +
// approved_by/at + rejected_reason + status pending_approval/approved/rejected).
// The dedicated approve/reject endpoints are the mechanism; the central approvals
// feed (approval_request_id) is reserved for a later integration. Notifications
// are AWAITED in try/catch (Rule H — serverless-freeze).
// ============================================================================

import { sql, query } from '../db.js';
import { audit } from './audit.js';
import { emitNotification, emitCustomerNotification } from './notify.js';
import { recomputeOrderTotals } from './pricing.js';

// The 7-tag type + 11-tag reason taxonomies (mirror the DB CHECKs, migration 046).
export const SUBSTITUTION_TYPES = [
  'same_unit_swap', 'same_product_swap', 'equivalent_product_swap',
  'upgrade_free', 'upgrade_paid', 'downgrade_credit', 'kit_component_swap',
] as const;
export type SubstitutionType = typeof SUBSTITUTION_TYPES[number];

export const SUBSTITUTION_REASON_TAGS = [
  'unit_failed_precheck', 'unit_unavailable_at_dispatch', 'unit_damaged_in_rental',
  'customer_preference_change', 'customer_upgrade_request', 'goodwill_upgrade',
  'product_shortage', 'extension_conflict', 'operational_convenience', 'staff_error', 'other',
] as const;

export const FINANCIAL_HANDLINGS = ['no_change', 'additional_charge', 'credit_to_customer', 'business_absorb'] as const;
export type FinancialHandling = typeof FINANCIAL_HANDLINGS[number];

export const SUBSTITUTION_TIMINGS = ['immediate_before_dispatch', 'rush_mid_rental', 'at_next_natural_handover', 'scheduled'] as const;

export const SUBSTITUTION_SOURCE_TYPES = ['direct', 'damage_incident', 'extension_conflict', 'pre_dispatch_check', 'customer_request'] as const;

/** The financial types that involve a customer charge or credit (gate on
 *  substitutions.financial). no_change / business_absorb never bill the customer. */
export function isFinancialSubstitution(type: SubstitutionType, handling: FinancialHandling): boolean {
  if (handling === 'additional_charge' || handling === 'credit_to_customer') return true;
  return type === 'upgrade_paid' || type === 'downgrade_credit';
}

/** True on a Postgres UNIQUE violation (SQLSTATE 23505) — used to retry the
 *  substitution_number sequence on a concurrent create (same pattern as quotes). */
function isUniqueViolation(e: unknown): boolean {
  const err = e as { code?: string; message?: string; constraint?: string } | null;
  if (!err) return false;
  if (err.code === '23505') return true;
  const hay = `${err.constraint ?? ''} ${err.message ?? ''}`.toLowerCase();
  return hay.includes('unique') || hay.includes('duplicate key');
}

type SubstitutionPolicy = {
  financial_defaults_by_type: Record<string, string>;
  customer_notification_defaults_by_type: Record<string, boolean>;
  approval_required: { goodwill_upgrade_over_value_paise?: number; downgrade_credit_over_paise?: number; cross_category_substitution?: boolean };
  reversion_window_hours: number;
};

function readSubstitutionPolicy(settings: Record<string, any> | null | undefined): SubstitutionPolicy {
  const p = settings?.substitution_policy ?? {};
  return {
    financial_defaults_by_type: p.financial_defaults_by_type ?? {},
    customer_notification_defaults_by_type: p.customer_notification_defaults_by_type ?? {},
    approval_required: p.approval_required ?? {},
    reversion_window_hours: Number(p.reversion_window_hours ?? 24),
  };
}

type OrderItemRow = {
  id: string; order_id: string; product_id: string | null; description: string;
  quantity: number; item_type: string; status: string; parent_item_id: string | null;
  daily_rate_paise: number | null; billable_days: number | null; unit_amount_paise: number | null;
  total_amount_paise: number; sort_order: number | null;
};

async function loadOrderItem(workspaceId: string, orderId: string, itemId: string): Promise<OrderItemRow | null> {
  return (await query<OrderItemRow>(sql`
    SELECT id, order_id, product_id, description, quantity, item_type::text AS item_type, status::text AS status,
           parent_item_id, daily_rate_paise, billable_days, unit_amount_paise, total_amount_paise, sort_order
    FROM order_items WHERE id = ${itemId}::uuid AND order_id = ${orderId}::uuid AND workspace_id = ${workspaceId}::uuid LIMIT 1
  `))[0] ?? null;
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

export type CreateSubstitutionArgs = {
  workspaceId: string; orderId: string; actorUserId: string;
  originalOrderItemId: string; originalAssetId?: string | null;
  replacementProductId?: string | null; replacementAssetId?: string | null;
  substitutionType: SubstitutionType; reasonTag: string; reasonNotes?: string | null;
  financialHandling?: FinancialHandling | null; financialAmountPaise?: number | null; proRatedDays?: number | null;
  timing: string; scheduledAt?: string | null;
  sourceType?: string; sourceId?: string | null;
  ip?: string | null; userAgent?: string | null;
};

export type CreateSubstitutionResult =
  | { ok: true; substitution: any; requires_approval: boolean }
  | { ok: false; error: string };

/** Create a substitution (status proposed, or pending_approval when policy
 *  thresholds trip). Freezes the policy snapshot. Original line is untouched here
 *  — it flips to substituted_out only at execute. */
export async function createSubstitution(args: CreateSubstitutionArgs): Promise<CreateSubstitutionResult> {
  const orderCtx = await loadOrderContext(args.workspaceId, args.orderId);
  if (!orderCtx) return { ok: false, error: 'order_not_found' };
  const original = await loadOrderItem(args.workspaceId, args.orderId, args.originalOrderItemId);
  if (!original) return { ok: false, error: 'original_item_not_found' };
  if (original.status === 'substituted_out') return { ok: false, error: 'already_substituted' };

  const settings = (await query<{ settings: Record<string, any> | null }>(sql`SELECT settings FROM workspaces WHERE id = ${args.workspaceId}::uuid LIMIT 1`))[0]?.settings ?? {};
  const policy = readSubstitutionPolicy(settings);

  // Financial handling default from policy when the caller didn't specify.
  const financialHandling: FinancialHandling =
    (args.financialHandling as FinancialHandling | null | undefined)
    ?? (policy.financial_defaults_by_type[args.substitutionType] as FinancialHandling | undefined)
    ?? 'no_change';
  const financialAmount = Math.max(0, Number(args.financialAmountPaise ?? 0));

  // Approval routing (policy thresholds). goodwill upgrade over value, downgrade
  // credit over amount, cross-category swap. requires_approval is advisory-gated:
  // the row is created pending_approval and the executor must approve first.
  const ar = policy.approval_required;
  let requiresApproval = false;
  const approvalReasons: string[] = [];
  // Goodwill upgrade is the `upgrade_free` TYPE with the `goodwill_upgrade` REASON
  // tag (the two taxonomies are distinct — see migration 046).
  if (args.reasonTag === 'goodwill_upgrade') {
    const th = Number(ar.goodwill_upgrade_over_value_paise ?? Infinity);
    if (financialAmount > th) { requiresApproval = true; approvalReasons.push('goodwill_upgrade_over_value'); }
  }
  if (args.substitutionType === 'downgrade_credit') {
    const th = Number(ar.downgrade_credit_over_paise ?? Infinity);
    if (financialAmount > th) { requiresApproval = true; approvalReasons.push('downgrade_credit_over_value'); }
  }

  const policySnapshot = {
    substitution_policy: settings?.substitution_policy ?? {},
    reversion_window_hours: policy.reversion_window_hours,
    approval_reasons: approvalReasons,
  };
  const status = requiresApproval ? 'pending_approval' : 'proposed';

  // Number: SUB-{orderNumber}-{seq} (Option A — per-order sequence, no year).
  // Retry on a concurrent-create unique clash (recompute seq), same discipline as
  // quote versioning.
  const MAX_ATTEMPTS = 4;
  for (let attempt = 1; ; attempt++) {
    const seq = Number((await query<{ n: number }>(sql`SELECT COUNT(*)::int AS n FROM substitutions WHERE order_id = ${args.orderId}::uuid AND workspace_id = ${args.workspaceId}::uuid`))[0]?.n ?? 0) + 1;
    const substitutionNumber = `SUB-${orderCtx.order_number}-${String(seq).padStart(2, '0')}`;
    try {
      const row = (await query<any>(sql`
        INSERT INTO substitutions (
          workspace_id, order_id, substitution_number, source_type, source_id, substitution_type,
          substitution_reason_tag, substitution_reason_notes, original_order_item_id, original_asset_id,
          original_prior_status, replacement_product_id, replacement_order_item_id, replacement_asset_id,
          financial_handling, financial_amount_paise, pro_rated_days, timing, scheduled_at, status,
          requires_approval, created_by, policy_applied_snapshot)
        VALUES (
          ${args.workspaceId}::uuid, ${args.orderId}::uuid, ${substitutionNumber}::text, ${args.sourceType ?? 'direct'}::text,
          ${args.sourceId ?? null}::uuid, ${args.substitutionType}::text, ${args.reasonTag}::text,
          ${args.reasonNotes ?? null}::text, ${args.originalOrderItemId}::uuid, ${args.originalAssetId ?? null}::uuid,
          ${original.status}::text, ${args.replacementProductId ?? null}::uuid, NULL::uuid, ${args.replacementAssetId ?? null}::uuid,
          ${financialHandling}::text, ${financialAmount}::bigint, ${args.proRatedDays ?? null}::int, ${args.timing}::text,
          ${args.scheduledAt ?? null}::timestamptz, ${status}::text, ${requiresApproval}::boolean,
          ${args.actorUserId}::uuid, ${JSON.stringify(policySnapshot)}::jsonb)
        RETURNING *
      `))[0];

      await sql`
        INSERT INTO order_events (workspace_id, order_id, event_type, payload, actor_user_id)
        VALUES (${args.workspaceId}::uuid, ${args.orderId}::uuid, 'order.substitution.proposed',
          ${JSON.stringify({ substitution_id: row.id, substitution_number: substitutionNumber, substitution_type: args.substitutionType, reason_tag: args.reasonTag, requires_approval: requiresApproval, original_order_item_id: args.originalOrderItemId })}::jsonb,
          ${args.actorUserId}::uuid)
      `;
      await audit({ workspaceId: args.workspaceId, actorUserId: args.actorUserId, eventType: 'substitutions.created', targetType: 'substitution', targetId: row.id, payload: { order_id: args.orderId, substitution_number: substitutionNumber, substitution_type: args.substitutionType, requires_approval: requiresApproval, financial_handling: financialHandling }, ipAddress: args.ip ?? null, userAgent: args.userAgent ?? null });

      // Notify the approver (internal) when approval is required. Awaited, fail-open.
      if (requiresApproval) {
        try {
          await emitNotification({
            workspaceId: args.workspaceId, actorUserId: args.actorUserId, eventType: 'substitution_pending_approval',
            targetType: 'order', targetId: args.orderId, linkUrl: `/order-360.html?id=${args.orderId}`,
            metadata: { order_number: orderCtx.order_number, substitution_number: substitutionNumber, original_item: original.description, replacement_item: args.replacementProductId ? 'replacement unit' : original.description, actor_name: '' },
          });
        } catch { /* fail-open */ }
      }
      return { ok: true, substitution: row, requires_approval: requiresApproval };
    } catch (e) {
      if (isUniqueViolation(e) && attempt < MAX_ATTEMPTS) continue;
      throw e;
    }
  }
}

/** Execute an approved/proposed substitution: original → substituted_out, create
 *  the replacement line, write linked return+dispatch events, materialise any
 *  financial delta as NEW lines, recompute, notify. */
export async function executeSubstitution(args: {
  workspaceId: string; orderId: string; substitutionId: string; actorUserId: string; ip?: string | null; userAgent?: string | null;
}): Promise<{ ok: boolean; error?: string; substitution?: any }> {
  const sub = (await query<any>(sql`
    SELECT * FROM substitutions WHERE id = ${args.substitutionId}::uuid AND workspace_id = ${args.workspaceId}::uuid LIMIT 1
  `))[0];
  if (!sub) return { ok: false, error: 'not_found' };
  if (sub.status === 'executed') return { ok: false, error: 'already_executed' };
  if (sub.status === 'reverted') return { ok: false, error: 'already_reverted' };
  if (sub.status === 'rejected') return { ok: false, error: 'rejected' };
  if (sub.requires_approval && sub.status !== 'approved') return { ok: false, error: 'approval_required' };

  const orderCtx = await loadOrderContext(args.workspaceId, args.orderId);
  if (!orderCtx) return { ok: false, error: 'order_not_found' };
  const original = await loadOrderItem(args.workspaceId, args.orderId, sub.original_order_item_id);
  if (!original) return { ok: false, error: 'original_item_not_found' };

  const settings = (await query<{ settings: Record<string, any> | null }>(sql`SELECT settings FROM workspaces WHERE id = ${args.workspaceId}::uuid LIMIT 1`))[0]?.settings ?? {};
  const policy = readSubstitutionPolicy(settings);

  // Replacement line: clone the original's commercial shape. If a replacement
  // product is given, re-point product_id + snapshot its rate; else same product
  // (same_unit / same_product swap). Item status matches timing: an immediate
  // pre-dispatch swap lands pending_dispatch; a mid-rental swap lands dispatched.
  const replacementProductId = sub.replacement_product_id ?? original.product_id;
  let dailyRate = original.daily_rate_paise;
  let unit = original.unit_amount_paise;
  if (replacementProductId && replacementProductId !== original.product_id) {
    const p = (await query<{ base_price_paise: number | null; daily_rate: number }>(sql`SELECT base_price_paise, daily_rate FROM products WHERE id = ${replacementProductId}::uuid AND workspace_id = ${args.workspaceId}::uuid LIMIT 1`))[0];
    if (p) { dailyRate = Number(p.base_price_paise ?? p.daily_rate); unit = dailyRate; }
  }
  const newItemStatus = sub.timing === 'rush_mid_rental' || orderCtx.status === 'dispatched' || orderCtx.status === 'active' ? 'dispatched' : 'pending_dispatch';

  const replacement = (await query<{ id: string }>(sql`
    INSERT INTO order_items (
      workspace_id, order_id, parent_item_id, item_type, product_id, description, quantity,
      daily_rate_paise, billable_days, unit_amount_paise, total_amount_paise, status, sort_order)
    VALUES (
      ${args.workspaceId}::uuid, ${args.orderId}::uuid, ${original.parent_item_id ?? null}::uuid,
      ${original.item_type}::order_item_type, ${replacementProductId ?? null}::uuid,
      ${`${original.description} (substituted)`}::text, ${original.quantity}::int,
      ${dailyRate ?? null}::bigint, ${original.billable_days ?? null}::int, ${unit ?? null}::bigint,
      ${original.total_amount_paise}::bigint, ${newItemStatus}::order_item_status, ${original.sort_order ?? null}::int)
    RETURNING id
  `))[0]!;

  // Original line → substituted_out (terminal, non-reserving).
  await sql`UPDATE order_items SET status = 'substituted_out', updated_at = now() WHERE id = ${original.id}::uuid AND workspace_id = ${args.workspaceId}::uuid`;

  // Asset dispositions (a substitution IS a return-of-original + dispatch-of-
  // replacement). Guarded — only when specific units are pinned.
  if (sub.original_asset_id) {
    await sql`UPDATE assets SET status = 'available', updated_at = now() WHERE id = ${sub.original_asset_id}::uuid AND workspace_id = ${args.workspaceId}::uuid AND status = 'out'`;
  }
  if (sub.replacement_asset_id) {
    await sql`UPDATE assets SET status = 'out', updated_at = now() WHERE id = ${sub.replacement_asset_id}::uuid AND workspace_id = ${args.workspaceId}::uuid AND status = 'available'`;
    await sql`
      INSERT INTO order_assets (workspace_id, order_id, order_item_id, asset_id)
      VALUES (${args.workspaceId}::uuid, ${args.orderId}::uuid, ${replacement.id}::uuid, ${sub.replacement_asset_id}::uuid)
      ON CONFLICT DO NOTHING
    `;
  }

  // Linked return (original) + dispatch (replacement) timeline events.
  const returnEvent = (await query<{ id: string }>(sql`
    INSERT INTO order_events (workspace_id, order_id, event_type, payload, actor_user_id)
    VALUES (${args.workspaceId}::uuid, ${args.orderId}::uuid, 'order.substitution.return',
      ${JSON.stringify({ substitution_id: sub.id, order_item_id: original.id, asset_id: sub.original_asset_id })}::jsonb, ${args.actorUserId}::uuid)
    RETURNING id
  `))[0]!;
  const dispatchEvent = (await query<{ id: string }>(sql`
    INSERT INTO order_events (workspace_id, order_id, event_type, payload, actor_user_id)
    VALUES (${args.workspaceId}::uuid, ${args.orderId}::uuid, 'order.substitution.dispatch',
      ${JSON.stringify({ substitution_id: sub.id, order_item_id: replacement.id, asset_id: sub.replacement_asset_id })}::jsonb, ${args.actorUserId}::uuid)
    RETURNING id
  `))[0]!;

  // Financial delta → NEW lines (never mutate originals). Charge = +'other';
  // credit = -'discount'. Then recompute so tax/totals follow.
  const amount = Number(sub.financial_amount_paise ?? 0);
  if (amount > 0 && sub.financial_handling === 'additional_charge') {
    await sql`
      INSERT INTO order_items (workspace_id, order_id, item_type, description, quantity, unit_amount_paise, total_amount_paise, is_custom_line, custom_name, status, sort_order)
      VALUES (${args.workspaceId}::uuid, ${args.orderId}::uuid, 'other', ${`Substitution charge · ${sub.substitution_number}`}::text, 1, ${amount}::bigint, ${amount}::bigint, true, 'Substitution charge', 'pending_dispatch', 8500)
    `;
  } else if (amount > 0 && sub.financial_handling === 'credit_to_customer') {
    await sql`
      INSERT INTO order_items (workspace_id, order_id, item_type, description, quantity, unit_amount_paise, total_amount_paise, is_custom_line, custom_name, status, sort_order)
      VALUES (${args.workspaceId}::uuid, ${args.orderId}::uuid, 'discount', ${`Substitution credit · ${sub.substitution_number}`}::text, 1, ${-amount}::bigint, ${-amount}::bigint, true, 'Substitution credit', 'pending_dispatch', 8600)
    `;
  }

  await sql`
    UPDATE substitutions SET status = 'executed', executed_at = now(),
      replacement_order_item_id = ${replacement.id}::uuid,
      linked_return_event_id = ${returnEvent.id}::uuid, linked_dispatch_event_id = ${dispatchEvent.id}::uuid,
      updated_at = now()
    WHERE id = ${sub.id}::uuid AND workspace_id = ${args.workspaceId}::uuid
  `;

  // Recompute totals (fail-soft — never fail the swap on a pricing hiccup).
  try { await recomputeOrderTotals(args.orderId, args.workspaceId, args.actorUserId); } catch { /* fail-soft */ }

  await audit({ workspaceId: args.workspaceId, actorUserId: args.actorUserId, eventType: 'substitutions.executed', targetType: 'substitution', targetId: sub.id, payload: { order_id: args.orderId, substitution_number: sub.substitution_number, replacement_order_item_id: replacement.id, financial_handling: sub.financial_handling, financial_amount_paise: amount }, ipAddress: args.ip ?? null, userAgent: args.userAgent ?? null });

  // Customer notification per policy default for this type (awaited, fail-open).
  const notifyDefault = policy.customer_notification_defaults_by_type[sub.substitution_type] ?? true;
  if (notifyDefault && orderCtx) {
    try {
      await emitCustomerNotification({
        workspaceId: args.workspaceId, orderId: args.orderId, personId: orderCtx.customer_person_id, eventType: 'substitution_executed',
        message: `An item on your order #${orderCtx.order_number} has been swapped (${sub.substitution_number}).`,
        channels: ['whatsapp', 'email'], contact: { phone: orderCtx.customer_phone, email: orderCtx.customer_email }, settings,
        variables: { customer_name: orderCtx.customer_name ?? 'there', order_number: orderCtx.order_number, substitution_number: sub.substitution_number, original_item: original.description, replacement_item: `${original.description} (substituted)` },
      });
      await sql`UPDATE substitutions SET customer_notified = true, updated_at = now() WHERE id = ${sub.id}::uuid AND workspace_id = ${args.workspaceId}::uuid`;
    } catch { /* fail-open */ }
  }

  const updated = (await query<any>(sql`SELECT * FROM substitutions WHERE id = ${sub.id}::uuid AND workspace_id = ${args.workspaceId}::uuid LIMIT 1`))[0];
  return { ok: true, substitution: updated };
}

/** Revert an executed substitution within the (policy-configured) window: restore
 *  the original line's prior status, remove the replacement line, reverse assets. */
export async function revertSubstitution(args: {
  workspaceId: string; orderId: string; substitutionId: string; actorUserId: string; reason?: string | null; ip?: string | null; userAgent?: string | null;
}): Promise<{ ok: boolean; error?: string }> {
  const sub = (await query<any>(sql`SELECT * FROM substitutions WHERE id = ${args.substitutionId}::uuid AND workspace_id = ${args.workspaceId}::uuid LIMIT 1`))[0];
  if (!sub) return { ok: false, error: 'not_found' };
  if (sub.status !== 'executed') return { ok: false, error: 'not_executed' };

  // Reversion window from the FROZEN policy snapshot (Rule D: the window in force
  // at creation time governs this substitution, even if the setting changes later).
  const windowHours = Number(sub.policy_applied_snapshot?.reversion_window_hours ?? 24);
  const executedAt = sub.executed_at ? new Date(sub.executed_at).getTime() : 0;
  if (executedAt && Date.now() - executedAt > windowHours * 3_600_000) {
    return { ok: false, error: 'reversion_window_expired' };
  }

  // Restore original, drop replacement. The substitution row references the
  // replacement line via replacement_order_item_id (FK), so we mark the row
  // reverted AND clear that reference FIRST, else the DELETE below violates the
  // FK (caught by the PG16 flow harness — the real revert would have 500'd).
  await sql`UPDATE order_items SET status = ${sub.original_prior_status ?? 'dispatched'}::order_item_status, updated_at = now() WHERE id = ${sub.original_order_item_id}::uuid AND workspace_id = ${args.workspaceId}::uuid`;
  await sql`UPDATE substitutions SET status = 'reverted', reverted_at = now(), reverted_reason = ${args.reason ?? null}::text, reverted_by = ${args.actorUserId}::uuid, replacement_order_item_id = NULL, updated_at = now() WHERE id = ${sub.id}::uuid AND workspace_id = ${args.workspaceId}::uuid`;
  if (sub.replacement_order_item_id) {
    await sql`DELETE FROM order_assets WHERE order_item_id = ${sub.replacement_order_item_id}::uuid AND workspace_id = ${args.workspaceId}::uuid`;
    await sql`DELETE FROM order_items WHERE id = ${sub.replacement_order_item_id}::uuid AND workspace_id = ${args.workspaceId}::uuid`;
  }
  // Reverse asset dispositions.
  if (sub.replacement_asset_id) {
    await sql`UPDATE assets SET status = 'available', updated_at = now() WHERE id = ${sub.replacement_asset_id}::uuid AND workspace_id = ${args.workspaceId}::uuid AND status = 'out'`;
  }
  if (sub.original_asset_id) {
    await sql`UPDATE assets SET status = 'out', updated_at = now() WHERE id = ${sub.original_asset_id}::uuid AND workspace_id = ${args.workspaceId}::uuid AND status = 'available'`;
  }

  // (substitution row already marked reverted + FK cleared above, before the
  //  replacement line was deleted.)
  await sql`
    INSERT INTO order_events (workspace_id, order_id, event_type, payload, actor_user_id)
    VALUES (${args.workspaceId}::uuid, ${args.orderId}::uuid, 'order.substitution.reverted', ${JSON.stringify({ substitution_id: sub.id, substitution_number: sub.substitution_number, reason: args.reason ?? null })}::jsonb, ${args.actorUserId}::uuid)
  `;
  try { await recomputeOrderTotals(args.orderId, args.workspaceId, args.actorUserId); } catch { /* fail-soft */ }
  await audit({ workspaceId: args.workspaceId, actorUserId: args.actorUserId, eventType: 'substitutions.reverted', targetType: 'substitution', targetId: sub.id, payload: { order_id: args.orderId, substitution_number: sub.substitution_number, reason: args.reason ?? null }, ipAddress: args.ip ?? null, userAgent: args.userAgent ?? null });

  // Notify the customer only if they were told about the original swap.
  if (sub.customer_notified) {
    const orderCtx = await loadOrderContext(args.workspaceId, args.orderId);
    const original = await loadOrderItem(args.workspaceId, args.orderId, sub.original_order_item_id);
    if (orderCtx) {
      try {
        await emitCustomerNotification({
          workspaceId: args.workspaceId, orderId: args.orderId, personId: orderCtx.customer_person_id, eventType: 'substitution_reverted',
          message: `The earlier swap ${sub.substitution_number} on your order #${orderCtx.order_number} has been reverted.`,
          channels: ['whatsapp', 'email'], contact: { phone: orderCtx.customer_phone, email: orderCtx.customer_email },
          variables: { customer_name: orderCtx.customer_name ?? 'there', order_number: orderCtx.order_number, substitution_number: sub.substitution_number, original_item: original?.description ?? 'the original item' },
        });
      } catch { /* fail-open */ }
    }
  }
  return { ok: true };
}

/** Approve / reject a pending_approval substitution (the row IS the approval record). */
export async function approveSubstitution(args: { workspaceId: string; orderId: string; substitutionId: string; actorUserId: string; ip?: string | null; userAgent?: string | null }): Promise<{ ok: boolean; error?: string }> {
  const sub = (await query<{ status: string; substitution_number: string }>(sql`SELECT status, substitution_number FROM substitutions WHERE id = ${args.substitutionId}::uuid AND workspace_id = ${args.workspaceId}::uuid LIMIT 1`))[0];
  if (!sub) return { ok: false, error: 'not_found' };
  if (sub.status !== 'pending_approval') return { ok: false, error: 'not_pending_approval' };
  await sql`UPDATE substitutions SET status = 'approved', approved_by = ${args.actorUserId}::uuid, approved_at = now(), updated_at = now() WHERE id = ${args.substitutionId}::uuid AND workspace_id = ${args.workspaceId}::uuid`;
  await audit({ workspaceId: args.workspaceId, actorUserId: args.actorUserId, eventType: 'substitutions.approved', targetType: 'substitution', targetId: args.substitutionId, payload: { order_id: args.orderId, substitution_number: sub.substitution_number }, ipAddress: args.ip ?? null, userAgent: args.userAgent ?? null });
  return { ok: true };
}

export async function rejectSubstitution(args: { workspaceId: string; orderId: string; substitutionId: string; actorUserId: string; reason?: string | null; ip?: string | null; userAgent?: string | null }): Promise<{ ok: boolean; error?: string }> {
  const sub = (await query<{ status: string; substitution_number: string }>(sql`SELECT status, substitution_number FROM substitutions WHERE id = ${args.substitutionId}::uuid AND workspace_id = ${args.workspaceId}::uuid LIMIT 1`))[0];
  if (!sub) return { ok: false, error: 'not_found' };
  if (sub.status !== 'pending_approval' && sub.status !== 'proposed') return { ok: false, error: 'not_rejectable' };
  await sql`UPDATE substitutions SET status = 'rejected', rejected_reason = ${args.reason ?? null}::text, updated_at = now() WHERE id = ${args.substitutionId}::uuid AND workspace_id = ${args.workspaceId}::uuid`;
  await audit({ workspaceId: args.workspaceId, actorUserId: args.actorUserId, eventType: 'substitutions.rejected', targetType: 'substitution', targetId: args.substitutionId, payload: { order_id: args.orderId, substitution_number: sub.substitution_number, reason: args.reason ?? null }, ipAddress: args.ip ?? null, userAgent: args.userAgent ?? null });
  return { ok: true };
}
