import crypto from 'node:crypto';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no 0/O, 1/I

/** Random access code, formatted XXXX-XXXX (~40 bits). */
export function generateAccessCode() {
  const bytes = crypto.randomBytes(8);
  let s = '';
  for (let i = 0; i < 8; i++) s += CODE_ALPHABET[bytes[i] % CODE_ALPHABET.length];
  return s.slice(0, 4) + '-' + s.slice(4);
}
export const normCode = (c) => String(c ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');

const SCRYPT = { N: 16384, r: 8, p: 1, keylen: 32 };
export function hashSecret(secret) {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(secret, salt, SCRYPT.keylen, SCRYPT);
  return `scrypt$${salt.toString('base64')}$${hash.toString('base64')}`;
}
const DUMMY = hashSecret('dummy-secret-for-timing');
/** Constant-time check. Pass stored=null to spend the same time when no hash exists. */
export function verifySecret(secret, stored) {
  const [alg, saltB64, hashB64] = String(stored || DUMMY).split('$');
  if (alg !== 'scrypt') return false;
  const expected = Buffer.from(hashB64, 'base64');
  const actual = crypto.scryptSync(secret, Buffer.from(saltB64, 'base64'), expected.length, SCRYPT);
  return crypto.timingSafeEqual(actual, expected) && stored != null;
}

export const newToken = () => crypto.randomBytes(32).toString('base64url');
export const sha256 = (data) => crypto.createHash('sha256').update(data).digest('hex');

export const maskId = (v) => (v.length <= 4 ? '••' + v.slice(-2) : v.slice(0, 2) + '•••' + v.slice(-2));

/** Fixed-window rate limiter kept in memory (per process). */
export function rateLimiter({ max, windowMs }) {
  const hits = new Map();
  return {
    hit(key) {
      const now = Date.now();
      let e = hits.get(key);
      if (!e || e.reset < now) { e = { n: 0, reset: now + windowMs }; hits.set(key, e); }
      e.n++;
      if (hits.size > 10000) for (const [k, v] of hits) if (v.reset < now) hits.delete(k);
      return e.n <= max;
    },
    reset() { hits.clear(); },
  };
}

/** Validates a PNG data URL and returns its bytes plus dimensions. */
export function parsePngDataUrl(s, maxBytes) {
  const m = /^data:image\/png;base64,([A-Za-z0-9+/=]+)$/.exec(String(s || ''));
  if (!m) return null;
  const buf = Buffer.from(m[1], 'base64');
  if (buf.length < 100 || buf.length > maxBytes) return null;
  const sig = '89504e470d0a1a0a';
  if (buf.subarray(0, 8).toString('hex') !== sig || buf.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
  return { bytes: buf, width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}
