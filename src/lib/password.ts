import bcrypt from 'bcryptjs';

// Cost 12 gives ~250ms per hash on modern hardware. Slow enough to hurt
// attackers but not our login endpoint.
const COST = 12;

export async function hashPassword(plaintext: string): Promise<string> {
  return bcrypt.hash(plaintext, COST);
}

export async function verifyPassword(plaintext: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plaintext, hash);
}

/**
 * Constant-work verification used when a user doesn't exist. Prevents timing
 * attacks that could enumerate valid emails by measuring how fast we say "wrong password".
 * We do the full bcrypt round against a canned hash and throw the result away.
 */
const DUMMY_HASH = '$2a$12$C9XahmxrKk2VeM8Z0eQ7Ne.iX0K3sqrHMnDmSqLdmXVfZjqfYD9GK'; // hash of 'never-match'
export async function fakePasswordCheck(plaintext: string): Promise<void> {
  await bcrypt.compare(plaintext, DUMMY_HASH);
}

/**
 * Server-side password policy. Mirrors the frontend checks in reset-password.html,
 * but the server is authoritative — never trust the client.
 *
 * NOTE: multi-tenant — when a workspace-specific security policy is introduced,
 * this function should accept a workspace_id and read from workspace settings.
 */
export function validatePasswordPolicy(pw: string): { ok: true } | { ok: false; reason: string } {
  if (pw.length < 8) return { ok: false, reason: 'must be at least 8 characters' };
  if (!/[a-zA-Z]/.test(pw)) return { ok: false, reason: 'must include a letter' };
  if (!/\d/.test(pw)) return { ok: false, reason: 'must include a number' };
  const hasSymbol = /[^a-zA-Z0-9]/.test(pw);
  const isLong = pw.length >= 12;
  if (!hasSymbol && !isLong) return { ok: false, reason: 'must include a symbol or be at least 12 characters' };
  return { ok: true };
}
