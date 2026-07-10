# Speed Audit Baseline — Post 9d

**Measured:** 2026-07-10
**Intended tool:** Chrome DevTools Lighthouse (Mobile emulation, Slow 4G, 4× CPU slowdown)
**Target URL:** https://rentalos-api.vercel.app

---

## ⚠️ Read this first — how these numbers were (and weren't) captured

The Lighthouse **field table below is a template left for capture in Chrome DevTools**, not
fabricated data. It could not be run from the sub-turn's CI sandbox, for three honest reasons:

1. **Network egress is policy-blocked.** The sandbox proxy denies outbound `CONNECT` to
   `rentalos-api.vercel.app` (`403` — verified). Lighthouse cannot reach the site from here.
2. **This branch isn't deployed.** Vercel auto-deploys `main`. Measuring production today would
   score the *pre-9d* pages, not the changes in this PR. Real numbers must be taken **after merge**.
3. **Nine of twelve pages require a session.** Lighthouse (unauthenticated) is redirected to
   sign-in on every app-shell page, so it can only ever score `/` and the two auth pages without a
   scripted login.

Rather than invent numbers, this document ships **two honest things**:

- **A static-weight analysis (Section A)** — measured directly from the repository right now. These
  are the exact levers 9a–9d pulled (render-blocking requests, font strategy, payload, skeletons).
- **A field-capture recipe (Section D)** — the precise DevTools/CLI steps for Aamir to fill the
  Lighthouse table in a few minutes, post-merge, with a logged-in session.

**Do not treat the field table as populated until someone runs Section D.** Every `—` is a
deliberately-empty cell, not a measured zero.

---

## A. Static-weight analysis (measured from the repo, 2026-07-10)

This is real data — computed from the shipped HTML — and it captures what the design-system rollout
actually changed for perceived speed. All 14 pages now: **load zero Google Fonts** (was 1 cross-origin
render-blocking stylesheet + 2 preconnects each), **share one cacheable `design-system.css`**, and
**paint with the system font stack** (no FOIT / no font swap).

| Page | HTML KB | Google-Fonts reqs | Render-blocking CSS | Font strategy | Inline critical paint | View Transitions | Skeleton blocks |
|------|--------:|:-----------------:|:-------------------:|---------------|:---------------------:|:----------------:|:---------------:|
| /index.html (sign-in) | 26 | 0 (was 1) | 1 (shared) | system | inline `<style>` | ✓ (via DS) | n/a (instant form) |
| /dashboard.html | 53 | 0 (was 1) | 1 (shared) | system | ✓ | ✓ | 6 |
| /orders.html | 50 | 0 (was 1) | 1 (shared) | system | ✓ | ✓ | 6 |
| /inventory.html | 112 | 0 (was 1) | 1 (shared) | system | ✓ | ✓ | 6 |
| /people.html | 52 | 0 (was 1) | 1 (shared) | system | ✓ | ✓ | 6 |
| /new-order.html | 65 | 0 (was 1) | 1 (shared) | system | ✓ | ✓ | n/a (sync wizard) |
| /order.html | 228 | 0 (was 1) | 1 (shared) | system | ✓ | ✓ | 13 |
| /invoice.html | 47 | 0 (was 1) | 1 (shared) | system | ✓ | ✓ | 8 |
| /person.html | 61 | 0 (was 1) | 1 (shared) | system | ✓ | ✓ | 13 |
| /calendar.html | 43 | 0 (was 1) | 1 (shared) | system | ✓ | ✓ | — (see note) |
| /analytics.html | 33 | 0 (was 1) | 1 (shared) | system | ✓ | ✓ | inline chart skeletons |
| /settings.html | 106 | 0 (was 1) | 1 (shared) | system | ✓ | ✓ | 10 |
| /forgot-password.html | 27 | 0 (was 1) | 1 (shared) | system | inline `<style>` | ✓ (via DS) | n/a |
| /reset-password.html | 39 | 0 (was 1) | 1 (shared) | system | inline `<style>` | ✓ (via DS) | n/a |

Notes:
- **"Render-blocking CSS = 1 (shared)"** — the single `design-system.css` is same-origin and cached
  across every navigation after the first page, so pages 2..N pay zero CSS network cost. Before 9a–9d,
  each page render-blocked on a **cross-origin** Google Fonts stylesheet (`fonts.googleapis.com` →
  `fonts.gstatic.com`), the classic FOIT source. That is now gone everywhere.
- **"Inline critical paint"** — app-shell pages (9b/9c/9d) carry a tiny `<style>` in `<head>` that sets
  the off-white bg + system font before `design-system.css` arrives. The auth pages (`index`,
  `forgot-password`, `reset-password`) don't need a separate critical block because their **entire**
  stylesheet is already inline in `<head>` — they paint immediately by construction.
- **View Transitions "via DS"** — the auth pages inherit `@view-transition { navigation: auto }` from
  `design-system.css` (Section 21) rather than an inline copy.
- **calendar** renders its Gantt from a live API call; its loading state is the existing inline
  "Loading…" placeholder (left byte-identical per the no-JS constraint), not a `.skeleton` block.

---

## B. Field metrics — Lighthouse (to be captured post-merge via Section D)

| Page | Performance | LCP | FCP | TBT | CLS |
|------|-------------|-----|-----|-----|-----|
| /login (→ /index.html) | — | — | — | — | — |
| /dashboard.html | — | — | — | — | — |
| /orders.html | — | — | — | — | — |
| /inventory.html | — | — | — | — | — |
| /people.html | — | — | — | — | — |
| /new-order.html | — | — | — | — | — |
| /order.html?id=… | — | — | — | — | — |
| /invoice.html?id=… | — | — | — | — | — |
| /person.html?id=… | — | — | — | — | — |
| /calendar.html | — | — | — | — | — |
| /analytics.html | — | — | — | — | — |
| /settings.html | — | — | — | — | — |

### Key metrics explained

- **Performance**: 0–100 composite score (>90 green, 50–89 amber, <50 red)
- **LCP** (Largest Contentful Paint): time until largest visible element renders (target < 2.5s)
- **FCP** (First Contentful Paint): time until any content appears (target < 1.8s)
- **TBT** (Total Blocking Time): main-thread block by long JS tasks (target < 200ms)
- **CLS** (Cumulative Layout Shift): visual stability score (target < 0.1)

---

## C. Observations

Grounded in the architecture (no build step, inline page CSS, one shared token stylesheet, Neon HTTP
driver, Vercel serverless) rather than in field numbers that haven't been captured yet:

- **FCP should improve across the board post-9d.** Every page dropped a cross-origin Google Fonts
  render-blocking request in favour of the system font stack — text paints on first frame with no FOIT
  and no font swap (no CLS from late-arriving fonts either).
- **CLS is structurally low.** Skeleton loaders on the data-heavy pages reserve layout before the JS
  render swaps in real content, so there's little late shift. The one thing to watch in DevTools is
  `order.html` (largest page at ~228 KB of inline markup) — its LCP is tied to the slowest of several
  order-detail API calls, not to asset weight.
- **TBT will spike on cold starts, and that's a backend signal, not a frontend one.** A cold Vercel
  function + a first Neon HTTP round-trip dominate first-load on API-heavy pages (`order`, `calendar`,
  `analytics`). This is a serverless cold-start artefact; warm loads should be well under target.
- **`design-system.css` caches once and is free thereafter.** The first navigation pays for it; every
  subsequent page in a session reuses it from cache, so the "render-blocking CSS = 1" cost is really a
  one-time cost per session.
- **Perceived speed ≠ measured speed.** Skeletons + View Transitions make navigations *feel* instant
  even when the underlying LCP is gated by an API call — a deliberate trade the rollout leaned into.

---

## D. Field-capture recipe (run post-merge)

Once this PR is merged and Vercel has deployed `main`:

**Option 1 — Chrome DevTools (matches the spec's methodology):**
1. Sign in at https://rentalos-api.vercel.app/ as an owner so the session cookie is set.
2. Open DevTools → **Lighthouse** tab → Mode **Navigation**, Device **Mobile**, Categories
   **Performance**. (DevTools reuses the logged-in session, so auth-gated pages measure correctly.)
3. Run it on each page in Section B. For `order`/`invoice`/`person`, append a real `?id=…`
   (e.g. an existing Order's UUID). Paste Performance / LCP / FCP / TBT / CLS into the table.

**Option 2 — Lighthouse CLI (scriptable, needs a session cookie):**
```bash
npx lighthouse "https://rentalos-api.vercel.app/dashboard.html" \
  --only-categories=performance \
  --form-factor=mobile --throttling-method=simulate \
  --extra-headers='{"Cookie":"<paste your session cookie here>"}' \
  --output=json --output-path=./lh-dashboard.json --quiet
```
Repeat per page; read `categories.performance.score` and the `audits[*].numericValue` for the metrics.

Fill Section B, then delete this recipe or leave it for the next audit.

---

## E. Fixes applied in this sub-turn

No perf **regressions** were introduced — 9d is a token remap + head speed block, so it *removes* work
rather than adding it. The speed-positive changes carried by the rollout (9a→9d) are:

1. **Google Fonts eliminated on every page** — removed one cross-origin render-blocking stylesheet and
   two preconnects per page; replaced with the system font stack (instant, no FOIT, no font-swap CLS).
2. **Preconnect to the API origin** — warms the TLS/connection before the first `fetch`.
3. **Inline critical CSS** in `<head>` on app-shell pages — off-white bg + system font paint on the
   first frame, before `design-system.css` arrives.
4. **Skeleton loaders** on data-loaded pages — reserve layout (low CLS) and cut *perceived* load time.
5. **One shared, cacheable `design-system.css`** — replaces per-page ad-hoc styling churn; cached
   across the whole session after the first navigation.
6. **View Transitions** — silent cross-page fade where supported; no cost where not.

---

## F. Next steps if scores prove unacceptable

- **Tier 2 (deferred to 10+):** in-memory data cache across page navigations; prefetch on hover.
- **Tier 3 (deferred):** migrate to an SPA/islands architecture (React/Astro/HTMX) to kill full-page
  reloads entirely.
- **Backend:** connection pooling for Neon (pooled driver over the HTTP driver at scale).
- **Backend:** warm Vercel functions with a cron ping to blunt cold-start TBT.

Baseline established. **Do not chase 100 at DSLRSWALA's scale** — this is an internal rental workspace,
not a marketing site. Anything above ~75 mobile Performance is acceptable for these tools.
