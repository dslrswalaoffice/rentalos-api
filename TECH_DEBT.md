# RentalOS — Tech Debt Register

Known, deliberate debt with a documented reconciliation path. Add an entry when
you ship a compatibility shim, a workaround, or a "leave it for now" decision —
so future work can find and retire it instead of rediscovering it as a bug.

Format per entry: **what**, **why it exists**, **where it lives**, **how to
reconcile**, **blast radius if ignored**.

---

## TD-1 — Order field-name convention drift (core vs Orders Module Pack)

**Status:** open · logged 2026-07-15 (Sub-slice 2.2 hotfix, PR #77) · reconcile in a later slice (3.x or a dedicated cleanup), no immediate action.

**What.** Two request-body naming conventions for the same concepts coexist in
the API:

| Concept | Core orders (older) | Orders Module Pack (2.1+) |
|---|---|---|
| Customer | `customer_person_id` | `customer_id` |
| Rental start | `rental_start` | `rental_start_at` |
| Rental end | `rental_end` | `rental_end_at` |
| Free-text note | `internal_notes` | `reason_notes` |

- **Core shape** is what every existing frontend page holds in state and sends to
  `POST /api/orders` / `PATCH /api/orders/:id`. It matches the `orders` table
  columns (`rental_start`, `rental_end`, `customer_person_id`).
- **Pack shape** is what the newer endpoints validate — it matches the newer
  tables' columns (`standbys.rental_start_at`, `standbys.customer_id`,
  `order_extensions.new_rental_end_at`, etc.).

**Why it exists.** The Pack tables were authored with `*_at` / `customer_id`
column names for clarity; their Zod schemas mirror the columns. But the shared
frontend state object (the New Order Composer) is built in the core shape for
`POST /api/orders`, so any Pack endpoint it calls from the same state is a
naming mismatch waiting to happen. It already bit us once:

- **`POST /api/standbys`** — the New Order Composer's Create Standby sent the
  core shape → HTTP 400 on every submit (production bug, PR #77).

**Where it lives / current mitigations.**
- `POST /api/orders/:id/extend` already accepts **both** `new_rental_end` and
  `new_rental_end_at` (an ad-hoc dual-accept — the first instance of this shim).
- `POST /api/standbys` now has an explicit **compatibility net**:
  `standbyCreateBodySchema` in `src/routes/standbys.ts` is a `z.preprocess`
  wrapper that maps the four core aliases onto the canonical keys before
  validating with the canonical `standbyCreateSchema` (canonical value wins if
  both are present). Covered by `test/standby_quote_contracts.test.ts`.
- The other Pack endpoints (`quote-versions` create/send/accept/withdraw,
  standby convert/release/extend, public tracking accept) take **no** customer/
  rental fields, so the drift does not reach them — no shim needed there.

**How to reconcile (future).** Pick ONE canonical request-body convention for the
API and converge:
1. Decide the winner. Recommendation: keep the core shape at the API boundary
   (`customer_person_id` / `rental_start` / `rental_end`) since it's what all
   existing clients speak and changing clients is riskier than changing the
   newer, less-used Pack schemas — OR commit to the Pack `*_at` shape everywhere
   and migrate the composer/state + `POST /api/orders`. Either is fine; pick one.
2. Update the losing side's Zod schemas (and the composer state if core loses).
3. Delete the compatibility shims: the `standbyCreateBodySchema` preprocess here
   and the `new_rental_end` dual-accept in the extend endpoint.
4. Keep the contract tests (`test/standby_quote_contracts.test.ts`) — retarget
   them at the unified shape.

**Blast radius if ignored.** Low and contained *today* (both shims accept both
shapes, so no live breakage), but every NEW Pack endpoint that takes a customer
or rental-window field is a fresh chance to reintroduce the 400 unless the author
either uses the canonical names or adds the same shim. The mitigation is the
process rule already adopted: every new endpoint ships a contract test that
parses the exact frontend payload through the endpoint's real Zod schema.
