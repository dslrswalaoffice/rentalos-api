// Persistence round-trip for the Sub-slice 2.2 hotfix.
// Parses the EXACT body new-order.html now sends through the REAL exported
// standbyCreateSchema, then persists it via the same INSERTs the handler runs,
// against local PG16 (spawned psql). Asserts a real standby exists, its backing
// order is status='standby', and its rental lines are soft-reserved and counted
// by availability. Run: tsx scripts/standby_e2e_pg16.ts
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { standbyCreateSchema } from '../src/routes/standbys.js';

const DB = 'ss22e2e';
function psql(sql: string): string {
  return execFileSync('runuser', ['-u', 'ubuntu', '--', 'psql', '-h', '/tmp/pgrun', '-p', '5433',
    '-U', 'postgres', '-d', DB, '-tAqc', sql], { encoding: 'utf8' }).trim();
}

// Fixture ids (valid hex uuids).
const WS = '11111111-1111-1111-1111-111111111111';
const USER = '22222222-2222-2222-2222-222222222222';
const CUST = '33333333-3333-3333-3333-333333333333';
const LOC = '66666666-6666-6666-6666-666666666666';
const PROD = '77777777-7777-7777-7777-777777777777';

// Clean any leftovers from a prior run so the availability assertion is exact.
psql(`DELETE FROM order_items WHERE order_id IN (SELECT id FROM orders WHERE workspace_id='${WS}');
      DELETE FROM standbys WHERE workspace_id='${WS}';
      DELETE FROM orders WHERE workspace_id='${WS}';`);

psql(`INSERT INTO workspaces (id,name,slug) VALUES ('${WS}','WS','ws') ON CONFLICT DO NOTHING;`);
psql(`INSERT INTO users (id,email,password_hash,display_name) VALUES ('${USER}','u@x.com','x','U') ON CONFLICT DO NOTHING;`);
psql(`INSERT INTO people (id,workspace_id,display_name,phone) VALUES ('${CUST}','${WS}','Rahul Mehta','9990001111') ON CONFLICT DO NOTHING;`);
psql(`INSERT INTO locations (id,workspace_id,name,is_default) VALUES ('${LOC}','${WS}','Main',true) ON CONFLICT DO NOTHING;`);
psql(`INSERT INTO products (id,workspace_id,name,sku,category,daily_rate) VALUES ('${PROD}','${WS}','Sony FX3','FX3-01','camera',100000) ON CONFLICT DO NOTHING;`);

// EXACT body new-order.html createStandby() sends after the hotfix.
const frontendBody = {
  customer_id: CUST,
  rental_start_at: '2026-08-01T10:05:00.000Z',
  rental_end_at: '2026-08-02T10:05:00.000Z',
  requested_via: 'walk_in',
  reason_tag: 'customer_deciding',
  hold_duration_minutes: 240,
  line_items: [{ product_id: PROD, quantity: 2 }],
  reason_notes: 'Holding for a wedding shoot',
};

// 1) The real schema must accept it.
const parsed = standbyCreateSchema.safeParse(frontendBody);
assert.ok(parsed.success, 'schema rejected the frontend body: ' + JSON.stringify((parsed as any).error?.issues));
const p = parsed.data;
console.log('✓ standbyCreateSchema accepted the exact frontend body');

// 2) Persist via the handler's INSERT path (backing order + standby + soft-reserved lines).
const n = psql(`UPDATE workspaces SET next_order_number = next_order_number + 1 WHERE id='${WS}' RETURNING next_order_number - 1;`);
const orderId = psql(`INSERT INTO orders (workspace_id,order_number,customer_person_id,status,rental_start,rental_end,dispatch_type,channel,pickup_location_id,return_location_id,created_by)
  VALUES ('${WS}',${n},'${p.customer_id}','standby','${p.rental_start_at}','${p.rental_end_at}','pickup','planned','${LOC}','${LOC}','${USER}') RETURNING id;`);
const stbId = psql(`INSERT INTO standbys (workspace_id,order_id,customer_id,standby_number,requested_by_source,requested_via,rental_start_at,rental_end_at,expires_at,hold_duration_minutes,reason_tag,reason_notes,estimated_value_paise,line_items_snapshot,status)
  VALUES ('${WS}','${orderId}','${p.customer_id}','SB-2026-0001','staff','${p.requested_via}','${p.rental_start_at}','${p.rental_end_at}', now() + interval '${p.hold_duration_minutes} minutes', ${p.hold_duration_minutes}, '${p.reason_tag}', '${p.reason_notes}', 400000, '[]'::jsonb, 'active') RETURNING id;`);
for (const li of p.line_items) {
  psql(`INSERT INTO order_items (workspace_id,order_id,item_type,product_id,description,quantity,status,is_soft_reserved,soft_reserved_standby_id)
    VALUES ('${WS}','${orderId}','rental','${li.product_id}','Sony FX3',${li.quantity},'pending_dispatch',true,'${stbId}');`);
}
console.log(`✓ persisted standby ${stbId} (order #${n}, id ${orderId})`);

// 3) Assert the standby exists and is correct.
const row = psql(`SELECT status||'|'||standby_number||'|'||hold_duration_minutes FROM standbys WHERE id='${stbId}';`);
assert.equal(row, 'active|SB-2026-0001|240', 'standby row mismatch: ' + row);
const ordStatus = psql(`SELECT status FROM orders WHERE id='${orderId}';`);
assert.equal(ordStatus, 'standby', 'backing order not standby: ' + ordStatus);
const softRows = psql(`SELECT count(*) FROM order_items WHERE order_id='${orderId}' AND is_soft_reserved=true;`);
const softQty = psql(`SELECT COALESCE(SUM(quantity),0) FROM order_items WHERE order_id='${orderId}' AND is_soft_reserved=true;`);
assert.equal(softRows, '1', 'expected 1 soft-reserved line, got ' + softRows);
assert.equal(softQty, '2', 'expected soft-reserved qty 2, got ' + softQty);
console.log('✓ standby active, backing order status=standby, 1 soft-reserved line (qty 2)');

// 4) Availability must count the hold (the standby blocks the window).
const conflict = psql(`SELECT COALESCE(SUM(oi.quantity),0) FROM order_items oi JOIN orders o ON o.id=oi.order_id
  WHERE oi.workspace_id='${WS}' AND oi.product_id='${PROD}' AND oi.item_type='rental' AND o.deleted_at IS NULL
    AND ((o.status::text = ANY(ARRAY['confirmed','dispatched','active','returned']) AND oi.status::text = ANY(ARRAY['pending_dispatch','dispatched','not_returned_chargeable','not_returned_non_chargeable'])) OR oi.is_soft_reserved=true)
    AND o.rental_start < '2026-08-02T00:00:00Z'::timestamptz AND o.rental_end > '2026-08-01T12:00:00Z'::timestamptz;`);
assert.equal(conflict, '2', 'availability did not count the hold: ' + conflict);
console.log('✓ availability counts the soft-reserved hold (conflict_qty=2)');

// cleanup
psql(`DELETE FROM order_items WHERE order_id='${orderId}'; DELETE FROM standbys WHERE id='${stbId}'; DELETE FROM orders WHERE id='${orderId}';`);
console.log('\n=== PG16 STANDBY PERSISTENCE ROUND-TRIP PASSED ===');
