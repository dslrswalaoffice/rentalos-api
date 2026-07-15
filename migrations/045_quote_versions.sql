-- 045_quote_versions.sql — Sub-slice 2.2: immutable snapshot quote versioning.
-- ---------------------------------------------------------------------------
-- (Pack calls this "044"; shifted to 045 — see 044_standbys.sql numbering note.)
-- Fully transactional (no tx-hostile statements). gen_random_uuid() (v4).
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS quote_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id UUID NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  order_id UUID NOT NULL REFERENCES orders(id),

  version_number INTEGER NOT NULL,                       -- v1, v2, … per order
  quote_number TEXT NOT NULL,                            -- QT-2026-0142-v1

  content_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,   -- frozen at 'sent'
  total_paise BIGINT NOT NULL DEFAULT 0,
  deposit_paise BIGINT NOT NULL DEFAULT 0,
  rental_start_at TIMESTAMPTZ,
  rental_end_at TIMESTAMPTZ,
  valid_until TIMESTAMPTZ,

  status TEXT NOT NULL DEFAULT 'draft',                  -- draft|sent|viewed|accepted|superseded|expired|withdrawn|rejected

  sent_at TIMESTAMPTZ,
  first_viewed_at TIMESTAMPTZ,
  last_viewed_at TIMESTAMPTZ,
  view_count INTEGER NOT NULL DEFAULT 0,
  accepted_at TIMESTAMPTZ,
  superseded_at TIMESTAMPTZ,
  expired_at TIMESTAMPTZ,
  withdrawn_at TIMESTAMPTZ,
  rejected_at TIMESTAMPTZ,
  expiry_notified_at TIMESTAMPTZ,                        -- for the quote-expiry monitor (2-day-before dedup)

  created_by_user_id UUID NOT NULL REFERENCES users(id),
  sent_by_user_id UUID REFERENCES users(id),
  withdrawn_by_user_id UUID REFERENCES users(id),
  withdrawn_reason TEXT,

  acceptance_source TEXT,                                -- customer_portal | staff_confirmed | in_person_signature | email_reply | whatsapp
  acceptance_signature_url TEXT,
  acceptance_ip_address TEXT,
  acceptance_notes TEXT,

  parent_version_id UUID REFERENCES quote_versions(id),
  superseded_by_version_id UUID REFERENCES quote_versions(id),
  diff_from_parent JSONB,
  revision_reason_tag TEXT,
  revision_reason_notes TEXT,

  document_url TEXT,
  tracking_link_url TEXT,                                -- secure random token (path segment)
  reject_reason TEXT,

  policy_applied_snapshot JSONB NOT NULL DEFAULT '{}'::jsonb,

  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT quote_version_status_valid CHECK (status IN (
    'draft','sent','viewed','accepted','superseded','expired','withdrawn','rejected'
  )),
  CONSTRAINT quote_version_number_per_order UNIQUE (order_id, version_number)
);

CREATE INDEX IF NOT EXISTS quote_versions_order_version_idx ON quote_versions (order_id, version_number DESC);
CREATE INDEX IF NOT EXISTS quote_versions_workspace_status_idx ON quote_versions (workspace_id, status, sent_at DESC);
-- Token uniqueness enforced at the DB level for the public tracking surface.
CREATE UNIQUE INDEX IF NOT EXISTS quote_versions_tracking_link_uidx ON quote_versions (tracking_link_url) WHERE tracking_link_url IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS quote_versions_accepted_per_order_idx ON quote_versions (order_id) WHERE status = 'accepted';
-- Quote-expiry monitor sweep.
CREATE INDEX IF NOT EXISTS quote_versions_valid_until_idx ON quote_versions (valid_until) WHERE status IN ('sent','viewed');

ALTER TABLE orders ADD COLUMN IF NOT EXISTS accepted_quote_version_id UUID REFERENCES quote_versions(id);
ALTER TABLE orders ADD COLUMN IF NOT EXISTS active_quote_version_id UUID REFERENCES quote_versions(id);

-- Default quote policy → workspaces.settings.quote_policy (idempotent).
UPDATE workspaces
SET settings = jsonb_set(
  COALESCE(settings, '{}'::jsonb),
  '{quote_policy}',
  COALESCE(
    settings->'quote_policy',
    jsonb_build_object(
      'default_validity_days', 7,
      'validity_by_customer_segment', jsonb_build_object('new_customer', 3, 'repeat', 7, 'vip', 14),
      'validity_by_value_paise', jsonb_build_object('over_100000_paise', 14),
      'acceptance_sources_allowed', jsonb_build_array('customer_portal', 'staff_confirmed', 'in_person_signature', 'email_reply', 'whatsapp'),
      'require_evidence_for_staff_confirmed_acceptance', true,
      'require_customer_signature_over_paise', 5000000,
      'auto_expire_on_valid_until', true,
      'notify_customer_before_expiry_days', 2,
      'keep_superseded_versions_viewable_to_customer', false,
      'invalidate_superseded_tracking_links', true,
      'diff_display_default', 'detailed',
      'require_reason_tag_on_revision', true,
      'revision_notification_default_to_customer', true,
      'allow_withdrawn_quote_after_acceptance', true,
      'withdrawn_after_acceptance_requires_approval', true,
      'quote_document_number_format', 'QT-{year}-{sequence}-v{version}'
    )
  ),
  true
)
WHERE deleted_at IS NULL;

-- Quote email templates → notification_policy.templates (create-parent merge).
UPDATE workspaces
SET settings = jsonb_set(
  COALESCE(settings, '{}'::jsonb),
  '{notification_policy}',
  COALESCE(settings->'notification_policy', '{}'::jsonb) || jsonb_build_object(
    'templates',
    COALESCE(settings->'notification_policy'->'templates', '{}'::jsonb) || jsonb_build_object(
      'quote_sent', jsonb_build_object(
        'email', jsonb_build_object(
          'subject', 'Your quote {quote_number} from {workspace_name}',
          'body', 'Hi {customer_name},

Your quote {quote_number} for {total_amount} is ready. Rental window: {rental_start} to {rental_end}. This quote is valid until {valid_until}.

View and accept it here: {tracking_url}

Thank you,
{workspace_name}'
        ),
        'whatsapp', jsonb_build_object('template_name', null, 'variable_order', null)
      ),
      'quote_reminder', jsonb_build_object(
        'email', jsonb_build_object(
          'subject', 'Reminder: your quote {quote_number} is waiting',
          'body', 'Hi {customer_name},

A quick reminder about quote {quote_number} for {total_amount}, valid until {valid_until}. You can review and accept it here: {tracking_url}

Thank you,
{workspace_name}'
        ),
        'whatsapp', jsonb_build_object('template_name', null, 'variable_order', null)
      ),
      'quote_expiring', jsonb_build_object(
        'email', jsonb_build_object(
          'subject', 'Your quote {quote_number} expires on {valid_until}',
          'body', 'Hi {customer_name},

Your quote {quote_number} for {total_amount} expires on {valid_until}. Accept it here before then to lock in your booking: {tracking_url}

Thank you,
{workspace_name}'
        ),
        'whatsapp', jsonb_build_object('template_name', null, 'variable_order', null)
      ),
      'quote_accepted', jsonb_build_object(
        'email', jsonb_build_object(
          'subject', 'Quote {quote_number} accepted — order confirmed',
          'body', 'Hi {customer_name},

Thank you — quote {quote_number} for {total_amount} has been accepted and your order #{order_number} is confirmed. We''ll be in touch with next steps.

{workspace_name}'
        ),
        'whatsapp', jsonb_build_object('template_name', null, 'variable_order', null)
      )
    )
  ),
  true
)
WHERE deleted_at IS NULL;
