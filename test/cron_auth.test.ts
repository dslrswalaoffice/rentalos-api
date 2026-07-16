// ============================================================================
// test/cron_auth.test.ts   (PR #83)
// ----------------------------------------------------------------------------
// Sub-slice 2.2 cron jobs failed 12/12 runs with HTTP 401. Actual GitHub Actions
// log: the header rendered as `X-Reminder-Secret: ` (empty) → the GitHub Actions
// secret REMINDER_TRIGGER_SECRET was never configured. Root cause was operational
// (missing secret), but the single 401 for every failure mode made it hard to
// diagnose. cronAuthError() now reports the two modes distinctly:
//   • server has no secret (Vercel env missing) → 503 cron_secret_not_configured
//   • header missing / blank / mismatched        → 401 unauthorized
// This test locks that behavior in.
//
// Run: `npm test`
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cronAuthError } from '../src/routes/cron.js';

// Minimal Hono-context stub: cronAuthError only uses c.req.header() and c.json().
function fakeCtx(header: string | undefined) {
  return {
    req: { header: (_name: string) => header },
    json: (body: unknown, status: number) => ({ body, status }),
  };
}

const SECRET = 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6';

test('no server secret (Vercel env missing) → 503 cron_secret_not_configured', () => {
  delete process.env.REMINDER_TRIGGER_SECRET;
  const r: any = cronAuthError(fakeCtx('anything'));
  assert.ok(r, 'should return an error response');
  assert.equal(r.status, 503);
  assert.equal(r.body.error, 'cron_secret_not_configured');
  assert.ok(r.body.hint.includes('Vercel'), 'hint should point at Vercel');
});

test('blank/empty header (the observed prod failure) → 401 unauthorized', () => {
  process.env.REMINDER_TRIGGER_SECRET = SECRET;
  const r: any = cronAuthError(fakeCtx('')); // exactly what the empty GitHub secret produced
  assert.equal(r.status, 401);
  assert.equal(r.body.error, 'unauthorized');
  assert.ok(r.body.hint.includes('GitHub'), 'hint should point at the GitHub secret');
});

test('mismatched header → 401 unauthorized', () => {
  process.env.REMINDER_TRIGGER_SECRET = SECRET;
  const r: any = cronAuthError(fakeCtx('wrong-secret'));
  assert.equal(r.status, 401);
});

test('missing header → 401 unauthorized', () => {
  process.env.REMINDER_TRIGGER_SECRET = SECRET;
  const r: any = cronAuthError(fakeCtx(undefined));
  assert.equal(r.status, 401);
});

test('correct header → authorized (null, no error response)', () => {
  process.env.REMINDER_TRIGGER_SECRET = SECRET;
  const r = cronAuthError(fakeCtx(SECRET));
  assert.equal(r, null, 'a matching secret must authorize (return null)');
});
