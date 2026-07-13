-- 035_seed_fixture.sql — Sub-turn 13, chunk 2: the STATIC test fixture
-- ---------------------------------------------------------------------------
-- One product per branch of the new model, two locations with stock genuinely
-- split, a tiered pricing template, a ruleset (weekend + cap_at_one_day, opt-in),
-- and two customers on the two GST paths. This IS the test surface for chunks
-- 3-9 — every verification step runs against it.
--
-- IDEMPOTENT + ADDITIVE by design (UPSERT on natural keys). It does NOT wipe —
-- a destructive workspace-wide reseed in an auto-run migration would abort the
-- deploy on any missed FK and would run against prod on merge. Stale pre-existing
-- dummy rows (backfilled valid by 034) coexist harmlessly. Orders are seeded
-- later (chunk 10) — they need the pricing engine to price them.
-- All rows are scoped to the DSLRSWALA workspace (slug='dslrswala').

-- ===========================================================================
-- Locations — Main (default, already seeded by 024) + Alkapuri Branch.
-- ===========================================================================
UPDATE locations SET name = 'Vadodara Main'
WHERE workspace_id = (SELECT id FROM workspaces WHERE slug = 'dslrswala')
  AND is_default = true;

INSERT INTO locations (workspace_id, name, city, is_default, is_active)
SELECT w.id, 'Alkapuri Branch', 'Vadodara', false, true
FROM workspaces w WHERE w.slug = 'dslrswala'
  AND NOT EXISTS (
    SELECT 1 FROM locations l WHERE l.workspace_id = w.id AND l.name = 'Alkapuri Branch'
  );

-- ===========================================================================
-- Products — one per model branch. UPSERT on (workspace_id, sku). daily_rate is
-- kept in sync with base_price_paise (both = the base rate) until the CONTRACT
-- phase drops the legacy columns.
--   sku · name · category · nature · tracking · pricing_method · charge_period ·
--   base(paise) · gst_bps
-- ===========================================================================
-- stock_quantity is still constrained by products_bulk_requires_quantity (023):
-- bulk ⇒ NOT NULL, tracked ⇒ NULL. We satisfy it here (the source of truth is
-- now stock_levels); stock_quantity is dropped in the CONTRACT phase.
INSERT INTO products
  (workspace_id, sku, name, category, nature, tracking_method, tracking_mode, stock_quantity,
   pricing_method, charge_period, daily_rate, base_price_paise, deposit,
   gst_rate_bps, is_taxable, security_deposit_value_paise, is_active)
SELECT w.id, v.sku, v.name, v.category,
       v.nature::product_nature, v.tracking::tracking_method,
       CASE WHEN v.tracking = 'bulk' THEN 'bulk' ELSE 'tracked' END,
       CASE WHEN v.tracking = 'bulk' THEN v.sq ELSE NULL END,
       v.method::pricing_method, v.period::charge_period,
       v.base, v.base, v.dep, v.gst, true, v.secdep, true
FROM workspaces w
CROSS JOIN (VALUES
  --  sku,               name,               category,        nature,   tracking,     method,       period, base(paise), dep, gst,  secdep,  bulk_qty
  ('SONY-FX3',          'Sony FX3',          'Camera Body',   'rental', 'serialized', 'structure',  'day',   500000,  0, 1800, 5000000,  0),
  ('CANON-24-70',       'Canon 24-70 f2.8',  'Lens',          'rental', 'serialized', 'fixed_fee',  'day',   150000,  0, 1800, 1500000,  0),
  ('SONY-FZ100-BATT',   'Sony FZ100 Battery','Accessory',     'rental', 'bulk',       'fixed_fee',  'day',    20000,  0, 1800,  100000, 12),
  ('CREW-ATTENDER',     'Attender (Crew)',   'Crew',          'rental', 'bulk',       'fixed_price', 'day',  200000,  0, 1800,       0,  3),
  ('SVC-TRANSPORT',     'Transportation',    'Service',       'service','none',       'fixed_price', 'day',  300000,  0, 1200,       0,  0),
  ('SALE-SD-128',       'SanDisk 128GB Card','Consumable',    'sale',   'bulk',       'fixed_price', 'day',   180000,  0, 1800,       0, 20),
  ('SALE-A7III',        'Sony A7 III (Sale)','Camera Body',   'sale',   'serialized', 'fixed_price', 'day', 6500000,  0, 1800,       0,  0),
  ('SUBRENT-70-200',    'Sub-rented 70-200', 'Lens',          'rental', 'serialized', 'fixed_fee',  'day',   250000,  0, 1800, 2000000,  0)
) AS v(sku, name, category, nature, tracking, method, period, base, dep, gst, secdep, sq)
WHERE w.slug = 'dslrswala'
ON CONFLICT (workspace_id, sku) DO UPDATE SET
  name = EXCLUDED.name, category = EXCLUDED.category, nature = EXCLUDED.nature,
  tracking_method = EXCLUDED.tracking_method, tracking_mode = EXCLUDED.tracking_mode,
  stock_quantity = EXCLUDED.stock_quantity,
  pricing_method = EXCLUDED.pricing_method, charge_period = EXCLUDED.charge_period,
  daily_rate = EXCLUDED.daily_rate, base_price_paise = EXCLUDED.base_price_paise,
  gst_rate_bps = EXCLUDED.gst_rate_bps, security_deposit_value_paise = EXCLUDED.security_deposit_value_paise,
  is_active = true, deleted_at = NULL;

-- ===========================================================================
-- Serialized assets — split across the two locations.
--   FX3: 2 at Main, 2 at Branch.  Canon 24-70: 2 at Main.  A7 III: 3 at Main.
--   Sub-rented 70-200: 1 TEMPORARY unit, bounded to one weekend (2025-07-18..21).
-- UPSERT on (workspace_id, asset_code).
-- ===========================================================================
INSERT INTO assets
  (workspace_id, product_id, asset_code, condition, status, location_id, stock_type, available_from, available_until)
SELECT w.id,
       (SELECT id FROM products p WHERE p.workspace_id = w.id AND p.sku = v.sku),
       v.code, 'excellent'::asset_condition, 'available'::asset_status,
       (SELECT id FROM locations l WHERE l.workspace_id = w.id AND l.name = v.loc),
       v.stype::stock_type,
       v.afrom::timestamptz, v.auntil::timestamptz
FROM workspaces w
CROSS JOIN (VALUES
  ('SONY-FX3',       'SONY-FX3-01',    'Vadodara Main',   'current',   NULL, NULL),
  ('SONY-FX3',       'SONY-FX3-02',    'Vadodara Main',   'current',   NULL, NULL),
  ('SONY-FX3',       'SONY-FX3-03',    'Alkapuri Branch', 'current',   NULL, NULL),
  ('SONY-FX3',       'SONY-FX3-04',    'Alkapuri Branch', 'current',   NULL, NULL),
  ('CANON-24-70',    'CANON-2470-01',  'Vadodara Main',   'current',   NULL, NULL),
  ('CANON-24-70',    'CANON-2470-02',  'Vadodara Main',   'current',   NULL, NULL),
  ('SALE-A7III',     'SONY-A7III-01',  'Vadodara Main',   'current',   NULL, NULL),
  ('SALE-A7III',     'SONY-A7III-02',  'Vadodara Main',   'current',   NULL, NULL),
  ('SALE-A7III',     'SONY-A7III-03',  'Vadodara Main',   'current',   NULL, NULL),
  ('SUBRENT-70-200', 'SUBRENT-70200-01','Vadodara Main',  'temporary', '2025-07-18T00:00:00Z', '2025-07-21T00:00:00Z')
) AS v(sku, code, loc, stype, afrom, auntil)
WHERE w.slug = 'dslrswala'
ON CONFLICT (workspace_id, asset_code) DO UPDATE SET
  product_id = EXCLUDED.product_id, location_id = EXCLUDED.location_id,
  stock_type = EXCLUDED.stock_type, available_from = EXCLUDED.available_from,
  available_until = EXCLUDED.available_until, status = 'available', deleted_at = NULL;

-- ===========================================================================
-- Bulk stock levels — exercises the per-location `stock_levels` fix.
--   FZ100 battery: 8 at Main, 4 at Branch.  SanDisk (sale/bulk): 20 at Main.
--   Attender (crew): 3 at Main. UPSERT on (product_id, location_id).
-- ===========================================================================
INSERT INTO stock_levels (product_id, location_id, quantity)
SELECT (SELECT id FROM products p WHERE p.workspace_id = w.id AND p.sku = v.sku),
       (SELECT id FROM locations l WHERE l.workspace_id = w.id AND l.name = v.loc),
       v.qty
FROM workspaces w
CROSS JOIN (VALUES
  ('SONY-FZ100-BATT', 'Vadodara Main',   8),
  ('SONY-FZ100-BATT', 'Alkapuri Branch', 4),
  ('SALE-SD-128',     'Vadodara Main',   20),
  ('CREW-ATTENDER',   'Vadodara Main',   3)
) AS v(sku, loc, qty)
WHERE w.slug = 'dslrswala'
ON CONFLICT (product_id, location_id) DO UPDATE SET quantity = EXCLUDED.quantity;

-- ===========================================================================
-- Pricing structure TEMPLATE ("Camera body") + tiers. Applied to FX3.
-- 1d=1.0×, 3d=2.5×, 7d=5.0×, overflow 0.7×/day. Multipliers on base_price.
-- ===========================================================================
INSERT INTO pricing_structures (workspace_id, name, is_template, overflow_period, overflow_multiplier)
SELECT w.id, 'Camera body', true, 'day'::charge_period, 0.7
FROM workspaces w WHERE w.slug = 'dslrswala'
  AND NOT EXISTS (SELECT 1 FROM pricing_structures s WHERE s.workspace_id = w.id AND s.name = 'Camera body');

INSERT INTO pricing_tiers (structure_id, duration_value, duration_period, multiplier, sort_order)
SELECT s.id, v.dv, 'day'::charge_period, v.mult, v.so
FROM pricing_structures s
JOIN workspaces w ON w.id = s.workspace_id AND w.slug = 'dslrswala'
CROSS JOIN (VALUES (1, 1.0, 0), (3, 2.5, 1), (7, 5.0, 2)) AS v(dv, mult, so)
WHERE s.name = 'Camera body'
ON CONFLICT (structure_id, duration_value, duration_period) DO UPDATE SET
  multiplier = EXCLUDED.multiplier, sort_order = EXCLUDED.sort_order;

UPDATE products SET pricing_structure_id =
  (SELECT s.id FROM pricing_structures s WHERE s.workspace_id = products.workspace_id AND s.name = 'Camera body')
WHERE workspace_id = (SELECT id FROM workspaces WHERE slug = 'dslrswala')
  AND sku = 'SONY-FX3';

-- ===========================================================================
-- Ruleset ("Weekend + half-day") with BOTH a weekend +20% rule and a
-- cap_at_one_day rule. NOT applied to any product — Aamir opts in per product.
-- ===========================================================================
INSERT INTO pricing_rulesets (workspace_id, name, stacking)
SELECT w.id, 'Weekend + half-day', false
FROM workspaces w WHERE w.slug = 'dslrswala'
  AND NOT EXISTS (SELECT 1 FROM pricing_rulesets r WHERE r.workspace_id = w.id AND r.name = 'Weekend + half-day');

INSERT INTO pricing_rules (ruleset_id, name, kind, sort_order, days_of_week, price_adjustment_bps, charge_period_action)
SELECT r.id, 'Weekend surcharge', 'adjust_price'::price_rule_kind, 0, ARRAY[0,6], 2000, NULL
FROM pricing_rulesets r
JOIN workspaces w ON w.id = r.workspace_id AND w.slug = 'dslrswala'
WHERE r.name = 'Weekend + half-day'
  AND NOT EXISTS (SELECT 1 FROM pricing_rules pr WHERE pr.ruleset_id = r.id AND pr.name = 'Weekend surcharge');

INSERT INTO pricing_rules (ruleset_id, name, kind, sort_order, charge_period_action)
SELECT r.id, 'Weekend one-day cap', 'adjust_charge_period'::price_rule_kind, 0, 'cap_at_one_day'
FROM pricing_rulesets r
JOIN workspaces w ON w.id = r.workspace_id AND w.slug = 'dslrswala'
WHERE r.name = 'Weekend + half-day'
  AND NOT EXISTS (SELECT 1 FROM pricing_rules pr WHERE pr.ruleset_id = r.id AND pr.name = 'Weekend one-day cap');

-- ===========================================================================
-- Customers — one Gujarat (intra-state → CGST+SGST), one Maharashtra
-- (inter-state → IGST). The Gujarat one has a GSTIN so the code derives from it.
-- UPSERT on (workspace_id, phone).
-- ===========================================================================
INSERT INTO people
  (workspace_id, display_name, phone, email, company_name, gstin,
   state, default_gst_state, state_code, country_code)
SELECT w.id, v.name, v.phone, v.email, v.company, v.gstin, v.state, v.state, v.code, 'IN'
FROM workspaces w
CROSS JOIN (VALUES
  ('Radhika Films (GJ)', '+919820000001', 'radhika@example.com', 'Radhika Films',   '24AAVFD2453P1ZU', 'Gujarat',     'GJ'),
  ('Nikhil Studios (MH)', '+919820000002', 'nikhil@example.com', 'Nikhil Studios',  NULL,              'Maharashtra', 'MH')
) AS v(name, phone, email, company, gstin, state, code)
WHERE w.slug = 'dslrswala'
ON CONFLICT (workspace_id, phone) DO UPDATE SET
  display_name = EXCLUDED.display_name, gstin = EXCLUDED.gstin,
  state = EXCLUDED.state, default_gst_state = EXCLUDED.default_gst_state,
  state_code = EXCLUDED.state_code, deleted_at = NULL;
