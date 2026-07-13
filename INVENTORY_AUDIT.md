# Inventory Module — Phase 0 Audit (Sub-turn 13)

## 0.0 Scope + hard limitation
- **Static code + schema audit.** The sandbox is **egress-blocked from production** (verified across prior sub-turns: `curl …/api/health` → `403 CONNECT`). **I cannot run a single `SELECT` against the live DB.** Every question of the form *"how many rows…"* / *"what values does `weekly_rate` hold"* / *"which assets are at Branch"* is therefore **NEEDS-HUMAN** — answered from schema + code, never from live data. **No row counts are fabricated.**
- Audited at branch `claude/repo-root-structure-vf6xy4` (12a + 12b applied), migrations `001`–`032`.
- **Headline:** several of this spec's assumptions are already-built. Locations exist and availability is already location-scoped; `resource` never existed; bulk is a quantity column; GST split exists; purchase cost/ROI shipped (11); **and the price is already snapshotted — the prime-directive bug does not exist.** Details below.

---

## 0.1 Current schema (verbatim CREATE + every later ALTER)

### `products` (002 base; +014 +015 +018 +023 +030)
```
id uuid PK · workspace_id uuid NOT NULL · sku citext NOT NULL · name text NOT NULL
category text NOT NULL · description text
daily_rate   integer NOT NULL CHECK (daily_rate > 0)          -- ⚠ integer, not bigint
weekly_rate  integer CHECK (weekly_rate IS NULL OR > 0)        -- NEVER READ (see 0.2)
monthly_rate integer CHECK (monthly_rate IS NULL OR > 0)       -- NEVER READ
deposit           integer NOT NULL DEFAULT 0 CHECK (>=0)
replacement_value integer CHECK (NULL OR > 0)
specifications jsonb NOT NULL DEFAULT '{}' · notes text · image_url text
is_active boolean NOT NULL DEFAULT true
created_by uuid · created_at/updated_at timestamptz · deleted_at timestamptz
UNIQUE (workspace_id, sku)
-- + hsn_code text (014, CHECK length<=8)
-- + is_kit boolean NOT NULL DEFAULT false (015)
-- + buffer_before_hours int NOT NULL DEFAULT 0 (018, 0-72)
-- + buffer_after_hours  int NOT NULL DEFAULT 0 (018, 0-72)
-- + shortage_limit      int NOT NULL DEFAULT 0 (018, 0-100)
-- + tracking_mode  text NOT NULL DEFAULT 'tracked' (023, CHECK in ('tracked','bulk'))
-- + stock_quantity int (023, nullable) · CHECK products_bulk_requires_quantity (mode↔qty)
-- + default_purchase_cost_paise BIGINT CHECK (NULL OR >=0) (030)
```
**No `type`/`nature`, no `pricing_method`/`base_price`/`charge_period`/`structure`/`ruleset`, no `gst_rate_bps`/`is_taxable`, no `security_deposit_value_paise`, no `charge_for_product`/`eligible_for_discounts`.**

### `assets` (002 base; +024 +030 +031)
```
id uuid PK · workspace_id uuid NOT NULL · product_id uuid NOT NULL (ON DELETE RESTRICT)
asset_code citext NOT NULL · serial_number text
condition asset_condition NOT NULL DEFAULT 'excellent'
status    asset_status     NOT NULL DEFAULT 'available'   -- 031: enum now available|out|retired
purchase_date date · purchase_source text · notes text
created_at/updated_at · deleted_at · UNIQUE (workspace_id, asset_code)
-- + location_id uuid NOT NULL REFERENCES locations(id) (024)
-- 030: purchase_price integer DROPPED; + purchase_cost_paise BIGINT CHECK (NULL OR >=0)
```
**No `stock_type`, no `available_from`, no `available_until`.** (12b STEP 0 confirmed these never existed.)

### `order_items` (004 base; +005 +006 +007 +009 +010)
```
id · workspace_id · order_id · parent_item_id (self-FK, accessory grouping)
item_type order_item_type NOT NULL       -- rental|delivery_fee|late_fee|damage|discount|tax|deposit|other
product_id uuid (nullable, ON DELETE RESTRICT)
description text NOT NULL · quantity int NOT NULL DEFAULT 1 CHECK (>0)
daily_rate_paise  bigint      -- 🔴 THE PER-LINE RATE SNAPSHOT (see 0.2)
billable_days     integer
unit_amount_paise  bigint NOT NULL DEFAULT 0
total_amount_paise bigint NOT NULL DEFAULT 0
sort_order int · created_at/updated_at
-- + manual_price boolean NOT NULL DEFAULT false (005)
-- + status order_item_status NOT NULL DEFAULT 'pending_dispatch' (006) · dispatched_at · returned_at · condition_notes
-- + chargeable_paise/cgst_paise/sgst_paise/igst_paise bigint NOT NULL DEFAULT 0 (007)  ← tax snapshot per line
-- + handed_to · received_by_user_id · dispatch_notes (009) · returned_by_user_id · returned_from (010)
```
**No `is_custom_line`, no `custom_name`.** Negative prices are not modelled; `quantity > 0` and defaults `>= 0`. (There is a `discount` item_type used by coupons with a negative total, so negative *totals* already occur on that one type.)

### `orders` (004 base; +007 +019 +024)
```
id · workspace_id · order_number int NOT NULL · customer_person_id uuid NOT NULL
status order_status NOT NULL DEFAULT 'draft' · rental_start/rental_end timestamptz
dispatch_type text · delivery_address · channel text
subtotal_paise/tax_paise/discount_paise/total_paise/deposit_paise/paid_paise/balance_paise bigint
notes · internal_notes · created_by · timestamps · deleted_at
UNIQUE (workspace_id, order_number) · CHECK (rental_end > rental_start)
-- + gst_state text (007)                                   ← per-order GST state override (a NAME, e.g. 'Gujarat')
-- + deposit_required_paise bigint NOT NULL DEFAULT 0 (019) · deposit_status text NOT NULL DEFAULT 'none'
-- + pickup_location_id uuid NOT NULL (024) · return_location_id uuid NOT NULL (024)
-- CHECK orders_pickup_equals_return (pickup = return)  ← 12b/6i: forced equal in v1
```
Note: **two deposit columns** — legacy `deposit_paise` (deposit portion of line totals) and `deposit_required_paise` (6d expected deposit).

### `people` (003 base; +007 +013)
```
id · workspace_id · display_name · phone NOT NULL · phone_verified_at · email citext
id_proof_type/id_proof_number text · address_line/city/state/postal_code text · country_code text DEFAULT 'IN'
company_name · gstin · notes · created_by · timestamps · deleted_at · UNIQUE (workspace_id, phone)
-- + default_gst_state text (007)                           ← the customer's GST state NAME
-- + tier text CHECK in (normal|premium|vip) · trust_score int (0-100) · trust_score_updated_at (013)
-- + billing_address text · shipping_address text (013)
```
**Has `state` (text, a name) and `default_gst_state` (text, a name). No `state_code` ('GJ').**

### `workspaces` (001 base; +004 +011)
```
id · slug · name · location text · country_code · currency_code · timezone · created_at · deleted_at
-- 004: legal_name, business_address/email/phone, pan, gstin, sac_code, uan, logo_url,
--       place_of_supply text  ← the workspace GST state NAME (corrected to 'Gujarat' in 007), next_order_number, settings jsonb
-- 011: address_line1/2, city, state, postal_code text
```
**No `state_code`.** GST state lives as a text NAME in `place_of_supply`.

### Already-existing: `locations` (024)
```
locations (id, workspace_id, name, address_line1/2, city, state, postal_code, phone, email,
           is_default, is_active, created_at, updated_at)
partial unique index: one is_default=true per workspace; migration seeds one default per workspace
```

---

## 0.2 Precise answers

### Product model
- **`type`/`nature` column: does NOT exist.** There is no product-nature axis at all. So *"how many rows use `resource`"* → **zero, because `resource` (and every nature value) does not exist.** `grep -rn "'resource'" src/` → **0**. Nothing to delete; `nature` is a greenfield ADD.
- **Tracking:** `products.tracking_mode text` (023) = `'tracked' | 'bulk'` — a **separate column** (not collapsed into a type). There is no `'serialized'/'none'` vocabulary; `tracked`≈serialized, `bulk`=fungible. No `service`/`sale` concept.
- **Do bulk products have asset rows or a quantity column?** → **A quantity column.** Bulk = `stock_quantity int` on the product; **no `assets` rows are created for bulk** (`products_bulk_requires_quantity` CHECK enforces it). Capacity = `stock_quantity`, workspace-global. **⇒ per-location bulk needs the `stock_levels` table** the spec anticipates (tracked products already resolve per-location via `assets.location_id`).

### Pricing — the important part
- **Every pricing column on `products`:** `daily_rate integer NOT NULL >0`, `weekly_rate integer`, `monthly_rate integer`, `deposit integer`, `replacement_value integer`. (All `integer`, i.e. paise as int32 — overflow risk above ₹21.4L; `default_purchase_cost_paise` is the only BIGINT.)
- **`weekly_rate`/`monthly_rate` — how many products have a value?** → **CANNOT DETERMINE (egress-blocked).** Confirmed by code: **neither column is read anywhere** — `grep` in `pricing.ts` → 0; the pricing engine uses only `daily_rate`. **⇒ These are dead columns that may hold real operator-entered data. Dropping them requires knowing whether any row is non-null. NEEDS-HUMAN before any drop.** (§0.3.)
- **🔴 Does `order_items` snapshot the price, or recompute from the product? → IT SNAPSHOTS. There is NO live "recompute from product" bug.**
  - The per-line rate is stored in `order_items.daily_rate_paise` and captured at add time (`orders.ts:1084`, from the request payload — the wizard passes the rate).
  - `recomputeOrderTotals` reads the **stored** `item.daily_rate_paise` (`pricing.ts:361`), never the product's current `daily_rate`. `loadItems` joins products only for `name`/`sku` (`pricing.ts:274`), not rate.
  - `billable_days` is recomputed **only from the order's own rental window** — correct (changing the order's dates re-prices; changing the *product's rate* does not).
  - Tax is also snapshotted per line (`cgst/sgst/igst_paise`). Invoices carry a separate frozen `snapshot` jsonb.
  - **⇒ Changing a product's rate today does NOT rewrite an existing order.** The spec's prime-directive risk is already satisfied. (Gap that remains: the snapshot is thin — no `charge_period`/method/structure detail — and the rate snapshot is client-supplied rather than server-captured. That's a robustness gap, not a correctness bug.)
- **Existing tiered/structure/template/ruleset tables:** **none.**

### Tax
- **GST computation:** `computeLineTax` (`pricing.ts:208`). **Rate** = `workspace.settings.tax.default_gst_percent` (default 18) — **workspace-level, NOT per-product.** Applied only when feature `gst_split_cgst_sgst_igst` is on (DSLRSWALA default true).
- **CGST/SGST vs IGST split — exists.** Intra-state → `CGST = floor(base·pct/200)`, `SGST = remainder`; inter-state → `IGST`. Integer math (`Math.floor`), no floats. **Determination:** `orders.gst_state` (per-order override) → else `people.default_gst_state` → else `workspace.place_of_supply`; equal to workspace ⇒ intra-state (`pricing.ts:314-318`). **All by state NAME ('Gujarat'), not code ('GJ').**
- **`state_code` on workspaces/people?** → **No.** State is a text name (`workspace.place_of_supply`, `people.default_gst_state`/`people.state`). **HSN on products?** → **Yes**, `products.hsn_code` (014). **Per-product GST rate?** → **No** (`gst_rate_bps` does not exist; rate is workspace-level percent).

### Deposits
- **`deposit_required_paise`** (`orders`, 019) is **set manually per order** via `PATCH /api/orders/:id/deposit`. **No auto-calc** — not a percentage, not per-product, not per-customer. (CLAUDE.md 6d: *"no workspace auto-calc yet."*)
- **Per-product / per-customer deposit config:** **none.** (`products.deposit integer` exists but is a legacy flat amount, not wired into the 6d deposit workflow.) No `deposit_method`, no `security_deposit_value_paise`, no customer override.

### Locations
- **`locations` table EXISTS** (024). Assets carry `location_id` (NOT NULL). Orders carry `pickup_location_id`/`return_location_id` (NOT NULL, forced equal by CHECK).
- **Does availability filter by location today?** → **YES for tracked products; NO for bulk.** `checkAvailability(locationId?)` counts assets **at that location** and reserves only against orders whose `pickup_location_id` matches (`availability.ts`). Bulk products are **workspace-global** (per-location bulk deferred). **⇒ There is NO live over-booking bug for tracked/serialized gear** (a Branch camera does not show available for a Main pickup). The residual gap is **bulk** stock, which has no per-location dimension yet (needs `stock_levels`). Cross-location *shortage surfacing* + *transfer* are not built.

### Post-12b confirmations (all ✅)
- **`asset.status` is written at dispatch (`out`) and return (`available`/`retired`)** — `orders.ts` dispatch/return, 12b.
- **`in_repair` is gone** — `asset_status` rebuilt to `available|out|retired` (031); `grep in_repair src/` → 0. Repair is an **asset-level downtime record** (`product_downtimes.kind='repair'`, auto-created on damaged return).
- **Availability releases at RETURN, not CLOSE** — item-level `RESERVING_ITEM_STATUSES` predicate (12b); a returned item stops reserving immediately.
- **Capacity excludes downtime** — an active asset-level downtime drops that unit from capacity (12b).

---

## 0.3 Deletion plan (NOTHING is dropped in Phase 0)

| Item | Rows with data | Migrate to | Safe to drop? |
|---|---|---|---|
| `products.weekly_rate` (int) | **UNKNOWN — egress-blocked** | a `pricing_structure` (tier: 7 days) IF non-null | **NO until row values are known.** NEEDS-HUMAN |
| `products.monthly_rate` (int) | **UNKNOWN — egress-blocked** | a `pricing_structure` (tier: 1 month) IF non-null | **NO until known.** NEEDS-HUMAN |
| `products.daily_rate` (int) | every product (NOT NULL) | `base_price_paise` + `charge_period='day'` (BIGINT) | Only after backfill + total-parity verify |
| `products.deposit` (int, legacy flat) | UNKNOWN | `security_deposit_value_paise` if used, else retire | NEEDS-HUMAN (is it used anywhere in code? — appears unused by 6d) |
| `'resource'` product type | **n/a — never existed** | — | Already absent; nothing to do |
| `in_repair` asset status | **n/a — removed in 031** | — | Already gone |
| `asset.status = out\|reserved\|…` legacy | already collapsed (031) | — | Done |

**Rule honored:** migration precedes deletion, in separate migrations. **`weekly_rate`/`monthly_rate` cannot be dropped until Aamir tells me (or a query confirms) whether any row is non-null** — if they hold real rates, they become `pricing_structures` first.

---

## 0.4 Gap list (target model vs. reality), sized

**Product model**
- `product_nature` enum (rental|service|sale) + column + backfill all→rental — **M**
- `sale`-nature availability model (quantity-on-hand, decrement at dispatch, never returns) — **L**
- `service`-nature (no availability constraint) — **S**
- `stock_type` (current|expected|temporary) + `available_from`/`available_until` on assets + availability integration (sub-rent) — **M**
- Rename/extend `tracking_mode` vocabulary to `serialized|bulk|none` — **S** (or keep tracked/bulk + add `none`)

**Locations**
- `stock_levels` table for **per-location bulk** — **M**
- Cross-location shortage surfacing ("2 at Branch — transfer?") — **M**
- Drop the `orders_pickup_equals_return` CHECK / transfer workflow — **DEFERRED (own sub-turn)**

**Pricing**
- `pricing_method`/`charge_period`/`base_price_paise`/`charge_for_product`/`eligible_for_discounts` on products — **M**
- `pricing_structures` + `pricing_tiers` (multiplier model, round-up, overflow) — **L**
- `pricing_rulesets` + `pricing_rules` (weekend/seasonal/charge-period, stacking, all-or-nothing, `cap_at_one_day`) — **L**
- Richer per-line price snapshot (charge_period used + explanation); server-captured rate — **M**
- Manual override label + custom charge duration on lines (perm `orders.override_price`, already exists) — **S**

**Custom line items**
- `order_items.is_custom_line` + `custom_name`; allow negative unit price only when custom; `product_id` nullable already true — **S/M**

**GST**
- `products.gst_rate_bps` + `is_taxable`; move rate from workspace-percent → per-product bps — **M**
- `state_code` on workspaces/people (or keep names + a name→code map) — **S**, but touches the working GST path — **verify parity**

**Deposits**
- `deposit_method` enum + `products.security_deposit_value_paise` + `people` overrides + `orders.deposit_method_used` + auto-calc (rental-lines-only base) — **M**
- Retained-deposit-as-line — **S** (depends on custom lines)

**Purchase cost (11 — already shipped)** — **none.** `default_purchase_cost_paise`/`purchase_cost_paise`/`purchase_date` + COALESCE read + NULL≠zero ROI all exist.

---

## Summary — what's already done vs. what's real work

**Already built (spec assumptions that are stale):** locations + **location-scoped availability for tracked gear** (no live over-booking bug); **price is snapshotted** (no recompute-from-product bug); GST CGST/SGST/IGST split (state-name based); HSN on products; purchase cost + ROI (11); `resource` never existed; `in_repair` already removed.

**Genuinely missing (the real sub-turn):** product `nature` axis + `sale`/`service` availability models; `stock_type`/sub-rent windows; pricing methods + structures/templates + rulesets; custom line items (incl. negative); per-product GST rate (bps); deposit methods/per-product/per-customer/auto-calc; per-location bulk (`stock_levels`); cross-location shortage surfacing.

**The two things blocking the deletion plan — I need you (Aamir):**
1. **`weekly_rate` / `monthly_rate`:** do any products have non-null values, and what are they? I cannot query prod. If they hold real rates, they migrate into `pricing_structures` before any drop. **I will not drop them until you confirm.**
2. **Locations:** the spec says "assign every existing asset to a location — ask which are at Branch, do not guess." Which asset codes sit at **Alkapuri Branch** vs **Main**? (Migration 024 already seeded one default location and put every asset there; splitting to two needs your list.)

Also confirm: **`state_code` vs state-name** — the working GST path uses names ('Gujarat'). Switching to 'GJ' codes touches a correct, live path; I'd add codes alongside names + verify byte-parity rather than rip out names. OK?

---

**Phase 0 complete. No code, no migrations, no drops — this file is the only artifact. Awaiting (a) approval of the deletion plan and (b) the two data answers above before I build. I will treat the build plan and the deletion plan as separately approved, per your instruction.**
