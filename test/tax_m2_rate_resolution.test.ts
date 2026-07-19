// ============================================================================
// test/tax_m2_rate_resolution.test.ts — Tax-M2 GST rate resolution
// ----------------------------------------------------------------------------
// resolveLineRateBps is the ONLY place the pricing engine's per-line GST rate
// changed in Tax-M2. These lock in two things:
//   1. PARITY — with tax_policy absent (null), the result is exactly the pre-M2
//      behaviour: `product override ?? workspace default`. No invoice moves until
//      a workspace explicitly configures tax_policy.
//   2. The new precedence when tax_policy IS present, including explicit 0% (e.g.
//      damage recovery configured to 0% — Aamir's call) which must NOT fall
//      through to the default.
// Run: `npm test`
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveLineRateBps } from '../src/lib/pricing.js';

const WS = 1800; // workspace default (18%) in bps

// ── Parity: tax_policy absent → product ?? workspaceDefault ──────────────────
test('parity — no tax_policy: falls back to workspace default', () => {
  assert.equal(resolveLineRateBps({ productRateBps: null, itemType: 'rental', taxPolicy: null, workspaceDefaultBps: WS }), 1800);
});
test('parity — no tax_policy: product override wins', () => {
  assert.equal(resolveLineRateBps({ productRateBps: 1200, itemType: 'rental', taxPolicy: null, workspaceDefaultBps: WS }), 1200);
});
test('parity — no tax_policy: explicit product 0% is respected (not overridden by default)', () => {
  assert.equal(resolveLineRateBps({ productRateBps: 0, itemType: 'rental', taxPolicy: null, workspaceDefaultBps: WS }), 0);
});

// ── Per-line-type rates from tax_policy ─────────────────────────────────────
const POLICY = { line_item_gst_rates_bps: { rental: 1200, damage: 0 }, default_gst_rate_bps: 1800 };

test('per-line-type: rental uses the configured 12%', () => {
  assert.equal(resolveLineRateBps({ productRateBps: null, itemType: 'rental', taxPolicy: POLICY, workspaceDefaultBps: WS }), 1200);
});
test('per-line-type: explicit damage 0% applies (does NOT fall through to default)', () => {
  assert.equal(resolveLineRateBps({ productRateBps: null, itemType: 'damage', taxPolicy: POLICY, workspaceDefaultBps: WS }), 0);
});
test('per-line-type: an item type absent from the map uses tax_policy.default_gst_rate_bps', () => {
  assert.equal(resolveLineRateBps({ productRateBps: null, itemType: 'late_fee', taxPolicy: POLICY, workspaceDefaultBps: WS }), 1800);
});
test('per-line-type: no type rate AND no policy default → workspace default', () => {
  assert.equal(resolveLineRateBps({ productRateBps: null, itemType: 'other', taxPolicy: { line_item_gst_rates_bps: { rental: 1200 } }, workspaceDefaultBps: WS }), WS);
});

// ── Precedence: product override still beats a per-line-type rate ────────────
test('product override wins over a per-line-type rate', () => {
  assert.equal(resolveLineRateBps({ productRateBps: 1500, itemType: 'rental', taxPolicy: POLICY, workspaceDefaultBps: WS }), 1500);
});
