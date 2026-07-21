// ============================================================================
// src/lib/dispatch_commit.ts — the SHARED physical-commit for a dispatch.
// ----------------------------------------------------------------------------
// Extracted (Slice 4 Session 2) from the legacy inline POST /api/orders/:id/dispatch
// handler so TWO callers can share one implementation (Constitution §10 — extract
// when a second caller emerges, not before):
//   1. legacy POST /api/orders/:id/dispatch (src/routes/orders.ts)      — batch hand-over
//   2. new   POST /api/dispatches/:id/complete (src/routes/dispatches.ts) — Phase 3 confirm
//
// "Asset with the customer" is expressed in the SHIPPED schema as
// `assets.status = 'out'` + an `order_assets` link row (holder is derived via
// order_assets → order → customer_person_id). There is NO `on_rent` asset/item
// status and NO current_holder column — those were in an idealized spec only.
// The on-rent order_item state is `dispatched`.
//
// Neon HTTP has no cross-statement transaction, so this runs as a sequence of
// idempotent statements (every write is guarded by a status predicate) — the same
// discipline the legacy handler used before extraction. Behaviour is byte-for-byte
// what the legacy handler did, just in one place.
// ============================================================================

import { sql, query } from '../db.js';

export type AssignedAsset = { asset_id: string; asset_code: string; item_id: string };

/** A pending line to hand over: id + type + product + quantity (from loadItems). */
export type DispatchCommitItem = {
  id: string;
  item_type: string;
  product_id: string | null;
  quantity: number;
};

export type DispatchCommitResult = {
  assignedAssets: AssignedAsset[];
  orderStatusChanged: boolean;
  newStatus: string;
};

/** Pin physical units for one dispatched rental line: order_assets row +
 *  asset.status='out'. Tracked products only (bulk have no serialized units).
 *  Explicit ids are validated (in-workspace, right product, currently
 *  available); otherwise auto-assign available units at the pickup location up
 *  to the line quantity. Returns the units actually pinned (may be fewer than
 *  quantity if the product is short — the advisory model dispatches anyway). */
export async function pinAssetsForItem(args: {
  workspaceId: string; orderId: string; itemId: string;
  productId: string; quantity: number;
  pickupLocationId: string | null;
  explicitAssetIds?: string[];
}): Promise<AssignedAsset[]> {
  const prodRows = await query<{ tracking_method: string | null; nature: string }>(sql`
    SELECT tracking_method::text AS tracking_method, nature::text AS nature FROM products
    WHERE id = ${args.productId}::uuid AND workspace_id = ${args.workspaceId}::uuid
    LIMIT 1
  `);
  if (!prodRows.length) return [];
  const nature = prodRows[0]!.nature;
  const isBulk = prodRows[0]!.tracking_method === 'bulk';

  // SERVICE: nothing physical to dispatch.
  if (nature === 'service') return [];

  // SALE — dispatch PERMANENTLY removes stock (Sub-turn 13). This is the ONLY
  // place the sale/rental behaviours diverge: a rental reserves and comes back;
  // a sale is decremented/retired and never returns.
  if (nature === 'sale') {
    if (isBulk) {
      // Decrement on-hand at the pickup location. Clamped at 0 (never negative).
      await sql`
        UPDATE stock_levels
           SET quantity = GREATEST(0, quantity - ${args.quantity}::int)
         WHERE product_id = ${args.productId}::uuid
           AND location_id = ${args.pickupLocationId}::uuid
      `;
      return [];
    }
    // Serialized sale: retire the units sold (status='retired' + soft-delete),
    // recording which units on order_assets. They never rejoin availability.
    const sold = await query<{ id: string; asset_code: string }>(sql`
      SELECT id, asset_code FROM assets
      WHERE workspace_id = ${args.workspaceId}::uuid
        AND product_id = ${args.productId}::uuid
        AND deleted_at IS NULL
        AND status = 'available'::asset_status
        AND (${args.pickupLocationId}::uuid IS NULL OR location_id = ${args.pickupLocationId}::uuid)
      ORDER BY asset_code ASC
      LIMIT ${args.quantity}::int
    `);
    const soldOut: AssignedAsset[] = [];
    for (const a of sold) {
      await sql`
        INSERT INTO order_assets (workspace_id, order_id, order_item_id, asset_id, status, dispatched_at)
        VALUES (${args.workspaceId}::uuid, ${args.orderId}::uuid, ${args.itemId}::uuid,
                ${a.id}::uuid, 'dispatched'::order_asset_status, now())
        ON CONFLICT (order_id, asset_id) DO NOTHING
      `;
      await sql`
        UPDATE assets SET status = 'retired'::asset_status, deleted_at = now(), updated_at = now()
        WHERE id = ${a.id}::uuid AND workspace_id = ${args.workspaceId}::uuid
          AND status = 'available'::asset_status
      `;
      soldOut.push({ asset_id: a.id, asset_code: a.asset_code, item_id: args.itemId });
    }
    return soldOut;
  }

  // RENTAL: bulk has no serialized units to pin (the reservation blocks it).
  if (isBulk) return [];

  let chosen: { id: string; asset_code: string }[] = [];
  if (args.explicitAssetIds && args.explicitAssetIds.length) {
    const ids = [...new Set(args.explicitAssetIds)];
    chosen = await query<{ id: string; asset_code: string }>(sql`
      SELECT id, asset_code FROM assets
      WHERE workspace_id = ${args.workspaceId}::uuid
        AND product_id = ${args.productId}::uuid
        AND deleted_at IS NULL
        AND status = 'available'::asset_status
        AND id::text = ANY(string_to_array(${ids.join(',')}::text, ','))
      ORDER BY asset_code ASC
    `);
  } else {
    chosen = await query<{ id: string; asset_code: string }>(sql`
      SELECT id, asset_code FROM assets
      WHERE workspace_id = ${args.workspaceId}::uuid
        AND product_id = ${args.productId}::uuid
        AND deleted_at IS NULL
        AND status = 'available'::asset_status
        AND (${args.pickupLocationId}::uuid IS NULL OR location_id = ${args.pickupLocationId}::uuid)
      ORDER BY asset_code ASC
      LIMIT ${args.quantity}::int
    `);
  }

  const pinned: AssignedAsset[] = [];
  for (const a of chosen) {
    // Idempotent against races: skip a unit already on this order, and only flip
    // a still-available unit to 'out'.
    await sql`
      INSERT INTO order_assets (workspace_id, order_id, order_item_id, asset_id, status, dispatched_at)
      VALUES (${args.workspaceId}::uuid, ${args.orderId}::uuid, ${args.itemId}::uuid,
              ${a.id}::uuid, 'dispatched'::order_asset_status, now())
      ON CONFLICT (order_id, asset_id) DO NOTHING
    `;
    await sql`
      UPDATE assets SET status = 'out'::asset_status, updated_at = now()
      WHERE id = ${a.id}::uuid AND workspace_id = ${args.workspaceId}::uuid
        AND status = 'available'::asset_status
    `;
    pinned.push({ asset_id: a.id, asset_code: a.asset_code, item_id: args.itemId });
  }
  return pinned;
}

/**
 * Commit a set of pending lines to physical "dispatched" state. Shared by the
 * legacy batch dispatch and the Slice 4 Session 2 complete endpoint.
 *
 * Steps (all idempotent — guarded by status predicates):
 *   1. per item: order_items.status pending_dispatch → dispatched, stamp
 *      dispatched_at / handed_to / received_by_user_id / dispatch_notes.
 *   2. per rental line: pinAssetsForItem — order_assets rows + assets.status='out'
 *      (sale lines decrement/retire; service/bulk-rental pin nothing).
 *   3. order: draft/quoted/confirmed → dispatched.
 *
 * Callers pass items ALREADY validated as pending_dispatch. The status guards
 * make a re-run a no-op, so this is safe under idempotency retries.
 */
export async function commitDispatchToPhysicalState(args: {
  workspaceId: string;
  orderId: string;
  fromStatus: string;
  items: DispatchCommitItem[];
  handedTo: string | null;
  receivedByUserId: string;
  dispatchNotes: string | null;
  pickupLocationId: string | null;
  assignments?: Map<string, string[]>;
}): Promise<DispatchCommitResult> {
  // 1. Per-item status transition (per-row UPDATE avoids the JS-array-param
  //    serialization gotcha in CLAUDE.md; the status guard is idempotent).
  for (const it of args.items) {
    await sql`
      UPDATE order_items SET
        status              = 'dispatched'::order_item_status,
        dispatched_at       = now(),
        handed_to           = ${args.handedTo ?? null}::text,
        received_by_user_id = ${args.receivedByUserId}::uuid,
        dispatch_notes      = ${args.dispatchNotes ?? null}::text,
        updated_at          = now()
      WHERE id = ${it.id}::uuid
        AND workspace_id = ${args.workspaceId}::uuid
        AND status = 'pending_dispatch'::order_item_status
    `;
  }

  // 2. Pin physical units for tracked rental lines (bulk/non-rental skipped
  //    inside the helper). Explicit picks come from the caller; else auto-assign.
  const assignedAssets: AssignedAsset[] = [];
  for (const it of args.items) {
    if (it.item_type !== 'rental' || !it.product_id) continue;
    const pinned = await pinAssetsForItem({
      workspaceId: args.workspaceId,
      orderId: args.orderId,
      itemId: it.id,
      productId: it.product_id,
      quantity: Number(it.quantity),
      pickupLocationId: args.pickupLocationId,
      explicitAssetIds: args.assignments?.get(it.id),
    });
    assignedAssets.push(...pinned);
  }

  // 3. Advance the order if it's still pre-dispatch.
  const orderStatusChanged = ['draft', 'quoted', 'confirmed'].includes(args.fromStatus);
  if (orderStatusChanged) {
    await sql`
      UPDATE orders SET status = 'dispatched'::order_status, updated_at = now()
      WHERE id = ${args.orderId}::uuid AND workspace_id = ${args.workspaceId}::uuid
    `;
  }

  return {
    assignedAssets,
    orderStatusChanged,
    newStatus: orderStatusChanged ? 'dispatched' : args.fromStatus,
  };
}
