# RentalOS — Codebase Conventions

You are working on **RentalOS**, a rental management SaaS being built for **DSLRSWALA** (camera + AV rental in Vadodara, India) as the first workspace, with an eventual multi-tenant SaaS goal. This document is the source of truth for how this codebase is organised, what patterns to follow, and what mistakes to avoid.

**Read this file completely before every task.** Most bugs in this codebase have come from drifting away from these conventions.

---

## Standing Directive (per Jul 19 2026)
Every proposal must pre-check against 9 alignment gates in docs/RENTALOS_CONSTITUTION.md before implementation. New patterns require proof of failed reuse attempts.

---

## Product context documents

Three project documents shape RentalOS direction. Every task should acknowledge them:

- **rentalOS Project Instructions** — high-level product philosophy
- **from Claude Design File** — DSLRSWALA prototype UX/IA specification (source of truth for product shape)
- **Camera_RMS_Developer_Brief.docx + Addendum v2** — inspirational reference architecture from a Pune-based camera rental business

When they conflict:
- Design File wins for UX/IA
- Camera RMS Brief informs business logic where Design File is silent
- Everything from Camera RMS Brief is opt-in via `workspace.settings.features.*` flags, never hardcoded

---

## Product context

- **Founder:** Aamir Patel — systems thinker, non-technical, browser-first workflow (GitHub web UI, Vercel dashboard, Neon SQL editor, Chrome DevTools). No Terminal, no VS Code.
- **Team:** Shoaib, Ruhan, Irfan.
- **Vision:** Multi-tenant rental OS. Start with DSLRSWALA as workspace #1, then onboard other rental businesses.
- **Design philosophy:** Workflow before features. Simplicity over complexity. Operations before reporting. Prevent human error. Progressive disclosure. Inventory is the heart. Configuration over hardcoding. Mobile-first operations. API-first. AI-native. Modular monolith until scaling proves otherwise.

---

## Tech stack (locked in)

- **Database:** Neon Postgres, HTTP driver (`@neondatabase/serverless`). Region: Singapore. Project internal name: `wild-thunder-49107529`.
- **Backend:** Hono on Vercel serverless functions (Node runtime).
- **Frontend:** Static HTML + vanilla JS ES modules. No React, no build step.
- **Auth:** bcryptjs cost 12 for password hashing. Opaque session tokens in `HttpOnly`, `SameSite=Lax` cookies, SHA-256 hashed at rest. **No JWTs.**
- **Validation:** Zod on every request body.
- **Money:** integer paise (bigint in Postgres, number in TypeScript). Never floats.
- **Time:** `timestamptz` in Postgres, UTC over the wire, `Asia/Kolkata` for display. Workspace timezone lives in `workspaces.timezone`.
- **Deployment:** Vercel auto-deploys on `main` branch push. Migrations run at build time via `vercel-build` script → `tsx src/lib/migrate.ts`. Do NOT run migrations manually.

---

## Repo layout

```
/
├── api/
│   └── index.ts               # Vercel entry — named HTTP method exports (GET, POST, PATCH, PUT, DELETE, OPTIONS)
├── migrations/
│   ├── 001_init.sql           # Auth spine (7 tables)
│   ├── 002_inventory.sql      # Products + assets
│   ├── 003_people.sql         # People + person_roles
│   └── 004_orders.sql         # Orders + items + events + assets + payments + invoices
├── public/                    # Static HTML pages, served at /
│   ├── index.html             # Sign-in
│   ├── dashboard.html
│   ├── inventory.html
│   ├── people.html
│   ├── orders.html
│   ├── new-order.html
│   └── _lib/
│       └── api.js             # Client helper: api.get/post/patch/delete, ensureAuth, formatINR, rupeesToPaise
├── src/
│   ├── app.ts                 # Hono app assembly + route mounts. `export const app = new Hono()`.
│   ├── db.ts                  # Exports `sql` (tagged template) and `query<T>(...)`. **NOT `src/lib/db.ts`.**
│   ├── lib/
│   │   ├── audit.ts           # `audit({...})` writes to audit_events
│   │   ├── config.ts          # Env vars, isDev, appOrigin, TTLs
│   │   ├── email.ts           # sendEmail, buildResetEmail
│   │   ├── migrate.ts         # Migration runner (called by vercel-build)
│   │   ├── password.ts        # hash/verify/policy
│   │   ├── rate-limit.ts      # Login + password-reset rate limits
│   │   └── tokens.ts          # generateToken, hashToken
│   ├── middleware/
│   │   └── session.ts         # `sessionMiddleware`, `requireAuth`, `requireRole`, `SESSION_COOKIE`, types
│   └── routes/
│       ├── auth.ts            # `export const auth = new Hono()`
│       ├── inventory.ts       # `export const inventory = new Hono<Env>()`
│       ├── people.ts          # `export const people = new Hono<Env>()`
│       ├── orders.ts          # `export const orders = new Hono<Env>()`
│       └── availability.ts    # `export const availability = new Hono<Env>()`
├── vercel.json
├── package.json
└── CLAUDE.md                  # THIS FILE
```

---

## Import path rules (source of past bugs)

- `sql` and `query` are imported from **`../db.js`** — NOT `../lib/db.js`. `db.ts` lives at `src/db.ts`.
- Session helpers come from **`../middleware/session.js`** — NOT `../lib/auth.js` or `../lib/session.js`.
- All local imports use the **`.js` extension** (Node ESM requirement, even for `.ts` files).
- All route files use **named exports**: `export const foo = new Hono<Env>()`. **Never use `export default`** for a route module — `src/app.ts` imports them by name.

---

## Route module pattern (mandatory)

Every new route file MUST follow this shape:

```ts
import { Hono } from 'hono';
import type { Context } from 'hono';
import { z } from 'zod';
import { sql, query } from '../db.js';
import { audit } from '../lib/audit.js';
import {
  sessionMiddleware,
  requireAuth,
  requireRole,
  type SessionUser,
  type SessionWorkspace,
} from '../middleware/session.js';

type SessionVar = {
  sessionId: string;
  user: SessionUser;
  workspace: SessionWorkspace;
} | null;

type Env = {
  Variables: { session: SessionVar };
};

export const myRoute = new Hono<Env>();
myRoute.use('*', sessionMiddleware, requireAuth);

function clientCtx(c: Context) {
  const ipAddress =
    c.req.header('x-forwarded-for')?.split(',')[0]?.trim() ??
    c.req.header('x-real-ip') ??
    null;
  const userAgent = c.req.header('user-agent') ?? null;
  return { ipAddress, userAgent };
}

myRoute.get('/', async (c) => {
  const session = c.get('session')!;
  // ... use session.workspace.id in every query ...
});
```

Then mount in `src/app.ts`:

```ts
import { myRoute } from './routes/my-route.js';
app.route('/api/my-route', myRoute);
```

---

## Database patterns

### Neon HTTP driver gotchas (real bugs we've hit)

- **`array_agg` on enum arrays returns a string like `{customer,staff}` — NOT a JS array.** Use `json_agg(pr.role ORDER BY pr.role)` instead. Always.
- **Do not cast JS arrays to Postgres enum arrays** (e.g. `${['confirmed','dispatched']}::order_status[]`). The driver serialises them oddly and the query silently returns wrong results. Instead, use inline literals: `o.status::text IN ('confirmed', 'dispatched', 'active')`.
- **`sql.unsafe(...)` is banned** except when there is genuinely no alternative. Prefer COALESCE-based PATCH updates (see below).
- Always cast query params explicitly in SQL: `${x}::text`, `${x}::uuid`, `${x}::timestamptz`, `${x}::int`, `${x}::bigint`. The driver's type inference is not always correct.

### Multi-tenant discipline (non-negotiable)

- Every operational table has a `workspace_id uuid NOT NULL REFERENCES workspaces(id)` column.
- **Every SELECT, INSERT, UPDATE, DELETE must filter/set by `workspace_id`.**
- Every audit event carries `workspace_id`.
- If you are writing a query that does not filter by `workspace_id`, stop and rethink.

### PATCH pattern (COALESCE, not dynamic SQL)

Never build UPDATE SET clauses from a JS object with dynamic keys. Use COALESCE:

```ts
const updated = await query<Row>(sql`
  UPDATE my_table SET
    name        = COALESCE(${p.name        ?? null}::text, name),
    description = COALESCE(${p.description ?? null}::text, description),
    updated_at  = now()
  WHERE id = ${id} AND workspace_id = ${session.workspace.id}
  RETURNING *
`);
```

Omitted fields are preserved. Sent fields overwrite. Clean and injection-proof.

### Enum status filtering

For enum columns, prefer text comparison:

```ts
WHERE o.status::text IN ('confirmed', 'dispatched', 'active')
```

NOT `= ANY(${arr}::status_enum[])`.

### Immutable audit tables

`audit_events` and `order_events` have triggers that block `UPDATE` and `DELETE`. They are append-only. If you need to "change" a row, insert a corrective one.

---

## Actual schema truths (verify before assuming)

- **`assets` table** has a `status` enum — since Sub-turn 12b (migration 031) this is **physical possession only**: `available` (on the shelf), `out` (with a customer), `retired` (written off). The legacy `rented`/`in_repair`/`in_transit`/`reserved` values were **removed** — reservations live at `order_items` (capacity claims), and repair is a **downtime record with an end date**, never a status. `asset.status` is written **only** in the order dispatch/return flow (`src/routes/orders.ts`). It does NOT have an `is_active` boolean. Retired assets are soft-deleted (both `status = 'retired'` AND `deleted_at IS NOT NULL`).
- **`products` table** DOES have `is_active` boolean AND `deleted_at`. Filter by `deleted_at IS NULL AND is_active = true` for active-only lists.
- **`workspaces` table** has business/tax columns (`legal_name`, `pan`, `gstin`, `sac_code`, `uan`, `place_of_supply`, `logo_url`, `business_address`, `business_email`, `business_phone`), plus `currency_code`, `country_code`, `timezone`, `next_order_number`, and a `settings jsonb` column.
- **`workspace.settings` JSONB** currently has this shape for DSLRSWALA:

```json
  {
    "billing": {
      "rounding_rule": "24_hour_windows",
      "grace_period_hours": 2,
      "minimum_days": 1,
      "day_cutoff_time": "10:00"
    },
    "tax": {
      "default_gst_percent": 18,
      "charge_gst_by_default": false
    },
    "invoice": {
      "number_format": "YYYY-MM-DD-{order}-{seq}-R{rev}"
    },
    "deposit": {
      "default_percent": 0
    }
  }
```

**All business rules that vary per rental house MUST live in `workspace.settings`, never hardcoded.** This is a founder-level architectural principle: RentalOS will onboard other rental businesses, and their rules will differ.

- **`order_items` table** now includes item-level status columns:
  - `status order_item_status` — enum with values `pending_dispatch`, `dispatched`, `returned`, `returned_with_damage`, `not_returned_chargeable`, `not_returned_non_chargeable`, `missing`. Default `pending_dispatch`.
  - `dispatched_at timestamptz` — nullable, set when item transitions to `dispatched`
  - `returned_at timestamptz` — nullable, set when item transitions to `returned` or `returned_with_damage`
  - `condition_notes text` — nullable, populated during return
- **Terminal item statuses:** `returned`, `returned_with_damage`, `not_returned_chargeable`, `not_returned_non_chargeable`, `missing`. When all items on an order are in terminal states, `GET /api/orders/:id` returns `can_finalize: true`.
- **GST tax breakdown is stored per line and per invoice** as three columns: `cgst_paise`, `sgst_paise`, `igst_paise`. All bigint, default 0. Intra-state populates CGST+SGST (each half the total tax); inter-state populates IGST alone. Present on `order_items` and `invoices`. Populated by the pricing engine at recompute time (implementation lands in Sub-turn 2.4a-endpoints).
- **Customer state for GST determination lives at two levels:**
  - `people.default_gst_state text` — the customer's registered state (e.g. 'Gujarat', 'Maharashtra')
  - `orders.gst_state text` — per-order override for one-off shoots in different states
  - Order wins when set. If both null, fall back to `workspace.place_of_supply`.
- **`orders.gst_state` is frozen on the invoice** at generation time as `invoices.gst_state`, so a future customer address change doesn't retroactively alter an issued invoice.
- **`order_items.chargeable_paise`** is the amount that actually gets billed (as opposed to `total_amount_paise` which is the pre-status-adjustment gross). For rental items, `chargeable_paise = 0` when `status = 'not_returned_non_chargeable'`, else equals `total_amount_paise`. For non-rental items, always equals `total_amount_paise`.
- **DSLRSWALA workspace `place_of_supply`** is `'Gujarat'` (the state, not the city). This is corrected in migration 007 from the legacy value 'Vadodara'.
- **`people` table** additions (migration 013):
  - `tier text CHECK (tier IN ('normal','premium','vip'))` nullable — customer classification tier. Null = "not classified" (no backfill).
  - `trust_score int (0-100)` nullable — algorithmic risk score placeholder, currently manually updated. Null = "not scored."
  - `trust_score_updated_at timestamptz` — set on any `trust_score` write.
  - `billing_address text`, `shipping_address text` — first-class addresses (separate from invoice snapshots).
- **`person_communications` table** (migration 013) — manual communication log per person. Columns: `id`, `workspace_id`, `person_id`, `channel` (`call`/`whatsapp`/`email`/`other`), `direction` (`in`/`out`), `notes`, `occurred_at`, `logged_by_user_id`, `created_at`. Not an immutable audit table. 5-minute correction window for delete, and only the logging user can delete their own entry.
- Tier and trust-score writes are gated by feature flags `customer_tiers` and `trust_score` respectively — the endpoints return `409 feature_disabled` when the flag is off. The columns and the person detail page exist regardless of flag state; only the tier picker / trust input UI is flag-gated.
- **`products` table** (migration 014 + pre-existing): `category text NOT NULL` and `image_url text` already existed from migration 002 (`idx_products_category` indexes category). Migration 014 adds only `hsn_code text CHECK (length <= 8)` nullable — Indian HSN classification code. `image_url` is an external URL (URL-only, upload UI deferred); `category` is freeform text with workspace-scoped autocomplete.
- **`invoices.snapshot.line_items[]`** now includes `hsn_code` (from the product at generation time). Invoices generated before migration 014 retain the "—" HSN display — snapshot immutability preserved.
- **`GET /api/inventory/categories`** returns the distinct non-null category values in the workspace; powers the inventory filter chips and the edit-modal category autocomplete.
- **`products.image_url`** (Sub-turn 5f) may be either a Vercel Blob URL (owned by us — auto-cleaned on replace/delete) or an external URL (pasted, never touched). Detection: `image_url.includes('.blob.vercel-storage.com')` identifies owned blobs. Upload: `POST /api/inventory/products/:id/image` (multipart, field `image`); clear: `DELETE .../image`. The existing PATCH still accepts `image_url` for the URL-paste fallback.
- **Vercel Blob** stores product images at `workspaces/<workspace_id>/products/<product_id>-<timestamp>-<random>.jpg` — the multi-tenant path prefix keeps workspaces isolated in a shared store. Images are client-compressed to max 1200px wide / JPEG 0.85 before upload (5 MB cap enforced both sides).
- **`BLOB_READ_WRITE_TOKEN`** env var must be set in the Vercel project (auto-added when a Blob store is created via the dashboard). The image upload/delete endpoints fail at runtime without it.
- **Products can be kits** (migration 015). `products.is_kit boolean NOT NULL DEFAULT false`. A kit's components live in `product_kit_items` (`kit_product_id`, `component_product_id`, `quantity`). CRUD via `/api/inventory/products/:id/kit-components` (+ `/:componentId`).
- **Kits can't be nested.** Trigger `check_no_nested_kits` (and the application layer) block a component that is itself a kit.
- **Kit availability is derived, not stored.** `checkAvailability()` for a kit returns `MIN` across component availabilities (accounting for the per-kit qty multiplier), plus `is_kit: true` and a `kit_components[]` breakdown. The kit product itself has no independent `total_units`.
- **Kit pricing is fixed on the kit product** (its own `daily_rate`); component rates are ignored when booked as a kit. A kit dispatches as one line item — per-component physical tracking is a QR-scanning concern (deferred).
- **Invoice snapshot** captures kit components under `line_items[].kit_components[]` (with `is_kit: true`) when the item is a kit. Snapshot immutability preserved — pre-migration-015 invoices have no kit fields.
- **`products` availability config** (migration 018, Sub-turn 6b):
  - `buffer_before_hours int NOT NULL DEFAULT 0 (0-72)` — prep time before this product's rentals start (charging, cleaning, packing). Applies to the EXISTING booking's window: a new booking can't start until `booking.rental_end + buffer_after` has passed.
  - `buffer_after_hours int NOT NULL DEFAULT 0 (0-72)` — turnaround time after rentals end (inspection, reset).
  - `shortage_limit int NOT NULL DEFAULT 0 (0-100)` — allowed overbook units above `total_units` capacity.
- **Availability semantics (6b):**
  - Effective conflict window for an existing booking = `[rental_start - buffer_before, rental_end + buffer_after]`. The buffer expands each existing booking, NOT the query window. SQL uses `make_interval(hours => …)` on `o.rental_start` / `o.rental_end`.
  - Availability decision: `available: true` when `currently_booked + requested <= capacity + shortage_limit`. `shortage_used: true` when the booking exceeds `capacity` but stays within `capacity + shortage_limit`. Above that, `available: false`.
  - `checkAvailability` returns `shortage_limit`, `shortage_used`, `applied_buffer_before_hours`, `applied_buffer_after_hours` (transparency) on every result.
  - Workspace-level `settings.availability.buffer_hours` is **DEPRECATED** for check-time logic — the engine reads per-product buffers only. It stays in `workspace.settings` for backward compat and (future) as the seed default for new products. Existing products had `buffer_before/after_hours` backfilled from it at migration time.
  - **Kits ignore kit-level buffer + shortage fields.** Each component uses its own product's buffers/limits during the recursive component check; the kit result surfaces `shortage_limit: 0`, `shortage_used: false`, and `applied_buffer_*: 0`.
  - Frontend distinguishes the soft **shortage** band (amber banner, submit label "Save (shortage)" / "Add (shortage)", no override wording) from a hard **overbook** (red banner, "Save with override" / "Add with override").

---

## Order module specifics

### Order status enum
`draft`, `quoted`, `confirmed`, `dispatched`, `active`, `returned`, `closed`, `cancelled`.

### State transitions
- **Advisory, not enforced.** Non-canonical jumps are allowed with `{ force: true }` in the body.
- Canonical map lives in `src/routes/orders.ts` as `CANONICAL_NEXT`.
- Every transition writes to `order_events` (with `event_type: 'order.status.changed'` or `'order.status.forced'`) AND `audit_events`.

### Order numbering
- Human-readable integer, unique per workspace.
- Atomic: `UPDATE workspaces SET next_order_number = next_order_number + 1 RETURNING next_order_number - 1 AS n`.
- Starts at `1` for each workspace.

### Reservation model (Sub-turn 1)
- Assets are NOT allocated to specific units in Sub-turn 1. `order_assets` table exists but is unused until dispatch (Sub-turn 3).
- Availability is measured at the product level: `total_units - reserved_units`.
- **`RESERVING_STATUSES`** = `['confirmed', 'dispatched', 'active', 'returned']` — the single canonical list of order statuses that reserve inventory. Defined once in `src/lib/availability.ts` and imported by any route that filters orders for availability (`src/routes/availability.ts`); both derive their SQL filter from it, so the two paths can't drift. Draft / quoted / closed / cancelled do NOT reserve.
- **`RESERVING_ITEM_STATUSES`** (Sub-turn 12b) = `['pending_dispatch', 'dispatched', 'not_returned_chargeable', 'not_returned_non_chargeable']` — reservation is now **item-level too**. A line reserves capacity only while its OWN status still ties up a unit; the moment an item is marked `returned` / `returned_with_damage` / `missing`, its capacity is **released at RETURN, not at CLOSE** (MODULE_AUDIT finding 4). The old "`returned` order status still holds the gear" behaviour is gone — the conflict query ANDs both the order-status and item-status filters.

### Physical object tracking (Sub-turn 12b — dispatch/return state machine)
Fixes MODULE_AUDIT findings 1, 2, 4, 6, 7 — one root cause: RentalOS tracked orders, not physical objects. **Two levels, never conflated:** *reservation* (`order_items`, a capacity claim — no specific unit) vs *assignment* (`order_assets`, a specific unit physically with a customer, created **at dispatch**, not at reservation).

- **`asset.status` is written only in the order dispatch/return flow** (`src/routes/orders.ts`): `available` → `out` on dispatch, `out` → `available` / `retired` on return. Nowhere else. (Enum rebuilt to 3 values in migration 031 — see the assets schema truth above.)
- **Dispatch** (`POST /api/orders/:id/dispatch`) now populates `order_assets` and flips assigned units to `out`. Optional `assignments: [{ item_id, asset_ids[] }]` picks specific units (QR scan-out later fills the same field); omitted lines **auto-assign** available units at the pickup location up to the line quantity. Tracked products only — bulk lines have no serialized units. The pinned units ride in the batch `order_event`/`audit` payload (`assigned_assets`) — **one batch row, not per-asset** (repo convention; per-asset rows would be noise).
- **Return** (`POST /api/orders/:id/return`) stamps `order_assets` + sets asset status per **outcome**: `returned` → `available`; `returned_with_damage` → `available` **+ an auto-created asset-level `repair` downtime** (window = `now → now + settings.downtime.default_repair_days`, default 7) so the unit doesn't rejoin availability until fixed; `missing` → `retired` (soft-deleted, out of capacity); `not_returned_*` → stays `out` (still with the customer). Capacity is **released per item at return** (see `RESERVING_ITEM_STATUSES`), not at close. Orders dispatched *before* 12b have no pinned units → the disposition step is a safe no-op (item-status change alone still releases their capacity).
- **Availability capacity is asset-aware** (`src/lib/availability.ts`): a unit held offline by an **active asset-level downtime** (`status IN ('scheduled','started')`) drops out of capacity for the window — capacity **minus one**, not a whole-product block. `out` units **stay in capacity** (the reservation already accounts for them — subtracting both would double-count). Product-level downtimes (Sub-turn 8a) still block the full product.
- **`GET /api/orders/:id`** returns an `assets` array (pinned `order_assets` + `asset_code` + status); `order.html` shows the unit codes per line. Inventory list/detail counts (`available_units`/`rented_units`/`offline_units`) are now **truthful** (driven by real `asset.status` + active downtime), and the product delete-guard (`409 has_out_assets`) is now real.
- **Downtime table extended, not replaced** (migration 031): `product_downtimes` gains nullable `asset_id` (XOR with `product_id`), `kind` (`downtime_reason`: maintenance/repair/missing), `status` (`downtime_status`: scheduled/started/ended/cancelled), and `order_id`. Only `scheduled`/`started` reduce availability.
- **Deliberately deferred** (documented, not built): the downtime *management* lifecycle (Start/Stop/Overdue/Undo/conflict-naming/scheduling UI/dashboard alerts), **OTP handover** (mechanism + null adapter), and **stock windows** (`stock_type`/`available_from`/`available_until` sub-rent — no such columns exist yet). The enum/status scaffolding is in place so those land additive.

### Item types
`rental`, `delivery_fee`, `late_fee`, `damage`, `discount`, `tax`, `deposit`, `other`. Rental items must have `product_id`. Accessories bundle under a parent via `parent_item_id`.

### Rental extension (Sub-turn 6c)
- **`POST /api/orders/:id/extend`** — first-class rental extension. Body: `{ new_rental_end, reason? }`. Allowed only when order status ∈ `confirmed`, `dispatched`, `active`, `returned` (else `409 not_extendable`). Rejects `400 not_an_extension` (new end ≤ current end) and `400 range_too_large` (> 365 days out).
- **Extension semantics:**
  - Availability is checked for the **extension window only** (`current rental_end → new rental_end`), per rental line item — advisory (warns, never blocks), fail-soft per item.
  - `recomputeOrderTotals` fires automatically after the date moves; manual price overrides are preserved.
  - **Invoice revision (Booqable pattern):** if the order already has any invoice AND isn't `closed`, a fresh revision is generated through the shared `generateInvoice()` helper (extracted from the invoices route; the route's behavior is unchanged). The extension passes `bypassReadiness: true` so a still-running order can be re-invoiced — Booqable invoices running orders at any lifecycle point. Old invoice snapshots stay immutable. Invoice generation is fail-open — a revision error never fails the extension.
  - Writes an `order.extended` timeline event + `orders.extended` audit row (payload: `old_rental_end`, `new_rental_end`, `delta_days`, `delta_paise`, `reason`, `conflicts`, `invoice_revised`, `new_invoice_id`, `new_revision_number`), and emits an `order.extended` notification to other members.
  - **Contraction (moving `rental_end` backward) is NOT supported here** — use the normal order edit path.
- **`generateInvoice()`** now lives in `src/routes/invoices.ts` as an exported function (the POST route is a thin wrapper). Callers get a structured `{ ok, ... }` result instead of an HTTP response. `bypassReadiness` skips the all-items-terminal gate.
- **UI:** dedicated "Extend rental" button + modal on `order.html` (visible for the four extendable statuses); the timeline renders `order.extended` distinctively (📅 with delta days, reason, delta ₹, invoice-revision note).

### Deposit workflow (Sub-turn 6d)
- A deposit is **a payment with a distinct kind**, not a new table — it reuses the payments correction-window / audit / refund infrastructure.
  - `payments.payment_kind text` — `rental | deposit | deposit_refund | deposit_forfeit`. Existing rows backfill to `rental`. **Payments have no `deleted_at`** — deletes are hard (within the 5-minute correction window).
  - `orders.deposit_required_paise bigint` — expected deposit (set per-order; no workspace auto-calc yet). **Distinct from the legacy `orders.deposit_paise`** (the deposit portion of the order's own line totals).
  - `orders.deposit_status text` — `none | pending | held | partial_forfeited | fully_forfeited | released`. Denormalised; recomputed from deposit-kind payments after every deposit write/delete.
- **Direction is derived from the kind, not the body:** `deposit_refund` → `out` (cash returned); `deposit` and `deposit_forfeit` → `in` (a forfeit reclassifies money already held).
- **Deposits never touch rental `paid_paise` / `balance_paise`** — `netReceivedPaise()` sums `payment_kind = 'rental'` only. Deposits are refundable holdings, not sales; they do **not** appear on invoices.
- Lifecycle: `pending` (required set, nothing collected) → `held` (deposit recorded) → `released` (deposit_refund) OR `fully_forfeited` / `partial_forfeited` (deposit_forfeit). **No auto-release on close** — the operator triggers Release or Forfeit.
- `deposit_refund` / `deposit_forfeit` require a prior completed `deposit` payment (else `409 no_deposit_to_release`).
- `PATCH /api/orders/:id/deposit` sets `deposit_required_paise` at any status (the generic PATCH is draft-scoped). Deposit mutations audit as `payments.deposit_recorded` / `.deposit_refunded` / `.deposit_forfeited`, and any status change audits `orders.deposit_status.changed`.
- **UI:** a Deposit card on `order.html` (required, currently-held, status pill, status-appropriate actions) reusing the record-payment modal tagged with the deposit kind; deposit payments are excluded from the rental payment.recorded notification.

### Late orders (Sub-turn 6d)
- **`is_late` is computed, not stored:** `rental_end < now() AND EXISTS(order_items still 'dispatched')`. NOTE the `order_item_status` enum has **no `'active'`** (that's an order status) — "still out" means item status `dispatched`. Returned on both the list and detail order responses.
- Orders list accepts `?late_only=1` to show only late orders (WHERE mirrors the `is_late` predicate). `orders.html` shows a red "Late Nd" badge per row + a "Late only" filter chip with URL state.

### Contract signatures at dispatch (Sub-turn 6e)
- **`order_contracts` table** — one row **per dispatch batch** when the `contract_signatures` flag is on. Columns: `contract_text_snapshot` (rendered at signing time), `template_version`, `signature_png` (base64, nullable when unsigned), `signer_name`, `signer_role` (`customer | representative | unsigned`), `signed_at`, `ip_address inet`, `user_agent`, `witness_user_id` (the operator), `dispatch_event_id` (soft link to the `order_events` batch row).
- **Contract template** lives at `workspaces.settings.contract.template_text` (+ `template_version`). Variables substituted at signing: `{customer_name}`, `{customer_phone}`, `{order_number}`, `{rental_start}`, `{rental_end}`, `{total_amount}`, `{deposit_required}`, `{items_list}`, `{workspace_name}`. Unknown `{tokens}` are left literal so template typos are visible.
- **Snapshot immutability:** the rendered text is frozen on the row at signing time — editing the template later never alters old contracts (same discipline as invoices).
- **`POST /api/orders/:id/dispatch`** accepts an optional `contract: { signature_png_base64?, signer_name, signer_role }`. When the flag is on it always writes a contract record — **signed** (`orders.contract.signed`) if a signature is present, else an **unsigned** record (`orders.contract.unsigned_generated`) for the audit trail. Contract creation is **fail-open** — a contract error never fails the dispatch. When the flag is off, no contract row is written (a payload is accepted-and-ignored).
- **`GET /api/orders/:id/contracts`** (light list) and **`GET /api/orders/:id/contracts/:contractId`** (full text + base64 PNG + witness name; `ip_address` via `host()`).
- **Signature storage:** base64 PNG in the DB column (no blob storage yet — migrate to Vercel Blob when scale demands).
- **Feature flag `contract_signatures`** (default OFF) gates the dispatch-drawer signature UI + the order Contracts card. Signature is **optional** — the operator can "Skip signature" (customer not present) and still dispatch; the contract record stays unsigned.
- **Vendored library** at `public/vendor/signature_pad.min.js` — a small, API-compatible signature pad (the upstream SignaturePad CDN was egress-blocked; this exposes `new SignaturePad(canvas,{backgroundColor,penColor})`, `.clear()`, `.isEmpty()`, `.toDataURL()`). First entry in `public/vendor/`. No CDN dependency at runtime.
- **UI:** signature block on the dispatch drawer's confirm step (contract preview, signer name/role, canvas, skip toggle); a Contracts card on `order.html`; a contract detail modal with a Print/Save-PDF path (`window.print()` with a `printing-contract` body class that hides everything except the modal).

### Audit on every mutation
Every route that mutates order state writes TWO event rows:
1. `order_events` — per-order timeline the operator sees
2. `audit_events` — workspace-wide security log

If you write a mutation that only records one, that's a bug.

### Sub-action audit convention

When a single mutation has semantic sub-variants (e.g. an item update that
overrides price vs one that reverts an override), encode the sub-variant in
**payload flags**, not in the event_type name.

Example (from `orders.item.updated`):

```json
{
  "event_type": "orders.item.updated",
  "payload": {
    "fields": ["unit_amount_paise"],
    "item_id": "...",
    "price_overridden": true,
    "price_reverted": false
  }
}
```

Rationale: keeps event_type stable per verb (`item.updated`, `payment.recorded`), lets audit rows query on payload flags when specific sub-actions matter. Avoids proliferating close-variant event_types that all mean "the item was edited."

Consistent across `order_events` and `audit_events`. Do not mix conventions — if you find one payload uses a flag and another uses a distinct event_type for the same semantic concept, unify them by moving to flags.

---

## Frontend patterns

### Client helper
Every page imports from `/_lib/api.js`:

```js
import { api, ensureAuth, formatINR, rupeesToPaise } from '/_lib/api.js';
```

- `api.get(url)` / `api.post(url, body)` / `api.patch(url, body)` / `api.delete(url)` — throw on non-2xx with `err.status` and `err.body`.
- `ensureAuth()` — returns `{ user, workspace }`, redirects to sign-in if unauthenticated.
- `formatINR(paise)` — returns `"₹2,199"`.
- `rupeesToPaise(rupees)` — inverse.

### Shared shell
Sidebar + topbar + content area is identical across `inventory.html`, `people.html`, `orders.html`, `new-order.html`. When adding a new page:
1. Copy the shell from `inventory.html` verbatim.
2. Set the active nav item.
3. Update the topbar kicker + page title.
4. Replace the `.content` section.

### CSS variables
Locked palette in `:root`. Never invent new colors — use existing variables. Full list at the top of `inventory.html`.

### Fonts
- Display: `Arzachel`, fallback `Space Grotesk`
- Body: `Ponjoung`, fallback `Inter`
- Mono: `JetBrains Mono`

### Escape everything
Every string interpolated into HTML must pass through `escapeHtml()`. Every attribute value through `escapeAttr()`. Both functions are defined inline at the bottom of every page (not shared yet — that's fine).

### No `localStorage` / `sessionStorage`
The wizard state lives in a module-scoped `state` object. Refresh loses progress. That's acceptable for Sub-turn 1.

---

## Vercel + Neon deployment specifics

- The Vercel entry file is `api/index.ts`. It uses **named HTTP method exports** (`export const GET = handle(app)`, etc.) via `handle(app)` from `hono/vercel`. Do NOT use `export default handle(app)` — Vercel's runtime misdetects it as a legacy `(req, res) => void` handler and returns 504 GATEWAY_TIMEOUT on every request.
- `vercel.json` routes `/api/(.*)` to `/api/index`.
- Migrations run automatically at build via `vercel-build` script. Do not manually invoke `tsx src/lib/migrate.ts`.
- The migration runner uses a `schema_migrations` ledger table. Files are matched by filename. Do NOT rename an already-applied migration file.
- The SQL migration splitter respects semicolons inside single-quoted strings. When writing seed data with apostrophes in strings, use `''` (SQL doubled quote) inside single-quoted strings.
- Neon-Vercel branch integration creates isolated DB branches per preview deployment. Stale branches can accumulate — fine to leave them alone.

---

## Migration discipline

- **Every migration runs in a TRANSACTION** (`sql.transaction([...])` in `src/lib/migrate.ts` — all statements plus the `schema_migrations` INSERT together). It either fully applies and records itself, or leaves zero trace. Never both-and-neither. A half-applied migration with no ledger entry is the worst possible state — the schema and the ledger disagree and nobody can tell where the DB actually is.
- **EVERY `ADD CONSTRAINT` must be preceded, IN THE SAME MIGRATION, by the data fix that makes it satisfiable.** Postgres validates a new constraint against existing rows. A constraint added without the fix aborts the migration and takes the whole deploy down. (This took production down on 2026-07-13 — migration 034, `order_items_negative_only_custom`, violated by legacy negative-price lines that predated custom line items. The fix: reclassify them as custom lines *before* the `ADD CONSTRAINT`.)
- **Transaction-hostile statements** (`ALTER TYPE ... ADD VALUE`, `CREATE INDEX CONCURRENTLY`, `VACUUM`, `ALTER SYSTEM`, `CREATE/DROP DATABASE`) cannot run inside a transaction block. The runner detects them and falls back to autocommit for that migration — so those migrations MUST be individually idempotent (every statement guarded). Flag any migration that needs one.
- **Migrations run at Vercel build time.** A bad migration = a dead deploy = the app is offline. Treat every migration as production-critical, even against dummy data.
- Corollary for the audit checklist: before shipping any migration, ask of each constraint — *can existing data violate it, and if so does the same migration fix the data first?* Contract-phase column drops are where this gets expensive.

---

## Sub-turn discipline

Aamir works in "sub-turns" — one focused deliverable per turn.

**Before starting any task:**
1. Read this CLAUDE.md fully.
2. Read the specific files you'll touch. Do not assume shapes.
3. If a task feels like it has multiple layers, propose splitting it into sub-turns rather than compressing.

**A task is DONE when:**
1. Code compiles: `npx tsc --noEmit` passes with zero errors.
2. Every mutation writes to `audit_events` (and `order_events` if it touches an order).
3. Every session-scoped endpoint enforces `workspace_id` on every query.
4. Zod validation is on every request body.
5. PATCH endpoints use the COALESCE pattern.
6. New route files use named exports (`export const foo`).
7. New route files are mounted in `src/app.ts`.
8. Frontend pages copy the shell from `inventory.html` exactly.
9. PR summary explains what changed and why.

**Aamir's three blind spots (flag these when you see them):**
1. Over-optimising before the base is stable.
2. Compressing multi-layer problems into single delegations.
3. Under-documenting for his team.

---

## Feature flags

RentalOS is designed to onboard multiple rental businesses with different needs. Not every feature is enabled for every workspace.

Feature flags live in `workspace.settings.features` as a JSONB object. Each key is a boolean; missing keys default to `false`.

Reading a flag in code:
```ts
const flagEnabled = workspace.settings?.features?.[flagKey] ?? false;
```

Documented feature keys (add new ones here as they're introduced):

* `qr_scanning` — per-sub-component QR tracking at dispatch/return
* `otp_handover` — OTP-based dispatch/return replacing paper agreements
* `customer_tiers` — Normal/Premium/VIP tier system with per-tier payment rules
* `vip_consolidated_billing` — monthly ledger with TDS deduction (requires `customer_tiers`)
* `trust_score` — algorithmic customer risk scoring
* `investor_module` — investor equipment tagging + revenue share
* `cashfree_gateway` — Cashfree payment gateway integration
* `wati_notifications` — WhatsApp Business API notifications via WATI
* `gst_split_cgst_sgst_igst` — Indian GST breakdown (CGST+SGST intra-state, IGST inter-state)
* `damage_module` — damage cost recovery, photo evidence, partial forfeiture
* `auto_close_when_all_items_terminal` — automatically close orders when all items reach terminal status (default false — operator confirms via banner)
* `contract_signatures` — on-screen customer signature capture on a rental agreement at dispatch (default false; workspace-editable template in `settings.contract.template_text`)

DSLRSWALA workspace has `gst_split_cgst_sgst_igst: true` by default (GST-registered). All other flags default to `false` and get enabled as features ship.

Never hardcode business rules that a flag would gate. If you're writing an endpoint that assumes tiers exist, check `settings.features.customer_tiers` first.

---

## Integration Adapter Architecture (Sub-turn 6a)

Third-party providers (payment gateways, WhatsApp APIs, email senders) are pluggable per workspace. Any workspace picks its preferred provider per category, saves credentials in Settings → Integrations, and activates one per category. This is the SaaS-multi-tenant story: DSLRSWALA might use Cashfree + WATI, another rental house might use Razorpay + Twilio.

### Three categories

`payment`, `whatsapp`, `email`. Exactly **one active adapter per category per workspace**, enforced by a partial unique index (`workspace_integrations_one_active_per_category ... WHERE is_active = true`). Activating a new provider deactivates the previous one (the route does deactivate-all-then-activate — Neon HTTP has no cross-statement transactions, so it's two sequential UPDATEs).

### Files

- `migrations/017_workspace_integrations.sql` — the `workspace_integrations` table (`category`, `provider`, `credentials_encrypted bytea`, `config jsonb`, `is_active`, `test_mode`, `last_tested_*`), `UNIQUE (workspace_id, category, provider)`.
- `src/lib/crypto.ts` — AES-256-GCM. Credentials are encrypted at rest with `INTEGRATION_ENC_KEY` (64-char hex = 32 bytes). Key is read **lazily** via `getKey()`, so a missing key only breaks the integration endpoints, not the whole backend. Layout: `[IV(12) | authTag(16) | ciphertext]`.
- `src/lib/adapters/types.ts` — `PaymentAdapter`, `WhatsAppAdapter`, `EmailAdapter` interfaces + `AdapterMetadata`, `CredentialField`.
- `src/lib/adapters/registry.ts` — **hardcoded** `ADAPTER_METADATA` (every provider we advertise, implemented or not) + `IMPLEMENTED_ADAPTERS` (only functional ones). Add a provider = add metadata here (+ a concrete adapter when built). `findAdapter`, `findMetadata`, `listMetadata`.
- `src/lib/adapters/noop.ts` — the only implemented adapters in 6a: log + return success. Everything else is `implemented: false` ("Coming soon").
- `src/routes/integrations.ts` — mounted at `/api/integrations`.

### Endpoints (all owner/manager for writes; reads for any member)

- `GET /api/integrations` — every registry adapter + this workspace's saved `configuration` (or `null`). **Credentials are NEVER returned** — only `credentials_saved: boolean`.
- `PUT /api/integrations/:category/:provider` — save credentials + config. Incoming credentials **merge over** existing decrypted ones (blank password field → existing value preserved), then re-encrypt. UPSERT on `(workspace_id, category, provider)`.
- `POST .../activate` — requires `meta.implemented` (else `400 not_implemented`) + a saved row with credentials (noop needs none). Deactivates the category, then activates the target.
- `POST .../deactivate`
- `POST .../test` — calls `adapter.testConnection()` if present, records `last_test_*`.
- `DELETE .../:category/:provider` — removes the row (credentials gone).

### Rules

- **Credentials never leave the backend.** The frontend only ever sees `credentials_saved`. Password fields in the config modal show `(unchanged)` when saved and are omitted from the PUT when left blank.
- **`is_active` on the row is authoritative** for these three categories — not the old feature flags. The legacy flags (`cashfree_gateway`, `wati_notifications`) stay in `settings.features` for backward compat but are now informational only.
- **Activation is gated on `implemented`.** A stub adapter can be listed and even have metadata, but can't be activated (it would route deliveries into a void).
- Every integration mutation writes an `audit_events` row (`integration.configured` / `.activated` / `.deactivated` / `.removed` / `.test_run`).
- **6a wires the pipe but does not send.** `src/lib/notify.ts` now looks up the active `whatsapp` + `email` adapters once per emit and records `notification_deliveries` rows — status `skipped` for a noop adapter, `pending` for a (future) real one. No active adapter → no external row. Nothing is actually dispatched; a sender worker is a later sub-turn. Still fail-open.
- **PREREQUISITE:** `INTEGRATION_ENC_KEY` (any 32-byte / 64-char hex string) must be set in the Vercel project env vars before the integration endpoints work. Without it, `getKey()` throws.

### What 6a deliberately does NOT do

No concrete third-party adapters (only noop), no auto-send on business events, no inbound webhook endpoints, no changes to orders/payments/invoices logic. Those are future sub-turns.

---

## Multi-channel invoice reminders (Sub-turn 6f)

Automated invoice reminders over WhatsApp and/or email, built on the 6a adapter architecture. `invoice_reminders` logs every send attempt with the channel **actually used**.

- **Two concrete adapters now `implemented: true`:** `smtp` (email, uses `nodemailer`) and `wati` (WhatsApp, native `fetch`). All others remain noop/stub. Registered in `IMPLEMENTED_ADAPTERS` + metadata in `src/lib/adapters/registry.ts`.
- **Reminder types:** `invoice_upcoming` (N days before due) and `invoice_overdue` (N days after due, repeats every `repeat_every_days`). Config lives in `settings.reminders.templates.*` per workspace.
- **Channel priority** is a per-type array, e.g. `['whatsapp','email']` — try WhatsApp first, fall back to email. A channel is **skipped** (logged) if its adapter is inactive OR the customer lacks that contact method; the next channel is tried.
- **WhatsApp uses pre-approved templates only** — `template_name` + `variable_order` per workspace; variables are sent as parameters (not freeform text). **Email uses inline `subject`+`body`** with `{variable}` substitution.
- **`due_date`:** migration 021 adds a nullable `invoices.due_date` (invoices had none). The scheduler uses `COALESCE(due_date, issued_at + settings.invoice.default_due_days)`. Invoice generation is untouched — the column stays null unless set directly.
- **Endpoints** (mounted at `/api/reminders`; invoices are served at `/api/order-invoices`, so the invoice-scoped reminder routes live under the reminders mount):
  - `POST /api/reminders/trigger` — cron; header `X-Reminder-Secret` must equal `REMINDER_TRIGGER_SECRET` (else 401). Iterates all workspaces. No session.
  - `POST /api/reminders/invoices/:invoiceId/send` — manual (session); optional `{ channel }` override; **bypasses the cooldown**.
  - `GET /api/reminders/invoices/:invoiceId` — reminder log.
- **24h cooldown** across all channels (in the cron eligibility SQL) + per-type dedup (upcoming: once ever; overdue: once per `repeat_every_days`). Manual send skips the cooldown.
- **Cron** via GitHub Actions hourly (`.github/workflows/reminders.yml`) — free, self-throttling.
- **Audit** `invoices.reminder.sent` / `.failed` (+ `.skipped` reserved); in-product `invoice.reminder.sent` notification to other members on success.
- **Adapters load decrypted credentials** from the active `workspace_integrations` row (AES-GCM via `INTEGRATION_ENC_KEY`) — same as 6a; a missing key just yields empty creds (send fails, logged).
- **PREREQUISITE:** `REMINDER_TRIGGER_SECRET` (64-char hex) in the Vercel env AND as a GitHub Actions secret. WhatsApp additionally needs a WATI account + Meta-approved templates; email needs any SMTP.

---

## Custom fields (Sub-turn 6g)

Workspace-defined custom fields on **orders, people, products** (not line items or invoices). Two tables: `custom_field_definitions` (the per-workspace schema) + `custom_field_values` (per record).

- **Field types:** `text`, `number`, `date`, `checkbox`, `dropdown` (dropdown carries `options jsonb`). **Values are stored as `text`**; type-specific parsing happens on read via the definition's `field_type`.
- **Definitions** — `GET/POST/PATCH/DELETE /api/custom-fields/definitions` (mounted `/api/custom-fields`). Create/update/delete are **owner/manager only**. `field_key` matches `^[a-z][a-z0-9_]{0,49}$`, is **unique per (workspace, entity_type)**, and is **immutable** after creation (so does `entity_type`) — protects existing values. Dropdown create/update requires non-empty `options` (else `400 dropdown_options_required`); duplicate key → `409 field_key_taken`.
- **Values** — `GET/PUT /api/custom-fields/values` (bulk upsert; a `null`/empty value clears the row). Any authenticated user may set values. Shared helpers `loadCustomFieldValues` / `upsertCustomFieldValues` live in `src/lib/custom_fields.ts` and are reused by the entity routes.
- **Soft-delete:** `DELETE …/definitions/:id` sets `is_active = false`; values persist in the DB (the value FK is `ON DELETE RESTRICT`) but stop being returned/rendered.
- **Entity integration:** single-record GETs (`GET /api/orders/:id`, `/api/people/:id`, `/api/inventory/products/:id`) include a `custom_fields` array (definitions left-joined with this record's values). **List endpoints do NOT** (per-row overhead). Each entity PATCH also accepts an optional `custom_fields: [{definition_id, value}]` to upsert inline.
- **Sort order:** definitions render `sort_order ASC, created_at ASC`.
- **UI:** Settings → **Custom Fields** tab (Orders / People / Products sub-tabs) manages definitions (add/edit/delete modal; field_key auto-fills from label; type toggles the options textarea). Edit forms render the fields — an inline "Custom fields" card on `order.html`, and a section in the `person.html` / `inventory.html` edit modals — saving via `PUT /api/custom-fields/values` or the entity PATCH.
- **No feature flag** (additive), **no search integration** (custom values aren't queryable via entity search yet), no file/rich-text/relationship field types.

---

## Product tracking modes (Sub-turn 6h)

`products.tracking_mode text` = `'tracked'` (default) or `'bulk'`, plus `products.stock_quantity int` (nullable).

- **Tracked** (current behavior, all existing products backfilled here): each unit is a serialized `assets` row. Capacity = `COUNT(assets)`. `stock_quantity` MUST be NULL.
- **Bulk**: fungible stock (memory cards, cables, tape). No asset rows are created. Capacity = `stock_quantity`. Bulk products MUST have `stock_quantity` set.
- **DB constraint `products_bulk_requires_quantity`** enforces the mode↔stock coupling.
- **Mode is immutable after creation.** The product PATCH rejects a changed `tracking_mode` with `409 tracking_mode_immutable` ("delete and recreate"); the edit modal shows the mode read-only (radios disabled). Create/PATCH validation also returns `400 stock_quantity_required` (bulk w/o qty) and `stock_quantity_not_allowed_for_tracked`.
- **`getProductCapacity(workspaceId, productId)`** in `src/lib/availability.ts` is the single capacity source → `{ capacity, source: 'assets' | 'stock_quantity' }`. `checkAvailability` computes capacity mode-aware inline (same logic) and returns `capacity_source` on every result.
- **Kit components can be either mode.** Kit availability is still `MIN` across components; each component's `checkAvailability` picks its own capacity source, so a bulk component contributes `floor(stock_quantity / per-kit qty)`.
- **Reservation math is unchanged** across modes (`reserved = SUM(order_items.quantity)` over reserving orders). **Wizard / dispatch / return are mode-agnostic** — they reference product IDs + quantities, never assets directly.
- **Inventory responses** carry `tracking_method`, `effective_capacity`, and per-location `stock_levels`. The list shows a blue TRACKED / amber BULK / violet SERVICE badge.
- No stock-movement log (audit covers updates).

> **⚠ SUPERSEDED by the Sub-turn 13 contract phase (migration 038).** The
> columns this 6h section describes — `products.tracking_mode`,
> `products.stock_quantity`, and the legacy `weekly_rate` / `monthly_rate` — were
> **dropped**. The new sources of truth are:
> - **`products.tracking_method`** (`serialized` | `bulk` | `none`) — replaces
>   `tracking_mode`. `serialized` ≙ the old `tracked`; `none` = service products.
> - **`stock_levels`** (per-location rows) — replaces the workspace-global
>   `stock_quantity` column. Bulk capacity = `Σ stock_levels`; the old
>   `stock_quantity` invariant was `= Σ stock_levels`, so every capacity read
>   (availability, analytics, dashboard, inventory) was repointed 1:1.
> - `getProductCapacity` / `checkAvailability` now return
>   `capacity_source: 'assets' | 'stock_levels'`.
> - `stock_quantity` survives ONLY as a **create request param** (the bulk seed
>   quantity → `stock_levels` at the default location) and the
>   `stock_quantity_required` error code — never as a column.
> - Product **PATCH stock** is per-location (`PATCH /products/:id/stock` with
>   `{ location_id, quantity }`); the edit modal uses a +/− stepper per location.

---

## Multi-location stock (Sub-turn 6i, Phase 1)

Gear lives at physical **locations** (warehouses / branches). Phase 1 ships the locations table + management UI, puts every tracked asset at a location, tags each order with a pickup + return location (forced equal in v1), and computes tracked-product availability **per-location**. DSLRSWALA is single-location, so nothing visible changes there.

- **`locations` table** (migration 024) — workspace-scoped: `name`, address fields (`address_line1/2`, `city`, `state`, `postal_code`, `phone`, `email`), `is_default`, `is_active`. Partial unique index `locations_one_default_per_workspace` (`WHERE is_default = true`) → **exactly one default per workspace**. Migration seeds one default per existing workspace (`city || ' Main'`, else `'Main warehouse'`).
- **`assets.location_id uuid NOT NULL`** — backfilled to the workspace default, then `NOT NULL`. **New tracked assets MUST set `location_id`** (product create sets it from the optional `location_id` param, else the default). Bulk products have no asset rows, so location is irrelevant for them.
- **`orders.pickup_location_id` + `orders.return_location_id`** — both `NOT NULL`, backfilled to default. **CHECK `orders_pickup_equals_return` (pickup = return)** — v1 forces them equal; the check is dropped in Phase 2 when transfers exist. The order create/PATCH take a single `pickup_location_id` and write both columns.
- **Location is draft-only on order PATCH** (`409 location_locked_after_draft` otherwise) — moving it after commitment would shift the per-location reservation out from under dispatched gear.
- **Per-location availability** (`src/lib/availability.ts`):
  - `checkAvailability` gained an optional `locationId`; when omitted it falls back to `getDefaultLocationId(workspaceId)` so pre-6i callers are unchanged.
  - **Tracked** products count live assets **at that location** AND reserve only against orders whose `pickup_location_id` matches. **Bulk** products stay **workspace-global** (per-location bulk is Phase 2) — the location filter is skipped for them.
  - `getProductCapacity(workspaceId, productId, locationId?)` is location-aware for tracked; bulk ignores it.
  - `AvailabilityResult` gained `location_id` (the checked location, or `null` for bulk / no default).
  - **Kits pass the same `locationId` to every component check** (kits dispatch from one warehouse). Kit-level result surfaces the kit's location.
- **`locations` route** (`/api/locations`): `GET` (any member; each row carries `asset_count` + `active_orders_count`), `POST`/`PATCH`/`DELETE` (owner/manager). The default can't be unset (`must_have_default`), deactivated (`cannot_deactivate_default`), or deleted (`cannot_delete_default`). DELETE soft-deletes (`is_active = false`) when referenced by assets/orders, else hard-deletes (`{ soft_deleted }`). Audit `locations.created/updated/deleted`.
- **`PATCH /api/inventory/assets/:id/location`** (owner/manager) relocates one asset → audit `inventory.asset.relocated` (`from_location_id`, `to_location_id`, `product_id`).
- **Inventory responses:** `GET /api/inventory/products` accepts `?location_id=` (products with ≥1 asset there) and returns `location_names` per product (distinct asset locations). `GET /api/inventory/products/:id` returns `assets` (individual rows with `location_id`/`location_name`) + `assets_by_location` (roll-up). Availability `POST /check` accepts optional `location_id`.
- **UI:** Settings → **Locations** tab (add/edit/set-default/delete). New-order wizard shows a location picker **only when >1 active location** (otherwise silent default). `order.html` shows a Location row **only when the workspace has >1 location**. `inventory.html` shows a location filter row + Location column + per-asset relocate dropdowns in the edit modal — all gated on multi-location.
- **Phase 2 (deferred):** per-location bulk stock, cross-location returns (drop the CHECK), inter-location transfer flow with a movement log.

---

## Analytics dashboard (Sub-turn 7)

Owner-facing business intelligence ("how is the business performing?"), distinct from the Command Center's operational "what needs attention now?". One page (`/analytics.html`), reachable from the sidebar.

- **Owner/manager only.** The route (`/api/analytics`) chains `requireRole('owner','manager')`; staff/client/investor get `403`. The page also role-checks client-side after `ensureAuth()`.
- **Four sections:** Revenue, Utilization, Customers, Operational health. A time-range selector at top drives all four.
- **Time range:** presets (7d / 30d / quarter / YTD / last year) + custom. Default 30 days. Every headline number shows a delta vs the **previous equivalent range** (`prevEnd = rangeStart - 1ms`, `prevStart = prevEnd - duration`).
- **Computed on demand** from the live tables — **no analytics tables, no pre-aggregation**. A 5-minute in-process `Map` cache per `(workspace, section, rangeStart, rangeEnd)` key (`src/lib/analytics.ts`). Best-effort only — Vercel recycles instances — which is fine since the queries are cheap. CSV endpoints bypass the cache.
- **Revenue basis:** `SUM(order_items.total_amount_paise)` where `item_type = 'rental'` and the parent order status ∈ {`dispatched`,`active`,`returned`,`closed`}, filtered by `orders.rental_start` in range. (The spec called this `line_total_paise`; the real column is `total_amount_paise`.) Deposits + non-rental lines are excluded.
- **Utilization:** `unit_days_rented / (capacity × days_in_range)` per non-kit product. Capacity is mode-aware (bulk → `stock_quantity`; tracked → live asset count) and **workspace-wide across all locations** — analytics counts every location, so it does NOT call `getProductCapacity` (which resolves to the default location only and would undercount multi-location workspaces). `unit_days` clips each rental's `[start,end]` to the range. Displayed capped at 150% (overbook can exceed 100%). Products with zero capacity are skipped.
- **Customer intelligence:** new vs returning by whether the customer had any completed order **before** the range start. Top 10 by in-range revenue (with tier pill). Repeat rate = share of in-range customers with 2+ completed orders all-time.
- **Operational health:** avg rental days, avg order value, cancellation rate, late returns, damage/forfeit count. **Late returns** = an `order_events` row with `event_type LIKE 'order.return.%'` whose `occurred_at > orders.rental_end` (note: the timeline event is `order.return.batch`/`order.item.returned`, and the column is `occurred_at`, not `created_at`). **Damage/forfeits** = orders with `deposit_status` ∈ {`fully_forfeited`,`partial_forfeited`}.
- **Charts:** vanilla SVG, **no chart library**. Line chart for the revenue daily trend; ranked bars for top products / categories / customers.
- **CSV export** per section: `/api/analytics/{revenue|utilization|customers}/csv?start=…&end=…` with a `Content-Disposition: attachment` header. Revenue exports the daily trend, utilization exports `all_products`, customers exports the top 10.
- **Read-only:** no writes, no audit events for viewing.
- **Migration 025** adds three additive indexes (orders by status+rental_start, order_items by order+type, orders by customer+status). No data change.
- **No feature flag** (additive, owner-gated). No forecasting, AI insights, cohort/LTV curves, report builder, scheduled reports, or cross-workspace comparison.

---

## Product downtimes + tags (Sub-turn 8a)

Two independent, additive features (migration 026) bundled because neither touches pricing or the wizard. No feature flag.

### Downtimes
- **`product_downtimes` table** — `(workspace_id, product_id, location_id nullable, start_at, end_at, reason, created_by_user_id)`, `CHECK (end_at > start_at)`. A `NULL` location_id = all locations; a set location_id = that location only.
- **Availability integration** (`src/lib/availability.ts`): `checkAvailability` loads downtimes overlapping the requested window via `loadDowntimeConflicts`. A downtime **blocks the full capacity** for its window. Tracked products match workspace-wide (`location_id IS NULL`) **plus** this-location downtimes; bulk products (location null) match only workspace-wide ones. **If ANY downtime intersects the window, the product is `available: false`** (simple + safe over-blocking; sub-day precision deferred).
- **`AvailabilityResult`** gained `has_downtime_conflict: boolean`. Each conflict row now has a **`type: 'booking' | 'downtime'`** discriminant. Downtime rows carry `reason`, `downtime_id`, `location_scope` and sentinel booking fields (`order_id: ''`, `quantity: capacity`) so numeric consumers (dashboard sweep) don't break. **`calendar.ts` filters `type !== 'downtime'`** out of its booking bars.
- **Route `/api/downtimes`** (any authenticated member): `GET /products/:productId` (`?upcoming=1`), `POST` (advisory — returns `booking_conflicts[]` of overlapping reserving-status orders but always creates), `PATCH /:id`, `DELETE /:id` (hard delete). Audit `downtimes.created/updated/deleted`.
- **Product detail GET** now returns `downtimes` (windows not yet ended). **UI:** a Downtimes section on the product edit modal (add-modal with start/end/location/reason + a conflict warning banner from the create response); the new-order wizard's availability banner shows downtime rows with a 🔧 + reason; the calendar renders downtimes as gray hatched bands (distinct from booking bars).

### Tags
- **`tags`** (`workspace_id, name UNIQUE per ws, color, sort_order, is_active`) + **`tag_assignments`** (`tag_id, entity_type IN (product|person|order), entity_id`, `UNIQUE (workspace_id, tag_id, entity_type, entity_id)`). **8 preset colors** (`red/orange/yellow/green/blue/purple/pink/gray`) enforced by a DB CHECK. **Soft-delete** (`is_active = false`) preserves assignments.
- **Route `/api/tags`**: `GET` (active tags + `usage_count`), `POST`/`PATCH`/`DELETE`/`POST /reorder` (**owner/manager**), `POST|DELETE|PUT /assignments` (**any member**; assign is idempotent via `ON CONFLICT`; PUT replaces all tags on an entity). Only tag CRUD is audited (`tags.created/updated/deleted`) — assignments are too noisy.
- **Shared helpers** in `src/lib/tags.ts`: `loadTagsForEntity`, `loadTagsForEntities` (batch, for list pages), `filterEntityIdsByTags` (AND semantics — the Neon driver can't nest `sql` fragments, so callers resolve matching ids first then constrain `id = ANY(...)`), `replaceEntityTags`, `parseTagIdsParam`.
- **Entity integration:** single-record GETs (`product`, `person`, `order`) return a `tags` array; list endpoints batch-load `tags` per row **and** accept a repeated/CSV **`?tag_ids=`** filter (AND semantics — an entity must carry all selected tags); each entity PATCH also accepts `tag_ids` (replace-all). **UI:** Settings → **Tags** tab (CRUD + drag-to-reorder + color picker); tag chips on inventory/orders/people rows; a tag filter chip row (multi-select, AND) on those lists; a tag assignment picker on the product edit modal + `order.html` + `person.html`.
- **DELETE assignment needs a body** — the client `api.del()` sends none, so unassign uses a raw `fetch(..., { method: 'DELETE', body })`.

### Deferred
Recurring downtimes, downtime notifications to affected bookings, per-location bulk downtime, tag hierarchies/descriptions, tags on line items/invoices, bulk (multi-entity) tag assignment, tag colors beyond the 8 presets.

---

## Coupons / discount codes (Sub-turn 8b)

Reusable discount codes that reuse the existing pricing/invoice/revision engine rather than fighting it. Two tables: `coupons` (definitions) + `coupon_redemptions` (per-order usage). No feature flag.

- **`order_item_type` already had `'discount'`** (migration 004) — migration 027 only creates the two coupon tables. The discount is materialised as an `order_items` row (`item_type='discount'`, **negative** `total_amount_paise`), so invoices/revisions/recompute handle it for free.
- **Discount model** (`coupons`): `discount_type` `percentage` (1-100) or `fixed` (paise); `max_discount_paise` optional cap for percentage; `min_order_paise` eligibility floor; `valid_from`/`valid_until` (both optional); `max_uses_total` (workspace-wide) + `max_uses_per_customer` (historical, non-removed redemptions); `is_active` soft-delete. **Code UPPERCASE-normalised on create + lookup**, unique per workspace, immutable after creation.
- **The discount line is coupon-driven inside `recomputeOrderTotals`** (`src/lib/pricing.ts`): after summing the subtotal (SUBTOTAL_TYPES = rental/delivery_fee/late_fee/damage/other), `resolveCouponDiscount()` reads the active redemption and recomputes the discount against the **current** subtotal, then upserts/deletes the single `discount` line. So a percentage coupon stays correct after an extension/edit re-prices the order. Manual discount lines aren't a thing — the coupon owns the discount line.
- **GST on the discounted base.** Legacy single-tax mode already nets the discount via `taxableBase = subtotal − discount`. In **GST-split mode** (DSLRSWALA default) the discount line carries a **negative** per-line CGST/SGST/IGST (computed on the discount amount and negated) so `lineTaxSum` — and thus the order tax — lands on `subtotal − discount`. SUBTOTAL_TYPES ≡ TAXABLE_ITEM_TYPES here, so the offset is exact. Discount line sorts at 9000 (before the 9999 auto-tax line).
- **Endpoints** (`/api/coupons`): `GET`/`POST`/`GET /:id`/`PATCH /:id`/`DELETE /:id` (owner/manager; `:id` UUID-constrained so `/validate`,`/apply`,`/remove` literals aren't captured). `POST /validate` (any member — preview discount, never mutates), `POST /apply` (insert redemption + recompute + audit + `order.coupon.applied` notification), `POST /remove` (mark `removed_at` + recompute → discount line auto-deleted). Audit `coupons.created/updated/deactivated/applied/removed`.
- **One active coupon per order** — partial unique index `coupon_redemptions_one_active_per_order (order_id) WHERE removed_at IS NULL`. Removal keeps the row (audit); usage caps count non-removed redemptions, so **cancelling an order does NOT free the cap** (prevents gaming).
- **Order detail GET** returns `coupon_redemption` (active only) alongside the existing `subtotal_paise`/`discount_paise`/`tax_paise`/`total_paise` split. **UI:** Settings → **Coupons** tab (CRUD + deactivate); a Coupon card on `order.html` (code input → 400 ms live `validate` preview → apply; active state shows code + savings + Remove); the order totals line shows `Discount · CODE`; `invoice.html` already renders the discount line (now tinted green).
- **Deferred:** product/category-scoped coupons, stacking, auto-apply, customer self-service, referral/BOGO/first-order-only, time-of-day rules.

---

## Related product recommendations (Sub-turn 8c)

"Customers also rented" — a `product_recommendations` table for manual curation plus co-rental frequency computed on demand from order history. No feature flag. **Honest limitation:** at low order volume the co-rental side is legitimately empty; manual curation is the primary source until history builds.

- **Two sources merged** (`src/lib/recommendations.ts`): **manual** rows (always first, workspace-curated) then **co-rental** auto-fill. Combined list is capped at **6** (manual takes precedence; a product in manual is deduped out of auto).
- **Co-rental** = other rental products appearing in the same completed orders (`status ∈ dispatched/active/returned/closed`) as the source product over the **last 180 days** (hardcoded), with **≥ 2 co-occurrences** (threshold). `confidence = co_occurrences / base_orders`. Both sources **exclude inactive / soft-deleted products**.
- **24h in-process cache** per `(workspace, product)` — computed at the canonical cap of 6 and sliced per request, so a varying `?limit` never poisons the key. Best-effort (Vercel recycles). Manual CRUD calls `invalidateRecommendationsCache`; the auto side expires naturally.
- **Endpoints** (`/api/recommendations`): `GET /products/:productId` (combined, any member; `?limit` clamped to 6), `GET /products/:productId/manual` (owner/manager), `POST /products/:productId/manual` (add — rejects `cannot_recommend_self`, `product_not_found`, `already_recommended`), `POST /products/:productId/manual/reorder`, `DELETE /products/:productId/manual/:recommendedId`. Audit `recommendations.created/removed` (reorder is too noisy). DB enforces self-recommendation (`CHECK`) + duplicate (`UNIQUE`).
- **Product detail GET** (`GET /api/inventory/products/:id`) now returns a `recommendations` array (up to 6). List endpoints do NOT (per-row overhead).
- **UI:** product edit modal → Recommendations section (manual list with drag-reorder + remove + searchable add picker; read-only auto list with "Pin as manual"). New-order wizard → a non-blocking "Customers also rent" panel appears the first time a product is added (chips with pair-rate + "+ Add"); silent when there are no recos.
- **Deferred:** customer-facing/storefront recos, cross-workspace, AI/ML, per-customer history, bundles (that's kits), pre-aggregation cron, configurable window/threshold, recos on `order.html`.

---

## Design system foundation (Sub-turn 9a)

A Stripe-inspired token layer + component styles in **`public/design-system.css`**, plus Tier-1 perceived-speed wins, demonstrated on **`settings.html` only** (proof of concept — 9b/9c/9d roll out to other pages if the direction is approved). No other HTML page loads it; `public/styles.css` (legacy) is untouched.

- **Tokens** at `:root`: colors (`--bg-page/-elevated/-subtle/-hover/-active`; `--text-primary/-secondary/-tertiary/-quaternary/-inverse`; `--border-subtle/-default/-strong/-focus`; `--accent`, `--accent-hover/-active/-soft/-text`; semantic `--success/-warning/-danger/-info` each with `-soft`/`-text`); typography (`--font-sans` system stack, `--font-mono`; `--fs-xs`→`--fs-4xl`; `--fw-*`; `--lh-*`); spacing `--space-1`→`--space-8`; radii `--radius-xs`→`--radius-full` (default `--radius: 6px`); shadows `--shadow-xs`→`--shadow-lg` + `--shadow-focus`; transitions; layout (`--sidebar-width`, `--header-height`).
- **Component classes:** `.btn` (+ `.primary/.secondary/.ghost/.destructive/.tiny/.large`), form inputs (auto-styled) + `.field`/`.label`/`.field-hint`/`.field-error` + `.toggle`, `.card` (+ `.card-head/-body/-foot`), `.table`, `.badge`/`.chip`/`.pill` (+ `-success/-warning/-danger/-info/-accent`), `.modal-backdrop`+`.modal` (+ `.modal-head/-body/-foot`, `.close-btn`), `.empty-state` (+ `-icon/-title/-description`), `.skeleton` (+ `-text/.short/.long/-title/-card/-row/-avatar`), `.sidebar-nav`/`.sidebar-item`/`.sidebar-section`, `.tabs`/`.tab`, `.toast`/`.toast-container`, `.app-shell`/`.sidebar`/`.main`/`.page-header`.
- **Aesthetic:** warm off-white page (`#f7f8fa`), warm near-black text (`#1a1f36`), muted violet accent (`#635bff`), 6px default radius, tinted subtle shadows, system font stack.
- **Speed (Tier 1) on settings.html:** system font stack primary (instant text, no FOIT — the Google Fonts link was removed there); inline critical CSS (bg + font) in `<head>`; `<link rel="preconnect">` to the API origin; skeleton loaders on the initial data-load; **View Transitions API** (`@view-transition { navigation: auto }`) for a silent cross-page fade where supported.
- **How settings.html adopts it (important for 9b+):** settings.html is fully inline-styled and its whole stylesheet is built on CSS variables. 9a **remaps those legacy vars onto the Stripe palette** (`--head`/`--orange` → violet accent, `--ink` → warm near-black, fonts → system stack), which re-skins all 10 tabs **with zero markup/JS changes** (every tab's JS keeps working). `design-system.css` is loaded for the shared token layer + net-new classes (skeletons/toggles/empty-states); the page's own retuned CSS stays authoritative for existing components. **Fresh pages in 9b+ should load `design-system.css` as their primary stylesheet and use its classes directly** (the ordering caveat only exists because settings.html predates the system).
- **What 9a is NOT:** no dark mode, no new JS/CSS dependencies, no functional changes, no other page touched.

### Rollout Phase 2 (Sub-turn 9b) — operational pages
Migrated the four daily-driver pages to the design system: **`dashboard.html`, `orders.html`, `inventory.html`, `people.html`**. Each now loads `design-system.css`, the preconnect, inline critical CSS, View Transitions, and shows **skeleton loaders** on initial load (the static `.loading` placeholder is replaced with `.skeleton-*` markup that the existing JS overwrites on data arrival).

- **Same adoption mechanism as 9a — zero JS changes.** Every one of these pages is fully inline-styled on the shared legacy token names, so 9b **remaps those `:root` vars onto the Stripe palette** (`--head`/`--orange` → violet, `--ink` → warm near-black, fonts → system stack, neutrals → Stripe greys). The whole page re-skins through the vars every rule already uses; markup, IDs, `data-*`, event handlers, filtering/sorting/pagination — all byte-identical. `design-system.css` supplies the shared token layer + the net-new list-page classes (skeletons especially); each page's own retuned CSS stays authoritative for its existing components (so the widget grid, tables, filter rows, notification bell, and every modal keep their exact layout).
- **New reusable components added to `design-system.css`** (for 9c/9d + any fresh markup): `.filter-row` + `.filter-chip` (+`.active`) + `.filter-actions`; `.pagination` + `.pagination-btn`/`-current`/`-info`; `.product-grid` + `.product-card` (+ `-image`/`-body`/`-name`/`-meta`/`-tags`/`-rate`); `.avatar` (+ `.tiny`/`.large`/`.xlarge` + `.color-1`…`.color-6`); `.data-container`; `.skeleton-table-row` (drive column count with `--cols`); `.widget-grid` + `.widget` (+ `-head`/`-title`/`-count`/`-body`/`-item`/`-empty`).
- **Skeletons match the real render:** table pages (orders, inventory, people) use `.data-container` + `.skeleton-table-row`; the dashboard uses `.skeleton-card`s. (Inventory renders a table, not a card grid, so its skeleton is a table too.)
- **Remaining rollout:** 9c (wizard + detail pages), 9d (calendar, analytics, invoice, remaining specialty). Non-migrated pages are untouched and unaffected — none load `design-system.css`.

### Rollout Phase 3 (Sub-turn 9c) — transactional core pages
Migrated the four transactional/detail pages to the design system: **`new-order.html` (booking wizard), `order.html` (order detail), `invoice.html` (invoice document), `person.html` (customer detail)**. Each now loads `design-system.css`, the preconnect, inline critical CSS, and View Transitions; the three data-loaded pages (`order`, `invoice`, `person`) show **skeleton loaders** on initial load (new-order renders the wizard immediately, so it has no initial skeleton — its `.loading` states are mid-flight availability checks, left as-is).

- **Same adoption mechanism as 9a/9b — ZERO JavaScript changes (hard constraint this sub-turn).** Every fetch call, event handler, drawer state, modal state, wizard step logic, and the vendored SignaturePad integration is byte-identical. Migration is purely the head speed block + a `:root` var **remap** onto the Stripe palette; every existing rule re-skins through the vars it already used. Markup, IDs, `data-*` — all untouched except the loading placeholders (below).
- **`invoice.html` print styles preserved verbatim.** The `@media print` block (hides everything but `.invoice-document`, forces white bg / black text / no shadow) is unchanged — the remap only retints screen rendering. The page keeps its intentional grey page background (`--bg: #f0f2f5`, `--line: #c1c9d2`) so the white document sheet pops; only one `--text-primary` lives in its critical CSS for that reason.
- **New reusable components added to `design-system.css`** (Section 17, detail-page): `.drawer-backdrop`/`.drawer`/`-head`/`-body`/`-foot` (slide-in-from-right, `@keyframes slideInDrawer`, full-width on mobile); `.wizard-steps`/`.wizard-step` (+`.active`/`.completed`)/`-number`/`-separator`/`.wizard-actions`; `.timeline`/`.timeline-item` (+`.accent`/`.success`/`.warning`/`.danger`)/`-marker`/`-header`/`-title`/`-time`/`-body`/`-actor`; `.sidebar-card`/`-head`/`-body`; `.kv-list`/`.kv-pair` (+`.stacked`/`.emphasis`)/`-label`/`-value`; `.status-progress`/`-segment` (+`.reached`/`.current`); `.order-layout` (grid `1fr 320px`, collapses <900px)/`.order-main-col`/`.order-sidebar-col` (sticky); `.line-item` (+`.discount`)/`-name`/`-meta`/`-qty`/`-rate`/`-total`.
- **Skeletons match the real render:** `order.html` and `person.html` are two-column layouts, so they use `.order-layout` + `.skeleton-card`s (main + sidebar); `invoice.html` uses a stacked `.skeleton`/`.skeleton-text` document silhouette inside `.invoice-document`. Each is `aria-hidden` and the existing JS overwrites `#content`/`#doc` on data arrival.
- **Ordering caveat (same as 9a/9b):** these pages predate the system and are fully inline-styled on legacy vars, so `design-system.css` loads BEFORE each page's inline `<style>` (page CSS stays authoritative for existing components; the shared file supplies the token layer + net-new classes). Fresh pages should instead load it as the primary stylesheet and use its classes directly.
- **Rollout complete for the core app.** Remaining un-migrated pages are the specialty views (calendar, analytics) — untouched and unaffected (none load `design-system.css`).

### Rollout Phase 4 (Sub-turn 9d) — remaining pages + speed audit — ROLLOUT DONE
Migrated the last pages so **every page in RentalOS now runs on the design system**: `calendar.html`, `analytics.html`, and the auth pages `index.html` (sign-in), `forgot-password.html`, `reset-password.html`.

- **`login.html` / `register.html` do not exist** — the real sign-in is `index.html` and password recovery is `forgot-password.html` / `reset-password.html`. All three auth pages are bespoke split-screen / centered layouts. They were migrated via the **same token-remap + head speed block as 9a–9c (zero JS changes)**, NOT rewritten to the generic `.auth-shell` markup — that would have deleted `index.html`'s product-proof panel and risked its auth-submission JS. The `.auth-shell`/`.auth-card`/`.auth-*` classes were still added to `design-system.css` (per spec) for any future minimal auth page.
- **Auth pages don't load `styles.css`** (they never did — they're fully inline-styled). They now load only `design-system.css` + their own retuned inline `<style>`. Google Fonts dropped for the system stack; favicon + `theme-color` retinted violet.
- **`calendar.html` — equipment-first Gantt layout unchanged.** Only the `:root` tokens were remapped (same legacy token set as the 9b operational pages). The calendar rendering/navigation JS is byte-identical; the Gantt re-skins through the vars every rule already used. The net-new `.calendar-*` classes in `design-system.css` are for fresh markup — the existing calendar keeps its own re-skinned classes.
- **`analytics.html` — SVG charts re-tinted with ZERO JS changes.** The chart-rendering code already emitted `stroke="var(--orange)"` / `fill="var(--muted)"` / `stroke="var(--border)"` etc. (no hardcoded hex anywhere in its `<script>`), so the `:root` remap flows the design palette straight into every line/bar/point/axis. The net-new `.metric-tile` / `.chart-container` / `.chart-svg` classes were added for future fresh markup.
- **New reusable components in `design-system.css`** (Sections 18–20): `.auth-shell` + `.auth-card` + `.auth-brand/title/subtitle/footer/error`; `.metric-tile` + `.metric-label/value/delta` (+`.up`/`.down`/`.flat`)`/sub`; `.chart-container` + `.chart-header/title/subtitle/body/legend` + `.chart-svg` and its descendant classes (`.axis-line`, `.grid-line`, `.data-line`, `.data-fill`, `.data-bar`, `.data-point`, + `.success`/`.warning`/`.danger` variants); `.calendar-toolbar`/`-nav`/`-view-toggle`, `.calendar-gantt`/`-header`/`-row`/`-row-header`/`-row-body`/`-cell`, `.calendar-product-col`/`-time-col`, `.calendar-booking` (+`.dispatched`/`.active`/`.late`/`.downtime`). View Transitions renumbered to Section 21.
- **Speed baseline** captured in `SPEED_AUDIT.md`. Lighthouse **field numbers were NOT run from CI** — egress to the deploy is policy-blocked, the branch isn't deployed, and auth-gated pages need a session. The doc instead ships a **real static-weight analysis** (measured from the repo: every page now has 0 Google-Fonts requests, 1 shared cacheable stylesheet, system fonts, skeletons) + an exact DevTools/CLI recipe for Aamir to fill the field table post-merge. No fabricated numbers.
- **Design system rollout is DONE.** Phase 1 (9a) foundation + settings, Phase 2 (9b) operational lists, Phase 3 (9c) transactional core, Phase 4 (9d) remaining pages + speed audit. No legacy visual patterns remain; every page runs on the design system.

---

## Team invitations (Sub-turn 10)

- **`invitations` table** (migration 029) + `/api/invitations` routes + `/api/members`. Invite by email → tokenized link → `accept-invite.html` sets password → auto-login. This **replaces the removed admin bootstrap token** — there is no longer any way to mint an account from a static env token.
- **A team member is a `users` row + a `workspace_memberships` row (role on the membership) — NEVER a `people` row.** `people` is the customer table; the inviter/invitee are login users. `invitations.invited_by_user_id → users(id)` (the spec's `people` FK was wrong for this schema).
- **Invite token pattern:** 32 random bytes, SHA-256 hashed at rest — same as sessions (`generateToken`/`hashToken`). bcryptjs (cost 12) is for passwords only, never for tokens.
- **Role escalation guard (server-enforced, not just UI):** owner can invite manager/staff/client/investor; manager can invite staff/client/investor only. **NOBODY can invite owner** — enforced in `invitations.ts` (403 `cannot_invite_owner`) AND by a CHECK constraint on `invitations.role` (owner absent from the allowed set).
- **Existing-user path (security):** `users.email` is globally unique. An invite grants the right to JOIN a workspace, never to authenticate as an existing account. Invite create: existing user + membership here → 409 `already_member`; existing user + no membership here → 201 with `existing_user:true`; existing user with `deleted_at` set → 409 `account_disabled` (never resurrected). Accept, `existing_user`: the password field is their EXISTING password — verified with `bcrypt.compare`, membership created, **password never changed**; wrong password → 401.
- **Invite expiry** configurable at `workspaces.settings.invitations.expiry_days` (default 7).
- **Email uses the existing adapter registry** (active workspace `email` integration, decrypted via `INTEGRATION_ENC_KEY`) — no new dependency, nodemailer stays dynamic-imported (F5). **A failed send does NOT roll back the invite** — `accept_url` is returned at creation so it can be shared manually. `accept_url` is shown ONCE and never retrievable (the raw token is not stored).
- **Verify never distinguishes revoked from never-existed** — both return 404 `invalid` (no info leak). Expired → 410 `expired`, used → 410 `already_accepted`.
- **Audit events:** `invitation.created`, `invitation.revoked`, `invitation.accepted`.
- **`ADMIN_SETUP_TOKEN` is REMOVED** (route file + config binding deleted; it was never mounted). Do not reintroduce. `src/lib/seed.ts` is now orphaned (only the deleted admin route called it) — left in place, reads no token.
- **Deferred (not built in Sub-turn 10):** change an existing member's role, remove a member, last-owner protection. Revoke + re-invite is the workaround.

---

## Purchase cost + product ROI (Sub-turn 11)

- **Two-level cost.** `products.default_purchase_cost_paise` (fallback) + `assets.purchase_cost_paise` (per-unit override) + `assets.purchase_date`. Resolution is `COALESCE(asset, product)` **at read time — never denormalized**, so changing a product default updates every non-overridden unit live. Asset responses carry computed `effective_cost_paise` + `cost_source` (`'asset'|'product'|'none'`).
- **Schema reality (STEP 0):** `assets` already had a dormant `purchase_price integer` + `purchase_date date`. Migration 030 reuses `purchase_date`, and replaces `purchase_price` with a BIGINT `purchase_cost_paise` (values copied, old column dropped). `products` had no cost column — `default_purchase_cost_paise` is a clean add.
- **NULL cost ≠ zero cost.** No recorded cost shows "Cost not set", never "ROI −100%". ROI is `null`, never a fabricated percentage.
- **ROI = (lifetime_revenue − total_cost) / total_cost × 100** over earned orders (`{dispatched, active, returned, closed}`). `GET /api/analytics/product-roi`, **owner/manager only**, **tracked non-kit products only** (bulk consumables + kits excluded — no per-unit capital/holding period). **2 set-based aggregate queries + 1 settings query = 3 total, constant** regardless of product count.
- **cost_complete=false ⇒ roi_pct=null AND recovered_pct=null.** Never compute ROI from a partial cost picture.
- **Bundled ₹0 lines never produce a negative ROI.** `is_bundled_only` (revenue only from `order_items` child lines, `parent_item_id IS NOT NULL`) ⇒ `roi_pct=null`, UI shows "Bundled".
- **`months_held < 6` ⇒ status `too_new`** — a new purchase is never a divest candidate. Statuses: `healthy`/`watch`/`divest_candidate`/`too_new`/`cost_missing`, thresholds at `settings.analytics.roi_thresholds` (defaults min_months 6, healthy 100%, watch 40%). Sorted worst-recovery-first.
- **Display contract:** every ROI surface leads with **capital → holding period → current earning rate → recovery %**, never a bare percentage. `cost_missing` rows group at the bottom with a link to bulk entry.
- **Cost is owner/manager only** — product cost field, per-asset overrides, bulk entry, ROI, and the idle-capital tile are all gated server-side; staff get 403 and the UI hides the fields.
- **Cost UI lives in inventory.html** (no product detail page exists): the product edit modal has the **default cost** field; per-unit costs + dates are entered on the **bulk cost screen** (one screen, tab-through, product-row default with opt-in cascade, **one `PATCH /api/inventory/assets/bulk-cost`** call, partial-success tolerant). Idle-capital tile = Σ effective cost of tracked units with no rental in 90 days, disclosing any units with missing cost.
- **Every cost change is audited** (`inventory.product.updated` / `inventory.asset.updated`).
- **Deferred:** depreciation, resale/salvage value, annualized (time-weighted) ROI, investor profit splits.

---

## Roles + granular permissions (Sub-turn 12a)

Closed the live security hole from `MODULE_AUDIT.md`: order/payment/invoice/settings/downtime mutations were gated only by `requireAuth` (no role). Booqable's model — **role is a preset, permission is the truth.**

- **Roles collapsed to `owner | manager | staff`** (migration 032). `client`/`investor` **removed** — they get separate portals later, never workspace memberships. The DB CHECK on `invitations.role` now allows only `manager|staff`.
- **Permission registry lives in code** (`src/lib/permissions.ts`) — 24 keys (`PERMISSIONS`), `PRESETS` (owner=`'*'` sentinel, manager, staff), `can(session, key)`, `presetPermissions(role)`, `requirePermission(...keys)` middleware. Adding a permission = a code change + a preset default, **not a migration**.
- **Permissions live in `workspace_memberships.permissions` JSONB** — the session query already loads the membership row, so `can()` costs **zero extra queries** (the F2 lesson; a join table would be one round trip per request). `getSession` now SELECTs `m.permissions` and attaches it to the session.
- **Owner = every permission, code-enforced** (`if role==='owner' return true`) — never stored as toggles, can never be reduced. Owners store `{}`.
- **Deny by default:** an absent or unknown key = denied. `requirePermission` 403s on the first missing key.
- **Deactivation:** `membership_status` gained `deactivated` (enum was `active|invited|suspended`). `getSession` already filters `status='active'`, so a deactivated member is rejected on their **next request** with no extra check — and the status PATCH also revokes their live sessions.
- **Every mutating route now has an explicit `requirePermission`.** Sub-actions gated in-handler: order **transitions** (cancel→`orders.cancel`, backward→`orders.revert_status`, forward→`orders.edit`), item **price override**→`orders.override_price`, deposit **refund/forfeit**→`deposits.retain`, product/asset **cost writes**→`inventory.costs`. Genuinely all-member routes (tag assignments, custom-field values, own-notification reads) stay `requireAuth` **with an explaining comment** (per the "every route declares intent" rule).
- **Intentional tightenings** (per the presets, these are by design, not regressions): `inventory.costs` (bulk-cost, per-asset cost, product-ROI, cost fields in product PATCH) → **owner-only** by default (manager must be granted it); `settings.manage` (workspace settings, integrations, custom-field **definitions**) → owner-only; `team.manage` (invitations, member management) → owner-only.
- **Team management** (`/api/members`, owner via `team.manage`): `PATCH /:userId/permissions` (toggle; owner immutable; can't edit self; **can't grant a permission you don't hold**; unknown key → 400), `PATCH /:userId/status` (deactivate/reactivate; can't deactivate self or the **last active owner**), `PATCH /:userId/role` (switch preset — overwrites custom perms), `POST /:userId/make-owner` (owner actor only). Every change audits (`team.member.permission_changed`/`.status_changed`/`.role_changed`/`.made_owner`).
- **Invitations seed permissions** from the role preset at accept time. The Sub-turn 10 escalation note ("owner can invite manager/staff/client/investor") is **superseded** — only `manager|staff` are invitable, a manager (if granted `team.manage`) may invite `staff` only, nobody invites `owner`.
- **UI:** Settings → **Team** — member rows show role + status; a "Manage" action opens an editor (status/deactivate, role preset switch, 24 grouped permission checkboxes, Make owner). Owner target renders all-checked + disabled ("Owners have full access. This cannot be changed."); self can't edit own permissions. **All guards are server-enforced regardless of the UI.**
- **Deferred:** custom named roles, permission groups/templates beyond the three presets, KYC field-level redaction (`people.view_sensitive` is registered but people reads aren't yet field-redacted — a documented follow-up).

---

## What NOT to do

- ❌ No JWTs — opaque session tokens only.
- ❌ No default exports for route modules.
- ❌ No `array_agg` on enum arrays — use `json_agg`.
- ❌ No `::enum[]` casts on JS arrays — use inline text `IN (...)`.
- ❌ No `sql.unsafe()` for dynamic UPDATE SET — use COALESCE.
- ❌ No hardcoded business rules — use `workspace.settings`.
- ❌ No manual migration steps — Vercel runs them automatically.
- ❌ No queries without `workspace_id` filtering.
- ❌ No new fonts, colors, or component patterns invented ad-hoc — reuse the existing shell.
- ❌ No `localStorage` / `sessionStorage` in artifacts (Aamir has explicitly ruled this out for the current phase).
- ❌ No premature microservices — modular monolith until scaling forces separation.
- ❌ No mutating route without an explicit `requirePermission` (or a comment stating it's intentionally all-member).
- ❌ No default-allow on an unknown/absent permission key — deny by default.
- ❌ No storing owner permissions in JSONB or reducing them — owner access is code-enforced in `can()`.
- ❌ No permissions join table — permissions ride on `workspace_memberships` (loaded with the session, zero extra queries).
- ❌ No `client`/`investor` workspace roles — collapsed to `owner|manager|staff`.

---

## Reference invoice format (DSLRSWALA)

Real invoice number example: `2022-12-23-24-1-R2`
- `2022-12-23` = invoice date
- `24` = order number
- `1` = sequence (1 = rental invoice, 2 = damage, etc.)
- `R2` = revision 2

Real order number example: `#24` (plain integer).

Real asset codes example: `SONY-FX3-BODY-01`, `SONY-FX3-BODY-02`.

---

## When you finish a task

Open a PR with:
- **Title:** clear one-liner (e.g. "Add pricing engine + order recompute endpoint")
- **Body:**
  - What changed (files added/modified)
  - Why (which sub-turn deliverable this closes)
  - How to verify (curl commands, SQL to run in Neon, pages to check in Chrome)
  - Anything the reviewer should watch for

Aamir will merge, Vercel will auto-deploy, and he'll verify.
