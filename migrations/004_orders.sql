-- ============================================================================
-- Migration 004 — Orders module foundation
-- ============================================================================
-- Adds the 6-table order backbone (orders, order_items, order_events,
-- order_assets, payments, invoices), extends workspaces with business/tax
-- fields + a configurable settings JSONB, and seeds DSLRSWALA workspace
-- with real values pulled from the reference invoice.
--
-- Sub-turn 1 uses: orders, order_items, order_events, order_assets.
-- Sub-turn 2 activates: payments, invoices.
-- Schema is created in full now to avoid churn across sub-turns.
--
-- Conventions:
--   * All operational tables scoped by workspace_id (multi-tenant from day 1)
--   * Money stored as bigint paise (never float)
--   * Every mutation surface is auditable via order_events + audit_events
--   * Business rules (rounding, grace, tax) live in workspaces.settings JSONB
--     — NOT hardcoded in application logic
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. Extend workspaces with business/tax/settings
-- ----------------------------------------------------------------------------
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS legal_name        text,
  ADD COLUMN IF NOT EXISTS business_address  text,
  ADD COLUMN IF NOT EXISTS business_email    text,
  ADD COLUMN IF NOT EXISTS business_phone    text,
  ADD COLUMN IF NOT EXISTS pan               text,
  ADD COLUMN IF NOT EXISTS gstin             text,
  ADD COLUMN IF NOT EXISTS sac_code          text,
  ADD COLUMN IF NOT EXISTS uan               text,
  ADD COLUMN IF NOT EXISTS logo_url          text,
  ADD COLUMN IF NOT EXISTS place_of_supply   text,
  ADD COLUMN IF NOT EXISTS currency_code     text NOT NULL DEFAULT 'INR',
  ADD COLUMN IF NOT EXISTS country_code      text NOT NULL DEFAULT 'IN',
  ADD COLUMN IF NOT EXISTS timezone          text NOT NULL DEFAULT 'Asia/Kolkata',
  ADD COLUMN IF NOT EXISTS next_order_number integer NOT NULL DEFAULT 1,
  ADD COLUMN IF NOT EXISTS settings          jsonb   NOT NULL DEFAULT '{}'::jsonb;


-- ----------------------------------------------------------------------------
-- 2. Enums
-- ----------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE order_status AS ENUM (
    'draft',       -- being built, not shared with customer
    'quoted',      -- quote sent to customer, awaiting confirmation
    'confirmed',   -- customer accepted, advance received or committed
    'dispatched',  -- gear handed over, rental in progress
    'active',      -- alias for dispatched (deprecated — keep for future flex)
    'returned',    -- gear physically back, awaiting inspection/settlement
    'closed',      -- fully settled, invoice paid, deposit returned
    'cancelled'    -- terminated without completion
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE order_item_type AS ENUM (
    'rental',        -- gear rental line (has product/asset)
    'delivery_fee',  -- pickup/drop charges
    'late_fee',      -- overdue return
    'damage',        -- damage recovery
    'discount',      -- negative-value line
    'tax',           -- GST or other
    'deposit',       -- refundable security
    'other'          -- catch-all
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE order_asset_status AS ENUM (
    'allocated',   -- committed to this order but not yet handed over
    'dispatched',  -- physically with the customer
    'returned',    -- back with us, awaiting inspection
    'damaged',     -- returned with damage recorded
    'lost'         -- not returned
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payment_method AS ENUM (
    'upi', 'bank_transfer', 'cash', 'card', 'cheque', 'wallet', 'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payment_direction AS ENUM ('in', 'out');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE payment_status AS ENUM (
    'pending', 'completed', 'failed', 'refunded', 'cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE invoice_status AS ENUM (
    'draft', 'sent', 'paid', 'revised', 'cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;


-- ----------------------------------------------------------------------------
-- 3. orders
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS orders (
  id                  uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid         NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  order_number        integer      NOT NULL,
  customer_person_id  uuid         NOT NULL REFERENCES people(id) ON DELETE RESTRICT,
  status              order_status NOT NULL DEFAULT 'draft',

  -- Rental window (nullable on draft; required by 'confirmed' transition)
  rental_start        timestamptz,
  rental_end          timestamptz,

  -- Fulfilment
  dispatch_type       text         NOT NULL DEFAULT 'pickup'
                                    CHECK (dispatch_type IN ('pickup', 'delivery')),
  delivery_address    text,

  -- Booking channel (walk-in vs planned)
  channel             text         NOT NULL DEFAULT 'planned'
                                    CHECK (channel IN ('walk_in', 'planned', 'whatsapp', 'phone', 'other')),

  -- Cached totals (kept in sync by application layer; source of truth = order_items)
  subtotal_paise      bigint       NOT NULL DEFAULT 0,
  tax_paise           bigint       NOT NULL DEFAULT 0,
  discount_paise      bigint       NOT NULL DEFAULT 0,
  total_paise         bigint       NOT NULL DEFAULT 0,
  deposit_paise       bigint       NOT NULL DEFAULT 0,
  paid_paise          bigint       NOT NULL DEFAULT 0,
  balance_paise       bigint       NOT NULL DEFAULT 0,

  notes               text,
  internal_notes      text,        -- staff-only, never on invoice

  created_by          uuid         REFERENCES users(id) ON DELETE SET NULL,
  created_at          timestamptz  NOT NULL DEFAULT now(),
  updated_at          timestamptz  NOT NULL DEFAULT now(),
  deleted_at          timestamptz,

  UNIQUE (workspace_id, order_number),
  CHECK (rental_end IS NULL OR rental_start IS NULL OR rental_end > rental_start)
);

CREATE INDEX IF NOT EXISTS orders_workspace_status_idx
  ON orders (workspace_id, status)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS orders_workspace_customer_idx
  ON orders (workspace_id, customer_person_id)
  WHERE deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS orders_workspace_rental_window_idx
  ON orders (workspace_id, rental_start, rental_end)
  WHERE deleted_at IS NULL AND status IN ('confirmed', 'dispatched', 'active');

CREATE INDEX IF NOT EXISTS orders_workspace_created_at_idx
  ON orders (workspace_id, created_at DESC)
  WHERE deleted_at IS NULL;


-- ----------------------------------------------------------------------------
-- 4. order_items
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_items (
  id                  uuid            PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid            NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  order_id            uuid            NOT NULL REFERENCES orders(id) ON DELETE CASCADE,

  -- For grouping accessories under a hero item (e.g. body -> battery, charger)
  parent_item_id      uuid            REFERENCES order_items(id) ON DELETE CASCADE,

  item_type           order_item_type NOT NULL,

  -- Only populated for 'rental' items
  product_id          uuid            REFERENCES products(id) ON DELETE RESTRICT,

  description         text            NOT NULL,
  quantity            integer         NOT NULL DEFAULT 1 CHECK (quantity > 0),

  -- Rental-specific pricing hints (Sub-turn 2 will populate these)
  daily_rate_paise    bigint,         -- per-unit daily rate at time of booking
  billable_days       integer,        -- computed from rental window + rounding rule

  unit_amount_paise   bigint          NOT NULL DEFAULT 0,
  total_amount_paise  bigint          NOT NULL DEFAULT 0,

  sort_order          integer         NOT NULL DEFAULT 0,

  created_at          timestamptz     NOT NULL DEFAULT now(),
  updated_at          timestamptz     NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS order_items_order_idx
  ON order_items (order_id, sort_order);

CREATE INDEX IF NOT EXISTS order_items_workspace_product_idx
  ON order_items (workspace_id, product_id)
  WHERE product_id IS NOT NULL;


-- ----------------------------------------------------------------------------
-- 5. order_events (per-order timeline; distinct from workspace audit_events)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_events (
  id              uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id    uuid          NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  order_id        uuid          NOT NULL REFERENCES orders(id) ON DELETE CASCADE,

  event_type      text          NOT NULL,
  from_status     order_status,
  to_status       order_status,
  payload         jsonb         NOT NULL DEFAULT '{}'::jsonb,

  actor_user_id   uuid          REFERENCES users(id) ON DELETE SET NULL,
  occurred_at     timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS order_events_order_time_idx
  ON order_events (order_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS order_events_workspace_time_idx
  ON order_events (workspace_id, occurred_at DESC);

-- Immutable: matches the audit_events pattern from migration 001
CREATE OR REPLACE FUNCTION prevent_order_events_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'order_events is append-only; UPDATE/DELETE forbidden';
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS order_events_no_update ON order_events;
CREATE TRIGGER order_events_no_update
  BEFORE UPDATE ON order_events
  FOR EACH ROW EXECUTE FUNCTION prevent_order_events_mutation();

DROP TRIGGER IF EXISTS order_events_no_delete ON order_events;
CREATE TRIGGER order_events_no_delete
  BEFORE DELETE ON order_events
  FOR EACH ROW EXECUTE FUNCTION prevent_order_events_mutation();


-- ----------------------------------------------------------------------------
-- 6. order_assets (physical unit allocation — materialises at dispatch)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS order_assets (
  id                uuid                PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id      uuid                NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  order_id          uuid                NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  order_item_id     uuid                REFERENCES order_items(id) ON DELETE SET NULL,
  asset_id          uuid                NOT NULL REFERENCES assets(id) ON DELETE RESTRICT,

  status            order_asset_status  NOT NULL DEFAULT 'allocated',

  dispatched_at     timestamptz,
  returned_at       timestamptz,
  condition_notes   text,

  created_at        timestamptz         NOT NULL DEFAULT now(),
  updated_at        timestamptz         NOT NULL DEFAULT now(),

  -- One asset cannot be on the same order twice
  UNIQUE (order_id, asset_id)
);

CREATE INDEX IF NOT EXISTS order_assets_asset_status_idx
  ON order_assets (asset_id, status);

CREATE INDEX IF NOT EXISTS order_assets_order_idx
  ON order_assets (order_id);

CREATE INDEX IF NOT EXISTS order_assets_workspace_status_idx
  ON order_assets (workspace_id, status);


-- ----------------------------------------------------------------------------
-- 7. payments (Sub-turn 2 will write here; schema now)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS payments (
  id             uuid              PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id   uuid              NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  order_id       uuid              NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,

  amount_paise   bigint            NOT NULL CHECK (amount_paise > 0),
  direction      payment_direction NOT NULL DEFAULT 'in',
  method         payment_method    NOT NULL,
  reference      text,
  status         payment_status    NOT NULL DEFAULT 'completed',
  notes          text,

  received_by    uuid              REFERENCES users(id) ON DELETE SET NULL,
  occurred_at    timestamptz       NOT NULL DEFAULT now(),
  created_at     timestamptz       NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS payments_order_idx
  ON payments (order_id, occurred_at DESC);

CREATE INDEX IF NOT EXISTS payments_workspace_time_idx
  ON payments (workspace_id, occurred_at DESC);


-- ----------------------------------------------------------------------------
-- 8. invoices (Sub-turn 2 will write here; schema now)
-- ----------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS invoices (
  id                     uuid           PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id           uuid           NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  order_id               uuid           NOT NULL REFERENCES orders(id) ON DELETE RESTRICT,

  invoice_number         text           NOT NULL,
  sequence               integer        NOT NULL,       -- 1 = rental invoice, 2 = damage, etc.
  revision               integer        NOT NULL DEFAULT 1,

  status                 invoice_status NOT NULL DEFAULT 'draft',
  issued_at              date           NOT NULL DEFAULT current_date,
  place_of_supply        text,

  subtotal_paise         bigint         NOT NULL DEFAULT 0,
  tax_paise              bigint         NOT NULL DEFAULT 0,
  total_paise            bigint         NOT NULL DEFAULT 0,

  -- Immutable snapshot of business/tax details + line items at issue time.
  -- Ensures reprinting an old invoice always renders identically even if
  -- workspace settings later change.
  snapshot               jsonb          NOT NULL DEFAULT '{}'::jsonb,

  supersedes_invoice_id  uuid           REFERENCES invoices(id),

  created_by             uuid           REFERENCES users(id) ON DELETE SET NULL,
  created_at             timestamptz    NOT NULL DEFAULT now(),

  UNIQUE (workspace_id, invoice_number)
);

CREATE INDEX IF NOT EXISTS invoices_order_idx
  ON invoices (order_id, sequence, revision DESC);

CREATE INDEX IF NOT EXISTS invoices_workspace_status_idx
  ON invoices (workspace_id, status);


-- ----------------------------------------------------------------------------
-- 9. Seed DSLRSWALA workspace with real values from reference invoice
-- ----------------------------------------------------------------------------
-- Configurable settings shape (documented for future workspaces):
--   billing.rounding_rule       : '24_hour_windows' | 'calendar_day' | 'custom'
--   billing.grace_period_hours  : number (0 = no grace)
--   billing.minimum_days        : number (1 = at least one day charged)
--   billing.day_cutoff_time     : 'HH:MM' (for calendar_day rule)
--   tax.default_gst_percent     : number
--   tax.charge_gst_by_default   : boolean
--   invoice.number_format       : 'YYYY-MM-DD-{order}-{seq}-R{rev}' etc.
--   deposit.default_percent     : number (of subtotal)
--
-- These are examples for DSLRSWALA. Other workspaces override per business.
UPDATE workspaces
SET
  legal_name        = COALESCE(legal_name,        'DSLRSWALA'),
  business_address  = COALESCE(business_address,  '404, 4th Floor, City Center Complex, B/S Sayaji Hotel (New), Bhimnath Bridge Road, Sayajiganj, 390007 Vadodara Gujarat'),
  business_email    = COALESCE(business_email,    'aamirpatel@dslrswala.com'),
  business_phone    = COALESCE(business_phone,    '+91 7990266857'),
  pan               = COALESCE(pan,               'AAVFD2453P'),
  gstin             = COALESCE(gstin,             '24AAVFD2453P1ZU'),
  sac_code          = COALESCE(sac_code,          '998381'),
  uan               = COALESCE(uan,               'UDYAM-GJ-24-0016418'),
  place_of_supply   = COALESCE(place_of_supply,   'Vadodara'),
  currency_code     = COALESCE(currency_code,     'INR'),
  country_code      = COALESCE(country_code,      'IN'),
  timezone          = COALESCE(timezone,          'Asia/Kolkata'),
  settings          = COALESCE(settings, '{}'::jsonb) || jsonb_build_object(
    'billing', jsonb_build_object(
      'rounding_rule',      '24_hour_windows',
      'grace_period_hours', 2,
      'minimum_days',       1,
      'day_cutoff_time',    '10:00'
    ),
    'tax', jsonb_build_object(
      'default_gst_percent',    18,
      'charge_gst_by_default',  false
    ),
    'invoice', jsonb_build_object(
      'number_format', 'YYYY-MM-DD-{order}-{seq}-R{rev}'
    ),
    'deposit', jsonb_build_object(
      'default_percent', 0
    )
  )
WHERE slug = 'dslrswala';
