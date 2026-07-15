import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { sql, query } from '../db.js';
import { audit } from '../lib/audit.js';
import { emitNotification } from '../lib/notify.js';
import {
  sessionMiddleware, requireAuth,
  type SessionUser, type SessionWorkspace,
} from '../middleware/session.js';
import { idempotencyMiddleware } from '../lib/idempotency.js';
import { orderBlock, reason as reasonB } from '../lib/blocked_action.js';
import { roleSatisfies, loadWorkspaceSettings, type ApproverRole } from '../lib/approvals.js';
import { applyExtensionEffects, applyCancellationEffects } from '../lib/order_actions.js';

// ============================================================================
// src/routes/approvals.ts (Sub-slice 2.1) — approval inbox + decisions
// ----------------------------------------------------------------------------
// Approvals route through here. Decision authorization is ROLE-based (owner
// decides anything; a manager decides what routes to 'manager') OR the caller is
// the explicitly-routed approver. Self-approval is blocked. On approve, the
// downstream workflow (extension / cancellation) is applied via the shared
// order_actions effects — identical to the no-approval path.
// ============================================================================

type SessionVar = { sessionId: string; user: SessionUser; workspace: SessionWorkspace } | null;
type Env = { Variables: { session: SessionVar } };

export const approvals = new Hono<Env>();
approvals.use('*', sessionMiddleware, requireAuth);
approvals.use('*', idempotencyMiddleware);

function clientCtx(c: Context) {
  const ipAddress =
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ?? c.req.header('x-real-ip') ?? null;
  const userAgent = c.req.header('user-agent') ?? null;
  return { ipAddress, userAgent };
}

const RESOURCE_LABEL: Record<string, string> = {
  order_extension: 'Extension',
  order_cancellation: 'Cancellation',
};

type ApprovalRow = {
  id: string; workspace_id: string; requester_user_id: string;
  approver_user_id: string | null; approver_role_required: ApproverRole;
  resource_type: string; resource_id: string; order_id: string | null;
  request_reason_tag: string | null; request_reason_notes: string | null;
  request_snapshot: unknown; policy_applied_snapshot: unknown;
  status: string; decision_at: string | null; decision_by_user_id: string | null;
  decision_reason_notes: string | null;
  requested_at: string; expires_at: string | null;
  requester_name?: string | null; approver_name?: string | null;
  order_number?: number | null;
};

async function loadApproval(id: string, workspaceId: string): Promise<ApprovalRow | null> {
  const rows = await query<ApprovalRow>(sql`
    SELECT ar.*, ru.display_name AS requester_name, au.display_name AS approver_name,
           o.order_number
    FROM approval_requests ar
    LEFT JOIN users ru ON ru.id = ar.requester_user_id
    LEFT JOIN users au ON au.id = ar.approver_user_id
    LEFT JOIN orders o ON o.id = ar.order_id
    WHERE ar.id = ${id}::uuid AND ar.workspace_id = ${workspaceId}::uuid
    LIMIT 1
  `);
  return rows[0] ?? null;
}

// ----------------------------------------------------------------------------
// GET / — pending approvals visible to the current user (routed to them, or
// their role can decide). ?status= filters (default pending). ?mine=1 restricts
// to approvals explicitly routed to this user.
// ----------------------------------------------------------------------------
approvals.get('/', async (c) => {
  const session = c.get('session')!;
  const status = c.req.query('status') || 'pending';
  const mine = c.req.query('mine') === '1';
  const role = session.user.role;
  const userId = session.user.id;

  // Role visibility: owner sees everything; manager sees manager-routed; anyone
  // sees approvals routed explicitly to them.
  const rows = await query<ApprovalRow>(sql`
    SELECT ar.*, ru.display_name AS requester_name, au.display_name AS approver_name,
           o.order_number
    FROM approval_requests ar
    LEFT JOIN users ru ON ru.id = ar.requester_user_id
    LEFT JOIN users au ON au.id = ar.approver_user_id
    LEFT JOIN orders o ON o.id = ar.order_id
    WHERE ar.workspace_id = ${session.workspace.id}::uuid
      AND ar.status = ${status}::text
      AND (
        ar.approver_user_id = ${userId}::uuid
        OR (${mine}::boolean = false AND (
             ${role}::text = 'owner'
             OR (${role}::text = 'manager' AND ar.approver_role_required = 'manager')
        ))
      )
    ORDER BY ar.requested_at DESC
    LIMIT 100
  `);
  return c.json({ approvals: rows });
});

// ----------------------------------------------------------------------------
// GET /:id — approval detail (with resource snapshot for Decide mode).
// ----------------------------------------------------------------------------
approvals.get('/:id', async (c) => {
  const session = c.get('session')!;
  const ap = await loadApproval(c.req.param('id'), session.workspace.id);
  if (!ap) return c.json({ error: 'not_found' }, 404);
  const canDecide =
    ap.status === 'pending' &&
    ap.requester_user_id !== session.user.id &&
    (ap.approver_user_id === session.user.id || roleSatisfies(session.user.role, ap.approver_role_required));
  return c.json({ approval: ap, resource_label: RESOURCE_LABEL[ap.resource_type] ?? ap.resource_type, can_decide: canDecide });
});

// ----------------------------------------------------------------------------
// POST /:id/decide — approve or reject, then drive the downstream workflow.
// ----------------------------------------------------------------------------
const decideSchema = z.object({
  decision: z.enum(['approved', 'rejected']),
  reason_notes: z.string().max(2000).optional(),
});

approvals.post('/:id/decide', async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');

  const body = await c.req.json().catch(() => null);
  const parsed = decideSchema.safeParse(body);
  if (!parsed.success) return c.json({ error: 'invalid_request', issues: parsed.error.issues }, 400);
  const { decision, reason_notes } = parsed.data;

  const ap = await loadApproval(id, session.workspace.id);
  if (!ap) return c.json({ error: 'not_found' }, 404);

  if (ap.status !== 'pending') {
    return c.json(orderBlock('APPROVAL_BLOCKED', 'This approval is no longer pending', [
      reasonB('terminal_state', 'ALREADY_DECIDED', `This request is already ${ap.status}`),
    ]), 409);
  }
  if (ap.requester_user_id === session.user.id) {
    return c.json(orderBlock('APPROVAL_BLOCKED', 'You cannot approve your own request', [
      reasonB('permission', 'SELF_APPROVAL', 'The person who requested a change cannot approve it'),
    ]), 403);
  }
  if (ap.approver_user_id !== session.user.id && !roleSatisfies(session.user.role, ap.approver_role_required)) {
    return c.json(orderBlock('APPROVAL_BLOCKED', 'You cannot decide this approval', [
      reasonB('permission', 'ROLE_INSUFFICIENT', `This approval must be decided by a ${ap.approver_role_required}`),
    ]), 403);
  }

  // Record the decision on the approval row.
  await sql`
    UPDATE approval_requests SET
      status = ${decision}::text, decision_at = now(), decision_by_user_id = ${session.user.id}::uuid,
      decision_reason_notes = ${reason_notes ?? null}::text, updated_at = now()
    WHERE id = ${id}::uuid AND workspace_id = ${session.workspace.id}::uuid
  `;

  let resourceResult: unknown = null;
  if (decision === 'approved') {
    if (ap.resource_type === 'order_extension') {
      resourceResult = await applyExtensionEffects({
        workspaceId: session.workspace.id, orderId: ap.order_id!, actorUserId: session.user.id,
        extensionId: ap.resource_id, approvedByUserId: session.user.id,
        ctx: { ipAddress, userAgent },
      });
    } else if (ap.resource_type === 'order_cancellation') {
      const settings = await loadWorkspaceSettings(session.workspace.id);
      resourceResult = await applyCancellationEffects({
        workspaceId: session.workspace.id, orderId: ap.order_id!, actorUserId: session.user.id,
        cancellationId: ap.resource_id, approvedByUserId: session.user.id, settings,
        ctx: { ipAddress, userAgent },
      });
    }
  } else {
    // Rejected → mark the resource rejected so it's not left dangling.
    if (ap.resource_type === 'order_extension') {
      await sql`UPDATE order_extensions SET status = 'rejected', status_reason = ${reason_notes ?? null}::text, updated_at = now()
                WHERE id = ${ap.resource_id}::uuid AND workspace_id = ${session.workspace.id}::uuid`;
    } else if (ap.resource_type === 'order_cancellation') {
      await sql`UPDATE order_cancellations SET status = 'rejected', status_reason = ${reason_notes ?? null}::text, updated_at = now()
                WHERE id = ${ap.resource_id}::uuid AND workspace_id = ${session.workspace.id}::uuid`;
    }
  }

  await audit({
    workspaceId: session.workspace.id, actorUserId: session.user.id,
    eventType: decision === 'approved' ? 'approvals.approved' : 'approvals.rejected',
    targetType: 'approval_request', targetId: id,
    payload: { resource_type: ap.resource_type, resource_id: ap.resource_id, order_id: ap.order_id, reason_notes: reason_notes ?? null },
    ipAddress, userAgent,
  });

  // Timeline on the affected order + notify the requester.
  if (ap.order_id) {
    await sql`
      INSERT INTO order_events (workspace_id, order_id, event_type, payload, actor_user_id)
      VALUES (${session.workspace.id}::uuid, ${ap.order_id}::uuid,
              ${decision === 'approved' ? 'order.approval.approved' : 'order.approval.rejected'}::text,
              ${JSON.stringify({ approval_id: id, resource_type: ap.resource_type, reason_notes: reason_notes ?? null })}::jsonb,
              ${session.user.id}::uuid)
    `.catch(() => {});
  }
  emitNotification({
    workspaceId: session.workspace.id, actorUserId: session.user.id,
    eventType: decision === 'approved' ? 'approval_approved' : 'approval_rejected',
    targetType: 'approval_request', targetId: id,
    linkUrl: ap.order_id ? `/order-360.html?id=${ap.order_id}` : undefined,
    metadata: {
      order_number: ap.order_number ?? '', resource_label: RESOURCE_LABEL[ap.resource_type] ?? ap.resource_type,
      actor_name: session.user.displayName ?? '', reason_suffix: reason_notes ? ` Reason: ${reason_notes}` : '',
    },
  }).catch(() => {});

  return c.json({ approval_id: id, decision, resource_updated: decision === 'approved', resource: resourceResult });
});

// ----------------------------------------------------------------------------
// POST /:id/withdraw — the requester cancels their own pending request.
// ----------------------------------------------------------------------------
approvals.post('/:id/withdraw', async (c) => {
  const session = c.get('session')!;
  const { ipAddress, userAgent } = clientCtx(c);
  const id = c.req.param('id');
  const ap = await loadApproval(id, session.workspace.id);
  if (!ap) return c.json({ error: 'not_found' }, 404);
  if (ap.requester_user_id !== session.user.id) {
    return c.json({ error: 'forbidden', reason: 'only_requester_can_withdraw' }, 403);
  }
  if (ap.status !== 'pending') {
    return c.json({ error: 'not_pending', status: ap.status }, 409);
  }
  await sql`
    UPDATE approval_requests SET status = 'withdrawn', decision_at = now(),
      decision_by_user_id = ${session.user.id}::uuid, updated_at = now()
    WHERE id = ${id}::uuid AND workspace_id = ${session.workspace.id}::uuid
  `;
  // Mark the linked resource cancelled so nothing dangles.
  if (ap.resource_type === 'order_extension') {
    await sql`UPDATE order_extensions SET status = 'cancelled', updated_at = now()
              WHERE id = ${ap.resource_id}::uuid AND workspace_id = ${session.workspace.id}::uuid`;
  } else if (ap.resource_type === 'order_cancellation') {
    await sql`UPDATE order_cancellations SET status = 'rejected', status_reason = 'withdrawn', updated_at = now()
              WHERE id = ${ap.resource_id}::uuid AND workspace_id = ${session.workspace.id}::uuid`;
  }
  await audit({
    workspaceId: session.workspace.id, actorUserId: session.user.id, eventType: 'approvals.withdrawn',
    targetType: 'approval_request', targetId: id,
    payload: { resource_type: ap.resource_type, resource_id: ap.resource_id }, ipAddress, userAgent,
  });
  return c.json({ approval_id: id, status: 'withdrawn' });
});
