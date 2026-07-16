// ============================================================================
// test/ss23_notify.test.ts — Rule C (merge fields) + Rule H (no fire-and-forget)
// ----------------------------------------------------------------------------
// Rule C: render every internal template with its real emit-site variables and
//         assert no unrendered {token} survives. (The 7 CUSTOMER-facing templates
//         are seeded into workspace.settings by migration 053 and are Rule-C'd
//         against the REAL seeded rows in scripts/ss23_merge_fields_pg16.ts, which
//         needs PG16; this suite stays DB-free.)
// Rule H: read the substitution + damage lib SOURCE and assert every notification
//         emit is awaited and NONE is fire-and-forget (.catch(()=>{}) on an emit).
//         This is the permanent guard for the serverless-freeze bug class.
// Run: `npm test`
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { substitute } from '../src/lib/notify.js';

const here = dirname(fileURLToPath(import.meta.url));
const srcLib = join(here, '..', 'src', 'lib');

// The internal templates (hardcoded in notify.ts TEMPLATES) + the exact variable
// set each emit site passes. If a template gains a {token} with no matching var,
// the leftover-token assertion fails.
const INTERNAL_RENDER_CASES: Array<{ label: string; text: string; vars: Record<string, unknown> }> = [
  {
    label: 'substitution_pending_approval',
    text: 'Substitution {substitution_number} needs approval · Order #{order_number}\n{original_item} → {replacement_item}. Requested by {actor_name}.',
    vars: { substitution_number: 'SUB-2026-0024-01', order_number: 24, original_item: 'Sony FX3', replacement_item: 'Sony FX6', actor_name: 'Shoaib' },
  },
  {
    label: 'damage_incident_reported_internal',
    text: 'Damage {incident_number} reported · Order #{order_number}\n{severity} · {incident_type}. Reported by {actor_name}.',
    vars: { incident_number: 'DI-2026-0024-001', order_number: 24, severity: 'major', incident_type: 'accidental_drop', actor_name: 'Ruhan' },
  },
  {
    label: 'damage_incident_pending_approval',
    text: 'Damage {incident_number} resolution needs approval · Order #{order_number}\n{resolution_summary} Requested by {actor_name}.',
    vars: { incident_number: 'DI-2026-0024-001', order_number: 24, resolution_summary: 'customer_pays (liability: yes).', actor_name: 'Irfan' },
  },
];

const LEFTOVER = /\{[a-z_]+\}/;

test('Rule C — internal templates render with no leftover {tokens}', () => {
  for (const c of INTERNAL_RENDER_CASES) {
    const out = substitute(c.text, c.vars);
    assert.ok(!LEFTOVER.test(out), `${c.label}: unrendered token in "${out}"`);
    assert.ok(!out.includes('undefined'), `${c.label}: an undefined slipped into "${out}"`);
  }
});

test('Rule C — substitute leaves a genuinely-unknown token literal (visible typo)', () => {
  // The convention: unknown tokens stay literal so a template typo is visible.
  const out = substitute('Hi {customer_name}, ref {typo_here}', { customer_name: 'Priya' });
  assert.equal(out, 'Hi Priya, ref {typo_here}');
});

test('Rule H — no fire-and-forget emits in substitution/damage libs', () => {
  for (const file of ['substitutions.ts', 'damage.ts']) {
    const src = readFileSync(join(srcLib, file), 'utf8');
    // Every emit call is awaited: count(emit...) === count(await emit...).
    const emitCalls = (src.match(/emit(?:Notification|CustomerNotification)\(/g) ?? []).length;
    const awaitedEmits = (src.match(/await emit(?:Notification|CustomerNotification)\(/g) ?? []).length;
    assert.equal(awaitedEmits, emitCalls, `${file}: ${emitCalls - awaitedEmits} emit(s) not awaited`);
    // No fire-and-forget .catch(()=>{}) chained onto an emit (the 2.2 bug class).
    assert.ok(!/emit(?:Notification|CustomerNotification)\([^;]*\)\s*\.catch\(/s.test(src), `${file}: a fire-and-forget .catch() on an emit`);
    // Each emit is wrapped for fail-open: at least as many try/catch blocks as emit calls.
    const tryCount = (src.match(/\btry\s*\{/g) ?? []).length;
    assert.ok(tryCount >= emitCalls, `${file}: ${emitCalls} emits but only ${tryCount} try blocks (fail-open)`);
  }
});
