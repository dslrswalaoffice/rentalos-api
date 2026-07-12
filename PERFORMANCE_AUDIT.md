# PERFORMANCE AUDIT — RentalOS backend/API latency

**Date:** 2026-07-12 · **Auditor:** perf review (read-only; zero code/settings changed)
**Scope:** why pages load slow + API feels laggy. Frontend Sprint-1 items already merged (see §5).

---

## 0. Measurement disclosure — read first

**Live timings could NOT be captured from this environment.** The audit sandbox's egress
proxy denies `CONNECT` to `rentalos-api.vercel.app` (verified: `curl → 403 CONNECT tunnel
failed` on both `/` and `/api/health`, 2026-07-12). Neon/Vercel dashboards are likewise
not accessible from here.

Everything in §1 is therefore an **architecture-derived estimate** (assumptions stated,
arithmetic shown). Every code-level finding in §2–§4 is **verified against source**
(file:line cited). Run the commands below from your machine to replace estimates with
real numbers before/after the sprint:

```bash
# Warm-vs-cold TTFB, 5 runs each. Cold = first run after >15 min idle.
for u in / /dashboard.html /orders.html /inventory.html /order.html \
         /api/health /api/auth/me /api/orders /api/inventory/products /api/people; do
  for i in 1 2 3 4 5; do
    curl -s -o /dev/null -H "Cookie: ros_session=<PASTE SESSION COOKIE>" \
      -w "$u run$i dns:%{time_namelookup} tls:%{time_appconnect} ttfb:%{time_starttransfer} total:%{time_total}\n" \
      "https://rentalos-api.vercel.app$u"
  done
done
```

---

## 1. MEASUREMENTS (estimates — replace with the curl output above)

Latency assumptions: Vadodara user → `iad1` (US East) ≈ 230 ms RTT; `iad1` → Neon
Singapore ≈ 230 ms per DB round trip (Neon HTTP driver = one HTTPS request per query;
connection reused after the first — `neonConfig.fetchConnectionCache = true`, src/db.ts:6).

| Endpoint | DB waves* | Est. WARM TTFB | Est. COLD TTFB | Measured (fill in) |
|---|---|---|---|---|
| `GET /api/health` | 0 | ~230 ms | +1–3 s | |
| `GET /api/auth/me` | 1 | ~460 ms | +1–3 s | |
| `GET /api/orders` (list) | **4** | **~1.2 s** 🔴 | +1–3 s | |
| `GET /api/people` (list) | **4** | **~1.2 s** 🔴 | +1–3 s | |
| `GET /api/inventory/products` | 3 | ~0.9 s | +1–3 s | |
| `GET /api/orders/:id` (detail) | 3–4 | ~1.0 s | +1–3 s | |
| `GET /api/dashboard` | **~4 waves, 2+4×P total queries** | **~1.4 s+** 🔴 | +1–3 s | |
| Static HTML pages | 0 (CDN) | fast | n/a | |

\* "Waves" = sequential DB round trips on the critical path (parallel queries in one
`Promise.all` = one wave). Each wave ≈ one iad1↔Singapore RTT. `P` = active product count.
COLD adds: Vercel cold start (moderate bundle, §2.4) **plus Neon compute wake-up if
autosuspended (§6) — the likely cause of "sometimes VERY slow".**

Wave counts verified in source:
- Session middleware: 1 awaited SELECT per authed request (`src/middleware/session.ts:51`;
  the `last_used_at` bump at `:80` is fire-and-forget — doesn't block).
- `/api/orders` list: middleware + rows + count + tags-batch = 4 sequential
  (`src/routes/orders.ts` list handler; +1 more when `tag_ids` filter active).
- `/api/people` list: middleware + rows + tags-batch + roleCounts = 4 sequential.
- `/api/orders/:id`: middleware + `loadOrder` + `Promise.all(items,events,customFields,
  tags,redemption)` = 3 waves (`src/routes/orders.ts:519-527`) — already well parallelized.
- `/api/dashboard`: middleware + products + `Promise.all(products.map(checkAvailability))`
  where **each `checkAvailability` is itself ~4 sequential queries** → see §2.2.

---

## 2. ROOT CAUSES (ranked)

### 2.1 🔴 Vercel function region ≠ Neon region — cross-planet DB round trips
**Evidence:** `vercel.json` has **no `regions` key** (verified — whole file read) → Vercel
deploys serverless functions to the **default `iad1` (Washington DC)**. Neon project is in
**Singapore** (CLAUDE.md, locked stack: "Region: Singapore", project `wild-thunder-49107529`
— confirm in Neon dashboard). The Neon HTTP driver makes one HTTPS request per query.
**Contribution:** ~230 ms × every DB wave × every request. The orders list's 4 waves ≈
~920 ms of pure geography. This single setting explains most of "API feels laggy".
It also double-penalizes India users: Vadodara → US East → Singapore → back.

### 2.2 🔴 Dashboard N+1 — availability engine invoked per product
**Evidence:** `src/routes/dashboard.ts:104` runs
`Promise.all(products.map(p => checkAvailability(...)))` over **every active product**;
each `checkAvailability` runs ~4 sequential queries (`getDefaultLocationId` → product row →
booking conflicts → downtimes; `src/lib/availability.ts:190,195,249,296`, more for kits).
`getDefaultLocationId` is re-queried per product — same answer every time.
**Contribution:** total queries ≈ 2 + 4×P per dashboard load (P=30 → ~122 queries);
wall-time ≈ 6 sequential waves ≈ ~1.4 s from iad1, plus real load on Neon.

### 2.3 🟠 List endpoints: 4 sequential waves where 2 would do
**Evidence:** orders/people lists run rows → count → tags as three separate sequential
awaits after middleware. The count can merge into the rows query (`COUNT(*) OVER()` — the
pattern already shipped in the inventory list, `src/routes/inventory.ts`), and the tags
batch can run concurrently with nothing to wait on it.
**Contribution:** ~2 extra waves ≈ ~460 ms today; **shrinks to ~4 ms once 2.1 is fixed**
— which is why this ranks below the region fix.

### 2.4 🟠 Cold starts: moderate bundle + everything imports at module top
**Evidence:** `api/index.ts` → `src/app.ts` (23 top-level imports, all 20+ route modules)
→ `registry.ts:3` imports `smtp.ts` → **nodemailer loads on every cold start** (664 KB
package) though it's only used when a reminder email actually sends. `bcryptjs` (332 KB)
loads via `password.ts` → `auth.ts` top-level. Hono 3.6 MB + zod 5.2 MB package weight
(bundler tree-shakes; **built size unmeasurable here** — no package installs allowed;
read it off the Vercel deploy summary → Functions tab).
**bcrypt is NOT in the hot path** — session auth uses SHA-256 `hashToken`
(`src/middleware/session.ts:49`); bcrypt only runs at login/password-change. ✅ correct.
**Contribution:** cold starts only; likely hundreds of ms of module eval, not seconds.

### 2.5 🟠 SUSPECTED (unverifiable from here): Neon autosuspend
Default Neon autosuspend (~5 min idle) means the first query after an idle gap pays a
**multi-second compute wake**. Symptom match: "sometimes very slow" / first hit of the
morning. **I cannot read your Neon dashboard — verify in §6.** A GitHub Actions warm
ping (`.github/workflows/warm.yml`, every 5 min business hours) already exists and also
keeps Neon awake **during those hours only** — nights/Sundays still hit cold wakes.

### 2.6 🟢 Not problems (checked, leave alone)
- **Indexes:** strong coverage. `sessions.token_hash` is `UNIQUE` (implicit index) — the
  per-request session lookup is indexed (migrations/001:79). Orders list filters/sorts on
  `workspace_id + status / created_at` — covered (`orders_workspace_status_idx`,
  `orders_workspace_created_at_idx`, migration 025 added analytics indexes). No missing-
  index table needed: every hot WHERE/ORDER BY column I traced has an index.
- Mutation-path loops (`orders.ts:1742,2065`, `tags.ts:317`, `notify.ts:172`) are
  technically N+1 but low-frequency writes on Neon-HTTP-no-transactions — intentional.
- `json_agg` / COALESCE-PATCH patterns — intentional driver workarounds, untouched.

---

## 3. FIX PLAN (ranked by Impact ÷ Effort)

| # | Fix | Files/settings | Expected improvement | Risk | Type |
|---|---|---|---|---|---|
| **F1** | Pin function region to Singapore: `"regions": ["sin1"]` | `vercel.json` (one line) | Each DB wave 230 ms → ~2 ms. Orders list ~1.2 s → **~350 ms**; every authed endpoint −230 ms minimum. India users: Vadodara↔sin1 ≈ 70 ms vs 230 ms to iad1 | Safe | Code (config) |
| **F2** | Dashboard: replace per-product `checkAvailability` with one batched SQL (booked-units per product in range) + hoist `getDefaultLocationId` | `src/routes/dashboard.ts` (+ helper) | 2+4×P queries → ~3; dashboard ~1.4 s → ~500 ms (~300 ms after F1) | Needs testing (availability semantics: reserving statuses, buffers) | Code |
| **F3** | Orders/people lists: `COUNT(*) OVER()` into rows query; run tags batch via `Promise.all` | `src/routes/orders.ts`, `src/routes/people.ts` | 4 waves → 2. Big today; ~4 ms after F1 — do it anyway, it compounds on India↔sin1 | Needs testing (response shape must stay identical) | Code |
| **F4** | Neon autosuspend ↑ (or off) | Neon dashboard | Kills multi-second first-hit wakes | Safe (cost: more compute-hours) | **Dashboard — you** |
| **F5** | Lazy-load nodemailer (`await import()` inside smtp `send`) | `src/lib/adapters/smtp.ts` | Cold-start module eval trim (est. 50–150 ms; measure) | Safe | Code |
| F6 | Vercel memory/Fluid Compute review | Vercel dashboard | More CPU/faster cold init if at 1 GB default | Safe | **Dashboard — you** |

Explicitly **not** proposed: caching the session lookup (auth-correctness risk, and it's
1 indexed query ≈ 2 ms after F1); rewriting list queries beyond F3; any schema change.

## 4. PROPOSED SPRINT (one PR, on your go-ahead)

**Branch `perf/backend-speed-sprint`: F1 + F2 + F3 + F5** — one commit each, in that
order. No schema changes → no migration. No API response-shape changes (F3 keeps
`{ orders, pagination }` / `{ people, ... }` byte-compatible; F2 keeps the dashboard
payload identical). PR body gets before/after curl timings **if you run the §0 commands**
(or grant me a reachable environment); otherwise before/after must come from your machine.

⚠️ F1 caveat to verify on merge: confirm your Vercel plan allows region selection
(Hobby allows one non-default region for serverless functions) and that the deploy
summary shows `sin1` afterward.

## 5. Already done — excluded from this plan (don't duplicate)

Frontend Sprint items are **merged to main** (verified in repo): shared stylesheet exists
as **`/design-system.css`** (there is no `/rentalos.css` — different name, same role),
`vercel.json` static cache headers ✅ (PRs #44), parallelized page boot ✅ (#45), private
API caching for workspace/tags/locations + business-hours warm cron ✅ (#46), lazy
images + prefetch ✅ (#47), inventory truncation fix ✅ (#48), memoized INR formatter ✅
(#49). Fonts were solved by moving to the system stack (no font files served at all).

## 6. SETTINGS YOU MUST CHANGE YOURSELF (I cannot)

1. **Neon autosuspend** — console.neon.tech → project `wild-thunder-49107529` →
   **Branches** → select your production branch → **Compute** (edit) → read **Autosuspend
   delay**. If ~5 min (default): raise to ≥ 1 h, or disable on a paid plan. While there,
   note **Compute size** (0.25 CU default is fine for now) and **region** (confirm
   `ap-southeast-1` Singapore — F1 assumes it).
2. **Vercel function check (after F1 merges)** — vercel.com → project `rentalos-api` →
   **Settings → Functions**: note **Node version** (expect 20/22), **memory** (default
   1769 MB Fluid / 1024 MB legacy), **Fluid Compute** toggle. Then open the latest
   **Deployment → Functions** tab: confirm region shows **sin1** and note the **bundle
   size** it reports (fills the §2.4 gap).
3. **Optional:** Vercel → Observability → Functions — p50/p99 duration + cold-start
   counts before vs after the sprint; screenshot both for the PR.

---
**STOP.** Phase 1 complete. No code, settings, or packages were touched; this file is the
only artifact. Awaiting explicit approval (all fixes or a subset) before Phase 2.
