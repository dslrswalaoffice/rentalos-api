// ============================================================================
// test/standby_defaults.test.ts
// ----------------------------------------------------------------------------
// Configurability regression for the Sub-slice 2.2 hotfix (Bug 2): the New Order
// Composer's Standby "Hold duration" default must come from
// workspace.settings.standby_policy.default_hold_duration_minutes, NOT a
// hardcoded constant. Aamir edited the setting 240 → 180 in Neon but the
// composer still showed 240 because the value was hardcoded in new-order.html.
//
// The settings-reading + labeling logic now lives in the shared, DOM-free
// module public/_lib/standby-defaults.js (imported by new-order.html). These
// tests exercise that real module: changing the settings input changes the
// resolved default. If someone reverts to a hardcoded value, the composer stops
// importing this and these tests no longer guard it — so a second test asserts
// the wiring is present in new-order.html.
//
// Run: `npm test`
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { standbyHoldDefaultMinutes, holdLabel } from '../public/_lib/standby-defaults.js';

// --- The configurability contract: settings drive the value -----------------
test('standbyHoldDefaultMinutes reads default_hold_duration_minutes from settings', () => {
  // Aamir's edit: 240 → 180 must be reflected.
  assert.equal(standbyHoldDefaultMinutes({ standby_policy: { default_hold_duration_minutes: 180 } }), 180);
  // A different edit yields a different default (proves it's not pinned to any constant).
  assert.equal(standbyHoldDefaultMinutes({ standby_policy: { default_hold_duration_minutes: 480 } }), 480);
  assert.equal(standbyHoldDefaultMinutes({ standby_policy: { default_hold_duration_minutes: 90 } }), 90);
});

test('standbyHoldDefaultMinutes returns null for absent/invalid settings (caller falls back)', () => {
  assert.equal(standbyHoldDefaultMinutes(null), null);
  assert.equal(standbyHoldDefaultMinutes({}), null);
  assert.equal(standbyHoldDefaultMinutes({ standby_policy: {} }), null);
  assert.equal(standbyHoldDefaultMinutes({ standby_policy: { default_hold_duration_minutes: 0 } }), null);
  assert.equal(standbyHoldDefaultMinutes({ standby_policy: { default_hold_duration_minutes: 'x' } }), null);
});

test('holdLabel formats minutes for the option that gets injected', () => {
  assert.equal(holdLabel(180), '3 hours');   // Aamir's 180 → "3 hours"
  assert.equal(holdLabel(240), '4 hours');
  assert.equal(holdLabel(60), '1 hour');
  assert.equal(holdLabel(1440), '1 day');
  assert.equal(holdLabel(2880), '2 days');
  assert.equal(holdLabel(90), '90 min');
});

// --- Anti-regression: the composer actually wires settings into the control --
test('new-order.html wires the workspace setting into the Hold Duration control', () => {
  const html = readFileSync(fileURLToPath(new URL('../public/new-order.html', import.meta.url)), 'utf8');
  // Imports the shared resolver.
  assert.match(html, /import\s*\{[^}]*standbyHoldDefaultMinutes[^}]*\}\s*from\s*'\/_lib\/standby-defaults\.js'/);
  // Fetches workspace settings on boot and applies them.
  assert.match(html, /api\.get\('\/api\/workspace'\)/);
  assert.match(html, /applyStandbyDefaults\(/);
  // The resolved value is applied to the #holdMinutes control.
  assert.match(html, /getElementById\('holdMinutes'\)/);
});
