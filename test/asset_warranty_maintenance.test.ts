// ============================================================================
// test/asset_warranty_maintenance.test.ts — Phase 2 (Assets) completion S1.
// ----------------------------------------------------------------------------
// Per-asset warranty + maintenance-due attention. The flag computation is a PURE
// date helper (unit-tested here, no DB); the migration + endpoints + kit late-fee
// correctness are validated on real PG16 (captured in the PR).
//
// Rule A/unit — computeAssetLifecycleFlags is exact across the boundary cases the
//   pack's Rule B enumerates (expired / expiring / due / overdue / clean / null),
//   and honors configurable thresholds (Rule D). Zod schemas parse/reject.
// Rule E/source — the list + detail endpoints expose the flags + dates, the two
//   POST endpoints exist (inventory.manage), and late_fee_lifecycle has NO kit
//   exclusion (Q6 was a phantom — kits already price via the line's daily_rate).
// ============================================================================
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

process.env.DATABASE_URL ??= 'postgres://test:test@localhost/test';

import {
  computeAssetLifecycleFlags, readAssetAttentionPolicy, DEFAULT_ASSET_ATTENTION_POLICY,
} from '../src/lib/asset_analytics.js';
import { assetWarrantySchema, assetMaintenanceSchema, assetListSchema } from '../src/routes/inventory.js';

const read = (rel: string) => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), 'utf8');
const inv = read('../src/routes/inventory.ts');
const lateFee = read('../src/lib/late_fee_lifecycle.ts');
const migration = read('../migrations/071_asset_warranty_maintenance.sql');
const asset360 = read('../public/asset-360.html');

// Fixed "now" for deterministic date math.
const NOW = new Date('2026-06-15T09:00:00Z');
const iso = (offsetDays: number) => { const d = new Date(NOW); d.setUTCDate(d.getUTCDate() + offsetDays); return d.toISOString().slice(0, 10); };
const P = DEFAULT_ASSET_ATTENTION_POLICY; // {30, 14}

// ---------- Rule A/unit — flag boundaries ----------
test('warranty expired: past date', () => {
  const f = computeAssetLifecycleFlags({ warranty_expiry: iso(-5) }, P, NOW);
  assert.equal(f.warranty_expired, true); assert.equal(f.warranty_expiring, false);
});
test('warranty expiring: within 30-day threshold, not past', () => {
  const f = computeAssetLifecycleFlags({ warranty_expiry: iso(20) }, P, NOW);
  assert.equal(f.warranty_expiring, true); assert.equal(f.warranty_expired, false);
});
test('warranty clean: beyond threshold', () => {
  const f = computeAssetLifecycleFlags({ warranty_expiry: iso(45) }, P, NOW);
  assert.equal(f.warranty_expiring, false); assert.equal(f.warranty_expired, false);
});
test('warranty expiring today counts as expiring, not expired', () => {
  const f = computeAssetLifecycleFlags({ warranty_expiry: iso(0) }, P, NOW);
  assert.equal(f.warranty_expiring, true); assert.equal(f.warranty_expired, false);
});
test('maintenance overdue + due boundaries (14-day threshold)', () => {
  assert.equal(computeAssetLifecycleFlags({ next_service_due: iso(-3) }, P, NOW).maintenance_overdue, true);
  assert.equal(computeAssetLifecycleFlags({ next_service_due: iso(10) }, P, NOW).maintenance_due, true);
  assert.equal(computeAssetLifecycleFlags({ next_service_due: iso(20) }, P, NOW).maintenance_due, false);
});
test('null dates raise no flags (existing assets pass through)', () => {
  const f = computeAssetLifecycleFlags({ warranty_expiry: null, next_service_due: null }, P, NOW);
  assert.deepEqual(f, { warranty_expiring: false, warranty_expired: false, maintenance_due: false, maintenance_overdue: false });
});

// ---------- Rule D — configurable thresholds ----------
test('threshold configurable: 20d-out warranty is NOT expiring at 30, IS at 60', () => {
  assert.equal(computeAssetLifecycleFlags({ warranty_expiry: iso(45) }, { warranty_expiring_days: 30, maintenance_due_days: 14 }, NOW).warranty_expiring, false);
  assert.equal(computeAssetLifecycleFlags({ warranty_expiry: iso(45) }, { warranty_expiring_days: 60, maintenance_due_days: 14 }, NOW).warranty_expiring, true);
});
test('readAssetAttentionPolicy: defaults + override + bad values', () => {
  assert.deepEqual(readAssetAttentionPolicy(null), { warranty_expiring_days: 30, maintenance_due_days: 14 });
  assert.deepEqual(readAssetAttentionPolicy({ asset_attention_policy: { warranty_expiring_days: 60 } }), { warranty_expiring_days: 60, maintenance_due_days: 14 });
  assert.deepEqual(readAssetAttentionPolicy({ asset_attention_policy: { warranty_expiring_days: 'x', maintenance_due_days: -5 } }), { warranty_expiring_days: 30, maintenance_due_days: 14 });
});

// ---------- Rule A — Zod ----------
test('warranty/maintenance schemas parse valid + reject bad dates', () => {
  assert.equal(assetWarrantySchema.safeParse({ warranty_expiry: '2027-01-01', warranty_notes: 'AMC' }).success, true);
  assert.equal(assetWarrantySchema.safeParse({ warranty_expiry: null, warranty_notes: null }).success, true);
  assert.equal(assetWarrantySchema.safeParse({ warranty_expiry: 'nope', warranty_notes: null }).success, false);
  assert.equal(assetMaintenanceSchema.safeParse({ next_service_due: '2026-09-01', last_service_date: null }).success, true);
  // list schema gained the filters + sorts.
  assert.equal(assetListSchema.safeParse({ warranty_status: 'expiring_soon', sort: 'warranty_expiry_asc' }).success, true);
  assert.equal(assetListSchema.safeParse({ maintenance_status: 'overdue', sort: 'next_service_due_asc' }).success, true);
});

// ---------- Rule E/source ----------
test('inventory route exposes flags + dates on list & detail; 2 POST endpoints', () => {
  assert.match(inv, /warranty_expiring: lc\.warranty_expiring/);
  assert.match(inv, /attention_flags: lifecycleFlags/);
  assert.match(inv, /inventory\.post\('\/assets\/:id\/warranty', requirePermission\('inventory\.manage'\)/);
  assert.match(inv, /inventory\.post\('\/assets\/:id\/maintenance', requirePermission\('inventory\.manage'\)/);
  // audit reuses inventory.asset.updated with a fields flag (no new audit type).
  assert.match(inv, /eventType: 'inventory\.asset\.updated'[\s\S]*?fields: \['warranty_expiry'/);
});

test('late_fee_lifecycle has NO kit exclusion (Q6 phantom) — kits price via line rate', () => {
  assert.doesNotMatch(lateFee, /is_kit|kit/i);
  assert.match(lateFee, /COALESCE\(oi\.daily_rate_paise, p\.daily_rate, 0\)/);
});

test('migration 071 adds 4 columns + policy defaults + 2 indexes (idempotent)', () => {
  assert.match(migration, /ADD COLUMN IF NOT EXISTS warranty_expiry\s+date/);
  assert.match(migration, /ADD COLUMN IF NOT EXISTS next_service_due\s+date/);
  assert.match(migration, /asset_attention_policy/);
  assert.match(migration, /'warranty_expiring_days', '30'::jsonb/);
  assert.match(migration, /CREATE INDEX IF NOT EXISTS idx_assets_warranty_expiry/);
});

test('asset-360 renders real warranty/service card + edit modals (no more stub)', () => {
  assert.match(asset360, /Warranty & Service/);
  assert.match(asset360, /openWarrantyEdit/);
  assert.match(asset360, /\/api\/inventory\/assets\/' \+ A\.asset\.id \+ '\/warranty/);
  assert.match(asset360, /\/api\/inventory\/assets\/' \+ A\.asset\.id \+ '\/maintenance/);
});
