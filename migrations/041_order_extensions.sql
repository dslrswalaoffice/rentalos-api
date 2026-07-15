-- 041_order_extensions.sql — Sub-slice 2.1: first-class extension records.
-- ---------------------------------------------------------------------------
-- The POST /orders/:id/extend endpoint (Sub-turn 6c) already moves rental_end
-- and revises invoices. This makes each extension a first-class, queryable row
-- with policy audit + optional approval linkage, without changing the existing
-- side effects. Additive + idempotent.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS order_extensions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  order_id UUID NOT NULL REFERENCES orders(id),

  extension_number INTEGER NOT NULL,                  -- 1st, 2nd, … extension on this order
  original_rental_end_at TIMESTAMPTZ NOT NULL,
  new_rental_end_at TIMESTAMPTZ NOT NULL,
  additional_days INTEGER NOT NULL,

  additional_charges_paise BIGINT NOT NULL DEFAULT 0,
  additional_deposit_paise BIGINT NOT NULL DEFAULT 0,
  additional_charges_line_item_ids UUID[] DEFAULT ARRAY[]::UUID[],

  reason_tag TEXT NOT NULL,                            -- customer_request | shoot_extended | weather | ...
  reason_notes TEXT,

  had_conflict BOOLEAN NOT NULL DEFAULT FALSE,
  conflict_resolution TEXT,                            -- shorten | substitute | reshuffle | force | none
  conflict_resolution_data JSONB,

  requires_approval BOOLEAN NOT NULL DEFAULT FALSE,
  approval_request_id UUID REFERENCES approval_requests(id),

  requested_by_user_id UUID NOT NULL REFERENCES users(id),
  approved_by_user_id UUID REFERENCES users(id),

  status TEXT NOT NULL DEFAULT 'pending_approval',     -- pending_approval | approved | rejected | cancelled
  status_reason TEXT,

  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  approved_at TIMESTAMPTZ,
  effective_at TIMESTAMPTZ,                            -- when actually applied to the order

  policy_applied_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,
  customer_notified_at TIMESTAMPTZ,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT extension_status_valid CHECK (status IN ('pending_approval','approved','rejected','cancelled')),
  CONSTRAINT extension_new_after_original CHECK (new_rental_end_at > original_rental_end_at)
);

CREATE INDEX IF NOT EXISTS order_extensions_workspace_status_idx
  ON order_extensions (workspace_id, status, requested_at DESC);
CREATE INDEX IF NOT EXISTS order_extensions_order_idx
  ON order_extensions (order_id, extension_number);

-- Default extension policy → workspaces.settings.extension_policy (idempotent).
UPDATE workspaces
SET settings = jsonb_set(
  COALESCE(settings, '{}'::jsonb),
  '{extension_policy}',
  COALESCE(
    settings->'extension_policy',
    jsonb_build_object(
      'requires_approval_over_days', 2,
      'requires_approval_over_value_paise', 1000000,
      'requires_approval_if_original_unpaid', true,
      'requires_approval_for_new_customers', true,
      'soft_reserve_window_hours', 4,
      'auto_regenerate_invoice', false,
      'cutoff_hours_before_end', 4,
      'allow_customer_self_service_via_portal', false,
      'customer_notification', jsonb_build_object(
        'channels', jsonb_build_array('whatsapp', 'email'),
        'attach_updated_invoice', true
      )
    )
  ),
  true
)
WHERE deleted_at IS NULL;
