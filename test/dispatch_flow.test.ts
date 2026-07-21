// ============================================================================
// test/dispatch_flow.test.ts — Slice 4 Session 1 (Phase 3 backend).
// ----------------------------------------------------------------------------
// Rule A — contract tests: every exported Zod schema parses the valid shape and
//          rejects the invalid ones (the exact bodies the dispatch UI will POST).
// Rule E — backward-compat / composition: the REAL assembled app still exposes
//          the legacy POST /api/orders/:id/dispatch (Sub-turn 12b) AND the new
//          dispatch routes, with idempotencyMiddleware still at-most-once per
//          path (my order-scoped fold must not double-mount it).
//
// Rule B (real DB round-trip) is validated SEPARATELY against real PostgreSQL 16
// (the node:test harness never connects — neon() is HTTP-only + lazy, DATABASE_URL
// is a dummy). See the Phase 3 report / scratchpad round-trip script.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost/test';
process.env.INTEGRATION_ENC_KEY ??= 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';

import {
  dispatchCreateSchema, recipientSchema, photoSchema,
  otpSendSchema, otpVerifySchema, otpSkipSchema, signatureSchema,
} from '../src/routes/dispatches.js';

// ---------- Rule A: dispatchCreateSchema ----------
test('dispatchCreateSchema — empty body OK (recipient optional at open)', () => {
  assert.equal(dispatchCreateSchema.safeParse({}).success, true);
  assert.equal(dispatchCreateSchema.safeParse({ recipient_type: 'delegate' }).success, true);
});
test('dispatchCreateSchema — bad recipient_type rejects', () => {
  assert.equal(dispatchCreateSchema.safeParse({ recipient_type: 'nobody' }).success, false);
});

// ---------- Rule A: recipientSchema ----------
test('recipientSchema — customer recipient parses', () => {
  assert.equal(recipientSchema.safeParse({ recipient_type: 'customer' }).success, true);
});
test('recipientSchema — delegate requires name + phone', () => {
  assert.equal(recipientSchema.safeParse({ recipient_type: 'delegate' }).success, false);
  assert.equal(
    recipientSchema.safeParse({ recipient_type: 'delegate', delegate_name: 'Riya', delegate_phone: '+919812345678', delegate_relationship: 'assistant' }).success,
    true,
  );
});
test('recipientSchema — bad delegate_relationship rejects', () => {
  assert.equal(
    recipientSchema.safeParse({ recipient_type: 'delegate', delegate_name: 'X', delegate_phone: '+91', delegate_relationship: 'spouse' }).success,
    false,
  );
});

// ---------- Rule A: photoSchema ----------
test('photoSchema — valid equipment photo parses', () => {
  assert.equal(
    photoSchema.safeParse({ photo_type: 'equipment', photo_base64: 'data:image/jpeg;base64,AAAA', order_item_id: '11111111-1111-1111-1111-111111111111' }).success,
    true,
  );
});
test('photoSchema — bad photo_type + missing base64 reject', () => {
  assert.equal(photoSchema.safeParse({ photo_type: 'selfie', photo_base64: 'AAAAAAAAAAAAAAAA' }).success, false);
  assert.equal(photoSchema.safeParse({ photo_type: 'equipment' }).success, false);
});
test('photoSchema — non-uuid order_item_id rejects', () => {
  assert.equal(photoSchema.safeParse({ photo_type: 'equipment', photo_base64: 'AAAAAAAAAAAAAAAA', order_item_id: 'not-a-uuid' }).success, false);
});

// ---------- Rule A: otp schemas ----------
test('otpSendSchema — channel optional / enum', () => {
  assert.equal(otpSendSchema.safeParse({}).success, true);
  assert.equal(otpSendSchema.safeParse({ channel: 'whatsapp' }).success, true);
  assert.equal(otpSendSchema.safeParse({ channel: 'pigeon' }).success, false);
});
test('otpVerifySchema — 6-digit code parses, non-numeric rejects', () => {
  assert.equal(otpVerifySchema.safeParse({ code: '123456' }).success, true);
  assert.equal(otpVerifySchema.safeParse({ code: '12ab' }).success, false);
  assert.equal(otpVerifySchema.safeParse({ code: '1' }).success, false);
});
test('otpSkipSchema — reason required', () => {
  assert.equal(otpSkipSchema.safeParse({ skip_reason: 'customer offline' }).success, true);
  assert.equal(otpSkipSchema.safeParse({}).success, false);
  assert.equal(otpSkipSchema.safeParse({ skip_reason: '' }).success, false);
});

// ---------- Rule A: signatureSchema ----------
test('signatureSchema — digital_draw parses, bad type rejects', () => {
  assert.equal(signatureSchema.safeParse({ signature_type: 'digital_draw', signature_base64: 'data:image/png;base64,AAAA' }).success, true);
  assert.equal(signatureSchema.safeParse({ signature_type: 'thumbprint', signature_base64: 'data:image/png;base64,AAAA' }).success, false);
});

// ---------- Rule E: composition + backward-compat ----------
const { app } = await import('../src/app.js');
const { idempotencyMiddleware } = await import('../src/lib/idempotency.js');
const routes = (app as any).routes as Array<{ method: string; path: string; handler: unknown }>;
const paths = new Set(routes.map((r) => r.path));

test('Rule E — legacy POST /api/orders/:id/dispatch still registered (12b untouched)', () => {
  assert.ok(paths.has('/api/orders/:id/dispatch'), 'legacy batch-dispatch route must survive');
});
test('Rule E — new dispatch routes are mounted', () => {
  assert.ok(paths.has('/api/orders/:orderId/dispatches'), 'order-scoped create-dispatch route');
  assert.ok([...paths].some((p) => p.startsWith('/api/dispatches/:dispatchId/')), 'id-scoped capture routes');
  for (const suffix of ['recipient', 'photos', 'otp', 'otp/verify', 'otp/skip', 'signature', 'complete']) {
    assert.ok(paths.has(`/api/dispatches/:dispatchId/${suffix}`), `missing route: ${suffix}`);
  }
});
test('Rule E — idempotencyMiddleware still at-most-once per path (fold did not double-mount)', () => {
  const byPath = new Map<string, number>();
  for (const r of routes) if (r.handler === idempotencyMiddleware) byPath.set(r.path, (byPath.get(r.path) ?? 0) + 1);
  const doubled = [...byPath.entries()].filter(([, n]) => n > 1);
  assert.deepEqual(doubled, [], `idempotency double-mounted on: ${doubled.map(([p]) => p).join(', ')}`);
});
