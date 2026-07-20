-- 055_deposits_inspection_ss24.sql — Sub-slice 2.4: Deposits + Inspection
-- ---------------------------------------------------------------------------
-- HANDOFF-PACK vs SHIPPED-REALITY RECONCILIATION (approved Phase-1 plan).
-- The SS-2.4 tech spec was authored against an idealized schema. As with the
-- 2.3 pack (see 046/048 headers), we reconcile it to shipped RentalOS:
--
--   1. Deposits are ALREADY the shipped Sub-turn-6d model — payments.payment_kind
--      ('deposit'|'deposit_refund'|'deposit_forfeit') + orders.deposit_status.
--      We EXTEND that (no parallel `deposit_holds` / `deposit_hold_events` table —
--      Constitution Gate 1/3). The pack's 30-event vocabulary is emitted as
--      namespaced `deposit.*` / `cheque.*` / `custody.*` / `inspection.*`
--      event_types in the existing order_events + audit_events (a CODE convention
--      for Phase 2; no events table here).
--   2. `uuid_generate_v7()` -> `gen_random_uuid()` (v4 is canonical; v7 fn does
--      not exist and would fail the build = dead deploy).
--   3. `.ts` migration -> this `.sql` file (the runner globs *.sql).
--   4. `order_line_items` -> `order_items` (pack naming error, per 046/049).
--   5. Staff FKs -> `users(id)` (created_by/custody_holder/inspected_by are TEAM
--      members = users; `people` is the customer table — Constitution §6).
--   6. deposit_hold_id FKs -> `payments(id)` (the deposit payment) + `order_id`.
--   7. No new `order_status` enum values — inspection outcome lives on
--      `inspection_events.result` + `damage_incidents`; computed client-side.
--
-- TRANSACTION SAFETY: every column here is text/jsonb/uuid/bigint with CHECK
-- constraints (NOT native enums), so there is NO `ALTER TYPE ... ADD VALUE` and
-- nothing transaction-hostile. This migration runs in the normal ATOMIC path.
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- 1. EXTEND payments — cheque lifecycle + physical custody (deposit rows only;
--    rental-kind rows leave these NULL). method_reference holds UPI ref /
--    cheque number / bank txn id etc. (the pack's `method_reference`).
-- ===========================================================================
ALTER TABLE payments
  ADD COLUMN IF NOT EXISTS method_reference       jsonb,
  ADD COLUMN IF NOT EXISTS cheque_status          text
    CHECK (cheque_status IS NULL OR cheque_status IN
      ('pending','deposited','cleared','bounced','re_presented')),
  ADD COLUMN IF NOT EXISTS custody_holder_user_id uuid REFERENCES users(id),
  ADD COLUMN IF NOT EXISTS bounce_reason          text
    CHECK (bounce_reason IS NULL OR bounce_reason IN
      ('insufficient_funds','stop_payment','signature_mismatch','post_dated',
       'stale','account_closed','refer_to_drawer','other')),
  ADD COLUMN IF NOT EXISTS bounce_fee_paise       bigint
    CHECK (bounce_fee_paise IS NULL OR bounce_fee_paise >= 0),
  ADD COLUMN IF NOT EXISTS bounced_at             timestamptz;

CREATE INDEX IF NOT EXISTS payments_custody_holder_idx
  ON payments (custody_holder_user_id)
  WHERE custody_holder_user_id IS NOT NULL;

-- ===========================================================================
-- 2. WIDEN orders.deposit_status CHECK to add 'bounced' (cheque deposit that
--    bounced). ADD-CONSTRAINT-with-data-fix discipline: this only WIDENS the
--    allowed set (adds a value), so no existing row can violate the new CHECK —
--    no data fix is required before the ADD. The old inline CHECK from migration
--    019 is auto-named orders_deposit_status_check.
-- ===========================================================================
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_deposit_status_check;
ALTER TABLE orders
  ADD CONSTRAINT orders_deposit_status_check
  CHECK (deposit_status IN
    ('none','pending','held','partial_forfeited','fully_forfeited','released','bounced'));

-- ===========================================================================
-- 3. custody_transfers — physical custody of a cash/cheque deposit moving
--    between STAFF (users). Keyed to the order + the deposit payment.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS custody_transfers (
  id                       uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id             uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  order_id                 uuid        NOT NULL REFERENCES orders(id),
  payment_id               uuid        REFERENCES payments(id),
  from_holder_user_id      uuid        NOT NULL REFERENCES users(id),
  to_holder_user_id        uuid        NOT NULL REFERENCES users(id),
  transferred_amount_paise bigint      NOT NULL CHECK (transferred_amount_paise >= 0),
  reason                   text        NOT NULL CHECK (reason IN
    ('shift_end','vacation','permanent','reconciliation','other')),
  reason_notes             text,
  transferred_at           timestamptz NOT NULL DEFAULT now(),
  acknowledged_at          timestamptz,
  created_at               timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS custody_transfers_order_idx   ON custody_transfers (workspace_id, order_id);
CREATE INDEX IF NOT EXISTS custody_transfers_payment_idx ON custody_transfers (payment_id);

-- ===========================================================================
-- 4. inspection_events — return inspection outcome (genuinely new; return
--    inspection was previously only order_items status). inspected_by ->
--    users; related deposit link -> the deposit payment; damage -> 048.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS inspection_events (
  id                         uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id               uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  order_id                   uuid        NOT NULL REFERENCES orders(id),
  inspection_number          text        NOT NULL,
  result                     text        NOT NULL CHECK (result IN
    ('pass','fail_minor','fail_major','fail_total_loss','inconclusive')),
  inspected_by_user_id       uuid        NOT NULL REFERENCES users(id),
  inspected_at               timestamptz NOT NULL,
  triggers_maintenance       boolean     NOT NULL DEFAULT false,
  triggers_damage_claim      boolean     NOT NULL DEFAULT false,
  triggers_deposit_release   boolean     NOT NULL DEFAULT false,
  condition_photos           jsonb       NOT NULL DEFAULT '[]'::jsonb,
  condition_notes            text,
  related_damage_incident_id uuid        REFERENCES damage_incidents(id),
  related_payment_id         uuid        REFERENCES payments(id),
  policy_snapshot            jsonb       NOT NULL DEFAULT '{}'::jsonb,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  UNIQUE (workspace_id, inspection_number)
);

CREATE INDEX IF NOT EXISTS inspection_events_order_idx ON inspection_events (workspace_id, order_id);

-- ===========================================================================
-- 5. inspection_line_items — per-unit condition captured during inspection.
--    order_item_id -> order_items (NOT order_line_items). workspace_id carried
--    explicitly (house rule) even though it is a child of inspection_events.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS inspection_line_items (
  id                  uuid  PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid  NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  inspection_event_id uuid  NOT NULL REFERENCES inspection_events(id) ON DELETE CASCADE,
  order_item_id       uuid  NOT NULL REFERENCES order_items(id),
  asset_id            uuid  REFERENCES assets(id),
  condition_in        text  NOT NULL CHECK (condition_in IN
    ('good','minor_wear','damage','broken','missing')),
  damage_severity     text  CHECK (damage_severity IS NULL OR damage_severity IN
    ('cosmetic','minor','major','total_loss')),
  missing_accessories jsonb NOT NULL DEFAULT '[]'::jsonb,
  inspector_notes     text
);

CREATE INDEX IF NOT EXISTS inspection_line_items_event_idx ON inspection_line_items (inspection_event_id);

-- ===========================================================================
-- 6. Seed workspaces.settings.deposit_policy (DS-10.2 shape, spec §8).
--    Create-parent merge, idempotent: only sets deposit_policy when ABSENT so a
--    redeploy never clobbers an operator's Settings edits (the TD-2 / Rule-D
--    trap). Read back via normalizeSettings passthrough (workspace.ts).
-- ===========================================================================
UPDATE workspaces
SET settings = jsonb_set(
  COALESCE(settings, '{}'::jsonb),
  '{deposit_policy}',
  COALESCE(
    settings->'deposit_policy',
    jsonb_build_object(
      'calculation_method', 'percentage_of_rental_value',
      'default_percentage_bps', 3000,
      'min_deposit_paise', 50000,
      'max_deposit_paise', 10000000,
      'segment_overrides', jsonb_build_object(
        'vip', jsonb_build_object('multiplier_bps', 5000)
      ),
      'category_rules', jsonb_build_object(
        'cameras', jsonb_build_object('percentage_bps', 5000, 'min_paise', 500000)
      ),
      'collection_methods', jsonb_build_object(
        'cash',          jsonb_build_object('enabled', true, 'ceiling_paise', 5000000, 'approval_over_paise', 2500000),
        'cheque',        jsonb_build_object('enabled', true),
        'upi',           jsonb_build_object('enabled', true),
        'bank_transfer', jsonb_build_object('enabled', true)
      ),
      'refund_trigger', 'inspection_pass',
      'refund_timing', 'immediate',
      'auto_forfeit_rules', jsonb_build_object(
        'late_return_over_24h', jsonb_build_object('enabled', true, 'per_day_paise', 100000)
      ),
      'approval_thresholds_paise', jsonb_build_object(
        'damage_forfeit_staff_limit', 500000,
        'damage_forfeit_manager_limit', 2500000,
        'full_deposit_forfeit_requires', 'owner',
        'release_manager_limit', 2500000,
        'forfeit_manager_limit', 500000
      ),
      'custody_rules', jsonb_build_object(
        'cash_holder_subroles', jsonb_build_array('owner', 'manager', 'accounts'),
        'manager_cash_ceiling_paise', 5000000,
        'cheque_handler_subroles', jsonb_build_array('owner', 'accounts')
      ),
      'cheque_bounce', jsonb_build_object(
        'bounce_fee_paise', 50000,
        'retain_from_deposit', true,
        'alternative_payment_window_days', 7
      )
    )
  )
)
WHERE deleted_at IS NULL;
