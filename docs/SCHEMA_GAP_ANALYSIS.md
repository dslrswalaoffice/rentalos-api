# RentalOS — Schema Gap Analysis

**Definitive audit of what the database schema _is_ today vs. what the locked design substrate _requires_ for the full-feature rollout.**

- **Scope:** migrations `001`–`054`, all `public/` + `docs/design-substrate/sprint-1/` design HTML available at time of writing.
- **Method:** every `CREATE TABLE` / `ALTER TABLE ADD|DROP COLUMN` / `CREATE TYPE` / `CHECK` / `CREATE INDEX` / `CREATE TRIGGER` was read directly from the migration files. The authoritative live-table list was produced by grepping `CREATE TABLE` across `migrations/`.
- **Status:** READ-ONLY AUDIT. **No migrations were written and no code was changed in this pass.** Every "missing" item below is a _proposal_, not an applied change.
- **Date:** 2026-07-19

---

## Headline counts

| Metric | Count |
|---|---|
| **Existing tables** (operational) | **51** (+ `schema_migrations` ledger = 52 physical) |
| **Missing tables** the design substrate / rollout slices require | **11 firm** (+ 3 optional/deferrable) |
| **ALTER migrations** needed (net-new columns on existing tables) | **~10 columns on `people`**, grouped into **2 ALTER migrations** |
| **Estimated migrations to complete the v1 schema** | **~13–16** (see Section B queue) |

> **The single biggest finding:** the schema is **broad and mature on the Order/Inventory/Payment spine** (54 migrations, a full physical-object model, GST, pricing engine, standbys, quotes, substitutions, damage, insurance). The gaps are almost entirely in the **Customer/People domain** (which has only 3 migrations: `003`, `013`) and in four **not-yet-started rollout slices** (dispatch photos/OTP, bank reconciliation, KYC documents, maintenance jobs). People is where the design substrate is richest and the schema is thinnest — that mismatch is the whole story.

---

## Reconciled grep false-negatives (read this first)

Two items that a naive `grep` flags as "missing" but **already exist** — do **not** propose migrations for them:

1. **Invoice PDF storage — EXISTS.** `invoices.pdf_url` was added in **migration `008`** (alongside `customer_id`, `discount_paise`, `paid_paise`, `balance_paise`, `sent_at`, `due_at`, `paid_at`, `notes`). A grep for the string `invoice_pdf_url` returns nothing and mislabels it missing; the real column is `invoices.pdf_url`.
2. **`is_late` / `days_overdue` — COMPUTED, not stored (by design).** `is_late` is derived at read time: `rental_end < now() AND EXISTS(order_items still 'dispatched')` (see CLAUDE.md → "Late orders"). The "Late Nd" / "days overdue" the UI shows is `now() − rental_end`, computed. **Do not add a stored column** (hard-rule 3).

---

# SECTION A — Domain-by-domain

For each domain: **(1)** existing tables + salient columns/enums/checks (with the migration that created/modified them), **(2)** what the designs need, **(3)** the gap — missing tables, missing columns (as ALTERs), unused columns to review, and computed/derived fields (with a note on whether the calc source exists).

---

## A1 · Auth & Tenancy

**Existing tables:** `workspaces`, `users`, `workspace_memberships`, `sessions`, `password_reset_tokens`, `audit_events`, `login_attempts`, `invitations`, `schema_migrations`.

Key facts:
- `workspaces` (`001`, expanded `004`): `id, slug, name, location, country_code, currency_code, timezone, created_at, deleted_at` + business/tax columns (`legal_name, business_address/email/phone, pan, gstin, sac_code, uan, logo_url, place_of_supply`), `next_order_number`, `settings jsonb`. **Has `deleted_at`, no `updated_at`.**
- `users` (`001`): global identity, `email citext UNIQUE`, `deleted_at`.
- `workspace_memberships` (`001`): `role workspace_role`, `status membership_status`, `permissions jsonb` (`032`). Enum `workspace_role` rebuilt in `032` → `owner|manager|staff` (dropped `client|investor`). `membership_status` gained `deactivated` in `032` (**transaction-hostile** `ALTER TYPE ADD VALUE`).
- `audit_events` (`001`): append-only, **trigger-guarded** (`prevent_audit_mutation` blocks UPDATE/DELETE).
- `invitations` (`029`): `role TEXT CHECK (role IN ('manager','staff','client','investor'))` — note the CHECK still lists `client|investor` even though `032` collapsed the membership enum; the app layer restricts to `manager|staff`.

**Designs need:** no auth/tenancy gaps surfaced by the People substrate. Team-management UI is already backed (`032`).

**Gap:** ✅ **None.** One cosmetic note for review: `invitations_role_valid` CHECK vocabulary (`client|investor`) is now stale vs. the collapsed `workspace_role` — a future cleanup migration could tighten it to `manager|staff`, but it is not a rollout blocker (app enforces it).

---

## A2 · Inventory — Products, Assets, Stock, Pricing, Locations, Tags

**Existing tables:** `products`, `assets`, `product_kit_items`, `product_downtimes`, `product_recommendations`, `stock_levels`, `locations`, `tags`, `tag_assignments`, `pricing_structures`, `pricing_tiers`, `pricing_rulesets`, `pricing_rules`.

Key facts:
- `products` (`002` + many): `daily_rate` (paise), `deposit`, `category NOT NULL`, `image_url`, `is_active`, `deleted_at`, `updated_at`, `hsn_code` (`014`), `default_purchase_cost_paise` (`030`). **Big expand in `034`:** `nature product_nature`, `tracking_method (serialized|bulk|none)`, `pricing_method`, `base_price_paise`, `gst_rate_bps`, `is_taxable`, `security_deposit_value_paise`, etc. **`038` DROPPED** the legacy `tracking_mode`, `stock_quantity`, `weekly_rate`, `monthly_rate`.
- `assets` (`002` + `031` + `030` + `024`): `status asset_status` rebuilt in `031` → **`available|out|retired`** (was 6 values). `purchase_cost_paise` (`030`, replaced legacy `purchase_price`), `purchase_date`, `location_id NOT NULL` (`024`). **Has `deleted_at`, `updated_at`.**
- `product_downtimes` (`026` + `031`): `asset_id` XOR `product_id`, `kind downtime_reason (maintenance|repair|missing)`, `status downtime_status (scheduled|started|ended|cancelled)`, `order_id`. Only `scheduled|started` reduce availability.
- `stock_levels` (`034`): PK `(product_id, location_id)` — **no `workspace_id`** (scoped via product FK). Replaces the dropped `products.stock_quantity`.
- `pricing_structures / pricing_tiers / pricing_rulesets / pricing_rules` (`034`): full server-side pricing engine. `pricing_tiers` / `pricing_rules` have **no `workspace_id`** (scoped via parent FK).
- `locations` (`024`): per-workspace, `is_default` (partial-unique one-default-per-workspace).
- `tags` / `tag_assignments` (`026`): `tag_assignments.entity_type IN (product|person|order)`, polymorphic `entity_id` (**no FK** — intentional).

**Designs need:** No inventory design substrate was provided this pass (sprint-1 shipped People). Inventory schema is the most mature in the codebase and needs nothing for the People rollout.

**Gap:**
- ✅ **No missing tables for current slices.**
- **Deferred rollout slice (Slice 10) → MISSING:** a **maintenance job ledger** — `product_downtimes` blocks availability for a repair window, but there is **no record of the job itself** (what was done, parts consumed, labor cost, vendor, cost recovery). See Section B Slice 10: `maintenance_jobs`, `maintenance_job_events`, `maintenance_parts`, `maintenance_labor`. `product_downtimes.order_id` + `kind='repair'` is the hook these will link to.
- **Unused-column review:** `products.specifications jsonb` and `assets.serial_number` / `assets.purchase_source` are lightly used — keep (no action).

---

## A3 · People / Customers — **THE PRIMARY GAP DOMAIN**

**Existing tables:** `people`, `person_roles`, `person_communications`.

Key facts (only **3 migrations** ever touched this domain — `003`, `013`, and `034`'s deposit-override columns):
- `people` (`003`): `display_name, phone (UNIQUE per ws), phone_verified_at, email, id_proof_type, id_proof_number, address_line, city, state, postal_code, country_code, company_name, gstin, notes, created_by, created_at, updated_at, deleted_at`.
- `people` (`007`): `default_gst_state`.
- `people` (`013`): `tier text CHECK (tier IN ('normal','premium','vip'))`, `trust_score int (0-100)`, `trust_score_updated_at`, `billing_address text`, `shipping_address text`.
- `people` (`034`): `state_code`, `deposit_method_override`, `deposit_value_paise`, `deposit_percentage_bps`.
- `person_roles` (`003`): PK `(person_id, role)`, `role person_role (customer|staff|investor|vendor)`, `is_active`.
- `person_communications` (`013`): `channel (call|whatsapp|email|other)`, `direction (in|out)`, `notes`, `occurred_at`, `logged_by_user_id`. Not immutable (5-min correction window).

### What the design substrate needs (from `people_list_dc.html` + `person_360_dc.html`)

**People list columns/filters:** Customer, Segment (VIP/New/Repeat/Dormant/At Risk/Blocked), Trust, Rentals+last, LTV, Outstanding, KYC (Verified/Pending), Next Action. Filter chips: All Active, VIP, New, Repeat, At Risk, Outstanding Payment, Pending KYC, Blocked. Search by name/phone/email/GSTIN/company.

**Person 360 sections:** Identity & Contact (incl. **Language**, multiple **Delivery Addresses** with default + distance, **Notification Preferences** WA/Email/SMS), **KYC & Trust** (verified date + by whom, **document viewers** Aadhaar/PAN/GST-cert, **trust breakdown sub-scores** + 12-mo trend), Relationship Summary (LTV/rentals/AOV/cancellation-rate), Rental History, Payment Behavior (method split, reliability, avg delay, **Credit Limit**, outstanding), Deposits & Forfeits, Communication, Notes (threaded, @mentions), Open Items, Recommendations (RESERVED). Metadata sidebar: Segment, **Source**, **Referred by**, Tags, **Branch**, Created, Last activity.

### Gap — MISSING COLUMNS on `people` (→ ALTER, hard-rule 2)

| Field (design) | Column proposal | Notes |
|---|---|---|
| Language ("English / Hindi") | `people.language text` | Identity card; freeform or CSV. |
| Credit Limit (₹50,000, editable) | `people.credit_limit_paise bigint` | Payment Behavior card. Paise, nullable = "no limit set". |
| Source ("WhatsApp inbound") | `people.source text` | Metadata sidebar. |
| Referred by ("Studio 8 Films") | `people.referred_by_person_id uuid REFERENCES people(id)` | Metadata sidebar; self-FK. |
| Branch ("Vadodara HQ") | `people.home_location_id uuid REFERENCES locations(id)` | Metadata sidebar; ties customer to a `locations` row (`024`). |
| Blocked segment + "View Reason" | `people.is_blocked boolean NOT NULL DEFAULT false`, `people.blocked_reason text`, `people.blocked_at timestamptz` | Blocked chip/row. **Must be stored** — it's an operator decision, not derivable. |
| KYC status (Verified/Pending) | `people.kyc_status text CHECK (kyc_status IN ('unverified','pending','verified','rejected'))` | List KYC column + Pending-KYC filter. **Stored** review state. `phone_verified_at` exists but is OTP-only, not KYC. |
| Notification prefs (WA/Email/SMS on/off) | `people.notification_preferences jsonb NOT NULL DEFAULT '{}'` | Identity card toggles. JSONB keeps it flexible; a table is overkill for 3 booleans. |

→ **Group these into 2 ALTER migrations** (e.g. one "people enrichment" for language/source/referral/branch/credit-limit, one "people risk & KYC status" for is_blocked/blocked_*/kyc_status/notification_preferences), each with the data-safe defaults above. All additive, none needs a data-fix-before-constraint (all nullable or defaulted) — but see Section C for the CHECK discipline.

### Gap — MISSING TABLES (People domain)

1. **`person_addresses`** — the design shows **multiple delivery addresses** per person (label "Sayajigunj Studio", `DEFAULT` flag, distance "7 km"). Today `people` has only single-text `billing_address` / `shipping_address` (`013`) + the structured `address_line/city/state/...` (`003`). **Proposal:** `person_addresses (id, workspace_id, person_id, label, address_line1/2, city, state, postal_code, country_code, is_default, distance_km numeric, created_at, deleted_at)`, partial-unique one-default-per-person. Migration `055_person_addresses.sql`.
2. **`kyc_documents`** — Identity/KYC card shows **document viewers** (Aadhaar, PAN, GST cert) with view links + a verified-by/verified-at. Today `people.id_proof_type/number` is text-only (no file, no per-doc verification). **Proposal:** `kyc_documents (id, workspace_id, person_id, doc_type CHECK (aadhaar|pan|gst_certificate|driving_license|passport|other), doc_number, file_url, status CHECK (pending|verified|rejected), verified_by_user_id, verified_at, uploaded_at, notes, deleted_at)`. Migration `056_kyc_documents.sql` (Slice 8).
3. **`kyc_review_events`** *(optional but recommended)* — append-only audit of KYC state changes (submitted → verified/rejected → resubmitted), so the "Verified Nov 12 2024 by Aamir" line and rejection history are first-class. Convention-appendable (like `order_events`). Migration `057_kyc_review_events.sql` (Slice 8).

### Gap — COMPUTED / DERIVED (do **not** add columns — hard-rule 3)

All of these are derivable from existing tables; **verify the calc source exists** (it does):
- **LTV, Total Rentals, Avg Order Value, Outstanding, last-rental date** → `SUM/COUNT` over `orders` + `order_items` + `payments` (all present).
- **Cancellation rate** → `order_cancellations` (`042`) / total orders.
- **Segment: New / Repeat / Dormant / At Risk** → computed from order recency + count (same pattern analytics already uses in `src/lib/analytics.ts`). **VIP** = `people.tier='vip'` (exists). **Blocked** = the new `is_blocked` column above.
- **Trust sub-scores** (Payment reliability, Return timeliness, Damage rate, Communication) + 12-mo trend → **computable** from `payments` (delay), `order_items.returned_at` vs `orders.rental_end` (timeliness), `damage_incidents` (`048`) (damage rate), `person_communications` (`013`) (communication). **Recommendation: compute, do not store.** The single `people.trust_score` int (`013`) can remain the cached headline; the breakdown is a read-time calc. **Do NOT add 4 sub-score columns.** *(If a trend sparkline needs historical points beyond the single `trust_score_updated_at`, that's the only case for a small `trust_score_history` table — flagged optional in Section B.)*
- **Payment method split, reliability %, avg delay** → aggregate `payments` (has `payment_method`, timestamps).
- **Deposits held / forfeits / disputes** → `payments` where `payment_kind IN ('deposit','deposit_refund','deposit_forfeit')` (`019`). Present.
- **Open Items** (active order, open damage, deposit hold, recovery) → live joins across `orders`, `damage_incidents`, deposit-kind `payments`. Present.
- **Next Action** (Start Quote / Collect Payment / Complete KYC / Follow Up / View Reason) → pure UI logic over the computed state above.

### Unused-column review (People)
- `people.billing_address` / `people.shipping_address` (single-text, `013`) become **partially redundant** once `person_addresses` exists. **Do not drop** — keep for back-compat and simple B2C; treat `person_addresses` as the multi-address superset. Flag for a later consolidation decision, not this rollout.

### Notes-with-@mentions (design section h)
The 360 Notes panel shows **threaded, authored notes with @mentions**. Today `people.notes` is a single `text` blob. **Proposal (optional):** a `person_notes` table (`id, workspace_id, person_id, author_user_id, body, mentions uuid[], created_at, deleted_at`). Low priority — can ship after the core People pages. Flagged optional in Section B.

---

## A4 · Orders (spine)

**Existing tables:** `orders`, `order_items`, `order_events`, `order_assets`, `order_contracts`, `order_extensions`, `order_cancellations`, `standbys`, `quote_versions`, `substitutions`.

Key facts (extensively mature):
- `orders` (`004` + many): `status order_status` — `draft|quoted|confirmed|dispatched|active|returned|closed|cancelled` + `standby|standby_expired|standby_released` (`044`, **transaction-hostile**). `gst_state` (`007`), `deposit_required_paise`/`deposit_status` (`019`), `pickup_location_id`/`return_location_id` (`024`), `accepted_quote_version_id`/`active_quote_version_id` (`045`).
- `order_items` (`004` + …): `item_type order_item_type (rental|delivery_fee|late_fee|damage|discount|tax|deposit|other)`, `status order_item_status` — 7 values + `substituted_out` (`047`, **transaction-hostile**), `chargeable_paise`, `cgst/sgst/igst_paise` (`007`), `dispatched_at`/`returned_at`/`condition_notes` (`006`), `price_override_label` (`033`), `is_soft_reserved`/`soft_reserved_standby_id` (`044`).
- `order_events` (`004`): append-only timeline (immutable by convention).
- `order_assets` (`004`): physical-unit assignment at dispatch. `order_asset_status (allocated|dispatched|returned|damaged|lost)`.
- `order_contracts` (`020`): **dispatch signature capture** — `signature_png`, `signer_name`, `signer_role (customer|representative|unsigned)`, `contract_text_snapshot`. **This already covers "signature at dispatch."**
- `order_extensions` (`041`), `order_cancellations` (`042`, `reason_tag` 12-value CHECK), `standbys` (`044`), `quote_versions` (`045`, `status` 8-value CHECK), `substitutions` (`046`, 6 CHECK vocabularies).

**Designs need:** the People 360 "Open Items / Rental History / Partially Dispatched 3/5" all read from this spine — **fully backed**.

**Gap — deferred rollout slices (Slice 4):**
- **`dispatch_photos` — MISSING.** No table stores handover photos at dispatch/return. `order_contracts` covers signatures, not photos. **Proposal:** `dispatch_photos (id, workspace_id, order_id, order_event_id, phase CHECK (dispatch|return), photo_url, caption, taken_by_user_id, created_at)`. Migration `058` (Slice 4).
- **`dispatch_otp_verifications` — MISSING.** `otp_handover` is a documented feature flag with **no backing table**; CLAUDE.md explicitly defers "OTP handover (mechanism + null adapter)." **Proposal:** `dispatch_otp_verifications (id, workspace_id, order_id, phase, phone, otp_hash, status CHECK (sent|verified|expired|failed), sent_at, verified_at, attempts)`. Migration `059` (Slice 4).
- **Return inspection** — currently modeled via `order_items.status` (`returned|returned_with_damage|...`) + `condition_notes` + auto-created `product_downtimes`. This is **intentional (not a gap)** per CLAUDE.md's physical-object model. A dedicated `inspection_events` table is **optional** (flagged in Section B) only if the design later needs per-line inspection checklists beyond status + notes.

---

## A5 · Payments & Invoices

**Existing tables:** `payments`, `invoices`, `invoice_reminders`.

Key facts:
- `payments` (`004` + `019`): `payment_method`, `payment_direction`, `payment_status`, `payment_kind (rental|deposit|deposit_refund|deposit_forfeit)`. **No `deleted_at`** — hard deletes within a 5-min window (intentional).
- `invoices` (`004` + `007` + `008` + `021`): immutable `snapshot jsonb` (line items live here — **no `invoice_items` table by design**), `cgst/sgst/igst_paise`, `gst_state`, `supersedes_invoice_id` (revisions), `customer_id`, `discount_paise`, `paid_paise`, `balance_paise`, **`pdf_url`** (`008` — see reconciled false-negatives), `due_date` (`021`).
- `invoice_reminders` (`021`): per-send log.

**Designs need:** People 360 "Payment Behavior" + "Outstanding" + "Deposits & Forfeits" all aggregate these — **backed**.

**Gap — deferred rollout slice (Slice 7): financial reconciliation. MISSING:**
1. **`bank_statement_lines`** — imported bank/UPI statement rows to reconcile against `payments`. **Proposal:** `bank_statement_lines (id, workspace_id, statement_date, value_date, amount_paise, direction, description, counterparty, reference, raw jsonb, imported_at, matched_payment_id uuid REFERENCES payments(id), match_status CHECK (unmatched|matched|ignored))`. Migration `060` (Slice 7).
2. **`payment_reconciliation_matches`** *(optional if match is 1:1 on the line above)* — an explicit N:M match ledger if one payment maps to multiple statement lines (split settlements). **Proposal:** `payment_reconciliation_matches (id, workspace_id, payment_id, bank_statement_line_id, amount_paise, matched_by_user_id, matched_at)`. Migration `061` (Slice 7). Start with the FK on `bank_statement_lines` and only add this if split-matching is needed.

---

## A6 · Damage & Insurance

**Existing tables:** `damage_incidents`, `damage_incident_assets`, `damage_incident_events`, `insurance_claims`.

Key facts:
- `damage_incidents` (`048`): many CHECK vocabularies; **no photo columns by design**; `insurance_claim_id` (plain uuid in `048`, promoted to FK in `054`).
- `damage_incident_assets` (`049`), `damage_incident_events` (`050`, **append-only by CONVENTION only — no trigger**), `insurance_claims` (`054`, `status` CHECK `draft|submitted|under_review|approved|rejected|paid|closed`).

**Designs need:** People 360 "damage rate" sub-score + "No open damage" open-item — computed from these. Backed.

**Gap:**
- **Damage evidence photos** — `damage_incidents` deliberately has no photo columns. The `damage_module` flag + the `dispatch_photos` table proposed in A4/Slice 4 can serve return-damage evidence too (with `phase='return'`), OR a dedicated `damage_incident_photos`. **Recommendation:** reuse `dispatch_photos` (link via `order_id` + a nullable `damage_incident_id`) rather than a new table. Flag as a Slice-4 design decision, not a separate migration.
- Otherwise ✅ **complete** for the current rollout.

---

## A7 · Notifications & Integrations

**Existing tables:** `notifications`, `notification_deliveries`, `notification_templates`, `workspace_integrations`.

Key facts:
- `notification_deliveries` (`016` + `043`): `channel (in_product|whatsapp|email|sms)`, `status (pending|sent|failed|skipped)`, `provider_ref`, `retry_count`.
- `workspace_integrations` (`017`): `category CHECK (payment|whatsapp|email)`, `credentials_encrypted bytea`, one-active-per-category partial-unique.

**Designs need:** People 360 "Notification Preferences" toggles + "WhatsApp/Call" actions. The **per-customer** preference is the new `people.notification_preferences` JSONB (A3). The **delivery pipe** is fully backed.

**Gap:** ✅ **None** beyond the `people.notification_preferences` column already listed in A3.

---

## A8 · Custom fields, coupons, idempotency, approvals

**Existing tables:** `custom_field_definitions`, `custom_field_values`, `coupons`, `coupon_redemptions`, `idempotency_records` (`039`), `approval_requests` (`040`, `status CHECK pending|approved|rejected|expired|withdrawn`, `approver_role CHECK manager|owner`).

**Designs need:** custom fields already integrate with `people` GET/PATCH (per CLAUDE.md 6g). Backed.

**Gap:** ✅ **None.** `custom_field_values.entity_id` / `tag_assignments.entity_id` are polymorphic with **no FK** (intentional — see Section C).

---

# SECTION B — Prioritized migration queue

Ordered by **dependency** then **rollout slice**. Filenames continue from `054`. Grouping rationale is in Section D.

| # | Proposed migration | Domain / Slice | Type | Depends on | Priority |
|---|---|---|---|---|---|
| `055` | `055_people_enrichment.sql` — ADD `people.language`, `source`, `referred_by_person_id` (self-FK), `home_location_id` (→`locations`), `credit_limit_paise` | People / **Slice 1 (People pages)** | ALTER | `024` (locations) | **P0** |
| `056` | `056_people_risk_kyc_status.sql` — ADD `people.is_blocked`, `blocked_reason`, `blocked_at`, `kyc_status` (CHECK), `notification_preferences jsonb` | People / **Slice 1** | ALTER | — | **P0** |
| `057` | `057_person_addresses.sql` — new table (multi delivery address, default flag, distance) | People / **Slice 1** | TABLE | `001` | **P0** |
| `058` | `058_kyc_documents.sql` — new table (per-doc file + verification) | People / **Slice 8 (KYC)** | TABLE | `001` | **P1** |
| `059` | `059_kyc_review_events.sql` — append-only KYC state log | People / **Slice 8** | TABLE | `058` | **P1 (optional)** |
| `060` | `060_dispatch_photos.sql` — handover photos (dispatch+return; nullable `damage_incident_id`) | Orders / **Slice 4** | TABLE | `004`,`048` | **P1** |
| `061` | `061_dispatch_otp_verifications.sql` — OTP handover backing (fills the `otp_handover` flag) | Orders / **Slice 4** | TABLE | `004` | **P2** |
| `062` | `062_bank_statement_lines.sql` — imported statement rows + `matched_payment_id` | Payments / **Slice 7 (reconciliation)** | TABLE | `004` (payments) | **P2** |
| `063` | `063_payment_reconciliation_matches.sql` — N:M split-match ledger *(only if 1:1 FK insufficient)* | Payments / **Slice 7** | TABLE | `062` | **P3 (optional)** |
| `064` | `064_maintenance_jobs.sql` — job header (links `product_downtimes.order_id`/repair) | Inventory / **Slice 10 (maintenance)** | TABLE | `002`,`026`/`031` | **P2** |
| `065` | `065_maintenance_job_events.sql` — append-only job lifecycle | Inventory / **Slice 10** | TABLE | `064` | **P2** |
| `066` | `066_maintenance_parts.sql` + `067_maintenance_labor.sql` — parts consumed + labor entries (cost recovery) | Inventory / **Slice 10** | TABLE | `064` | **P3** |
| `068` | `068_person_notes.sql` — threaded authored notes w/ @mentions *(supersedes single `people.notes`)* | People / enhancement | TABLE | `001` | **P3 (optional)** |
| `069` | `069_trust_score_history.sql` — snapshot points for the 12-mo trend *(ONLY if trend can't be derived)* | People / analytics | TABLE | `013` | **P3 (optional, likely unnecessary — prefer computing)** |

**Slice sequence hint alignment:** Slice 1 = `055`–`057` (People pages, the immediate rollout). Slice 4 = `060`–`061` (dispatch photos/OTP/signature — signature already done via `order_contracts`). Slice 7 = `062`–`063` (bank statement lines). Slice 8 = `058`–`059` (KYC). Slice 10 = `064`–`067` (maintenance jobs).

**Firm missing tables (11):** `person_addresses`, `kyc_documents`, `kyc_review_events`, `dispatch_photos`, `dispatch_otp_verifications`, `bank_statement_lines`, `payment_reconciliation_matches`, `maintenance_jobs`, `maintenance_job_events`, `maintenance_parts`, `maintenance_labor`.
**Optional/deferrable (3):** `person_notes`, `trust_score_history`, `inspection_events`.

---

# SECTION C — Data integrity observations

Systemic patterns worth a decision **before** the new migrations land, so the new tables match house style (or deliberately don't).

### C1 · `workspace_id` — mostly disciplined, three deliberate exceptions
Every operational table carries `workspace_id uuid NOT NULL REFERENCES workspaces(id)` **except three**, all scoped via a parent FK (intentional, not a bug):
- `stock_levels` (PK `product_id, location_id`) — scoped through `products`.
- `pricing_tiers`, `pricing_rules` — scoped through `pricing_structures`/`pricing_rulesets`.

**→ For the new tables:** `person_addresses`, `kyc_documents`, `dispatch_photos`, `bank_statement_lines`, `maintenance_jobs` etc. are **top-level** → **give them `workspace_id NOT NULL` as column 2** (house rule). Only child/junction tables (`kyc_review_events`, `maintenance_job_events`, `payment_reconciliation_matches`) may scope through their parent — but even then, carrying `workspace_id` explicitly matches the majority pattern and simplifies the mandatory `workspace_id`-filtered queries. **Recommendation: carry `workspace_id` on every new table**, including children.

### C2 · `deleted_at` — a hard split by era
**No table created after `001`–`003` has a `deleted_at`** except where it came from the early inventory/people era. Later tables soft-delete via **domain flags** (`is_active`, `revoked_at`, `removed_at`, `status='cancelled'`) or are **hard-deleted within a correction window** (`payments`, assignments). `payments` deliberately has **no `deleted_at`**.
**→ For new tables:** follow the modern convention — `person_addresses`/`kyc_documents` want `deleted_at` (customer data, recoverable); event logs (`kyc_review_events`, `maintenance_job_events`) want **no** `deleted_at` (append-only). Match intent, don't blanket-add.

### C3 · Append-only tables — trigger vs. convention (inconsistency to note)
- **Trigger-enforced immutability:** only `audit_events` (`001`, `prevent_audit_mutation`).
- **Convention-only (NO trigger):** `order_events`, `damage_incident_events` (`050`) — documented as append-only but **nothing at the DB layer stops an UPDATE/DELETE**.
**→ Decision for new event tables** (`kyc_review_events`, `maintenance_job_events`): either add the `prevent_*_mutation` trigger (strict, matches `audit_events`) or accept the convention-only pattern (matches `order_events`). **Recommendation: convention-only for consistency with the order-side event tables**, unless KYC compliance demands hard immutability — in which case, add the trigger.

### C4 · FK cascade / polymorphic references
- **Polymorphic, no FK (intentional):** `custom_field_values.entity_id`, `tag_assignments.entity_id` (entity_type discriminant, can't FK to multiple tables). The Neon driver + app enforce integrity. **Do not "fix"** — it's a known trade-off.
- **`ON DELETE` review:** most FKs are `CASCADE` (workspace) or `RESTRICT` (assets→products). New self-FK `people.referred_by_person_id` should be **`ON DELETE SET NULL`** (a referrer being deleted must not cascade-delete referred customers). `dispatch_photos.order_id` → `CASCADE`; `bank_statement_lines.matched_payment_id` → **`SET NULL`** (deleting a payment shouldn't delete the imported bank line).

### C5 · Missing FK indexes (perf, not correctness)
New FK columns that will be **filtered/joined hot** need a supporting index in the same migration:
- `person_addresses(person_id)`, `kyc_documents(person_id)`, `dispatch_photos(order_id)`, `bank_statement_lines(matched_payment_id) WHERE match_status='matched'`, `maintenance_jobs(asset_id)`.
- `people.referred_by_person_id` (for "who did X refer") and `people.home_location_id` (branch filter) — index both if the list page filters on them.
Existing tables already index their hot FKs well (assets, order_items, downtimes) — **match that discipline**.

### C6 · Missing CHECKs / enum vocabularies to define on new tables
Every status-like column must ship its CHECK **in the same migration**, and (hard-won lesson, CLAUDE.md → Migration discipline) **any `ADD CONSTRAINT` on an existing table must be preceded by the data-fix that satisfies it**. The new tables are green-field so their CHECKs are safe, but the People **ALTERs** add `kyc_status` — ship it as a **column default that already satisfies the CHECK** (`DEFAULT 'unverified'`) so no existing `people` row violates it. Vocabularies to lock: `kyc_status (unverified|pending|verified|rejected)`, `kyc_documents.doc_type` + `.status`, `dispatch_photos.phase (dispatch|return)`, `dispatch_otp_verifications.status`, `bank_statement_lines.match_status`, `maintenance_jobs.status`.

### C7 · `created_at` / `updated_at`
Most tables have `created_at`; `updated_at` (+ `bump_updated_at` trigger) exists on `products`, `assets`, `people`, `standbys`. **→ New mutable tables** (`person_addresses`, `kyc_documents`, `maintenance_jobs`) should get **both** + the existing `bump_updated_at` trigger (it's reusable — defined in `002`). Event/log tables: `created_at` only.

### C8 · Audit-event coverage
CLAUDE.md mandates every mutation writes an `audit_events` row. The **new endpoints** (address CRUD, KYC upload/verify, block/unblock, maintenance jobs) must each audit — schema already supports it (`audit_events` is generic). No schema change; a **build-time checklist item**, flagged here so it isn't forgotten.

---

# SECTION D — PR batching strategy

Which migrations ship together vs. independently, and why.

### Batch 1 — **People foundation** (ship together, one PR): `055` + `056` + `057`
The three People migrations back **Slice 1 (the People list + 360 pages)**, which is the active rollout. They're all additive, all low-risk (nullable/defaulted columns + one green-field table), and the frontend needs all three at once (the 360 page renders addresses, KYC status, block state, credit limit, referral in a single view). Shipping them separately would leave the page half-wired. **One PR: "People schema foundation (enrichment + risk/KYC status + addresses)."**

### Batch 2 — **KYC documents** (independent PR): `058` (+ `059` if adopted)
KYC document upload/verify is a **self-contained feature** (Slice 8) with its own UI surface (the KYC & Trust card's document viewers). It depends on Batch 1's `kyc_status` column but is otherwise isolated. Ship after Batch 1 merges. `059_kyc_review_events` rides in the same PR **only if** the immutable-history decision (C3) is made; otherwise defer.

### Batch 3 — **Dispatch photos/OTP** (independent PR): `060` (+ `061`)
Slice 4. `060_dispatch_photos` is useful on its own (handover + damage evidence) and should ship first; `061_dispatch_otp_verifications` is gated behind the `otp_handover` flag and can ship in the **same PR or a follow-up** — keep them together since both touch the dispatch/return flow and the same order-event batch.

### Batch 4 — **Bank reconciliation** (independent PR): `062` (+ `063`)
Slice 7, entirely finance-domain, no dependency on People/Orders slices. Ship `062` (statement lines + 1:1 match) alone; add `063` (N:M split-match) **only if** reconciliation testing shows 1:1 is insufficient — don't build it speculatively.

### Batch 5 — **Maintenance jobs** (independent PR, largest): `064` + `065` (+ `066`/`067`)
Slice 10. `064_maintenance_jobs` + `065_maintenance_job_events` are the core and ship together (header + lifecycle). `066_maintenance_parts` / `067_maintenance_labor` (cost-recovery detail) are a **follow-up PR** — the job header is usable without the parts/labor ledger. This is the one slice where I'd split within the slice.

### Independent / deferred (own PRs, when prioritized)
- `068_person_notes` — optional People enhancement; ship whenever the threaded-notes UI is built.
- `069_trust_score_history` — **likely never needed** (prefer computing the trend). Only if a real requirement to snapshot appears.

### Cross-cutting rules for **every** batch
1. **No `ADD CONSTRAINT` without the preceding data-fix in the same migration** (CLAUDE.md; the `034` production incident). The People ALTERs avoid this by defaulting to constraint-satisfying values.
2. **Each migration is one transaction** (the runner wraps it) — none of the proposed migrations need `ALTER TYPE ADD VALUE` or `CREATE INDEX CONCURRENTLY`, so **none are transaction-hostile** (unlike `032`/`044`/`047`). All can run in the normal atomic path.
3. **`workspace_id` + audit** on every new table/endpoint (Section C1, C8).

---

## Appendix — full existing-table inventory (51 operational)

`approval_requests`, `assets`, `audit_events`, `coupon_redemptions`, `coupons`, `custom_field_definitions`, `custom_field_values`, `damage_incident_assets`, `damage_incident_events`, `damage_incidents`, `idempotency_records`, `insurance_claims`, `invitations`, `invoice_reminders`, `invoices`, `locations`, `login_attempts`, `notification_deliveries`, `notification_templates`, `notifications`, `order_assets`, `order_cancellations`, `order_contracts`, `order_events`, `order_extensions`, `order_items`, `orders`, `password_reset_tokens`, `payments`, `people`, `person_communications`, `person_roles`, `pricing_rules`, `pricing_rulesets`, `pricing_structures`, `pricing_tiers`, `product_downtimes`, `product_kit_items`, `product_recommendations`, `products`, `quote_versions`, `sessions`, `standbys`, `stock_levels`, `substitutions`, `tag_assignments`, `tags`, `users`, `workspace_integrations`, `workspace_memberships`, `workspaces` *(+ `schema_migrations` ledger)*.

**Transaction-hostile migrations on record** (must stay individually idempotent): `032` (`ALTER TYPE membership_status ADD VALUE 'deactivated'`), `044` (`order_status` ×3 standby values), `047` (`order_item_status ADD VALUE 'substituted_out'`). None of the proposed `055`–`069` are transaction-hostile.
