import { neon, neonConfig } from '@neondatabase/serverless';
import { config } from './lib/config.js';

// The Neon serverless driver talks HTTP, so it's cold-start friendly.
// For long-running local dev, this also works — HTTP just goes over the same channel.
neonConfig.fetchConnectionCache = true;

if (!config.databaseUrl) {
  throw new Error('DATABASE_URL is not set. Copy .env.example → .env and fill it in.');
}

/**
 * Tagged-template SQL client.
 * Usage: `const rows = await sql`SELECT * FROM users WHERE id = ${id}`;`
 * All values are parameterized — you cannot accidentally build a SQL-injection here.
 *
 * Note: Neon's `sql<A,F>` type params are for array-mode / full-results, NOT for row
 * types. To get typed rows, use the `query<Row>` helper below, or cast at the call site.
 */
export const sql = neon(config.databaseUrl);

/**
 * Typed row wrapper. Preferred for anything non-trivial.
 * Usage:
 *   const users = await query<{ id: string }>(sql`SELECT id FROM users`);
 */
export async function query<Row>(p: Promise<unknown>): Promise<Row[]> {
  return (await p) as Row[];
}

/**
 * One-off query helper that returns the first row or null.
 */
export async function one<Row>(p: Promise<unknown>): Promise<Row | null> {
  const rows = (await p) as Row[];
  return rows[0] ?? null;
}
