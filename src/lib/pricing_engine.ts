// ============================================================================
// src/lib/pricing_engine.ts  (Sub-turn 13, chunk 3)
// ----------------------------------------------------------------------------
// The rental pricing engine. Pure functions — no DB. Given a product's pricing
// config, the rental window, quantity, and workspace billing settings, it
// produces the line total in paise plus a full SNAPSHOT of how it got there.
//
// The pipeline (spec §C), in this exact order:
//   rental window
//     → charge-period rules  (exclude_pickup_day | exclude_return_day |
//        cap_at_one_day)  ── RUN FIRST, they change the chargeable period count
//     → pricing method (fixed_fee | fixed_price | structure)  → base line price
//     → adjust_price rules  (additive when stacking=false, compounding when true)
//     → line total
//
// Non-negotiable semantics:
//   * Rounding is UP. 25h at ₹500/day = 2 days = ₹1,000. Grace shaves the tail.
//   * cap_at_one_day runs BEFORE tier selection, so a Fri→Mon weekend collapses
//     to the 1-DAY tier, not the 3-day tier. (Gotcha #1 — the expensive mistake.)
//   * Rules are ALL-OR-NOTHING, never pro-rated: if any part of the window
//     matches a rule, it applies to the whole line.
//   * Money is integer paise. Multipliers are the only non-integers, and every
//     product of a multiplier is floored back to paise immediately.
// ============================================================================

export type ChargePeriod = 'hour' | 'day' | 'week' | 'month';
export type PricingMethod = 'fixed_fee' | 'fixed_price' | 'structure';

// Hours per charge period. `month` is the 30-day approximation (documented) —
// DSLRSWALA rents by the day; sub-day/monthly precision can refine later.
const PERIOD_HOURS: Record<ChargePeriod, number> = { hour: 1, day: 24, week: 168, month: 720 };

export type PricingTier = {
  id: string;
  duration_value: number;
  duration_period: ChargePeriod;
  multiplier: number;
  sort_order: number;
};

export type PricingStructure = {
  id: string;
  name: string;
  overflow_period: ChargePeriod | null;
  overflow_multiplier: number | null;
  tiers: PricingTier[];
};

export type PricingRule = {
  id: string;
  name: string;
  kind: 'adjust_charge_period' | 'adjust_price';
  sort_order: number;
  days_of_week: number[] | null;
  date_from: string | null;
  date_until: string | null;
  time_from: string | null; // 'HH:MM' or 'HH:MM:SS'
  time_until: string | null;
  price_adjustment_bps: number | null;
  charge_period_action: 'exclude_pickup_day' | 'exclude_return_day' | 'cap_at_one_day' | null;
};

export type PricingRuleset = {
  id: string;
  name: string;
  stacking: boolean;
  rules: PricingRule[];
};

export type PriceInput = {
  method: PricingMethod;
  basePaise: number;           // product.base_price_paise
  chargePeriod: ChargePeriod;  // product.charge_period (unit for fixed_fee/structure)
  quantity: number;
  start: Date;
  end: Date;
  structure?: PricingStructure | null;
  ruleset?: PricingRuleset | null;
  graceHours?: number;         // workspace settings.billing.grace_period_hours
  minimumPeriods?: number;     // workspace settings.billing.minimum_days (in charge-period units)
};

export type AppliedRule = { id: string; name: string; kind: string; effect: string };

export type PriceResult = {
  lineTotalPaise: number;
  periodsCharged: number;      // e.g. 2 (days) after charge-period rules
  periodUnit: ChargePeriod;
  method: PricingMethod;
  tierId: string | null;
  rulesApplied: AppliedRule[];
  explain: Record<string, unknown>;
};

// ----------------------------------------------------------------------------
// Duration: rental window → count of charge-period units, grace-shaved, UP.
// ----------------------------------------------------------------------------
export function periodsBetween(
  start: Date,
  end: Date,
  period: ChargePeriod,
  graceHours = 0,
  minimumPeriods = 1,
): number {
  const ms = end.getTime() - start.getTime();
  if (!(ms > 0)) return Math.max(minimumPeriods, 0);
  const hours = ms / 3_600_000;
  const unitHours = PERIOD_HOURS[period];
  // Grace shaves the tail: 26h with 2h grace = 24h = 1 day, not 2.
  const effective = Math.max(0, hours - Math.max(0, graceHours));
  const count = Math.ceil(effective / unitHours);
  return Math.max(count, Math.max(1, minimumPeriods));
}

// Every day (calendar date) the window touches, as 0=Sun..6=Sat. Used for
// all-or-nothing day-of-week matching.
function daysOfWeekTouched(start: Date, end: Date): Set<number> {
  const out = new Set<number>();
  const cur = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()));
  const last = new Date(Date.UTC(end.getUTCFullYear(), end.getUTCMonth(), end.getUTCDate()));
  // Guard against pathological ranges.
  let guard = 0;
  while (cur.getTime() <= last.getTime() && guard < 4000) {
    out.add(cur.getUTCDay());
    cur.setUTCDate(cur.getUTCDate() + 1);
    guard++;
  }
  return out;
}

// Does a rule's WHEN clause intersect the window? All-or-nothing: any overlap
// on any configured dimension counts. Unset dimensions are wildcards.
function ruleApplies(rule: PricingRule, start: Date, end: Date): boolean {
  // day-of-week
  if (rule.days_of_week && rule.days_of_week.length) {
    const touched = daysOfWeekTouched(start, end);
    if (![...rule.days_of_week].some((d) => touched.has(d))) return false;
  }
  // seasonal date range — window must intersect [date_from, date_until]
  if (rule.date_from || rule.date_until) {
    const from = rule.date_from ? new Date(rule.date_from + 'T00:00:00Z').getTime() : -Infinity;
    const until = rule.date_until ? new Date(rule.date_until + 'T23:59:59Z').getTime() : Infinity;
    if (end.getTime() < from || start.getTime() > until) return false;
  }
  // time-of-day — interpreted against the PICKUP time (e.g. 'picked up after 16:00')
  if (rule.time_from || rule.time_until) {
    const mins = start.getUTCHours() * 60 + start.getUTCMinutes();
    const toM = (t: string) => {
      const [h, m] = t.split(':');
      return Number(h) * 60 + Number(m ?? 0);
    };
    if (rule.time_from && mins < toM(rule.time_from)) return false;
    if (rule.time_until && mins > toM(rule.time_until)) return false;
  }
  return true;
}

// ----------------------------------------------------------------------------
// Charge-period rules — run FIRST, mutate the period count.
// ----------------------------------------------------------------------------
function applyChargePeriodRules(
  periods: number,
  rules: PricingRule[],
  start: Date,
  end: Date,
  applied: AppliedRule[],
): number {
  let n = periods;
  for (const r of rules) {
    if (r.kind !== 'adjust_charge_period' || !r.charge_period_action) continue;
    if (!ruleApplies(r, start, end)) continue;
    const before = n;
    if (r.charge_period_action === 'cap_at_one_day') n = Math.min(n, 1);
    else if (r.charge_period_action === 'exclude_pickup_day') n = Math.max(1, n - 1);
    else if (r.charge_period_action === 'exclude_return_day') n = Math.max(1, n - 1);
    if (n !== before) {
      applied.push({ id: r.id, name: r.name, kind: r.kind, effect: `${r.charge_period_action}: ${before}→${n}` });
    }
  }
  return n;
}

// ----------------------------------------------------------------------------
// Structure: pick the tier for `periods` (ROUND UP to the next tier), multiply
// the base. Beyond the last tier, the overflow rate applies per extra period.
// Tiers are assumed in the product's charge-period unit (duration_period).
// ----------------------------------------------------------------------------
function priceStructure(
  basePaise: number,
  periods: number,
  structure: PricingStructure,
  explain: Record<string, unknown>,
): { total: number; tierId: string | null } {
  const tiers = [...structure.tiers].sort((a, b) => a.duration_value - b.duration_value);
  if (tiers.length === 0) return { total: basePaise * periods, tierId: null };

  // Round UP to the first tier whose duration_value >= periods.
  const tier = tiers.find((t) => t.duration_value >= periods);
  if (tier) {
    const total = Math.floor(basePaise * tier.multiplier);
    explain.tier = { duration_value: tier.duration_value, multiplier: tier.multiplier };
    return { total, tierId: tier.id };
  }

  // Beyond the last tier: last tier price + overflow per extra period.
  const last = tiers[tiers.length - 1]!;
  const extra = periods - last.duration_value;
  const overflowMult = structure.overflow_multiplier ?? 0;
  const lastPrice = Math.floor(basePaise * last.multiplier);
  const overflowPrice = Math.floor(basePaise * overflowMult) * Math.max(0, extra);
  explain.tier = { duration_value: last.duration_value, multiplier: last.multiplier, overflow_periods: extra, overflow_multiplier: overflowMult };
  return { total: lastPrice + overflowPrice, tierId: last.id };
}

// ----------------------------------------------------------------------------
// adjust_price rules → a final factor. Additive when stacking=false, compounding
// (top-down by sort_order) when true. bps: +2000 = +20%, -1000 = -10%.
// Returns the adjusted total (floored to paise).
// ----------------------------------------------------------------------------
function applyPriceRules(
  subtotal: number,
  ruleset: PricingRuleset,
  start: Date,
  end: Date,
  applied: AppliedRule[],
): number {
  const priceRules = ruleset.rules
    .filter((r) => r.kind === 'adjust_price' && r.price_adjustment_bps != null && ruleApplies(r, start, end))
    .sort((a, b) => a.sort_order - b.sort_order);
  if (priceRules.length === 0) return subtotal;

  if (!ruleset.stacking) {
    // Additive: sum the bps, apply once.
    const sumBps = priceRules.reduce((s, r) => s + (r.price_adjustment_bps ?? 0), 0);
    priceRules.forEach((r) => applied.push({ id: r.id, name: r.name, kind: r.kind, effect: `${(r.price_adjustment_bps ?? 0) / 100}%` }));
    return Math.floor((subtotal * (10000 + sumBps)) / 10000);
  }
  // Compounding: apply each in order.
  let total = subtotal;
  for (const r of priceRules) {
    total = Math.floor((total * (10000 + (r.price_adjustment_bps ?? 0))) / 10000);
    applied.push({ id: r.id, name: r.name, kind: r.kind, effect: `×(1${(r.price_adjustment_bps ?? 0) >= 0 ? '+' : ''}${(r.price_adjustment_bps ?? 0) / 10000})` });
  }
  return total;
}

// ----------------------------------------------------------------------------
// THE entry point. Returns the line total (× quantity) + the snapshot.
// ----------------------------------------------------------------------------
export function computeLinePrice(input: PriceInput): PriceResult {
  const applied: AppliedRule[] = [];
  const explain: Record<string, unknown> = {};
  const qty = Math.max(1, input.quantity);

  // fixed_price: one flat charge regardless of duration (still × quantity).
  if (input.method === 'fixed_price') {
    const perUnit = input.basePaise;
    explain.method = 'fixed_price';
    // adjust_price rules still apply to a fixed_price line.
    let perUnitAdj = perUnit;
    if (input.ruleset) perUnitAdj = applyPriceRules(perUnit, input.ruleset, input.start, input.end, applied);
    return {
      lineTotalPaise: perUnitAdj * qty,
      periodsCharged: 1,
      periodUnit: input.chargePeriod,
      method: 'fixed_price',
      tierId: null,
      rulesApplied: applied,
      explain,
    };
  }

  // Duration in charge-period units, then charge-period rules (FIRST).
  let periods = periodsBetween(input.start, input.end, input.chargePeriod, input.graceHours ?? 0, input.minimumPeriods ?? 1);
  explain.raw_periods = periods;
  if (input.ruleset) {
    periods = applyChargePeriodRules(periods, input.ruleset.rules, input.start, input.end, applied);
  }
  explain.charged_periods = periods;

  // Base line price via method.
  let perUnit: number;
  let tierId: string | null = null;
  if (input.method === 'structure' && input.structure) {
    const r = priceStructure(input.basePaise, periods, input.structure, explain);
    perUnit = r.total;
    tierId = r.tierId;
    explain.method = 'structure';
  } else {
    // fixed_fee: rate × periods.
    perUnit = input.basePaise * periods;
    explain.method = 'fixed_fee';
  }

  // adjust_price rules on the base line price.
  if (input.ruleset) perUnit = applyPriceRules(perUnit, input.ruleset, input.start, input.end, applied);

  return {
    lineTotalPaise: perUnit * qty,
    periodsCharged: periods,
    periodUnit: input.chargePeriod,
    method: input.method,
    tierId,
    rulesApplied: applied,
    explain,
  };
}
