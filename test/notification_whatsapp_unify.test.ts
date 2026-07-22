// ============================================================================
// test/notification_whatsapp_unify.test.ts — Slice 10 Session 1, PR-B.
// ----------------------------------------------------------------------------
// WhatsApp unification (Q3 + DRY rule): the three former direct callers of
// sendWhatsAppTemplate (dispatch OTP, return OTP, invoice_ready) now route
// through the ONE canonical emitCustomerNotification. There must be no parallel
// send path left in the routes/lib.
//
// Rule E — a source-level invariant: the three callers import
//          emitCustomerNotification and no longer call sendWhatsAppTemplate
//          directly; the OTP routes are still mounted; emitCustomerNotification
//          accepts the whatsapp override + redactRender and stays fail-open.
//
// Rule B (real DB: dispatch OTP -> emitCustomerNotification -> WhatsApp send with
//         the plaintext code REDACTED from the stored delivery snapshot;
//         opted-out customer -> whatsapp skipped -> route offers skip-with-reason)
//         is validated SEPARATELY against real PostgreSQL 16 — see the scratchpad
//         notif_s10_roundtrip.sql.
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost/test';
process.env.INTEGRATION_ENC_KEY ??= 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2';

import { emitCustomerNotification } from '../src/lib/notify.js';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (p: string) => readFileSync(join(root, p), 'utf8');

const CALLERS = [
  'src/routes/dispatches.ts',
  'src/routes/returns.ts',
  'src/lib/invoice_deliver.ts',
];

test('DRY — the three former callers no longer call sendWhatsAppTemplate directly', () => {
  for (const f of CALLERS) {
    const src = read(f);
    // No direct invocation `sendWhatsAppTemplate(` anywhere (comments referencing
    // the name are fine; an actual call is not).
    assert.equal(/sendWhatsAppTemplate\s*\(/.test(src), false, `${f} must not call sendWhatsAppTemplate directly`);
    // They route through the canonical pipeline instead.
    assert.match(src, /emitCustomerNotification/, `${f} must use emitCustomerNotification`);
  }
});

test('DRY — sendWhatsAppTemplate keeps exactly ONE internal caller (performChannelSend in notify.ts)', () => {
  const notify = read('src/lib/notify.ts');
  const calls = (notify.match(/await sendWhatsAppTemplate\s*\(/g) ?? []).length;
  assert.equal(calls, 1, 'sendWhatsAppTemplate is the internal primitive, invoked once from performChannelSend');
});

test('OTP events are seeded in the policy so the unified path resolves a mode', () => {
  const mig = read('migrations/065_notification_slice10.sql');
  assert.match(mig, /dispatch_otp_send/);
  assert.match(mig, /return_otp_send/);
});

test('Rule E — the OTP routes are still mounted after the refactor', async () => {
  const { app } = await import('../src/app.js');
  const routes = (app as any).routes as Array<{ method: string; path: string }>;
  const paths = new Set(routes.map((r) => r.path));
  assert.ok([...paths].some((p) => p.includes('/api/dispatches')), 'dispatch routes mounted');
  assert.ok([...paths].some((p) => p.includes('/api/returns')), 'return routes mounted');
});

test('Rule E — emitCustomerNotification accepts the whatsapp override + redactRender, fail-open', async () => {
  const r = await emitCustomerNotification({
    workspaceId: '55555555-5555-5555-5555-555555555555',
    orderId: '66666666-6666-6666-6666-666666666666',
    personId: null,
    eventType: 'dispatch_otp_send',
    message: 'Dispatch verification OTP',
    channels: ['whatsapp'],
    contact: { phone: '+919812345678' },
    whatsapp: { templateName: 'dispatch_otp', variables: { '1': '123456' } },
    redactRender: true,
  });
  assert.ok(r && Array.isArray(r.deliveries));
});
