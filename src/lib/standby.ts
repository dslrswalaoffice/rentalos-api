// ============================================================================
// src/lib/standby.ts (Sub-slice 2.2) — standby (timed reservation) helpers
// ----------------------------------------------------------------------------
// A standby is a backing order in the 'standby' lifecycle state whose rental
// lines are is_soft_reserved=true (they hold availability without committing).
// Shared effects (activate on approval, release the hold) live here so both the
// route and the approvals-decide path use identical logic (no circular import).
// All thresholds come from workspace.settings.standby_policy — never hardcoded.
// ============================================================================

import { sql, query } from '../db.js';
import { audit } from './audit.js';

export const STANDBY_REASON_TAGS = [
  'customer_deciding', 'awaiting_client_approval', 'shoot_dates_tentative', 'budget_pending',
  'comparing_options', 'partner_referral', 'repeat_customer_convenience', 'team_coordination', 'other',
] as const;
export const STANDBY_VIA = ['whatsapp', 'phone', 'walk_in', 'portal', 'in_person'] as const;
export const STANDBY_SOURCES = ['staff', 'quote_conversion', 'portal', 'auto_suggested'] as const;

export type StandbySegment = 'new_customer' | 'repeat' | 'loyal' | 'vip';

/** Customer segment for the concurrent-hold cap. vip tier wins; else by prior
 *  completed orders (loyal ≥ 5, repeat ≥ 1, new otherwise). */
export async function computeStandbySegment(workspaceId: string, customerId: string): Promise<StandbySegment> {
  const rows = await query<{ tier: string | null; completed: number }>(sql`
    SELECT p.tier,
      (SELECT COUNT(*)::int FROM orders o
        WHERE o.workspace_id = p.workspace_id AND o.customer_person_id = p.id
          AND o.status::text IN ('confirmed','dispatched','active','returned','closed')) AS completed
    FROM people p WHERE p.id = ${customerId}::uuid AND p.workspace_id = ${workspaceId}::uuid LIMIT 1
  `);
  const r = rows[0];
  if (!r) return 'new_customer';
  if (r.tier === 'vip') return 'vip';
  const n = Number(r.completed);
  if (n >= 5) return 'loyal';
  if (n >= 1) return 'repeat';
  return 'new_customer';
}

/** SB-YYYY-NNNN, per-workspace per-year. Low volume → count-based is fine. */
export async function generateStandbyNumber(workspaceId: string): Promise<string> {
  const year = new Date().getUTCFullYear();
  const rows = await query<{ n: number }>(sql`
    SELECT COUNT(*)::int AS n FROM standbys
    WHERE workspace_id = ${workspaceId}::uuid AND standby_number LIKE ${'SB-' + year + '-%'}
  `);
  const seq = (rows[0]?.n ?? 0) + 1;
  return `SB-${year}-${String(seq).padStart(4, '0')}`;
}

export function standbyPolicy(settings: Record<string, any> | null | undefined): Record<string, any> {
  return settings?.standby_policy ?? {};
}

/** Count a customer's currently-active holds (for the concurrent-hold cap). */
export async function activeHoldCount(workspaceId: string, customerId: string): Promise<number> {
  const rows = await query<{ n: number }>(sql`
    SELECT COUNT(*)::int AS n FROM standbys
    WHERE workspace_id = ${workspaceId}::uuid AND customer_id = ${customerId}::uuid
      AND status IN ('active', 'pending_approval')
  `);
  return rows[0]?.n ?? 0;
}

/** Release a standby's hold: un-soft-reserve its lines and move its backing order
 *  out of the standby state. `newStatus` is the terminal standby status. Used by
 *  manual release, expiry, and approval rejection. Fail-soft; writes events. */
export async function releaseStandbyHold(args: {
  workspaceId: string; standbyId: string; actorUserId: string | null;
  newStatus: 'released_manually' | 'expired' | 'rejected';
  orderStatus: 'standby_released' | 'standby_expired' | 'cancelled';
  outcomeReason?: string | null;
}): Promise<{ order_id: string | null }> {
  const sb = (await query<{ order_id: string | null }>(sql`
    SELECT order_id FROM standbys WHERE id = ${args.standbyId}::uuid AND workspace_id = ${args.workspaceId}::uuid LIMIT 1
  `))[0];
  const orderId = sb?.order_id ?? null;

  // Drop the soft reservation on the backing lines.
  await sql`
    UPDATE order_items SET is_soft_reserved = false, soft_reserved_standby_id = NULL, updated_at = now()
    WHERE soft_reserved_standby_id = ${args.standbyId}::uuid AND workspace_id = ${args.workspaceId}::uuid
  `;
  await sql`
    UPDATE standbys SET status = ${args.newStatus}::text, outcome_reason = ${args.outcomeReason ?? null}::text, updated_at = now()
    WHERE id = ${args.standbyId}::uuid AND workspace_id = ${args.workspaceId}::uuid
  `;
  if (orderId) {
    await sql`
      UPDATE orders SET status = ${args.orderStatus}::order_status, updated_at = now()
      WHERE id = ${orderId}::uuid AND workspace_id = ${args.workspaceId}::uuid
    `;
    await sql`
      INSERT INTO order_events (workspace_id, order_id, event_type, payload, actor_user_id)
      VALUES (${args.workspaceId}::uuid, ${orderId}::uuid, 'order.standby.released'::text,
              ${JSON.stringify({ standby_id: args.standbyId, outcome: args.newStatus })}::jsonb,
              ${args.actorUserId}::uuid)
    `.catch(() => {});
  }
  await audit({
    workspaceId: args.workspaceId, actorUserId: args.actorUserId, eventType: 'standbys.released',
    targetType: 'standby', targetId: args.standbyId,
    payload: { new_status: args.newStatus, outcome_reason: args.outcomeReason ?? null }, ipAddress: null, userAgent: null,
  });
  return { order_id: orderId };
}

/** Activate a pending-approval standby (called from approvals-decide on approve):
 *  soft-reserve its lines and flip both the standby and its order to active. */
export async function activateStandby(args: { workspaceId: string; standbyId: string; actorUserId: string }): Promise<void> {
  const sb = (await query<{ order_id: string | null }>(sql`
    SELECT order_id FROM standbys WHERE id = ${args.standbyId}::uuid AND workspace_id = ${args.workspaceId}::uuid LIMIT 1
  `))[0];
  await sql`
    UPDATE standbys SET status = 'active', approved_by_user_id = ${args.actorUserId}::uuid, updated_at = now()
    WHERE id = ${args.standbyId}::uuid AND workspace_id = ${args.workspaceId}::uuid
  `;
  if (sb?.order_id) {
    await sql`
      UPDATE order_items SET is_soft_reserved = true, soft_reserved_standby_id = ${args.standbyId}::uuid, updated_at = now()
      WHERE order_id = ${sb.order_id}::uuid AND workspace_id = ${args.workspaceId}::uuid AND item_type = 'rental'
    `;
    await sql`
      UPDATE orders SET status = 'standby'::order_status, updated_at = now()
      WHERE id = ${sb.order_id}::uuid AND workspace_id = ${args.workspaceId}::uuid
    `;
  }
  await audit({
    workspaceId: args.workspaceId, actorUserId: args.actorUserId, eventType: 'standbys.activated',
    targetType: 'standby', targetId: args.standbyId, payload: {}, ipAddress: null, userAgent: null,
  });
}
