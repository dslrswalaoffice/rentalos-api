// ============================================================================
// test/calendar_enhancement.test.ts — Phase 1 completion Session 2.
// ----------------------------------------------------------------------------
// Booking Calendar enhancements: standby visualization (fixes the invisible-bar
// bug), category/location/search filters, view-status chips, and a customer →
// person-360 link. This is an ENHANCEMENT of the shipped calendar (Sub-turn 4b),
// not a rebuild — no migration, no new deps.
//
// Rule A/source — the calendar route accepts the new params (location filter
//   correctly keyed on pickup_location_id, NOT the non-existent orders.location_id),
//   attaches standby metadata + customer_person_id, and search-filters server-side.
// Rule E — the existing response is a superset (new fields are additive); the
//   overbook/downtime paths are untouched.
//
// Rule B (real PG16: category/location/search filter the payload; a standby order
//   returns is_standby=true + expires_at + is_grace_period/is_expiring_soon;
//   backward-compat no-param response) validated SEPARATELY on PostgreSQL 16 —
//   captured in the PR.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost/test';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const calendarRoute = read('../src/routes/calendar.ts');
const calendarHtml = read('../public/calendar.html');

// ---------- backend: new params ----------
test('calendar route — accepts optional category / location_id / search (backward compatible)', () => {
  assert.match(calendarRoute, /category: z\.string\(\)\.trim\(\)\.min\(1\)\.max\(120\)\.optional\(\)/);
  assert.match(calendarRoute, /location_id: z\.string\(\)\.uuid\(\)\.optional\(\)/);
  assert.match(calendarRoute, /search: z\.string\(\)\.trim\(\)\.min\(1\)\.max\(120\)\.optional\(\)/);
  // view_status is deliberately client-side (warnings need the full set).
  assert.doesNotMatch(calendarRoute, /view_status: z\./);
});

test('calendar route — location filter keyed on pickup_location_id (NOT orders.location_id)', () => {
  assert.match(calendarRoute, /o\.pickup_location_id = \$\{location_id \?\? null\}::uuid/);
  assert.doesNotMatch(calendarRoute, /o\.location_id\b/);
});

test('calendar route — category filter on products, COALESCE-null-safe', () => {
  assert.match(calendarRoute, /\$\{category \?\? null\}::text IS NULL OR p\.category = \$\{category \?\? null\}::text/);
});

// ---------- backend: standby metadata ----------
test('calendar route — attaches standby metadata + customer_person_id', () => {
  assert.match(calendarRoute, /is_standby: boolean/);
  assert.match(calendarRoute, /expires_at: string \| null/);
  assert.match(calendarRoute, /is_grace_period: boolean/);
  assert.match(calendarRoute, /is_expiring_soon: boolean/);
  assert.match(calendarRoute, /customer_person_id/);
  // Standby expiry pulled from the standbys table, keyed by order (Slice 4).
  assert.match(calendarRoute, /FROM standbys/);
  assert.match(calendarRoute, /ONE_HOUR_MS/);
});

test('calendar route — search filters products server-side + prunes warnings', () => {
  assert.match(calendarRoute, /if \(search\)/);
  assert.match(calendarRoute, /outWarnings = warnings\.filter/);
});

// ---------- frontend: standby visualization (the bug fix) ----------
test('calendar.html — standby bar CSS (was invisible): hatched + grace + expiring pulse', () => {
  assert.match(calendarHtml, /\.booking-bar\.status-standby\s*\{/);
  assert.match(calendarHtml, /\.booking-bar\.status-standby\.grace-period/);
  assert.match(calendarHtml, /\.booking-bar\.status-standby\.expiring-soon/);
  assert.match(calendarHtml, /@keyframes standbyPulse/);
  // Terminal standby states also get a visible (muted) style — never invisible.
  assert.match(calendarHtml, /status-standby_expired/);
});

// ---------- frontend: filters + chips ----------
test('calendar.html — filter row: view chips + category/location selects + search + date', () => {
  assert.match(calendarHtml, /class="view-chips"/);
  assert.match(calendarHtml, /data-vs="standby"/);
  assert.match(calendarHtml, /data-vs="overdue"/);
  assert.match(calendarHtml, /id="filter-category"/);
  assert.match(calendarHtml, /id="filter-location"/);
  assert.match(calendarHtml, /id="filter-search"/);
  assert.match(calendarHtml, /id="filter-date"/);
});

test('calendar.html — view_status is client-side (render, no refetch); category/search refetch', () => {
  assert.match(calendarHtml, /function matchesViewStatus/);
  assert.match(calendarHtml, /sorted\.filter\(\(b\) => matchesViewStatus\(b, cal\.viewStatus\)\)/);
  // chips re-render without a fetch; server filters trigger loadCalendar.
  assert.match(calendarHtml, /if \(state\.calendar\.range\) render\(\);/);
});

test('calendar.html — URL state persists all new filters', () => {
  assert.match(calendarHtml, /params\.set\('category'/);
  assert.match(calendarHtml, /params\.set\('location_id'/);
  assert.match(calendarHtml, /params\.set\('view_status'/);
  assert.match(calendarHtml, /params\.set\('search'/);
});

// ---------- frontend: customer → person-360 link ----------
test('calendar.html — tooltip customer name links to person-360, interactive', () => {
  assert.match(calendarHtml, /class="tt-cust" href="\/person-360\.html\?id=/);
  assert.match(calendarHtml, /pointer-events: auto/); // tooltip clickable
  assert.match(calendarHtml, /tooltip\.addEventListener\('mouseenter'/); // hover-persist
  // clicking the link must not also open the order.
  assert.match(calendarHtml, /closest\('\.tt-cust'\)/);
});

test('calendar.html — reuses existing endpoints for filter options (DRY, fail-soft)', () => {
  assert.match(calendarHtml, /\/api\/inventory\/categories/);
  assert.match(calendarHtml, /\/api\/locations/);
  // location select shown only for multi-location workspaces.
  assert.match(calendarHtml, /locs\.length > 1/);
});
