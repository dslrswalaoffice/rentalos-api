// ============================================================================
// migrate.ts · Migration engine
// ============================================================================
// One engine, two entry points:
//   1. The Vercel BUILD HOOK — package.json "vercel-build": "tsx src/lib/migrate.ts".
//      When this file is executed directly, the guard at the bottom constructs a
//      Neon client from DATABASE_URL and runs the migrations before the deploy
//      goes live.
//   2. The ADMIN ENDPOINT — src/routes/admin.ts imports runMigrations() and calls
//      it against the shared request-scoped sql client.
//
// The .sql files in /migrations are bundled into the serverless function at build
// time via `includeFiles` in vercel.json, so runMigrations() can read them at
// runtime too (not just during the build).
// ============================================================================

import { readdirSync, readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { neon } from '@neondatabase/serverless';

const __dirname = dirname(fileURLToPath(import.meta.url));

// The Neon tagged-template client. Callable as `sql`...`` AND as `sql(rawString)`.
type Sql = ReturnType<typeof neon>;

// Every table we expect to exist once 001 + 002 have applied. If any is missing
// after a migration run, something in the SQL silently failed — we bail loudly.
const EXPECTED_TABLES = [
  'workspaces',
  'users',
  'workspace_memberships',
  'sessions',
  'password_reset_tokens',
  'audit_events',
  'login_attempts',
  'products',
  'assets',
] as const;

export type MigrationResult = {
  applied: string[]; // versions applied this run
  skipped: string[]; // versions already recorded, skipped
  tables: string[];  // all public tables present after the run (sorted)
};

/**
 * Locate the migrations directory. Resolution differs between the build
 * environment (repo checkout) and the bundled serverless runtime, so we probe a
 * few candidate locations and use the first that exists.
 */
function resolveMigrationsDir(): string {
  const candidates = [
    join(__dirname, '..', '..', 'migrations'), // src/lib → repo root (build/dev)
    join(process.cwd(), 'migrations'),         // cwd = project root (Vercel build + runtime)
    join(__dirname, 'migrations'),             // colocated fallback
  ];
  for (const dir of candidates) {
    if (existsSync(dir)) return dir;
  }
  throw new Error(
    `Could not locate the migrations/ directory. Tried:\n  ${candidates.join('\n  ')}`
  );
}

/**
 * Apply every pending migration in /migrations, in filename order.
 *
 * Idempotent: a `schema_migrations` table records which versions have run, so
 * re-invoking is a no-op for already-applied files. After applying, we verify
 * all expected tables exist and throw if any are missing.
 */
export async function runMigrations(sql: Sql): Promise<MigrationResult> {
  const migrationsDir = resolveMigrationsDir();

  // Ensure the ledger exists so we can be idempotent.
  await sql`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    text        PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `;

  const files = readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const alreadyApplied = new Set(
    ((await sql`SELECT version FROM schema_migrations`) as { version: string }[]).map(
      (r) => r.version
    )
  );

  const applied: string[] = [];
  const skipped: string[] = [];

  for (const file of files) {
    const version = file.replace(/\.sql$/, '');
    if (alreadyApplied.has(version)) {
      skipped.push(version);
      continue;
    }

    const contents = readFileSync(join(migrationsDir, file), 'utf8');

    // The Neon HTTP driver requires one statement per call. Split at top-level
    // `;`, respecting quotes/dollar-quotes/comments. Migrations are OUR static
    // SQL only — never build these strings from user input.
    const statements = splitSqlStatements(contents);
    for (const stmt of statements) {
      const trimmed = stmt.trim();
      if (!trimmed) continue;
      await sql(trimmed);
    }

    await sql`INSERT INTO schema_migrations (version) VALUES (${version})
              ON CONFLICT (version) DO NOTHING`;
    applied.push(version);
  }

  // Post-flight sanity check.
  const rows = (await sql`
    SELECT tablename FROM pg_tables WHERE schemaname = 'public'
  `) as { tablename: string }[];
  const present = new Set(rows.map((r) => r.tablename));
  const missing = EXPECTED_TABLES.filter((t) => !present.has(t));
  if (missing.length > 0) {
    throw new Error(
      `Post-migration sanity check FAILED. Missing tables: ${missing.join(', ')}. ` +
        `Something in the SQL didn't execute — inspect the migration files and the DB.`
    );
  }

  return {
    applied,
    skipped,
    tables: [...present].sort(),
  };
}

/**
 * Splits SQL by `;` at the top level. Respects:
 *   - single-quoted string literals `'...'`, including `''` doubled-escapes
 *   - dollar-quoted blocks `$$...$$` and tagged variants `$tag$...$tag$`
 *   - single-line `--` comments (skipped through end-of-line)
 *
 * This exists because the Neon HTTP driver requires one statement per call.
 * Historic bug: without single-quote awareness, a `;` inside a COMMENT ON
 * IS 'string with ; in it' would split the statement in half and silently
 * corrupt the migration. Don't remove any of these branches.
 */
function splitSqlStatements(sqlText: string): string[] {
  const out: string[] = [];
  let buf = '';
  let i = 0;
  const n = sqlText.length;
  let inSingle = false;      // inside '...'
  let inDollar = false;      // inside $tag$...$tag$
  let dollarTag = '';
  let inLineComment = false; // inside -- ...

  while (i < n) {
    const ch = sqlText[i];
    const next = i + 1 < n ? sqlText[i + 1] : '';

    // 1. Line comments: consume until end of line, don't emit them.
    if (inLineComment) {
      if (ch === '\n') inLineComment = false;
      buf += ch;
      i++;
      continue;
    }
    if (!inSingle && !inDollar && ch === '-' && next === '-') {
      inLineComment = true;
      buf += ch;
      i++;
      continue;
    }

    // 2. Dollar-quoted blocks.
    if (!inSingle && !inDollar && ch === '$') {
      const m = sqlText.slice(i).match(/^\$([A-Za-z0-9_]*)\$/);
      if (m) {
        dollarTag = m[0];
        inDollar = true;
        buf += dollarTag;
        i += dollarTag.length;
        continue;
      }
    } else if (inDollar && sqlText.startsWith(dollarTag, i)) {
      buf += dollarTag;
      i += dollarTag.length;
      inDollar = false;
      dollarTag = '';
      continue;
    }

    // 3. Single-quoted strings. Postgres escapes a quote inside a string by
    //    doubling it ('') — advance past the pair and stay inside.
    if (!inDollar && ch === "'") {
      if (inSingle && next === "'") {
        buf += "''";
        i += 2;
        continue;
      }
      inSingle = !inSingle;
      buf += ch;
      i++;
      continue;
    }

    // 4. Statement terminator, only outside all quoted contexts.
    if (!inSingle && !inDollar && ch === ';') {
      out.push(buf);
      buf = '';
      i++;
      continue;
    }

    buf += ch;
    i++;
  }
  if (buf.trim()) out.push(buf);
  return out;
}

// ============================================================================
// Build-hook entry point.
// Runs only when this file is executed directly (`tsx src/lib/migrate.ts`),
// NOT when it's imported by the admin route.
// ============================================================================
async function buildHookMain() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error('[migrate] DATABASE_URL is not set — cannot run migrations.');
    process.exit(1);
  }
  const sql = neon(url);
  console.log('[migrate] running migrations at build time…');
  const result = await runMigrations(sql);
  console.log(
    `[migrate] done. applied=[${result.applied.join(', ') || '—'}] ` +
      `skipped=[${result.skipped.join(', ') || '—'}] ` +
      `tables=${result.tables.length}`
  );
}

// Only fire when invoked as the process entry point (the build hook).
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  buildHookMain().catch((err) => {
    console.error('[migrate] migration failed:', err);
    process.exit(1);
  });
}
