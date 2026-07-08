-- ============================================================================
-- 002_inventory.sql · Products + Assets
-- ============================================================================
-- Product  = SKU (Sony FX3 Body).           The catalog entry — what you rent.
-- Asset    = physical unit (SONY-FX3-BODY-01). The actual thing on your shelf.
--
-- A booking rents ONE OR MORE assets (or unassigned — "any Sony FX3 body").
-- Availability = count(assets of product P) − count(assets on active orders).
--
-- Money: stored as integer PAISE (smallest INR unit). Multiply rupees × 100 on
-- input, divide by 100 on output. Never use FLOAT/REAL — always integer.
-- When we go multi-currency, the smallest unit is defined by workspaces.currency_code.
--
-- Investor ownership deferred: will come as a separate `asset_ownership` table
-- linking assets ↔ investors with a percentage. Do NOT add investor columns
-- to products or assets — that's the wrong denormalisation.
-- ============================================================================

CREATE TYPE asset_condition AS ENUM (
  'new', 'excellent', 'good', 'fair', 'needs_repair', 'retired'
);

CREATE TYPE asset_status AS ENUM (
  'available', 'rented', 'in_repair', 'in_transit', 'reserved', 'retired'
);

-- ----------------------------------------------------------------------------
-- products — SKU catalog
-- ----------------------------------------------------------------------------
CREATE TABLE products (
  id                   uuid         PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         uuid         NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  sku                  citext       NOT NULL,
  name                 text         NOT NULL,
  category             text         NOT NULL,
  description          text,

  -- Money in the smallest currency unit (paise for INR).
  daily_rate           integer      NOT NULL CHECK (daily_rate > 0),
  weekly_rate          integer      CHECK (weekly_rate IS NULL OR weekly_rate > 0),
  monthly_rate         integer      CHECK (monthly_rate IS NULL OR monthly_rate > 0),
  deposit              integer      NOT NULL DEFAULT 0 CHECK (deposit >= 0),
  replacement_value    integer      CHECK (replacement_value IS NULL OR replacement_value > 0),

  specifications       jsonb        NOT NULL DEFAULT '{}'::jsonb,
  notes                text,
  image_url            text,
  is_active            boolean      NOT NULL DEFAULT true,

  created_by           uuid         REFERENCES users(id),
  created_at           timestamptz  NOT NULL DEFAULT now(),
  updated_at           timestamptz  NOT NULL DEFAULT now(),
  deleted_at           timestamptz,

  UNIQUE (workspace_id, sku)
);

COMMENT ON TABLE products IS 'Catalog. One row per SKU. Physical units live in `assets`.';
COMMENT ON COLUMN products.daily_rate IS 'Amount in the workspace currency smallest unit (paise for INR).';

CREATE INDEX idx_products_workspace_active
  ON products(workspace_id) WHERE deleted_at IS NULL AND is_active = true;
CREATE INDEX idx_products_workspace_name
  ON products(workspace_id, name) WHERE deleted_at IS NULL;
CREATE INDEX idx_products_category
  ON products(workspace_id, category) WHERE deleted_at IS NULL;

-- ----------------------------------------------------------------------------
-- assets — physical units
-- ----------------------------------------------------------------------------
CREATE TABLE assets (
  id                   uuid              PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         uuid              NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  product_id           uuid              NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  asset_code           citext            NOT NULL,
  serial_number        text,

  condition            asset_condition   NOT NULL DEFAULT 'excellent',
  status               asset_status      NOT NULL DEFAULT 'available',

  purchase_date        date,
  purchase_price       integer           CHECK (purchase_price IS NULL OR purchase_price >= 0),
  purchase_source      text,

  notes                text,

  created_at           timestamptz       NOT NULL DEFAULT now(),
  updated_at           timestamptz       NOT NULL DEFAULT now(),
  deleted_at           timestamptz,

  UNIQUE (workspace_id, asset_code)
);

COMMENT ON TABLE assets IS 'Physical units. Serial_number is manufacturer serial; asset_code is our label.';

CREATE INDEX idx_assets_product ON assets(product_id) WHERE deleted_at IS NULL;
CREATE INDEX idx_assets_workspace_status
  ON assets(workspace_id, status) WHERE deleted_at IS NULL;
CREATE INDEX idx_assets_serial
  ON assets(workspace_id, serial_number)
  WHERE serial_number IS NOT NULL AND deleted_at IS NULL;

-- ----------------------------------------------------------------------------
-- Auto-bump updated_at on every UPDATE. Reusable across any table.
-- ----------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION bump_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER products_bump_updated_at BEFORE UPDATE ON products
  FOR EACH ROW EXECUTE FUNCTION bump_updated_at();
CREATE TRIGGER assets_bump_updated_at BEFORE UPDATE ON assets
  FOR EACH ROW EXECUTE FUNCTION bump_updated_at();
