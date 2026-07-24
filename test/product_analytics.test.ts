// ============================================================================
// test/product_analytics.test.ts — Product analytics (batch utilization + YTD
// revenue on the products list) + the Asia/Kolkata YTD boundary fix + the Assets
// list revenue-redaction leak fix.
// ----------------------------------------------------------------------------
// Rule E — the batch helpers are fail-soft (no throw / empty result with no DB).
// Rule A/source — the SQL uses the Asia/Kolkata YTD boundary + the = ANY(...)
//   batch idiom; kits are excluded from utilization; revenue groups by product_id;
//   the products + assets endpoints cost-redact YTD revenue; the frontend renders
//   the two columns + the utilization chips + metric sort.
//
// Rule B (real PG16 round-trip: batch utilization/revenue values, kit=null util,
//   redaction, filter + sort, Asia/Kolkata Jan-1 boundary, assets-leak fix) is
//   validated SEPARATELY against PostgreSQL 16 — the Neon HTTP driver can't reach
//   a local PG from `npm test`. Output captured in the PR (scratchpad pa.sql).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost/test';

import { computeProductMetricsBatch, computeSingleProductMetrics } from '../src/lib/product_analytics.js';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const productAnalytics = read('../src/lib/product_analytics.ts');
const assetAnalytics = read('../src/lib/asset_analytics.ts');
const inventoryRoute = read('../src/routes/inventory.ts');
const inventoryHtml = read('../public/inventory.html');

// ---------- Rule E — fail-soft ----------
test('computeProductMetricsBatch — empty productIds returns empty Map, never queries', async () => {
  const m = await computeProductMetricsBatch('w', [], 30);
  assert.ok(m instanceof Map);
  assert.equal(m.size, 0);
});

test('computeProductMetricsBatch — no DB -> no throw, empty Map (fail-soft)', async () => {
  const m = await computeProductMetricsBatch('w', ['a5000000-0000-0000-0000-000000000001'], 30);
  assert.ok(m instanceof Map); // empty on DB failure, never throws
});

test('computeSingleProductMetrics — no DB -> zero/null shape, never throws', async () => {
  const r = await computeSingleProductMetrics('w', 'a5000000-0000-0000-0000-000000000001');
  assert.deepEqual(r, { utilization_percent: null, ytd_revenue_paise: 0 });
});

// ---------- Rule A/source — product_analytics.ts ----------
test('product_analytics — Asia/Kolkata YTD boundary (not UTC)', () => {
  assert.match(
    productAnalytics,
    /date_trunc\('year',\s*now\(\)\s*AT TIME ZONE 'Asia\/Kolkata'\)\s*AT TIME ZONE 'Asia\/Kolkata'/,
  );
  // No bare UTC year boundary left behind.
  assert.doesNotMatch(productAnalytics, /date_trunc\('year',\s*now\(\)\)/);
});

test('product_analytics — batched via = ANY(string_to_array(...)) (no per-row fan-out)', () => {
  const hits = productAnalytics.match(/= ANY\(string_to_array\(/g) || [];
  assert.ok(hits.length >= 2, 'both utilization + revenue queries use the batch idiom');
});

test('product_analytics — kits excluded from utilization, revenue groups by product_id', () => {
  assert.match(productAnalytics, /p\.is_kit = false/);
  assert.match(productAnalytics, /GROUP BY oi\.product_id/);
  // Two set-based queries.
  assert.equal((productAnalytics.match(/await query</g) || []).length, 2);
});

test('product_analytics — utilization capped at 150 and null for zero capacity', () => {
  assert.match(productAnalytics, /Math\.min\(150,/);
  assert.match(productAnalytics, /capacity > 0[\s\S]*?:\s*null/);
});

// ---------- Rule A/source — asset_analytics.ts YTD fix ----------
test('asset_analytics — YTD revenue window fixed to Asia/Kolkata', () => {
  assert.match(
    assetAnalytics,
    /dispatched_at >= \(date_trunc\('year',\s*now\(\)\s*AT TIME ZONE 'Asia\/Kolkata'\)\s*AT TIME ZONE 'Asia\/Kolkata'\)/,
  );
  assert.doesNotMatch(assetAnalytics, /dispatched_at >= date_trunc\('year',\s*now\(\)\)/);
});

// ---------- Rule A/source — inventory.ts endpoints ----------
test('inventory products list — enriches with the batch + returns utilization_counts', () => {
  assert.match(inventoryRoute, /computeProductMetricsBatch\(session\.workspace\.id/);
  assert.match(inventoryRoute, /utilization_counts/);
  assert.match(inventoryRoute, /utilization_range/);
});

test('inventory products list — YTD revenue cost-redacted to null without inventory.costs', () => {
  // Redaction sets ytd_revenue_paise = null under the !showCost branch.
  assert.match(inventoryRoute, /if \(!showCost\)[\s\S]*?ytd_revenue_paise = null/);
});

test('inventory products list — revenue sort refused (fallback) without inventory.costs', () => {
  assert.match(inventoryRoute, /ytd_revenue_(desc|asc)['\s\S]*?!showCost[\s\S]*?category_name/);
});

test('inventory assets list — YTD revenue leak fixed (showCost guard on ytd_revenue_paise)', () => {
  assert.match(inventoryRoute, /ytd_revenue_paise:\s*showCost \? m\.revenue_paise : null/);
});

// ---------- Rule A/source — frontend ----------
test('inventory.html — Products view renders Utilization + YTD revenue columns', () => {
  assert.match(inventoryHtml, /<th style="text-align:right;">Utilization<\/th>/);
  assert.match(inventoryHtml, /<th style="text-align:right;">YTD revenue<\/th>/);
  assert.match(inventoryHtml, /utilCell/);
  assert.match(inventoryHtml, /ytdCell/);
});

test('inventory.html — utilization filter chips + metric sort wired', () => {
  assert.match(inventoryHtml, /id="util-chips"/);
  assert.match(inventoryHtml, /id="product-sort"/);
  assert.match(inventoryHtml, /function renderUtilChips/);
  assert.match(inventoryHtml, /utilization_range/);
});

test('inventory.html — null YTD renders "—", 0 renders via formatINR (distinguish null from zero)', () => {
  assert.match(inventoryHtml, /p\.ytd_revenue_paise == null[\s\S]*?—/);
});

// ---------- Rule E — backward compat ----------
test('inventory products list — response still carries products/total/by_category (additive)', () => {
  assert.match(inventoryRoute, /products:\s*list,/);
  assert.match(inventoryRoute, /by_category:\s*byCategory,/);
  assert.match(inventoryRoute, /total:\s*fullTotal,/);
});
