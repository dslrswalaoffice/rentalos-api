// ============================================================================
// test/dispatch_session_2.test.ts — Slice 4 Session 2 (full 6-step flow).
// ----------------------------------------------------------------------------
// Rule A — contract tests for the NEW / CHANGED Zod schemas (the exact bodies the
//          Session 2 UI POSTs): items checklist, serial + QR, condition, signature
//          skip, complete.
// Rule E — composition / backward-compat: the assembled app exposes the new
//          Section B routes AND the legacy POST /api/orders/:id/dispatch (12b),
//          with idempotencyMiddleware still at-most-once per path.
//
// Rule B (real DB round-trip through commitDispatchToPhysicalState — assets→out,
//         order_assets rows, item→dispatched, order→dispatched, timeline events)
//         and Rule D (per-type photo policy) are validated SEPARATELY against real
//         PostgreSQL 16 (neon() is HTTP-only + lazy; DATABASE_URL is a dummy here).
//         See the Phase report / scratchpad dispatch_s2_roundtrip.sql.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost/test';
process.env.INTEGRATION_ENC_KEY ??= 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';

import {
  itemsChecklistSchema, serialSchema, conditionSchema,
  signatureSchema, completeSchema, otpVerifySchema, CONDITION_VALUES,
} from '../src/routes/dispatches.js';

// ---------- Rule A: itemsChecklistSchema ----------
test('itemsChecklistSchema — non-empty uuid array parses; empty rejects', () => {
  assert.equal(itemsChecklistSchema.safeParse({ item_ids: ['11111111-1111-1111-1111-111111111111'] }).success, true);
  assert.equal(itemsChecklistSchema.safeParse({ item_ids: [] }).success, false);
  assert.equal(itemsChecklistSchema.safeParse({ item_ids: ['nope'] }).success, false);
});

// ---------- Rule A: serialSchema ----------
test('serialSchema — captured_serial required; override optional', () => {
  assert.equal(serialSchema.safeParse({ captured_serial: 'NL-FS300-01' }).success, true);
  assert.equal(serialSchema.safeParse({ captured_serial: 'X', override: true }).success, true);
  assert.equal(serialSchema.safeParse({}).success, false);
  assert.equal(serialSchema.safeParse({ captured_serial: '' }).success, false);
});

// ---------- Rule A: conditionSchema ----------
test('conditionSchema — only the 4 enum values parse', () => {
  for (const v of CONDITION_VALUES) assert.equal(conditionSchema.safeParse({ condition: v }).success, true);
  assert.equal(conditionSchema.safeParse({ condition: 'broken' }).success, false);
  assert.equal(conditionSchema.safeParse({}).success, false);
});

// ---------- Rule A: signatureSchema (skip vs captured) ----------
test('signatureSchema — captured needs type + base64', () => {
  assert.equal(signatureSchema.safeParse({ signature_type: 'digital_draw', signature_base64: 'data:image/png;base64,AAAA' }).success, true);
  assert.equal(signatureSchema.safeParse({ signature_type: 'digital_draw' }).success, false);
  assert.equal(signatureSchema.safeParse({ signature_base64: 'data:image/png;base64,AAAA' }).success, false);
});
test('signatureSchema — skip needs no image', () => {
  assert.equal(signatureSchema.safeParse({ skipped: true, skip_reason: 'customer not present' }).success, true);
  assert.equal(signatureSchema.safeParse({ skipped: true }).success, true); // reason enforced server-side by policy
});

// ---------- Rule A: completeSchema ----------
test('completeSchema — optional item_ids; empty body OK', () => {
  assert.equal(completeSchema.safeParse({}).success, true);
  assert.equal(completeSchema.safeParse({ item_ids: ['11111111-1111-1111-1111-111111111111'] }).success, true);
  assert.equal(completeSchema.safeParse({ item_ids: ['x'] }).success, false);
});

// ---------- Rule A: otpVerifySchema (still 6-digit for real crypto) ----------
test('otpVerifySchema — 6-digit code parses, non-numeric rejects', () => {
  assert.equal(otpVerifySchema.safeParse({ code: '482913' }).success, true);
  assert.equal(otpVerifySchema.safeParse({ code: '48a913' }).success, false);
});

// ---------- Rule E: composition + backward-compat ----------
const { app } = await import('../src/app.js');
const { idempotencyMiddleware } = await import('../src/lib/idempotency.js');
const routes = (app as any).routes as Array<{ method: string; path: string; handler: unknown }>;
const paths = new Set(routes.map((r) => r.path));

test('Rule E — legacy POST /api/orders/:id/dispatch still registered (12b via shared helper)', () => {
  assert.ok(paths.has('/api/orders/:id/dispatch'), 'legacy batch-dispatch route must survive the DRY refactor');
});

test('Rule E — new Section B/C/D/E + complete routes mounted', () => {
  for (const suffix of [
    'items', 'items/:itemId/serial', 'items/:itemId/condition',
    'photos', 'otp', 'otp/verify', 'otp/skip', 'signature', 'complete',
  ]) {
    assert.ok(paths.has(`/api/dispatches/:dispatchId/${suffix}`), `missing route: ${suffix}`);
  }
});

test('Rule E — idempotencyMiddleware still at-most-once per path (no double-mount)', () => {
  const byPath = new Map<string, number>();
  for (const r of routes) if (r.handler === idempotencyMiddleware) byPath.set(r.path, (byPath.get(r.path) ?? 0) + 1);
  const doubled = [...byPath.entries()].filter(([, n]) => n > 1);
  assert.deepEqual(doubled, [], `idempotency double-mounted on: ${doubled.map(([p]) => p).join(', ')}`);
});
