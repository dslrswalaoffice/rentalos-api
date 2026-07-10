-- ============================================================================
-- Migration 015 — Product kits (bundles)
-- ============================================================================
-- Sub-turn 5c-2: a product can be a KIT that bundles other products (body +
-- charger + batteries + card = "Sony FX3 Kit"). One price, one line item, one
-- dispatch. Component physical tracking is a QR-scanning concern (deferred).
--
--   * products.is_kit — flags a product as a bundle
--   * product_kit_items — the components (kit_product_id → component_product_id, qty)
--   * check_no_nested_kits trigger — single-level nesting only (a kit can't
--     contain a kit)
--
-- Kit capacity is DERIVED (MIN across components), never stored. Kit pricing is
-- the kit product's own daily_rate; component rates are ignored when booked as
-- a kit.
-- ============================================================================

ALTER TABLE products
  ADD COLUMN IF NOT EXISTS is_kit boolean NOT NULL DEFAULT false;

CREATE TABLE IF NOT EXISTS product_kit_items (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  workspace_id         uuid        NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kit_product_id       uuid        NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  component_product_id uuid        NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
  quantity             integer     NOT NULL CHECK (quantity > 0),
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT kit_no_self CHECK (kit_product_id != component_product_id),
  UNIQUE (kit_product_id, component_product_id)
);

CREATE INDEX IF NOT EXISTS product_kit_items_kit_idx
  ON product_kit_items (workspace_id, kit_product_id);

-- Block nested kits: a component may not itself be a kit.
CREATE OR REPLACE FUNCTION check_no_nested_kits()
RETURNS trigger AS $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM products
    WHERE id = NEW.component_product_id AND is_kit = true
  ) THEN
    RAISE EXCEPTION 'nested_kits_not_allowed: component % is itself a kit', NEW.component_product_id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_no_nested_kits ON product_kit_items;
CREATE TRIGGER trg_no_nested_kits
  BEFORE INSERT OR UPDATE ON product_kit_items
  FOR EACH ROW EXECUTE FUNCTION check_no_nested_kits();
