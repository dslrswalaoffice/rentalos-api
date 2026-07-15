// ============================================================================
// src/lib/approvals.ts (Sub-slice 2.1) — approval routing brain
// ----------------------------------------------------------------------------
// Cross-cutting approval infrastructure. A workflow that a policy blocks calls
// createApprovalRequest(); routing picks an approver by role (one-role-up, or an
// amount override to owner). The decide endpoint (src/routes/approvals.ts) drives
// the downstream workflow. Every policy threshold is read from
// workspaces.settings — nothing is hardcoded (Aamir's configurability rule).
//
// Approver ≠ requester (self-approval blocked). Owner is the ceiling: an owner
// can decide anything; managers can decide only what routes to 'manager'.
// ============================================================================

import { sql, query } from '../db.js';

export type ApproverRole = 'manager' | 'owner';

/** Full workspace settings JSONB (whatever shape it currently holds). */
export async function loadWorkspaceSettings(workspaceId: string): Promise<Record<string, any>> {
  const rows = await query<{ settings: Record<string, any> | null }>(sql`
    SELECT settings FROM workspaces WHERE id = ${workspaceId}::uuid LIMIT 1
  `);
  return (rows[0]?.settings ?? {}) as Record<string, any>;
}

// ----------------------------------------------------------------------------
// Policy evaluation. Each returns whether approval is required, to which role,
// and the human-readable reasons (for the request snapshot + UI).
// ----------------------------------------------------------------------------
export type ApprovalDecision = {
  requires: boolean;
  role: ApproverRole;
  reasons: string[];
};

function num(v: unknown, dflt = 0): number {
  const n = Number(v);
  return Number.isFinite(n) ? n : dflt;
}

/** Extension approval policy — settings.extension_policy + approval_routing. */
export function evaluateExtensionApproval(
  settings: Record<string, any>,
  input: { additionalDays: number; additionalChargesPaise: number; originalUnpaid: boolean; isNewCustomer: boolean },
): ApprovalDecision {
  const ep = settings.extension_policy ?? {};
  const routing = settings.approval_routing?.resource_type_overrides?.order_extension ?? {};
  const reasons: string[] = [];
  let requires = false;
  let role: ApproverRole = 'manager';

  const daysThreshold = num(ep.requires_approval_over_days, 2);
  if (input.additionalDays > daysThreshold) {
    requires = true;
    reasons.push(`Extension of ${input.additionalDays} days exceeds the ${daysThreshold}-day limit`);
    role = (routing.days_over_routes_to?.target_role as ApproverRole) ?? role;
  }

  const valueThreshold = num(ep.requires_approval_over_value_paise, 0);
  if (valueThreshold > 0 && input.additionalChargesPaise > valueThreshold) {
    requires = true;
    reasons.push(`Additional charges exceed the value threshold`);
    role = (routing.value_over_routes_to?.target_role as ApproverRole) ?? role;
  }

  if (ep.requires_approval_if_original_unpaid && input.originalUnpaid) {
    requires = true;
    reasons.push('Original order is not fully paid');
  }
  if (ep.requires_approval_for_new_customers && input.isNewCustomer) {
    requires = true;
    reasons.push('New customer — first order');
  }

  role = amountEscalation(settings, input.additionalChargesPaise, role);
  return { requires, role, reasons };
}

/** Cancellation approval policy — settings.cancellation_policy + approval_routing. */
export function evaluateCancellationApproval(
  settings: Record<string, any>,
  input: { tier: string; refundAmountPaise: number; isNoShow: boolean },
): ApprovalDecision {
  const cp = settings.cancellation_policy ?? {};
  const ra = cp.requires_approval ?? {};
  const routing = settings.approval_routing?.resource_type_overrides?.order_cancellation ?? {};
  const reasons: string[] = [];
  let requires = false;
  let role: ApproverRole = 'manager';

  if (input.tier === 'under_24hr' && ra.under_24hr_cancellations) {
    requires = true;
    reasons.push('Cancellation within 24 hours of dispatch');
    role = (routing.under_24hr_routes_to as ApproverRole) ?? role;
  }
  if (input.isNoShow && ra.no_show_cancellations) {
    requires = true;
    reasons.push('No-show cancellation');
    role = (routing.no_show_routes_to as ApproverRole) ?? 'owner';
  }
  const refundThreshold = num(ra.refunds_over_paise, 0);
  if (refundThreshold > 0 && input.refundAmountPaise > refundThreshold) {
    requires = true;
    reasons.push('Refund exceeds the approval threshold');
    const t = routing.refund_over_paise_routes_to?.target_role as ApproverRole | undefined;
    if (t) role = t;
  }

  role = amountEscalation(settings, input.refundAmountPaise, role);
  return { requires, role, reasons };
}

/** Global amount override: any money over route_by_amount.over_paise → owner. */
function amountEscalation(settings: Record<string, any>, amountPaise: number, role: ApproverRole): ApproverRole {
  const rba = settings.approval_routing?.route_by_amount;
  if (rba && num(rba.over_paise, Infinity) > 0 && amountPaise > num(rba.over_paise, Infinity)) {
    return (rba.target_role as ApproverRole) ?? 'owner';
  }
  return role;
}

// ----------------------------------------------------------------------------
// Routing: pick an approver user for a required role, excluding the requester.
// 'owner' → an active owner. 'manager' → an active manager, else escalate to an
// owner (there's always at least one owner). Returns null if none found; then
// the approval is role-gated (anyone with the role can decide it).
// ----------------------------------------------------------------------------
export async function routeApprover(
  workspaceId: string,
  requiredRole: ApproverRole,
  excludeUserId: string,
): Promise<string | null> {
  const roleList = requiredRole === 'owner' ? ['owner'] : ['manager', 'owner'];
  const rows = await query<{ user_id: string; role: string }>(sql`
    SELECT m.user_id, m.role
    FROM workspace_memberships m
    JOIN users u ON u.id = m.user_id
    WHERE m.workspace_id = ${workspaceId}::uuid
      AND m.status = 'active'
      AND u.deleted_at IS NULL
      AND m.user_id != ${excludeUserId}::uuid
      AND m.role::text = ANY(string_to_array(${roleList.join(',')}::text, ','))
    ORDER BY (m.role::text = ${requiredRole}::text) DESC, m.role
    LIMIT 1
  `);
  return rows[0]?.user_id ?? null;
}

// ----------------------------------------------------------------------------
// createApprovalRequest — insert a pending row and route it. Returns the id +
// resolved approver (may be null → role-gated). Timing from settings.
// ----------------------------------------------------------------------------
export async function createApprovalRequest(args: {
  workspaceId: string;
  requesterUserId: string;
  requiredRole: ApproverRole;
  resourceType: string;
  resourceId: string;
  orderId?: string | null;
  reasonTag?: string | null;
  reasonNotes?: string | null;
  requestSnapshot: Record<string, unknown>;
  policySnapshot: Record<string, unknown>;
}): Promise<{ id: string; approver_user_id: string | null; expires_at: string | null }> {
  const settings = await loadWorkspaceSettings(args.workspaceId);
  const expireHours = num(settings.approval_routing?.auto_expire_hours, 72);
  const approver = await routeApprover(args.workspaceId, args.requiredRole, args.requesterUserId);

  const rows = await query<{ id: string; approver_user_id: string | null; expires_at: string | null }>(sql`
    INSERT INTO approval_requests (
      workspace_id, requester_user_id, approver_user_id, approver_role_required,
      resource_type, resource_id, order_id, request_reason_tag, request_reason_notes,
      request_snapshot, policy_applied_snapshot, status, expires_at
    ) VALUES (
      ${args.workspaceId}::uuid, ${args.requesterUserId}::uuid, ${approver}::uuid, ${args.requiredRole}::text,
      ${args.resourceType}::text, ${args.resourceId}::uuid, ${args.orderId ?? null}::uuid,
      ${args.reasonTag ?? null}::text, ${args.reasonNotes ?? null}::text,
      ${JSON.stringify(args.requestSnapshot)}::jsonb, ${JSON.stringify(args.policySnapshot)}::jsonb,
      'pending', now() + make_interval(hours => ${expireHours}::int)
    )
    RETURNING id, approver_user_id, expires_at
  `);
  return rows[0]!;
}

/** Can this session role decide an approval routed to requiredRole? Owner always;
 *  manager only when the required role is 'manager'. */
export function roleSatisfies(sessionRole: string, requiredRole: ApproverRole): boolean {
  if (sessionRole === 'owner') return true;
  if (sessionRole === 'manager' && requiredRole === 'manager') return true;
  return false;
}
