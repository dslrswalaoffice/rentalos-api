// Rule B — real PG16 round-trip for the Sub-slice 2.3 migrations (046–053).
// ---------------------------------------------------------------------------
// Proves the NEW tables/enum/constraints accept the real DML the M2 backend will
// run, and REJECT malformed data — against a database that already carries the
// real 045-era schema (ss23 = clone of ss22b + migrations 046–053 applied).
//
// This is a SCHEMA-level harness (raw INSERTs, no lib code yet). The M2 milestone
// adds lib-driven round-trips on top. Follows the 2.2 pattern
// (scripts/standby_e2e_pg16.ts): psql via runuser, fixed-UUID fixtures, dedicated
// DB, self-cleaning. Run: tsx scripts/ss23_migrations_pg16.ts
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';

const DB = 'ss23';
function psql(sql: string): string {
  return execFileSync(
    'runuser',
    ['-u', 'ubuntu', '--', '/usr/lib/postgresql/16/bin/psql', '-h', '/tmp/pgrun', '-p', '5433',
      '-U', 'postgres', '-d', DB, '-tAqc', sql],
    { encoding: 'utf8' },
  ).trim();
}
/** Run SQL expected to FAIL (a constraint violation). Returns true if it errored. */
function psqlExpectError(sql: string): boolean {
  try {
    execFileSync(
      'runuser',
      ['-u', 'ubuntu', '--', '/usr/lib/postgresql/16/bin/psql', '-h', '/tmp/pgrun', '-p', '5433',
        '-U', 'postgres', '-d', DB, '-v', 'ON_ERROR_STOP=1', '-tAqc', sql],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] },
    );
    return false; // succeeded → constraint did NOT fire
  } catch {
    return true; // errored → constraint fired
  }
}

// Fixture ids (valid hex uuids, distinct namespace from the 2.2 harness).
const WS = 'a1111111-1111-1111-1111-111111111111';
const USER = 'a2222222-2222-2222-2222-222222222222';
const CUST = 'a3333333-3333-3333-3333-333333333333';
const LOC = 'a6666666-6666-6666-6666-666666666666';
const PROD = 'a7777777-7777-7777-7777-777777777777';
const PROD2 = 'a7777777-7777-7777-7777-777777777778';
const ORDER = 'a8888888-8888-8888-8888-888888888888';
const OI = 'a9999999-9999-9999-9999-999999999991';
const ASSET = 'aaaa1111-1111-1111-1111-111111111111';
const ASSET2 = 'aaaa2222-2222-2222-2222-222222222222';
const SUB = 'b1111111-1111-1111-1111-111111111111';
const DI = 'b2222222-2222-2222-2222-222222222222';

// Clean any leftovers from a prior run (children first).
psql(`
  DELETE FROM damage_incident_events WHERE workspace_id='${WS}';
  DELETE FROM damage_incident_assets WHERE workspace_id='${WS}';
  DELETE FROM damage_incidents WHERE workspace_id='${WS}';
  DELETE FROM substitutions WHERE workspace_id='${WS}';
  DELETE FROM order_items WHERE order_id='${ORDER}';
  DELETE FROM orders WHERE id='${ORDER}';
  DELETE FROM assets WHERE workspace_id='${WS}';
  DELETE FROM products WHERE workspace_id='${WS}' AND id IN ('${PROD}','${PROD2}');
`);

// Fixture.
psql(`INSERT INTO workspaces (id,name,slug) VALUES ('${WS}','WS23','ws23') ON CONFLICT (id) DO NOTHING;`);
psql(`INSERT INTO users (id,email,password_hash,display_name) VALUES ('${USER}','u23@x.com','x','Op') ON CONFLICT (id) DO NOTHING;`);
psql(`INSERT INTO people (id,workspace_id,display_name,phone) VALUES ('${CUST}','${WS}','Priya Shah','9990002222') ON CONFLICT (id) DO NOTHING;`);
psql(`INSERT INTO locations (id,workspace_id,name,is_default) VALUES ('${LOC}','${WS}','Main23',true) ON CONFLICT (id) DO NOTHING;`);
psql(`INSERT INTO products (id,workspace_id,name,sku,category,daily_rate) VALUES
      ('${PROD}','${WS}','Sony FX3','FX3-23','camera',100000),
      ('${PROD2}','${WS}','Sony FX6','FX6-23','camera',150000) ON CONFLICT (id) DO NOTHING;`);
psql(`INSERT INTO assets (id,workspace_id,product_id,asset_code,location_id) VALUES
      ('${ASSET}','${WS}','${PROD}','SONY-FX3-BODY-23A','${LOC}'),
      ('${ASSET2}','${WS}','${PROD2}','SONY-FX6-BODY-23A','${LOC}') ON CONFLICT (id) DO NOTHING;`);
psql(`INSERT INTO orders (id,workspace_id,order_number,customer_person_id,pickup_location_id,return_location_id,status)
      VALUES ('${ORDER}','${WS}',9231,'${CUST}','${LOC}','${LOC}','dispatched') ON CONFLICT (id) DO NOTHING;`);
psql(`INSERT INTO order_items (id,workspace_id,order_id,item_type,description,product_id,quantity,status)
      VALUES ('${OI}','${WS}','${ORDER}','rental','Sony FX3 (original)','${PROD}',1,'dispatched') ON CONFLICT (id) DO NOTHING;`);

console.log('fixture ready');

// ── Test 1: create a substitution (proposed) — real shape persists ──────────
psql(`INSERT INTO substitutions
  (id, workspace_id, order_id, substitution_number, source_type, substitution_type,
   substitution_reason_tag, substitution_reason_notes, original_order_item_id, original_asset_id,
   original_prior_status, financial_handling, financial_amount_paise, timing, status,
   requires_approval, created_by)
  VALUES
  ('${SUB}','${WS}','${ORDER}','SUB-2026-9231-01','pre_dispatch_check','same_product_swap',
   'unit_failed_precheck','FX3 body #A failed the pre-dispatch check','${OI}','${ASSET}',
   'dispatched','no_change',0,'immediate_before_dispatch','proposed',false,'${USER}');`);
{
  const row = psql(`SELECT status||'|'||financial_handling||'|'||(policy_applied_snapshot='{}'::jsonb)::text||'|'||requires_approval::text
                    FROM substitutions WHERE id='${SUB}';`);
  assert.equal(row, 'proposed|no_change|true|false', `substitution row shape: ${row}`);
  console.log('  ✓ T1 substitution persists (proposed, default policy snapshot {})');
}

// ── Test 2: original line → substituted_out (the new enum value is accepted) ─
psql(`UPDATE order_items SET status='substituted_out' WHERE id='${OI}';`);
{
  const s = psql(`SELECT status FROM order_items WHERE id='${OI}';`);
  assert.equal(s, 'substituted_out', `order_items.status: ${s}`);
  console.log('  ✓ T2 order_items.status = substituted_out accepted (enum value present)');
}

// ── Test 3: CHECK constraints reject bad enum-ish values ────────────────────
assert.ok(psqlExpectError(
  `INSERT INTO substitutions (id,workspace_id,order_id,substitution_number,source_type,substitution_type,
     substitution_reason_tag,original_order_item_id,financial_handling,timing,status,created_by)
   VALUES (gen_random_uuid(),'${WS}','${ORDER}','SUB-BAD','BOGUS_SOURCE','same_product_swap',
     'other','${OI}','no_change','scheduled','proposed','${USER}');`),
  'source_type CHECK should reject BOGUS_SOURCE');
console.log('  ✓ T3 source_type CHECK rejects an invalid value');

// ── Test 4: unique (workspace_id, substitution_number) ──────────────────────
assert.ok(psqlExpectError(
  `INSERT INTO substitutions (id,workspace_id,order_id,substitution_number,source_type,substitution_type,
     substitution_reason_tag,original_order_item_id,financial_handling,timing,status,created_by)
   VALUES (gen_random_uuid(),'${WS}','${ORDER}','SUB-2026-9231-01','direct','same_product_swap',
     'other','${OI}','no_change','scheduled','proposed','${USER}');`),
  'duplicate substitution_number in same workspace should be rejected');
console.log('  ✓ T4 unique (workspace_id, substitution_number) enforced');

// ── Test 5: damage incident + assets + events round-trip ────────────────────
psql(`INSERT INTO damage_incidents
  (id, workspace_id, order_id, incident_number, reported_by_type, occurred_at, incident_type,
   severity, description, customer_liability, liability_percent, financial_resolution, deposit_action,
   status, requires_approval, created_by, linked_substitution_id)
  VALUES
  ('${DI}','${WS}','${ORDER}','DI-2026-9231','customer_whatsapp', now() - interval '2 hours','accidental_drop',
   'major','Dropped on concrete, lens mount cracked','yes',100,'pending','hold',
   'reported',true,'${USER}','${SUB}');`);
psql(`INSERT INTO damage_incident_assets
  (id, workspace_id, damage_incident_id, order_item_id, asset_id, severity, disposition)
  VALUES (gen_random_uuid(),'${WS}','${DI}','${OI}','${ASSET}','major','maintenance_required');`);
psql(`INSERT INTO damage_incident_events
  (id, workspace_id, damage_incident_id, event_type, actor_type, actor_id, actor_name, title, body)
  VALUES (gen_random_uuid(),'${WS}','${DI}','reported','user','${USER}','Op','Incident reported','via customer WhatsApp');`);
{
  const di = psql(`SELECT status||'|'||severity||'|'||customer_liability||'|'||(linked_substitution_id='${SUB}')::text
                   FROM damage_incidents WHERE id='${DI}';`);
  assert.equal(di, 'reported|major|yes|true', `damage_incident shape: ${di}`);
  const nAssets = psql(`SELECT count(*) FROM damage_incident_assets WHERE damage_incident_id='${DI}';`);
  const nEvents = psql(`SELECT count(*) FROM damage_incident_events WHERE damage_incident_id='${DI}';`);
  assert.equal(nAssets, '1', 'one damage_incident_assets row');
  assert.equal(nEvents, '1', 'one damage_incident_events row');
  console.log('  ✓ T5 damage_incident + 1 asset + 1 event persist; linked_substitution_id resolves');
}

// ── Test 6: severity CHECK + liability_percent range ────────────────────────
assert.ok(psqlExpectError(
  `INSERT INTO damage_incidents (id,workspace_id,order_id,incident_number,reported_by_type,occurred_at,
     incident_type,severity,description,status,created_by)
   VALUES (gen_random_uuid(),'${WS}','${ORDER}','DI-BAD','staff_observation',now(),'impact_damage',
     'apocalyptic','x','reported','${USER}');`),
  'severity CHECK should reject apocalyptic');
assert.ok(psqlExpectError(
  `INSERT INTO damage_incidents (id,workspace_id,order_id,incident_number,reported_by_type,occurred_at,
     incident_type,severity,description,liability_percent,status,created_by)
   VALUES (gen_random_uuid(),'${WS}','${ORDER}','DI-BAD2','staff_observation',now(),'impact_damage',
     'minor','x',150,'reported','${USER}');`),
  'liability_percent BETWEEN 0 AND 100 should reject 150');
console.log('  ✓ T6 severity CHECK + liability_percent(0..100) range enforced');

// ── Test 7: order can close while incident stays open (parallel lifecycle) ──
psql(`UPDATE orders SET status='closed' WHERE id='${ORDER}';`);
{
  const open = psql(`SELECT count(*) FROM damage_incidents WHERE order_id='${ORDER}' AND status <> 'closed';`);
  assert.equal(open, '1', 'incident stays open after order closes');
  console.log('  ✓ T7 order closed with an open incident (parallel lifecycle intact)');
}

// Cleanup.
psql(`
  DELETE FROM damage_incident_events WHERE workspace_id='${WS}';
  DELETE FROM damage_incident_assets WHERE workspace_id='${WS}';
  DELETE FROM damage_incidents WHERE workspace_id='${WS}';
  DELETE FROM substitutions WHERE workspace_id='${WS}';
  DELETE FROM order_items WHERE order_id='${ORDER}';
  DELETE FROM orders WHERE id='${ORDER}';
  DELETE FROM assets WHERE workspace_id='${WS}';
  DELETE FROM products WHERE workspace_id='${WS}' AND id IN ('${PROD}','${PROD2}');
`);

console.log('\nALL PG16 MIGRATION ROUND-TRIP CHECKS PASSED');
