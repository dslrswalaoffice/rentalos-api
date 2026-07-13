-- 033_server_pricing.sql — Sub-turn 13-0: the server computes line rates
-- ---------------------------------------------------------------------------
-- Trust-boundary fix. `order_items.daily_rate_paise` was written from the
-- client on add, so `POST /orders/:id/items {daily_rate_paise:1}` could rent a
-- Sony FX3 for one paise/day. The server now computes a rental line's rate from
-- the product; a manual override is an explicit, permissioned act (12a's
-- orders.override_price) that sets manual_price=true and records a label here.
--
-- `manual_price` (migration 005) is the is-override flag. This adds only the
-- human label ("why this price").

ALTER TABLE order_items
  ADD COLUMN IF NOT EXISTS price_override_label text;

COMMENT ON COLUMN order_items.price_override_label IS
  'Reason/label for a manual price override (manual_price=true). NULL for engine-priced lines. Requires orders.override_price to set.';
