-- 031_asset_lifecycle.sql — Sub-turn 12b: physical object tracking
-- ---------------------------------------------------------------------------
-- Root cause fixed (MODULE_AUDIT findings 1, 2, 4, 6, 7): RentalOS tracked
-- orders, never physical objects. This migration reshapes asset.status into a
-- pure *physical possession* enum and gives downtime an asset-level dimension
-- so a single damaged unit can be held offline without blocking its siblings.
--
-- Scope note: this ships the INTEGRITY CORE + the minimal asset-level downtime
-- needed by the damaged-return path. The downtime *management* lifecycle
-- (Start / Stop / Overdue / Undo / conflict-naming / scheduling UI / dashboard
-- alerts), OTP handover, and stock windows are deliberately deferred to later
-- sub-turns. The enum + status columns are created now so those land additive.

-- ---------------------------------------------------------------------------
-- 1. asset_status: rebuild to physical possession ONLY.
--    Old enum: available | rented | in_repair | in_transit | reserved | retired
--    New enum: available | out | retired
--    - `out`      = physically with a customer (was: rented / in_transit)
--    - `available`= on the shelf (was: available / reserved / in_repair — repair
--                    is now a downtime record with an end date, not a status)
--    - `retired`  = sold / written off / lost (soft-deleted rows)
--    Nothing in the codebase ever WROTE status, so every live row is
--    'available'; the mapping UPDATEs below are safe no-ops in practice but keep
--    any hand-set legacy value coherent. Postgres can't drop enum values in
--    place, so we swap the type via text.
-- ---------------------------------------------------------------------------
ALTER TABLE assets ALTER COLUMN status DROP DEFAULT;
ALTER TABLE assets ALTER COLUMN status TYPE text USING status::text;

UPDATE assets SET status = 'out'       WHERE status IN ('rented', 'in_transit', 'reserved');
UPDATE assets SET status = 'available' WHERE status = 'in_repair';
-- 'available' and 'retired' already map to themselves.

DROP TYPE asset_status;
CREATE TYPE asset_status AS ENUM ('available', 'out', 'retired');

ALTER TABLE assets ALTER COLUMN status TYPE asset_status USING status::asset_status;
ALTER TABLE assets ALTER COLUMN status SET DEFAULT 'available';

COMMENT ON COLUMN assets.status IS
  'Physical possession only: available (on shelf) | out (with customer) | retired (written off). NOT a reservation state — reservations live at order_items. NOT a repair state — repair is a downtime record.';

-- ---------------------------------------------------------------------------
-- 2. Downtime gains an asset-level dimension + lifecycle scaffolding.
--    The Sub-turn 8a `product_downtimes` table stays (product-level rows still
--    work and still block via availability). We ADD:
--      - asset_id    → a specific unit offline (repair / missing), capacity-1
--      - kind        → typed reason (maintenance | repair | missing)
--      - status      → lifecycle (scheduled | started | ended | cancelled);
--                       only scheduled/started reduce availability
--      - order_id    → set when a downtime is born from a damaged return
--    product_id is relaxed to nullable + an XOR check: a row targets EITHER a
--    product (bulk / whole-product block, legacy) OR a single asset, never both.
--    Existing rows (product_id set, asset_id null) satisfy the XOR untouched.
-- ---------------------------------------------------------------------------
DO $$ BEGIN
  CREATE TYPE downtime_reason AS ENUM ('maintenance', 'repair', 'missing');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE downtime_status AS ENUM ('scheduled', 'started', 'ended', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

ALTER TABLE product_downtimes
  ADD COLUMN IF NOT EXISTS asset_id uuid REFERENCES assets(id) ON DELETE CASCADE,
  ADD COLUMN IF NOT EXISTS kind     downtime_reason NOT NULL DEFAULT 'maintenance',
  ADD COLUMN IF NOT EXISTS status   downtime_status NOT NULL DEFAULT 'scheduled',
  ADD COLUMN IF NOT EXISTS order_id uuid REFERENCES orders(id) ON DELETE SET NULL;

ALTER TABLE product_downtimes ALTER COLUMN product_id DROP NOT NULL;

DO $$ BEGIN
  ALTER TABLE product_downtimes
    ADD CONSTRAINT product_downtimes_asset_xor_product
    CHECK ((asset_id IS NOT NULL) <> (product_id IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- Active asset-level downtimes, for the capacity-exclusion subquery.
CREATE INDEX IF NOT EXISTS product_downtimes_asset_window_idx
  ON product_downtimes (asset_id, start_at, end_at)
  WHERE status IN ('scheduled', 'started');

COMMENT ON COLUMN product_downtimes.asset_id IS
  'When set, this downtime takes ONE specific unit offline (repair/missing) — capacity minus 1. Mutually exclusive with product_id.';
COMMENT ON COLUMN product_downtimes.status IS
  'scheduled | started | ended | cancelled. Only scheduled/started reduce availability. Lifecycle management UI ships in a later sub-turn.';
COMMENT ON COLUMN product_downtimes.order_id IS
  'Set when this downtime was auto-created from a damaged/lost return, linking the block back to its origin order.';
