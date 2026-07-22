// ============================================================================
// src/lib/return_commit.ts — the SHARED physical disposition for a returned unit.
// ----------------------------------------------------------------------------
// Extracted (Slice 5 Session 1) from the legacy POST /api/orders/:id/return
// handler (was the private applyReturnDisposition in orders.ts) so TWO callers
// share one implementation (Constitution §10 — extract on the 2nd caller):
//   1. legacy POST /api/orders/:id/return (src/routes/orders.ts) — immediate,
//      operator-chosen outcome at return time.
//   2. new POST /api/inspections/:id/complete (src/routes/inspections.ts) — the
//      SAME disposition, deferred to inspection time (pass → 'returned',
//      fail_major → 'returned_with_damage').
//
// Mirrors commitDispatchToPhysicalState (Slice 4) — the reverse side of the loop.
// Reconciled to the SHIPPED schema (Slice 5 diagnostic, Aamir-approved): there is
// NO 'in_maintenance' asset status and NO 'awaiting_inspection'/'damaged' item
// status — a damaged unit goes 'available' + a repair downtime (product_downtimes),
// exactly as the shipped model already does.
//
// Neon HTTP has no cross-statement transaction, so every write is guarded by a
// status predicate (idempotent). Behaviour is byte-for-byte what the legacy
// handler did before extraction.
// ============================================================================

import { sql, query } from '../db.js';

export type Disposition = { asset_id: string; asset_code: string; outcome: string; downtime_id: string | null };

/**
 * Dispose the physical units pinned to one returned line, per the outcome:
 *   returned                    → asset 'available'; order_assets 'returned'.
 *   returned_with_damage        → asset 'available' + a repair downtime; order_assets 'damaged'.
 *   missing                     → asset 'retired' (soft-deleted); order_assets 'lost'.
 *   not_returned_*              → unit stays with the customer (asset 'out', order_assets 'dispatched') — no-op.
 * Returns the dispositions applied (for the batch audit payload).
 *
 * Only order_assets rows still 'dispatched' are acted on, so a re-run is a no-op.
 * When called from the inspection flow, any inspection-hold downtime on the unit is
 * released first (releaseInspectionHolds) so a passed unit rejoins availability.
 */
export async function commitReturnToPhysicalState(args: {
  workspaceId: string; orderId: string; orderNumber: number; itemId: string;
  outcome: string; actorUserId: string; repairDays: number;
}): Promise<Disposition[]> {
  const rows = await query<{ asset_id: string; asset_code: string }>(sql`
    SELECT oa.asset_id, a.asset_code
    FROM order_assets oa JOIN assets a ON a.id = oa.asset_id
    WHERE oa.order_id = ${args.orderId}::uuid
      AND oa.order_item_id = ${args.itemId}::uuid
      AND oa.workspace_id = ${args.workspaceId}::uuid
      AND oa.status = 'dispatched'::order_asset_status
  `);

  const out: Disposition[] = [];
  for (const r of rows) {
    let oaStatus: string;
    let downtimeId: string | null = null;

    if (args.outcome === 'returned') {
      oaStatus = 'returned';
      await sql`
        UPDATE assets SET status = 'available'::asset_status, updated_at = now()
        WHERE id = ${r.asset_id}::uuid AND workspace_id = ${args.workspaceId}::uuid
      `;
    } else if (args.outcome === 'returned_with_damage') {
      oaStatus = 'damaged';
      await sql`
        UPDATE assets SET status = 'available'::asset_status, updated_at = now()
        WHERE id = ${r.asset_id}::uuid AND workspace_id = ${args.workspaceId}::uuid
      `;
      const dt = await query<{ id: string }>(sql`
        INSERT INTO product_downtimes
          (workspace_id, asset_id, kind, status, start_at, end_at, reason, order_id, created_by_user_id)
        VALUES (
          ${args.workspaceId}::uuid, ${r.asset_id}::uuid,
          'repair'::downtime_reason, 'scheduled'::downtime_status,
          now(), now() + make_interval(days => ${args.repairDays}::int),
          ${`Damage on return (order #${args.orderNumber})`}::text,
          ${args.orderId}::uuid, ${args.actorUserId}::uuid
        )
        RETURNING id
      `);
      downtimeId = dt[0]?.id ?? null;
    } else if (args.outcome === 'missing') {
      oaStatus = 'lost';
      // Retired = status 'retired' AND soft-deleted (CLAUDE.md), out of capacity.
      await sql`
        UPDATE assets SET status = 'retired'::asset_status, deleted_at = now(), updated_at = now()
        WHERE id = ${r.asset_id}::uuid AND workspace_id = ${args.workspaceId}::uuid
      `;
    } else {
      // not_returned_chargeable / not_returned_non_chargeable: the unit is still
      // physically with the customer. Leave it 'out' and its order_assets row
      // 'dispatched' — the line keeps reserving (RESERVING_ITEM_STATUSES).
      continue;
    }

    await sql`
      UPDATE order_assets
        SET status = ${oaStatus}::order_asset_status, returned_at = now(), updated_at = now()
      WHERE order_id = ${args.orderId}::uuid AND asset_id = ${r.asset_id}::uuid
        AND workspace_id = ${args.workspaceId}::uuid
    `;
    out.push({ asset_id: r.asset_id, asset_code: r.asset_code, outcome: oaStatus, downtime_id: downtimeId });
  }
  return out;
}

/**
 * Create an inspection-hold downtime per unit pinned to a returned line (Slice 5,
 * Q7 "availability stays Awaiting Inspection until inspection done"). Reuses the
 * shipped product_downtimes model (kind='maintenance', status='scheduled') so the
 * availability engine already excludes the unit — no query changes. The window is
 * now → now + holdDays (a bounded default; the hold is released/converted at
 * inspection). Returns the created downtime ids.
 */
export async function createInspectionHolds(args: {
  workspaceId: string; orderId: string; orderNumber: number; itemId: string;
  actorUserId: string; holdDays: number;
}): Promise<{ asset_id: string; downtime_id: string }[]> {
  const rows = await query<{ asset_id: string }>(sql`
    SELECT oa.asset_id
    FROM order_assets oa
    WHERE oa.order_id = ${args.orderId}::uuid
      AND oa.order_item_id = ${args.itemId}::uuid
      AND oa.workspace_id = ${args.workspaceId}::uuid
      AND oa.status = 'dispatched'::order_asset_status
  `);
  const out: { asset_id: string; downtime_id: string }[] = [];
  for (const r of rows) {
    const dt = await query<{ id: string }>(sql`
      INSERT INTO product_downtimes
        (workspace_id, asset_id, kind, status, start_at, end_at, reason, order_id, created_by_user_id)
      VALUES (
        ${args.workspaceId}::uuid, ${r.asset_id}::uuid,
        'maintenance'::downtime_reason, 'scheduled'::downtime_status,
        now(), now() + make_interval(days => ${args.holdDays}::int),
        ${`Awaiting inspection (order #${args.orderNumber})`}::text,
        ${args.orderId}::uuid, ${args.actorUserId}::uuid
      )
      RETURNING id
    `);
    if (dt[0]?.id) out.push({ asset_id: r.asset_id, downtime_id: dt[0].id });
  }
  return out;
}

/**
 * Cancel any active inspection-hold downtime (kind='maintenance', status in
 * scheduled/started) on the units pinned to a returned line — called on an
 * inspection PASS so the unit rejoins availability. A fail_major leaves the hold
 * for commitReturnToPhysicalState to supersede with a repair downtime.
 */
export async function releaseInspectionHolds(args: {
  workspaceId: string; orderId: string; itemId: string;
}): Promise<number> {
  const res = await query<{ id: string }>(sql`
    UPDATE product_downtimes SET status = 'cancelled'::downtime_status, updated_at = now()
    WHERE workspace_id = ${args.workspaceId}::uuid
      AND order_id = ${args.orderId}::uuid
      AND kind = 'maintenance'::downtime_reason
      AND status IN ('scheduled'::downtime_status, 'started'::downtime_status)
      AND asset_id IN (
        SELECT oa.asset_id FROM order_assets oa
        WHERE oa.order_id = ${args.orderId}::uuid
          AND oa.order_item_id = ${args.itemId}::uuid
          AND oa.workspace_id = ${args.workspaceId}::uuid
      )
    RETURNING id
  `);
  return res.length;
}
