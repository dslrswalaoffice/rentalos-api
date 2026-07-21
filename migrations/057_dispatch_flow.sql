-- 057_dispatch_flow.sql — Slice 4 Session 1: structured dispatch/handover capture.
-- ---------------------------------------------------------------------------
-- Replaces the WhatsApp-photos-and-verbal handover with a structured 60–120s
-- capture flow (3 phases: Prepare → Handover → Confirm; substrate
-- docs/design-substrate/sprint-1/dispatch_ui_dc.html). This migration is the
-- schema foundation only — endpoints land in Phase 3, UI in Phase 4.
--
-- Reconciled to SHIPPED reality (Phase 1 review, Aamir-approved):
--   • dispatch is now a FIRST-CLASS `dispatches` table (multiple per order),
--     not the idealized spec's implicit entity. Photos/OTP/signatures FK into it.
--   • child photos reference `order_items` (the real table), NOT `order_line_items`.
--   • signatures are a NEW `dispatch_signatures` table — deliberately NOT an
--     extension of `order_contracts` (Sub-turn 6e): a witnessed "acknowledge
--     pickup" canvas is a different semantic from a signed rental agreement.
--   • mutations will emit `order_events` + `audit_events` (repo two-row
--     convention); there is no `dispatch_events` table.
--   • permission gate is the existing `dispatch.execute` key (not a new one).
--   • photos/ID/signature images go to Vercel Blob (reuse inventory.ts pattern);
--     these columns hold the resulting URLs.
--
-- BACKWARD-COMPAT DECISION (Aamir asked to flag it here):
--   The existing inline `POST /api/orders/:id/dispatch` (Sub-turn 12b —
--   allocates order_assets, flips asset status, writes one batch order_event)
--   is KEPT WORKING UNCHANGED. Slice 4 is purely ADDITIVE: the new
--   `POST /api/orders/:orderId/dispatches` creates a dispatch record, capture
--   endpoints append to it, and `.../complete` finalizes + transitions order
--   state. Rationale: the legacy endpoint backs the current order-360 quick
--   dispatch and the 12b tests; breaking it risks regressions with no upside in
--   Session 1. A later sub-turn may refactor the legacy endpoint to internally
--   open a `dispatches` row (deprecation path) — NOT done here.
--
-- Transaction-safe: only CREATE TABLE / CREATE INDEX (non-CONCURRENTLY) /
-- UPDATE. No ALTER TYPE / no CONCURRENTLY, so the runner applies + records it
-- atomically. CHECK constraints (text), never native enums, per Constitution.
-- ---------------------------------------------------------------------------

-- 1. dispatches — one row per dispatch batch (an order can have several).
CREATE TABLE IF NOT EXISTS dispatches (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id          uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  order_id              uuid        NOT NULL REFERENCES orders(id) ON DELETE CASCADE,

  -- Human-readable, minted by the endpoint: DS-YYYY-{order_number}-{seq}.
  dispatch_number       text,

  recipient_type        text        NOT NULL DEFAULT 'customer'
                          CHECK (recipient_type IN ('customer', 'delegate')),
  delegate_name         text,
  delegate_phone        text,
  delegate_relationship text
                          CHECK (delegate_relationship IS NULL OR delegate_relationship IN
                                 ('assistant', 'driver', 'family', 'colleague', 'other')),
  delegate_id_proof_url text,

  status                text        NOT NULL DEFAULT 'draft'
                          CHECK (status IN ('draft', 'prepare', 'handover', 'confirmed', 'completed', 'failed')),

  dispatch_started_at   timestamptz,
  dispatch_completed_at timestamptz,
  completed_by_user_id  uuid        REFERENCES users(id) ON DELETE SET NULL,

  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE dispatches IS
  'Slice 4: a structured dispatch/handover batch. Multiple per order. Capture (photos/otp/signatures) FKs here. Completion transitions the order to dispatched. Additive to the legacy POST /orders/:id/dispatch (kept for backward compat).';

-- 2. dispatch_photos — condition/handover photos (Vercel Blob URLs).
CREATE TABLE IF NOT EXISTS dispatch_photos (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  dispatch_id         uuid        NOT NULL REFERENCES dispatches(id) ON DELETE CASCADE,
  order_item_id       uuid        REFERENCES order_items(id) ON DELETE CASCADE,
  asset_id            uuid        REFERENCES assets(id) ON DELETE SET NULL,

  photo_url           text        NOT NULL,
  photo_type          text        NOT NULL
                        CHECK (photo_type IN ('equipment', 'serial', 'accessory', 'damage', 'other')),

  captured_by_user_id uuid        REFERENCES users(id) ON DELETE SET NULL,
  captured_at         timestamptz NOT NULL DEFAULT now(),

  gps_lat             numeric(9, 6),
  gps_lng             numeric(9, 6),
  device_metadata     jsonb       NOT NULL DEFAULT '{}'::jsonb,

  created_at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN dispatch_photos.photo_url IS 'Vercel Blob URL (multi-tenant path prefix), or a data URI for the v1 fallback.';

-- 3. dispatch_otp_verifications — OTP send/verify/skip audit per dispatch.
CREATE TABLE IF NOT EXISTS dispatch_otp_verifications (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  dispatch_id       uuid        NOT NULL REFERENCES dispatches(id) ON DELETE CASCADE,

  otp_sent_to_phone text,
  otp_sent_via      text
                      CHECK (otp_sent_via IS NULL OR otp_sent_via IN ('whatsapp', 'sms', 'voice', 'skipped')),
  otp_verified      boolean     NOT NULL DEFAULT false,
  otp_verified_at   timestamptz,
  skip_reason       text,
  skip_reason_notes text,
  provider_ref      text,

  created_at        timestamptz NOT NULL DEFAULT now()
);

COMMENT ON COLUMN dispatch_otp_verifications.provider_ref IS 'External message id (e.g. WATI) when sent via a real provider. NULL when skipped or no provider configured.';

-- 4. dispatch_signatures — witnessed pickup acknowledgement (NEW, not order_contracts).
CREATE TABLE IF NOT EXISTS dispatch_signatures (
  id                  uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  dispatch_id         uuid        NOT NULL REFERENCES dispatches(id) ON DELETE CASCADE,

  signature_type      text        NOT NULL
                        CHECK (signature_type IN ('digital_draw', 'paper_photo')),
  signature_url       text        NOT NULL,

  captured_by_user_id uuid        REFERENCES users(id) ON DELETE SET NULL,
  captured_at         timestamptz NOT NULL DEFAULT now(),

  created_at          timestamptz NOT NULL DEFAULT now()
);

-- 5. Indexes — (workspace_id, status) for the dispatch list; (dispatch_id) for children.
CREATE INDEX IF NOT EXISTS idx_dispatches_ws_status   ON dispatches (workspace_id, status);
CREATE INDEX IF NOT EXISTS idx_dispatches_order        ON dispatches (order_id);
CREATE UNIQUE INDEX IF NOT EXISTS dispatches_number_uidx
  ON dispatches (workspace_id, dispatch_number) WHERE dispatch_number IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_dispatch_photos_dispatch ON dispatch_photos (dispatch_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_photos_ws       ON dispatch_photos (workspace_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_otp_dispatch    ON dispatch_otp_verifications (dispatch_id);
CREATE INDEX IF NOT EXISTS idx_dispatch_sig_dispatch    ON dispatch_signatures (dispatch_id);

-- 6. Seed workspaces.settings.dispatch_return_policy (config-first; every threshold
--    lives here, never hardcoded). Create-parent merge, idempotent: only sets the
--    key when ABSENT so re-runs and workspace edits are preserved.
UPDATE workspaces
SET settings = jsonb_set(
  COALESCE(settings, '{}'::jsonb),
  '{dispatch_return_policy}',
  COALESCE(
    settings->'dispatch_return_policy',
    jsonb_build_object(
      'photos_required_per_item', 2,
      'signature_required', true,
      'signature_types_allowed', jsonb_build_array('digital_draw', 'paper_photo'),
      'otp_required', true,
      'otp_fallback_when_no_provider', 'allow_skip_with_reason',
      'delegate_pickup_allowed', true,
      'delegate_requires_id_proof', false,
      'gps_capture_at_dispatch', false
    )
  ),
  true
);
