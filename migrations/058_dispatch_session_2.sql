-- 058_dispatch_session_2.sql: Slice 4 Session 2 - real OTP + signature skip + policy.
-- Additive columns on the Session 1 dispatch child tables + extended
-- workspaces.settings.dispatch_return_policy defaults. Transaction-safe
-- (ADD COLUMN / UPDATE only; no ALTER TYPE, no CONCURRENTLY), ASCII-only.

-- 1. dispatch_otp_verifications: real crypto OTP. otp_code_hash stores a bcrypt
--    hash of the generated 6-digit code (never the plaintext); otp_generated_at
--    stamps when it was minted (session-based validity - no timer expiry, Q3).
ALTER TABLE dispatch_otp_verifications
  ADD COLUMN IF NOT EXISTS otp_code_hash   text,
  ADD COLUMN IF NOT EXISTS otp_generated_at timestamptz;

COMMENT ON COLUMN dispatch_otp_verifications.otp_code_hash IS
  'bcrypt hash of the generated 6-digit OTP. Plaintext is only sent to the customer, never stored.';

-- 2. dispatch_signatures: policy-configurable skip with a reason (Q5). A skipped
--    row has signature_url NULL, skipped=true, and a captured skip_reason.
ALTER TABLE dispatch_signatures
  ADD COLUMN IF NOT EXISTS skipped     boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS skip_reason text;

-- A skipped signature has no image and no type; both were NOT NULL in 057, so
-- relax them. The signature_type CHECK still holds for non-null values (NULL
-- passes an IN (...) CHECK), and the `skipped` flag is the authoritative marker.
ALTER TABLE dispatch_signatures ALTER COLUMN signature_url  DROP NOT NULL;
ALTER TABLE dispatch_signatures ALTER COLUMN signature_type DROP NOT NULL;

-- 3. Extend the dispatch_return_policy defaults. Idempotent create-parent merge:
--    (full defaults) || (existing policy) - the '||' concatenation lets EXISTING
--    values win on every key, so 057's seed, this migration's new keys, and any
--    per-workspace edits are all preserved; absent keys are filled from defaults.
--    Writing the whole '{dispatch_return_policy}' object (create_missing=true on a
--    top-level path) also seeds the parent if a row somehow lacks it. Guarded so
--    it only runs on rows whose settings is a JSON object (never a scalar/NULL).
UPDATE workspaces
SET settings = jsonb_set(
  COALESCE(settings, '{}'::jsonb),
  '{dispatch_return_policy}',
  jsonb_build_object(
    'photos_required_per_item',              2,
    'photos_required_per_item_type',         jsonb_build_object('equipment', 1, 'serial', 1),
    'signature_required',                    true,
    'signature_types_allowed',               jsonb_build_array('digital_draw', 'paper_photo'),
    'signature_skip_requires_reason',        true,
    'otp_required',                          true,
    'otp_fallback_when_no_provider',         'allow_skip_with_reason',
    'otp_valid_for_session_only',            true,
    'otp_skip_requires_approval_over_paise', 25000,
    'delegate_pickup_allowed',               true,
    'delegate_requires_id_proof',            false,
    'gps_capture_at_dispatch',               false,
    'customer_notification_channels',        jsonb_build_array('whatsapp', 'email')
  ) || COALESCE(settings->'dispatch_return_policy', '{}'::jsonb),
  true)
WHERE jsonb_typeof(COALESCE(settings, '{}'::jsonb)) = 'object';
