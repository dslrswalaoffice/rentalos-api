// ============================================================================
// test/integrations_save.test.ts
// ----------------------------------------------------------------------------
// Regression coverage for the SMTP-save 500 (Sub-slice 2.1.5 hotfix). The bug:
// PUT /api/integrations/:cat/:provider called encryptJson() which throws when
// INTEGRATION_ENC_KEY is missing/invalid; the throw was uncaught → generic
// {"error":"internal_error"} 500, giving the operator nothing to act on.
//
// This locks in:
//   1. encryptJson throws a TYPED EncKeyMissingError (so the route can map it).
//   2. A fresh save (valid key) round-trips the exact credentials Aamir sent.
//   3. encKeyBlockedBody() is a structured Item-12 error naming INTEGRATION_ENC_KEY.
//
// Run: `npm test` (sets a dummy DATABASE_URL so the module graph imports; neon()
// never connects at import).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptJson, decryptJson, EncKeyMissingError, encKeyAvailable } from '../src/lib/crypto.js';
import { encKeyBlockedBody } from '../src/routes/integrations.js';

const VALID_KEY = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2'; // 64 hex chars
const AAMIR_CREDS = { username: 'aamir2307@gmail.com', password: 'jzzknygkltalpasw' };

test('encryptJson throws typed EncKeyMissingError when the key is absent', () => {
  delete process.env.INTEGRATION_ENC_KEY;
  assert.equal(encKeyAvailable(), false);
  assert.throws(
    () => encryptJson(AAMIR_CREDS),
    (e: unknown) => e instanceof EncKeyMissingError && (e as EncKeyMissingError).code === 'ENCRYPTION_KEY_UNAVAILABLE',
  );
});

test('encryptJson throws on a wrong-length or non-hex key', () => {
  process.env.INTEGRATION_ENC_KEY = 'tooshort';
  assert.throws(() => encryptJson({}), EncKeyMissingError);
  process.env.INTEGRATION_ENC_KEY = 'z'.repeat(64); // 64 chars but not hex
  assert.throws(() => encryptJson({}), EncKeyMissingError);
});

test('fresh save round-trips the exact credentials with a valid key', () => {
  process.env.INTEGRATION_ENC_KEY = VALID_KEY;
  assert.equal(encKeyAvailable(), true);
  // Simulate the PUT path: encrypt → base64 (stored) → decode → decrypt.
  const b64 = encryptJson(AAMIR_CREDS).toString('base64');
  const roundTripped = decryptJson(Buffer.from(b64, 'base64'));
  assert.deepEqual(roundTripped, AAMIR_CREDS);
});

test('encKeyBlockedBody is a structured Item-12 error naming the env var', () => {
  const b = encKeyBlockedBody();
  assert.equal(b.error.code, 'ENCRYPTION_KEY_UNAVAILABLE');
  assert.ok(Array.isArray(b.error.reasons) && b.error.reasons.length >= 1);
  assert.equal(b.error.reasons[0]!.code, 'ENC_KEY_MISSING');
  assert.equal(b.error.reasons[0]!.category, 'external');
  assert.match(b.error.reasons[0]!.message, /INTEGRATION_ENC_KEY/);
});
