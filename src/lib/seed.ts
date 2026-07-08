// ============================================================================
// seed.ts · Bootstrap seed
// ============================================================================
// Creates the DSLRSWALA workspace and Aamir's owner user + membership.
// Called by the token-protected admin endpoint (src/routes/admin.ts) — there is
// no local seed script in this browser-only workflow.
//
// Idempotent: every insert is ON CONFLICT DO UPDATE, so hitting the endpoint
// twice re-applies the same state (including re-hashing the seed password from
// SEED_OWNER_PASSWORD) rather than erroring.
// ============================================================================

import bcrypt from 'bcryptjs';
import { neon } from '@neondatabase/serverless';
import type { config as appConfig } from './config.js';

type Sql = ReturnType<typeof neon>;
type AppConfig = typeof appConfig;

export type SeedResult = {
  workspace_id: string;
  user_id: string;
  email: string;
};

/**
 * Seed the base workspace + owner. Returns the ids so the caller can echo them.
 */
export async function runSeed(sql: Sql, cfg: AppConfig): Promise<SeedResult> {
  const { ownerEmail, ownerName, ownerPassword } = cfg.seed;

  // 1. Workspace (tenant root).
  const workspaces = (await sql`
    INSERT INTO workspaces (slug, name, location, country_code, currency_code, timezone)
    VALUES ('dslrswala', 'DSLRSWALA', 'Vadodara', 'IN', 'INR', 'Asia/Kolkata')
    ON CONFLICT (slug) DO UPDATE SET name = EXCLUDED.name
    RETURNING id
  `) as { id: string }[];
  const workspaceId = workspaces[0]!.id;

  // 2. Owner user (Aamir). Hash the seed password at cost 12.
  const passwordHash = await bcrypt.hash(ownerPassword, 12);
  const users = (await sql`
    INSERT INTO users (email, display_name, password_hash, email_verified_at)
    VALUES (${ownerEmail}, ${ownerName}, ${passwordHash}, now())
    ON CONFLICT (email) DO UPDATE SET
      display_name        = EXCLUDED.display_name,
      password_hash       = EXCLUDED.password_hash,
      password_updated_at = now()
    RETURNING id
  `) as { id: string }[];
  const userId = users[0]!.id;

  // 3. Owner membership.
  await sql`
    INSERT INTO workspace_memberships (workspace_id, user_id, role, status)
    VALUES (${workspaceId}, ${userId}, 'owner', 'active')
    ON CONFLICT (workspace_id, user_id) DO UPDATE SET role = 'owner', status = 'active'
  `;

  return { workspace_id: workspaceId, user_id: userId, email: ownerEmail };
}
