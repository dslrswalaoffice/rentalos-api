-- 036_gst_state.sql — Sub-turn 13, chunk 5: code-based GST split
-- ---------------------------------------------------------------------------
-- The CGST/SGST-vs-IGST split moves from state NAME to state CODE (derived from
-- GSTIN when present). These columns snapshot the resolution onto the order so a
-- later customer address change never alters an issued invoice, and flag when
-- the customer's state had to be ASSUMED (blocked-with-confirm before finalise).

ALTER TABLE orders
  ADD COLUMN IF NOT EXISTS gst_state_code text,
  ADD COLUMN IF NOT EXISTS state_assumed  boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN orders.gst_state_code IS
  'Resolved customer GST state code (Sub-turn 13). Derived GSTIN → explicit code → address → assumed workspace state.';
COMMENT ON COLUMN orders.state_assumed IS
  'true when the customer GST state could not be resolved and the workspace state was assumed — invoice finalisation blocks-with-confirm.';
