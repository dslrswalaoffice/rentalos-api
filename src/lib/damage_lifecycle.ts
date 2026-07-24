// ============================================================================
// src/lib/damage_lifecycle.ts (Slice 11 Session 1) — damage integration seams.
// ----------------------------------------------------------------------------
// Wires the dormant seams of the Sub-slice 2.3 damage module into the other
// engines, reusing their canonical routines (DRY):
//   * Workflow Engine — a fail_major inspection auto-opens a damage incident
//     (reusing createDamageIncident, which already writes the per-asset rows,
//     timeline, order event, and notifications).
//   * Money Engine — a settled financial resolution moves real money: a deposit
//     forfeit PAYMENT (own INSERT + the shared commitPaymentAndReconcile TAIL,
//     the codebase's established per-op pattern) and a damage invoice line.
//   * Inventory — an asset disposition takes the unit offline (maintenance
//     downtime) or retires it (status + soft-delete), reusing the return-flow
//     product_downtimes pattern.
//
// EVERY seam is FAIL-SOFT: the triggering action (inspection completion /
// financial resolution) must never be blocked by a side-effect error. Each side
// effect is individually idempotent so a retry can't double-charge or double-open.
// ============================================================================

import { sql, query } from '../db.js';
import { audit } from './audit.js';
import { createDamageIncident, type Severity, type IncidentType } from './damage.js';
import { commitPaymentAndReconcile } from './payment_commit.js';
import { recomputeOrderTotals } from './pricing.js';

// ---------------------------------------------------------------------------
// Seam 1 — inspection (fail_major) -> damage incident.
// ---------------------------------------------------------------------------
export type InspectionTriggerArgs = {
  workspaceId: string;
  orderId: string;
  orderItemId: string;
  assetId?: string | null;
  actorUserId: string;
  actorName: string;
  ip?: string | null;
  userAgent?: string | null;
};

/**
 * Auto-open a damage incident from a fail_major inspection (Q1/Q2). Reuses
 * createDamageIncident so the incident, per-asset row, timeline, order event, and
 * notifications all flow through the ONE canonical path. Defaults are
 * operator-correctable (incident_type='wear_and_tear_dispute', severity='major').
 * IDEMPOTENT: if an inspection-sourced incident already exists for this order
 * item, it is returned instead of creating a duplicate (retry-safe).
 */
export async function triggerDamageIncidentFromInspection(
  args: InspectionTriggerArgs,
): Promise<{ ok: boolean; incident?: any; deduped?: boolean; error?: string }> {
 try {
  // Dedup: one inspection-sourced incident per order item (retry / re-run safe).
  const existing = await query<{ id: string; incident_number: string }>(sql`
    SELECT di.id, di.incident_number
    FROM damage_incidents di
    JOIN damage_incident_assets dia ON dia.damage_incident_id = di.id
    WHERE di.workspace_id = ${args.workspaceId}::uuid
      AND di.order_id = ${args.orderId}::uuid
      AND di.reported_by_type = 'inspection_at_return'
      AND dia.order_item_id = ${args.orderItemId}::uuid
    LIMIT 1
  `);
  if (existing[0]) return { ok: true, incident: existing[0], deduped: true };

  const r = await createDamageIncident({
    workspaceId: args.workspaceId,
    orderId: args.orderId,
    actorUserId: args.actorUserId,
    actorName: args.actorName,
    reportedByType: 'inspection_at_return',
    occurredAt: new Date().toISOString(),
    incidentType: 'wear_and_tear_dispute' as IncidentType,
    severity: 'major' as Severity,
    description: 'Auto-created from a failed return inspection (fail_major). Review and correct type/severity/cost.',
    affectedItems: [{
      order_item_id: args.orderItemId,
      asset_id: args.assetId ?? null,
      severity: 'major' as Severity,
      disposition: 'pending_assessment',
    }],
    estimatedCostPaise: 0,
    ip: args.ip ?? null,
    userAgent: args.userAgent ?? null,
  });
  if (!r.ok) return { ok: false, error: r.error };
  return { ok: true, incident: r.incident };
 } catch (e) {
  console.error('[damage_lifecycle] triggerDamageIncidentFromInspection failed', e);
  return { ok: false, error: 'trigger_error' };
 }
}

// ---------------------------------------------------------------------------
// Seam 2 — settled financial resolution -> money movement + asset dispositions.
// ---------------------------------------------------------------------------
export type FinancialSideEffectArgs = {
  workspaceId: string;
  orderId: string;
  damageIncidentId: string;
  incidentNumber: string;
  actorUserId: string;
  customerLiability: string;
  finalCostPaise: number | null;
  depositAction: string;
  depositForfeitAmountPaise: number | null;
  autoExecuteForfeit: boolean;
  ip?: string | null;
  userAgent?: string | null;
};

export type FinancialSideEffectResult = {
  deposit_forfeit_payment_id: string | null;
  damage_line_paise: number;
  asset_effects: Array<{ asset_incident_id: string; disposition: string; effect: string }>;
};

/**
 * Fire the money + inventory side-effects when a financial resolution SETTLES
 * (not when it still needs approval). Each effect is fail-soft + idempotent.
 * Money model (Q4, additional-only): the deposit forfeit already produces a
 * "Retained deposit" invoice line, so the damage line bills only the amount
 * BEYOND the forfeited deposit (final_cost - forfeit_applied) — never both.
 */
export async function applyDamageFinancialSideEffects(
  args: FinancialSideEffectArgs,
): Promise<FinancialSideEffectResult> {
  const result: FinancialSideEffectResult = { deposit_forfeit_payment_id: null, damage_line_paise: 0, asset_effects: [] };
  const forfeitAmount = Number(args.depositForfeitAmountPaise ?? 0);
  const finalCost = Number(args.finalCostPaise ?? 0);
  const isForfeitAction = args.depositAction === 'forfeit_partial' || args.depositAction === 'forfeit_full';

  // (a) Deposit forfeit payment — reuse the Money Engine commit tail.
  let forfeitApplied = 0;
  if (args.autoExecuteForfeit && args.customerLiability === 'yes' && forfeitAmount > 0 && isForfeitAction) {
    try {
      // Idempotency: only forfeit once per incident.
      const inc = (await query<{ deposit_forfeit_payment_id: string | null }>(sql`
        SELECT deposit_forfeit_payment_id FROM damage_incidents
        WHERE id = ${args.damageIncidentId}::uuid AND workspace_id = ${args.workspaceId}::uuid LIMIT 1
      `))[0];
      if (inc && !inc.deposit_forfeit_payment_id) {
        // Method from the customer's held deposit (fallback cash).
        const dep = (await query<{ method: string }>(sql`
          SELECT method::text AS method FROM payments
          WHERE order_id = ${args.orderId}::uuid AND workspace_id = ${args.workspaceId}::uuid
            AND payment_kind = 'deposit' AND status = 'completed'
          ORDER BY occurred_at DESC LIMIT 1
        `))[0];
        const method = dep?.method ?? 'cash';
        const notes = `Forfeit for damage incident ${args.incidentNumber}`;
        const pay = (await query<{ id: string }>(sql`
          INSERT INTO payments (
            workspace_id, order_id, amount_paise, direction, method, payment_kind,
            reference, status, notes, received_by, occurred_at
          ) VALUES (
            ${args.workspaceId}::uuid, ${args.orderId}::uuid, ${forfeitAmount}::bigint,
            'out'::payment_direction, ${method}::payment_method, 'deposit_forfeit'::text,
            ${'DAMAGE_FORFEIT_' + args.damageIncidentId}::text, 'completed'::payment_status,
            ${notes}::text, ${args.actorUserId}::uuid, now()
          ) RETURNING id
        `))[0]!;
        // Sub-turn 13 parity: a retained deposit becomes an invoice line so the
        // amount withheld is explained, not a mystery subtraction.
        await sql`
          INSERT INTO order_items
            (workspace_id, order_id, item_type, description, quantity,
             unit_amount_paise, total_amount_paise, is_custom_line, custom_name, sort_order)
          VALUES (${args.workspaceId}::uuid, ${args.orderId}::uuid, 'other'::order_item_type,
                  ${'Retained deposit — damage ' + args.incidentNumber}::text, 1,
                  ${forfeitAmount}::bigint, ${forfeitAmount}::bigint,
                  true, 'Retained deposit'::text, 8500)
        `;
        await recomputeOrderTotals(args.orderId, args.workspaceId, args.actorUserId).catch(() => {});
        await commitPaymentAndReconcile({
          workspaceId: args.workspaceId, orderId: args.orderId, actorUserId: args.actorUserId,
          isDeposit: true, ipAddress: args.ip ?? null, userAgent: args.userAgent ?? null,
        });
        await sql`UPDATE damage_incidents SET deposit_forfeit_payment_id = ${pay.id}::uuid, updated_at = now()
                  WHERE id = ${args.damageIncidentId}::uuid AND workspace_id = ${args.workspaceId}::uuid`;
        await audit({
          workspaceId: args.workspaceId, actorUserId: args.actorUserId, eventType: 'payments.deposit_forfeited',
          targetType: 'payment', targetId: pay.id,
          payload: { order_id: args.orderId, damage_incident_id: args.damageIncidentId, incident_number: args.incidentNumber, amount_paise: forfeitAmount, source: 'damage_auto' },
          ipAddress: args.ip ?? null, userAgent: args.userAgent ?? null,
        });
        result.deposit_forfeit_payment_id = pay.id;
        forfeitApplied = forfeitAmount;
      } else if (inc?.deposit_forfeit_payment_id) {
        result.deposit_forfeit_payment_id = inc.deposit_forfeit_payment_id;
        forfeitApplied = forfeitAmount; // already applied on a prior run
      }
    } catch (e) {
      console.error('[damage_lifecycle] deposit forfeit failed', e);
    }
  }

  // (b) Damage invoice line — additional-only (Q4). Bills final_cost minus the
  //     forfeit already carried by the "Retained deposit" line.
  if (args.customerLiability === 'yes' && finalCost > 0) {
    try {
      const additional = finalCost - forfeitApplied;
      if (additional > 0) {
        const already = (await query<{ n: number }>(sql`
          SELECT COUNT(*)::int AS n FROM order_items
          WHERE order_id = ${args.orderId}::uuid AND workspace_id = ${args.workspaceId}::uuid
            AND item_type = 'damage' AND description LIKE ${'%' + args.incidentNumber + '%'}::text
        `))[0]?.n ?? 0;
        if (already === 0) {
          await sql`
            INSERT INTO order_items
              (workspace_id, order_id, item_type, description, quantity, unit_amount_paise, total_amount_paise, sort_order)
            VALUES (${args.workspaceId}::uuid, ${args.orderId}::uuid, 'damage'::order_item_type,
                    ${'Damage settlement — Incident ' + args.incidentNumber}::text, 1,
                    ${additional}::bigint, ${additional}::bigint, 8600)
          `;
          await recomputeOrderTotals(args.orderId, args.workspaceId, args.actorUserId).catch(() => {});
          result.damage_line_paise = additional;
        }
      }
    } catch (e) {
      console.error('[damage_lifecycle] damage invoice line failed', e);
    }
  }

  // (c) Asset dispositions — take failed units offline / retire them (Q5).
  try {
    const assets = await query<{ id: string; asset_id: string | null; disposition: string | null; linked_downtime_id: string | null }>(sql`
      SELECT id, asset_id, disposition, linked_downtime_id FROM damage_incident_assets
      WHERE damage_incident_id = ${args.damageIncidentId}::uuid AND workspace_id = ${args.workspaceId}::uuid
    `);
    for (const a of assets) {
      const eff = await executeAssetDispositionEffects({
        workspaceId: args.workspaceId, orderId: args.orderId, damageIncidentAssetId: a.id,
        assetId: a.asset_id, disposition: a.disposition, linkedDowntimeId: a.linked_downtime_id,
        incidentNumber: args.incidentNumber, actorUserId: args.actorUserId,
      });
      if (eff.effect !== 'none') result.asset_effects.push({ asset_incident_id: a.id, disposition: a.disposition ?? '', effect: eff.effect });
    }
  } catch (e) {
    console.error('[damage_lifecycle] asset dispositions failed', e);
  }

  return result;
}

// ---------------------------------------------------------------------------
// Seam 3 — asset disposition -> asset state. Reuses the return-flow downtime +
// retire conventions. Idempotent per unit. Never throws.
// ---------------------------------------------------------------------------
export async function executeAssetDispositionEffects(args: {
  workspaceId: string;
  orderId: string;
  damageIncidentAssetId: string;
  assetId: string | null;
  disposition: string | null;
  linkedDowntimeId: string | null;
  incidentNumber: string;
  actorUserId: string;
}): Promise<{ effect: string }> {
  const { disposition } = args;
  // return_to_service (unit already back via the return pipeline) and any
  // unhandled disposition (customer_replacement / sell_as_used / scrap) are no-ops.
  if (disposition !== 'maintenance_required' && disposition !== 'retire') return { effect: 'none' };
  if (!args.assetId) return { effect: 'none' }; // bulk line, no serialized unit

  try {
    if (disposition === 'maintenance_required') {
      if (args.linkedDowntimeId) return { effect: 'downtime_exists' }; // idempotent
      const days = await repairDays(args.workspaceId);
      const dt = (await query<{ id: string }>(sql`
        INSERT INTO product_downtimes
          (workspace_id, asset_id, kind, status, start_at, end_at, reason, order_id, created_by_user_id)
        VALUES (
          ${args.workspaceId}::uuid, ${args.assetId}::uuid,
          'maintenance'::downtime_reason, 'scheduled'::downtime_status,
          now(), now() + make_interval(days => ${days}::int),
          ${'Damage repair — incident ' + args.incidentNumber}::text,
          ${args.orderId}::uuid, ${args.actorUserId}::uuid
        ) RETURNING id
      `))[0]!;
      await sql`UPDATE damage_incident_assets SET linked_downtime_id = ${dt.id}::uuid
                WHERE id = ${args.damageIncidentAssetId}::uuid AND workspace_id = ${args.workspaceId}::uuid`;
      return { effect: 'downtime_created' };
    }
    // retire — status + soft-delete (CLAUDE.md convention), out of capacity.
    const upd = await query<{ id: string }>(sql`
      UPDATE assets SET status = 'retired'::asset_status, deleted_at = now(), updated_at = now()
      WHERE id = ${args.assetId}::uuid AND workspace_id = ${args.workspaceId}::uuid AND deleted_at IS NULL
      RETURNING id
    `);
    return { effect: upd[0] ? 'retired' : 'already_retired' };
  } catch (e) {
    console.error('[damage_lifecycle] asset disposition effect failed', e, args.damageIncidentAssetId);
    return { effect: 'none' };
  }
}

async function repairDays(workspaceId: string): Promise<number> {
  try {
    const rows = await query<{ d: number }>(sql`
      SELECT COALESCE((settings->'downtime'->>'default_repair_days')::int, 7) AS d
      FROM workspaces WHERE id = ${workspaceId}::uuid LIMIT 1
    `);
    const d = Number(rows[0]?.d ?? 7);
    return Number.isFinite(d) && d > 0 ? d : 7;
  } catch { return 7; }
}
