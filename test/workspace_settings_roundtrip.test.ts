// ============================================================================
// test/workspace_settings_roundtrip.test.ts
// ----------------------------------------------------------------------------
// Configurability regression (Rule D) for the Sub-slice 2.2 hotfix, Bug 1:
// GET /api/workspace ran the raw settings JSONB through normalizeSettings(),
// which WHITELISTED keys and silently dropped the six order-policy objects
// (extension/cancellation/approval/notification/standby/quote). So a policy the
// PATCH had just saved could never be read back — the New Order Composer read
// settings.standby_policy === undefined and fell through to its hardcoded 240.
//
// This test drives the REAL transform + the REAL composer resolver end-to-end:
// raw DB settings → normalizeSettings → standbyHoldDefaultMinutes. If someone
// re-narrows normalizeSettings and drops the policy again, this fails.
//
// Run: `npm test`
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeSettings } from '../src/routes/workspace.js';
import { standbyHoldDefaultMinutes } from '../public/_lib/standby-defaults.js';

test('normalizeSettings passes through standby_policy (and its saved value)', () => {
  const raw = { standby_policy: { default_hold_duration_minutes: 180, grace_period_minutes: 30 } };
  const out = normalizeSettings(raw) as any;
  assert.equal(out.standby_policy?.default_hold_duration_minutes, 180);
  assert.equal(out.standby_policy?.grace_period_minutes, 30);
});

test('all six order-policy objects survive normalizeSettings', () => {
  const raw = {
    extension_policy: { a: 1 }, cancellation_policy: { b: 2 }, approval_routing: { c: 3 },
    notification_policy: { d: 4 }, standby_policy: { default_hold_duration_minutes: 180 },
    quote_policy: { default_validity_days: 7 },
  };
  const out = normalizeSettings(raw) as any;
  for (const k of ['extension_policy', 'cancellation_policy', 'approval_routing', 'notification_policy', 'standby_policy', 'quote_policy']) {
    assert.ok(out[k], `${k} was dropped by normalizeSettings`);
  }
  assert.equal(out.quote_policy.default_validity_days, 7);
});

test('full round-trip: DB settings → GET transform → composer resolver reads 180', () => {
  // Exactly what Aamir saved (240 → 180) and what the composer should read back.
  const dbSettings = { standby_policy: { default_hold_duration_minutes: 180 } };
  const served = normalizeSettings(dbSettings);          // GET /api/workspace runs this
  const composerDefault = standbyHoldDefaultMinutes(served); // composer reads this
  assert.equal(composerDefault, 180);                    // was NULL before the fix → composer fell back to 240
});

test('normalizeSettings omits an absent policy (composer keeps its fallback)', () => {
  const out = normalizeSettings({ billing: {} }) as any;
  assert.equal(out.standby_policy, undefined);
  assert.equal(standbyHoldDefaultMinutes(out), null); // → composer uses its built-in preset
});

// Bug B hardening (PR #80): GET /api/workspace must not aggressively browser-cache
// the settings — the composer reads it right after a save and must see the new
// value. Source-level guard against regressing to a stale max-age.
test('GET /api/workspace does not browser-cache settings with a positive max-age', async () => {
  const { readFileSync } = await import('node:fs');
  const { fileURLToPath } = await import('node:url');
  const src = readFileSync(fileURLToPath(new URL('../src/routes/workspace.ts', import.meta.url)), 'utf8');
  // Find the Cache-Control header set on the workspace GET.
  const m = src.match(/c\.header\('Cache-Control',\s*'([^']+)'\)/);
  assert.ok(m, 'workspace GET should still set a Cache-Control header');
  const cc = m![1];
  assert.ok(cc.includes('private'), 'must stay private (multi-tenant data)');
  assert.ok(/no-cache|max-age=0/.test(cc), `settings GET must always revalidate; got "${cc}"`);
  assert.ok(!/max-age=[1-9]/.test(cc), `settings GET must not cache with a positive max-age; got "${cc}"`);
});
