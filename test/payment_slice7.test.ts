// ============================================================================
// test/payment_slice7.test.ts — Slice 7 Session 1 (payment recording UI +
// invoice auto-reconciliation).
// ----------------------------------------------------------------------------
// Rule A — contract tests for the payment / preview / refund schemas.
// Rule E — composition: the new preview + payment-options routes are mounted,
//          the existing payment/refund routes survive, and the payments router
//          carries idempotencyMiddleware at-most-once per path (no double-charge).
//
// Rule B (real DB round-trip: record rental payment -> balance hits zero ->
//         latest 'sent' invoice auto-flips to 'paid'; a refund reopens it) and
//         Rule D (policy toggle auto_mark_paid_on_zero_balance=false suppresses
//         the flip) are validated SEPARATELY against real PostgreSQL 16. See the
//         scratchpad payment_s7_roundtrip.sql.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost/test';
process.env.INTEGRATION_ENC_KEY ??= 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';

import { paymentCreateSchema, paymentPreviewSchema, refundSchema } from '../src/routes/payments.js';

// ---------- Rule A: paymentCreateSchema ----------
test('paymentCreateSchema — defaults kind to rental, requires a positive amount', () => {
  const ok = paymentCreateSchema.safeParse({ amount_paise: 50000, method: 'upi' });
  assert.equal(ok.success, true);
  assert.equal(ok.success && ok.data.payment_kind, 'rental');

  assert.equal(paymentCreateSchema.safeParse({ amount_paise: 0, method: 'cash' }).success, false);
  assert.equal(paymentCreateSchema.safeParse({ amount_paise: -100, method: 'cash' }).success, false);
  assert.equal(paymentCreateSchema.safeParse({ amount_paise: 100, method: 'crypto' }).success, false);
});

test('paymentCreateSchema — accepts deposit kinds + deposit-only metadata', () => {
  const dep = paymentCreateSchema.safeParse({
    amount_paise: 100000, method: 'cheque', payment_kind: 'deposit',
    cheque_status: 'pending', method_reference: { cheque_no: '123456' },
  });
  assert.equal(dep.success, true);
  for (const k of ['deposit', 'deposit_refund', 'deposit_forfeit', 'rental']) {
    assert.equal(paymentCreateSchema.safeParse({ amount_paise: 1, method: 'cash', payment_kind: k }).success, true, k);
  }
  // an unknown cheque_status is rejected.
  assert.equal(paymentCreateSchema.safeParse({ amount_paise: 1, method: 'cheque', payment_kind: 'deposit', cheque_status: 'nope' }).success, false);
});

// ---------- Rule A: paymentPreviewSchema ----------
test('paymentPreviewSchema — mirrors the record contract, kind defaults to rental', () => {
  const p = paymentPreviewSchema.safeParse({ amount_paise: 25000, method: 'card' });
  assert.equal(p.success, true);
  assert.equal(p.success && p.data.payment_kind, 'rental');
  assert.equal(paymentPreviewSchema.safeParse({ amount_paise: 25000 }).success, false); // method required
  assert.equal(paymentPreviewSchema.safeParse({ amount_paise: 0, method: 'card' }).success, false);
});

// ---------- Rule A: refundSchema ----------
test('refundSchema — positive amount + known method', () => {
  assert.equal(refundSchema.safeParse({ amount_paise: 5000, method: 'upi' }).success, true);
  assert.equal(refundSchema.safeParse({ amount_paise: 0, method: 'upi' }).success, false);
  assert.equal(refundSchema.safeParse({ amount_paise: 5000, method: 'giftcard' }).success, false);
});

// ---------- Rule E: composition ----------
const { app } = await import('../src/app.js');
const { idempotencyMiddleware } = await import('../src/lib/idempotency.js');
const routes = (app as any).routes as Array<{ method: string; path: string; handler: unknown }>;
const paths = new Set(routes.map((r) => r.path));

test('Rule E — new preview + payment-options routes are mounted', () => {
  assert.ok(paths.has('/api/order-payments/:orderId/preview'), 'preview route missing');
  assert.ok(paths.has('/api/order-payments/:orderId/payment-options'), 'payment-options route missing');
});
test('Rule E — existing payment record/list/refund routes survive', () => {
  assert.ok(paths.has('/api/order-payments/:orderId'), 'record/list route');
  assert.ok(paths.has('/api/order-payments/:orderId/:paymentId'), 'delete route');
  assert.ok(paths.has('/api/order-payments/:orderId/:paymentId/refund'), 'refund route');
});
test('Rule E — idempotencyMiddleware is at-most-once per payment path (no double-charge)', () => {
  const byPath = new Map<string, number>();
  for (const r of routes) if (r.handler === idempotencyMiddleware) byPath.set(r.path, (byPath.get(r.path) ?? 0) + 1);
  assert.deepEqual([...byPath.entries()].filter(([, n]) => n > 1), []);
  // and it IS present on the payments mount.
  const onPayments = [...byPath.keys()].some((p) => p.startsWith('/api/order-payments'));
  assert.ok(onPayments, 'idempotencyMiddleware not applied to /api/order-payments');
});
