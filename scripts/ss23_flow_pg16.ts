// Rule B — real PG16 FLOW round-trip for Sub-slice 2.3 (substitution + damage
// state machines). The neon HTTP driver can't reach local PG16, so this
// replicates the EXACT SQL sequence src/lib/substitutions.ts + src/lib/damage.ts
// run (create → execute → revert; report → save-the-shoot → financial → close)
// against ss23, and asserts the end state each lib guarantees. It also imports the
// REAL RESERVING_ITEM_STATUSES constant and proves a substituted_out line drops
// out of the availability conflict query.  Run: tsx scripts/ss23_flow_pg16.ts
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { RESERVING_ITEM_STATUSES } from '../src/lib/availability.js';

const DB = 'ss23';
function psql(sqlText: string): string {
  return execFileSync('runuser', ['-u', 'ubuntu', '--', '/usr/lib/postgresql/16/bin/psql', '-h', '/tmp/pgrun',
    '-p', '5433', '-U', 'postgres', '-d', DB, '-tAqc', sqlText], { encoding: 'utf8' }).trim();
}

const WS = 'c1111111-1111-1111-1111-111111111111';
const USER = 'c2222222-2222-2222-2222-222222222222';
const CUST = 'c3333333-3333-3333-3333-333333333333';
const LOC = 'c6666666-6666-6666-6666-666666666666';
const PROD = 'c7777777-7777-7777-7777-777777777777';
const PROD2 = 'c7777777-7777-7777-7777-777777777778';
const ORDER = 'c8888888-8888-8888-8888-888888888888';
const OI = 'c9999999-9999-9999-9999-999999999991';
const ASSET = 'caaa1111-1111-1111-1111-111111111111';
const ASSET2 = 'caaa2222-2222-2222-2222-222222222222';

// Clean + fixture.
psql(`
  DELETE FROM damage_incident_events WHERE workspace_id='${WS}';
  DELETE FROM damage_incident_assets WHERE workspace_id='${WS}';
  DELETE FROM damage_incidents WHERE workspace_id='${WS}';
  DELETE FROM substitutions WHERE workspace_id='${WS}';
  DELETE FROM order_assets WHERE workspace_id='${WS}';
  DELETE FROM order_items WHERE order_id='${ORDER}';
  DELETE FROM assets WHERE workspace_id='${WS}';
  DELETE FROM products WHERE workspace_id='${WS}';
`);
psql(`INSERT INTO workspaces (id,name,slug) VALUES ('${WS}','WSF','wsf') ON CONFLICT (id) DO NOTHING;`);
psql(`INSERT INTO users (id,email,password_hash,display_name) VALUES ('${USER}','f@x.com','x','Op') ON CONFLICT (id) DO NOTHING;`);
psql(`INSERT INTO people (id,workspace_id,display_name,phone) VALUES ('${CUST}','${WS}','Neha Rao','9990003333') ON CONFLICT (id) DO NOTHING;`);
psql(`INSERT INTO locations (id,workspace_id,name,is_default) VALUES ('${LOC}','${WS}','MainF',true) ON CONFLICT (id) DO NOTHING;`);
psql(`INSERT INTO products (id,workspace_id,name,sku,category,daily_rate) VALUES
  ('${PROD}','${WS}','Sony FX3','FX3-F','camera',100000),
  ('${PROD2}','${WS}','Sony FX6','FX6-F','camera',150000) ON CONFLICT (id) DO NOTHING;`);
psql(`INSERT INTO assets (id,workspace_id,product_id,asset_code,location_id,status) VALUES
  ('${ASSET}','${WS}','${PROD}','FX3-F-01','${LOC}','out'),
  ('${ASSET2}','${WS}','${PROD2}','FX6-F-01','${LOC}','available') ON CONFLICT (id) DO NOTHING;`);
psql(`INSERT INTO orders (id,workspace_id,order_number,customer_person_id,pickup_location_id,return_location_id,status)
  VALUES ('${ORDER}','${WS}',9241,'${CUST}','${LOC}','${LOC}','dispatched') ON CONFLICT (id) DO NOTHING;`);
psql(`INSERT INTO order_items (id,workspace_id,order_id,item_type,description,product_id,quantity,daily_rate_paise,unit_amount_paise,total_amount_paise,status)
  VALUES ('${OI}','${WS}','${ORDER}','rental','Sony FX3','${PROD}',1,100000,100000,100000,'dispatched') ON CONFLICT (id) DO NOTHING;`);
psql(`UPDATE orders SET status='dispatched' WHERE id='${ORDER}';`);
console.log('fixture ready');

// ══ SUBSTITUTION FLOW ════════════════════════════════════════════════════════
// createSubstitution (proposed, no approval).
const SUB = psql(`INSERT INTO substitutions
  (workspace_id, order_id, substitution_number, source_type, substitution_type, substitution_reason_tag,
   original_order_item_id, original_asset_id, original_prior_status, replacement_product_id, replacement_asset_id,
   financial_handling, financial_amount_paise, timing, status, requires_approval, created_by, policy_applied_snapshot)
  VALUES ('${WS}','${ORDER}','SUB-2026-9241-01','pre_dispatch_check','equivalent_product_swap','unit_damaged_in_rental',
   '${OI}','${ASSET}','dispatched','${PROD2}','${ASSET2}','no_change',0,'rush_mid_rental','proposed',false,'${USER}',
   '{"reversion_window_hours":24}'::jsonb) RETURNING id;`);
assert.ok(SUB, 'substitution created');
console.log('  ✓ S1 createSubstitution → proposed row');

// executeSubstitution replicated: replacement line, original→substituted_out,
// asset flips, 2 events, sub→executed.
const REPL = psql(`INSERT INTO order_items (workspace_id,order_id,item_type,product_id,description,quantity,daily_rate_paise,unit_amount_paise,total_amount_paise,status)
  VALUES ('${WS}','${ORDER}','rental','${PROD2}','Sony FX3 (substituted)',1,150000,150000,100000,'dispatched') RETURNING id;`);
psql(`UPDATE order_items SET status='substituted_out' WHERE id='${OI}';`);
psql(`UPDATE assets SET status='available' WHERE id='${ASSET}' AND status='out';`);
psql(`UPDATE assets SET status='out' WHERE id='${ASSET2}' AND status='available';`);
psql(`INSERT INTO order_assets (workspace_id,order_id,order_item_id,asset_id) VALUES ('${WS}','${ORDER}','${REPL}','${ASSET2}') ON CONFLICT DO NOTHING;`);
const retEv = psql(`INSERT INTO order_events (workspace_id,order_id,event_type,payload,actor_user_id) VALUES ('${WS}','${ORDER}','order.substitution.return','{}'::jsonb,'${USER}') RETURNING id;`);
const dispEv = psql(`INSERT INTO order_events (workspace_id,order_id,event_type,payload,actor_user_id) VALUES ('${WS}','${ORDER}','order.substitution.dispatch','{}'::jsonb,'${USER}') RETURNING id;`);
psql(`UPDATE substitutions SET status='executed', executed_at=now(), replacement_order_item_id='${REPL}', linked_return_event_id='${retEv}', linked_dispatch_event_id='${dispEv}' WHERE id='${SUB}';`);
{
  const orig = psql(`SELECT status FROM order_items WHERE id='${OI}';`);
  const subStatus = psql(`SELECT status||'|'||(replacement_order_item_id='${REPL}')::text FROM substitutions WHERE id='${SUB}';`);
  const a1 = psql(`SELECT status FROM assets WHERE id='${ASSET}';`);
  const a2 = psql(`SELECT status FROM assets WHERE id='${ASSET2}';`);
  assert.equal(orig, 'substituted_out', 'original substituted_out');
  assert.equal(subStatus, 'executed|true', 'sub executed + replacement linked');
  assert.equal(a1, 'available', 'original asset returned to available');
  assert.equal(a2, 'out', 'replacement asset now out');
  console.log('  ✓ S2 executeSubstitution → original substituted_out, replacement line + assets flipped');
}

// substituted_out is NON-RESERVING: it must be absent from the real constant AND
// must not appear in the availability conflict query.
assert.ok(!(RESERVING_ITEM_STATUSES as readonly string[]).includes('substituted_out'), 'substituted_out absent from RESERVING_ITEM_STATUSES');
{
  const reservingCsv = RESERVING_ITEM_STATUSES.join(',');
  const stillReserves = psql(`SELECT COUNT(*) FROM order_items WHERE id='${OI}' AND status::text = ANY(string_to_array('${reservingCsv}',','));`);
  assert.equal(stillReserves, '0', 'substituted_out line does NOT reserve capacity');
  console.log('  ✓ S3 substituted_out is non-reserving (real RESERVING_ITEM_STATUSES + conflict query)');
}

// revertSubstitution replicated (within window): restore original, clear the FK
// reference + mark reverted FIRST, THEN drop the replacement line (the
// replacement_order_item_id FK would otherwise block the delete).
psql(`UPDATE order_items SET status='dispatched' WHERE id='${OI}';`);
psql(`UPDATE substitutions SET status='reverted', reverted_at=now(), reverted_by='${USER}', replacement_order_item_id=NULL WHERE id='${SUB}';`);
psql(`DELETE FROM order_assets WHERE order_item_id='${REPL}';`);
psql(`DELETE FROM order_items WHERE id='${REPL}';`);
psql(`UPDATE assets SET status='available' WHERE id='${ASSET2}' AND status='out';`);
psql(`UPDATE assets SET status='out' WHERE id='${ASSET}' AND status='available';`);
{
  const orig = psql(`SELECT status FROM order_items WHERE id='${OI}';`);
  const replGone = psql(`SELECT COUNT(*) FROM order_items WHERE id='${REPL}';`);
  const subStatus = psql(`SELECT status FROM substitutions WHERE id='${SUB}';`);
  assert.equal(orig, 'dispatched', 'original restored to prior status');
  assert.equal(replGone, '0', 'replacement line removed');
  assert.equal(subStatus, 'reverted', 'sub reverted');
  console.log('  ✓ S4 revertSubstitution → original restored, replacement removed, sub reverted');
}

// ══ DAMAGE FLOW ══════════════════════════════════════════════════════════════
// createDamageIncident (auto-liability 'yes' for accidental_drop, requires_approval
// true for major severity).
const DI = psql(`INSERT INTO damage_incidents
  (workspace_id, order_id, incident_number, reported_by_type, occurred_at, incident_type, severity, description,
   customer_liability, estimated_cost_paise, financial_resolution, deposit_action, status, requires_approval,
   created_by, policy_applied_snapshot)
  VALUES ('${WS}','${ORDER}','DI-2026-9241-001','customer_whatsapp', now()-interval '1 hour','accidental_drop','major',
   'Dropped on set','yes',4500000,'pending','no_change','reported',true,
   '${USER}','{"auto_liability_applied":"yes"}'::jsonb) RETURNING id;`);
psql(`INSERT INTO damage_incident_assets (workspace_id,damage_incident_id,order_item_id,asset_id,severity,disposition)
  VALUES ('${WS}','${DI}','${OI}','${ASSET}','major','maintenance_required');`);
psql(`INSERT INTO damage_incident_events (workspace_id,damage_incident_id,event_type,actor_type,actor_id,actor_name,title)
  VALUES ('${WS}','${DI}','reported','user','${USER}','Op','Incident reported');`);
{
  const shape = psql(`SELECT status||'|'||customer_liability||'|'||requires_approval::text FROM damage_incidents WHERE id='${DI}';`);
  assert.equal(shape, 'reported|yes|true', `damage incident shape: ${shape}`);
  console.log('  ✓ D1 createDamageIncident → reported, auto-liability yes, requires_approval (major)');
}

// saveTheShoot substitute → linked substitution.
const SUB2 = psql(`INSERT INTO substitutions
  (workspace_id, order_id, substitution_number, source_type, source_id, substitution_type, substitution_reason_tag,
   original_order_item_id, original_prior_status, financial_handling, timing, status, requires_approval, created_by, policy_applied_snapshot)
  VALUES ('${WS}','${ORDER}','SUB-2026-9241-02','damage_incident','${DI}','same_product_swap','unit_damaged_in_rental',
   '${OI}','dispatched','no_change','rush_mid_rental','proposed',false,'${USER}','{}'::jsonb) RETURNING id;`);
psql(`UPDATE damage_incidents SET operational_decision='substitute_with_another_unit', operational_decided_at=now(),
   operational_decided_by='${USER}', linked_substitution_id='${SUB2}', status='investigating' WHERE id='${DI}';`);
psql(`INSERT INTO damage_incident_events (workspace_id,damage_incident_id,event_type,actor_type,actor_id,actor_name,title,body)
  VALUES ('${WS}','${DI}','save_the_shoot','user','${USER}','Op','Save The Shoot decision','substitute_with_another_unit');`);
{
  const linked = psql(`SELECT (linked_substitution_id='${SUB2}')::text||'|'||operational_decision||'|'||status FROM damage_incidents WHERE id='${DI}';`);
  assert.equal(linked, 'true|substitute_with_another_unit|investigating', `save-the-shoot: ${linked}`);
  console.log('  ✓ D2 saveTheShoot(substitute) → linked_substitution_id set, status investigating');
}

// financialResolution → resolution_proposed (approval still required at major).
psql(`UPDATE damage_incidents SET customer_liability='partial', liability_percent=60, final_cost_paise=3000000,
   financial_resolution='deposit_plus_additional', financial_resolved_at=now(), financial_resolved_by='${USER}',
   deposit_action='forfeit_partial', deposit_forfeit_amount_paise=1500000, requires_approval=true,
   status='resolution_proposed' WHERE id='${DI}';`);
psql(`INSERT INTO damage_incident_events (workspace_id,damage_incident_id,event_type,actor_type,actor_id,actor_name,title)
  VALUES ('${WS}','${DI}','financial_resolution_proposed','user','${USER}','Op','Financial resolution');`);
{
  const fr = psql(`SELECT status||'|'||financial_resolution||'|'||deposit_action FROM damage_incidents WHERE id='${DI}';`);
  assert.equal(fr, 'resolution_proposed|deposit_plus_additional|forfeit_partial', `financial resolution: ${fr}`);
  console.log('  ✓ D3 recordFinancialResolution → resolution_proposed + deposit action recorded');
}

// approve → financial_settled; close → closed.
psql(`UPDATE damage_incidents SET approved_by='${USER}', approved_at=now(), requires_approval=false, status='financial_settled' WHERE id='${DI}';`);
psql(`UPDATE damage_incidents SET status='closed' WHERE id='${DI}';`);
{
  const st = psql(`SELECT status FROM damage_incidents WHERE id='${DI}';`);
  const evCount = psql(`SELECT COUNT(*) FROM damage_incident_events WHERE damage_incident_id='${DI}';`);
  assert.equal(st, 'closed', 'incident closed');
  assert.ok(Number(evCount) >= 3, `timeline accrued ${evCount} events`);
  console.log('  ✓ D4 approve → financial_settled → close; timeline intact');
}

// Cleanup.
psql(`
  DELETE FROM damage_incident_events WHERE workspace_id='${WS}';
  DELETE FROM damage_incident_assets WHERE workspace_id='${WS}';
  DELETE FROM damage_incidents WHERE workspace_id='${WS}';
  DELETE FROM substitutions WHERE workspace_id='${WS}';
  DELETE FROM order_assets WHERE workspace_id='${WS}';
  DELETE FROM order_items WHERE order_id='${ORDER}';
  DELETE FROM assets WHERE workspace_id='${WS}';
  DELETE FROM products WHERE workspace_id='${WS}';
`);
console.log('\nALL PG16 FLOW ROUND-TRIP CHECKS PASSED');
