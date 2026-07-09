-- ============================================================================
-- Migration 007 — Invoice module schema foundation (GST split + customer state)
-- ============================================================================
-- Pure schema prep for the invoice module (Sub-turn 2.4). NO endpoints, NO
-- behavioural change here — just the columns the generator will populate later,
-- so a schema mistake rolls back one migration cleanly instead of unwinding
-- handler logic.
--
-- What this adds:
--   * GST split columns (cgst/sgst/igst) on order_items AND invoices. Intra-state
--     orders populate CGST+SGST (each half the tax); inter-state populate IGST.
--   * order_items.chargeable_paise — the billable amount (status-adjusted).
--     total_amount_paise stays as the pre-adjustment gross.
--   * Customer state at two levels: people.default_gst_state (registered) and
--     orders.gst_state (per-order override). Order wins; else workspace fallback.
--   * invoices.gst_state — frozen at generation so issued invoices never shift.
--
-- Conventions:
--   * Money is bigint paise, default 0.
--   * Population of these columns is deferred to Sub-turn 2.4a-endpoints — this
--     migration only backfills existing rows so nothing reads as ₹0 wrongly.
-- ============================================================================


-- ----------------------------------------------------------------------------
-- 1. order_items — chargeable amount + GST breakdown
-- ----------------------------------------------------------------------------
ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS chargeable_paise bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS cgst_paise       bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sgst_paise       bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS igst_paise       bigint NOT NULL DEFAULT 0;

-- Backfill chargeable from the existing gross so historical rows aren't ₹0.
UPDATE order_items
SET chargeable_paise = total_amount_paise
WHERE chargeable_paise = 0
  AND total_amount_paise > 0;


-- ----------------------------------------------------------------------------
-- 2. orders — per-order GST state override
-- ----------------------------------------------------------------------------
ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS gst_state text;


-- ----------------------------------------------------------------------------
-- 3. people — customer's registered GST state
-- ----------------------------------------------------------------------------
ALTER TABLE people
  ADD COLUMN IF NOT EXISTS default_gst_state text;


-- ----------------------------------------------------------------------------
-- 4. invoices — GST breakdown + frozen state
-- ----------------------------------------------------------------------------
ALTER TABLE invoices
  ADD COLUMN IF NOT EXISTS cgst_paise bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS sgst_paise bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS igst_paise bigint NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS gst_state  text;


-- ----------------------------------------------------------------------------
-- 5. Correct DSLRSWALA place_of_supply (city -> state for GST determination)
-- ----------------------------------------------------------------------------
-- Migration 004 seeded 'Vadodara' (the city). GST needs the state. Only touch
-- NULL or the legacy 'Vadodara' value, so a manual override is left alone.
UPDATE workspaces
SET place_of_supply = COALESCE(place_of_supply, 'Gujarat')
WHERE slug = 'dslrswala'
  AND (place_of_supply IS NULL OR place_of_supply = 'Vadodara');


-- ----------------------------------------------------------------------------
-- 6. Backfill existing DSLRSWALA customers to the home state (Gujarat)
-- ----------------------------------------------------------------------------
-- Fair default for the 4 pre-existing customers; Aamir can correct individuals.
UPDATE people
SET default_gst_state = 'Gujarat'
WHERE workspace_id = (SELECT id FROM workspaces WHERE slug = 'dslrswala')
  AND default_gst_state IS NULL;
