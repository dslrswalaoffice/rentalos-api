// ============================================================================
// src/lib/aggregate_status.ts (Slice 1) — derive an order's AGGREGATE status
// ----------------------------------------------------------------------------
// order.status is a single coarse enum; the truth of "where is this order right
// now" lives in the per-item micro-lifecycle (order_items.status). This derives a
// richer aggregate_status + aggregate_status_context from item-status counts, so
// the UI can render compound labels like "PARTIALLY DISPATCHED 3/5".
//
// Pure + side-effect free — used identically by GET /:id (from loaded items) and
// GET / (from a per-row LATERAL count). Passthrough for terminal/pre-dispatch
// order states; item-derived for anything mid-flight.
// ============================================================================

// Terminal item statuses (the item is done — returned, or accounted-for-not-returned).
export const TERMINAL_ITEM_STATUSES = [
  'returned',
  'returned_with_damage',
  'not_returned_chargeable',
  'not_returned_non_chargeable',
  'missing',
] as const;

export type AggregateInput = {
  order_status: string;
  total_rental: number;      // count of rental line items
  pending_dispatch: number;  // rental items still pending_dispatch
  dispatched: number;        // rental items currently dispatched (out)
  returned: number;          // rental items returned or returned_with_damage
  terminal: number;          // rental items in ANY terminal status
  has_assets: boolean;       // any order_assets pinned (allocation happened)
  payment_complete: boolean; // balance_paise <= 0
};

export type AggregateStatus = {
  aggregate_status: string;
  aggregate_status_context: { dispatched?: number; returned?: number; total: number } | null;
};

/**
 * Derive aggregate_status. Coarse pre-dispatch / terminal order states pass
 * through; confirmed → returned states are refined from item counts.
 */
export function deriveAggregateStatus(i: AggregateInput): AggregateStatus {
  const s = i.order_status;

  // Passthrough — nothing dispatched yet, or the order is already terminal.
  if (s === 'draft' || s === 'quoted' || s === 'cancelled' || s === 'closed') {
    return { aggregate_status: s, aggregate_status_context: null };
  }

  const total = i.total_rental;
  // A non-goods order (services only) has no dispatch lifecycle — pass through.
  if (total === 0) {
    return { aggregate_status: s === 'confirmed' ? 'confirmed' : s, aggregate_status_context: null };
  }

  // All items accounted for → awaiting inspection (still open) or ready to close.
  if (i.terminal === total) {
    if (i.payment_complete) {
      return { aggregate_status: 'ready_to_close', aggregate_status_context: { dispatched: i.dispatched, total } };
    }
    return { aggregate_status: 'awaiting_inspection', aggregate_status_context: { returned: i.returned, total } };
  }

  // Some back, some still out.
  if (i.returned > 0 && i.dispatched > 0) {
    return { aggregate_status: 'partial_return', aggregate_status_context: { returned: i.returned, total } };
  }

  // Dispatch progress.
  if (i.dispatched === total) {
    return { aggregate_status: 'fully_dispatched', aggregate_status_context: { dispatched: i.dispatched, total } };
  }
  if (i.dispatched > 0) {
    return { aggregate_status: 'partially_dispatched', aggregate_status_context: { dispatched: i.dispatched, total } };
  }

  // Nothing dispatched — confirmed, possibly allocated (units pinned).
  if (s === 'confirmed') {
    return { aggregate_status: i.has_assets ? 'allocated' : 'confirmed', aggregate_status_context: null };
  }
  return { aggregate_status: s, aggregate_status_context: null };
}

/**
 * Build the AggregateInput from a loaded order + its items + assets (GET /:id path).
 * `items` need only carry item_type + status; `order` needs status + balance_paise.
 */
export function aggregateInputFromLoaded(
  order: { status: string; balance_paise: number | string | null },
  items: { item_type: string; status: string }[],
  hasAssets: boolean,
): AggregateInput {
  const rental = items.filter((it) => it.item_type === 'rental');
  const count = (pred: (s: string) => boolean) => rental.filter((it) => pred(it.status)).length;
  return {
    order_status: order.status,
    total_rental: rental.length,
    pending_dispatch: count((s) => s === 'pending_dispatch'),
    dispatched: count((s) => s === 'dispatched'),
    returned: count((s) => s === 'returned' || s === 'returned_with_damage'),
    terminal: count((s) => (TERMINAL_ITEM_STATUSES as readonly string[]).includes(s)),
    has_assets: hasAssets,
    payment_complete: Number(order.balance_paise ?? 0) <= 0,
  };
}
