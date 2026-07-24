-- 065_notification_slice10.sql -- Slice 10 Session 1: notification firing.
-- ---------------------------------------------------------------------------
-- Activates the notification policy that has been inert since 2.1 (the events
-- map was never seeded, so every event silently defaulted to 'auto'). Three
-- additive changes, all backward compatible:
--
--   1. notification_deliveries.status CHECK gains 'queued', 'delivered', 'read'.
--      Existing rows (pending|sent|failed|skipped) all satisfy the superset, so
--      the constraint swap needs no data fix. Webhook wiring that would WRITE
--      'delivered'/'read' is deferred (Q4) -- the backend can just carry them now.
--
--   2. people gains customer notification_preferences (opt-in per channel) +
--      preferred_language. Existing customers get the opt-everything default and
--      'en' -- no behaviour change until a customer edits their prefs.
--
--   3. workspaces.settings.notification_policy.events is seeded with category
--      defaults (Q1): transactional = 'auto', approval-adjacent = 'auto_with_review',
--      marketing defaults to 'manual_only' (none seeded here). Plus policy scalars
--      (default_language / enable_delivery_receipts / enforce_customer_preferences).
--      Idempotent: only sets keys that are ABSENT, so an operator's Settings edits
--      and the 043-seeded templates are never clobbered.
--
-- NUMBERING: the Private-PII sub-turn reserves 064 (held), so this takes 065.
-- The runner applies unapplied files in filename order and tolerates the gap.
--
-- Additive + idempotent. Runs inside the transactional migration runner.
-- ---------------------------------------------------------------------------

-- 1. Delivery status: append queued/delivered/read (never remove existing values).
ALTER TABLE notification_deliveries DROP CONSTRAINT IF EXISTS notification_deliveries_status_check;
ALTER TABLE notification_deliveries
  ADD CONSTRAINT notification_deliveries_status_check
  CHECK (status IN ('pending', 'queued', 'sent', 'delivered', 'read', 'failed', 'skipped'));

-- 2. Customer notification preferences (opt-in per channel + language).
ALTER TABLE people
  ADD COLUMN IF NOT EXISTS notification_preferences jsonb NOT NULL
  DEFAULT '{"whatsapp": true, "email": true, "sms": false}'::jsonb;

ALTER TABLE people
  ADD COLUMN IF NOT EXISTS preferred_language text NOT NULL DEFAULT 'en'
  CHECK (preferred_language IN ('en', 'hi', 'gu'));

-- 3. Seed notification_policy.events (Q1 category defaults) + policy scalars.
--    jsonb_set can't create a nested key under a missing parent, and most
--    workspaces have no notification_policy at all (2.1 read it with defaults,
--    never wrote it) -- so rebuild it as (existing ?? {}) || { ...seeded keys },
--    COALESCE-ing every key against what already exists. This preserves the
--    043-seeded `templates` and any operator-edited `events`.
UPDATE workspaces
SET settings = jsonb_set(
  COALESCE(settings, '{}'::jsonb),
  '{notification_policy}',
  COALESCE(settings->'notification_policy', '{}'::jsonb) || jsonb_build_object(
    'events',
    COALESCE(
      settings->'notification_policy'->'events',
      jsonb_build_object(
        'dispatch_completed',       jsonb_build_object('mode', 'auto',             'is_marketing', false),
        'dispatch_otp_send',        jsonb_build_object('mode', 'auto',             'is_marketing', false),
        'return_received',          jsonb_build_object('mode', 'auto',             'is_marketing', false),
        'return_otp_send',          jsonb_build_object('mode', 'auto',             'is_marketing', false),
        'inspection_pass',          jsonb_build_object('mode', 'auto',             'is_marketing', false),
        'inspection_fail_minor',    jsonb_build_object('mode', 'auto',             'is_marketing', false),
        'inspection_fail_major',    jsonb_build_object('mode', 'auto_with_review', 'is_marketing', false),
        'invoice_issued',           jsonb_build_object('mode', 'auto',             'is_marketing', false),
        'invoice_ready',            jsonb_build_object('mode', 'auto',             'is_marketing', false),
        'invoice_overdue',          jsonb_build_object('mode', 'auto',             'is_marketing', false),
        'payment_received',         jsonb_build_object('mode', 'auto',             'is_marketing', false),
        'deposit_released',         jsonb_build_object('mode', 'auto',             'is_marketing', false),
        'deposit_forfeited',        jsonb_build_object('mode', 'auto_with_review', 'is_marketing', false),
        'kyc_approved',             jsonb_build_object('mode', 'auto',             'is_marketing', false),
        'kyc_rejected',             jsonb_build_object('mode', 'auto_with_review', 'is_marketing', false),
        'damage_reported',          jsonb_build_object('mode', 'auto_with_review', 'is_marketing', false),
        'cancellation_confirmed',   jsonb_build_object('mode', 'auto_with_review', 'is_marketing', false),
        'extension_confirmed',      jsonb_build_object('mode', 'auto',             'is_marketing', false),
        'quote_sent',               jsonb_build_object('mode', 'auto',             'is_marketing', false),
        'quote_reminder',           jsonb_build_object('mode', 'auto',             'is_marketing', false),
        'standby_expiring',         jsonb_build_object('mode', 'auto',             'is_marketing', false)
      )
    ),
    'default_language',            COALESCE(settings->'notification_policy'->'default_language',            '"en"'::jsonb),
    'enable_delivery_receipts',    COALESCE(settings->'notification_policy'->'enable_delivery_receipts',    'false'::jsonb),
    'enforce_customer_preferences',COALESCE(settings->'notification_policy'->'enforce_customer_preferences','true'::jsonb)
  ),
  true
)
WHERE deleted_at IS NULL
  AND (settings IS NULL OR jsonb_typeof(settings) = 'object');
