// ============================================================================
// test/damage_slice11_s1.test.ts — Slice 11 Session 1 (damage integration seams).
// ----------------------------------------------------------------------------
// Rule A — the financial-resolution schema accepts the forfeit amount the seam
//          keys off; the create schema still holds.
// Rule E — the seam orchestrator is exported + wired into both consumers
//          (inspection completion, damage financial resolution); the DB-free
//          disposition branches behave; every seam is fail-soft (never throws).
//
// Rule B (real PG16 round-trip: fail_major -> incident; settled resolution ->
//         deposit_forfeit payment + retained line + additional-only damage line;
//         maintenance -> product_downtimes; retire -> asset status+soft-delete;
//         event key renamed) is validated SEPARATELY against real PostgreSQL 16 —
//         the Neon HTTP driver can't reach a local PG from `npm test`. See the
//         scratchpad damage_s11_roundtrip.sql (output captured in the PR).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost/test';

import { financialResolutionSchema, damageCreateSchema } from '../src/routes/damage.js';
import { executeAssetDispositionEffects, applyDamageFinancialSideEffects, triggerDamageIncidentFromInspection } from '../src/lib/damage_lifecycle.js';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');

// ---------- Rule A ----------
test('financialResolutionSchema accepts the deposit forfeit amount the seam consumes', () => {
  const ok = financialResolutionSchema.safeParse({
    customer_liability: 'yes', financial_resolution: 'deposit_plus_additional',
    deposit_action: 'forfeit_partial', deposit_forfeit_amount_paise: 500000, final_cost_paise: 800000,
  });
  assert.equal(ok.success, true);
  assert.equal(financialResolutionSchema.safeParse({ customer_liability: 'maybe', financial_resolution: 'pending', deposit_action: 'no_change' }).success, false);
  assert.equal(financialResolutionSchema.safeParse({ customer_liability: 'yes', financial_resolution: 'customer_pays', deposit_action: 'hold', deposit_forfeit_amount_paise: -1 }).success, false);
});

test('damageCreateSchema still requires an affected item + valid enums', () => {
  assert.equal(damageCreateSchema.safeParse({ reported_by_type: 'inspection_at_return', occurred_at: new Date().toISOString(), incident_type: 'wear_and_tear_dispute', severity: 'major', description: 'x', affected_items: [{ order_item_id: '11111111-1111-1111-1111-111111111111', severity: 'major' }] }).success, true);
  assert.equal(damageCreateSchema.safeParse({ reported_by_type: 'inspection_at_return', occurred_at: new Date().toISOString(), incident_type: 'wear_and_tear_dispute', severity: 'major', description: 'x', affected_items: [] }).success, false);
});

// ---------- Rule E: wiring ----------
test('both consumers import the seam orchestrator (static wiring)', () => {
  assert.match(read('../src/routes/inspections.ts'), /triggerDamageIncidentFromInspection/);
  assert.match(read('../src/routes/inspections.ts'), /auto_create_from_inspection/);
  assert.match(read('../src/routes/damage.ts'), /applyDamageFinancialSideEffects/);
});

test('migration 066 renames the orphan event key + adds the column', () => {
  const m = read('../migrations/066_damage_slice11_s1.sql');
  assert.match(m, /#- '\{notification_policy,events,damage_reported\}'/);
  assert.match(m, /damage_incident_reported/);
  assert.match(m, /deposit_forfeit_payment_id uuid REFERENCES payments\(id\)/);
});

// ---------- Rule E: DB-free disposition branches + fail-soft ----------
test('executeAssetDispositionEffects — no-op dispositions return before any DB call', async () => {
  const base = { workspaceId: 'w', orderId: 'o', damageIncidentAssetId: 'dia', incidentNumber: 'DI-1', actorUserId: 'u', linkedDowntimeId: null };
  assert.deepEqual(await executeAssetDispositionEffects({ ...base, assetId: 'a', disposition: 'return_to_service' }), { effect: 'none' });
  assert.deepEqual(await executeAssetDispositionEffects({ ...base, assetId: 'a', disposition: 'scrap' }), { effect: 'none' });
  // maintenance/retire with no serialized unit is also a no-op (bulk line).
  assert.deepEqual(await executeAssetDispositionEffects({ ...base, assetId: null, disposition: 'retire' }), { effect: 'none' });
  // idempotent: maintenance with an existing downtime does not re-create.
  assert.deepEqual(await executeAssetDispositionEffects({ ...base, assetId: 'a', disposition: 'maintenance_required', linkedDowntimeId: 'dt' }), { effect: 'downtime_exists' });
});

test('applyDamageFinancialSideEffects is fail-soft (returns a result, never throws) with no DB', async () => {
  const r = await applyDamageFinancialSideEffects({
    workspaceId: 'w', orderId: 'o', damageIncidentId: 'd', incidentNumber: 'DI-1', actorUserId: 'u',
    customerLiability: 'yes', finalCostPaise: 800000, depositAction: 'forfeit_partial',
    depositForfeitAmountPaise: 500000, autoExecuteForfeit: true,
  });
  assert.ok(r && typeof r === 'object' && Array.isArray(r.asset_effects));
  assert.equal(r.deposit_forfeit_payment_id, null); // the DB write threw + was swallowed
});

test('triggerDamageIncidentFromInspection is fail-soft with no DB (returns, never throws)', async () => {
  const r = await triggerDamageIncidentFromInspection({
    workspaceId: 'w', orderId: 'o', orderItemId: 'oi', assetId: null, actorUserId: 'u', actorName: 'Ruhan',
  });
  assert.ok(r && typeof r === 'object' && 'ok' in r);
});
