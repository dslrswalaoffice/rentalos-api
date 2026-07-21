# Shell Consistency Audit

**Date:** 2026-07-21
**Scope:** Read-only audit of the application shell (icon rail, top-bar, search, notification bell, avatar/menu, sub-nav) across every `public/*.html` page except `index.html` (sign-in). No 404 page exists in the repo.
**Reference standard:** `orders.html` (cleanest `shell.js` consumer) + the shared module `public/_lib/shell.js`.
**State audited:** `main`. During the audit, PRs **#105 + #106 merged**, migrating `analytics`, `settings`, `settings-business-profile`, `settings-integrations`, `settings-order-policies` to the shared rail. The table below reflects **post-merge `main`**; the "before" state of those five is preserved in the deviation notes (marked `✅ #105/#106`) because it documents the paradigm-split this rollout closed.

---

## 1. Reference standard — what "correct" looks like

`shell.js` is the single source of truth. A correctly-migrated operational page:

1. **Wrapper:** a `.shell` (flex) **or** `.app` (now flex) element whose direct child is a `<main>`.
2. **Import + mount:** `import { renderShell[, mountUserMenu] } from '/_lib/shell.js?v=5';` then `renderShell('<activeKey>'[, { topbar:false }])`.

### 1.1 Left icon rail (the unambiguous, consistent part)
- **60px** fixed rail, `#faf9f7`, injected by `shell.js` (`RAIL_CSS`), cascade-authoritative.
- **8 canonical modules, fixed order:** Dashboard · Orders · Assets · People · Finance · Insights · Communications · **System** (System pinned to the bottom).
- `Finance` + `Communications` are **disabled "coming soon"** (`.ri.soon`, `title` tooltip), no `href`.
- Active item = `renderShell(activeKey)` → `.active` (indigo-soft bg, indigo icon). Keys: `dashboard|orders|assets|people|finance|insights|comms|system`. **Calendar has no key** — it rides `orders` (delinked in F2b-2).
- Every item has a native `title` tooltip. Logo "R" pinned top.

### 1.2 Top-bar — **NOT yet standardized (this is the core finding)**
There are **three different top-bars** among correctly-migrated pages:
- **Canonical (`renderShell` with `topbar:true`)** — used by `people-list`, `person-360`. Contains: a **decorative** search pill (`.tsearch`, a static "Search anything" span + a `⌘K` badge with **no binding**), a **decorative** bell icon (`.iconbtn`, **no drawer, no badge, no wiring**), and a **functional** avatar menu (`#me-initials` → dropdown).
- **Own top-bar + `topbar:false` + `mountUserMenu`** — `dashboard`, `inventory`, `calendar`. Contains a **functional** notification bell + drawer, page actions, and the shared avatar menu.
- **Own top-bar + `topbar:false`, bespoke avatar** — `orders`, `new-order`. Contains a **local filter** search input, **no bell**, and a **bare `#userInitials`** chip with **no dropdown menu**.

Because the reference `orders.html` itself omits the bell and uses a bespoke avatar, there is **no single page that exhibits the full "correct" top-bar**. The rail is standardized; the top-bar is not.

### 1.3 Search
- **No global search exists anywhere.** The shell's `.tsearch` is decorative.
- `dashboard` has the only working **`⌘K` / `/`** shortcut, and it only **focuses its own `#global-search`** input (page-local, not global).
- `orders` (`#q`), `new-order` (product search) have **page-local filter inputs**, unrelated to the shell.

### 1.4 Notification bell
- **Functional (bell + `#notif-drawer` + `#notif-badge`, outside-click close):** `dashboard`, `inventory`, `calendar`, `settings`, `invoice`.
- **Decorative (icon only, no drawer):** the shell canonical top-bar → `people-list`, `person-360`.
- **Absent:** `orders`, `new-order`.

### 1.5 Avatar / account menu
- **Shared dropdown (name/role · System settings · Sign out; closes on Esc/outside-click):** `people-list`, `person-360` (via `renderShell` top-bar) and `dashboard`, `inventory`, `calendar` (via `mountUserMenu`).
- **Bare initials, no menu:** `orders`, `new-order` (`#userInitials`).
- **Sidebar avatar, no menu:** `analytics`, `settings` (pre-migration `sb-user`).

### 1.6 Sub-nav / breadcrumb
- `orders`: `.subnav` "Rentals › Orders" + "Calendar view ›" link.
- `calendar`: top-bar kicker "Orders › Calendar".
- `settings` + sub-pages: left `.settings-nav` column and/or a `.crumb` breadcrumb.
- `order-360`, `order-policies`: `.subnav` breadcrumb only (their **sole** navigation — no rail).

---

## 2. Per-page audit table

| Page | Uses shell.js? | ?v | Icon rail matches? | Top-bar matches? | Search | Bell | Avatar | Deviations |
|------|----------------|----|--------------------|--------------------|--------|------|--------|------------|
| **orders.html** | ✅ | 5 | ✅ canonical | ★ reference (own) | local `#q` | ✗ none | bare initials | Reference. No bell; bare avatar (no menu). |
| **new-order.html** | ✅ | 5 | ✅ canonical | own (topbar:false) | local (products) | ✗ none | bare initials | No bell; bare avatar (no menu). |
| **dashboard.html** | ✅ | 5 | ✅ canonical | own + mountUserMenu | `#global-search` + ⌘K | ✅ drawer | ✅ shared menu | ⌘K focuses local input only. Dead `.sb-*` CSS. |
| **inventory.html** | ✅ | 5 | ✅ canonical | own + mountUserMenu | ✗ | ✅ drawer | ✅ shared menu | Dead `.sb-*` CSS. |
| **calendar.html** | ✅ | 5 | ✅ canonical (`orders`) | own + mountUserMenu | ✗ | ✅ drawer | ✅ shared menu | Dead `.sb-*` CSS. |
| **people-list.html** | ✅ | 5 | ✅ canonical | canonical (topbar:true) | ✗ decorative | ✗ decorative | ✅ shared menu | Shell bell is decorative; `⌘K` badge inert. |
| **person-360.html** | ✅ | 5 | ✅ canonical | canonical (topbar:true) | ✗ decorative | ✗ decorative | ✅ shared menu | Shell bell decorative; `⌘K` badge inert. |
| **analytics.html** | ✅ #105 | 5 | ✅ canonical (`insights`) | own + mountUserMenu | ✗ | ✗ none | ✅ shared menu | ✅ #105 replaced the legacy labeled sidebar. No bell; dead `.sb-*` CSS remains. |
| **settings.html** | ✅ #105 | 5 | ✅ canonical (`system`) | own + mountUserMenu | ✗ | ✅ drawer | ✅ shared menu | ✅ #105 replaced the legacy labeled sidebar. Avatar on `.topbar` (not `#tb-actions`, which JS rewrites). Dead `.sb-*` CSS. |
| **settings-business-profile.html** | ✅ #106 | 5 | ✅ canonical (`system`) | own + `.settings-nav` + mountUserMenu | ✗ | ✗ | ✅ shared menu | ✅ #106 replaced the drifted inline rail (was 6 items, missing Finance/Communications). Dead `.sb` CSS. |
| **settings-integrations.html** | ✅ #106 | 5 | ✅ canonical (`system`) | own + `.settings-nav` + mountUserMenu | ✗ | ✗ | ✅ shared menu | ✅ #106 replaced the drifted inline rail. Dead `.sb` CSS. |
| **settings-order-policies.html** | ✅ #106 | 5 | ✅ canonical (`system`) | ✗ (`.subnav` + avatar) | ✗ | ✗ | ✅ in `.subnav` | ✅ #106 wrapped the bare page in `.shell`. No real top-bar; avatar rides the breadcrumb; fixed savebar underlaps the rail (cosmetic). |
| **order-360.html** | ❌ | – | ✗ **no rail** | ✗ (`.subnav` + `.orderstrip`) | ✗ | ✗ | ✗ | Core order-detail page with **no rail** — sole nav is a back-link. Flagged F2c. |
| **invoice.html** | ❌ | – | ✗ no rail (document) | partial (bell only) | ✗ | ✅ drawer | ✗ | Document view; no rail (arguably intentional) but carries a functional bell. |
| **quote-view.html** | ❌ (correct) | – | n/a (public) | n/a | ✗ | ✗ | ✗ | Public customer page — no shell expected. ✅ |
| **accept-invite.html** | ❌ (correct) | – | n/a (auth) | n/a | ✗ | ✗ | ✗ | Auth page — no shell expected. ✅ |
| **forgot-password.html** | ❌ (correct) | – | n/a (auth) | n/a | ✗ | ✗ | ✗ | Auth page — no shell expected. ✅ |
| **reset-password.html** | ❌ (correct) | – | n/a (auth) | n/a | ✗ | ✗ | ✗ | Auth page — no shell expected. ✅ |

*(`index.html` excluded per scope — sign-in.)*

**Totals:** 18 pages audited · **12 on `shell.js`** (all `?v=5`, after #105/#106 merged) · **1 core page with no rail** (`order-360`) · 4 correctly shell-less (auth + public) · 1 document (`invoice`).

---

## 3. Deviations grouped by severity

### CRITICAL
*None.* No page has a broken/double shell (inline sidebar **and** `shell.js` together), and nothing is user-blocking. The worst cases are missing rails, not broken ones.

### MAJOR
1. **`order-360.html` — no rail on a core page.** The order-detail screen (very high traffic) has only a `.subnav` back-link; you cannot reach any other module from it. **This is now the single most visible remaining rail inconsistency.** *(Deferred as "F2c" — not yet done.)*
2. **Notification bell means three different things.** Same icon renders as: functional drawer (`dashboard`/`inventory`/`calendar`/`settings`/`invoice`), **decorative no-op** (`people-list`/`person-360` via the shell top-bar), or **absent** (`orders`/`new-order`). A tester clicking the bell gets inconsistent results. **This is the top unresolved systemic issue** now that the rail is uniform.

**Resolved during this audit (were MAJOR, fixed by #105/#106 which merged mid-audit):**
- ~~`analytics` / `settings` labeled-232px-sidebar paradigm split~~ → now the canonical rail (#105).
- ~~`settings-business-profile` / `settings-integrations` drifted inline rail (missing Finance/Communications)~~ → now the canonical rail (#106).
- ~~`settings-order-policies` no rail~~ → wrapped in `.shell` (#106).

### MINOR
6. **Search is three unrelated things and none is global.** Decorative shell `.tsearch` (with a `⌘K` badge that does nothing), `dashboard`'s local `#global-search` (only page with a working `⌘K`/`/`), and per-page filter inputs (`orders`/`new-order`).
7. **Avatar menu present on some pages, bare on others.** Shared dropdown on 4 pages; bare `#userInitials` (no menu) on `orders`/`new-order`; sidebar avatar (no menu) on `analytics`/`settings`.
8. **Dead `.sb-*` / `.sb-workspace` CSS** left in every migrated Family-A page (`dashboard`, `inventory`, `calendar`, `analytics`, `settings`) and dead `.sb` rail CSS in the two `.shell` sub-pages. Harmless, pending a cleanup pass.
9. **`invoice.html` carries a functional bell but no rail** — minor mismatch for a document view.
10. **Avatar placement varies** on `topbar:false` pages (after `#tb-actions` on `settings`, in `.subnav` on `order-policies`) — cosmetic, accepted during the rollout.

---

## 4. Interaction pattern inconsistencies

| Interaction | Behavior | Consistent? |
|-------------|----------|-------------|
| **Icon rail expand/collapse** | Never expands — fixed 60px everywhere it exists. | ✅ Consistent (no hover-expand anywhere). |
| **Click notification bell** | Opens `#notif-drawer` (dashboard/inventory/calendar/settings/invoice); **does nothing** (people pages — decorative); **no bell** (orders/new-order). | ❌ Three behaviors. |
| **Click avatar** | Shared dropdown (people/dashboard/inventory/calendar); **nothing** (orders/new-order bare initials; analytics/settings sidebar avatar). | ❌ Inconsistent. |
| **`⌘K` global search** | Works **only on dashboard** (focuses its own input). Elsewhere the `⌘K` badge is shown but inert, or absent. | ❌ Effectively broken as a "global" affordance. |
| **`Esc` closes overlays** | Avatar menu closes on Esc (shell `wireUserMenu`). Notif drawers close on **outside-click**, not verified to close on Esc. | ⚠️ Partial. |
| **Rail active state** | Correct per page via `activeKey`; calendar correctly highlights Orders. | ✅ Consistent. |

---

## 5. Recommendation — pages to fix, in priority order

1. ~~Merge PR #105 + #106~~ — **done (merged mid-audit)**; the 5 sidebar/rail deviations are cleared on `main`.
2. **`order-360.html` → add the rail (F2c).** The single highest-traffic page still without navigation, and now the **only** rail gap. It uses a bespoke `.subnav`/`.orderstrip` layout, so it needs a small wrapper (like `order-policies` got) — do it as its own PR so its detail layout can be checked. **Top priority.**
3. **Standardize the top-bar contract** (the real systemic gap). Decide the canonical set — bell (functional or removed everywhere), search (make the shell `.tsearch` real **or** drop the decorative pill + `⌘K` badge), avatar menu (mount the shared menu on `orders`/`new-order` too). Until decided, the bell/search/avatar will stay a three-way split even on "migrated" pages.
4. **Backfill `mountUserMenu` on `orders` / `new-order`** so every rail page has the same account menu (small, closes MINOR #7).
5. **Dead-CSS cleanup pass** — strip `.sb-*` / `.sb-workspace` blocks from all migrated pages (MINOR #8).
6. **Leave shell-less pages as-is** — `index`, `accept-invite`, `forgot-password`, `reset-password` (auth), `quote-view` (public), and `invoice` (document, minus reconsidering its stray bell) are correctly outside the shell.

**Bottom line:** with #105/#106 merged, the icon **rail** is now consistent across every operational page except **`order-360`** (the one remaining gap). The unfinished work is the **top-bar** — bell, search, and avatar menu still differ across migrated pages and need one deliberate contract.
