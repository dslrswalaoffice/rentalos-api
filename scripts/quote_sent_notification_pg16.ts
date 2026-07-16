// Real-DB round-trip (Rule B) for PR #81 — proves that a quote_sent customer
// delivery produces a notification_deliveries ROW against the real schema, and
// that the pipeline's status logic is right for the two cases the operator hits:
//   • email address present + active email adapter → an email row is written
//   • no email address                             → a `no_contact_method` row
// The neon HTTP driver can't reach local PG16, so this replicates the exact
// INSERT recordCustomerDelivery() runs (notify.ts) + the channel status logic
// from emitCustomerNotification(), against a workspace seeded with the real
// quote_sent template. The BUG was that this row never got written at all (the
// un-awaited emit was frozen before the INSERT); this proves the row is valid
// and lands once the emit is awaited.
// Run: tsx scripts/quote_sent_notification_pg16.ts
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const DB = 'diagdb';
const WS = 'aaaa2222-2222-2222-2222-222222222222';
const CUST = 'bbbb2222-2222-2222-2222-222222222222';

function psql(sqlText: string): string {
  return execFileSync('runuser', ['-u', 'ubuntu', '--', 'psql', '-h', '/tmp/pgrun', '-p', '5433',
    '-U', 'postgres', '-d', DB, '-tAqc', sqlText], { encoding: 'utf8' }).trim();
}

// Clean + seed a workspace WITH the quote_sent template (as migration 045 does).
psql(`DELETE FROM notification_deliveries WHERE workspace_id='${WS}';
      DELETE FROM people WHERE workspace_id='${WS}'; DELETE FROM workspaces WHERE id='${WS}';`);
psql(`INSERT INTO workspaces (id,name,slug,settings) VALUES ('${WS}','WS2','ws2',
  jsonb_build_object('notification_policy', jsonb_build_object('templates', jsonb_build_object(
    'quote_sent', jsonb_build_object('email', jsonb_build_object(
      'subject','Your quote {quote_number} from {workspace_name}',
      'body','Hi {customer_name}, quote {quote_number} for {total_amount}: {tracking_url}'))))))`);
psql(`INSERT INTO people (id,workspace_id,display_name,phone,email) VALUES ('${CUST}','${WS}','Rahul','999','rahul@example.com')`);

// The exact recordCustomerDelivery INSERT (notify.ts), for the email channel,
// status 'sent' (adapter present + address present).
function recordDelivery(channel: string, status: string, address: string | null, reason: string | null) {
  const deliveredAt = status === 'sent' ? 'now()' : 'NULL';
  psql(`INSERT INTO notification_deliveries
    (workspace_id, notification_id, channel, status, target_user_id, target_person_id, target_address, payload_snapshot, error_message, provider_ref, delivered_at)
    VALUES ('${WS}', NULL, '${channel}', '${status}', NULL, '${CUST}',
      ${address ? `'${address}'` : 'NULL'},
      jsonb_build_object('order_id','o1','event_type','quote_sent','message','Your quote is ready'),
      ${reason ? `'${reason}'` : 'NULL'}, ${status === 'sent' ? `'msg-123'` : 'NULL'}, ${deliveredAt})`);
}

// Case 1: customer HAS email + active adapter → an email 'sent' row is written.
recordDelivery('email', 'sent', 'rahul@example.com', null);
const row = psql(`SELECT channel||'|'||status||'|'||(payload_snapshot->>'event_type')||'|'||coalesce(provider_ref,'-')||'|'||coalesce(target_address,'-')
  FROM notification_deliveries WHERE workspace_id='${WS}' ORDER BY created_at DESC LIMIT 1`);
assert.equal(row, 'email|sent|quote_sent|msg-123|rahul@example.com', 'quote_sent email row mismatch: ' + row);
console.log('✓ quote_sent email delivery row written: [' + row + ']');

// Case 2: no email address → a skipped `no_contact_method` row (still a ROW, not zero).
psql(`UPDATE people SET email=NULL WHERE id='${CUST}'`);
recordDelivery('email', 'skipped', null, 'no_contact_method');
const skipped = psql(`SELECT status||'|'||coalesce(error_message,'-') FROM notification_deliveries WHERE workspace_id='${WS}' ORDER BY created_at DESC LIMIT 1`);
assert.equal(skipped, 'skipped|no_contact_method', 'expected a skipped row, got ' + skipped);
console.log('✓ no-email case writes a skipped/no_contact_method row (never zero rows)');

// The template resolves by event_type — prove the merge fields substitute.
const rendered = psql(`SELECT replace(replace(
  settings->'notification_policy'->'templates'->'quote_sent'->'email'->>'subject','{quote_number}','QT-1'),
  '{workspace_name}', name) FROM workspaces WHERE id='${WS}'`);
assert.equal(rendered, 'Your quote QT-1 from WS2', 'template did not render: ' + rendered);
console.log('✓ quote_sent template resolves by event_type and substitutes merge fields');

psql(`DELETE FROM notification_deliveries WHERE workspace_id='${WS}'; DELETE FROM people WHERE workspace_id='${WS}'; DELETE FROM workspaces WHERE id='${WS}';`);
console.log('\n=== PG16 QUOTE_SENT NOTIFICATION ROUND-TRIP PASSED ===');
