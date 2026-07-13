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
// closed/cancelled are done. THE single source of truth — the SQL below and
// src/routes/availability.ts both derive their status filter from this constant
// (via string_to_array on the joined CSV, which sidesteps the Neon HTTP
// driver's mis-serialisation of JS arrays cast to order_status[]). Change the
// list here and every availability code path follows.
export const RESERVING_STATUSES = [
  'confirmed',
  'dispatched',
  'active',
  'returned',
] as const;

// Item-level release (Sub-turn 12b — MODULE_AUDIT finding 4). An order in a
// reserving status no longer blocks gear for items that have physically come
// back. A rental line reserves capacity only while its OWN status still ties up
// a unit: pending_dispatch / dispatched (unit expected or out) and the two
// not_returned_* outcomes (unit still with the customer, unresolved). The moment
// an item is marked returned / returned_with_damage / missing, its capacity is
// released — without waiting for the whole order to close. (A damaged unit is
// re-blocked at the ASSET level via an auto-created repair downtime, so it
// doesn't rejoin availability; a missing unit is retired out of capacity.)
export const RESERVING_ITEM_STATUSES = [
  'pending_dispatch',
  'dispatched',
  'not_returned_chargeable',
  'not_returned_non_chargeable',
] as const;

const BUFFER_MIN_HOURS = 0;
const BUFFER_MAX_HOURS = 72;

/** Thrown when the product can't be found in the workspace. Callers map the
 *  `code` to an HTTP status (product_not_found → 404). */
export class AvailabilityError extends Error {
  constructor(public code: string) {
    super(code);
    this.name = 'AvailabilityError';
  }
}

export type AvailabilityConflict = {
  // Discriminant (Sub-turn 8a). Absent/'booking' = a real order reservation;
  // 'downtime' = a maintenance block. Booking fields carry sentinels on
  // downtime rows so numeric consumers (dashboard sweep, calendar) don't break.
  type: 'booking' | 'downtime';
  order_id: string;
  order_number: number;
  customer_name: string | null;
  quantity: number;
  start: string; // ISO
  end: string;   // ISO
  status: string;
  // Downtime-only fields (Sub-turn 8a).
  downtime_id?: string;
  reason?: string;
  location_scope?: 'location' | 'workspace';
};

export type KitComponentAvailability = {
  component_product_id: string;
  component_name: string;
  component_sku: string;
  per_kit_qty: number;       // qty of this component in ONE kit
  required_qty: number;      // per_kit_qty * requested kit quantity
  available: boolean;
  component_capacity: number;
  component_booked: number;
};

export type AvailabilityResult = {
  available: boolean; // FALSE only when demand exceeds capacity + shortage_limit
  requested: number;
  capacity: number;
  capacity_source: 'assets' | 'stock_quantity'; // Sub-turn 6h — tracked vs bulk
  location_id: string | null; // Sub-turn 6i — which location was checked (null for bulk / no default)
  currently_booked: number;
  shortage_limit: number;   // per-product allowed overbook (Sub-turn 6b)
  shortage_used: boolean;   // true when overbooked but within shortage_limit
  // Which per-product buffers were applied to the conflict window (transparency).
  applied_buffer_before_hours: number;
  applied_buffer_after_hours: number;
  inactive_product?: boolean;
  conflicts: AvailabilityConflict[];
  // True when a maintenance downtime intersects the requested window (Sub-turn 8a).
  has_downtime_conflict?: boolean;
  // Present only when the product is a kit (Sub-turn 5c-2).
  is_kit?: boolean;
  kit_components?: KitComponentAvailability[];
  reason?: string;
};

export type KitComponentRow = {
  component_product_id: string;
  quantity: number;
  component_name: string;
  component_sku: string;
};

// Kit components (kit_product_id → components). Exported: the invoice snapshot
// builder reuses it so "what's in a kit" has a single source of truth.
export async function loadKitComponents(
  workspaceId: string,
  kitProductId: string,
): Promise<KitComponentRow[]> {
  return await query<KitComponentRow>(sql`
    SELECT pki.component_product_id, pki.quantity,
           p.name AS component_name, p.sku AS component_sku
    FROM product_kit_items pki
    JOIN products p ON p.id = pki.component_product_id
    WHERE pki.workspace_id = ${workspaceId}::uuid
      AND pki.kit_product_id = ${kitProductId}::uuid
    ORDER BY p.name ASC
  `);
}

function clampBuffer(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(BUFFER_MAX_HOURS, Math.max(BUFFER_MIN_HOURS, n));
}

// The workspace's default location id (Sub-turn 6i). Used when a caller doesn't
// specify one, preserving pre-multi-location behavior.
export async function getDefaultLocationId(workspaceId: string): Promise<string | null> {
  const rows = await query<{ id: string }>(sql`
    SELECT id FROM locations
    WHERE workspace_id = ${workspaceId}::uuid AND is_default = true
    LIMIT 1
  `);
  return rows[0]?.id ?? null;
}

// Single source of truth for a product's capacity (Sub-turn 6h + 6i). Tracked
// products count live asset rows AT A LOCATION (default when omitted); bulk
// products use the workspace-global stock_quantity column (per-location bulk is
// Phase 2, so locationId is ignored for bulk). Exported for reuse.
export async function getProductCapacity(
  workspaceId: string,
  productId: string,
  locationId?: string,
): Promise<{ capacity: number; source: 'assets' | 'stock_quantity' }> {
  const rows = await query<{ tracking_mode: string; stock_quantity: number | null }>(sql`
    SELECT p.tracking_mode, p.stock_quantity
    FROM products p
    WHERE p.id = ${productId}::uuid AND p.workspace_id = ${workspaceId}::uuid
    LIMIT 1
  `);
  const row = rows[0];
  if (!row) return { capacity: 0, source: 'assets' };
  if (row.tracking_mode === 'bulk') {
    return { capacity: Number(row.stock_quantity ?? 0), source: 'stock_quantity' };
  }
  const effectiveLocationId = locationId ?? (await getDefaultLocationId(workspaceId));
  const countRows = await query<{ c: number }>(sql`
    SELECT COUNT(*)::int AS c FROM assets a
    WHERE a.workspace_id = ${workspaceId}::uuid
      AND a.product_id = ${productId}::uuid
      AND a.deleted_at IS NULL
      AND (${effectiveLocationId}::uuid IS NULL OR a.location_id = ${effectiveLocationId}::uuid)
  `);
  return { capacity: Number(countRows[0]?.c ?? 0), source: 'assets' };
}

/**
 * Check product availability for a window. Applies THIS PRODUCT's own buffer
 * hours (Sub-turn 6b) — not the workspace-wide value, which is now deprecated
 * for check-time logic. The buffer expands each existing booking's window, not
 * the query window: a booking at 10-12 with 2h before + 1h after effectively
 * blocks 8-13 for that product. Excludes an order's own bookings when
 * `excludeOrderId` is supplied (so editing an existing order doesn't conflict
 * with itself).
 *
 * Overbook tolerance is per-product too: `available` stays true up to
 * `capacity + shortage_limit`, with `shortage_used` flagging that the booking
 * dipped into shortage capacity.
 */
export async function checkAvailability(args: {
  workspaceId: string;
  productId: string;
  quantity: number;
  start: Date;
  end: Date;
  excludeOrderId?: string;
  locationId?: string; // Sub-turn 6i — per-location capacity for tracked products
}): Promise<AvailabilityResult> {
  // Resolve the location to check against. Tracked products count assets AT this
  // location; bulk products ignore it (workspace-global — Phase 2 adds per-loc
  // bulk). Falls back to the workspace default so pre-6i callers behave the same.
  const effectiveLocationId = args.locationId ?? (await getDefaultLocationId(args.workspaceId));

  // Capacity = count of live assets for the product at the location. Also grab
  // is_active + is_kit (to flag inactive products / route kits) and the
  // per-product buffer + shortage config.
  const productRows = await query<{
    total_units: number;
    tracking_mode: string;
    stock_quantity: number | null;
    is_active: boolean;
    is_kit: boolean;
    buffer_before_hours: number;
    buffer_after_hours: number;
    shortage_limit: number;
  }>(sql`
    SELECT
      COALESCE(a.total, 0)::int AS total_units,
      p.tracking_mode, p.stock_quantity,
      p.is_active, p.is_kit,
      p.buffer_before_hours, p.buffer_after_hours, p.shortage_limit
    FROM products p
    LEFT JOIN LATERAL (
      SELECT COUNT(*) AS total
      FROM assets asset
      WHERE asset.product_id = p.id
        AND asset.workspace_id = p.workspace_id
        AND asset.deleted_at IS NULL
        AND (${effectiveLocationId}::uuid IS NULL OR asset.location_id = ${effectiveLocationId}::uuid)
        -- Sub-turn 12b: a unit held offline by an active ASSET-level downtime
        -- (repair/missing) drops out of capacity for the window — capacity minus
        -- one, not a whole-product block. Product-level downtimes are handled
        -- separately (loadDowntimeConflicts) and still block the full product.
        AND NOT EXISTS (
          SELECT 1 FROM product_downtimes d
          WHERE d.asset_id = asset.id
            AND d.status IN ('scheduled', 'started')
            AND d.start_at < ${args.end.toISOString()}::timestamptz
            AND d.end_at   > ${args.start.toISOString()}::timestamptz
        )
    ) a ON true
    WHERE p.id = ${args.productId}::uuid
      AND p.workspace_id = ${args.workspaceId}::uuid
      AND p.deleted_at IS NULL
    LIMIT 1
  `);
  if (productRows.length === 0) throw new AvailabilityError('product_not_found');
  // Capacity source depends on tracking mode (6h): bulk → stock_quantity
  // (workspace-global), tracked → live asset rows at the location (6i).
  const isBulk = productRows[0]!.tracking_mode === 'bulk';
  const capacity = isBulk ? Number(productRows[0]!.stock_quantity ?? 0) : productRows[0]!.total_units;
  const capacitySource: 'assets' | 'stock_quantity' = isBulk ? 'stock_quantity' : 'assets';
  const isActive = productRows[0]!.is_active;

  // KIT PATH: capacity is derived from the components, not the kit's own assets.
  // Kit-level buffer + shortage fields exist but are IGNORED — each component
  // uses its own buffers/limits (see checkKitAvailability). The kit's location
  // flows to every component (kits dispatch together from one warehouse).
  if (productRows[0]!.is_kit) {
    return checkKitAvailability(args, isActive, effectiveLocationId);
  }

  const bufferBefore = clampBuffer(Number(productRows[0]!.buffer_before_hours ?? 0));
  const bufferAfter = clampBuffer(Number(productRows[0]!.buffer_after_hours ?? 0));
  const shortageLimit = Math.max(0, Number(productRows[0]!.shortage_limit ?? 0));

  // Overlapping reserving-status rental lines for this product. The buffer
  // expands each EXISTING booking's window: a booking effectively blocks
  // [rental_start - buffer_before, rental_end + buffer_after]. Strict overlap
  // (`<` / `>`) so a booking whose (buffered) end lands exactly on the window
  // start does not conflict.
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
      AND o.status::text = ANY(string_to_array(${RESERVING_STATUSES.join(',')}::text, ','))
      -- Item-level release (Sub-turn 12b): a returned/missing line stops
      -- reserving even while its order is still open (released at RETURN, not
      -- CLOSE). Same string_to_array trick to dodge the enum-array serialization.
      AND oi.status::text = ANY(string_to_array(${RESERVING_ITEM_STATUSES.join(',')}::text, ','))
      AND o.id != COALESCE(${args.excludeOrderId ?? null}::uuid,
                           '00000000-0000-0000-0000-000000000000'::uuid)
      -- Tracked products reserve per-location (pickup_location_id); bulk products
      -- reserve workspace-globally (Phase 2 adds per-location bulk).
      AND (${isBulk}::boolean OR ${effectiveLocationId}::uuid IS NULL
           OR o.pickup_location_id = ${effectiveLocationId}::uuid)
      AND o.rental_start - make_interval(hours => ${bufferBefore}::int) < ${args.end.toISOString()}::timestamptz
      AND o.rental_end   + make_interval(hours => ${bufferAfter}::int)  > ${args.start.toISOString()}::timestamptz
    ORDER BY o.rental_start ASC
  `);

  const normalized: AvailabilityConflict[] = conflicts.map((cf) => ({
    type: 'booking' as const,
    order_id: cf.order_id,
    order_number: Number(cf.order_number),
    customer_name: cf.customer_name ?? null,
    quantity: Number(cf.quantity),
    start: new Date(cf.start).toISOString(),
    end: new Date(cf.end).toISOString(),
    status: cf.status,
  }));

  const currentlyBooked = normalized.reduce((sum, c) => sum + c.quantity, 0);

  // Downtimes (Sub-turn 8a): a maintenance block reserves the FULL capacity for
  // its window. Tracked products see workspace-wide (location_id NULL) plus
  // this-location downtimes; bulk products (no location) see only workspace-wide
  // ones. If ANY downtime intersects the requested window we treat the whole
  // window as blocked (simple + safe; sub-day precision is a future refinement).
  const downtimeConflicts = await loadDowntimeConflicts(
    args.workspaceId, args.productId, isBulk ? null : effectiveLocationId,
    args.start, args.end, capacity,
  );
  const hasDowntimeConflict = downtimeConflicts.length > 0;

  // Decision: available up to capacity + shortage_limit; shortage_used flags the
  // overbook-but-within-limit band.
  const totalDemand = currentlyBooked + args.quantity;
  const hardCapacity = capacity + shortageLimit;
  let available: boolean;
  let shortageUsed: boolean;
  if (totalDemand <= capacity) {
    available = true;
    shortageUsed = false;
  } else if (totalDemand <= hardCapacity) {
    available = true;
    shortageUsed = true;
  } else {
    available = false;
    shortageUsed = false;
  }

  // A downtime overrides the numeric verdict: the gear is offline, so it's not
  // available regardless of headroom. Downtime rows are appended AFTER bookings.
  if (hasDowntimeConflict) {
    available = false;
    shortageUsed = false;
  }

  const result: AvailabilityResult = {
    available,
    requested: args.quantity,
    capacity,
    capacity_source: capacitySource,
    location_id: isBulk ? null : effectiveLocationId,
    currently_booked: currentlyBooked,
    shortage_limit: shortageLimit,
    shortage_used: shortageUsed,
    applied_buffer_before_hours: bufferBefore,
    applied_buffer_after_hours: bufferAfter,
    conflicts: [...normalized, ...downtimeConflicts],
    has_downtime_conflict: hasDowntimeConflict,
  };
  if (!isActive) result.inactive_product = true;
  return result;
}

// ----------------------------------------------------------------------------
// Downtime blocks (Sub-turn 8a). A downtime reserves the product's FULL capacity
// for [start_at, end_at]. We surface each overlapping downtime as a conflict row
// with type 'downtime' (booking fields carry sentinels so numeric consumers stay
// happy). `locationId` is the tracked-product location to match location-scoped
// downtimes against; pass null for bulk (only workspace-wide downtimes apply).
// ----------------------------------------------------------------------------
async function loadDowntimeConflicts(
  workspaceId: string,
  productId: string,
  locationId: string | null,
  windowStart: Date,
  windowEnd: Date,
  capacity: number,
): Promise<AvailabilityConflict[]> {
  const rows = await query<{
    id: string; start_at: string; end_at: string; reason: string; location_id: string | null;
  }>(sql`
    SELECT id, start_at, end_at, reason, location_id
    FROM product_downtimes
    WHERE workspace_id = ${workspaceId}::uuid
      AND product_id = ${productId}::uuid
      -- Only live blocks (Sub-turn 12b added the lifecycle column; legacy rows
      -- default to 'scheduled', so this stays backward-compatible).
      AND status IN ('scheduled', 'started')
      AND (location_id IS NULL OR location_id = ${locationId}::uuid)
      AND start_at < ${windowEnd.toISOString()}::timestamptz
      AND end_at   > ${windowStart.toISOString()}::timestamptz
    ORDER BY start_at ASC
  `);
  return rows.map((r) => ({
    type: 'downtime' as const,
    // Sentinels so dashboard/calendar numeric code keeps working. A downtime
    // blocks the full capacity for its window.
    order_id: '',
    order_number: 0,
    customer_name: r.reason,
    quantity: Math.max(0, capacity),
    start: new Date(r.start_at).toISOString(),
    end: new Date(r.end_at).toISOString(),
    status: 'downtime',
    downtime_id: r.id,
    reason: r.reason,
    location_scope: r.location_id ? 'location' : 'workspace',
  }));
}

// ----------------------------------------------------------------------------
// Kit availability = every component must be available at (kit qty × per-kit
// component qty). Derived capacity = MIN over components of floor(component
// capacity / per-kit qty). Component checks recurse into the standard path
// (nested kits are blocked at the DB, so recursion is one level deep).
// ----------------------------------------------------------------------------
async function checkKitAvailability(
  args: {
    workspaceId: string; productId: string; quantity: number;
    start: Date; end: Date; excludeOrderId?: string;
  },
  isActive: boolean,
  effectiveLocationId: string | null,
): Promise<AvailabilityResult> {
  const components = await loadKitComponents(args.workspaceId, args.productId);

  if (components.length === 0) {
    const empty: AvailabilityResult = {
      available: false,
      requested: args.quantity,
      capacity: 0,
      capacity_source: 'assets',
      location_id: effectiveLocationId,
      currently_booked: 0,
      shortage_limit: 0,
      shortage_used: false,
      applied_buffer_before_hours: 0,
      applied_buffer_after_hours: 0,
      conflicts: [],
      is_kit: true,
      kit_components: [],
      reason: 'kit_has_no_components',
    };
    if (!isActive) empty.inactive_product = true;
    return empty;
  }

  // Every component checks against the SAME location as the kit — kits dispatch
  // together from one warehouse. A bulk component ignores it internally.
  const checks = await Promise.all(
    components.map((comp) =>
      checkAvailability({
        workspaceId: args.workspaceId,
        productId: comp.component_product_id,
        quantity: args.quantity * Number(comp.quantity),
        start: args.start,
        end: args.end,
        excludeOrderId: args.excludeOrderId,
        locationId: effectiveLocationId ?? undefined,
      }),
    ),
  );

  const kitCapacity = Math.min(
    ...components.map((comp, i) => Math.floor(checks[i]!.capacity / Number(comp.quantity))),
  );
  const available = checks.every((c) => c.available);

  const kit_components: KitComponentAvailability[] = components.map((comp, i) => ({
    component_product_id: comp.component_product_id,
    component_name: comp.component_name,
    component_sku: comp.component_sku,
    per_kit_qty: Number(comp.quantity),
    required_qty: args.quantity * Number(comp.quantity),
    available: checks[i]!.available,
    component_capacity: checks[i]!.capacity,
    component_booked: checks[i]!.currently_booked,
  }));

  // Kit-level buffer + shortage fields are ignored: each component already
  // applied its own buffers/shortage during its recursive check. Kit-level
  // shortage would double-count, so we surface 0/false here.
  const result: AvailabilityResult = {
    available,
    requested: args.quantity,
    capacity: Number.isFinite(kitCapacity) ? Math.max(0, kitCapacity) : 0,
    capacity_source: 'assets', // kit capacity is derived from components
    location_id: effectiveLocationId,
    currently_booked: 0, // not meaningful for a derived-capacity kit
    shortage_limit: 0,
    shortage_used: false,
    applied_buffer_before_hours: 0,
    applied_buffer_after_hours: 0,
    conflicts: available ? [] : checks.flatMap((c) => c.conflicts),
    is_kit: true,
    kit_components,
  };
  if (!isActive) result.inactive_product = true;
  return result;
}
