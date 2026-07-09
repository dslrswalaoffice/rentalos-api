# RentalOS — Codebase Conventions

You are working on **RentalOS**, a rental management SaaS being built for **DSLRSWALA** (camera + AV rental in Vadodara, India) as the first workspace, with an eventual multi-tenant SaaS goal. This document is the source of truth for how this codebase is organised, what patterns to follow, and what mistakes to avoid.

**Read this file completely before every task.** Most bugs in this codebase have come from drifting away from these conventions.

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
- Reserving statuses: `confirmed`, `dispatched`, `active`. Draft and quoted do NOT reserve inventory.

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
