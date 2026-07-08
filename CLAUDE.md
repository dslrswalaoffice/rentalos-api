# CLAUDE.md — RentalOS API (Vercel-native, browser-only)

Guidance for Claude (and humans) working in this repo. Read this before making
changes.

## What this is

RentalOS backend for **DSLRSWALA** (camera & AV rental, Vadodara). Owner: Aamir
Patel. A Hono API on Vercel serverless functions, Neon Postgres, and a static
HTML frontend in `/public`. Auth spine (sessions, audit, rate limits) plus a
first inventory module (products + assets).

This is the **v2 ground-up rewrite**: a browser-only workflow. There is no local
Terminal step, no local Node, no `scripts/` folder. Migrations run automatically
at build time on Vercel; the initial seed runs via a token-protected HTTP
endpoint. Everything is production-only.

## Stack

- **Runtime:** Vercel serverless (`@vercel/node`), Node 20+. Single function at
  `api/index.ts` (`export default handle(app)`), all `/api/*` rewritten to it.
- **Framework:** Hono (`src/app.ts` is the app; mounts `/api/auth`,
  `/api/inventory`, `/api/admin`).
- **DB:** Neon Postgres over the serverless HTTP driver (`src/db.ts`). Neon–Vercel
  branch integration is configured; `DATABASE_URL` is injected by Vercel.
- **Migrations:** `.sql` files in `/migrations`, applied by `src/lib/migrate.ts`.
  Run automatically by the Vercel **build hook** (`vercel-build` script) and
  re-runnable via `POST|GET /api/admin/migrate`. Bundled into the function via
  `includeFiles: "migrations/**"` in `vercel.json`.
- **Seed:** `src/lib/seed.ts`, invoked by `POST|GET /api/admin/seed`.
- **Frontend:** static HTML/CSS/JS in `/public`, served by Vercel from the repo
  root (no `outputDirectory`). Same origin as the API, so session cookies just
  work — no CORS.
- **Auth:** bcryptjs (cost 12), CSPRNG + SHA-256 session/reset tokens, HttpOnly
  SameSite=Lax cookies, Postgres-backed rate limits, append-only audit log.

## How to run things (browser workflow)

There is **no local dev server and no npm commands** in day-to-day work. Deps
install on Vercel; the build hook migrates. You operate the app entirely through
the browser against the deployed Vercel URL.

- **Deploy:** push to `main` → Vercel builds. The build runs
  `vercel-build` = `tsx src/lib/migrate.ts`, which applies pending migrations
  before the deploy goes live. Watch the Vercel **build log** to confirm.
- **Migrate on demand:** open `…/api/admin/migrate?token=<ADMIN_SETUP_TOKEN>`.
- **Seed (first time):** open `…/api/admin/seed?token=<ADMIN_SETUP_TOKEN>`.
- **Use the app:** open `…/index.html` and sign in.
- After initial setup, **delete `ADMIN_SETUP_TOKEN` from Vercel** so the admin
  endpoints go dark (they return `503 admin_disabled` when the var is unset).

Env vars are managed in the Vercel dashboard. Do not add local `.env*` files to
the workflow; `.env.example` documents the variables only.

Only `npm run typecheck` (`tsc --noEmit`) is meant to be run manually, and only
if you have a local checkout with deps — it is not part of the normal loop.

## How to verify a change

Verify against the **Vercel deployment URL**, not localhost:

1. Push, then confirm the Vercel build log shows `[migrate] done …` with the
   expected applied/skipped versions and table count.
2. `GET …/api/health` → `{ ok: true, ts }`.
3. For schema changes: `GET …/api/admin/migrate?token=…` → JSON with
   `applied`, `skipped`, and all 9 `tables`.
4. Exercise the actual flow in the browser at `…/index.html` (sign in, hit the
   inventory page, etc.).
5. Check the audit trail in the DB (`audit_events`) for the expected events,
   including `admin.migrate.success` / `admin.seed.success`.

## Conventions & guardrails

- **Money** is integer paise (INR smallest unit). Never FLOAT/REAL.
- **Multi-tenant** from day one: every operational row FKs to `workspaces(id)`.
- **Audit** every state-changing action via `audit()` (it never throws). Add new
  event types to the `AuditEventType` union in `src/lib/audit.ts`.
- **Migrations are immutable once shipped.** Add a new numbered file
  (`003_*.sql`); do not edit `001`/`002`. The engine is idempotent via
  `schema_migrations`.
- **Never** build SQL statement strings from user input. The raw-string path in
  `migrate.ts` is for our own static `.sql` files only; everything else uses the
  parameterized tagged-template client.
- **No `scripts/` folder** and no TypeScript that requires local execution. The
  only build-time entry is `src/lib/migrate.ts` (self-executes under the build
  hook).
- Admin endpoints compare tokens with `crypto.timingSafeEqual` (SHA-256 both
  sides). Keep it that way.

## Current state (v2 starting point)

- Fresh Neon public schema (was wiped to 0 tables) — first deploy's build hook
  (or `/api/admin/migrate`) applies `001_init` + `002_inventory` → 9 tables.
- Modules live: auth (`/api/auth/*`), inventory (`/api/inventory/*`), admin
  bootstrap (`/api/admin/*`). Frontend: `index`, `forgot-password`,
  `reset-password`, `dashboard`, `inventory`.
- Not yet built: orders/bookings, invoices, investor ownership, real email
  provider (`src/lib/email.ts` is a prod stub), signup/invite UI.
