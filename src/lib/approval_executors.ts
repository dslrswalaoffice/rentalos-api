// ============================================================================
// src/lib/approval_executors.ts (Approval Engine Unification S1)
// ----------------------------------------------------------------------------
// The canonical resource_type → executor registry. Replaces the inline
// if/else-if switch that used to live in src/routes/approvals.ts, so post-approval
// execution is UNIFORM across every resource_type and a new type can never again
// be created without an executor (fail-fast, not a silent no-op — the bug that
// made `asset_bulk_retire` do nothing on approve).
//
// DRY: each executor is a thin wrapper over the SAME shared effects helper the
// direct (no-approval) path already calls — applyExtensionEffects /
// applyCancellationEffects / activateStandby — exactly as the proven Extension
// reference does. No approval logic is duplicated here. Batch resources
// (asset_bulk_retire) read the FROZEN request_snapshot (immutable at creation),
// so no schema change is needed and re-approval is idempotent (skip units already
// retired).
// ============================================================================

import { sql, query } from '../db.js';
import { audit } from './audit.js';
import { applyExtensionEffects, applyCancellationEffects } from './order_actions.js';
import { activateStandby, releaseStandbyHold } from './standby.js';

// Human labels — the single source, imported by the route + createApprovalRequest.
export const RESOURCE_LABEL: Record<string, string> = {
  order_extension: 'Extension',
  order_cancellation: 'Cancellation',
  standby: 'Standby',
  quote_withdrawal: 'Quote withdrawal',
  asset_bulk_retire: 'Bulk asset retire',
};
export function resourceLabel(resourceType: string): string {
  return RESOURCE_LABEL[resourceType] ?? resourceType;
}

export type ApprovalExecutorContext = {
  workspaceId: string;
  approvalRequestId: string;
  resourceType: string;
  resourceId: string;
  requestSnapshot: Record<string, unknown>;
  orderId: string | null;
  actorUserId: string;          // the decider
  requesterUserId: string;
  settings: Record<string, any>;
  reasonNotes: string | null;
  ctx: { ipAddress: string | null; userAgent: string | null };
};

export type ApprovalExecutorResult = {
  success: boolean;
  detail?: string;
  side_effects: string[];       // audit trail, e.g. ['rental_end_moved','invoice_revised']
};

type Executor = {
  execute: (ctx: ApprovalExecutorContext) => Promise<ApprovalExecutorResult>;
  reject: (ctx: ApprovalExecutorContext) => Promise<ApprovalExecutorResult>;
};

// ----------------------------------------------------------------------------
// Registry. The four existing executors wrap the identical helpers the inline
// switch called — behavior is byte-identical, only the dispatch changed.
// ----------------------------------------------------------------------------
const APPROVAL_EXECUTORS: Record<string, Executor> = {
  order_extension: {
    execute: async (ctx) => {
      await applyExtensionEffects({
        workspaceId: ctx.workspaceId, orderId: ctx.orderId!, actorUserId: ctx.actorUserId,
        extensionId: ctx.resourceId, approvedByUserId: ctx.actorUserId,
        ctx: { ipAddress: ctx.ctx.ipAddress, userAgent: ctx.ctx.userAgent },
      });
      return { success: true, side_effects: ['extension_effects_applied'] };
    },
    reject: async (ctx) => {
      await sql`UPDATE order_extensions SET status = 'rejected', status_reason = ${ctx.reasonNotes ?? null}::text, updated_at = now()
                WHERE id = ${ctx.resourceId}::uuid AND workspace_id = ${ctx.workspaceId}::uuid`;
      return { success: true, side_effects: ['extension_rejected'] };
    },
  },
  order_cancellation: {
    execute: async (ctx) => {
      await applyCancellationEffects({
        workspaceId: ctx.workspaceId, orderId: ctx.orderId!, actorUserId: ctx.actorUserId,
        cancellationId: ctx.resourceId, approvedByUserId: ctx.actorUserId, settings: ctx.settings,
        ctx: { ipAddress: ctx.ctx.ipAddress, userAgent: ctx.ctx.userAgent },
      });
      return { success: true, side_effects: ['cancellation_effects_applied'] };
    },
    reject: async (ctx) => {
      await sql`UPDATE order_cancellations SET status = 'rejected', status_reason = ${ctx.reasonNotes ?? null}::text, updated_at = now()
                WHERE id = ${ctx.resourceId}::uuid AND workspace_id = ${ctx.workspaceId}::uuid`;
      return { success: true, side_effects: ['cancellation_rejected'] };
    },
  },
  standby: {
    execute: async (ctx) => {
      await activateStandby({ workspaceId: ctx.workspaceId, standbyId: ctx.resourceId, actorUserId: ctx.actorUserId });
      return { success: true, side_effects: ['standby_activated'] };
    },
    reject: async (ctx) => {
      await releaseStandbyHold({ workspaceId: ctx.workspaceId, standbyId: ctx.resourceId, actorUserId: ctx.actorUserId, newStatus: 'rejected', orderStatus: 'cancelled', outcomeReason: 'approval_rejected' });
      return { success: true, side_effects: ['standby_hold_released'] };
    },
  },
  quote_withdrawal: {
    execute: async (ctx) => {
      await sql`UPDATE quote_versions SET status = 'withdrawn', withdrawn_at = now(), withdrawn_by_user_id = ${ctx.actorUserId}::uuid,
                  withdrawn_reason = ${ctx.reasonNotes ?? null}::text, tracking_link_url = NULL, updated_at = now()
                WHERE id = ${ctx.resourceId}::uuid AND workspace_id = ${ctx.workspaceId}::uuid`;
      return { success: true, side_effects: ['quote_withdrawn'] };
    },
    reject: async () => ({ success: true, side_effects: [] }), // rejecting a withdrawal leaves the quote as-is
  },
  asset_bulk_retire: {
    // NEW — the fix. Reads the frozen snapshot's asset_ids and retires each,
    // idempotently (skip any already retired via the direct path in the meantime).
    execute: async (ctx) => {
      const ids = Array.isArray(ctx.requestSnapshot?.asset_ids)
        ? (ctx.requestSnapshot.asset_ids as string[]).filter((x) => typeof x === 'string')
        : [];
      const reason = typeof ctx.requestSnapshot?.reason === 'string' ? (ctx.requestSnapshot.reason as string) : null;
      if (!ids.length) return { success: true, detail: 'no_assets_in_snapshot', side_effects: [] };
      const csv = ids.join(',');
      // One set-based UPDATE, idempotent: WHERE status <> 'retired' skips units
      // already retired, and RETURNING tells us exactly which transitioned.
      const retired = await query<{ id: string }>(sql`
        UPDATE assets SET status = 'retired'::asset_status, deleted_at = now(), updated_at = now()
        WHERE workspace_id = ${ctx.workspaceId}::uuid
          AND id = ANY(string_to_array(${csv}::text, ',')::uuid[])
          AND status::text <> 'retired'
        RETURNING id
      `);
      for (const r of retired) {
        await audit({
          workspaceId: ctx.workspaceId, actorUserId: ctx.actorUserId,
          eventType: 'inventory.asset.updated', targetType: 'asset', targetId: r.id,
          payload: { action: 'retired', reason, bulk: true, via_approval: ctx.approvalRequestId },
          ipAddress: ctx.ctx.ipAddress, userAgent: ctx.ctx.userAgent,
        });
      }
      const skipped = ids.length - retired.length;
      return { success: true, detail: `retired ${retired.length}, skipped ${skipped}`, side_effects: [`retired_${retired.length}_assets`] };
    },
    reject: async () => ({ success: true, side_effects: [] }), // rejecting leaves every asset untouched
  },
};

/** Lookup with fail-fast — an unregistered resource_type must throw, never no-op. */
export function getExecutor(resourceType: string): Executor {
  const ex = APPROVAL_EXECUTORS[resourceType];
  if (!ex) throw new Error(`No approval executor registered for resource_type: ${resourceType}`);
  return ex;
}

export async function executeApproval(ctx: ApprovalExecutorContext): Promise<ApprovalExecutorResult> {
  return getExecutor(ctx.resourceType).execute(ctx);
}
export async function rejectApproval(ctx: ApprovalExecutorContext): Promise<ApprovalExecutorResult> {
  return getExecutor(ctx.resourceType).reject(ctx);
}

/** Every resource_type the engine can execute (for tests + docs). */
export const REGISTERED_RESOURCE_TYPES = Object.keys(APPROVAL_EXECUTORS);
