-- 042_order_cancellations.sql — Sub-slice 2.1: first-class cancellation records.
-- ---------------------------------------------------------------------------
-- POST /orders/:id/cancel writes one row per order (terminal). It carries the
-- computed tier, the frozen policy snapshot (legal defense), the financial
-- resolution, and optional approval linkage. Additive + idempotent.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS order_cancellations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  order_id UUID NOT NULL REFERENCES orders(id) UNIQUE,   -- one cancellation per order

  order_state_at_cancellation TEXT NOT NULL,
  hours_before_dispatch DECIMAL(10,2),

  reason_tag TEXT NOT NULL,
  reason_notes TEXT,

  -- Financial resolution
  original_amount_paise BIGINT NOT NULL,
  refund_amount_paise BIGINT NOT NULL DEFAULT 0,
  forfeit_amount_paise BIGINT NOT NULL DEFAULT 0,
  processing_fee_paise BIGINT NOT NULL DEFAULT 0,
  deposit_refunded_paise BIGINT NOT NULL DEFAULT 0,
  deposit_forfeited_paise BIGINT NOT NULL DEFAULT 0,

  -- Refund tracking
  refund_gateway_ref TEXT,
  refund_initiated_at TIMESTAMPTZ,
  refund_completed_at TIMESTAMPTZ,
  refund_expected_credit_by TIMESTAMPTZ,

  requires_approval BOOLEAN NOT NULL DEFAULT FALSE,
  approval_request_id UUID REFERENCES approval_requests(id),

  requested_by_user_id UUID NOT NULL REFERENCES users(id),
  approved_by_user_id UUID REFERENCES users(id),

  status TEXT NOT NULL DEFAULT 'pending_approval',
  status_reason TEXT,

  policy_applied_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  customer_notified_at TIMESTAMPTZ,

  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  confirmed_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT cancellation_status_valid CHECK (status IN (
    'pending_approval','confirmed','rejected','refund_processing','refund_complete','refund_failed'
  )),
  CONSTRAINT cancellation_reason_tag_valid CHECK (reason_tag IN (
    'customer_change_of_plans','customer_budget_issue','shoot_cancelled','duplicate_booking',
    'customer_found_alternative','weather','equipment_issue_on_our_side','no_kyc',
    'payment_failed','customer_no_show','staff_error','other'
  ))
);

CREATE INDEX IF NOT EXISTS order_cancellations_workspace_status_idx
  ON order_cancellations (workspace_id, status, requested_at DESC);

-- Default cancellation policy → workspaces.settings.cancellation_policy (idempotent).
UPDATE workspaces
SET settings = jsonb_set(
  COALESCE(settings, '{}'::jsonb),
  '{cancellation_policy}',
  COALESCE(
    settings->'cancellation_policy',
    jsonb_build_object(
      'tiers', jsonb_build_object(
        'before_72hr', jsonb_build_object('refund_percent', 100, 'processing_fee_paise', 0),
        '24_to_72hr',  jsonb_build_object('refund_percent', 75,  'processing_fee_paise', 0),
        'under_24hr',  jsonb_build_object('refund_percent', 50,  'processing_fee_paise', 0)
      ),
      'no_show_policy', jsonb_build_object(
        'refund_percent', 0,
        'deposit_forfeit_percent', 100
      ),
      'auto_refund_reasons', jsonb_build_array('equipment_issue_on_our_side', 'staff_error'),
      'auto_zero_refund_reasons', jsonb_build_array('customer_no_show'),
      'requires_approval', jsonb_build_object(
        'under_24hr_cancellations', true,
        'refunds_over_paise', 2500000,
        'no_show_cancellations', true
      ),
      'customer_notification', jsonb_build_object(
        'channels', jsonb_build_array('whatsapp', 'email'),
        'attach_credit_note', true,
        'show_refund_timeline', true
      ),
      'refund_processing', jsonb_build_object(
        'auto_initiate_on_confirm', true,
        'expected_business_days', 7
      )
    )
  ),
  true
)
WHERE deleted_at IS NULL;
