// ============================================================================
// test/asset_360_page.test.ts — Asset List S2 (Asset-360 page wiring).
// ----------------------------------------------------------------------------
// Source-level guards (the page needs a live session/DB to render, so like
// order360_quote_card.test.ts these lock the contract): asset-360.html consumes
// the shipped GET /api/inventory/assets/:id endpoint, completes the Assets-view
// "View ->" link, and its actions call the real bulk endpoints. Module JS is
// separately node --check-clean.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('asset-360.html consumes the shipped per-asset endpoint + renders on the assets shell', () => {
  const html = read('../public/asset-360.html');
  assert.match(html, /api\.get\('\/api\/inventory\/assets\/' \+ encodeURIComponent\(id\)\)/);
  assert.match(html, /renderShell\('assets'/);
});

test('asset-360 actions call the real bulk endpoints (single-id)', () => {
  const html = read('../public/asset-360.html');
  assert.match(html, /\/api\/inventory\/assets\/bulk-location-transfer/);
  assert.match(html, /\/api\/inventory\/assets\/bulk-retire/);
});

test('the inventory Assets view "View ->" link now resolves to a real page', () => {
  assert.match(read('../public/inventory.html'), /asset-360\.html\?id=/);
  // the target page exists (would throw if missing)
  assert.ok(read('../public/asset-360.html').length > 0);
});

test('cost-sensitive values render "—" (redaction is transparent to the UI)', () => {
  const html = read('../public/asset-360.html');
  assert.match(html, /fmtINR = \(p\) => \(p == null \? dash/);
});
