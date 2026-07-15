-- 040_approval_requests.sql — Sub-slice 2.1: cross-cutting approval routing.
-- ---------------------------------------------------------------------------
-- A single approval_requests spine every workflow (extension, cancellation,
-- and — in later sub-slices — damage, substitution) routes through. A blocked
-- action creates one row, routes it to an approver by role (one-role-up, or an
-- amount override), and the decide endpoint drives the downstream workflow.
--
-- Discipline:
--   * gen_random_uuid() (NOT v7 — the pack's gen_random_uuid_v7() does not exist
--     in this database; the whole codebase uses gen_random_uuid()).
--   * workspace_id second column, NOT NULL, FK to workspaces.
--   * Owner can never be an approver_role_required target (owner is the ceiling,
--     not a routing level); the CHECK allows only manager|owner as the required
--     role, matching the escalation model.
--   * Additive + idempotent (IF NOT EXISTS) — runs inside the transactional
--     migration runner.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS approval_requests (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  requester_user_id UUID NOT NULL REFERENCES users(id),
  approver_user_id UUID REFERENCES users(id),        -- nullable until routed to a person
  approver_role_required TEXT NOT NULL,              -- 'manager' | 'owner'

  -- What's being approved
  resource_type TEXT NOT NULL,                        -- 'order_extension' | 'order_cancellation' | ...
  resource_id UUID NOT NULL,

  -- Context (frozen at request time)
  order_id UUID REFERENCES orders(id),               -- soft link so Order 360 can surface pending approvals
  request_reason_tag TEXT,
  request_reason_notes TEXT,
  request_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  policy_applied_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Decision
  status TEXT NOT NULL DEFAULT 'pending',             -- pending | approved | rejected | expired | withdrawn
  decision_at TIMESTAMPTZ,
  decision_by_user_id UUID REFERENCES users(id),
  decision_reason_notes TEXT,

  -- Timing
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ,
  reminded_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT approval_status_valid CHECK (status IN ('pending','approved','rejected','expired','withdrawn')),
  CONSTRAINT approval_role_valid CHECK (approver_role_required IN ('manager','owner'))
);

CREATE INDEX IF NOT EXISTS approval_requests_workspace_status_idx
  ON approval_requests (workspace_id, status, requested_at DESC);
CREATE INDEX IF NOT EXISTS approval_requests_approver_pending_idx
  ON approval_requests (workspace_id, approver_user_id, status) WHERE status = 'pending';
CREATE INDEX IF NOT EXISTS approval_requests_resource_idx
  ON approval_requests (resource_type, resource_id);
CREATE INDEX IF NOT EXISTS approval_requests_order_idx
  ON approval_requests (order_id) WHERE order_id IS NOT NULL;

-- Default approval routing policy → workspaces.settings.approval_routing.
-- Idempotent: only sets the key when absent (COALESCE preserves any edits).
UPDATE workspaces
SET settings = jsonb_set(
  COALESCE(settings, '{}'::jsonb),
  '{approval_routing}',
  COALESCE(
    settings->'approval_routing',
    jsonb_build_object(
      'escalation_rule', 'one_role_up',
      'route_by_amount', jsonb_build_object(
        'over_paise', 5000000,
        'target_role', 'owner'
      ),
      'auto_expire_hours', 72,
      'remind_after_hours', 24,
      'resource_type_overrides', jsonb_build_object(
        'order_cancellation', jsonb_build_object(
          'under_24hr_routes_to', 'manager',
          'no_show_routes_to', 'owner',
          'refund_over_paise_routes_to', jsonb_build_object(
            'threshold_paise', 2500000,
            'target_role', 'owner'
          )
        ),
        'order_extension', jsonb_build_object(
          'days_over_routes_to', jsonb_build_object(
            'threshold_days', 2,
            'target_role', 'manager'
          ),
          'value_over_paise_routes_to', jsonb_build_object(
            'threshold_paise', 1000000,
            'target_role', 'manager'
          )
        )
      )
    )
  ),
  true
)
WHERE deleted_at IS NULL;
