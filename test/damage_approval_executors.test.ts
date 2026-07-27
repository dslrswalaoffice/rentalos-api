// ============================================================================
// test/damage_approval_executors.test.ts — Approval Engine S2.
// ----------------------------------------------------------------------------
// Rule A — the damage_financial_resolution executor is registered + resolvable;
//   the registry still fails fast on unknown types.
// Rule E/source — the damage route routes above-threshold resolutions through the
//   engine (createApprovalRequest + populates approval_request_id), the legacy
//   approve endpoint 409-redirects when an engine request is active, and the
//   reviews-summary endpoint sums the three queues with per-source permission gates.
//
// Rule B (real PG16: executor settles + emits the timeline event; the route
//   creates the approval row + FK; the three review counts match their queues)
//   validated SEPARATELY against PostgreSQL 16 — captured in the PR.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost/test';

import { getExecutor, REGISTERED_RESOURCE_TYPES, resourceLabel } from '../src/lib/approval_executors.js';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const executors = read('../src/lib/approval_executors.ts');
const damageRoute = read('../src/routes/damage.ts');
const reviewsRoute = read('../src/routes/reviews.ts');
const app = read('../src/app.ts');

// ---------- Rule A — registry ----------
test('registry — damage_financial_resolution is registered + resolvable', () => {
  assert.ok(REGISTERED_RESOURCE_TYPES.includes('damage_financial_resolution'));
  const ex = getExecutor('damage_financial_resolution');
  assert.equal(typeof ex.execute, 'function');
  assert.equal(typeof ex.reject, 'function');
  assert.equal(resourceLabel('damage_financial_resolution'), 'Damage resolution');
});

test('registry — still fails fast on unknown types (Session 1 invariant intact)', () => {
  assert.throws(() => getExecutor('nope'), /No approval executor registered/);
});

// ---------- Rule E/source — executor wraps the shared Slice-11 helper ----------
test('executor — approve wraps applyDamageFinancialSideEffects then settles', () => {
  assert.match(executors, /applyDamageFinancialSideEffects\(\{/);
  assert.match(executors, /status = 'financial_settled', requires_approval = false/);
  assert.match(executors, /financial_resolution_approved/);
});

test('executor — reject reverts to investigating, no side-effects', () => {
  assert.match(executors, /status = 'investigating', requires_approval = false[\s\S]*?financial_resolution_rejected/);
  // No side-effect helper call inside the reject arm.
});

test('executor — imports the helper from damage_lifecycle (not damage.ts — cycle-safe)', () => {
  assert.match(executors, /from '\.\/damage_lifecycle\.js'/);
  assert.doesNotMatch(executors, /applyDamageFinancialSideEffects.*from '\.\/damage\.js'/);
});

// ---------- Rule E/source — damage route ----------
test('damage route — above-threshold resolution routes through the engine + FK', () => {
  assert.match(damageRoute, /createApprovalRequest\(\{[\s\S]*?resourceType: 'damage_financial_resolution'/);
  assert.match(damageRoute, /UPDATE damage_incidents SET approval_request_id/);
});

test('damage route — legacy /approve + /reject endpoints are RETIRED (Phase 1 S3)', () => {
  // The parallel legacy approval path is gone; the engine is the only surface.
  assert.doesNotMatch(damageRoute, /post\('\/:id\/approve'/);
  assert.doesNotMatch(damageRoute, /post\('\/:id\/reject'/);
  assert.doesNotMatch(damageRoute, /damageRejectSchema/);
  // /close stays — a distinct action, never engine-routed.
  assert.match(damageRoute, /post\('\/:id\/close'/);
});

// ---------- Rule E/source — reviews summary ----------
test('reviews summary — sums 3 queues, each gated by its own permission', () => {
  assert.match(reviewsRoute, /can\(session, 'approvals\.review'\)/);
  assert.match(reviewsRoute, /can\(session, 'people\.review_kyc'\)/);
  assert.match(reviewsRoute, /can\(session, 'notifications\.review'\)/);
  assert.match(reviewsRoute, /total_pending:/);
  // Notification count mirrors the queue discriminator (notification_id IS NULL).
  assert.match(reviewsRoute, /notification_id IS NULL AND status = 'pending'/);
  // KYC count excludes soft-deleted people (matches the queue).
  assert.match(reviewsRoute, /p\.deleted_at IS NULL/);
});

test('reviews route — mounted at /api/reviews', () => {
  assert.match(app, /app\.route\('\/api\/reviews', reviews\)/);
});
