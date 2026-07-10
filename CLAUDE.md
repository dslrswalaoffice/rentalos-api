# RentalOS — Codebase Conventions

You are working on **RentalOS**, a rental management SaaS being built for **DSLRSWALA** (camera + AV rental in Vadodara, India) as the first workspace, with an eventual multi-tenant SaaS goal. This document is the source of truth for how this codebase is organised, what patterns to follow, and what mistakes to avoid.

**Read this file completely before every task.** Most bugs in this codebase have come from drifting away from these conventions.

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

- **`assets` table** has a `status` enum with values `available`, `rented`, `in_repair`, `retired`. It does NOT have an `is_active` boolean. Retired assets are soft-deleted (both `status = 'retired'` AND `deleted_at IS NOT NULL`).
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
- **`RESERVING_STATUSES`** = `['confirmed', 'dispatched', 'active', 'returned']` — the single canonical list of order statuses that reserve inventory. Defined once in `src/lib/availability.ts` and imported by any route that filters orders for availability (`src/routes/availability.ts`); both derive their SQL filter from it, so the two paths can't drift. Draft / quoted / closed / cancelled do NOT reserve. (`returned` still holds the gear until items are individually marked returned, so it counts.)

### Item types
`rental`, `delivery_fee`, `late_fee`, `damage`, `discount`, `tax`, `deposit`, `other`. Rental items must have `product_id`. Accessories bundle under a parent via `parent_item_id`.

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
