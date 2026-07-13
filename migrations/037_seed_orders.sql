-- 037_seed_orders.sql — Sub-turn 13, chunk 10: seed demo orders.
-- ---------------------------------------------------------------------------
-- Adds ONE confirmed order to the DSLRSWALA fixture that exercises the chunk-7
-- custom line path: a rental line, a POSITIVE custom line, and a NEGATIVE custom
-- line (a fixed-amount goodwill credit). Idempotent — guarded on a notes marker,
-- so a redeploy never double-seeds. Cached totals are set approximately (tax = 0);
-- an operator hitting "Recalculate" re-prices exactly through the engine.
--
-- Runs BEFORE the contract drops (038) but touches none of the doomed columns.

DO $$
DECLARE
  ws   uuid;
  cust uuid;
  loc  uuid;
  prod uuid;
  ord  uuid;
  onum int;
BEGIN
  SELECT id INTO ws FROM workspaces WHERE slug = 'dslrswala';
  IF ws IS NULL THEN RETURN; END IF;

  -- Idempotency: skip if the demo order is already present.
  IF EXISTS (SELECT 1 FROM orders WHERE workspace_id = ws AND notes = 'SEED-13 demo order') THEN
    RETURN;
  END IF;

  SELECT id INTO cust FROM people    WHERE workspace_id = ws AND phone = '+919820000001';
  SELECT id INTO loc  FROM locations WHERE workspace_id = ws AND is_default = true;
  SELECT id INTO prod FROM products  WHERE workspace_id = ws AND sku = 'CANON-24-70';
  IF cust IS NULL OR loc IS NULL THEN RETURN; END IF;

  -- Atomic order-number allocation (same rule as the app: post-increment - 1).
  UPDATE workspaces SET next_order_number = next_order_number + 1
  WHERE id = ws
  RETURNING next_order_number - 1 INTO onum;

  INSERT INTO orders (
    workspace_id, order_number, customer_person_id, status,
    rental_start, rental_end, pickup_location_id, return_location_id,
    subtotal_paise, tax_paise, total_paise, notes
  ) VALUES (
    ws, onum, cust, 'confirmed',
    now() + interval '2 days', now() + interval '5 days', loc, loc,
    470000, 0, 470000, 'SEED-13 demo order'
  ) RETURNING id INTO ord;

  -- Rental line — Canon 24-70, 1 unit × ₹1,500/day × 3 days.
  INSERT INTO order_items (
    workspace_id, order_id, item_type, product_id, description, quantity,
    daily_rate_paise, billable_days, unit_amount_paise, total_amount_paise,
    chargeable_paise, sort_order
  ) VALUES (
    ws, ord, 'rental', prod, 'Canon 24-70 f2.8 · CANON-24-70', 1,
    150000, 3, 150000, 450000, 450000, 1
  );

  -- POSITIVE custom line — a named one-off charge.
  INSERT INTO order_items (
    workspace_id, order_id, item_type, description, quantity,
    unit_amount_paise, total_amount_paise, chargeable_paise,
    is_custom_line, custom_name, sort_order
  ) VALUES (
    ws, ord, 'other', 'Rush handling', 1, 50000, 50000, 50000,
    true, 'Rush handling', 2
  );

  -- NEGATIVE custom line — a fixed goodwill credit (only custom lines may go <0).
  INSERT INTO order_items (
    workspace_id, order_id, item_type, description, quantity,
    unit_amount_paise, total_amount_paise, chargeable_paise,
    is_custom_line, custom_name, sort_order
  ) VALUES (
    ws, ord, 'other', 'Goodwill credit', 1, -30000, -30000, -30000,
    true, 'Goodwill credit', 3
  );
END $$;
