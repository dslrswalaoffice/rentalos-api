# Module Audit — Orders · Inventory · People

## 1. Scope + limitations

- **Static code audit only.** The sandbox is **egress-blocked from production** — verified this session: `curl https://rentalos-api.vercel.app/api/health` → `403 CONNECT tunnel failed`. No runtime observations. Nothing here was clicked; findings are traced through source. Anything that needs a browser is marked **`NEEDS-HUMAN`** (§7).
- Reviewed: `public/{orders,order,new-order,inventory,people,person}.html`, `src/routes/{orders,inventory,people,availability,...}.ts`, `src/lib/{availability,pricing,analytics}.ts`, migrations. Commit `6d17b33`.
- Not flagged (intentional per CLAUDE.md): `json_agg`, COALESCE PATCH, paise-as-BIGINT, SHA-256 session tokens.

## 2. The verdict (one paragraph each)

- **Orders — can run the money loop, with two real holes.** Pricing, GST (CGST/SGST vs IGST), deposits, payments, invoices, coupons, discounts all compute from real data. **BUT: dispatch and return never assign or release specific asset units** (`order_assets` is unused; `asset.status` is never written anywhere in the codebase). Availability is *order-status-driven*, so it is internally consistent and **will not double-book** — but returning items does **not** free availability until the whole order reaches `closed`, and **tiered/half-day/weekend pricing do not exist** (only flat `daily_rate × days`). Orders works; it is less capable than the UI implies.
- **Inventory — the availability *engine* is correct; the inventory *table's* counts are not.** `available_units` / `rented_units` on every product row come from `assets.status`, which **nothing in the system ever updates** — so `rented_units` is **always 0** and `available_units` **always equals total**, even when every unit is out on an active rental. The booking flow reads the correct (order-driven) engine, so this is a *display* lie, not a booking bug — but it is the single most misleading number in the three modules. Cost/ROI (Sub-turn 11) and downtime-blocking are real. **No product detail page exists.**
- **People — clean.** Order history, payments, communications, tags, custom fields, tiers all read real API fields. Trust score is a real (nullable, manually-set) column, honestly shown as blank when unset. **No fabricated LTV** — it simply isn't rendered. This module is in good shape.

**The mocked-data sweep came back essentially clean** — the named mockup strings are gone (§3). The dangerous number is Inventory's status counts, not a hardcoded literal.

## 3. Mocked-data table (Part A) — LEAD SECTION

**A1 sweep result:** `grep` for every listed mock string (`8.42L, 3.20L, 94.58, 12,450, Trust 92, 4.82L, 47 orders, 8,860, 1.84L, 72%, 78%, #9204, #9198, Harshvardhan, Radhika Films, Nikhil Studios`) across `public/` → **ZERO matches.** The hardcoded mockup data has been replaced. This is the audit's most important positive finding.

**A4 cross-check (every stat tile → API field):**

| Page | Element | Displayed value | Real source | Verdict |
|---|---|---|---|---|
| inventory.html | `available_units` / `rented_units` per row | e.g. "4 available · 0 rented" | `assets.status` FILTER (`inventory.ts:162-164`) — **but `status` is never written** | 🟡 **MOCKED-in-effect** — always `available=total, rented=0` |
| inventory.html:~1224 | `₹6.99L / ₹1.2Cr` | (none — it's a **code comment** in `inrCompact`) | n/a | ✅ false positive |
| inventory.html | Idle capital tile | `₹X (no rental 90d)` | `/api/analytics/product-roi.idle_capital_paise` | ✅ WORKS |
| analytics.html | Return-on-capital rows | ROI/recovered/capital | `/api/analytics/product-roi` (real, Sub-turn 11) | ✅ WORKS |
| order.html | `Record ₹0 / Refund ₹0 / ₹0 preview` | `₹0` | form default, updated on input (`order.html:749,915,1034`) | ✅ placeholder, not a metric |
| dashboard.html | 6 command-center widgets | counts/₹ | `/api/dashboard` (computed, Sub-turn 5a) | ✅ WORKS |
| person.html | trust score | number or blank | `p.trust_score` DB column (`person.html:622`) | 🔵 real value, **manually set, not computed** |
| person.html | order history / payments | real rows | `GET /api/people/:id` → `orders`,`payments` (`people.ts:251`) | ✅ WORKS |
| people.html | list | names/roles/tiers | `/api/people` | ✅ WORKS |
| orders.html | list + totals | real | `/api/orders` (`total_paise`, `pagination`) | ✅ WORKS |

**Only one entry renders a wrong number as truth: Inventory `available_units`/`rented_units`.** Real source *would be* either (a) live `asset.status` if dispatch/return maintained it, or (b) derived from the order-driven availability engine. Neither is wired to the list. **Fix size: M.**

## 4. Findings by module

### Orders
- 🔵 **PARTIAL — dispatch/return do not track physical units.** `grep order_assets`, `grep "status = 'rented'"` across `src/routes/orders.ts` → **nothing writes them.** `order_assets` (the unit-allocation table) is unused; no unit is ever marked out. Availability stays correct because it's order-driven, but there is **no record of which unit went to which order**. `orders.ts` dispatch/return handlers (`orders.ts:2020` return). Fix: L.
- 🔵 **PARTIAL — return frees availability only at `closed`, not at item-return.** The reservation query counts `oi.quantity` for any order whose **order** status ∈ `{confirmed,dispatched,active,returned}` (`availability.ts:24-29, 249-276`) — it never inspects item status. A fully-returned order sitting in status `returned` still blocks its gear until someone closes it. Over-reserves (safe direction) but wrong. Fix: M.
- 🔵 **PARTIAL — no tiered / half-day / weekend pricing.** `src/lib/pricing.ts` reads **only** `daily_rate_paise` (`pricing.ts:361`); `weekly_rate`/`monthly_rate` columns exist but are **never read**; `grep -ri "half.?day|weekend|surcharge" src/` → **zero**. A 30-day rental bills `daily × 30`, ignoring `monthly_rate`. `billable_days` rounding itself is real (`pricing.ts:164-171`, `24_hour_windows` only; `calendar_day` unimplemented, `pricing.ts:25`). Fix: M–L.
- ⚠️ **UNSAFE — order mutations have no role gate.** `orders.ts` mounts `sessionMiddleware + requireAuth` only; ~13 POST/PATCH/DELETE handlers carry no `requireRole`. A member with role `client` or `investor` (both invitable, Sub-turn 10) can create/modify/dispatch/return/cancel orders. Staff *should* operate orders; client/investor should not. Fix: S.
- ✅ **WORKS — GST, deposits, payments, invoices, coupons, discounts** compute from real data and audit (`orders.ts` has 15 `audit()` calls).

### Inventory
- 🟡 **MOCKED-in-effect — `available_units`/`rented_units` are disconnected from reality** (see §3). `assets.status` is written **nowhere** (only read at `inventory.ts:162-164,245` and the delete-guard `:660`). Every product shows all units available, zero rented, regardless of live rentals. Fix: M.
- ⚠️ **UNSAFE — product delete guard is a no-op.** `inventory.ts:660` refuses delete when an asset is `status='rented'` — but no asset is ever `rented`, so **a product with units physically out on an active rental can be soft-deleted** without warning. Fix: S (depends on the status-tracking fix).
- 🔵 **PARTIAL — capacity ignores `asset.status`.** `checkAvailability` capacity = `COUNT(*) assets WHERE deleted_at IS NULL` (`availability.ts:210-217`); an `in_repair` unit still counts as capacity. (Downtimes are handled separately and *do* block — `has_downtime_conflict`, Sub-turn 8a, real.) Fix: S.
- ⛔ **MISSING — no product detail page.** Confirmed: no `public/product*.html`. Pricing/asset editing lives in the inventory edit modal + bulk-cost screen (Sub-turn 11). Not a bug, but the design brief's "product detail page" doesn't exist. Fix: L if wanted.
- ⛔ **MISSING — no serialized/bulk/infinite "tracking type" beyond tracked/bulk.** `tracking_mode ∈ {tracked,bulk}` only (migration 023); no `infinite`, no product `type` (rental/service/resource). D2.2's model doesn't exist. Fix: L.
- ✅ **WORKS — create product, bulk/tracked, cost/ROI, downtime scheduling, category autocomplete.**

### People
- ✅ **WORKS — create/edit customer, order history, payments, communications, custom fields, tags** — all real (`people.ts:251`).
- 🔵 **PARTIAL — trust score is stored, not computed.** Real nullable column (migration 013), set via `PATCH /people/:id/trust-score` (`people.ts:651`, gated `requireRole('owner','manager')`, audited). Honestly shows blank when unset — **not fabricated** — but the label may imply an algorithm that doesn't exist. Fix: n/a (accurate as-is) or L to compute.
- 🔵 **PARTIAL — no lifetime-value / KYC-document storage.** No LTV tile is rendered (absent, not faked — good). ID-proof is text-only (`people.id_proof_type/number`); no document/image storage. Fix: M–L if wanted.
- ✅ **WORKS — tiers** exist in schema + gated by `customer_tiers` flag and drive UI pills.

## 5. Cross-cutting (Part E)

- **E3 workspace scoping — no leak found in sampled queries; NOT exhaustively verified.** Every operational query I read filters `workspace_id` (codebase discipline is strong). I did **not** verify all ~170 references one-by-one; a dedicated per-query pass is **`NEEDS-HUMAN`/deeper review** (§7.6). No escalation — but "sampled clean" ≠ "proven clean."
- **E1 audit events** — good coverage (orders 15, people 9, inventory 12 `audit()` calls). No obvious mutation gap found in sampling.
- **E2 permissions** — financial/admin routes gated (`analytics.ts` mount `requireRole('owner','manager')`; asset cost, trust-score, product CRUD all gated). **Gap: order mutations ungated** (Orders §4). 
- **E4 error handling** — module pages use `api.*` which throws on non-2xx; most flows `try/catch` + toast. Spot-checked; a full "every fetch has a branch" pass is **`NEEDS-HUMAN`**.
- **E5 money** — paise/BIGINT throughout. No float money found. ✅
- **E6 loading states** — `₹0` payment/refund defaults are form placeholders, not pre-fetch fake metrics. No hardcoded metric renders before its fetch (skeletons used). ✅

## 6. Triage — ranked by "what breaks the business first"

1. **Inventory `available`/`rented` counts are fiction** (§3, §4). Highest because it's a *wrong number acted on* — staff reading "4 available" may promise gear that's out. (Booking flow itself is safe.) **M.**
2. **Return doesn't free availability until `closed`** (Orders §4). Gear sits blocked after physical return → lost bookings / manual DB nudges. **M.**
3. **Order mutations have no role gate** (Orders §4) — client/investor members can alter orders. **S.**
4. **Product delete guard is a no-op** — deletable while physically rented. **S.**
5. **No tiered/weekly/monthly pricing** — long rentals overbill vs. the stored tier. **M.**
6. **No physical unit tracking at dispatch** (`order_assets` unused) — no "which unit, which order." **L.**
7. **Capacity counts `in_repair` units** — minor over-availability. **S.**
8. Trust score not computed; no LTV/KYC storage — feature-completeness, not breakage. **L.**

## 7. NEEDS-HUMAN — test script for Aamir's team (production, logged in)

1. **Inventory count truth:** put a product's every unit onto an active order. Reload Inventory. Does the row still say "N available, 0 rented"? (Expected per code: yes — the bug.)
2. **Return → availability:** complete a rental, mark all items returned, but leave the order in `returned` (don't close). Try to book the same gear for overlapping dates in New Order. Is it blocked? (Expected: blocked until you Close the order.)
3. **Pricing tiers:** create a 30-day rental of a product with a `monthly_rate` set. Is the price `daily × 30`, or the monthly rate? (Expected: `daily × 30`.)
4. **Role enforcement:** as a `client`- or `investor`-role member, `curl -X POST /api/orders …`. Does it succeed? (Expected: yes — the gap.)
5. **Delete-while-rented:** dispatch a product's unit on an active order, then delete that product. Blocked? (Expected: not blocked.)
6. **Workspace scoping (deeper):** a security reviewer should read every `FROM orders/order_items/people/products/assets/payments/invoices` in `src/` and confirm each carries `workspace_id`. ~170 references — not done in this static pass.
7. **Every-fetch-has-error-branch:** click each control with the network throttled to offline; confirm a visible error, never a silent no-op.

## 8. What I could not determine

- Whether any query truly lacks `workspace_id` (sampled only — see 7.6).
- Runtime behaviour of any control (egress-blocked).
- Whether `asset.status='in_repair'` is settable via any UI (no status-change endpoint found; likely not, making all status counts permanently `available`).
- Whether the `returned`-status-blocks-availability behaviour is intended (CLAUDE.md says "`returned` still holds the gear until items are individually marked returned" — but the query keys on *order* status, not item status, so per-item return has no availability effect until close).

---
**Phase 1 complete. No code changed — this file is the only artifact. Awaiting approval to sequence Phase 2 from the §6 triage.**
