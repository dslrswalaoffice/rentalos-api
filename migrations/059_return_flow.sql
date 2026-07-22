-- 059_return_flow.sql: Slice 5 Session 1 return + inspection routing.
-- Table-only + a policy seed (NO ALTER TYPE - reconciled to the shipped enums:
-- "awaiting inspection" is an open inspection_events row + the derived
-- aggregate_status; a damaged unit stays available + a repair downtime; there is
-- no on_rent/awaiting_inspection/damaged/in_maintenance enum value). Transaction-
-- safe (CREATE TABLE/INDEX + guarded UPDATE), ASCII-only. CHECK constraints, not
-- native enums, per the Constitution.

-- 1. returns - one row per return batch (single return per order in Session 1).
CREATE TABLE IF NOT EXISTS returns (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  order_id              uuid        NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  return_number         text,
  recipient_type        text        NOT NULL DEFAULT 'customer'
                          CHECK (recipient_type IN ('customer', 'delegate')),
  delegate_name         text,
  delegate_phone        text,
  delegate_relationship text
                          CHECK (delegate_relationship IS NULL OR delegate_relationship IN
                                 ('assistant', 'driver', 'family', 'colleague', 'other')),
  delegate_id_proof_url text,
  status                text        NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft', 'receive', 'handover', 'inspection_routing', 'completed', 'failed')),
  return_started_at     timestamptz,
  return_completed_at   timestamptz,
  completed_by_user_id  uuid        REFERENCES users(id) ON DELETE SET NULL,
  is_early_return       boolean     NOT NULL DEFAULT false,
  is_late_return        boolean     NOT NULL DEFAULT false,
  late_return_hours     numeric(10, 2),
  early_return_hours    numeric(10, 2),
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

-- 2. return_line_items - per-item receive state (serial, condition, notes).
CREATE TABLE IF NOT EXISTS return_line_items (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  return_id                uuid        NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
  order_item_id            uuid        NOT NULL REFERENCES order_items(id) ON DELETE CASCADE,
  asset_id                 uuid        REFERENCES assets(id) ON DELETE SET NULL,
  captured_serial          text,
  serial_matched           boolean,
  condition_in             text
                             CHECK (condition_in IS NULL OR condition_in IN
                                    ('pristine', 'good', 'minor_wear', 'damage_flagged', 'missing')),
  missing_accessories_notes text,
  notes                    text,
  created_at               timestamptz NOT NULL DEFAULT now(),
  updated_at               timestamptz NOT NULL DEFAULT now()
);

-- 3. return_photos - mirrors dispatch_photos.
CREATE TABLE IF NOT EXISTS return_photos (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  return_id           uuid        NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
  order_item_id       uuid        REFERENCES order_items(id) ON DELETE CASCADE,
  asset_id            uuid        REFERENCES assets(id) ON DELETE SET NULL,
  photo_url           text        NOT NULL,
  photo_type          text        NOT NULL
                        CHECK (photo_type IN ('equipment', 'serial', 'condition_front', 'condition_back', 'damage', 'other')),
  captured_by_user_id uuid        REFERENCES users(id) ON DELETE SET NULL,
  captured_at         timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- 4. return_otp_verifications - mirrors dispatch_otp_verifications (optional at return).
CREATE TABLE IF NOT EXISTS return_otp_verifications (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  return_id         uuid        NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
  otp_sent_to_phone text,
  otp_sent_via      text
                      CHECK (otp_sent_via IS NULL OR otp_sent_via IN ('whatsapp', 'sms', 'voice', 'skipped')),
  otp_verified      boolean     NOT NULL DEFAULT false,
  otp_verified_at   timestamptz,
  otp_code_hash     text,
  otp_generated_at  timestamptz,
  skip_reason       text,
  skip_reason_notes text,
  provider_ref      text,
  created_at        timestamptz NOT NULL DEFAULT now()
);

-- 5. return_signatures - mirrors dispatch_signatures (skippable).
CREATE TABLE IF NOT EXISTS return_signatures (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  return_id           uuid        NOT NULL REFERENCES returns(id) ON DELETE CASCADE,
  signature_type      text
                        CHECK (signature_type IS NULL OR signature_type IN ('digital_draw', 'paper_photo')),
  signature_url       text,
  skipped             boolean     NOT NULL DEFAULT false,
  skip_reason         text,
  captured_by_user_id uuid        REFERENCES users(id) ON DELETE SET NULL,
  captured_at         timestamptz NOT NULL DEFAULT now(),
  created_at          timestamptz NOT NULL DEFAULT now()
);

-- 6. inspection_events already EXISTS (migration 055, SS24 - dormant groundwork for
--    exactly this return-inspection feature: order-level terminal `result` +
--    triggers_deposit_release/damage/maintenance + related_payment_id + a per-unit
--    inspection_line_items child). Slice 5 EXTENDS it (reconcile, don't rebuild)
--    with the scheduling lifecycle it lacks. All additive - existing rows stay valid.
--   - status: the scheduled->in_progress->outcome lifecycle 055's `result` can't hold.
--   - scheduled_for / return_id / order_item_id / asset_id / result_notes: the
--     per-item + scheduling fields the return flow needs.
--   - result / inspected_by_user_id / inspected_at were NOT NULL (a completed
--     inspection); a SCHEDULED row has none yet, so relax them.
ALTER TABLE inspection_events
  ADD COLUMN IF NOT EXISTS status        text,
  ADD COLUMN IF NOT EXISTS scheduled_for timestamptz,
  ADD COLUMN IF NOT EXISTS return_id     uuid REFERENCES returns(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS order_item_id uuid REFERENCES order_items(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS asset_id      uuid REFERENCES assets(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS result_notes  text,
  ADD COLUMN IF NOT EXISTS completed_at  timestamptz,
  ADD COLUMN IF NOT EXISTS updated_at    timestamptz NOT NULL DEFAULT now();

ALTER TABLE inspection_events ALTER COLUMN result               DROP NOT NULL;
ALTER TABLE inspection_events ALTER COLUMN inspected_by_user_id DROP NOT NULL;
ALTER TABLE inspection_events ALTER COLUMN inspected_at         DROP NOT NULL;

-- Backfill status from any existing rows' terminal result (none in practice, but
-- keep the two columns consistent), then constrain status to the lifecycle values.
UPDATE inspection_events SET status = result WHERE status IS NULL AND result IS NOT NULL;
DO $do$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'inspection_events_status_check') THEN
    ALTER TABLE inspection_events ADD CONSTRAINT inspection_events_status_check
      CHECK (status IS NULL OR status IN ('scheduled','in_progress','pass','fail_minor','fail_major','skipped'));
  END IF;
END $do$;

-- inspection_line_items (055) gains created_at (house rule - every table carries it).
ALTER TABLE inspection_line_items ADD COLUMN IF NOT EXISTS created_at timestamptz NOT NULL DEFAULT now();

-- 7. Indexes.
CREATE INDEX IF NOT EXISTS idx_returns_ws_status            ON returns (workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_returns_order                ON returns (order_id);
CREATE UNIQUE INDEX IF NOT EXISTS returns_number_uidx       ON returns (workspace_id, return_number) WHERE return_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_return_line_items_return     ON return_line_items (return_id);
CREATE INDEX IF NOT EXISTS idx_return_photos_return         ON return_photos (return_id);
CREATE INDEX IF NOT EXISTS idx_return_otp_return            ON return_otp_verifications (return_id);
CREATE INDEX IF NOT EXISTS idx_return_sig_return            ON return_signatures (return_id);
CREATE INDEX IF NOT EXISTS idx_inspection_events_ws_status  ON inspection_events (workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_inspection_events_return     ON inspection_events (return_id);
CREATE INDEX IF NOT EXISTS idx_inspection_events_order      ON inspection_events (order_id);

-- 8. Extend dispatch_return_policy with the return + inspection defaults. Idempotent
--    create-parent merge: (full defaults || existing) so existing/customized values
--    always win; absent keys are filled. Guarded to JSON-object settings only.
UPDATE workspaces
SET settings = jsonb_set(
  COALESCE(settings, '{}'::jsonb),
  '{dispatch_return_policy}',
  jsonb_build_object(
    'photos_required_per_item_type_return',      jsonb_build_object('equipment', 1, 'serial', 1, 'condition_front', 1, 'condition_back', 1),
    'otp_required_at_return',                     false,
    'inspection_required_by_category',           true,
    'inspection_default_action',                 'schedule',
    'inspection_scheduled_default_assignee_role','warehouse',
    'inspection_hold_days',                      3,
    'late_return_fee_grace_hours',               2,
    'early_return_credit_threshold_hours',       12,
    'signature_required_at_return',              true,
    'signature_skip_requires_reason',            true,
    'auto_release_deposit_on_inspection_pass',   false
  ) || COALESCE(settings->'dispatch_return_policy', '{}'::jsonb),
  true)
WHERE jsonb_typeof(COALESCE(settings, '{}'::jsonb)) = 'object';
