// ============================================================================
// test/late_fee_slice.test.ts — Phase 1 completion Session 1 (late-return fee).
// ----------------------------------------------------------------------------
// Rule A — the pure calculation helpers (description + per-hour rate) are exact,
//   and the two endpoints + Zod schema exist with the orders.edit gate.
// Rule E/source — migration 069 seeds the policy + notification event/template;
//   returns.ts attaches the suggest-only proposal to /complete; the apply path
//   audits as orders.item.added with a late_fee payload flag (sub-variant
//   convention, no new event_type); invoice_pdf is intentionally untouched (the
//   rich description is baked at line-creation and rendered from the snapshot).
//
// Rule B (real PG16: within-grace => no fee; past grace => computed fee > 0; apply
//   inserts a late_fee line, recomputes the order total, and revises an issued
//   invoice) validated SEPARATELY against PostgreSQL 16 — captured in the PR.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost/test';

import { renderLateFeeDescription, lateFeeHourlyRatePaise } from '../src/lib/late_fee_lifecycle.js';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const lifecycle = read('../src/lib/late_fee_lifecycle.ts');
const ordersRoute = read('../src/routes/orders.ts');
const returnsRoute = read('../src/routes/returns.ts');
const migration = read('../migrations/069_late_fee_slice.sql');
const invoicePdf = read('../src/lib/invoice_pdf.ts');
const returnHtml = read('../public/return.html');
const order360 = read('../public/order-360.html');

// ---------- Rule A — pure calculation ----------
test('lateFeeHourlyRatePaise — daily ₹2400 @ 10%/hr = ₹10/hr (240000 -> 1000 paise)', () => {
  assert.equal(lateFeeHourlyRatePaise(240000, 10), 1000);
});

test('lateFeeHourlyRatePaise — scales linearly with percent', () => {
  assert.equal(lateFeeHourlyRatePaise(240000, 15), 1500); // Rule D: policy percent change
  assert.equal(lateFeeHourlyRatePaise(240000, 0), 0);
});

test('formula — 1 billable hour on a ₹2400/day product at 10% is ₹10', () => {
  // Rule F: returned 3h late, grace 2 -> 1 billable hour. fee = 1 * (240000/24) * 0.10 = 1000 paise.
  const perHour = lateFeeHourlyRatePaise(240000, 10);
  assert.equal(perHour * 1, 1000);
  assert.equal(perHour * 3, 3000); // 5h late, grace 2 -> 3 billable -> ₹30
});

test('renderLateFeeDescription — includes billable hours + effective rate', () => {
  assert.equal(renderLateFeeDescription(1, 1000), 'Late return fee — 1 hour(s) late (₹10/hr)');
  // No rate (custom/overridden amount) => hours only, never a misleading rate.
  assert.equal(renderLateFeeDescription(3, null), 'Late return fee — 3 hour(s) late');
  assert.equal(renderLateFeeDescription(0, 0), 'Late return fee — 0 hour(s) late');
});

// ---------- Rule A — endpoints + validation ----------
test('orders.ts — suggest + apply endpoints exist, orders.edit gated', () => {
  assert.match(ordersRoute, /orders\.post\('\/:id\/late-fee\/suggest', requirePermission\('orders\.edit'\)/);
  assert.match(ordersRoute, /orders\.post\('\/:id\/late-fee', requirePermission\('orders\.edit'\)/);
  assert.match(ordersRoute, /lateFeeApplySchema = z\.object/);
  assert.match(ordersRoute, /amount_paise: z\.number\(\)\.int\(\)\.positive\(\)/);
  assert.match(ordersRoute, /import \{ computeLateFeeAtReturn, applyLateFeeToOrder \}/);
});

// ---------- Rule E/source — lifecycle wiring ----------
test('late_fee_lifecycle — reuses recompute + invoice-revision + notification, no new table', () => {
  assert.match(lifecycle, /recomputeOrderTotals/);
  assert.match(lifecycle, /generateInvoice/);
  assert.match(lifecycle, /emitCustomerNotification/);
  assert.match(lifecycle, /bypassReadiness: true/);
  assert.match(lifecycle, /'late_fee'::order_item_type/);
  assert.doesNotMatch(lifecycle, /CREATE TABLE|INSERT INTO late_fees/);
});

test('audit — apply uses orders.item.added with a late_fee payload flag (sub-variant convention)', () => {
  assert.match(lifecycle, /eventType: 'orders\.item\.added'/);
  assert.match(lifecycle, /late_fee: true/);
  assert.match(lifecycle, /event_type, payload, actor_user_id/); // order_events timeline row too
});

test('returns.ts — /complete attaches a suggest-only late-fee proposal', () => {
  assert.match(returnsRoute, /computeLateFeeAtReturn/);
  assert.match(returnsRoute, /late_fee_suggestion: lateFeeSuggestion/);
});

// ---------- migration 069 ----------
test('migration 069 — seeds policy percent + notification event + template (idempotent)', () => {
  assert.match(migration, /late_return_fee_per_hour_percent/);
  assert.match(migration, /'order\.late_fee_applied'/);
  assert.match(migration, /jsonb_build_object\('mode', 'auto', 'is_marketing', false\)/);
  // Top-level {notification_policy} merge (avoids the missing-parent jsonb_set gotcha).
  assert.match(migration, /'\{notification_policy\}'/);
  assert.match(migration, /'\{dispatch_return_policy\}'/);
  // WhatsApp seeded null (043 convention — operator supplies the approved name).
  assert.match(migration, /'template_name', NULL, 'variable_order', NULL/);
});

// ---------- invoice_pdf untouched (description baked at creation) ----------
test('invoice_pdf — renders line description verbatim, no late_fee special-casing', () => {
  assert.match(invoicePdf, /li\.description/);
  assert.doesNotMatch(invoicePdf, /late_fee/);
});

// ---------- frontend surfaces ----------
test('return.html — suggest card with Apply / Custom / Skip', () => {
  assert.match(returnHtml, /lateFeeCard/);
  assert.match(returnHtml, /lf-apply/);
  assert.match(returnHtml, /lf-skip/);
  assert.match(returnHtml, /\/api\/orders\/'\+S\.r\.order_id\+'\/late-fee/);
});

test('order-360.html — overflow action + modal + Financial timeline + charges line', () => {
  assert.match(order360, /data-ov="late-fee"/);
  assert.match(order360, /function openLateFeeModal/);
  assert.match(order360, /I confirm this late fee is authorized/);
  assert.match(order360, /late_fee/); // eventMeta Financial + eventLabel + charges group
});
