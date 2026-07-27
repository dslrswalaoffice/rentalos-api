-- ===========================================================================
-- 070_damage_endpoint_retirement.sql -- Phase 1 completion Session 3.
-- ---------------------------------------------------------------------------
-- Retiring the legacy damage approve/reject endpoints leaves ONE population
-- unhandled: "orphan" incidents that still need approval but never got an
-- Approval Engine request --
--     requires_approval = true  AND  approval_request_id IS NULL
-- These are pre-Session-2 incidents (the engine didn't exist yet) OR any incident
-- whose fail-soft createApprovalRequest didn't land. Without the legacy /approve
-- endpoint they'd be un-decidable (no engine request to act on in Approvals), so
-- this migration BACKFILLS a canonical damage_financial_resolution request for
-- each, then points the incident's FK at it -- exactly what the Session 2 route
-- does live for new above-threshold resolutions.
--
-- NOTE: the retirement session could not run the production orphan COUNT (the
-- session had no DATABASE_URL). This migration is therefore written to be a SAFE
-- SUPERSET: it is a NO-OP when zero orphans exist and the correct fix when any do,
-- so the retirement is safe regardless of the real count. It is also IDEMPOTENT --
-- the WHERE guard only matches un-backfilled orphans, and the same statement sets
-- their approval_request_id, so a re-run matches nothing.
--
-- Snapshot mirrors createApprovalRequest (src/lib/approvals.ts): request inputs
-- frozen from the incident's current financial fields; policy from the workspace
-- damage_policy (fallback '{}' for historically-missing settings). Routed to the
-- workspace owner (approver_role_required='owner' -- preserves the old owner-only
-- damage.approve gate). expires_at is set FORWARD (now()+72h) so a backfilled
-- historical incident is actionable now and is NOT immediately swept by the
-- approvals-expiry cron; requested_at keeps the incident's real reported_at.
--
-- Additive + idempotent. Runs inside the transactional migration runner (the
-- INSERT + FK update are one CTE statement -> atomic per orphan set).
-- ===========================================================================

WITH orphans AS (
  SELECT
    di.id            AS incident_id,
    di.workspace_id,
    di.order_id,
    di.created_by,                      -- NOT NULL on damage_incidents (the reporter)
    di.reported_at,
    di.customer_liability,
    di.liability_percent,
    di.final_cost_paise,
    di.deposit_action,
    di.deposit_forfeit_amount_paise,
    COALESCE(w.settings->'damage_policy', '{}'::jsonb) AS damage_policy,
    (SELECT m.user_id FROM workspace_memberships m
       WHERE m.workspace_id = di.workspace_id AND m.role = 'owner' AND m.status = 'active'
       ORDER BY m.joined_at ASC LIMIT 1) AS owner_user_id
  FROM damage_incidents di
  JOIN workspaces w ON w.id = di.workspace_id
  WHERE di.requires_approval = true
    AND di.approval_request_id IS NULL
),
ins AS (
  INSERT INTO approval_requests (
    workspace_id, requester_user_id, approver_user_id, approver_role_required,
    resource_type, resource_id, order_id,
    request_reason_tag, request_reason_notes,
    request_snapshot, policy_applied_snapshot,
    status, requested_at, expires_at
  )
  SELECT
    o.workspace_id,
    o.created_by,                       -- requester = the incident reporter (always present)
    o.owner_user_id,                    -- routed to the owner (nullable if none active)
    'owner',
    'damage_financial_resolution',
    o.incident_id,                      -- approval_requests.resource_id == damage_incident.id
    o.order_id,
    'damage_financial_over_threshold',
    'Backfilled during Phase 1 completion Session 3 (legacy /approve retirement).',
    jsonb_build_object(
      'customer_liability',            o.customer_liability,
      'liability_percent',             o.liability_percent,
      'final_cost_paise',              o.final_cost_paise,
      'deposit_action',                o.deposit_action,
      'deposit_forfeit_amount_paise',  o.deposit_forfeit_amount_paise
    ),
    o.damage_policy,
    'pending',
    o.reported_at,                      -- honest historical request time
    now() + interval '72 hours'         -- forward expiry -> actionable now, not pre-expired
  FROM orphans o
  RETURNING id, resource_id
)
UPDATE damage_incidents di
SET approval_request_id = ins.id, updated_at = now()
FROM ins
-- ins.resource_id IS the incident PK (set on INSERT above), so this uniquely
-- matches one incident. No workspace cross-check is needed (and a subquery reading
-- approval_requests here would NOT see the CTE's just-inserted rows — that snapshot
-- gap silently broke the FK update + idempotency; caught by PG16 Rule B).
WHERE di.id = ins.resource_id;
