-- 044_standbys.sql — Sub-slice 2.2: first-class timed reservation (standby).
-- ---------------------------------------------------------------------------
-- NUMBERING: the pack calls this "043", but 2.1.5 already took 043
-- (notification_delivery_tracking). Migrations are matched by filename and must
-- be monotonic, so standbys = 044 and quote_versions = 045.
--
-- ⚠ AUTOCOMMIT MIGRATION: this file contains `ALTER TYPE order_status ADD VALUE`,
-- which Postgres forbids inside a transaction block. The migration runner detects
-- that and runs the WHOLE file in autocommit (non-atomic), so EVERY statement
-- here is individually idempotent (IF NOT EXISTS / guarded) — a partial failure
-- re-converges on the next deploy. The new enum values are NOT used within this
-- migration (standbys.status is its own TEXT+CHECK), avoiding the "unsafe use of
-- new value in same transaction" trap.
--
-- Discipline: gen_random_uuid() (v4 — v7 doesn't exist here), workspace_id 2nd
-- column NOT NULL, json settings seed uses the create-parent merge pattern.
-- ---------------------------------------------------------------------------

-- New lifecycle states for orders that are held on standby.
ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'standby';
ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'standby_expired';
ALTER TYPE order_status ADD VALUE IF NOT EXISTS 'standby_released';

CREATE TABLE IF NOT EXISTS standbys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  order_id UUID REFERENCES orders(id),                   -- nullable: standby may precede the order
  customer_id UUID NOT NULL REFERENCES people(id),

  standby_number TEXT NOT NULL,                          -- SB-2026-0142
  requested_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  requested_by_source TEXT NOT NULL,                     -- staff | quote_conversion | portal | auto_suggested
  requested_via TEXT NOT NULL,                           -- whatsapp | phone | walk_in | portal | in_person
  requested_by_user_id UUID REFERENCES users(id),

  rental_start_at TIMESTAMPTZ NOT NULL,
  rental_end_at TIMESTAMPTZ NOT NULL,

  hold_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at TIMESTAMPTZ NOT NULL,
  hold_duration_minutes INTEGER NOT NULL,
  grace_period_ends_at TIMESTAMPTZ,

  reason_tag TEXT NOT NULL,
  reason_notes TEXT,

  estimated_value_paise BIGINT DEFAULT 0,
  line_items_snapshot JSONB NOT NULL DEFAULT '[]'::jsonb,

  requires_approval BOOLEAN NOT NULL DEFAULT FALSE,
  approval_request_id UUID REFERENCES approval_requests(id),
  approved_by_user_id UUID REFERENCES users(id),

  customer_notified_at TIMESTAMPTZ,
  customer_reminder_sent_at TIMESTAMPTZ,
  staff_reminder_sent_at TIMESTAMPTZ,

  status TEXT NOT NULL DEFAULT 'active',
  outcome_reason TEXT,
  converted_to_type TEXT,                                -- quote | booking
  converted_to_id UUID,

  policy_applied_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT standby_status_valid CHECK (status IN (
    'active','expired','released_manually','converted_to_quote','converted_to_booking',
    'pending_approval','rejected'
  ))
);

CREATE INDEX IF NOT EXISTS standbys_workspace_status_idx ON standbys (workspace_id, status, expires_at) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS standbys_customer_active_idx ON standbys (customer_id, status) WHERE status = 'active';
CREATE INDEX IF NOT EXISTS standbys_expires_at_idx ON standbys (expires_at) WHERE status = 'active';

-- Soft-reservation on line items (a standby holds availability without committing).
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS is_soft_reserved BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE order_items ADD COLUMN IF NOT EXISTS soft_reserved_standby_id UUID REFERENCES standbys(id);
CREATE INDEX IF NOT EXISTS order_items_soft_reserved_idx ON order_items (product_id) WHERE is_soft_reserved = true;

-- Default standby policy → workspaces.settings.standby_policy (idempotent).
UPDATE workspaces
SET settings = jsonb_set(
  COALESCE(settings, '{}'::jsonb),
  '{standby_policy}',
  COALESCE(
    settings->'standby_policy',
    jsonb_build_object(
      'default_hold_duration_minutes', 240,
      'grace_period_minutes', 30,
      'max_hold_duration_by_role', jsonb_build_object('staff', 480, 'manager', 1440, 'owner', 4320),
      'concurrent_holds_cap_by_segment', jsonb_build_object('new_customer', 1, 'repeat', 2, 'loyal', 3, 'vip', 999),
      'requires_approval', jsonb_build_object(
        'value_over_paise', 2500000,
        'duration_over_minutes', 1440,
        'customer_release_ratio_over', 0.7,
        'crosses_high_demand_period', true,
        'cap_override', true
      ),
      'reminders', jsonb_build_object('customer_before_expiry_minutes', 60, 'staff_before_expiry_minutes', 15),
      'on_expiry', jsonb_build_object(
        'auto_release_availability', true,
        'auto_convert_to_quote', false,
        'customer_notification', true,
        'customer_reclaim_grace_minutes', 30
      ),
      'conversion_analytics', jsonb_build_object('flag_customer_after_repeat_non_conversions', 3),
      'allow_customer_self_service_via_portal', false,
      'auto_suggest_hold_during_quote_flow', true
    )
  ),
  true
)
WHERE deleted_at IS NULL;

-- Standby customer/staff email templates → notification_policy.templates (create-parent merge).
UPDATE workspaces
SET settings = jsonb_set(
  COALESCE(settings, '{}'::jsonb),
  '{notification_policy}',
  COALESCE(settings->'notification_policy', '{}'::jsonb) || jsonb_build_object(
    'templates',
    COALESCE(settings->'notification_policy'->'templates', '{}'::jsonb) || jsonb_build_object(
      'standby_expiring', jsonb_build_object(
        'email', jsonb_build_object(
          'subject', 'Your hold on order {standby_number} expires soon',
          'body', 'Hi {customer_name},

Your hold {standby_number} ({items_summary}) expires at {expires_at}. Let us know soon if you''d like to confirm the booking.

Thank you,
{workspace_name}'
        ),
        'whatsapp', jsonb_build_object('template_name', null, 'variable_order', null)
      ),
      'standby_expired', jsonb_build_object(
        'email', jsonb_build_object(
          'subject', 'Your hold {standby_number} has expired',
          'body', 'Hi {customer_name},

Your hold {standby_number} has expired and the equipment has been released. If you''d still like it, reply within {reclaim_minutes} minutes and we''ll try to reclaim it.

Thank you,
{workspace_name}'
        ),
        'whatsapp', jsonb_build_object('template_name', null, 'variable_order', null)
      )
    )
  ),
  true
)
WHERE deleted_at IS NULL;
