// Rule C — merge-field completeness for the 7 CUSTOMER-facing Sub-slice 2.3
// templates, against the REAL rows migration 053 seeded into
// workspace.settings.notification_policy.templates (read from ss23 via psql). Each
// subject+body is rendered with the documented emit-site variable set through the
// REAL substitute() from notify.ts; no {token} may survive and no 'undefined' may
// leak.  Run: DATABASE_URL=… tsx scripts/ss23_merge_fields_pg16.ts
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { substitute } from '../src/lib/notify.js';

const DB = 'ss23';
function psql(sqlText: string): string {
  return execFileSync('runuser', ['-u', 'ubuntu', '--', '/usr/lib/postgresql/16/bin/psql', '-h', '/tmp/pgrun',
    '-p', '5433', '-U', 'postgres', '-d', DB, '-tAqc', sqlText], { encoding: 'utf8' }).trim();
}

// The full emit-site variable set for each template (mirrors the lib emit calls +
// the migration 053 header). workspace_name is auto-filled at real send time by
// emitCustomerNotification; supplied here so the render is complete.
const CASES: Record<string, Record<string, unknown>> = {
  damage_incident_reported: { customer_name: 'Priya Shah', incident_number: 'DI-2026-0024-001', order_number: 24, item_summary: '1 item(s)', severity: 'major', workspace_name: 'DSLRSWALA' },
  damage_incident_customer_acknowledgment_required: { customer_name: 'Priya Shah', incident_number: 'DI-2026-0024-001', order_number: 24, liability_summary: 'You are liable for the full repair cost.', acknowledgment_url: 'https://app/x', workspace_name: 'DSLRSWALA' },
  damage_incident_financial_resolution_proposed: { customer_name: 'Priya Shah', incident_number: 'DI-2026-0024-001', order_number: 24, resolution_summary: 'customer_pays (liability: yes).', amount: '₹45,000', workspace_name: 'DSLRSWALA' },
  damage_incident_closed: { customer_name: 'Priya Shah', incident_number: 'DI-2026-0024-001', order_number: 24, workspace_name: 'DSLRSWALA' },
  substitution_executed: { customer_name: 'Priya Shah', order_number: 24, substitution_number: 'SUB-2026-0024-01', original_item: 'Sony FX3', replacement_item: 'Sony FX3 (substituted)', workspace_name: 'DSLRSWALA' },
  substitution_reverted: { customer_name: 'Priya Shah', order_number: 24, substitution_number: 'SUB-2026-0024-01', original_item: 'Sony FX3', workspace_name: 'DSLRSWALA' },
  substitution_pending_approval: { order_number: 24, substitution_number: 'SUB-2026-0024-01', original_item: 'Sony FX3', replacement_item: 'Sony FX6', actor_name: 'Shoaib', workspace_name: 'DSLRSWALA' },
};

const LEFTOVER = /\{[a-z_]+\}/;
let checked = 0;
for (const [eventType, vars] of Object.entries(CASES)) {
  const subject = psql(`SELECT settings->'notification_policy'->'templates'->'${eventType}'->'email'->>'subject' FROM workspaces WHERE settings->'notification_policy'->'templates' ? '${eventType}' LIMIT 1;`);
  const body = psql(`SELECT settings->'notification_policy'->'templates'->'${eventType}'->'email'->>'body' FROM workspaces WHERE settings->'notification_policy'->'templates' ? '${eventType}' LIMIT 1;`);
  assert.ok(subject && subject.length > 0, `${eventType}: seeded subject present`);
  assert.ok(body && body.length > 0, `${eventType}: seeded body present`);
  const renderedSubject = substitute(subject, vars);
  const renderedBody = substitute(body, vars);
  assert.ok(!LEFTOVER.test(renderedSubject), `${eventType}: unrendered token in SUBJECT → "${renderedSubject}"`);
  assert.ok(!LEFTOVER.test(renderedBody), `${eventType}: unrendered token in BODY → "${renderedBody}"`);
  assert.ok(!renderedSubject.includes('undefined') && !renderedBody.includes('undefined'), `${eventType}: 'undefined' leaked`);
  console.log(`  ✓ ${eventType} — subject + body render clean (no leftover {token})`);
  checked++;
}
assert.equal(checked, 7, 'all 7 customer templates checked');
console.log(`\nALL ${checked} SEEDED CUSTOMER TEMPLATES RENDER WITH REAL MERGE FIELDS — RULE C PASSED`);
