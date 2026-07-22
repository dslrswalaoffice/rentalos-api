// ============================================================================
// test/kyc_slice8.test.ts — Slice 8 Session 1 (KYC review workflow).
// ----------------------------------------------------------------------------
// Rule A — reject schema contract.
// Rule B/D (pure) — the status-derivation engine (deriveKycStatus + kycCategory):
//   individual needs aadhaar+pan, b2b needs gst; verified/pending/rejected/
//   not_started transitions; category auto-detected from company_name. This is
//   the core business logic, tested without a DB.
// Rule E — composition: the KYC routes are mounted + idempotency at-most-once.
//
// Rule B (real DB round-trip: upload -> pending; verify all required -> verified;
//   reject -> rejected; B2B gst-only path) is validated SEPARATELY against real
//   PostgreSQL 16. See the scratchpad kyc_s8_roundtrip.sql.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost/test';
process.env.INTEGRATION_ENC_KEY ??= 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';

import { rejectSchema } from '../src/routes/kyc.js';
import { deriveKycStatus, kycCategory } from '../src/lib/kyc_lifecycle.js';

// helper: build the type->statuses map
const m = (entries: Record<string, string[]>) => {
  const map = new Map<string, Set<string>>();
  for (const [t, ss] of Object.entries(entries)) map.set(t, new Set(ss));
  return map;
};

// ---------- Rule A ----------
test('rejectSchema — reason enum + optional notes', () => {
  assert.equal(rejectSchema.safeParse({ reason: 'unclear_image' }).success, true);
  assert.equal(rejectSchema.safeParse({ reason: 'document_expired', notes: 'blurry' }).success, true);
  assert.equal(rejectSchema.safeParse({ reason: 'nope' }).success, false);
  assert.equal(rejectSchema.safeParse({}).success, false);
});

// ---------- Rule B/D: category detection ----------
test('kycCategory — company_name present => b2b, else individual', () => {
  assert.equal(kycCategory(null), 'individual');
  assert.equal(kycCategory(''), 'individual');
  assert.equal(kycCategory('   '), 'individual');
  assert.equal(kycCategory('Acme Films Pvt Ltd'), 'b2b');
});

// ---------- Rule B/D: status derivation (individual: aadhaar+pan) ----------
const INDIV = ['aadhaar', 'pan'];
test('individual — no documents => not_started', () => {
  assert.equal(deriveKycStatus(INDIV, m({}), false), 'not_started');
});
test('individual — aadhaar verified, pan pending => pending', () => {
  assert.equal(deriveKycStatus(INDIV, m({ aadhaar: ['verified'], pan: ['pending'] }), true), 'pending');
});
test('individual — aadhaar verified, pan missing => pending', () => {
  assert.equal(deriveKycStatus(INDIV, m({ aadhaar: ['verified'] }), true), 'pending');
});
test('individual — both verified => verified', () => {
  assert.equal(deriveKycStatus(INDIV, m({ aadhaar: ['verified'], pan: ['verified'] }), true), 'verified');
});
test('individual — pan rejected (no verified) => rejected', () => {
  assert.equal(deriveKycStatus(INDIV, m({ aadhaar: ['verified'], pan: ['rejected'] }), true), 'rejected');
});
test('individual — a resubmitted pan (rejected + pending) is NOT rejected => pending', () => {
  assert.equal(deriveKycStatus(INDIV, m({ aadhaar: ['verified'], pan: ['rejected', 'pending'] }), true), 'pending');
});

// ---------- Rule B/D: B2B (gst only) ----------
const B2B = ['gst_certificate'];
test('b2b — gst verified => verified (aadhaar/pan not required)', () => {
  assert.equal(deriveKycStatus(B2B, m({ gst_certificate: ['verified'] }), true), 'verified');
});
test('b2b — gst pending => pending', () => {
  assert.equal(deriveKycStatus(B2B, m({ gst_certificate: ['pending'] }), true), 'pending');
});
test('b2b — an individual doc does NOT satisfy the b2b requirement', () => {
  assert.equal(deriveKycStatus(B2B, m({ aadhaar: ['verified'] }), true), 'pending');
});

// ---------- Rule E: composition ----------
const { app } = await import('../src/app.js');
const { idempotencyMiddleware } = await import('../src/lib/idempotency.js');
const routes = (app as any).routes as Array<{ method: string; path: string; handler: unknown }>;
const paths = new Set(routes.map((r) => r.path));

test('Rule E — KYC routes mounted', () => {
  for (const p of [
    '/api/kyc/people/:personId/documents',
    '/api/kyc/queue',
    '/api/kyc/documents/:docId/verify',
    '/api/kyc/documents/:docId/reject',
    '/api/kyc/documents/:docId/files/:idx',
  ]) assert.ok(paths.has(p), `missing KYC route: ${p}`);
});
test('Rule E — existing people routes survive', () => {
  assert.ok(paths.has('/api/people'), 'people list');
  assert.ok(paths.has('/api/people/:id'), 'person detail');
});
test('Rule E — idempotencyMiddleware at-most-once per KYC path', () => {
  const byPath = new Map<string, number>();
  for (const r of routes) if (r.handler === idempotencyMiddleware) byPath.set(r.path, (byPath.get(r.path) ?? 0) + 1);
  assert.deepEqual([...byPath.entries()].filter(([, n]) => n > 1), []);
  assert.ok([...byPath.keys()].some((p) => p.startsWith('/api/kyc')), 'idempotency applied to /api/kyc');
});
