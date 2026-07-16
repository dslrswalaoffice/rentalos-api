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

---

## TD-2 — `normalizeSettings` is an allow-list that silently drops unknown keys

**Status:** open · logged 2026-07-15 (Sub-slice 2.2 hotfix, PR #79) · low-risk with the current mitigation; revisit if settings keys keep growing.

**What.** `normalizeSettings()` in `src/routes/workspace.ts` (used by `GET /api/workspace` and the settings PATCH response) rebuilds a *fresh* object from a fixed allow-list of keys. Any `workspace.settings` key not explicitly copied is **dropped from the response** — even though the PATCH persists it to the JSONB and Neon shows it saved.

**Why it bit us.** The six order-policy objects (`extension_policy`, `cancellation_policy`, `approval_routing`, `notification_policy`, `standby_policy`, `quote_policy`) were **not** in the allow-list. So a saved `standby_policy.default_hold_duration_minutes = 180` could never be read back: the New Order Composer read `settings.standby_policy === undefined` and fell through to its hardcoded fallback (240). The Settings → Order Policies page appeared to work only because it kept local form state after a save and rarely re-fetched.

**Fix applied.** Added `ORDER_POLICY_SETTINGS_KEYS` — a single list that drives BOTH the GET passthrough (in `normalizeSettings`) and the PATCH merge (`ORDER_POLICY_KEYS` now aliases it) so a saved policy is always readable back. Guarded by `test/workspace_settings_roundtrip.test.ts`.

**Residual debt.** The allow-list pattern remains: **any future `settings.*` key must be added to `normalizeSettings` (and its round-trip test) or it will silently vanish on read.** This is a foot-gun for every new configurable feature.

**How to reconcile.** Either (a) switch `normalizeSettings` to *merge onto* the raw settings (fill defaults for known keys, pass everything else through) instead of rebuilding from scratch — so unknown keys survive by default; or (b) keep the allow-list but add a CI test that fails when a key present in the PATCH schema is absent from the GET passthrough. (b) is cheaper; (a) removes the foot-gun entirely.

**Blast radius if ignored.** Every new workspace-configurable setting is a chance to reintroduce the exact "saved but not readable → UI shows a hardcoded default" bug. Rule D (configurability test) catches it per-feature, but only if the author writes the test.

---

## TD-3 — Internal/transactional events have no email templates (silently skipped)

**Status:** open · logged 2026-07-16 (Sub-slice 2.2, PR #81) · low priority — not blocking; fold into a template-seeding sub-slice.

**What.** Several events fire correctly and create `notification_deliveries` rows, but with `status='skipped', error_message='no_template'` for the email channel, because no template is seeded under `settings.notification_policy.templates.<event>`:
- `quote_accepted_internal` (staff notification)
- `order.created`
- `extension_pending_approval` (approver notification)

So internal staff (e.g. Shoaib) don't get the emails they should when a quote is accepted, an order is created, or an approval is pending. In-product notifications for these still work; only their **email** channel is skipped.

**Not a code bug** — the pipeline behaves correctly (skip + record when no template). It's a **workspace-configuration gap**: templates were only seeded for customer-facing events (`quote_sent`, `quote_reminder`, `quote_expiring`, `quote_accepted`, `standby_expiring`, `standby_expired`) and the 2.1 order events, not for these internal ones.

**How to reconcile.** In a template-seeding sub-slice, add default email templates for the internal events above under `notification_policy.templates`, using the internal merge-field vocabulary (`order_number`, `quote_number`, `customer_name`, `total_amount`, `link_url`). Guard with the merge-field completeness audit (Rule C) so every referenced token is supplied by the emit site.

**Blast radius if ignored.** Internal staff miss email notifications (they still see in-product). No customer impact, no data loss. Distinct from the `quote_sent` bug (PR #81), which was a code bug (un-awaited emit) — a missing template writes a *skipped row*; the un-awaited emit wrote *no row at all*.

---

## TD-4 — Quote Revision UX is a stub (prompt, no chain viz, no content editing)

**Status:** open · logged 2026-07-16 (Sub-slice 2.2, Test 4) · **UX gaps, not workflow blockers** — backend supersession is verified correct end-to-end. Deferred to a dedicated design cycle; ship as a separate PR after Sub-slice 2.2 is closed. NOT blocking 2.2 verification or 2.3.

*(Numbered TD-4: the Test-4 note called this "TD-3", but TD-3 was already taken by the missing-internal-templates item from PR #81.)*

**Backend is correct (do not touch).** Real Neon data confirms a 4-version chain with `parent_version_id`, `superseded_at`, and `superseded_by_version_id` populated correctly on each transition. `createQuoteVersionFromOrder` + `sendQuoteVersion` supersession work as designed. These are purely front-end / product-surface gaps in `public/order-360.html`.

**Gap 1 — Revise is a `window.prompt()`, not a modal.** Clicking Revise on a quote version opens a native browser prompt with a single reason-tag text field prefilled `'customer_requested_change'` (Cancel/OK). Per the locked spec (Item 7 Quote Versioning + Item 16 Order 360 pattern) it should open a proper modal with: a **reason-tag dropdown** listing all 7 taxonomy options; an **optional revision-notes textarea**; a surface to **edit quote content** (line items, pricing, dates, discounts); and a **diff preview** (v(n) → v(n+1)) before commit.

**Gap 2 — the Quote Versions card doesn't visualize the revision chain.** Versions render as flat rows/tabs. It should show the hierarchical chain (v1 → v2 → v3 → v4) with parent→child relationships and superseded status made visible.

**Gap 3 — no content modification between versions (the functional consequence of Gap 1).** Because the prompt gives no edit surface, Revise → OK creates v(n+1) as an *identical copy* of v(n) with only a new reason tag. The revision workflow captures a reason but can't change what the customer sees — so it's currently useless in practice. (Backend supports content changes via `createQuoteVersionFromOrder` re-snapshotting the order; the missing piece is a UI to modify the order/quote content before the revision snapshot.)

**How to reconcile.** Design pass first (no design substrate exists for the Revision modal yet), then implement: a Revise modal on `order-360.html` with reason-tag dropdown + notes + an editable line-item/pricing/dates surface + live diff preview; and a chain visualization in the Quote Versions card. Reuse the existing diff computation (`computeDiff` / `diff_from_parent`) for the preview. No backend change expected beyond possibly an endpoint to apply content edits as part of the revision.

**Blast radius if ignored.** Operators can create revisions but can't meaningfully change quote content through the UI (only the reason tag), and the version history is hard to read. No data loss, no customer-facing breakage on the paths that DO work (send/accept/track). Purely a workflow-usability gap.
