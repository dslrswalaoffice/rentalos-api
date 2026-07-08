// Central config, read once at startup. Fail fast on missing critical values.

function num(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a number, got: ${raw}`);
  return n;
}

function str(name: string, fallback: string): string {
  return process.env[name] ?? fallback;
}

export const config = {
  databaseUrl: process.env.DATABASE_URL ?? '',
  nodeEnv: str('NODE_ENV', 'development'),
  isDev: str('NODE_ENV', 'development') !== 'production',
  appOrigin: str('APP_ORIGIN', 'http://localhost:3000'),

  sessionTtlDays:         num('SESSION_TTL_DAYS', 30),
  passwordResetTtlMinutes: num('PASSWORD_RESET_TTL_MINUTES', 30),

  loginMaxFailuresPerEmail: num('LOGIN_MAX_FAILURES_PER_EMAIL', 5),
  loginMaxFailuresPerIp:    num('LOGIN_MAX_FAILURES_PER_IP', 20),
  passwordResetMaxPerHour:  num('PASSWORD_RESET_MAX_PER_HOUR', 3),

  // Token that gates the browser-hit /api/admin/* bootstrap endpoints.
  // Empty string = admin endpoints disabled (503). Delete the Vercel env var
  // after initial setup so migrate/seed can no longer be triggered.
  adminSetupToken: process.env.ADMIN_SETUP_TOKEN ?? '',

  seed: {
    ownerEmail:    str('SEED_OWNER_EMAIL', 'aamir@dslrswala.com'),
    ownerName:     str('SEED_OWNER_NAME', 'Aamir Patel'),
    ownerPassword: str('SEED_OWNER_PASSWORD', 'change-me-on-first-login'),
  },
} as const;
