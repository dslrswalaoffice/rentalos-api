-- 034_inventory_model.sql — Sub-turn 13: inventory model foundation (SCHEMA)
-- ---------------------------------------------------------------------------
-- The get-it-right-once schema for the complete inventory model: product nature
-- × tracking × stock_type, pricing methods/structures/rulesets, per-location
-- bulk stock, per-product GST, and deposit methods. Sections map to the spec:
--   A product model · B locations/stock_levels · C pricing · E GST · F deposits
--
-- EXPAND phase only: this migration is ADDITIVE (new enums/tables/columns +
-- backfills). It drops NOTHING and rewrites no reads, so the build stays green.
-- The CONTRACT phase (drop weekly_rate/monthly_rate/stock_quantity, switch the
-- engine + availability over, rebuild the seed) lands in a separate migration
-- once the code that reads the new shape is in place — never drop a column in
-- the same migration that the running code still reads.

-- ===========================================================================
-- Enums (A, C, F). DO-blocks so a re-run is a no-op.
-- ===========================================================================
DO $$ BEGIN CREATE TYPE product_nature  AS ENUM ('rental','service','sale');            EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE tracking_method AS ENUM ('serialized','bulk','none');           EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE stock_type      AS ENUM ('current','expected','temporary');     EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE pricing_method  AS ENUM ('fixed_fee','fixed_price','structure'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE charge_period   AS ENUM ('hour','day','week','month');          EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE price_rule_kind AS ENUM ('adjust_charge_period','adjust_price'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;
DO $$ BEGIN CREATE TYPE deposit_method  AS ENUM ('none','order_percentage','product_value','fixed'); EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ===========================================================================
-- C — Pricing structures + tiers (multipliers on the product's base_price).
-- One model for one-off structures AND reusable templates (is_template).
-- ===========================================================================
CREATE TABLE IF NOT EXISTS pricing_structures (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id        uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name                text NOT NULL,
  is_template         boolean NOT NULL DEFAULT false,
  overflow_period     charge_period,
  overflow_multiplier numeric(8,4) CHECK (overflow_multiplier IS NULL OR overflow_multiplier >= 0),
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pricing_structures_ws_idx ON pricing_structures (workspace_id);

CREATE TABLE IF NOT EXISTS pricing_tiers (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  structure_id    uuid NOT NULL REFERENCES pricing_structures(id) ON DELETE CASCADE,
  duration_value  int  NOT NULL CHECK (duration_value > 0),
  duration_period charge_period NOT NULL,
  multiplier      numeric(8,4) NOT NULL CHECK (multiplier >= 0),
  sort_order      int NOT NULL DEFAULT 0,
  UNIQUE (structure_id, duration_value, duration_period)
);
CREATE INDEX IF NOT EXISTS pricing_tiers_structure_idx ON pricing_tiers (structure_id, sort_order);

-- ===========================================================================
-- C — Rulesets + rules (weekend / seasonal / charge-period adjustments).
-- ===========================================================================
CREATE TABLE IF NOT EXISTS pricing_rulesets (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id uuid NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  name         text NOT NULL,
  stacking     boolean NOT NULL DEFAULT false,   -- false = additive, true = compounding
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pricing_rulesets_ws_idx ON pricing_rulesets (workspace_id);

CREATE TABLE IF NOT EXISTS pricing_rules (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  ruleset_id    uuid NOT NULL REFERENCES pricing_rulesets(id) ON DELETE CASCADE,
  name          text NOT NULL,
  kind          price_rule_kind NOT NULL,
  sort_order    int NOT NULL DEFAULT 0,          -- evaluation order; matters when stacking
  -- WHEN it applies
  days_of_week  int[],                           -- 0=Sun..6=Sat. NULL = any day
  date_from     date,                            -- seasonal window. NULL = any date
  date_until    date,
  time_from     time,
  time_until    time,
  -- WHAT it does
  price_adjustment_bps int,                      -- adjust_price: +2000 = +20%, -1000 = -10%
  charge_period_action text CHECK (charge_period_action IS NULL OR charge_period_action IN
    ('exclude_pickup_day','exclude_return_day','cap_at_one_day')),
  created_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS pricing_rules_ruleset_idx ON pricing_rules (ruleset_id, sort_order);

-- ===========================================================================
-- B — Per-location bulk stock. Serialized stock is already per-location via
-- assets.location_id; this gives bulk products the same dimension. Backfilled
-- from products.stock_quantity below; stock_quantity is dropped in CONTRACT.
-- ===========================================================================
CREATE TABLE IF NOT EXISTS stock_levels (
  product_id  uuid NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  location_id uuid NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
  quantity    int  NOT NULL DEFAULT 0 CHECK (quantity >= 0),
  PRIMARY KEY (product_id, location_id)
);

-- ===========================================================================
-- A — Product columns: nature × tracking, pricing method, per-product GST,
-- deposit value. tracking_method is added ALONGSIDE the legacy tracking_mode
-- (dropped in CONTRACT). base_price_paise backfills from daily_rate so pricing
-- is behaviour-identical until the engine switches over.
-- ===========================================================================
ALTER TABLE products
  ADD COLUMN IF NOT EXISTS nature                 product_nature NOT NULL DEFAULT 'rental',
  ADD COLUMN IF NOT EXISTS tracking_method        tracking_method,
  ADD COLUMN IF NOT EXISTS charge_for_product     boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS pricing_method         pricing_method NOT NULL DEFAULT 'fixed_fee',
  ADD COLUMN IF NOT EXISTS base_price_paise       bigint CHECK (base_price_paise IS NULL OR base_price_paise >= 0),
  ADD COLUMN IF NOT EXISTS charge_period          charge_period,
  ADD COLUMN IF NOT EXISTS pricing_structure_id   uuid REFERENCES pricing_structures(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS pricing_ruleset_id     uuid REFERENCES pricing_rulesets(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS eligible_for_discounts boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS gst_rate_bps           int CHECK (gst_rate_bps IS NULL OR (gst_rate_bps BETWEEN 0 AND 5000)),
  ADD COLUMN IF NOT EXISTS is_taxable             boolean NOT NULL DEFAULT true,
  ADD COLUMN IF NOT EXISTS security_deposit_value_paise bigint CHECK (security_deposit_value_paise IS NULL OR security_deposit_value_paise >= 0);

-- Backfill product model from today's shape (behaviour-preserving).
UPDATE products SET tracking_method =
  CASE WHEN tracking_mode = 'bulk' THEN 'bulk'::tracking_method ELSE 'serialized'::tracking_method END
  WHERE tracking_method IS NULL;
UPDATE products SET base_price_paise = daily_rate WHERE base_price_paise IS NULL;
UPDATE products SET charge_period = 'day'::charge_period WHERE charge_period IS NULL;

-- ===========================================================================
-- A — Asset stock lifecycle (current | expected | temporary = sub-rent).
-- ===========================================================================
ALTER TABLE assets
  ADD COLUMN IF NOT EXISTS stock_type      stock_type NOT NULL DEFAULT 'current',
  ADD COLUMN IF NOT EXISTS available_from  timestamptz,
  ADD COLUMN IF NOT EXISTS available_until timestamptz;

DO $$ BEGIN
  ALTER TABLE assets ADD CONSTRAINT assets_temporary_window CHECK (
    stock_type <> 'temporary'
    OR (available_from IS NOT NULL AND available_until IS NOT NULL AND available_until > available_from)
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ===========================================================================
-- D — Custom line items (name + negative price allowed only when custom).
-- Plus a richer price snapshot (E, C): what method/period/tier/rules produced
-- the number, so an invoice explains itself months later.
-- ===========================================================================
ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS is_custom_line     boolean NOT NULL DEFAULT false,
  ADD COLUMN IF NOT EXISTS custom_name        text,
  ADD COLUMN IF NOT EXISTS priced_method      pricing_method,
  ADD COLUMN IF NOT EXISTS priced_charge_period charge_period,
  ADD COLUMN IF NOT EXISTS priced_tier_id     uuid REFERENCES pricing_tiers(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS price_explain      jsonb;

-- Negative unit price is legal ONLY on a custom line (fixed-amount discounts).
-- Existing coupon 'discount' lines carry a negative total but unit stays >= 0,
-- so this guard is safe additively.
DO $$ BEGIN
  ALTER TABLE order_items ADD CONSTRAINT order_items_negative_only_custom CHECK (
    unit_amount_paise >= 0 OR is_custom_line = true
  );
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ===========================================================================
-- F — Deposit method on the order + per-customer overrides.
-- ===========================================================================
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS deposit_method_used deposit_method;

ALTER TABLE people
  ADD COLUMN IF NOT EXISTS state_code              text,
  ADD COLUMN IF NOT EXISTS deposit_method_override deposit_method,
  ADD COLUMN IF NOT EXISTS deposit_value_paise     bigint CHECK (deposit_value_paise IS NULL OR deposit_value_paise >= 0),
  ADD COLUMN IF NOT EXISTS deposit_percentage_bps  int CHECK (deposit_percentage_bps IS NULL OR (deposit_percentage_bps BETWEEN 0 AND 10000));

-- ===========================================================================
-- E — Workspace state code (GST split moves from state NAME to code). Names are
-- kept for display; the engine switches to codes in a later chunk after parity.
-- 'Gujarat' → 'GJ' for the seeded DSLRSWALA workspace; unknowns left NULL.
-- ===========================================================================
ALTER TABLE workspaces
  ADD COLUMN IF NOT EXISTS state_code text;

UPDATE workspaces SET state_code = 'GJ'
  WHERE state_code IS NULL AND place_of_supply = 'Gujarat';

-- ===========================================================================
-- B — Backfill stock_levels from the legacy per-product stock_quantity, at the
-- workspace default location. Bulk availability reads this once the code
-- switches over; stock_quantity is dropped in CONTRACT.
-- ===========================================================================
INSERT INTO stock_levels (product_id, location_id, quantity)
SELECT p.id, l.id, COALESCE(p.stock_quantity, 0)
FROM products p
JOIN locations l ON l.workspace_id = p.workspace_id AND l.is_default = true
WHERE p.tracking_mode = 'bulk' AND p.stock_quantity IS NOT NULL
ON CONFLICT (product_id, location_id) DO NOTHING;

COMMENT ON TABLE pricing_structures IS 'Multiplier-based rental pricing (Sub-turn 13). Tiers multiply the product base_price_paise; is_template=true means reusable across products.';
COMMENT ON TABLE stock_levels IS 'Per-location bulk stock (Sub-turn 13). Serialized stock uses assets.location_id; bulk uses this. Supersedes products.stock_quantity.';
COMMENT ON COLUMN products.nature IS 'rental (comes back) | service (no availability constraint) | sale (quantity on hand, decremented at dispatch, never returns).';
COMMENT ON COLUMN order_items.price_explain IS 'Snapshot of how this line was priced (method, charge period, tier, rules applied) — so the number is explainable months later.';
