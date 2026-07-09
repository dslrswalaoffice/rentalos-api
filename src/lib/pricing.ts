// ============================================================================
// src/lib/pricing.ts — Order pricing engine (Sub-turn 2.1a)
// ----------------------------------------------------------------------------
// Two public functions:
//   * computeBillableDays()  — pure: rental window + billing rules -> day count
//   * recomputeOrderTotals() — reads an order's line items, recomputes each
//     auto-priced line, manages the auto GST line, and refreshes the order's
//     cached totals (subtotal/tax/discount/total/balance). Idempotent: calling
//     it twice with nothing stale is a no-op and returns { changed: false }.
//
// All business rules (rounding, grace, minimum days, GST) come from
// workspace.settings — never hardcoded. Defaults are only fallbacks for a
// workspace missing a settings key.
//
// CONCURRENCY: the Neon HTTP driver has no cross-statement transactions, so two
// concurrent mutations on the same order can race and both write totals from a
// stale read. Worst case is a stale cached total, self-correcting on the next
// recompute (or an explicit POST /api/orders/:id/recompute). We deliberately do
// NOT lock here — accept the small window for now.
// ============================================================================

import { sql, query } from '../db.js';

export type BillingSettings = {
  rounding_rule: '24_hour_windows' | 'calendar_day'; // only 24_hour_windows implemented in 2.1a
  grace_period_hours: number;
  minimum_days: number;
  day_cutoff_time?: string; // reserved for calendar_day rule, unused now
};

export type TaxSettings = {
  default_gst_percent: number;
  charge_gst_by_default: boolean;
};

// Re-declared to match the shapes in src/routes/orders.ts (not exported there).
// Keep these in sync if the order/order_items columns change.
export type OrderRow = {
  id: string;
  workspace_id: string;
  order_number: number;
  customer_person_id: string;
  status: string;
  rental_start: string | null;
  rental_end: string | null;
  dispatch_type: string;
  delivery_address: string | null;
  channel: string;
  subtotal_paise: number;
  tax_paise: number;
  discount_paise: number;
  total_paise: number;
  deposit_paise: number;
  paid_paise: number;
  balance_paise: number;
  gst_state: string | null;
  notes: string | null;
  internal_notes: string | null;
  created_by: string | null;
  created_at: string;
  updated_at: string;
  deleted_at: string | null;
  customer_name?: string;
  customer_phone?: string;
  customer_email?: string | null;
  person_default_gst_state?: string | null;
};

export type OrderItemType =
  | 'rental' | 'delivery_fee' | 'late_fee' | 'damage'
  | 'discount' | 'tax' | 'deposit' | 'other';

export type OrderItemRow = {
  id: string;
  order_id: string;
  workspace_id: string;
  parent_item_id: string | null;
  item_type: string;
  product_id: string | null;
  description: string;
  quantity: number;
  daily_rate_paise: number | null;
  billable_days: number | null;
  unit_amount_paise: number;
  total_amount_paise: number;
  manual_price: boolean;
  status: string;
  dispatched_at: string | null;
  returned_at: string | null;
  condition_notes: string | null;
  chargeable_paise: number;
  cgst_paise: number;
  sgst_paise: number;
  igst_paise: number;
  sort_order: number;
  created_at: string;
  updated_at: string;
  product_name?: string | null;
  product_sku?: string | null;
};

const DEFAULT_BILLING: BillingSettings = {
  rounding_rule: '24_hour_windows',
  grace_period_hours: 0,
  minimum_days: 1,
};

const DEFAULT_TAX: TaxSettings = {
  default_gst_percent: 18,
  charge_gst_by_default: false,
};

// Line types that make up the pre-tax subtotal.
const SUBTOTAL_TYPES = new Set(['rental', 'delivery_fee', 'late_fee', 'damage', 'other']);

// Sentinel sort order so the auto GST line always renders last.
const AUTO_TAX_SORT_ORDER = 9999;

// ----------------------------------------------------------------------------
// computeBillableDays — 24_hour_windows with grace, rounded up, minimum enforced
// ----------------------------------------------------------------------------
export function computeBillableDays(
  rentalStart: Date,
  rentalEnd: Date,
  billingSettings: BillingSettings,
): number {
  if (billingSettings.rounding_rule === 'calendar_day') {
    throw new Error('calendar_day rounding not yet implemented');
  }

  const grace = billingSettings.grace_period_hours ?? 0;
  const minDays = billingSettings.minimum_days ?? 1;

  const hoursBetween = (rentalEnd.getTime() - rentalStart.getTime()) / 3_600_000;
  const effectiveHours = Math.max(0, hoursBetween - grace);
  const rawDays = Math.ceil(effectiveHours / 24);
  return Math.max(minDays, rawDays);
}

// ----------------------------------------------------------------------------
// GST helpers (Sub-turn 2.4a-endpoints)
// ----------------------------------------------------------------------------
// Only these line types are taxable. discount / tax / deposit get no breakdown.
const TAXABLE_ITEM_TYPES = new Set(['rental', 'delivery_fee', 'late_fee', 'damage', 'other']);

// Fallback chain: per-order override → customer's registered state → workspace
// place-of-supply → null.
export function resolveGstState(args: {
  orderState: string | null;
  personDefaultState: string | null;
  workspacePlaceOfSupply: string | null;
}): string | null {
  return args.orderState ?? args.personDefaultState ?? args.workspacePlaceOfSupply ?? null;
}

// Per-line GST split. Intra-state → CGST+SGST (each ~half); inter-state → IGST.
// Non-taxable types and a disabled feature flag yield all zeros.
export function computeLineTax(args: {
  chargeablePaise: number;
  itemType: OrderItemType | string;
  isIntraState: boolean;
  taxPct: number;
  featureFlagOn: boolean;
}): { cgst_paise: number; sgst_paise: number; igst_paise: number } {
  const zero = { cgst_paise: 0, sgst_paise: 0, igst_paise: 0 };
  if (!args.featureFlagOn) return zero;
  if (!TAXABLE_ITEM_TYPES.has(args.itemType)) return zero;
  const base = args.chargeablePaise;
  if (base <= 0 || args.taxPct <= 0) return zero;

  const lineTaxTotal = Math.floor((base * args.taxPct) / 100);
  if (args.isIntraState) {
    const cgst = Math.floor((base * args.taxPct) / 200); // half the total tax
    const sgst = lineTaxTotal - cgst;                    // remainder absorbs rounding drift
    return { cgst_paise: cgst, sgst_paise: sgst, igst_paise: 0 };
  }
  return { cgst_paise: 0, sgst_paise: 0, igst_paise: lineTaxTotal };
}

// ----------------------------------------------------------------------------
// Settings helpers
// ----------------------------------------------------------------------------
function readBilling(settings: unknown): BillingSettings {
  const b = (settings as Record<string, unknown> | null)?.['billing'] as
    | Partial<BillingSettings>
    | undefined;
  return {
    rounding_rule: (b?.rounding_rule as BillingSettings['rounding_rule']) ?? DEFAULT_BILLING.rounding_rule,
    grace_period_hours:
      typeof b?.grace_period_hours === 'number' ? b.grace_period_hours : DEFAULT_BILLING.grace_period_hours,
    minimum_days: typeof b?.minimum_days === 'number' ? b.minimum_days : DEFAULT_BILLING.minimum_days,
    day_cutoff_time: b?.day_cutoff_time,
  };
}

function readTax(settings: unknown): TaxSettings {
  const t = (settings as Record<string, unknown> | null)?.['tax'] as Partial<TaxSettings> | undefined;
  return {
    default_gst_percent:
      typeof t?.default_gst_percent === 'number' ? t.default_gst_percent : DEFAULT_TAX.default_gst_percent,
    charge_gst_by_default:
      typeof t?.charge_gst_by_default === 'boolean' ? t.charge_gst_by_default : DEFAULT_TAX.charge_gst_by_default,
  };
}

// ----------------------------------------------------------------------------
// Load helpers (self-contained — the orders route types aren't exported)
// ----------------------------------------------------------------------------
async function loadOrderRaw(orderId: string, workspaceId: string): Promise<OrderRow | null> {
  const rows = await query<OrderRow>(sql`
    SELECT
      o.*,
      p.display_name       AS customer_name,
      p.phone              AS customer_phone,
      p.email              AS customer_email,
      p.default_gst_state  AS person_default_gst_state
    FROM orders o
    JOIN people p ON p.id = o.customer_person_id
    WHERE o.id = ${orderId}::uuid
      AND o.workspace_id = ${workspaceId}::uuid
    LIMIT 1
  `);
  return rows[0] ?? null;
}

async function loadItems(orderId: string, workspaceId: string): Promise<OrderItemRow[]> {
  return await query<OrderItemRow>(sql`
    SELECT
      oi.*,
      pr.name AS product_name,
      pr.sku  AS product_sku
    FROM order_items oi
    LEFT JOIN products pr ON pr.id = oi.product_id
    WHERE oi.order_id = ${orderId}::uuid
      AND oi.workspace_id = ${workspaceId}::uuid
    ORDER BY oi.sort_order ASC, oi.created_at ASC
  `);
}

// ----------------------------------------------------------------------------
// recomputeOrderTotals — the heart of the engine
// ----------------------------------------------------------------------------
export async function recomputeOrderTotals(
  orderId: string,
  workspaceId: string,
  actorUserId: string,
): Promise<{ order: OrderRow; items: OrderItemRow[]; changed: boolean }> {
  const order = await loadOrderRaw(orderId, workspaceId);
  if (!order || order.deleted_at) {
    throw new Error('not_found');
  }
  if (order.status === 'closed' || order.status === 'cancelled') {
    throw new Error('order_locked');
  }

  // Load workspace billing + tax settings (with fallbacks) + GST context.
  const wsRows = await query<{ settings: unknown; place_of_supply: string | null }>(sql`
    SELECT settings, place_of_supply FROM workspaces WHERE id = ${workspaceId}::uuid LIMIT 1
  `);
  const billing = readBilling(wsRows[0]?.settings);
  const tax = readTax(wsRows[0]?.settings);
  const workspacePlaceOfSupply = wsRows[0]?.place_of_supply ?? null;
  const features = (wsRows[0]?.settings as Record<string, unknown> | null)?.['features'] as
    | Record<string, unknown>
    | undefined;
  const gstSplitOn = features?.['gst_split_cgst_sgst_igst'] === true;

  // GST state resolution (order override → person default → workspace place).
  const resolvedState = resolveGstState({
    orderState: order.gst_state,
    personDefaultState: order.person_default_gst_state ?? null,
    workspacePlaceOfSupply,
  });
  const isIntraState = resolvedState !== null && resolvedState === workspacePlaceOfSupply;

  // Billable days — null when the rental window is incomplete (skip rental recompute).
  let billableDays: number | null = null;
  if (order.rental_start && order.rental_end) {
    billableDays = computeBillableDays(new Date(order.rental_start), new Date(order.rental_end), billing);
  }

  const items = await loadItems(orderId, workspaceId);

  let changed = false;

  // --- Per-line recompute (everything except the auto GST line) ---------------
  let subtotalPaise = 0;
  let discountRaw = 0;
  let manualTaxSum = 0;
  let lineTaxSum = 0; // sum of per-line cgst+sgst+igst (used when GST split is on)

  for (const item of items) {
    const qty = Number(item.quantity);
    const unit = Number(item.unit_amount_paise);
    const storedTotal = Number(item.total_amount_paise);

    // The auto-managed GST line is handled entirely in the tax step below.
    if (item.item_type === 'tax' && !item.manual_price) {
      continue;
    }

    let desiredTotal = storedTotal;
    let desiredBillableDays = item.billable_days;

    if (item.item_type === 'rental' && !item.manual_price) {
      if (billableDays === null) {
        // Incomplete rental window — leave the line's total untouched.
        desiredTotal = storedTotal;
      } else {
        const rate = Number(item.daily_rate_paise ?? 0);
        desiredTotal = qty * rate * billableDays;
        desiredBillableDays = billableDays;
      }
    } else if (item.item_type === 'tax' && item.manual_price) {
      // Operator-entered tax line — leave exactly as-is.
      desiredTotal = storedTotal;
    } else {
      // rental (manual), delivery_fee, late_fee, damage, discount, deposit, other
      desiredTotal = unit * qty;
    }

    // Chargeable amount (status-adjusted). Only rental waivers zero it out;
    // every other line's chargeable equals its gross total.
    const chargeable =
      item.item_type === 'rental' && item.status === 'not_returned_non_chargeable'
        ? 0
        : desiredTotal;

    // Per-line GST breakdown (all zeros unless the split feature is on).
    const { cgst_paise, sgst_paise, igst_paise } = computeLineTax({
      chargeablePaise: chargeable,
      itemType: item.item_type,
      isIntraState,
      taxPct: tax.default_gst_percent,
      featureFlagOn: gstSplitOn,
    });

    // Persist the line only if something actually moved.
    const billableChanged = (desiredBillableDays ?? null) !== (item.billable_days ?? null);
    const chargeableChanged = chargeable !== Number(item.chargeable_paise);
    const taxChanged =
      cgst_paise !== Number(item.cgst_paise) ||
      sgst_paise !== Number(item.sgst_paise) ||
      igst_paise !== Number(item.igst_paise);
    if (desiredTotal !== storedTotal || billableChanged || chargeableChanged || taxChanged) {
      await sql`
        UPDATE order_items SET
          total_amount_paise = ${desiredTotal}::bigint,
          billable_days      = ${desiredBillableDays ?? null}::int,
          chargeable_paise   = ${chargeable}::bigint,
          cgst_paise         = ${cgst_paise}::bigint,
          sgst_paise         = ${sgst_paise}::bigint,
          igst_paise         = ${igst_paise}::bigint,
          updated_at         = now()
        WHERE id = ${item.id}::uuid
          AND workspace_id = ${workspaceId}::uuid
      `;
      changed = true;
    }

    lineTaxSum += cgst_paise + sgst_paise + igst_paise;

    // Roll the fresh (desired) value into the aggregates.
    if (SUBTOTAL_TYPES.has(item.item_type)) {
      subtotalPaise += desiredTotal;
    } else if (item.item_type === 'discount') {
      discountRaw += desiredTotal;
    } else if (item.item_type === 'tax') {
      // Only manual tax rows reach here; auto rows were skipped above.
      manualTaxSum += desiredTotal;
    }
    // 'deposit' lines are computed but excluded from subtotal/tax/total.
  }

  const discountPaise = Math.abs(discountRaw);
  const taxableBase = subtotalPaise - discountPaise;

  // --- Tax --------------------------------------------------------------------
  // Two mutually-exclusive models:
  //   * GST split ON  (feature flag) — tax lives in per-line cgst/sgst/igst; the
  //     order tax is their sum. No standalone auto-tax line (remove a stale one).
  //   * GST split OFF — legacy auto-managed single tax line driven by
  //     charge_gst_by_default. Preserved exactly as before.
  const autoTaxRow = items.find((i) => i.item_type === 'tax' && !i.manual_price) ?? null;
  let autoTaxAmount = 0;
  let taxPaise: number;

  if (gstSplitOn) {
    if (autoTaxRow) {
      // Split took over — drop a leftover auto-tax line from the legacy model.
      await sql`
        DELETE FROM order_items
        WHERE id = ${autoTaxRow.id}::uuid
          AND workspace_id = ${workspaceId}::uuid
          AND manual_price = false
      `;
      changed = true;
    }
    taxPaise = lineTaxSum + manualTaxSum;
  } else {
    if (tax.charge_gst_by_default) {
      autoTaxAmount = Math.round((taxableBase * tax.default_gst_percent) / 100);
      const description = `GST @ ${tax.default_gst_percent}%`;

      if (autoTaxRow) {
        const needsUpdate =
          Number(autoTaxRow.unit_amount_paise) !== autoTaxAmount ||
          Number(autoTaxRow.total_amount_paise) !== autoTaxAmount ||
          Number(autoTaxRow.quantity) !== 1 ||
          autoTaxRow.description !== description;
        if (needsUpdate) {
          await sql`
            UPDATE order_items SET
              description        = ${description}::text,
              quantity           = 1,
              unit_amount_paise  = ${autoTaxAmount}::bigint,
              total_amount_paise = ${autoTaxAmount}::bigint,
              updated_at         = now()
            WHERE id = ${autoTaxRow.id}::uuid
              AND workspace_id = ${workspaceId}::uuid
          `;
          changed = true;
        }
      } else {
        await sql`
          INSERT INTO order_items (
            workspace_id, order_id, item_type, description, quantity,
            daily_rate_paise, billable_days, unit_amount_paise, total_amount_paise,
            manual_price, sort_order
          ) VALUES (
            ${workspaceId}::uuid,
            ${orderId}::uuid,
            'tax'::order_item_type,
            ${description}::text,
            1,
            NULL,
            NULL,
            ${autoTaxAmount}::bigint,
            ${autoTaxAmount}::bigint,
            false,
            ${AUTO_TAX_SORT_ORDER}
          )
        `;
        changed = true;
      }
    } else if (autoTaxRow) {
      // GST turned off for this workspace — remove the auto line (never manual ones).
      await sql`
        DELETE FROM order_items
        WHERE id = ${autoTaxRow.id}::uuid
          AND workspace_id = ${workspaceId}::uuid
          AND manual_price = false
      `;
      changed = true;
    }
    taxPaise = manualTaxSum + autoTaxAmount;
  }

  // --- Cached order totals ----------------------------------------------------
  const totalPaise = subtotalPaise - discountPaise + taxPaise;
  const balancePaise = totalPaise - Number(order.paid_paise);

  const oldTotals = {
    subtotal_paise: Number(order.subtotal_paise),
    tax_paise: Number(order.tax_paise),
    discount_paise: Number(order.discount_paise),
    total_paise: Number(order.total_paise),
    balance_paise: Number(order.balance_paise),
  };
  const newTotals = {
    subtotal_paise: subtotalPaise,
    tax_paise: taxPaise,
    discount_paise: discountPaise,
    total_paise: totalPaise,
    balance_paise: balancePaise,
  };

  const totalsChanged =
    oldTotals.subtotal_paise !== newTotals.subtotal_paise ||
    oldTotals.tax_paise !== newTotals.tax_paise ||
    oldTotals.discount_paise !== newTotals.discount_paise ||
    oldTotals.total_paise !== newTotals.total_paise ||
    oldTotals.balance_paise !== newTotals.balance_paise;

  if (totalsChanged) {
    await sql`
      UPDATE orders SET
        subtotal_paise = ${subtotalPaise}::bigint,
        tax_paise      = ${taxPaise}::bigint,
        discount_paise = ${discountPaise}::bigint,
        total_paise    = ${totalPaise}::bigint,
        balance_paise  = ${balancePaise}::bigint,
        updated_at     = now()
      WHERE id = ${orderId}::uuid
        AND workspace_id = ${workspaceId}::uuid
    `;
    changed = true;
  }

  // --- Timeline event (order_events only — NOT audit_events) ------------------
  if (changed) {
    const payload: Record<string, unknown> = { old: oldTotals, new: newTotals };
    await sql`
      INSERT INTO order_events
        (workspace_id, order_id, event_type, from_status, to_status, payload, actor_user_id)
      VALUES (
        ${workspaceId}::uuid,
        ${orderId}::uuid,
        'order.pricing.recomputed',
        ${order.status}::order_status,
        ${order.status}::order_status,
        ${JSON.stringify(payload)}::jsonb,
        ${actorUserId}::uuid
      )
    `;
  }

  // Return fresh, joined shapes for the response.
  const freshOrder = (await loadOrderRaw(orderId, workspaceId))!;
  const freshItems = await loadItems(orderId, workspaceId);

  return { order: freshOrder, items: freshItems, changed };
}
