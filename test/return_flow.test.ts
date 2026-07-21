// ============================================================================
// test/return_flow.test.ts — Slice 5 Session 1 (return + inspection routing).
// ----------------------------------------------------------------------------
// Rule A — contract tests: the exported Zod schemas parse valid bodies + reject
//          invalid ones (the exact bodies the return UI + inspection modal POST).
// Rule E — composition / backward-compat: the assembled app exposes the new
//          return + inspection routes AND the legacy POST /api/orders/:id/return
//          (now backed by the SHARED commitReturnToPhysicalState), with
//          idempotencyMiddleware still at-most-once per path.
//
// Rule B (real DB round-trip through commitReturnToPhysicalState + inspection-hold
//         downtimes + inspection pass/fail_major disposition) and Rule D (per-type
//         return photo policy) are validated SEPARATELY against real PostgreSQL 16
//         (neon() is HTTP-only + lazy; DATABASE_URL is a dummy here). See the Phase
//         report / scratchpad return_s1_roundtrip.sql.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost/test';
process.env.INTEGRATION_ENC_KEY ??= 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';

import {
  returnCreateSchema, recipientSchema, itemsChecklistSchema, serialSchema,
  conditionSchema, missingAccessoriesSchema, photoSchema, otpVerifySchema,
  signatureSchema, completeSchema, CONDITION_IN_VALUES,
} from '../src/routes/returns.js';
import {
  completeSchema as inspectionCompleteSchema, scheduleSchema, INSPECTION_RESULTS,
} from '../src/routes/inspections.js';

// ---------- Rule A: returns schemas ----------
test('returnCreateSchema — empty body OK; bad recipient rejects', () => {
  assert.equal(returnCreateSchema.safeParse({}).success, true);
  assert.equal(returnCreateSchema.safeParse({ recipient_type: 'ghost' }).success, false);
});
test('recipientSchema — delegate requires name + phone', () => {
  assert.equal(recipientSchema.safeParse({ recipient_type: 'customer' }).success, true);
  assert.equal(recipientSchema.safeParse({ recipient_type: 'delegate' }).success, false);
  assert.equal(recipientSchema.safeParse({ recipient_type: 'delegate', delegate_name: 'Riya', delegate_phone: '+9198', delegate_relationship: 'driver' }).success, true);
});
test('itemsChecklistSchema — non-empty uuid array', () => {
  assert.equal(itemsChecklistSchema.safeParse({ item_ids: ['11111111-1111-1111-1111-111111111111'] }).success, true);
  assert.equal(itemsChecklistSchema.safeParse({ item_ids: [] }).success, false);
});
test('serialSchema — captured_serial required; override optional', () => {
  assert.equal(serialSchema.safeParse({ captured_serial: 'NL-01' }).success, true);
  assert.equal(serialSchema.safeParse({ captured_serial: 'X', override: true }).success, true);
  assert.equal(serialSchema.safeParse({}).success, false);
});
test('conditionSchema — 5 return conditions incl. missing', () => {
  for (const v of CONDITION_IN_VALUES) assert.equal(conditionSchema.safeParse({ condition: v }).success, true);
  assert.ok(CONDITION_IN_VALUES.includes('missing'));
  assert.equal(conditionSchema.safeParse({ condition: 'exploded' }).success, false);
});
test('missingAccessoriesSchema — free-text notes', () => {
  assert.equal(missingAccessoriesSchema.safeParse({ notes: 'Rear cap missing, strap present' }).success, true);
  assert.equal(missingAccessoriesSchema.safeParse({}).success, false);
});
test('photoSchema — 4 return photo types', () => {
  for (const t of ['equipment', 'serial', 'condition_front', 'condition_back']) {
    assert.equal(photoSchema.safeParse({ photo_type: t, photo_base64: 'data:image/jpeg;base64,AAAA' }).success, true);
  }
  assert.equal(photoSchema.safeParse({ photo_type: 'xray', photo_base64: 'data:image/jpeg;base64,AAAA' }).success, false);
});
test('otpVerifySchema — numeric code', () => {
  assert.equal(otpVerifySchema.safeParse({ code: '482913' }).success, true);
  assert.equal(otpVerifySchema.safeParse({ code: 'ab' }).success, false);
});
test('signatureSchema — captured needs type+base64; skip does not', () => {
  assert.equal(signatureSchema.safeParse({ signature_type: 'digital_draw', signature_base64: 'data:image/png;base64,AAAA' }).success, true);
  assert.equal(signatureSchema.safeParse({ signature_type: 'digital_draw' }).success, false);
  assert.equal(signatureSchema.safeParse({ skipped: true, skip_reason: 'customer left' }).success, true);
});
test('completeSchema — optional item_ids', () => {
  assert.equal(completeSchema.safeParse({}).success, true);
  assert.equal(completeSchema.safeParse({ item_ids: ['bad'] }).success, false);
});

// ---------- Rule A: inspections schemas ----------
test('inspection completeSchema — only pass/fail_minor/fail_major', () => {
  for (const r of INSPECTION_RESULTS) assert.equal(inspectionCompleteSchema.safeParse({ result: r }).success, true);
  assert.equal(inspectionCompleteSchema.safeParse({ result: 'catastrophe' }).success, false);
  assert.equal(inspectionCompleteSchema.safeParse({}).success, false);
});
test('inspection scheduleSchema — datetime + optional inspector', () => {
  assert.equal(scheduleSchema.safeParse({ scheduled_for: '2026-08-01T10:00:00Z' }).success, true);
  assert.equal(scheduleSchema.safeParse({}).success, true);
  assert.equal(scheduleSchema.safeParse({ scheduled_for: 'tomorrow' }).success, false);
});

// ---------- Rule E: composition + backward-compat ----------
const { app } = await import('../src/app.js');
const { idempotencyMiddleware } = await import('../src/lib/idempotency.js');
const routes = (app as any).routes as Array<{ method: string; path: string; handler: unknown }>;
const paths = new Set(routes.map((r) => r.path));

test('Rule E — legacy POST /api/orders/:id/return still registered (via shared helper)', () => {
  assert.ok(paths.has('/api/orders/:id/return'), 'legacy batch-return route must survive the DRY refactor');
});
test('Rule E — order-scoped create-return folded into orders router', () => {
  assert.ok(paths.has('/api/orders/:orderId/returns'), 'order-scoped create-return route');
});
test('Rule E — id-scoped return capture routes mounted', () => {
  for (const suffix of ['recipient', 'items', 'items/:itemId/serial', 'items/:itemId/condition', 'items/:itemId/missing-accessories', 'photos', 'otp', 'otp/verify', 'otp/skip', 'signature', 'complete']) {
    assert.ok(paths.has(`/api/returns/:returnId/${suffix}`), `missing return route: ${suffix}`);
  }
});
test('Rule E — inspection routes mounted', () => {
  for (const suffix of ['start', 'complete', 'schedule']) {
    assert.ok(paths.has(`/api/inspections/:inspectionId/${suffix}`), `missing inspection route: ${suffix}`);
  }
});
test('Rule E — idempotencyMiddleware still at-most-once per path (no double-mount)', () => {
  const byPath = new Map<string, number>();
  for (const r of routes) if (r.handler === idempotencyMiddleware) byPath.set(r.path, (byPath.get(r.path) ?? 0) + 1);
  const doubled = [...byPath.entries()].filter(([, n]) => n > 1);
  assert.deepEqual(doubled, [], `idempotency double-mounted on: ${doubled.map(([p]) => p).join(', ')}`);
});
