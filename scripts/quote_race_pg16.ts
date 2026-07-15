// Real-DB round-trip (Rule B) for the Sub-slice 2.2 hotfix Bug 2 retry.
// Validates the version-numbering retry ALGORITHM against real Postgres UNIQUE
// semantics: two "concurrent" creates that both read version max = 0 must end up
// as v1 AND v2 (gap-free), never a 500. The neon HTTP driver can't reach local
// PG16, so this replicates createQuoteVersionFromOrder's retry loop in psql
// (same read-max → insert → on-conflict-recompute-retry logic).
// Run: tsx scripts/quote_race_pg16.ts
import { execFileSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { isVersionNumberConflict } from '../src/lib/quotes.js';

const DB = 'ss22b';
const WS = '11111111-1111-1111-1111-111111111111';
const ORD = '878ca187-660e-43f0-bba0-91c5f33328b7';
const USER = '22222222-2222-2222-2222-222222222222';

function psql(sqlText: string): string {
  return execFileSync('runuser', ['-u', 'ubuntu', '--', 'psql', '-h', '/tmp/pgrun', '-p', '5433',
    '-U', 'postgres', '-d', DB, '-tAqc', sqlText], { encoding: 'utf8' }).trim();
}
function tryInsert(versionNumber: number): { ok: boolean; err?: any } {
  try {
    execFileSync('runuser', ['-u', 'ubuntu', '--', 'psql', '-h', '/tmp/pgrun', '-p', '5433', '-U', 'postgres',
      '-d', DB, '-v', 'ON_ERROR_STOP=1', '-c',
      `INSERT INTO quote_versions (workspace_id,order_id,version_number,quote_number,content_snapshot,total_paise,deposit_paise,status,created_by_user_id,policy_applied_snapshot)
       VALUES ('${WS}','${ORD}',${versionNumber},'QT-v${versionNumber}','{}',0,0,'draft','${USER}','{}')`],
      { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] });
    return { ok: true };
  } catch (e: any) {
    // psql prints the SQLSTATE + message to stderr; surface it for the detector.
    const msg = String(e.stderr ?? e.message ?? '');
    const code = /23505/.test(msg) ? '23505' : undefined;
    return { ok: false, err: { code, message: msg } };
  }
}

// createQuoteVersionFromOrder's retry loop, replicated.
function createVersion(): number {
  for (let attempt = 1; ; attempt++) {
    const prev = Number(psql(`SELECT COALESCE(MAX(version_number),0) FROM quote_versions WHERE order_id='${ORD}' AND workspace_id='${WS}'`));
    const versionNumber = prev + 1;
    const r = tryInsert(versionNumber);
    if (r.ok) return versionNumber;
    assert.ok(isVersionNumberConflict(r.err), 'unexpected error (not a version conflict): ' + JSON.stringify(r.err));
    if (attempt >= 4) throw new Error('exhausted retries');
  }
}

// ---- fixtures ----
psql(`DELETE FROM quote_versions WHERE order_id='${ORD}'`);
psql(`INSERT INTO workspaces (id,name,slug) VALUES ('${WS}','WS','ws') ON CONFLICT DO NOTHING`);
psql(`INSERT INTO users (id,email,password_hash,display_name) VALUES ('${USER}','u@x.com','x','U') ON CONFLICT DO NOTHING`);
psql(`INSERT INTO people (id,workspace_id,display_name,phone) VALUES ('33333333-3333-3333-3333-333333333333','${WS}','Meera','999') ON CONFLICT DO NOTHING`);
psql(`INSERT INTO locations (id,workspace_id,name,is_default) VALUES ('66666666-6666-6666-6666-666666666666','${WS}','Main',true) ON CONFLICT DO NOTHING`);
psql(`INSERT INTO orders (id,workspace_id,order_number,customer_person_id,status,rental_start,rental_end,pickup_location_id,return_location_id)
  VALUES ('${ORD}','${WS}',21,'33333333-3333-3333-3333-333333333333','quoted','2026-08-10T04:30:00Z','2026-08-13T04:30:00Z','66666666-6666-6666-6666-666666666666','66666666-6666-6666-6666-666666666666') ON CONFLICT DO NOTHING`);

// ---- simulate the race: request B reads max=0 BEFORE request A commits v1 ----
// A commits v1 first.
const vA = createVersion();
// B already read max=0; force its first attempt at v1 (the stale number) → conflict → retry → v2.
let bAttempts = 0; let vB = -1;
for (let attempt = 1; ; attempt++) {
  bAttempts++;
  const versionNumber = attempt === 1 ? 1 /* stale read */ : Number(psql(`SELECT COALESCE(MAX(version_number),0) FROM quote_versions WHERE order_id='${ORD}'`)) + 1;
  const r = tryInsert(versionNumber);
  if (r.ok) { vB = versionNumber; break; }
  assert.ok(isVersionNumberConflict(r.err), 'B: unexpected error: ' + JSON.stringify(r.err));
  if (attempt >= 4) throw new Error('B exhausted retries');
}

console.log(`✓ request A created v${vA}`);
console.log(`✓ request B raced (stale v1 → conflict → retry), created v${vB} in ${bAttempts} attempts`);

const rows = psql(`SELECT string_agg(version_number::text, ',' ORDER BY version_number) FROM quote_versions WHERE order_id='${ORD}'`);
assert.equal(vA, 1, 'A should be v1');
assert.equal(vB, 2, 'B should recover to v2');
assert.equal(rows, '1,2', 'final versions must be gap-free v1,v2 — got ' + rows);
assert.equal(bAttempts, 2, 'B should succeed on its 2nd attempt (1 conflict + 1 success)');
console.log(`✓ final quote_versions for the order: [${rows}] — race produced v1+v2, no 500, no orphan`);

psql(`DELETE FROM quote_versions WHERE order_id='${ORD}'`);
console.log('\n=== PG16 QUOTE-VERSION RACE RETRY PASSED ===');
