// ============================================================================
// test/deposit_slice7_s2.test.ts — Slice 7 Session 2 (deposit auto-release +
// release/forfeit lifecycle + notification templates).
// ----------------------------------------------------------------------------
// Rule A — contract test for the mark-complete schema.
// Rule D/E — autoReleaseEnabled policy resolution: deposit_policy is the source
//            of truth, with a legacy dispatch_return_policy fallback (the Q1
//            deprecation window). Toggling the flag changes the outcome.
// Rule E — composition: the new /complete route is mounted, the existing payment
//          routes survive, and idempotencyMiddleware stays at-most-once per path.
//
// Rule B (real DB round-trip: inspection pass -> pending deposit_refund created
//         -> mark complete -> deposit_status 'released'; policy off -> no payment;
//         legacy fallback still fires) is validated SEPARATELY against real
//         PostgreSQL 16. See the scratchpad deposit_s7s2_roundtrip.sql.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost/test';
process.env.INTEGRATION_ENC_KEY ??= 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';

import { completeSchema } from '../src/routes/payments.js';
import { autoReleaseEnabled } from '../src/lib/deposit_lifecycle.js';

// ---------- Rule A: completeSchema ----------
test('completeSchema — optional positive amount + notes', () => {
  assert.equal(completeSchema.safeParse({}).success, true);                      // no adjust
  assert.equal(completeSchema.safeParse({ amount_paise: 50000 }).success, true);
  assert.equal(completeSchema.safeParse({ amount_paise: 0 }).success, false);
  assert.equal(completeSchema.safeParse({ amount_paise: -1 }).success, false);
  assert.equal(completeSchema.safeParse({ notes: 'settled via NEFT' }).success, true);
});

// ---------- Rule D/E: policy resolution + legacy fallback ----------
test('autoReleaseEnabled — deposit_policy is the source of truth', () => {
  assert.equal(autoReleaseEnabled({ deposit_policy: { auto_release_on_inspection_pass: true } }), true);
  assert.equal(autoReleaseEnabled({ deposit_policy: { auto_release_on_inspection_pass: false } }), false);
});
test('autoReleaseEnabled — deposit_policy=false wins even if legacy=true', () => {
  assert.equal(autoReleaseEnabled({
    deposit_policy: { auto_release_on_inspection_pass: false },
    dispatch_return_policy: { auto_release_deposit_on_inspection_pass: true },
  }), false);
});
test('autoReleaseEnabled — legacy fallback when the new key is absent (deprecation window)', () => {
  assert.equal(autoReleaseEnabled({ dispatch_return_policy: { auto_release_deposit_on_inspection_pass: true } }), true);
  assert.equal(autoReleaseEnabled({ dispatch_return_policy: { auto_release_deposit_on_inspection_pass: false } }), false);
});
test('autoReleaseEnabled — default false when neither key present', () => {
  assert.equal(autoReleaseEnabled({}), false);
  assert.equal(autoReleaseEnabled(null), false);
});

// ---------- Rule E: composition ----------
const { app } = await import('../src/app.js');
const { idempotencyMiddleware } = await import('../src/lib/idempotency.js');
const routes = (app as any).routes as Array<{ method: string; path: string; handler: unknown }>;
const paths = new Set(routes.map((r) => r.path));

test('Rule E — mark-complete route mounted; existing payment routes survive', () => {
  assert.ok(paths.has('/api/order-payments/:orderId/:paymentId/complete'), 'complete route missing');
  assert.ok(paths.has('/api/order-payments/:orderId'), 'record/list route');
  assert.ok(paths.has('/api/order-payments/:orderId/:paymentId/refund'), 'refund route');
  assert.ok(paths.has('/api/order-payments/:orderId/payment-options'), 'payment-options route');
  assert.ok(paths.has('/api/inspections/:inspectionId/complete'), 'inspection complete (auto-release caller)');
});
test('Rule E — idempotencyMiddleware at-most-once per payment path', () => {
  const byPath = new Map<string, number>();
  for (const r of routes) if (r.handler === idempotencyMiddleware) byPath.set(r.path, (byPath.get(r.path) ?? 0) + 1);
  assert.deepEqual([...byPath.entries()].filter(([, n]) => n > 1), []);
});
