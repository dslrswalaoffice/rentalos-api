// ============================================================================
// test/notification_slice10.test.ts — Slice 10 Session 1 (notification firing:
// policy activation, customer preferences, WhatsApp unification, review queue).
// ----------------------------------------------------------------------------
// Rule A — contract tests for the policy-update, review-list, and customer
//          notification-preference schemas.
// Rule E — composition + fail-open:
//          * the PUBLIC unsubscribe route answers WITHOUT a session (not 401);
//          * the authed review-queue / policy routes ARE gated (401 no session);
//          * the unsubscribe HMAC token round-trips and rejects tampering;
//          * emitCustomerNotification is fail-open (returns a result, never throws)
//            even when the DB is unreachable.
//
// Rule B (real DB round-trip: auto → sends; auto_with_review → 'pending' then the
//         review queue approves → 'sent'; a whatsapp opt-out skips whatsapp but
//         email still sends) and Rule D (policy mode toggle + enforce_customer_
//         preferences toggle change emit behaviour) are validated SEPARATELY
//         against real PostgreSQL 16 — see scratchpad notif_s10_roundtrip.sql.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost/test';
process.env.INTEGRATION_ENC_KEY ??= 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';
process.env.APP_ORIGIN ??= 'https://rentalos.example';

import { policyUpdateSchema, reviewListSchema } from '../src/routes/notifications.js';
import { notifPrefsSchema } from '../src/routes/people.js';
import { makeUnsubscribeToken, verifyUnsubscribeToken, emitCustomerNotification } from '../src/lib/notify.js';

// ---------- Rule A: policyUpdateSchema ----------
test('policyUpdateSchema — accepts partial event-mode edits + policy scalars', () => {
  const ok = policyUpdateSchema.safeParse({
    events: { kyc_rejected: { mode: 'auto' }, invoice_issued: { mode: 'manual_only' } },
    default_language: 'hi',
    enable_delivery_receipts: true,
    enforce_customer_preferences: false,
  });
  assert.equal(ok.success, true);
  // empty object is valid (a no-op PUT)
  assert.equal(policyUpdateSchema.safeParse({}).success, true);
});

test('policyUpdateSchema — rejects an unknown mode + unknown language', () => {
  assert.equal(policyUpdateSchema.safeParse({ events: { x: { mode: 'send_now' } } }).success, false);
  assert.equal(policyUpdateSchema.safeParse({ default_language: 'fr' }).success, false);
});

// ---------- Rule A: reviewListSchema ----------
test('reviewListSchema — coerces paging, defaults limit/offset', () => {
  const ok = reviewListSchema.safeParse({ event_type: 'kyc_rejected', limit: '25', offset: '10' });
  assert.equal(ok.success, true);
  assert.equal(ok.success && ok.data.limit, 25);
  assert.equal(ok.success && ok.data.offset, 10);
  const bare = reviewListSchema.safeParse({});
  assert.equal(bare.success && bare.data.limit, 50);
  assert.equal(bare.success && bare.data.offset, 0);
  // limit is capped at 100
  assert.equal(reviewListSchema.safeParse({ limit: '500' }).success, false);
});

// ---------- Rule A: notifPrefsSchema ----------
test('notifPrefsSchema — all-optional per-channel booleans + language enum', () => {
  assert.equal(notifPrefsSchema.safeParse({ whatsapp: false }).success, true);
  assert.equal(notifPrefsSchema.safeParse({ whatsapp: false, email: true, sms: false, marketing: false, language: 'gu' }).success, true);
  assert.equal(notifPrefsSchema.safeParse({}).success, true);
  // wrong types / bad language rejected
  assert.equal(notifPrefsSchema.safeParse({ whatsapp: 'yes' }).success, false);
  assert.equal(notifPrefsSchema.safeParse({ language: 'ta' }).success, false);
});

// ---------- unsubscribe token round-trip + tamper rejection ----------
test('unsubscribe token — round-trips (workspace, person) and rejects tampering', () => {
  const ws = '11111111-1111-1111-1111-111111111111';
  const person = '22222222-2222-2222-2222-222222222222';
  const token = makeUnsubscribeToken(ws, person);
  assert.ok(token, 'token minted when INTEGRATION_ENC_KEY is present');
  const decoded = verifyUnsubscribeToken(token!);
  assert.deepEqual(decoded, { workspaceId: ws, personId: person });

  // A flipped signature must not verify.
  const [payload, mac] = token!.split('.');
  const badMac = mac.slice(0, -2) + (mac.endsWith('AA') ? 'BB' : 'AA');
  assert.equal(verifyUnsubscribeToken(`${payload}.${badMac}`), null);
  // Garbage / wrong shape must not verify.
  assert.equal(verifyUnsubscribeToken('not-a-token'), null);
  assert.equal(verifyUnsubscribeToken(`${payload}`), null);
});

// ---------- Rule E: PUBLIC unsubscribe route answers WITHOUT a session ----------
test('Rule E — GET /unsubscribe/:token is PUBLIC (a bad token gives 400, never 401)', async () => {
  const { app } = await import('../src/app.js');
  const res = await app.fetch(new Request('http://x/api/notifications/unsubscribe/garbage'));
  assert.notEqual(res.status, 401, 'a public route must not be gated by requireAuth');
  assert.equal(res.status, 400);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/);
});

// ---------- Rule E: authed Slice-10 routes ARE gated ----------
test('Rule E — review-queue + policy routes require a session (401 without one)', async () => {
  const { app } = await import('../src/app.js');
  for (const path of ['/api/notifications/review-queue', '/api/notifications/policy']) {
    const res = await app.fetch(new Request(`http://x${path}`));
    assert.equal(res.status, 401, `${path} must require auth`);
  }
});

// ---------- Rule E: emitCustomerNotification is fail-open ----------
test('Rule E — emitCustomerNotification never throws; returns a result even with no DB', async () => {
  const r = await emitCustomerNotification({
    workspaceId: '33333333-3333-3333-3333-333333333333',
    orderId: '44444444-4444-4444-4444-444444444444',
    personId: null,
    eventType: 'dispatch_completed',
    message: 'Your gear is on the way.',
    channels: ['whatsapp', 'email'],
    contact: { phone: '+919999999999', email: 'c@example.com' },
  });
  assert.ok(r && Array.isArray(r.deliveries), 'always returns a { mode, deliveries } shape');
});
