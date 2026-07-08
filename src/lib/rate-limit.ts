import { sql, query } from '../db.js';
import { config } from './config.js';

/**
 * Login rate limits — evaluated BEFORE we look up the user, so we can't
 * be used as a probe. If either the email or the IP is over its budget,
 * we 429.
 *
 * We look back 15 minutes and count failures only. Successes don't count.
 * This means a user who legitimately signs in resets their budget.
 */
export async function checkLoginRateLimit(
  email: string,
  ipAddress: string | null
): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number }> {
  const [byEmail, byIp] = await Promise.all([
    query<{ n: number }>(sql`
      SELECT COUNT(*)::int AS n
      FROM login_attempts
      WHERE email = ${email}
        AND success = false
        AND attempted_at > now() - interval '15 minutes'
    `),
    ipAddress
      ? query<{ n: number }>(sql`
          SELECT COUNT(*)::int AS n
          FROM login_attempts
          WHERE ip_address = ${ipAddress}::inet
            AND success = false
            AND attempted_at > now() - interval '15 minutes'
        `)
      : Promise.resolve([{ n: 0 }]),
  ]);

  const emailCount = byEmail[0]?.n ?? 0;
  const ipCount    = byIp[0]?.n ?? 0;

  if (emailCount >= config.loginMaxFailuresPerEmail || ipCount >= config.loginMaxFailuresPerIp) {
    return { ok: false, retryAfterSeconds: 60 * 15 };
  }
  return { ok: true };
}

export async function recordLoginAttempt(
  email: string,
  ipAddress: string | null,
  success: boolean
): Promise<void> {
  await sql`
    INSERT INTO login_attempts (email, ip_address, success)
    VALUES (${email}, ${ipAddress}, ${success})
  `;
}

/**
 * Password-reset requests: 3/hour per email. This one uses the reset-token
 * table itself as the counter — cheaper than a separate log.
 */
export async function checkPasswordResetRateLimit(
  email: string
): Promise<{ ok: true } | { ok: false; retryAfterSeconds: number }> {
  const rows = await query<{ n: number }>(sql`
    SELECT COUNT(*)::int AS n
    FROM password_reset_tokens t
    JOIN users u ON u.id = t.user_id
    WHERE u.email = ${email}
      AND t.created_at > now() - interval '1 hour'
  `);
  const count = rows[0]?.n ?? 0;
  if (count >= config.passwordResetMaxPerHour) {
    return { ok: false, retryAfterSeconds: 60 * 60 };
  }
  return { ok: true };
}
