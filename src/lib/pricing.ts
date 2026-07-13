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
  // Sub-turn 13: the resolved-price snapshot. priced_inputs inside it is the
  // signature (dates + quantity) that produced the total; recompute keeps the
  // line untouched while the signature is unchanged.
  price_breakdown?: { priced_inputs?: { start: string; end: string; quantity: number } } | null;
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

import {
  computeLinePrice,
  type PricingMethod,
  type ChargePeriod,
  type PricingStructure,
  type PricingRuleset,
  type PriceResult,
} from './pricing_engine.js';

// Line types that make up the pre-tax subtotal.
const SUBTOTAL_TYPES = new Set(['rental', 'delivery_fee', 'late_fee', 'damage', 'other']);

// ----------------------------------------------------------------------------
// Pricing config loader (Sub-turn 13, chunk 3). Batched — 1 products query + 2
// for structures/tiers + 2 for rulesets/rules, regardless of line count (F2).
// The line's RATE is snapshotted on order_items.daily_rate_paise (immutable);
// method / charge_period / structure / ruleset are re-read here (config, not
// rate — changing them affects re-priced orders, documented).
// ----------------------------------------------------------------------------
type LinePricingConfig = {
  method: PricingMethod;
  chargePeriod: ChargePeriod;
  structure: PricingStructure | null;
  ruleset: PricingRuleset | null;
};

async function loadPricingConfigs(
  workspaceId: string,
  productIds: string[],
): Promise<Map<string, LinePricingConfig>> {
  const out = new Map<string, LinePricingConfig>();
  const ids = [...new Set(productIds.filter(Boolean))];
  if (ids.length === 0) return out;

  const prods = await query<{
    id: string; pricing_method: string; charge_period: string | null;
    pricing_structure_id: string | null; pricing_ruleset_id: string | null;
  }>(sql`
    SELECT id, pricing_method::text AS pricing_method, charge_period::text AS charge_period,
           pricing_structure_id, pricing_ruleset_id
    FROM products
    WHERE workspace_id = ${workspaceId}::uuid
      AND id::text = ANY(string_to_array(${ids.join(',')}::text, ','))
  `);

  const structureIds = [...new Set(prods.map((p) => p.pricing_structure_id).filter(Boolean) as string[])];
  const rulesetIds = [...new Set(prods.map((p) => p.pricing_ruleset_id).filter(Boolean) as string[])];

  const structures = new Map<string, PricingStructure>();
  if (structureIds.length) {
    const srows = await query<{ id: string; name: string; overflow_period: string | null; overflow_multiplier: string | number | null }>(sql`
      SELECT id, name, overflow_period::text AS overflow_period, overflow_multiplier
      FROM pricing_structures WHERE workspace_id = ${workspaceId}::uuid
        AND id::text = ANY(string_to_array(${structureIds.join(',')}::text, ','))
    `);
    for (const s of srows) structures.set(s.id, {
      id: s.id, name: s.name,
      overflow_period: (s.overflow_period as ChargePeriod | null) ?? null,
      overflow_multiplier: s.overflow_multiplier != null ? Number(s.overflow_multiplier) : null,
      tiers: [],
    });
    const trows = await query<{ id: string; structure_id: string; duration_value: number; duration_period: string; multiplier: string | number; sort_order: number }>(sql`
      SELECT id, structure_id, duration_value, duration_period::text AS duration_period, multiplier, sort_order
      FROM pricing_tiers WHERE structure_id::text = ANY(string_to_array(${structureIds.join(',')}::text, ','))
    `);
    for (const t of trows) structures.get(t.structure_id)?.tiers.push({
      id: t.id, duration_value: Number(t.duration_value),
      duration_period: t.duration_period as ChargePeriod, multiplier: Number(t.multiplier),
      sort_order: Number(t.sort_order),
    });
  }

  const rulesets = new Map<string, PricingRuleset>();
  if (rulesetIds.length) {
    const rrows = await query<{ id: string; name: string; stacking: boolean }>(sql`
      SELECT id, name, stacking FROM pricing_rulesets WHERE workspace_id = ${workspaceId}::uuid
        AND id::text = ANY(string_to_array(${rulesetIds.join(',')}::text, ','))
    `);
    for (const r of rrows) rulesets.set(r.id, { id: r.id, name: r.name, stacking: r.stacking, rules: [] });
    const prows = await query<{
      id: string; ruleset_id: string; name: string; kind: string; sort_order: number;
      days_of_week: number[] | null; date_from: string | null; date_until: string | null;
      time_from: string | null; time_until: string | null;
      price_adjustment_bps: number | null; charge_period_action: string | null;
    }>(sql`
      SELECT id, ruleset_id, name, kind::text AS kind, sort_order, days_of_week,
             date_from::text AS date_from, date_until::text AS date_until,
             time_from::text AS time_from, time_until::text AS time_until,
             price_adjustment_bps, charge_period_action
      FROM pricing_rules WHERE ruleset_id::text = ANY(string_to_array(${rulesetIds.join(',')}::text, ','))
    `);
    for (const p of prows) rulesets.get(p.ruleset_id)?.rules.push({
      id: p.id, name: p.name, kind: p.kind as PricingRuleset['rules'][number]['kind'],
      sort_order: Number(p.sort_order), days_of_week: p.days_of_week,
      date_from: p.date_from, date_until: p.date_until, time_from: p.time_from, time_until: p.time_until,
      price_adjustment_bps: p.price_adjustment_bps != null ? Number(p.price_adjustment_bps) : null,
      charge_period_action: p.charge_period_action as PricingRuleset['rules'][number]['charge_period_action'],
    });
  }

  for (const p of prods) out.set(p.id, {
    method: (p.pricing_method as PricingMethod) ?? 'fixed_fee',
    chargePeriod: (p.charge_period as ChargePeriod) ?? 'day',
    structure: p.pricing_structure_id ? structures.get(p.pricing_structure_id) ?? null : null,
    ruleset: p.pricing_ruleset_id ? rulesets.get(p.pricing_ruleset_id) ?? null : null,
  });
  return out;
}

// Sentinel sort order so the auto GST line always renders last.
const AUTO_TAX_SORT_ORDER = 9999;
// Discount line renders after real items but before the tax line (Sub-turn 8b).
const DISCOUNT_SORT_ORDER = 9000;

// ----------------------------------------------------------------------------
// Coupon discount (Sub-turn 8b)
// ----------------------------------------------------------------------------
// The active coupon redemption on an order (if any) drives a single 'discount'
// line, recomputed against the CURRENT subtotal on every recompute — so a
// percentage coupon stays correct after the rental window or items change.
// Returns 0 when there's no active redemption (or the coupon was deactivated).
async function resolveCouponDiscount(
  workspaceId: string,
  orderId: string,
  subtotalPaise: number,
): Promise<{ discountPaise: number; couponLabel: string }> {
  const rows = await query<{
    code: string; description: string | null; discount_type: string;
    discount_value: string | number; max_discount_paise: string | number | null;
  }>(sql`
    SELECT c.code, c.description, c.discount_type, c.discount_value, c.max_discount_paise
    FROM coupon_redemptions cr
    JOIN coupons c ON c.id = cr.coupon_id
    WHERE cr.order_id = ${orderId}::uuid
      AND cr.workspace_id = ${workspaceId}::uuid
      AND cr.removed_at IS NULL
      AND c.is_active = true
    LIMIT 1
  `);
  if (!rows.length) return { discountPaise: 0, couponLabel: '' };
  const c = rows[0]!;
  let discount = 0;
  if (c.discount_type === 'fixed') {
    discount = Number(c.discount_value);
  } else {
    discount = Math.floor((subtotalPaise * Number(c.discount_value)) / 100);
    if (c.max_discount_paise != null && discount > Number(c.max_discount_paise)) {
      discount = Number(c.max_discount_paise);
    }
  }
  // Never discount below zero or beyond the subtotal.
  discount = Math.max(0, Math.min(discount, subtotalPaise));
  const label = `Coupon ${c.code}${c.description ? ' — ' + c.description : ''}`;
  return { discountPaise: discount, couponLabel: label };
}

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
  opts?: { reprice?: boolean },
): Promise<{ order: OrderRow; items: OrderItemRow[]; changed: boolean }> {
  // reprice=true is the explicit "Recalculate prices" action — it re-runs the
  // engine for every rental line against the CURRENT config. Default false:
  // a line is only re-priced when its OWN inputs (dates/quantity) changed, so an
  // external structure/ruleset edit never rewrites an existing order's totals.
  const reprice = opts?.reprice === true;
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

  // Pricing configs for the rental lines' products (batched — F2-safe). Used by
  // the engine below; the line's snapshotted daily_rate_paise stays the base.
  const rentalProductIds = items
    .filter((it) => it.item_type === 'rental' && it.product_id)
    .map((it) => it.product_id as string);
  const pricingConfigs = await loadPricingConfigs(workspaceId, rentalProductIds);
  // Per-line engine snapshot to persist (only for lines actually re-priced).
  const pricedSnapshots = new Map<string, { priced: PriceResult; sig: { start: string; end: string; quantity: number } }>();

  let changed = false;

  // --- Per-line recompute (everything except the auto GST + discount lines) ---
  let subtotalPaise = 0;
  let manualTaxSum = 0;
  let lineTaxSum = 0; // sum of per-line cgst+sgst+igst (used when GST split is on)
  // The single coupon-managed discount line is reconciled AFTER the loop (its
  // amount depends on the subtotal computed here).
  let existingDiscountItem: OrderItemRow | null = null;

  for (const item of items) {
    const qty = Number(item.quantity);
    const unit = Number(item.unit_amount_paise);
    const storedTotal = Number(item.total_amount_paise);

    // The auto-managed GST line is handled entirely in the tax step below.
    if (item.item_type === 'tax' && !item.manual_price) {
      continue;
    }
    // The discount line is coupon-driven — reconciled post-loop (Sub-turn 8b).
    if (item.item_type === 'discount') {
      existingDiscountItem = item;
      continue;
    }

    let desiredTotal = storedTotal;
    let desiredBillableDays = item.billable_days;

    if (item.item_type === 'rental' && !item.manual_price) {
      if (billableDays === null || !order.rental_start || !order.rental_end) {
        // Incomplete rental window — leave the line's total untouched.
        desiredTotal = storedTotal;
      } else {
        // Sub-turn 13: re-price ONLY when THIS line's own inputs (the order
        // window + this line's quantity) changed, or on an explicit reprice.
        // Otherwise keep the snapshot — an external structure/ruleset edit must
        // not rewrite an existing order (Booqable's guarantee).
        const curSig = {
          start: new Date(order.rental_start).toISOString(),
          end: new Date(order.rental_end).toISOString(),
          quantity: qty,
        };
        const prevSig = item.price_breakdown?.priced_inputs ?? null;
        const inputsUnchanged =
          !!prevSig && prevSig.start === curSig.start && prevSig.end === curSig.end
          && Number(prevSig.quantity) === qty;

        if (!reprice && inputsUnchanged) {
          // Frozen snapshot.
          desiredTotal = storedTotal;
          desiredBillableDays = item.billable_days;
        } else {
          const cfg = item.product_id ? pricingConfigs.get(item.product_id) : undefined;
          const priced = computeLinePrice({
            method: cfg?.method ?? 'fixed_fee',
            basePaise: Number(item.daily_rate_paise ?? 0),
            chargePeriod: cfg?.chargePeriod ?? 'day',
            quantity: qty,
            start: new Date(order.rental_start),
            end: new Date(order.rental_end),
            structure: cfg?.structure ?? null,
            ruleset: cfg?.ruleset ?? null,
            graceHours: billing.grace_period_hours,
            minimumPeriods: billing.minimum_days,
          });
          desiredTotal = priced.lineTotalPaise;
          desiredBillableDays = priced.periodsCharged;
          pricedSnapshots.set(item.id, { priced, sig: curSig });
        }
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
    // Engine snapshot (Sub-turn 13). Present ONLY for lines actually re-priced
    // this pass — a frozen line's price_breakdown/priced_* are PRESERVED (the
    // CASE keeps the existing values), so a tax-only or unrelated recompute never
    // wipes the snapshot. hasSnap drives whether we set or keep the priced cols.
    const snap = pricedSnapshots.get(item.id) ?? null;
    const hasSnap = snap !== null;
    const breakdownJson = snap
      ? JSON.stringify({
          method: snap.priced.method,
          charge_period: snap.priced.periodUnit,
          periods_charged: snap.priced.periodsCharged,
          tier: (snap.priced.explain as Record<string, unknown>).tier ?? null,
          rules_applied: snap.priced.rulesApplied,
          priced_inputs: snap.sig,
        })
      : null;
    if (desiredTotal !== storedTotal || billableChanged || chargeableChanged || taxChanged || hasSnap) {
      await sql`
        UPDATE order_items SET
          total_amount_paise   = ${desiredTotal}::bigint,
          billable_days        = ${desiredBillableDays ?? null}::int,
          chargeable_paise     = ${chargeable}::bigint,
          cgst_paise           = ${cgst_paise}::bigint,
          sgst_paise           = ${sgst_paise}::bigint,
          igst_paise           = ${igst_paise}::bigint,
          priced_method        = CASE WHEN ${hasSnap}::boolean THEN ${snap ? snap.priced.method : null}::pricing_method ELSE priced_method END,
          priced_charge_period = CASE WHEN ${hasSnap}::boolean THEN ${snap ? snap.priced.periodUnit : null}::charge_period ELSE priced_charge_period END,
          priced_tier_id       = CASE WHEN ${hasSnap}::boolean THEN ${snap ? snap.priced.tierId : null}::uuid ELSE priced_tier_id END,
          price_breakdown      = CASE WHEN ${hasSnap}::boolean THEN ${breakdownJson}::jsonb ELSE price_breakdown END,
          updated_at           = now()
        WHERE id = ${item.id}::uuid
          AND workspace_id = ${workspaceId}::uuid
      `;
      changed = true;
    }

    lineTaxSum += cgst_paise + sgst_paise + igst_paise;

    // Roll the fresh (desired) value into the aggregates.
    if (SUBTOTAL_TYPES.has(item.item_type)) {
      subtotalPaise += desiredTotal;
    } else if (item.item_type === 'tax') {
      // Only manual tax rows reach here; auto rows were skipped above.
      manualTaxSum += desiredTotal;
    }
    // 'deposit' lines are computed but excluded from subtotal/tax/total.
  }

  // --- Coupon-managed discount line (Sub-turn 8b) -----------------------------
  // Compute the discount from the active coupon redemption against the just-
  // summed subtotal, then reconcile the single 'discount' order_items row. In
  // GST-split mode the discount line carries a NEGATIVE per-line tax so the
  // order tax lands on the discounted base (subtotal − discount); the legacy
  // single-tax model already nets the discount via `taxableBase`, so its
  // discount line stays tax-free.
  const { discountPaise, couponLabel } = await resolveCouponDiscount(
    workspaceId,
    orderId,
    subtotalPaise,
  );

  if (discountPaise <= 0) {
    if (existingDiscountItem) {
      await sql`
        DELETE FROM order_items
        WHERE id = ${existingDiscountItem.id}::uuid AND workspace_id = ${workspaceId}::uuid
      `;
      changed = true;
    }
  } else {
    const dTax = gstSplitOn
      ? computeLineTax({
          chargeablePaise: discountPaise,
          itemType: 'rental', // force a taxable computation; we negate it below
          isIntraState,
          taxPct: tax.default_gst_percent,
          featureFlagOn: true,
        })
      : { cgst_paise: 0, sgst_paise: 0, igst_paise: 0 };
    const negCgst = -dTax.cgst_paise;
    const negSgst = -dTax.sgst_paise;
    const negIgst = -dTax.igst_paise;
    const negTotal = -discountPaise;

    if (existingDiscountItem) {
      const needs =
        Number(existingDiscountItem.total_amount_paise) !== negTotal ||
        Number(existingDiscountItem.unit_amount_paise) !== negTotal ||
        Number(existingDiscountItem.chargeable_paise) !== negTotal ||
        Number(existingDiscountItem.cgst_paise) !== negCgst ||
        Number(existingDiscountItem.sgst_paise) !== negSgst ||
        Number(existingDiscountItem.igst_paise) !== negIgst ||
        existingDiscountItem.description !== couponLabel;
      if (needs) {
        await sql`
          UPDATE order_items SET
            description        = ${couponLabel}::text,
            quantity           = 1,
            unit_amount_paise  = ${negTotal}::bigint,
            total_amount_paise = ${negTotal}::bigint,
            chargeable_paise   = ${negTotal}::bigint,
            cgst_paise         = ${negCgst}::bigint,
            sgst_paise         = ${negSgst}::bigint,
            igst_paise         = ${negIgst}::bigint,
            updated_at         = now()
          WHERE id = ${existingDiscountItem.id}::uuid AND workspace_id = ${workspaceId}::uuid
        `;
        changed = true;
      }
    } else {
      await sql`
        INSERT INTO order_items (
          workspace_id, order_id, item_type, description, quantity,
          daily_rate_paise, billable_days, unit_amount_paise, total_amount_paise,
          chargeable_paise, cgst_paise, sgst_paise, igst_paise, manual_price, sort_order
        ) VALUES (
          ${workspaceId}::uuid, ${orderId}::uuid, 'discount'::order_item_type,
          ${couponLabel}::text, 1, NULL, NULL,
          ${negTotal}::bigint, ${negTotal}::bigint, ${negTotal}::bigint,
          ${negCgst}::bigint, ${negSgst}::bigint, ${negIgst}::bigint,
          false, ${DISCOUNT_SORT_ORDER}
        )
      `;
      changed = true;
    }
    lineTaxSum += negCgst + negSgst + negIgst;
  }

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
