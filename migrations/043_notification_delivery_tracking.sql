-- 043_notification_delivery_tracking.sql — Sub-slice 2.1.5: email adapter wiring.
-- ---------------------------------------------------------------------------
-- Two additive things, both needed to actually DISPATCH notifications (2.1 only
-- recorded delivery intent):
--   1. notification_deliveries gains provider_ref (the SMTP message-id) +
--      retry_count (0 for now; a retry endpoint lands with the WATI slice).
--   2. Seed workspaces.settings.notification_policy.templates — email subject/body
--      per event. WhatsApp template keys are placeholders (null) since the WATI
--      adapter is deliberately NOT wired in 2.1.5.
--
-- NOTE ON NUMBERING: 2.1.5 ships BEFORE 2.2, so it takes 043. Sub-slice 2.2's
-- standbys/quote_versions therefore become 044/045 (the pack's "043/044" shifts
-- by one). Migrations are matched by filename and must be monotonic.
--
-- Additive + idempotent. Runs inside the transactional migration runner.
-- ---------------------------------------------------------------------------

ALTER TABLE notification_deliveries ADD COLUMN IF NOT EXISTS provider_ref text;
ALTER TABLE notification_deliveries ADD COLUMN IF NOT EXISTS retry_count int NOT NULL DEFAULT 0;

-- Seed the email template map (idempotent: only sets templates when absent so an
-- operator's Settings edits are never clobbered by a redeploy). Preserves any
-- existing notification_policy.events modes.
--
-- IMPORTANT: jsonb_set can't create a nested key under a parent that doesn't yet
-- exist, and most workspaces have no notification_policy object at all (2.1 reads
-- it with defaults, never writes it). So we rebuild notification_policy as
-- (existing ?? {}) || { templates: existing_templates ?? default } — this creates
-- the parent, preserves any `events` modes, and keeps operator template edits.
UPDATE workspaces
SET settings = jsonb_set(
  COALESCE(settings, '{}'::jsonb),
  '{notification_policy}',
  COALESCE(settings->'notification_policy', '{}'::jsonb) || jsonb_build_object(
    'templates',
  COALESCE(
    settings->'notification_policy'->'templates',
    jsonb_build_object(
      'extension_confirmed', jsonb_build_object(
        'email', jsonb_build_object(
          'subject', 'Your rental #{order_number} has been extended',
          'body', 'Hi {customer_name},

Your rental order #{order_number} has been extended to {new_end_date}.
Additional charges: {additional_charges}.

Thank you,
{workspace_name}'
        ),
        'whatsapp', jsonb_build_object('template_name', null, 'variable_order', null)
      ),
      'cancellation_confirmed', jsonb_build_object(
        'email', jsonb_build_object(
          'subject', 'Your order #{order_number} has been cancelled',
          'body', 'Hi {customer_name},

Your order #{order_number} has been cancelled. A refund of {refund_amount} will be processed{refund_timeline}.

Sorry to see this order go,
{workspace_name}'
        ),
        'whatsapp', jsonb_build_object('template_name', null, 'variable_order', null)
      ),
      'extension_pending_approval', jsonb_build_object(
        'email', jsonb_build_object(
          'subject', 'Approval needed: extension on order #{order_number}',
          'body', '{actor_name} requested a {delta_days}-day extension on order #{order_number} (approx {additional_charges}).

Review it in RentalOS: {link_url}'
        ),
        'whatsapp', jsonb_build_object('template_name', null, 'variable_order', null)
      ),
      'cancellation_pending_approval', jsonb_build_object(
        'email', jsonb_build_object(
          'subject', 'Approval needed: cancellation on order #{order_number}',
          'body', '{actor_name} requested to cancel order #{order_number} (refund {refund_amount}).

Review it in RentalOS: {link_url}'
        ),
        'whatsapp', jsonb_build_object('template_name', null, 'variable_order', null)
      ),
      'approval_approved', jsonb_build_object(
        'email', jsonb_build_object(
          'subject', 'Approved: {resource_label} on order #{order_number}',
          'body', 'Your {resource_label} request on order #{order_number} was approved by {actor_name}.'
        ),
        'whatsapp', jsonb_build_object('template_name', null, 'variable_order', null)
      ),
      'approval_rejected', jsonb_build_object(
        'email', jsonb_build_object(
          'subject', 'Rejected: {resource_label} on order #{order_number}',
          'body', 'Your {resource_label} request on order #{order_number} was rejected by {actor_name}.{reason_suffix}'
        ),
        'whatsapp', jsonb_build_object('template_name', null, 'variable_order', null)
      )
    )
  )
  ),
  true
)
WHERE deleted_at IS NULL;
