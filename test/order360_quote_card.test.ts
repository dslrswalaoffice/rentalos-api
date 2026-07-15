// ============================================================================
// test/order360_quote_card.test.ts
// ----------------------------------------------------------------------------
// Empty-state regression for the Sub-slice 2.2 hotfix (Bug 1): the Quote
// Versions card did not render in Order 360 for an order with zero
// quote_versions rows (production repro: order #21, status 'quoted'). Root
// cause: the card was gated on `S.quotes.length`.
//
// Guards, both directions of the contract:
//  1. Backend GET /api/orders/:id always returns `quote_versions` as an array
//     (it maps a query() result, which is [] when empty — never null/absent).
//  2. Frontend order-360.html renders the Quote Versions card UNCONDITIONALLY
//     and offers a "Create v1" empty state.
//
// These are source-level assertions because the endpoint needs a live DB/auth
// (the functional render is verified separately via headless dump-dom, captured
// in the PR). If someone re-gates the card or drops the array, CI fails here.
//
// Run: `npm test`
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

test('GET /api/orders/:id response always includes quote_versions as an array', () => {
  const src = read('../src/routes/orders.ts');
  // The detail payload maps quote_versions from a query() result. query() returns
  // Row[] (empty array when no rows) — so the key is always an array, never null.
  assert.match(src, /quote_versions:\s*quoteRows/);
  assert.match(src, /const\s*\[\s*standbyRows\s*,\s*quoteRows\s*\]\s*=\s*await\s+Promise\.all/);
  // And quoteRows is a query() over quote_versions (guarantees an array).
  assert.match(src, /FROM quote_versions WHERE order_id/);
});

test('order-360.html renders the Quote Versions card unconditionally (not gated on length)', () => {
  const html = read('../public/order-360.html');
  // The card() call for quotes must NOT be preceded by an `if(S.quotes...length)` gate.
  const gated = /if\s*\(\s*S\.quotes\s*&&\s*S\.quotes\.length\s*\)\s*main\s*\+=\s*card\('quotes'/;
  assert.ok(!gated.test(html), 'Quote Versions card is still gated on S.quotes.length — it must render for empty orders');
  // The card is emitted for every order.
  assert.match(html, /main\s*\+=\s*card\('quotes'[^\n]*cardQuotes\(\)\)/);
});

test('order-360.html Quote Versions empty state offers a "Create v1" action', () => {
  const html = read('../public/order-360.html');
  assert.match(html, /No versions yet/);
  assert.match(html, /Create v1/);
  // The empty-state button triggers the create-version action.
  assert.match(html, /data-qact="revise"[^>]*>[^<]*Create v1|Create v1[\s\S]{0,40}data-qact="revise"/);
});
