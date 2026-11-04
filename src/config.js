// All settings come from environment variables; defaults suit local development.
const env = process.env;
const onVercel = !!env.VERCEL;
// Neon's Vercel integration can add a custom prefix (e.g. STORAGE_DATABASE_URL); accept that too.
const findDbUrl = () => env.DATABASE_URL || env.POSTGRES_URL
  || Object.entries(env).find(([k, v]) => /_DATABASE_URL$/.test(k) && v)?.[1]
  || Object.entries(env).find(([k, v]) => /_POSTGRES_URL$/.test(k) && v)?.[1] || '';
const bool = (v, d) => (v == null || v === '' ? d : /^(1|true|yes)$/i.test(v));
export const config = {
  port: Number(env.PORT || 3000),
  host: env.HOST || '0.0.0.0',
  // Vercel's Neon integration provides DATABASE_URL (older Vercel Postgres projects: POSTGRES_URL).
  databaseUrl: findDbUrl(),
  sessionHours: Number(env.SESSION_HOURS || 12),
  maxFailedLogins: Number(env.MAX_FAILED_LOGINS || 5),
  lockMinutes: Number(env.LOCK_MINUTES || 15),
  loginMaxPerIp: Number(env.LOGIN_MAX_PER_IP || 30),
  maxBodyBytes: 600 * 1024,
  maxSignatureBytes: 400 * 1024,
  secureCookies: bool(env.SECURE_COOKIES, onVercel || env.NODE_ENV === 'production'),
  trustProxy: bool(env.TRUST_PROXY, onVercel),
  // Owners sign in with their ID number only, unless this is set to 1.
  requireMemberCode: bool(env.REQUIRE_ACCESS_CODE, false),
  // First super admin, set once in the hosting dashboard (see README).
  superadminId: env.SUPERADMIN_ID || '',
  superadminInitialCode: env.SUPERADMIN_INITIAL_CODE || '',
};
