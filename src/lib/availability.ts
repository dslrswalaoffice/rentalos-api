import { sql, query } from '../db.js';

// ============================================================================
// src/lib/availability.ts  (Sub-turn 4d-1)
// ----------------------------------------------------------------------------
// Single source of truth for "is this product available in this window?".
// Reused by POST /api/availability/check and by the calendar's overbook sweep.
//
// Product-level granularity: we sum rental quantities across overlapping
// orders for the product and compare against capacity (= COUNT(assets), there
// is no products.total_units column). Per-asset granularity is deferred until
// QR scanning ships.
//
// Warn, don't block: this computes conflicts, it never rejects anything. The
// caller decides what to do with a false `available`.
// ============================================================================

// Statuses that actually commit inventory. draft/quoted are not commitments;
// closed/cancelled are done. NOTE: the SQL below inlines this same list as a
// text literal (the Neon HTTP driver mis-serialises JS arrays cast to
// order_status[], per CLAUDE.md) — keep the two in sync.
export const RESERVING_STATUSES = [
  'confirmed',
  'dispatched',
  'active',
  'returned',
] as const;

const BUFFER_MIN_HOURS = 0;
const BUFFER_MAX_HOURS = 24;

/** Thrown when the product can't be found in the workspace. Callers map the
 *  `code` to an HTTP status (product_not_found → 404). */
export class AvailabilityError extends Error {
  constructor(public code: string) {
    super(code);
    this.name = 'AvailabilityError';
  }
}

export type AvailabilityConflict = {
  order_id: string;
  order_number: number;
  customer_name: string | null;
  quantity: number;
  start: string; // ISO
  end: string;   // ISO
  status: string;
};

export type AvailabilityResult = {
  available: boolean;
  requested: number;
  capacity: number;
  currently_booked: number;
  inactive_product?: boolean;
  conflicts: AvailabilityConflict[];
};

function clampBuffer(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(BUFFER_MAX_HOURS, Math.max(BUFFER_MIN_HOURS, n));
}

/**
 * Check product availability for a window. Applies the workspace's configured
 * buffer_hours by expanding the query window on both sides (buffer = prep /
 * cleaning time between rentals). Excludes an order's own bookings when
 * `excludeOrderId` is supplied (so editing an existing order doesn't conflict
 * with itself).
 */
export async function checkAvailability(args: {
  workspaceId: string;
  productId: string;
  quantity: number;
  start: Date;
  end: Date;
  excludeOrderId?: string;
}): Promise<AvailabilityResult> {
  // Capacity = count of live assets for the product. Also grab is_active so we
  // can flag (but still answer for) inactive products.
  const productRows = await query<{ total_units: number; is_active: boolean }>(sql`
    SELECT
      COALESCE(a.total, 0)::int AS total_units,
      p.is_active
    FROM products p
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS total
      FROM assets
      WHERE product_id = p.id
        AND workspace_id = p.workspace_id
        AND deleted_at IS NULL
    ) a ON true
    WHERE p.id = ${args.productId}::uuid
      AND p.workspace_id = ${args.workspaceId}::uuid
      AND p.deleted_at IS NULL
    LIMIT 1
  `);
  if (productRows.length === 0) throw new AvailabilityError('product_not_found');
  const capacity = productRows[0]!.total_units;
  const isActive = productRows[0]!.is_active;

  // Buffer hours from workspace settings (default 0, clamped 0-24).
  const wsRows = await query<{ buffer_hours: number }>(sql`
    SELECT COALESCE((settings->'availability'->>'buffer_hours')::float8, 0) AS buffer_hours
    FROM workspaces
    WHERE id = ${args.workspaceId}::uuid
    LIMIT 1
  `);
  const bufferHours = clampBuffer(Number(wsRows[0]?.buffer_hours ?? 0));
  const bufferMs = bufferHours * 60 * 60 * 1000;

  const effStart = new Date(args.start.getTime() - bufferMs);
  const effEnd = new Date(args.end.getTime() + bufferMs);

  // Overlapping reserving-status rental lines for this product. Strict overlap
  // (`<` / `>`) so a booking that ends exactly when the window starts does not
  // conflict — the unit is handed back at that instant.
  const conflicts = await query<AvailabilityConflict>(sql`
    SELECT
      o.id            AS order_id,
      o.order_number,
      p.display_name  AS customer_name,
      oi.quantity,
      o.rental_start  AS start,
      o.rental_end    AS end,
      o.status::text  AS status
    FROM order_items oi
    JOIN orders o     ON o.id = oi.order_id
    LEFT JOIN people p ON p.id = o.customer_person_id
    WHERE oi.workspace_id = ${args.workspaceId}::uuid
      AND o.workspace_id = ${args.workspaceId}::uuid
      AND oi.product_id = ${args.productId}::uuid
      AND oi.item_type = 'rental'
      AND o.deleted_at IS NULL
      AND o.status::text IN ('confirmed', 'dispatched', 'active', 'returned')
      AND o.id != COALESCE(${args.excludeOrderId ?? null}::uuid,
                           '00000000-0000-0000-0000-000000000000'::uuid)
      AND o.rental_start < ${effEnd.toISOString()}::timestamptz
      AND o.rental_end   > ${effStart.toISOString()}::timestamptz
    ORDER BY o.rental_start ASC
  `);

  const normalized: AvailabilityConflict[] = conflicts.map((cf) => ({
    order_id: cf.order_id,
    order_number: Number(cf.order_number),
    customer_name: cf.customer_name ?? null,
    quantity: Number(cf.quantity),
    start: new Date(cf.start).toISOString(),
    end: new Date(cf.end).toISOString(),
    status: cf.status,
  }));

  const currentlyBooked = normalized.reduce((sum, c) => sum + c.quantity, 0);
  const available = currentlyBooked + args.quantity <= capacity;

  const result: AvailabilityResult = {
    available,
    requested: args.quantity,
    capacity,
    currently_booked: currentlyBooked,
    conflicts: normalized,
  };
  if (!isActive) result.inactive_product = true;
  return result;
}
