// HTTP application: JSON API (+ static files when run as a plain Node server).
// Every API route checks the session and the role stored in the database; member routes are always
// scoped to the signed-in person. Works as a Node http handler and as a Vercel function.
import fs from 'node:fs';
import path from 'node:path';
import { normId } from './db.js';
import { generateAccessCode, normCode, hashSecret, verifySecret, newToken, sha256, maskId, rateLimiter, parsePngDataUrl } from './security.js';

const PUBLIC_DIR = path.resolve(new URL('../public', import.meta.url).pathname);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
const LANGS = ['ka', 'en', 'ru'];
const COOKIE = 'alpiki_sid';

class HttpError extends Error { constructor(status, code, extra) { super(code); this.status = status; this.code = code; this.extra = extra; } }
const nowIso = () => new Date().toISOString();

export const SECURITY_HEADERS = {
  'Content-Security-Policy': "default-src 'self'; img-src 'self' data: blob:; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'",
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Permissions-Policy': 'camera=(), microphone=(), geolocation=()',
  'Cross-Origin-Opener-Policy': 'same-origin',
};

/**
 * @param {{ db: import('./pg.js').Db | Promise<import('./pg.js').Db>, config: object, serveStatic?: boolean }} opts
 */
export function createApp({ db: dbOrPromise, config, serveStatic = true }) {
  const apiLimit = rateLimiter({ max: 600, windowMs: 60 * 1000 }); // per instance; login limits live in the DB
  let db;

  /* ---------------- data helpers ---------------- */
  const audit = (actorId, action, target, details, ip) =>
    db.run('INSERT INTO audit_log (actor_id, action, target, details, ip) VALUES (?, ?, ?, ?, ?)',
      actorId ?? null, action, target ?? null, details ? JSON.stringify(details) : null, ip ?? null);
  const personById = (id) => db.get('SELECT * FROM persons WHERE id = ?', id);
  const identsOf = (id) => db.all('SELECT value, kind FROM identifiers WHERE person_id = ? ORDER BY kind, value', id);
  const unitsOf = (id) => db.all(`SELECT u.*, (SELECT COUNT(*) FROM unit_owners x WHERE x.unit_id = u.id) AS owner_count
      FROM units u JOIN unit_owners o ON o.unit_id = u.id WHERE o.person_id = ? ORDER BY u.num`, id);
  const mySigs = (id) => db.all(`SELECT s.id, s.document_id, s.signed_at, s.signed_name, u.code AS unit_code, u.id AS unit_id
      FROM signatures s JOIN units u ON u.id = s.unit_id WHERE s.person_id = ? AND s.revoked_at IS NULL ORDER BY s.signed_at`, id);
  const publicUser = async (p) => ({
    id: p.id, kind: p.kind, name_ka: p.name_ka, name_en: p.name_en, role: p.role, lang: p.lang,
    ids: (await identsOf(p.id)).map((i) => ({ kind: i.kind, masked: maskId(i.value) })),
  });
  /** Fixed-window counter in the database, shared by all serverless instances. */
  async function hitLimit(key, max, windowMs) {
    const now = Date.now();
    const r = await db.get(`INSERT INTO rate_limits (key, window_start, hits) VALUES (?, ?, 1)
      ON CONFLICT (key) DO UPDATE SET
        hits = CASE WHEN rate_limits.window_start < ? THEN 1 ELSE rate_limits.hits + 1 END,
        window_start = CASE WHEN rate_limits.window_start < ? THEN EXCLUDED.window_start ELSE rate_limits.window_start END
      RETURNING hits`, key, now, now - windowMs, now - windowMs);
    return r.hits <= max;
  }

  /* ---------------- request helpers ---------------- */
  const clientIp = (req) => (config.trustProxy && req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : req.socket?.remoteAddress) || '';
  const cookies = (req) => Object.fromEntries(String(req.headers.cookie || '').split(';').map((c) => c.trim().split('=')).filter((p) => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
  const setCookie = (res, value, maxAgeSec) => res.setHeader('Set-Cookie',
    `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${config.secureCookies ? '; Secure' : ''}`);

  async function readJson(req) {
    // Vercel's Node runtime may already have parsed the body.
    let pre;
    try { pre = req.body; } catch { throw new HttpError(400, 'bad_json'); }
    if (pre !== undefined && pre !== null && pre !== '') {
      let b = pre;
      if (Buffer.isBuffer(b)) b = b.toString('utf8');
      if (typeof b === 'string') { if (b.length > config.maxBodyBytes) throw new HttpError(413, 'payload_too_large'); try { b = JSON.parse(b); } catch { throw new HttpError(400, 'bad_json'); } }
      if (!b || typeof b !== 'object' || Array.isArray(b)) throw new HttpError(400, 'bad_json');
      if (JSON.stringify(b).length > config.maxBodyBytes) throw new HttpError(413, 'payload_too_large');
      return b;
    }
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > config.maxBodyBytes) throw new HttpError(413, 'payload_too_large'); chunks.push(c); }
    if (!size) return {};
    try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!v || typeof v !== 'object' || Array.isArray(v)) throw 0; return v; }
    catch { throw new HttpError(400, 'bad_json'); }
  }

  async function currentUser(req) {
    const token = cookies(req)[COOKIE];
    if (!token) return null;
    const s = await db.get('SELECT person_id, expires_at FROM sessions WHERE token_hash = ?', sha256(token));
    if (!s || s.expires_at < nowIso()) return null;
    return (await personById(s.person_id)) || null;
  }
  const requireUser = (ctx) => { if (!ctx.user) throw new HttpError(401, 'unauthenticated'); return ctx.user; };
  const requireAdmin = (ctx) => { const u = requireUser(ctx); if (u.role !== 'superadmin') throw new HttpError(403, 'forbidden'); return u; };
  const intParam = (v) => { const n = Number(v); if (!Number.isInteger(n) || n <= 0 || n > 2 ** 52) throw new HttpError(404, 'not_found'); return n; };
  const firstDocId = async () => (await db.get('SELECT id FROM documents ORDER BY id LIMIT 1'))?.id;

  /* ---------------- routes ---------------- */
  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler });

  // --- health (no data, just whether the database answers)
  route('GET', '/api/health', async () => { await db.get('SELECT 1 AS ok'); return { ok: true, database: 'connected' }; });

  // --- auth
  route('POST', '/api/auth/login', async (ctx) => {
    if (!await hitLimit('login-ip:' + ctx.ip, config.loginMaxPerIp, 15 * 60 * 1000)) throw new HttpError(429, 'too_many_attempts');
    const body = await readJson(ctx.req);
    const pid = normId(body.personalId), code = normCode(body.accessCode);
    if (pid.length < 5 || pid.length > 20) throw new HttpError(400, 'unknown_id');
    const hit = await db.get('SELECT person_id FROM identifiers WHERE value = ?', pid);
    const person = hit ? await personById(hit.person_id) : null;
    if (!person) {
      await audit(null, 'login_failed', `pid:${maskId(pid)}`, null, ctx.ip);
      throw new HttpError(401, 'unknown_id');
    }
    if (person.locked_until && person.locked_until > nowIso()) {
      await audit(person.id, 'login_blocked', `person:${person.id}`, null, ctx.ip);
      throw new HttpError(429, 'too_many_attempts');
    }
    // Owners sign in with their ID number alone (unless REQUIRE_ACCESS_CODE is set);
    // the super admin, who sees everyone's data, always needs the access code as well.
    const needsCode = config.requireMemberCode || person.role === 'superadmin';
    if (needsCode) {
      if (code.length !== 8) throw new HttpError(401, 'code_required');
      if (!verifySecret(code, person.code_hash ?? null)) {
        const r = await db.get(`UPDATE persons SET failed_logins = failed_logins + 1 WHERE id = ? RETURNING failed_logins`, person.id);
        const lock = r.failed_logins >= config.maxFailedLogins;
        if (lock) await db.run('UPDATE persons SET failed_logins = 0, locked_until = ? WHERE id = ?', new Date(Date.now() + config.lockMinutes * 60000).toISOString(), person.id);
        await audit(null, lock ? 'login_locked' : 'login_failed', `person:${person.id}`, null, ctx.ip);
        throw new HttpError(401, 'invalid_credentials');
      }
    }
    const token = newToken();
    const lang = LANGS.includes(body.lang) ? body.lang : person.lang;
    await db.tx(async (t) => {
      await t.run('UPDATE persons SET failed_logins = 0, locked_until = NULL, last_login_at = ?, lang = ? WHERE id = ?', nowIso(), lang, person.id);
      await t.run('DELETE FROM sessions WHERE expires_at < ?', nowIso());
      await t.run('INSERT INTO sessions (token_hash, person_id, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?)',
        sha256(token), person.id, new Date(Date.now() + config.sessionHours * 3600000).toISOString(), ctx.ip, String(ctx.req.headers['user-agent'] || '').slice(0, 300));
    });
    await audit(person.id, 'login', `person:${person.id}`, { role: person.role }, ctx.ip);
    setCookie(ctx.res, token, config.sessionHours * 3600);
    return { user: await publicUser(await personById(person.id)) };
  });

  route('POST', '/api/auth/logout', async (ctx) => {
    const token = cookies(ctx.req)[COOKIE];
    if (token) await db.run('DELETE FROM sessions WHERE token_hash = ?', sha256(token));
    if (ctx.user) await audit(ctx.user.id, 'logout', `person:${ctx.user.id}`, null, ctx.ip);
    setCookie(ctx.res, '', 0);
    return { ok: true };
  });

  route('GET', '/api/auth/config', async () => ({ memberCode: !!config.requireMemberCode }));

  route('GET', '/api/auth/session', async (ctx) => ({ user: await publicUser(requireUser(ctx)) }));

  // --- member (always scoped to ctx.user)
  route('PUT', '/api/me/lang', async (ctx) => {
    const u = requireUser(ctx); const { lang } = await readJson(ctx.req);
    if (!LANGS.includes(lang)) throw new HttpError(400, 'invalid_language');
    await db.run('UPDATE persons SET lang = ? WHERE id = ?', lang, u.id);
    return { lang };
  });

  route('GET', '/api/me', async (ctx) => {
    const u = requireUser(ctx);
    const sigs = await mySigs(u.id);
    const units = (await unitsOf(u.id)).map((x) => ({
      code: x.code, num: x.num, type: x.type, label: x.label, floor: x.floor, area: x.area, coOwners: x.owner_count - 1,
      signatures: sigs.filter((s) => s.unit_id === x.id).map((s) => ({ id: s.id, documentId: s.document_id, signedAt: s.signed_at })),
    }));
    const documents = (await db.all('SELECT id, slug, status, content FROM documents ORDER BY id'))
      .map((d) => ({ id: d.id, slug: d.slug, status: d.status, title: Object.fromEntries(LANGS.map((l) => [l, JSON.parse(d.content)[l].title])) }));
    return { user: await publicUser(u), units, documents };
  });

  route('GET', '/api/me/documents/:id', async (ctx) => {
    const u = requireUser(ctx);
    const d = await db.get('SELECT * FROM documents WHERE id = ?', intParam(ctx.params.id)); if (!d) throw new HttpError(404, 'not_found');
    const signatures = (await mySigs(u.id)).filter((s) => s.document_id === d.id)
      .map((s) => ({ id: s.id, unitCode: s.unit_code, signedAt: s.signed_at, signedName: s.signed_name }));
    return { document: { id: d.id, slug: d.slug, status: d.status, content: JSON.parse(d.content) }, signatures };
  });

  route('POST', '/api/me/documents/:id/signatures', async (ctx) => {
    const u = requireUser(ctx);
    const d = await db.get('SELECT * FROM documents WHERE id = ?', intParam(ctx.params.id)); if (!d) throw new HttpError(404, 'not_found');
    if (d.status !== 'open') throw new HttpError(409, 'document_closed');
    const body = await readJson(ctx.req);
    if (body.consent !== true) throw new HttpError(400, 'consent_required');
    const signedName = String(body.signedName || '').trim().replace(/\s+/g, ' ');
    if (signedName.length < 3 || signedName.length > 120) throw new HttpError(400, 'invalid_name');
    const img = parsePngDataUrl(body.image, config.maxSignatureBytes);
    if (!img || img.width < 200 || img.height < 60 || img.width > 2000 || img.height > 1000) throw new HttpError(400, 'invalid_signature');
    const lang = LANGS.includes(body.lang) ? body.lang : u.lang;
    const codes = [...new Set((Array.isArray(body.unitCodes) ? body.unitCodes : []).map(String))];
    if (!codes.length || codes.length > 20) throw new HttpError(400, 'no_units');
    const mine = new Map((await unitsOf(u.id)).map((x) => [x.code, x]));
    const foreign = codes.filter((c) => !mine.has(c));
    if (foreign.length) {
      await audit(u.id, 'signature_denied', `document:${d.id}`, { reason: 'not_owner', units: foreign }, ctx.ip);
      throw new HttpError(403, 'not_your_unit');
    }
    const imageHash = sha256(img.bytes);
    const ua = String(ctx.req.headers['user-agent'] || '').slice(0, 300);
    let created;
    try {
      created = await db.tx(async (t) => {
        const existing = (await t.all(`SELECT u.code FROM signatures s JOIN units u ON u.id = s.unit_id WHERE s.document_id = ? AND s.person_id = ? AND s.revoked_at IS NULL`, d.id, u.id)).map((r) => r.code);
        const dup = codes.filter((c) => existing.includes(c));
        if (dup.length) throw new HttpError(409, 'already_signed', { units: dup });
        const out = [];
        for (const c of codes) {
          const r = await t.get('INSERT INTO signatures (document_id, unit_id, person_id, signed_name, image, image_sha256, lang, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING id',
            d.id, mine.get(c).id, u.id, signedName, img.bytes, imageHash, lang, ctx.ip, ua);
          out.push({ id: r.id, unitCode: c });
        }
        return out;
      });
    } catch (e) {
      if (e instanceof HttpError) throw e;
      if (e.code === '23505') throw new HttpError(409, 'already_signed');
      throw e;
    }
    await audit(u.id, 'signature_created', `document:${d.id}`, { units: codes, signatureIds: created.map((c) => c.id), imageSha256: imageHash }, ctx.ip);
    return { signatures: created };
  });

  route('GET', '/api/me/signatures/:id/image', async (ctx) => {
    const u = requireUser(ctx);
    const s = await db.get('SELECT image FROM signatures WHERE id = ? AND person_id = ? AND revoked_at IS NULL', intParam(ctx.params.id), u.id);
    if (!s) throw new HttpError(404, 'not_found');
    return { raw: s.image, type: 'image/png' };
  });

  // --- super admin
  route('GET', '/api/admin/overview', async (ctx) => {
    requireAdmin(ctx);
    const docId = await firstDocId();
    const units = await db.get('SELECT COUNT(*) AS n, COALESCE(SUM(area), 0) AS area FROM units');
    const signedUnits = await db.get(`SELECT COUNT(*) AS n, COALESCE(SUM(area), 0) AS area FROM units WHERE id IN (SELECT unit_id FROM signatures WHERE document_id = ? AND revoked_at IS NULL)`, docId);
    const people = await db.get(`SELECT COUNT(*) AS n, COUNT(*) FILTER (WHERE code_hash IS NOT NULL) AS "withCode", COUNT(*) FILTER (WHERE last_login_at IS NOT NULL) AS "loggedIn",
      COUNT(*) FILTER (WHERE id IN (SELECT person_id FROM signatures WHERE document_id = ? AND revoked_at IS NULL)) AS signed FROM persons`, docId);
    const sigCount = (await db.get('SELECT COUNT(*) AS n FROM signatures WHERE document_id = ? AND revoked_at IS NULL', docId)).n;
    const recent = await db.all(`SELECT a.at, a.action, a.target, p.name_ka, p.name_en FROM audit_log a LEFT JOIN persons p ON p.id = a.actor_id ORDER BY a.id DESC LIMIT 8`);
    return { documentId: docId, units: { total: units.n, signed: signedUnits.n, area: units.area, signedArea: signedUnits.area },
      persons: { total: people.n, withCode: people.withCode, loggedIn: people.loggedIn, signed: people.signed }, memberCode: !!config.requireMemberCode, signatures: sigCount, recent };
  });

  route('GET', '/api/admin/units', async (ctx) => {
    requireAdmin(ctx);
    const docId = await firstDocId();
    const sp = ctx.url.searchParams;
    const rows = await db.all('SELECT * FROM units ORDER BY num');
    const owners = await db.all(`SELECT o.unit_id, p.id, p.name_ka, p.name_en, p.kind, s.id AS sig_id, s.signed_at
      FROM unit_owners o JOIN persons p ON p.id = o.person_id
      LEFT JOIN signatures s ON s.unit_id = o.unit_id AND s.person_id = p.id AND s.document_id = ? AND s.revoked_at IS NULL`, docId);
    const ids = await db.all('SELECT person_id, value FROM identifiers');
    let list = rows.map((u) => {
      const os = owners.filter((o) => o.unit_id === u.id).map((o) => ({ id: o.id, name_ka: o.name_ka, name_en: o.name_en, kind: o.kind,
        ids: ids.filter((i) => i.person_id === o.id).map((i) => i.value), signatureId: o.sig_id, signedAt: o.signed_at }));
      const n = os.filter((o) => o.signatureId).length;
      return { ...u, owners: os, status: n === 0 ? 'unsigned' : n === os.length ? 'signed' : 'partial' };
    });
    const status = sp.get('status'), floor = sp.get('floor'), type = sp.get('type'), term = (sp.get('q') || '').trim().toLowerCase();
    if (status && status !== 'all') list = list.filter((u) => u.status === status);
    if (floor && floor !== 'all') list = list.filter((u) => u.floor === floor);
    if (type && type !== 'all') list = list.filter((u) => u.type === type);
    if (term) { const nt = normId(term); list = list.filter((u) => (u.code + ' ' + u.label + ' ' + u.owners.map((o) => o.name_ka + ' ' + o.name_en).join(' ')).toLowerCase().includes(term) || (nt.length >= 3 && u.owners.some((o) => o.ids.some((i) => i.includes(nt))))); }
    return { units: list };
  });

  route('GET', '/api/admin/persons', async (ctx) => {
    requireAdmin(ctx);
    const docId = await firstDocId(); const sp = ctx.url.searchParams;
    const rows = await db.all(`SELECT p.id, p.kind, p.name_ka, p.name_en, p.role, p.phone, p.email, p.last_login_at, p.locked_until,
        p.code_hash IS NOT NULL AS has_code, p.code_issued_at,
        (SELECT COUNT(*) FROM unit_owners o WHERE o.person_id = p.id) AS unit_count,
        (SELECT COUNT(*) FROM signatures s WHERE s.person_id = p.id AND s.document_id = ? AND s.revoked_at IS NULL) AS signed_count,
        (SELECT string_agg(value, ' ' ORDER BY value) FROM identifiers i WHERE i.person_id = p.id) AS ids,
        (SELECT string_agg(u.label, ', ' ORDER BY u.num) FROM unit_owners o JOIN units u ON u.id = o.unit_id WHERE o.person_id = p.id) AS unit_labels
      FROM persons p ORDER BY p.name_en`, docId);
    let list = rows.map((r) => ({ ...r, status: r.signed_count === 0 ? 'unsigned' : r.signed_count >= r.unit_count ? 'signed' : 'partial', ids: (r.ids || '').split(' ') }));
    const status = sp.get('status'), term = (sp.get('q') || '').trim().toLowerCase();
    if (status === 'nocode') list = list.filter((p) => !p.has_code);
    else if (status && status !== 'all') list = list.filter((p) => p.status === status);
    if (term) { const nt = normId(term); list = list.filter((p) => (p.name_ka + ' ' + p.name_en + ' ' + (p.phone || '') + ' ' + (p.email || '')).toLowerCase().includes(term) || (nt.length >= 3 && p.ids.some((i) => i.includes(nt)))); }
    return { persons: list };
  });

  route('GET', '/api/admin/persons/:id', async (ctx) => {
    requireAdmin(ctx);
    const p = await personById(intParam(ctx.params.id)); if (!p) throw new HttpError(404, 'not_found');
    const units = await unitsOf(p.id);
    const signatures = await db.all(`SELECT s.id, s.document_id, s.signed_at, s.signed_name, s.lang, s.ip, s.image_sha256, s.revoked_at, s.revoke_reason, u.code AS unit_code
      FROM signatures s JOIN units u ON u.id = s.unit_id WHERE s.person_id = ? ORDER BY s.signed_at DESC`, p.id);
    const history = await db.all(`SELECT a.at, a.action, a.details, a.ip, x.name_en AS actor FROM audit_log a LEFT JOIN persons x ON x.id = a.actor_id WHERE a.target = ? ORDER BY a.id DESC LIMIT 30`, `person:${p.id}`);
    await audit(ctx.user.id, 'admin_view_person', `person:${p.id}`, null, ctx.ip);
    return { person: { id: p.id, kind: p.kind, name_ka: p.name_ka, name_en: p.name_en, role: p.role, lang: p.lang, phone: p.phone, email: p.email, note: p.note,
      has_code: !!p.code_hash, code_issued_at: p.code_issued_at, last_login_at: p.last_login_at, locked_until: p.locked_until, created_at: p.created_at,
      ids: await identsOf(p.id) }, units, signatures, history };
  });

  route('PATCH', '/api/admin/persons/:id', async (ctx) => {
    const admin = requireAdmin(ctx);
    const p = await personById(intParam(ctx.params.id)); if (!p) throw new HttpError(404, 'not_found');
    const body = await readJson(ctx.req);
    if ('role' in body) throw new HttpError(403, 'role_change_forbidden'); // roles are not editable over the API
    const changes = {};
    for (const k of ['phone', 'email', 'note']) if (k in body) { const v = body[k] == null ? null : String(body[k]).trim().slice(0, k === 'note' ? 1000 : 120); changes[k] = v || null; }
    if (!Object.keys(changes).length) throw new HttpError(400, 'nothing_to_update');
    await db.run(`UPDATE persons SET ${Object.keys(changes).map((k) => k + ' = ?').join(', ')} WHERE id = ?`, ...Object.values(changes), p.id);
    await audit(admin.id, 'person_updated', `person:${p.id}`, { fields: Object.keys(changes) }, ctx.ip);
    return { ok: true };
  });

  route('POST', '/api/admin/persons/:id/access-code', async (ctx) => {
    const admin = requireAdmin(ctx);
    const p = await personById(intParam(ctx.params.id)); if (!p) throw new HttpError(404, 'not_found');
    const code = generateAccessCode();
    await db.tx(async (t) => {
      await t.run('UPDATE persons SET code_hash = ?, code_issued_at = ?, failed_logins = 0, locked_until = NULL WHERE id = ?', hashSecret(normCode(code)), nowIso(), p.id);
      if (p.id !== admin.id) await t.run('DELETE FROM sessions WHERE person_id = ?', p.id);
    });
    await audit(admin.id, p.code_hash ? 'access_code_reset' : 'access_code_issued', `person:${p.id}`, null, ctx.ip);
    return { code };
  });

  route('DELETE', '/api/admin/persons/:id/access-code', async (ctx) => {
    const admin = requireAdmin(ctx);
    const p = await personById(intParam(ctx.params.id)); if (!p) throw new HttpError(404, 'not_found');
    if (p.id === admin.id) throw new HttpError(409, 'cannot_revoke_self');
    await db.tx(async (t) => {
      await t.run('UPDATE persons SET code_hash = NULL, code_issued_at = NULL WHERE id = ?', p.id);
      await t.run('DELETE FROM sessions WHERE person_id = ?', p.id);
    });
    await audit(admin.id, 'access_code_revoked', `person:${p.id}`, null, ctx.ip);
    return { ok: true };
  });

  route('GET', '/api/admin/signatures/:id/image', async (ctx) => {
    requireAdmin(ctx);
    const s = await db.get('SELECT image FROM signatures WHERE id = ?', intParam(ctx.params.id));
    if (!s) throw new HttpError(404, 'not_found');
    return { raw: s.image, type: 'image/png' };
  });

  route('POST', '/api/admin/signatures/:id/revoke', async (ctx) => {
    const admin = requireAdmin(ctx);
    const id = intParam(ctx.params.id);
    const r = String((await readJson(ctx.req)).reason || '').trim();
    if (r.length < 3) throw new HttpError(400, 'reason_required');
    const s = await db.get('SELECT id, person_id, revoked_at FROM signatures WHERE id = ?', id);
    if (!s) throw new HttpError(404, 'not_found');
    if (s.revoked_at) throw new HttpError(409, 'already_revoked');
    await db.run('UPDATE signatures SET revoked_at = ?, revoked_by = ?, revoke_reason = ? WHERE id = ?', nowIso(), admin.id, r.slice(0, 500), id);
    await audit(admin.id, 'signature_revoked', `person:${s.person_id}`, { signatureId: id, reason: r.slice(0, 500) }, ctx.ip);
    return { ok: true };
  });

  route('GET', '/api/admin/audit', async (ctx) => {
    requireAdmin(ctx);
    const sp = ctx.url.searchParams;
    const limit = Math.min(200, Math.max(1, Number(sp.get('limit')) || 50)), offset = Math.max(0, Number(sp.get('offset')) || 0);
    const action = sp.get('action');
    const filtered = action && action !== 'all';
    const where = filtered ? 'WHERE a.action = ?' : '';
    const args = filtered ? [action] : [];
    const entries = await db.all(`SELECT a.id, a.at, a.action, a.target, a.details, a.ip, p.name_ka, p.name_en, t.name_ka AS target_ka, t.name_en AS target_en
      FROM audit_log a LEFT JOIN persons p ON p.id = a.actor_id
      LEFT JOIN persons t ON a.target = 'person:' || t.id::text
      ${where} ORDER BY a.id DESC LIMIT ? OFFSET ?`, ...args, limit, offset);
    const total = (await db.get(`SELECT COUNT(*) AS n FROM audit_log a ${where}`, ...args)).n;
    return { entries, total };
  });

  route('GET', '/api/admin/export.csv', async (ctx) => {
    const admin = requireAdmin(ctx);
    const docId = await firstDocId();
    const rows = await db.all(`SELECT u.num, u.code, u.type, u.label, u.floor, u.area, p.name_ka, p.name_en,
        (SELECT string_agg(value, ' ' ORDER BY value) FROM identifiers i WHERE i.person_id = p.id) AS ids, p.phone, p.email,
        s.signed_at, s.signed_name, s.image_sha256
      FROM units u JOIN unit_owners o ON o.unit_id = u.id JOIN persons p ON p.id = o.person_id
      LEFT JOIN signatures s ON s.unit_id = u.id AND s.person_id = p.id AND s.document_id = ? AND s.revoked_at IS NULL
      ORDER BY u.num, p.name_en`, docId);
    const esc = (v) => { const s = String(v ?? ''); return /^[=+\-@]/.test(s) ? `"'${s.replace(/"/g, '""')}"` : `"${s.replace(/"/g, '""')}"`; };
    const head = ['No', 'Cadastral code', 'Type', 'Unit', 'Floor', 'Area m2', 'Owner (KA)', 'Owner (EN)', 'IDs', 'Phone', 'Email', 'Status', 'Signed at', 'Signed name', 'Signature SHA-256'];
    const lines = [head.map(esc).join(',')].concat(rows.map((r) => [r.num, r.code, r.type, r.label, r.floor, r.area.toFixed(2), r.name_ka, r.name_en, r.ids, r.phone, r.email, r.signed_at ? 'signed' : 'pending', r.signed_at, r.signed_name, r.image_sha256].map(esc).join(',')));
    await audit(admin.id, 'export_csv', `document:${docId}`, { rows: rows.length }, ctx.ip);
    return { raw: Buffer.from('﻿' + lines.join('\r\n'), 'utf8'), type: 'text/csv; charset=utf-8', filename: `alpiki-consents-${new Date().toISOString().slice(0, 10)}.csv` };
  });

  /* ---------------- dispatcher ---------------- */
  const sendJson = (res, status, obj) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(obj)); };

  function staticFile(req, res, pathname) {
    let rel = decodeURIComponent(pathname);
    if (rel === '/' || !path.extname(rel)) rel = '/index.html';
    const file = path.resolve(PUBLIC_DIR, '.' + rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; return res.end('Not found'); }
    res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
    res.setHeader('Cache-Control', rel === '/index.html' ? 'no-cache' : 'public, max-age=300');
    fs.createReadStream(file).pipe(res);
  }

  return async function handler(req, res) {
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) res.setHeader(k, v);
    if (config.secureCookies) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    const url = new URL(req.url, 'http://localhost');
    // On Vercel, vercel.json rewrites /api/* to the single function and passes the original path as __p.
    const forwarded = url.searchParams.get('__p');
    if (forwarded) { url.pathname = forwarded.startsWith('/') ? forwarded : '/' + forwarded; url.searchParams.delete('__p'); }
    const ip = clientIp(req);
    if (!url.pathname.startsWith('/api/')) {
      if (!serveStatic || (req.method !== 'GET' && req.method !== 'HEAD')) { res.statusCode = 404; return res.end(); }
      return staticFile(req, res, url.pathname);
    }
    try {
      if (!apiLimit.hit(ip)) throw new HttpError(429, 'rate_limited');
      if (req.method !== 'GET') {
        if (req.headers['x-alpiki'] !== '1') throw new HttpError(403, 'csrf');
        const origin = req.headers.origin;
        const host = req.headers['x-forwarded-host'] || req.headers.host;
        if (origin && new URL(origin).host !== host) throw new HttpError(403, 'csrf');
      }
      const r = routes.find((x) => x.method === req.method && x.re.test(url.pathname));
      if (!r) throw new HttpError(404, 'not_found');
      try { db = await (typeof dbOrPromise === 'function' ? dbOrPromise() : dbOrPromise); } catch (e) { console.error('Database unavailable:', e); throw new HttpError(503, 'database_unavailable'); }
      const ctx = { req, res, url, ip, params: url.pathname.match(r.re).groups || {}, user: await currentUser(req) };
      const out = await r.handler(ctx);
      if (out && out.raw) {
        res.statusCode = 200; res.setHeader('Content-Type', out.type); res.setHeader('Cache-Control', 'private, no-store');
        if (out.filename) res.setHeader('Content-Disposition', `attachment; filename="${out.filename}"`);
        return res.end(out.raw);
      }
      sendJson(res, 200, out);
    } catch (e) {
      if (e instanceof HttpError) return sendJson(res, e.status, { error: e.code, ...(e.extra || {}) });
      console.error(e);
      sendJson(res, 500, { error: 'server_error' });
    }
  };
}
