# RentalOS · API (Vercel-native)

Backend for **DSLRSWALA** (camera & AV rental, Vadodara): a Hono API on Vercel
serverless functions, Neon Postgres, and a static HTML frontend in `/public`.
Auth spine (sessions, audit, rate limits) plus inventory (products + assets).

## How this works (browser-only workflow)

This repo runs **production-only, from the browser** — no local Terminal, no
local Node, no `scripts/` folder. You push to `main`, Vercel installs deps and
builds, and the app is live. There is nothing to run on your machine. Env vars
(`DATABASE_URL`, `ADMIN_SETUP_TOKEN`, seed values, etc.) live in the Vercel
dashboard, and the Neon–Vercel branch integration wires the database in
automatically. `.env.example` documents the variables for reference only.

**Migrations run themselves.** The Vercel build step runs `vercel-build`
(`tsx src/lib/migrate.ts`), which applies every pending `.sql` file in
`/migrations` against `DATABASE_URL` before the deploy goes live. It's
idempotent — a `schema_migrations` ledger records what's applied, so redeploys
are safe — and it does a post-flight check that all 9 expected tables exist,
failing the build loudly if any is missing. You can also re-run it any time from
the browser via the admin endpoint below. The `.sql` files are bundled into the
serverless function (`includeFiles` in `vercel.json`) so the runtime endpoint
can read them too.

**Setup is two browser hits.** After the first deploy, open the migrate URL to
build the schema, then the seed URL to create the DSLRSWALA workspace and Aamir's
owner account. Both are gated by `ADMIN_SETUP_TOKEN` (timing-safe comparison);
with that env var unset they return `503 admin_disabled`. **Once setup is done,
delete `ADMIN_SETUP_TOKEN` from Vercel** so the bootstrap endpoints go dark, then
sign in and use the app normally.

## URLs to hit for setup

Replace `<APP>` with your Vercel URL (e.g. `https://rms.dslrswala.com`) and
`<TOKEN>` with the `ADMIN_SETUP_TOKEN` you set in Vercel.

1. **Health check** — `<APP>/api/health` → `{ ok: true, ts }`
2. **Migrate** — `<APP>/api/admin/migrate?token=<TOKEN>` → `{ ok, applied, skipped, tables }`
   (the build hook already does this on deploy; this is for on-demand/verification)
3. **Seed** — `<APP>/api/admin/seed?token=<TOKEN>` → `{ ok, workspace_id, user_id, email }`
4. **Sign in** — `<APP>/index.html`

Then remove `ADMIN_SETUP_TOKEN` from the Vercel project's environment variables.

## Endpoints

Base path `/api`. Bodies are JSON. Cookies are `HttpOnly SameSite=Lax` (+ `Secure`
in production). Admin routes accept **GET or POST** (GET so you can trigger them
from the address bar).

| Method   | Path                              | Auth            | Success                                      |
|----------|-----------------------------------|-----------------|----------------------------------------------|
| GET      | `/api/health`                     | –               | `200 { ok, ts }`                             |
| POST     | `/api/auth/login`                 | –               | `200 { redirect, user, workspace }` + cookie |
| POST     | `/api/auth/logout`                | session         | `200 { ok }` + cookie cleared                |
| GET      | `/api/auth/me`                    | session         | `200 { user, workspace }` or `401`           |
| POST     | `/api/auth/forgot-password`       | –               | `200 { ok }` (always — no enumeration)       |
| GET      | `/api/auth/reset-password/verify` | –               | `200 { email }` or `404`                     |
| POST     | `/api/auth/reset-password`        | reset token     | `200 { redirect }` + cookie                  |
| GET      | `/api/inventory/products`         | session         | `200 { products, total, by_category }`       |
| POST     | `/api/inventory/products`         | owner/manager   | `201 { product }`                            |
| PATCH    | `/api/inventory/products/:id`     | owner/manager   | `200 { product }`                            |
| DELETE   | `/api/inventory/products/:id`     | owner/manager   | `200 { ok }`                                 |
| GET/POST | `/api/admin/migrate`              | `ADMIN_SETUP_TOKEN` | `200 { ok, applied, skipped, tables }`   |
| GET/POST | `/api/admin/seed`                 | `ADMIN_SETUP_TOKEN` | `200 { ok, workspace_id, user_id, email }` |

## Layout

```
rentalos-api/
├── vercel.json            ← rewrites + function config + includeFiles (no outputDirectory)
├── api/index.ts           ← Vercel entry: export default handle(app)
├── migrations/
│   ├── 001_init.sql       ← auth spine (7 tables)
│   └── 002_inventory.sql  ← products + assets
├── src/
│   ├── app.ts             ← Hono app, mounts auth + inventory + admin
│   ├── db.ts              ← Neon client
│   ├── lib/
│   │   ├── config.ts      ← env → typed config (incl. adminSetupToken)
│   │   ├── password.ts    ← bcryptjs cost 12
│   │   ├── tokens.ts      ← CSPRNG + SHA-256
│   │   ├── audit.ts       ← append-only event log
│   │   ├── rate-limit.ts  ← login + reset limits (Postgres-backed)
│   │   ├── email.ts       ← dev: console; prod: stub
│   │   ├── migrate.ts     ← migration engine (build hook + admin endpoint)
│   │   └── seed.ts        ← seed logic (admin endpoint)
│   ├── middleware/session.ts
│   └── routes/
│       ├── auth.ts        ← /api/auth/*
│       ├── inventory.ts   ← /api/inventory/*
│       └── admin.ts       ← /api/admin/* (token-protected bootstrap)
└── public/                ← static frontend (index, forgot, reset, dashboard, inventory)
```

## Not built yet

Orders/bookings, invoices, investor ownership, a real email provider
(`src/lib/email.ts` is a prod stub — wire Resend/Postmark/SES), and a signup /
invite UI. Add new schema as numbered migrations (`003_*.sql`); never edit
`001`/`002`.
