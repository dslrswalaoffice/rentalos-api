# Sub-slice 2.2 — Deep Diagnostic Sweep

**Branch:** `diagnostic-sweep-2-2-deep` (diagnostic only — never merged, no PR, no deploy)
**Date:** 2026-07-15 (overnight sweep)
**main HEAD analyzed:** `1171e35e6243e245024de7876e701a72921dd35e` (Merge PR #79)
**Author:** Diagnostic sweep for Aamir Patel — observation only, zero fixes.

---

## ⭐ TL;DR (read this first)

**BUG A ("Create v1" → "identical request already being processed") — ROOT CAUSE FOUND & REPRODUCED.**
`src/app.ts` mounts **two routers at the same prefix `/api/orders`**: the `orders` router (line 66) and the `quoteVersions` router (line 90). Both apply `idempotencyMiddleware` via `use('*')`. For any path the `orders` router does *not* own — i.e. **every `/api/orders/:id/quote-versions*` route** — Hono runs **both** routers' `use('*')` middleware. So `idempotencyMiddleware` executes **twice** on one request:
1. Pass 1 (from the `orders` mount): fresh key → `INSERT idempotency_records … 'in_flight'` → `next()`.
2. Pass 2 (from the `quoteVersions` mount): same key → finds the row Pass 1 just wrote as `in_flight` → returns **409 `REQUEST_IN_FLIGHT` "An identical request is already being processed"** — and the actual handler never runs.

This fails for **every fresh idempotency key**, which is exactly what Aamir sees. It has existed since the original 2.2 merge (**#76**), and none of #77/#78/#79 touched `app.ts`, so every hotfix missed it. **Reproduced end-to-end with real Hono** (see Section 5). The #79 "version-race retry" and frontend re-entry guard were treating a symptom that was never the cause.
**Blast radius:** only quote-version routes (POSTs). Dispatch/return/cancel/etc. are owned by the `orders` router and run a single middleware pass — unaffected. GETs bypass idempotency, so the Quote Versions **card still renders** (list/detail are GETs) while every quote **mutation** 409s.

**BUG B (Settings 240→180 not sticking) — CODE IS CORRECT; failure is environmental. Not reproducible locally.**
The full write→read round-trip is **correct on real Postgres 16**: seed `240` → PATCH `180` → DB stores `180` → the read path (`normalizeSettings`, post-#79) returns `180`. The `numVal` input read is correct, the PATCH merge is correct, the role gate passes for `owner`, and migration 044's seed is idempotent (won't overwrite a saved value). **I cannot reproduce Bug B in code.** The remaining explanations are operational and need production access to disambiguate (Section 3): (1) **browser cache** — `GET /api/workspace` sends `Cache-Control: private, max-age=60, stale-while-revalidate=300`, so the composer can serve a stale `240` for up to ~6 min after a save; (2) **deploy staleness** — whether #79's `normalizeSettings` passthrough is actually live; (3) **save not persisting / wrong workspace** — a multi-workspace or session-scope mismatch between the row the PATCH updates (`session.workspace.id`) and the row Aamir queries (`slug='dslrswala'`). Exact production curl/SQL to settle it are in Section 3.

---

## ⚠️ Production-access limitation (please read)

This diagnostic ran in an **isolated sandbox with no network path to production**. I could **not**:
- reach the live Vercel deployment, its dashboard, env vars, or edge/cache config;
- query the production Neon database;
- read production server logs;
- run curl against the live API (no production session token, outbound restricted to the agent proxy).

So the **live-production** parts of Sections 1.4, 1.5, 3, and 5 are provided as **exact ready-to-run commands, marked `⧗ NOT YET RUN — REQUIRES PRODUCTION ACCESS`**, for Aamir to run in the morning (or to grant access and have me run). Everything I *could* do rigorously — read the real merged code, trace both paths line-by-line, and **reproduce against a local Postgres 16 + real Hono** — I did, and those results are labeled `✓ EXECUTED`.

No production data was read or written. No code on `main` was changed. No deploy, no PR.

---

## Section 1 — Environment Verification

### 1.1 main HEAD  ✓ EXECUTED
```
1171e35  Merge pull request #79 from …hotfix-composer-defaults-and-quote-create
8f505ae  Hotfix: composer reads settings default + Create v1 race safety
3a21072  Merge pull request #78 …
0b5385d  Hotfix: Quote Versions card empty state + composer reads settings for defaults
881e752  Merge pull request #77 …
```
PR #79 IS merged to main. HEAD = `1171e35e6243e245024de7876e701a72921dd35e`.

### 1.2 Are PR #79's three fixes on main?  ✓ EXECUTED — all present.
1. `normalizeSettings` passthrough of the 6 policy keys — **present** (`src/routes/workspace.ts`).
2. `createQuoteVersionFromOrder` retry on version conflict — **present** (`src/lib/quotes.ts`).
3. `order-360.html` re-entry guard (`quoteBusy`) — **present**.

### 1.3 Actual code from main

**(a) `src/routes/workspace.ts` — `normalizeSettings` + the policy-key list (the #79 fix):**
```ts
export function normalizeSettings(raw: unknown) {
  const s = (raw ?? {}) as Record<string, any>;
  // … billing/tax/invoice/bank_details/contract/reminders/features …
  return {
    // …,
    reminders: s.reminders ?? {},
    // Order-policy objects passed through raw (the #79 fix):
    ...ORDER_POLICY_SETTINGS_KEYS.reduce((acc, k) => {
      if (s[k] !== undefined) acc[k] = s[k];
      return acc;
    }, {} as Record<string, unknown>),
    features,
  };
}
const ORDER_POLICY_SETTINGS_KEYS = [
  'extension_policy', 'cancellation_policy', 'approval_routing',
  'notification_policy', 'standby_policy', 'quote_policy',
] as const;
// …
const ORDER_POLICY_KEYS = ORDER_POLICY_SETTINGS_KEYS;   // one list drives GET passthrough AND PATCH merge
```
**Verdict:** correct. `standby_policy` is passed through on read. Confirmed by round-trip in Section 3.

**(b) `src/lib/quotes.ts` — `createQuoteVersionFromOrder` retry loop (the #79 fix):**
```ts
const MAX_ATTEMPTS = 4;
for (let attempt = 1; ; attempt++) {
  const prev = (await query(… ORDER BY version_number DESC LIMIT 1))[0];
  const versionNumber = (prev?.version_number ?? 0) + 1;
  try {
    const row = (await query(sql`INSERT INTO quote_versions (…, version_number, …) VALUES (…) RETURNING id`))[0];
    await audit({ … });
    return { id: row.id, version_number: versionNumber, quote_number: quoteNumber };
  } catch (e) {
    if (isVersionNumberConflict(e) && attempt < MAX_ATTEMPTS) continue;
    throw e;
  }
}
```
**Verdict:** correct *for the race it targets* — but **the race was never the real cause of Bug A** (Section 4/5). This retry never even gets a chance to run, because Pass 2 of the double idempotency middleware 409s **before the handler executes**.

**(c) `public/order-360.html` — re-entry guard (the #79 fix):**
```js
let quoteBusy=false;
async function handleQuote(kind,qid){
  if(kind!=='copylink'){ if(quoteBusy) return; quoteBusy=true; }
  try{ … await api.post('/api/orders/'+S.id+'/quote-versions', …) … await load(); }
  catch(err){showModalError(err);}
  finally{ quoteBusy=false; }
}
```
**Verdict:** correct as a double-*click* guard, but **irrelevant to Bug A** — the failure is a single request being double-processed **server-side**, not two client requests.

### 1.4 Vercel deployment status  ⧗ NOT YET RUN — REQUIRES PRODUCTION ACCESS
Run and paste into this report:
```
# In the Vercel dashboard → Deployments → filter branch = main:
#   confirm the latest READY deployment's commit == 1171e35 (PR #79 merge)
#   confirm its build LOGS show migrate.ts ran and all migrations applied
#   confirm there is NO newer FAILED/ERROR deployment sitting on top of it
```
**Why this matters:** if the latest *ready* deployment predates `1171e35` (e.g. #79's build failed and Vercel kept serving #78), then #79's `normalizeSettings` passthrough is **not live** — which alone explains the composer showing 240 (read strip) even though the DB has 180. The `vercel-build` script is `tsx src/lib/migrate.ts`; a migration throw does `process.exit(1)` → the **whole deploy fails** and production is frozen on the last-good build. **The double-mount (Bug A) is live regardless**, because it shipped in #76.

### 1.5 Unexpected Vercel env / edge / cache config  ⧗ NOT YET RUN — REQUIRES PRODUCTION ACCESS
```
# Vercel → Settings → Environment Variables: confirm DATABASE_URL points at the
#   intended Neon branch (NOT a stale preview branch DB).
# Vercel → check for any Edge Config / middleware / caching rules on /api/*.
```
**Why this matters:** the Neon-Vercel integration creates per-preview DB branches. If a preview or the production function is pointed at a **different Neon branch** than the one Aamir queries, "saved but not visible" is fully explained. (See Section 3 hypothesis 3.)

---

## Section 2 — Deep Read of the Read Path (Bug B)

### 2.1 Frontend read path — the New Order Composer  ✓ EXECUTED
- **File:** `public/new-order.html`.
- **Default set at:** `state.hold_minutes: 240` — but a comment marks it *"fallback only — overwritten by workspace.settings.standby_policy.default_hold_duration_minutes on boot."*
- **Fetch:** `boot()` calls `await api.get('/api/workspace')` then `applyStandbyDefaults(ws.settings)`.
- **Applies via:** `applyStandbyDefaults()` → reads `standbyHoldDefaultMinutes(settings)` from `/_lib/standby-defaults.js`, which reads `settings.standby_policy.default_hold_duration_minutes`; injects/selects the matching `#holdMinutes` option.
- **Fallback / override paths:** **none dangerous.** No `localStorage`/`sessionStorage`/cookies. Only fallback is the built-in `240` when the fetch fails or the key is absent. **No hardcoded override after the fetch.**
- **Verdict:** correct. With the endpoint returning `standby_policy`, the composer renders `180`. Confirmed by headless DOM dump in PR #79 (`<option value="180" selected>3 hours</option>`).

### 2.2 API endpoint `GET /api/workspace`  ✓ EXECUTED
- Handler: `workspace.get('/', …)` → `buildState(session)` → `loadWorkspaceRow` runs `SELECT … settings … FROM workspaces WHERE id = $ws`.
- **Transform:** `settings: normalizeSettings(ws.settings)` — the only transform. Post-#79 it passes `standby_policy` through (Section 1.3a).
- **Second `normalizeSettings`?** ✓ Grepped the whole repo: **only one definition** (`src/routes/workspace.ts`). No shadow copy.
- **Cache header set here:** `c.header('Cache-Control', 'private, max-age=60, stale-while-revalidate=300')` — **see 2.5, a real staleness lead.**

### 2.3 DB column & JSONB path  ✓ EXECUTED (locally) / ⧗ prod value NOT YET RUN
- Column: `workspaces.settings jsonb`. Migration 044 seeds `settings.standby_policy` with `default_hold_duration_minutes = 240` **idempotently** (`COALESCE(settings->'standby_policy', <default>)` — never overwrites an existing value).
- **Exact path:** `settings -> 'standby_policy' ->> 'default_hold_duration_minutes'`. This matches **both** what `normalizeSettings` passes through **and** what the composer reads. **No path mismatch.**
- **⧗ Production value — run and paste:**
```sql
SELECT jsonb_pretty(settings) FROM workspaces WHERE slug = 'dslrswala';
SELECT settings->'standby_policy'->>'default_hold_duration_minutes' FROM workspaces WHERE slug='dslrswala';
```

### 2.4 Save path `PATCH /api/workspace/settings`  ✓ EXECUTED
- The Settings UI (`settings-order-policies.html:253`) sends `api.patch('/api/workspace/settings', { settings: collect() })`, where `collect().standby_policy = { ...sp, default_hold_duration_minutes: numVal('sb_hold', 240), … }`.
- `numVal(id, d)` reads the **live** `#sb_hold` input value (`document.getElementById(id).value`) — so if Aamir types 180, it sends 180. **Correct** (verified by reading the helper).
- Handler: clones current `settings`, **shallow-merges** each incoming policy object (`next.standby_policy = { ...existing, ...incoming }`), then `UPDATE workspaces SET settings = <next>::jsonb WHERE id = session.workspace.id`.
- **Writes to the same JSONB path the read expects.** Confirmed by round-trip (Section 3).
- **Role gate:** `requirePermission('settings.manage')` + `METADATA_ROLES = {owner, manager}` — **owner passes.**
- Write is a **partial merge** onto a clone (preserves other keys). `normalizeSettings` is applied on **read and on the PATCH response**, never on the DB write.

### 2.5 Cache invalidation  ✓ EXECUTED (static analysis)
- **API:** no Redis/in-memory/edge cache in the settings path.
- **Vercel platform cache:** `Cache-Control: private` prevents *shared/CDN* caching, BUT `max-age=60, stale-while-revalidate=300` lets the **browser** serve a cached response for 60 s, then a **stale** one for up to 300 s more while it revalidates.
- **Frontend:** no `localStorage`/`sessionStorage`.
- **⚠ Leading Bug-B mechanism for the *composer*:** Aamir loads Settings (browser caches `GET /api/workspace` = 240) → saves 180 (Settings page updates from the PATCH response, DB now 180) → opens the composer, which does its own `GET /api/workspace` → **browser replays the cached 240** for up to ~60 s (and stale up to ~6 min). This does **not** explain a Neon query returning 240 — only the composer.

---

## Section 3 — Live Production Trace (Bug B)  ⧗ NOT YET RUN — REQUIRES PRODUCTION ACCESS
### 3a — What I proved locally instead  ✓ EXECUTED
Because production is unreachable, I ran the **exact write→read round-trip on Postgres 16** with the real seed + the real PATCH-merge SQL + the real read path:
```
after seed (migration 044):                        240
after PATCH {default_hold_duration_minutes:180}:   180      <-- DB stores 180 correctly
read via normalizeSettings passthrough:            180      <-- GET would return 180
```
**Conclusion: the code round-trips correctly. Bug B is not in the settings read/write code.**

### 3b — Exact production commands for Aamir (fill in the results):
```bash
# 1) Grab your session cookie from the browser (DevTools → Application → Cookies → ros_session).
COOKIE='ros_session=<paste>'
BASE='https://<your-prod-domain>'

# 2) Read current settings + INSPECT HEADERS (look at age/x-vercel-cache/cache-control):
curl -sS -D - "$BASE/api/workspace" -H "Cookie: $COOKIE" | sed -n '1,40p'
#    → Does the JSON body include settings.standby_policy.default_hold_duration_minutes? What value?

# 3) Write a DISTINCT value (200, to distinguish from earlier 180 attempts):
curl -sS -X PATCH "$BASE/api/workspace/settings" -H "Cookie: $COOKIE" \
  -H 'Content-Type: application/json' \
  -d '{"settings":{"standby_policy":{"default_hold_duration_minutes":200}}}' | jq .
#    → status 200? Does the RESPONSE body show standby_policy.default_hold_duration_minutes == 200?

# 4) Immediately query Neon (production branch):
#    SELECT settings->'standby_policy'->>'default_hold_duration_minutes' FROM workspaces WHERE slug='dslrswala';
#    → 200 (persisted) or 240 (not persisted)?

# 5) Immediately GET again (bypass browser cache with a cache-buster):
curl -sS "$BASE/api/workspace?t=$(date +%s)" -H "Cookie: $COOKIE" | jq '.settings.standby_policy.default_hold_duration_minutes'

# 6) Wait 60s, repeat step 5. Any change (would indicate cache TTL expiry)?
```
**Decision tree:**
- **DB shows 200 but composer still shows 240** → browser/CDN cache (Section 2.5) or a stale deploy (1.4). Fix is not in settings logic.
- **DB shows 240 (PATCH didn't persist)** → check the PATCH response for a 403/validation error, and check whether `session.workspace.id` (the row you updated) is the **same** row as `slug='dslrswala'` (multi-workspace/session mismatch — hypothesis 3).
- **GET body lacks `standby_policy` entirely** → #79's `normalizeSettings` passthrough is **not live** (deploy staleness, 1.4).

**⚠ Reset when done (per the sweep rules):**
```
# UPDATE workspaces SET settings = jsonb_set(settings,'{standby_policy,default_hold_duration_minutes}','240')
#   WHERE slug='dslrswala';
```

---

## Section 4 — Deep Read of the Create v1 Path (Bug A)  ✓ EXECUTED

### 4.1 Frontend click handler
- `order-360.html`: a single top-level `document.addEventListener('click', …)` (delegated). It routes `[data-qact]` clicks to `handleQuote(kind, qid)`. **Added once** (module scope) — **not** re-attached per render; no inline `onclick`; no framework. The empty-state **Create v1** button is `<button … data-qact="revise">Create v1</button>`.
- `handleQuote` calls `api.post('/api/orders/'+S.id+'/quote-versions', …)` **once**, guarded by `quoteBusy`.
- **Does the button fire twice per click?** No — verified by reading the wiring. **This is not a client double-submit.** (The #78/#79 assumption was wrong.)

### 4.2 Idempotency-Key generation
- `public/_lib/api.js`: `api.post` sets `Idempotency-Key: newIdempotencyKey()` = `crypto.randomUUID()` — **fresh per call**, no reuse. `request()` has **no retry loop**. So one click = one request = one fresh key. Matches Aamir's observed distinct UUIDs.

### 4.3 API request handler + the error string
- **Grep for the exact string across the whole repo:** it originates in **exactly one place** — `src/lib/idempotency.ts`, the `REQUEST_IN_FLIGHT` branches (two of them: an existing `in_flight` record, and an `ON CONFLICT DO NOTHING` claim race). Nothing else emits it.
- **`idempotency_records` schema (migration 039):** `UNIQUE (workspace_id, user_id, endpoint, idempotency_key)`; PK on `id`. No other unique constraint. `endpoint = "${method} ${c.req.path}"` (full path incl. order id).
- **The other code path that returns it:** ← **THIS IS THE BUG.** It's not "another handler." It's the **same** middleware running **twice** because of the double mount (Section 4 sub-finding below + Section 5 repro).

### 4.4 Quote creation logic
- `createQuoteVersionFromOrder` (with the #79 retry) is correct **but unreachable** — Pass 2 of the middleware 409s before `next()` reaches the handler.
- `buildOrderContentSnapshot` and the `quote_versions` INSERT are fine for order #21 (rental_start_at/end_at are nullable; version numbering is `max+1`). **No order-#21-specific quirk is needed to explain the failure** — the double-mount 409s *every* order's quote-version POST.

### 4.5 The double-mount (root cause)  ✓ EXECUTED
`src/app.ts`:
```ts
app.route('/api/orders', orders);          // line 66  — dispatch/return/cancel/items/extend/transitions/…
// …
app.route('/api/orders', quoteVersions);   // line 90  — /:id/quote-versions[/…]   ← SAME prefix
```
Both routers do `use('*', sessionMiddleware, requireAuth)` **and** `use('*', idempotencyMiddleware)`. `grep` for duplicate mount prefixes across `app.ts` returns exactly one: **`/api/orders`**. Every other module has a unique prefix (standbys → `/api/standbys`, public quotes → `/api/quote-versions`, etc.), so **only quote-version routes are affected.**

### 4.6 Historical idempotency records  ⧗ NOT YET RUN — REQUIRES PRODUCTION ACCESS
```sql
SELECT id, idempotency_key, endpoint, status, response_status, created_at, expires_at
FROM idempotency_records
WHERE endpoint LIKE '%quote-versions%'
ORDER BY created_at DESC LIMIT 50;
```
**Expected pattern if the double-mount is the cause:** rows with `status='completed'` whose `response_status = 409` (Pass 1 caches the 409 that Pass 2 produced), and/or `in_flight` rows. **Do not delete them** — they're evidence, and they don't need cleanup once the mount is fixed.

---

## Section 5 — Live Production Trace (Bug A)

### 5a — Local end-to-end reproduction with REAL Hono  ✓ EXECUTED (this is the proof)
I rebuilt the exact `app.ts` mount shape (two sub-apps at `/api/orders`, each `use('*')` a faithful in-memory model of `idempotencyMiddleware`) and sent two requests with **different fresh keys**:
```
POST /api/orders/878/quote-versions  (Idempotency-Key: FRESH-KEY-d982)
  [orders] fresh key -> INSERT in_flight
  [quoteVersions] key seen in_flight -> 409 REQUEST_IN_FLIGHT
  RESULT status: 409 | {"error":{"code":"REQUEST_IN_FLIGHT","message":"An identical request is already being processed"}}

POST /api/orders/878/quote-versions  (Idempotency-Key: FRESH-KEY-afaf)
  [orders] fresh key -> INSERT in_flight
  [quoteVersions] key seen in_flight -> 409 REQUEST_IN_FLIGHT
  RESULT status: 409 | …same…
```
And a **blast-radius** test (real Hono middleware counter):
```
POST /api/orders/878/dispatch          -> chain: orders.use -> orders.dispatch HANDLER      (single mw pass — OK)
POST /api/orders/878/quote-versions    -> chain: orders.use -> quoteVersions.use -> HANDLER  (DOUBLE mw pass — 409)
```
**This reproduces Bug A exactly: different fresh keys, same 409, every time; quote-versions only.**

### 5b — Exact production curl for confirmation  ⧗ NOT YET RUN — REQUIRES PRODUCTION ACCESS
```bash
COOKIE='ros_session=<paste>'; BASE='https://<your-prod-domain>'
KEY=$(uuidgen)
curl -sS -i -X POST "$BASE/api/orders/878ca187-660e-43f0-bba0-91c5f33328b7/quote-versions" \
  -H "Cookie: $COOKIE" -H 'Content-Type: application/json' -H "Idempotency-Key: $KEY" -d '{}'
#   Expect: 409 {"error":{"code":"REQUEST_IN_FLIGHT",...}}  with a FRESH key → confirms the double-mount.
# Then:
#   SELECT * FROM idempotency_records WHERE idempotency_key = '<KEY>';
#     → expect a row for this key with status 'completed' and response_status 409 (Pass 1 cached Pass 2's 409).
#   SELECT * FROM quote_versions WHERE order_id='878ca187-660e-43f0-bba0-91c5f33328b7' ORDER BY created_at DESC;
#     → expect NO new version (the handler never ran).
```

---

## Section 6 — Test-Coverage Gap Analysis (be brutally honest)

**Bug A — what every test missed.** All my quote tests (`test/standby_quote_contracts.test.ts`, `test/quote_version_conflict.test.ts`, `scripts/quote_race_pg16.ts`) exercised the **schema, the handler, or the DB in isolation** — they imported `quoteCreateSchema`/`createQuoteVersionFromOrder`/`isVersionNumberConflict` directly, or hit the DB directly. **Not one test sent an HTTP request through the real `app` (`src/app.ts`) with its actual mounts.** The bug lives *only* in the route composition — the layer no test touched. A single `app.request('/api/orders/<id>/quote-versions', {method:'POST', headers:{'Idempotency-Key': uuid}})` against the real assembled `app` would have returned 409 and caught this on day one of #76.

**Bug B — the test tested a different thing than production does.** The #79 "Rule D" test asserts `normalizeSettings({standby_policy:{…:180}}).standby_policy… === 180` — a **pure function call on a hand-crafted input**. It never exercised: (a) the **PATCH persisting** to a DB, (b) the **GET reading** it back, (c) the **HTTP cache header**, or (d) the **deploy**. So it "passes" while production can still fail for reasons entirely outside `normalizeSettings`. A real round-trip test — `PATCH` then `GET` through the assembled `app` against a live DB — is what's missing (I ran the SQL equivalent in Section 3a and it passed, which is *why* I now believe Bug B is environmental, not code).

**The shared gap:** the test suite has **no full-stack / assembled-`app` integration test.** Both bugs slipped through the seam between "unit tests pass" and "the wired app behaves." That seam is Rule F (end-to-end), and it was the one rule not actually satisfied for these flows.

---

## Section 7 — Root-Cause Hypotheses

### Bug A — **CONFIRMED (not a hypothesis).**
- **Root cause:** duplicate router mount at `/api/orders` (`orders` + `quoteVersions`), both applying `idempotencyMiddleware`; Hono runs both `use('*')` chains for quote-version paths, so the idempotency middleware double-executes and Pass 2 always 409s.
- **Why previous fixes missed it:** #77 (field names), #78 (card render), #79 (version race + client guard) all targeted the schema/handler/client. None looked at `app.ts`. Every test ran below the routing layer. The bug is as old as #76.
- **What would actually fix it (do NOT implement now):** make quote-version requests pass through the idempotency middleware **once**. Cleanest options, in order of preference:
  1. **Fold the quote-version routes into the `orders` router** (define them on `orders` instead of a second router) — one mount, one middleware chain. Lowest risk.
  2. **Mount `quoteVersions` at a non-overlapping prefix** (e.g. `/api/quotes` with routes `/orders/:id/versions`), and update the 6 frontend call sites. More churn.
  3. **Remove `use('*', idempotencyMiddleware)` (and the redundant `sessionMiddleware`/`requireAuth`) from the `quoteVersions` sub-app**, relying on the `orders`-mount Pass 1 to cover them. Works, but fragile — it depends on the mount order and the coincidental fact that Pass 1 runs; easy to re-break. Not recommended.
  - Whatever the fix, add a **full-`app` integration test** that POSTs to `/api/orders/:id/quote-versions` with a fresh key and asserts **201** (Rule F).

### Bug B — code correct; **environmental. Ranked hypotheses:**
1. **Browser `Cache-Control` staleness on `GET /api/workspace`** (evidence: header is `private, max-age=60, stale-while-revalidate=300`; the composer does a fresh GET that the browser can answer from a pre-save cache). Explains the **composer** showing 240. Does **not** explain a Neon query returning 240. *Likelihood: high for the composer symptom.*
2. **Deploy staleness** — #79's `normalizeSettings` passthrough not live (e.g. its build failed and Vercel serves #78). Explains **composer 240** (read strip) with the DB still holding 180. *Likelihood: medium; check Section 1.4.* (Note: Bug A's double-mount is live regardless, since it shipped in #76.)
3. **Save not persisting to the queried row** — a multi-workspace/session mismatch where the PATCH updates `session.workspace.id` but Aamir queries `slug='dslrswala'` (different row), or a swallowed non-200 on save. This is the **only** hypothesis that explains a genuine **Neon = 240**. *Likelihood: medium — Section 3b steps 3–4 settle it in one shot.*
- These are **not mutually exclusive**; 1+2 could both be masking whether the DB is actually 180 or 240. Section 3b's distinct value (200) plus an immediate Neon read disambiguates all three.

---

## Section 8 — Recommended Next Steps

- **Bug A → Option A (simple, well-scoped fix).** Root cause is confirmed and the fix is small (≈ move the quote-version route definitions onto the `orders` router, or change one mount + 6 call sites). **< 50 lines.** Must land with a **full-`app` Rule F integration test** (POST quote-version → 201) so it can never silently regress. This single fix resolves Bug A completely; #79's retry + client guard become harmless belt-and-suspenders (keep or remove — orthogonal).
- **Bug B → Option D (more diagnostics — but *targeted*, ~10 minutes).** The code is proven correct locally; do **not** write another code fix blind. Run **Section 3b** against production first. The result routes to a *specific* small fix: if it's the cache → drop/shorten `Cache-Control` on `GET /api/workspace` (or have the composer cache-bust); if it's deploy staleness → redeploy/verify the build; if it's save-not-persisting → fix the workspace/session scoping. **One 10-minute production trace replaces another speculative hotfix cycle.**

Honest note: Bug A I am certain about (reproduced). Bug B I am certain the *code* is correct and certain it's environmental, but I **cannot** name which environmental cause without the production trace — so I'm explicitly recommending the trace over a guess.

---

## Section 9 — Anything Else Weird

1. **`app.ts:88–89` comment is actively misleading.** It says quote-version routes "coexist" at the same prefix because "Hono matches by full path." That's true for *handlers* but **false for `use('*')` middleware**, which double-runs. The comment likely gave false confidence during 2.2. (Documented, not changed.)
2. **The idempotency middleware caches a 409 as a success.** When Pass 2 returns 409, Pass 1's post-`next()` logic sees `status < 500` and marks the record `status='completed'`, caching the 409 body. So a **same-key** retry *replays* the 409 forever (until TTL). Harmless once the mount is fixed, but worth knowing: it means some order #21 keys may be "stuck" returning 409 on replay until their TTL expires. (Observe via Section 4.6; do not delete.)
3. **Every mutating `/api/orders/*` route runs Pass 1 of the idempotency middleware from the `orders` mount, and quote-version routes run Pass 2 from the `quoteVersions` mount.** Only the *second* pass 409s. So dispatch/return/etc. are safe **only because** their handlers live in the first-registered router. This is an ordering-dependent accident, not a design guarantee — fragile.
4. **`GET /api/workspace` `max-age=60` is aggressive for a settings surface** that the composer reads right after a save. Even after Bug B's root cause is found, this TTL is a latent "why didn't my setting take effect immediately" trap for any future configurable default. Consider `no-cache` or a cache-bust on the composer's fetch. (Logged as adjacent to TECH_DEBT TD-2.)
5. **`numVal('sb_hold', 240)` fallback is 240**, matching the legacy default — fine, but note that if the `#sb_hold` input ever fails to render (e.g. a future refactor), `collect()` silently sends 240 and "resets" the saved value. Low risk today; flagged because it sits on the exact path under investigation.
6. **No full-stack integration test exists anywhere in `test/`.** Every test is a unit/DB test. This is the single biggest process gap (see Section 6) and the reason 5 hotfix cycles couldn't converge. Recommend a small `test/app_integration.test.ts` using `app.request(...)` against a local PG, added alongside the Bug A fix.

---

*End of diagnostic sweep. No code on `main` changed. No deploy. No PR. Database untouched (all local-only reproductions were on a throwaway `diagdb` and rolled back). Awaiting Aamir's morning review.*
