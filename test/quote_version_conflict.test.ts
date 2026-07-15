// ============================================================================
// test/quote_version_conflict.test.ts
// ----------------------------------------------------------------------------
// Sub-slice 2.2 hotfix, Bug 2: "Create v1" surfaced "identical request already
// being processed". Root cause (reproduced on PG16): a concurrent double-submit
// — two requests both read version max = 0 and both INSERT version_number = 1,
// so the loser hits the UNIQUE (order_id, version_number) index (SQLSTATE
// 23505). That threw a 500, which orphaned the caller's idempotency record; the
// next same-key retry then hit the middleware's REQUEST_IN_FLIGHT path and
// showed the misleading message.
//
// Fix: createQuoteVersionFromOrder now catches the version-number conflict and
// retries with a recomputed number, so a genuine race produces v1 + v2 cleanly
// (no 500, no orphan). These tests cover the conflict detector; the full retry
// behavior is exercised against PG16 in scripts/quote_race_pg16.ts.
//
// Run: `npm test`
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isVersionNumberConflict } from '../src/lib/quotes.js';

test('isVersionNumberConflict detects SQLSTATE 23505', () => {
  assert.equal(isVersionNumberConflict({ code: '23505' }), true);
});

test('isVersionNumberConflict detects the constraint/message forms', () => {
  assert.equal(isVersionNumberConflict({ constraint: 'quote_versions_order_id_version_number_key', message: 'duplicate key value violates unique constraint' }), true);
  assert.equal(isVersionNumberConflict({ message: 'duplicate key value violates unique constraint "quote_versions_order_id_version_number_key"' }), true);
});

test('isVersionNumberConflict ignores unrelated errors (so we never retry the wrong failure)', () => {
  assert.equal(isVersionNumberConflict(null), false);
  assert.equal(isVersionNumberConflict(undefined), false);
  assert.equal(isVersionNumberConflict(new Error('order_not_found')), false);
  assert.equal(isVersionNumberConflict({ code: '23503', message: 'foreign key violation' }), false);
  // A unique violation on a DIFFERENT column must NOT be treated as a version race.
  assert.equal(isVersionNumberConflict({ code: undefined, message: 'duplicate key value violates unique constraint "quote_versions_tracking_link_uidx"' }), false);
});
