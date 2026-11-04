// HTTP application: static frontend + JSON API. Every API route checks the session and the role
// stored in the database; member routes are always scoped to the signed-in person.
import fs from 'node:fs';
import path from 'node:path';
import { tx, normId } from './db.js';
import { generateAccessCode, normCode, hashSecret, verifySecret, newToken, sha256, maskId, rateLimiter, parsePngDataUrl } from './security.js';

const PUBLIC_DIR = path.resolve(new URL('../public', import.meta.url).pathname);
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.json': 'application/json' };
const LANGS = ['ka', 'en', 'ru'];
const COOKIE = 'alpiki_sid';

class HttpError extends Error { constructor(status, code, extra) { super(code); this.status = status; this.code = code; this.extra = extra; } }
const nowIso = () => new Date().toISOString();

export function createApp({ db, config }) {
  const loginIpLimit = rateLimiter({ max: config.loginMaxPerIp, windowMs: 15 * 60 * 1000 });
  const apiLimit = rateLimiter({ max: 600, windowMs: 60 * 1000 });

  const q = {
    personById: db.prepare('SELECT * FROM persons WHERE id = ?'),
    identOwner: db.prepare('SELECT person_id FROM identifiers WHERE value = ?'),
    identsOf: db.prepare('SELECT value, kind FROM identifiers WHERE person_id = ? ORDER BY kind, value'),
    session: db.prepare('SELECT s.person_id, s.expires_at FROM sessions s WHERE s.token_hash = ?'),
    unitsOf: db.prepare(`SELECT u.*, (SELECT COUNT(*) FROM unit_owners x WHERE x.unit_id = u.id) AS owner_count
                         FROM units u JOIN unit_owners o ON o.unit_id = u.id WHERE o.person_id = ? ORDER BY u.num`),
    doc: db.prepare('SELECT * FROM documents WHERE id = ?'),
    docs: db.prepare('SELECT id, slug, status, content, created_at FROM documents ORDER BY id'),
    mySigs: db.prepare(`SELECT s.id, s.document_id, s.signed_at, s.signed_name, u.code AS unit_code, u.id AS unit_id
                        FROM signatures s JOIN units u ON u.id = s.unit_id
                        WHERE s.person_id = ? AND s.revoked_at IS NULL ORDER BY s.signed_at`),
    audit: db.prepare('INSERT INTO audit_log (actor_id, action, target, details, ip) VALUES (?, ?, ?, ?, ?)'),
  };

  const audit = (actorId, action, target, details, ip) =>
    q.audit.run(actorId ?? null, action, target ?? null, details ? JSON.stringify(details) : null, ip ?? null);

  const publicUser = (p) => ({
    id: p.id, kind: p.kind, name_ka: p.name_ka, name_en: p.name_en, role: p.role, lang: p.lang,
    ids: q.identsOf.all(p.id).map(i => ({ kind: i.kind, masked: maskId(i.value) })),
  });

  /* ---------------- request helpers ---------------- */
  const clientIp = (req) => (config.trustProxy && req.headers['x-forwarded-for'] ? String(req.headers['x-forwarded-for']).split(',')[0].trim() : req.socket.remoteAddress) || '';
  const cookies = (req) => Object.fromEntries(String(req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(p => p[0]).map(([k, ...v]) => [k, decodeURIComponent(v.join('='))]));
  const setCookie = (res, value, maxAgeSec) => res.setHeader('Set-Cookie',
    `${COOKIE}=${value}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAgeSec}${config.secureCookies ? '; Secure' : ''}`);

  async function readJson(req) {
    const chunks = []; let size = 0;
    for await (const c of req) { size += c.length; if (size > config.maxBodyBytes) throw new HttpError(413, 'payload_too_large'); chunks.push(c); }
    if (!size) return {};
    try { const v = JSON.parse(Buffer.concat(chunks).toString('utf8')); if (!v || typeof v !== 'object' || Array.isArray(v)) throw 0; return v; }
    catch { throw new HttpError(400, 'bad_json'); }
  }

  function currentUser(req) {
    const token = cookies(req)[COOKIE];
    if (!token) return null;
    const s = q.session.get(sha256(token));
    if (!s || s.expires_at < nowIso()) return null;
    return q.personById.get(s.person_id) || null;
  }
  const requireUser = (ctx) => { if (!ctx.user) throw new HttpError(401, 'unauthenticated'); return ctx.user; };
  const requireAdmin = (ctx) => { const u = requireUser(ctx); if (u.role !== 'superadmin') throw new HttpError(403, 'forbidden'); return u; };
  const intParam = (v) => { const n = Number(v); if (!Number.isInteger(n) || n <= 0) throw new HttpError(404, 'not_found'); return n; };

  /* ---------------- routes ---------------- */
  const routes = [];
  const route = (method, pattern, handler) => routes.push({ method, re: new RegExp('^' + pattern.replace(/:(\w+)/g, '(?<$1>[^/]+)') + '$'), handler });

  // --- auth
  route('POST', '/api/auth/login', async (ctx) => {
    if (!loginIpLimit.hit(ctx.ip)) throw new HttpError(429, 'too_many_attempts');
    const body = await readJson(ctx.req);
    const pid = normId(body.personalId), code = normCode(body.accessCode);
    if (pid.length < 5 || pid.length > 20 || code.length !== 8) throw new HttpError(400, 'invalid_credentials');
    const hit = q.identOwner.get(pid);
    const person = hit ? q.personById.get(hit.person_id) : null;
    if (person?.locked_until && person.locked_until > nowIso()) {
      verifySecret(code, null);
      audit(person.id, 'login_blocked', `person:${person.id}`, null, ctx.ip);
      throw new HttpError(429, 'too_many_attempts');
    }
    const ok = verifySecret(code, person?.code_hash ?? null);
    if (!ok) {
      if (person) {
        const fails = person.failed_logins + 1;
        const lock = fails >= config.maxFailedLogins;
        db.prepare('UPDATE persons SET failed_logins = ?, locked_until = ? WHERE id = ?')
          .run(lock ? 0 : fails, lock ? new Date(Date.now() + config.lockMinutes * 60000).toISOString() : person.locked_until, person.id);
        audit(null, lock ? 'login_locked' : 'login_failed', `person:${person.id}`, null, ctx.ip);
      } else audit(null, 'login_failed', `pid:${maskId(pid)}`, null, ctx.ip);
      throw new HttpError(401, 'invalid_credentials');
    }
    const token = newToken();
    const lang = LANGS.includes(body.lang) ? body.lang : person.lang;
    tx(db, () => {
      db.prepare('UPDATE persons SET failed_logins = 0, locked_until = NULL, last_login_at = ?, lang = ? WHERE id = ?').run(nowIso(), lang, person.id);
      db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(nowIso());
      db.prepare('INSERT INTO sessions (token_hash, person_id, expires_at, ip, user_agent) VALUES (?, ?, ?, ?, ?)')
        .run(sha256(token), person.id, new Date(Date.now() + config.sessionHours * 3600000).toISOString(), ctx.ip, String(ctx.req.headers['user-agent'] || '').slice(0, 300));
    });
    audit(person.id, 'login', `person:${person.id}`, { role: person.role }, ctx.ip);
    setCookie(ctx.res, token, config.sessionHours * 3600);
    return { user: publicUser(q.personById.get(person.id)) };
  });

  route('POST', '/api/auth/logout', async (ctx) => {
    const token = cookies(ctx.req)[COOKIE];
    if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
    if (ctx.user) audit(ctx.user.id, 'logout', `person:${ctx.user.id}`, null, ctx.ip);
    setCookie(ctx.res, '', 0);
    return { ok: true };
  });

  route('GET', '/api/auth/session', async (ctx) => ({ user: publicUser(requireUser(ctx)) }));

  // --- member (always scoped to ctx.user)
  route('PUT', '/api/me/lang', async (ctx) => {
    const u = requireUser(ctx); const { lang } = await readJson(ctx.req);
    if (!LANGS.includes(lang)) throw new HttpError(400, 'invalid_language');
    db.prepare('UPDATE persons SET lang = ? WHERE id = ?').run(lang, u.id);
    return { lang };
  });

  route('GET', '/api/me', async (ctx) => {
    const u = requireUser(ctx);
    const sigs = q.mySigs.all(u.id);
    const units = q.unitsOf.all(u.id).map(x => ({
      code: x.code, num: x.num, type: x.type, label: x.label, floor: x.floor, area: x.area, coOwners: x.owner_count - 1,
      signatures: sigs.filter(s => s.unit_id === x.id).map(s => ({ id: s.id, documentId: s.document_id, signedAt: s.signed_at })),
    }));
    const documents = q.docs.all().map(d => ({ id: d.id, slug: d.slug, status: d.status, title: Object.fromEntries(LANGS.map(l => [l, JSON.parse(d.content)[l].title])) }));
    return { user: publicUser(u), units, documents };
  });

  route('GET', '/api/me/documents/:id', async (ctx) => {
    const u = requireUser(ctx);
    const d = q.doc.get(intParam(ctx.params.id)); if (!d) throw new HttpError(404, 'not_found');
    const signatures = q.mySigs.all(u.id).filter(s => s.document_id === d.id)
      .map(s => ({ id: s.id, unitCode: s.unit_code, signedAt: s.signed_at, signedName: s.signed_name }));
    return { document: { id: d.id, slug: d.slug, status: d.status, content: JSON.parse(d.content) }, signatures };
  });

  route('POST', '/api/me/documents/:id/signatures', async (ctx) => {
    const u = requireUser(ctx);
    const d = q.doc.get(intParam(ctx.params.id)); if (!d) throw new HttpError(404, 'not_found');
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
    const mine = new Map(q.unitsOf.all(u.id).map(x => [x.code, x]));
    const foreign = codes.filter(c => !mine.has(c));
    if (foreign.length) {
      audit(u.id, 'signature_denied', `document:${d.id}`, { reason: 'not_owner', units: foreign }, ctx.ip);
      throw new HttpError(403, 'not_your_unit');
    }
    const imageHash = sha256(img.bytes);
    const ua = String(ctx.req.headers['user-agent'] || '').slice(0, 300);
    let created;
    try {
      created = tx(db, () => {
        const existing = db.prepare(`SELECT u.code FROM signatures s JOIN units u ON u.id = s.unit_id WHERE s.document_id = ? AND s.person_id = ? AND s.revoked_at IS NULL`).all(d.id, u.id).map(r => r.code);
        const dup = codes.filter(c => existing.includes(c));
        if (dup.length) throw new HttpError(409, 'already_signed', { units: dup });
        const ins = db.prepare('INSERT INTO signatures (document_id, unit_id, person_id, signed_name, image, image_sha256, lang, ip, user_agent) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
        return codes.map(c => { const r = ins.run(d.id, mine.get(c).id, u.id, signedName, img.bytes, imageHash, lang, ctx.ip, ua); return { id: Number(r.lastInsertRowid), unitCode: c }; });
      });
    } catch (e) {
      if (e instanceof HttpError) throw e;
      if (String(e.message).includes('UNIQUE')) throw new HttpError(409, 'already_signed');
      throw e;
    }
    audit(u.id, 'signature_created', `document:${d.id}`, { units: codes, signatureIds: created.map(c => c.id), imageSha256: imageHash }, ctx.ip);
    return { signatures: created };
  });

  route('GET', '/api/me/signatures/:id/image', async (ctx) => {
    const u = requireUser(ctx);
    const s = db.prepare('SELECT image FROM signatures WHERE id = ? AND person_id = ? AND revoked_at IS NULL').get(intParam(ctx.params.id), u.id);
    if (!s) throw new HttpError(404, 'not_found');
    return { raw: Buffer.from(s.image), type: 'image/png' };
  });

  // --- super admin
  const DOC_ID = () => db.prepare('SELECT id FROM documents ORDER BY id LIMIT 1').get()?.id;

  route('GET', '/api/admin/overview', async (ctx) => {
    requireAdmin(ctx);
    const docId = DOC_ID();
    const units = db.prepare('SELECT COUNT(*) AS n, SUM(area) AS area FROM units').get();
    const signedUnits = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(area),0) AS area FROM units WHERE id IN (SELECT unit_id FROM signatures WHERE document_id = ? AND revoked_at IS NULL)`).get(docId);
    const people = db.prepare(`SELECT COUNT(*) AS n, SUM(code_hash IS NOT NULL) AS withCode,
      SUM(id IN (SELECT person_id FROM signatures WHERE document_id = ? AND revoked_at IS NULL)) AS signed FROM persons`).get(docId);
    const sigCount = db.prepare('SELECT COUNT(*) AS n FROM signatures WHERE document_id = ? AND revoked_at IS NULL').get(docId).n;
    const recent = db.prepare(`SELECT a.at, a.action, a.target, p.name_ka, p.name_en FROM audit_log a LEFT JOIN persons p ON p.id = a.actor_id ORDER BY a.id DESC LIMIT 8`).all();
    return { documentId: docId, units: { total: units.n, signed: signedUnits.n, area: units.area, signedArea: signedUnits.area },
      persons: { total: people.n, withCode: people.withCode, signed: people.signed }, signatures: sigCount, recent };
  });

  route('GET', '/api/admin/units', async (ctx) => {
    requireAdmin(ctx);
    const docId = DOC_ID();
    const sp = ctx.url.searchParams;
    const rows = db.prepare('SELECT * FROM units ORDER BY num').all();
    const owners = db.prepare(`SELECT o.unit_id, p.id, p.name_ka, p.name_en, p.kind,
        (SELECT s.id FROM signatures s WHERE s.unit_id = o.unit_id AND s.person_id = p.id AND s.document_id = ? AND s.revoked_at IS NULL) AS sig_id,
        (SELECT s.signed_at FROM signatures s WHERE s.unit_id = o.unit_id AND s.person_id = p.id AND s.document_id = ? AND s.revoked_at IS NULL) AS signed_at
      FROM unit_owners o JOIN persons p ON p.id = o.person_id`).all(docId, docId);
    const ids = db.prepare('SELECT person_id, value FROM identifiers').all();
    let list = rows.map(u => {
      const os = owners.filter(o => o.unit_id === u.id).map(o => ({ id: o.id, name_ka: o.name_ka, name_en: o.name_en, kind: o.kind,
        ids: ids.filter(i => i.person_id === o.id).map(i => i.value), signatureId: o.sig_id, signedAt: o.signed_at }));
      const n = os.filter(o => o.signatureId).length;
      return { ...u, owners: os, status: n === 0 ? 'unsigned' : n === os.length ? 'signed' : 'partial' };
    });
    const status = sp.get('status'), floor = sp.get('floor'), type = sp.get('type'), term = (sp.get('q') || '').trim().toLowerCase();
    if (status && status !== 'all') list = list.filter(u => u.status === status);
    if (floor && floor !== 'all') list = list.filter(u => u.floor === floor);
    if (type && type !== 'all') list = list.filter(u => u.type === type);
    if (term) { const nt = normId(term); list = list.filter(u => (u.code + ' ' + u.label + ' ' + u.owners.map(o => o.name_ka + ' ' + o.name_en).join(' ')).toLowerCase().includes(term) || (nt.length >= 3 && u.owners.some(o => o.ids.some(i => i.includes(nt))))); }
    return { units: list };
  });

  route('GET', '/api/admin/persons', async (ctx) => {
    requireAdmin(ctx);
    const docId = DOC_ID(); const sp = ctx.url.searchParams;
    const rows = db.prepare(`SELECT p.id, p.kind, p.name_ka, p.name_en, p.role, p.phone, p.email, p.last_login_at, p.locked_until,
        p.code_hash IS NOT NULL AS has_code, p.code_issued_at,
        (SELECT COUNT(*) FROM unit_owners o WHERE o.person_id = p.id) AS unit_count,
        (SELECT COUNT(*) FROM signatures s WHERE s.person_id = p.id AND s.document_id = ? AND s.revoked_at IS NULL) AS signed_count,
        (SELECT group_concat(value, ' ') FROM identifiers i WHERE i.person_id = p.id) AS ids,
        (SELECT group_concat(u.label, ', ') FROM unit_owners o JOIN units u ON u.id = o.unit_id WHERE o.person_id = p.id) AS unit_labels
      FROM persons p ORDER BY p.name_en`).all(docId);
    let list = rows.map(r => ({ ...r, has_code: !!r.has_code, status: r.signed_count === 0 ? 'unsigned' : r.signed_count >= r.unit_count ? 'signed' : 'partial', ids: (r.ids || '').split(' ') }));
    const status = sp.get('status'), term = (sp.get('q') || '').trim().toLowerCase();
    if (status === 'nocode') list = list.filter(p => !p.has_code);
    else if (status && status !== 'all') list = list.filter(p => p.status === status);
    if (term) { const nt = normId(term); list = list.filter(p => (p.name_ka + ' ' + p.name_en + ' ' + (p.phone || '') + ' ' + (p.email || '')).toLowerCase().includes(term) || (nt.length >= 3 && p.ids.some(i => i.includes(nt)))); }
    return { persons: list };
  });

  route('GET', '/api/admin/persons/:id', async (ctx) => {
    requireAdmin(ctx);
    const p = q.personById.get(intParam(ctx.params.id)); if (!p) throw new HttpError(404, 'not_found');
    const units = q.unitsOf.all(p.id);
    const signatures = db.prepare(`SELECT s.id, s.document_id, s.signed_at, s.signed_name, s.lang, s.ip, s.image_sha256, s.revoked_at, s.revoke_reason, u.code AS unit_code
      FROM signatures s JOIN units u ON u.id = s.unit_id WHERE s.person_id = ? ORDER BY s.signed_at DESC`).all(p.id);
    const history = db.prepare(`SELECT a.at, a.action, a.details, a.ip, x.name_en AS actor FROM audit_log a LEFT JOIN persons x ON x.id = a.actor_id WHERE a.target = ? ORDER BY a.id DESC LIMIT 30`).all(`person:${p.id}`);
    audit(ctx.user.id, 'admin_view_person', `person:${p.id}`, null, ctx.ip);
    return { person: { id: p.id, kind: p.kind, name_ka: p.name_ka, name_en: p.name_en, role: p.role, lang: p.lang, phone: p.phone, email: p.email, note: p.note,
      has_code: !!p.code_hash, code_issued_at: p.code_issued_at, last_login_at: p.last_login_at, locked_until: p.locked_until, created_at: p.created_at,
      ids: q.identsOf.all(p.id) }, units, signatures, history };
  });

  route('PATCH', '/api/admin/persons/:id', async (ctx) => {
    const admin = requireAdmin(ctx);
    const p = q.personById.get(intParam(ctx.params.id)); if (!p) throw new HttpError(404, 'not_found');
    const body = await readJson(ctx.req);
    const allowed = ['phone', 'email', 'note']; // role is deliberately not editable over the API
    const changes = {};
    for (const k of allowed) if (k in body) { const v = body[k] == null ? null : String(body[k]).trim().slice(0, k === 'note' ? 1000 : 120); changes[k] = v || null; }
    if ('role' in body) throw new HttpError(403, 'role_change_forbidden');
    if (!Object.keys(changes).length) throw new HttpError(400, 'nothing_to_update');
    db.prepare(`UPDATE persons SET ${Object.keys(changes).map(k => k + ' = ?').join(', ')} WHERE id = ?`).run(...Object.values(changes), p.id);
    audit(admin.id, 'person_updated', `person:${p.id}`, { fields: Object.keys(changes) }, ctx.ip);
    return { ok: true };
  });

  route('POST', '/api/admin/persons/:id/access-code', async (ctx) => {
    const admin = requireAdmin(ctx);
    const p = q.personById.get(intParam(ctx.params.id)); if (!p) throw new HttpError(404, 'not_found');
    const code = generateAccessCode();
    tx(db, () => {
      db.prepare('UPDATE persons SET code_hash = ?, code_issued_at = ?, failed_logins = 0, locked_until = NULL WHERE id = ?').run(hashSecret(normCode(code)), nowIso(), p.id);
      if (p.id !== admin.id) db.prepare('DELETE FROM sessions WHERE person_id = ?').run(p.id);
    });
    audit(admin.id, p.code_hash ? 'access_code_reset' : 'access_code_issued', `person:${p.id}`, null, ctx.ip);
    return { code };
  });

  route('DELETE', '/api/admin/persons/:id/access-code', async (ctx) => {
    const admin = requireAdmin(ctx);
    const p = q.personById.get(intParam(ctx.params.id)); if (!p) throw new HttpError(404, 'not_found');
    if (p.id === admin.id) throw new HttpError(409, 'cannot_revoke_self');
    tx(db, () => {
      db.prepare('UPDATE persons SET code_hash = NULL, code_issued_at = NULL WHERE id = ?').run(p.id);
      db.prepare('DELETE FROM sessions WHERE person_id = ?').run(p.id);
    });
    audit(admin.id, 'access_code_revoked', `person:${p.id}`, null, ctx.ip);
    return { ok: true };
  });

  route('GET', '/api/admin/signatures/:id/image', async (ctx) => {
    requireAdmin(ctx);
    const s = db.prepare('SELECT image FROM signatures WHERE id = ?').get(intParam(ctx.params.id));
    if (!s) throw new HttpError(404, 'not_found');
    return { raw: Buffer.from(s.image), type: 'image/png' };
  });

  route('POST', '/api/admin/signatures/:id/revoke', async (ctx) => {
    const admin = requireAdmin(ctx);
    const id = intParam(ctx.params.id);
    const { reason } = await readJson(ctx.req);
    const r = String(reason || '').trim();
    if (r.length < 3) throw new HttpError(400, 'reason_required');
    const s = db.prepare('SELECT id, person_id, revoked_at FROM signatures WHERE id = ?').get(id);
    if (!s) throw new HttpError(404, 'not_found');
    if (s.revoked_at) throw new HttpError(409, 'already_revoked');
    db.prepare('UPDATE signatures SET revoked_at = ?, revoked_by = ?, revoke_reason = ? WHERE id = ?').run(nowIso(), admin.id, r.slice(0, 500), id);
    audit(admin.id, 'signature_revoked', `person:${s.person_id}`, { signatureId: id, reason: r.slice(0, 500) }, ctx.ip);
    return { ok: true };
  });

  route('GET', '/api/admin/audit', async (ctx) => {
    requireAdmin(ctx);
    const sp = ctx.url.searchParams;
    const limit = Math.min(200, Math.max(1, Number(sp.get('limit')) || 50)), offset = Math.max(0, Number(sp.get('offset')) || 0);
    const action = sp.get('action');
    const where = action && action !== 'all' ? 'WHERE a.action = ?' : '';
    const args = action && action !== 'all' ? [action] : [];
    const rows = db.prepare(`SELECT a.id, a.at, a.action, a.target, a.details, a.ip, p.name_ka, p.name_en, t.name_ka AS target_ka, t.name_en AS target_en
      FROM audit_log a LEFT JOIN persons p ON p.id = a.actor_id
      LEFT JOIN persons t ON a.target LIKE 'person:%' AND t.id = CAST(substr(a.target, 8) AS INTEGER)
      ${where} ORDER BY a.id DESC LIMIT ? OFFSET ?`).all(...args, limit, offset);
    const total = db.prepare(`SELECT COUNT(*) AS n FROM audit_log a ${where}`).get(...args).n;
    return { entries: rows, total };
  });

  route('GET', '/api/admin/export.csv', async (ctx) => {
    const admin = requireAdmin(ctx);
    const docId = DOC_ID();
    const rows = db.prepare(`SELECT u.num, u.code, u.type, u.label, u.floor, u.area, p.name_ka, p.name_en,
        (SELECT group_concat(value, ' ') FROM identifiers i WHERE i.person_id = p.id) AS ids, p.phone, p.email,
        s.signed_at, s.signed_name, s.image_sha256
      FROM units u JOIN unit_owners o ON o.unit_id = u.id JOIN persons p ON p.id = o.person_id
      LEFT JOIN signatures s ON s.unit_id = u.id AND s.person_id = p.id AND s.document_id = ? AND s.revoked_at IS NULL
      ORDER BY u.num, p.name_en`).all(docId);
    const esc = (v) => { const s = String(v ?? ''); return /^[=+\-@]/.test(s) ? `"'${s.replace(/"/g, '""')}"` : `"${s.replace(/"/g, '""')}"`; };
    const head = ['No', 'Cadastral code', 'Type', 'Unit', 'Floor', 'Area m2', 'Owner (KA)', 'Owner (EN)', 'IDs', 'Phone', 'Email', 'Status', 'Signed at', 'Signed name', 'Signature SHA-256'];
    const lines = [head.map(esc).join(',')].concat(rows.map(r => [r.num, r.code, r.type, r.label, r.floor, r.area.toFixed(2), r.name_ka, r.name_en, r.ids, r.phone, r.email, r.signed_at ? 'signed' : 'pending', r.signed_at, r.signed_name, r.image_sha256].map(esc).join(',')));
    audit(admin.id, 'export_csv', `document:${docId}`, { rows: rows.length }, ctx.ip);
    return { raw: Buffer.from('﻿' + lines.join('\r\n'), 'utf8'), type: 'text/csv; charset=utf-8', filename: `alpiki-consents-${new Date().toISOString().slice(0, 10)}.csv` };
  });

  /* ---------------- dispatcher ---------------- */
  function securityHeaders(res) {
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data: blob:; style-src 'self' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com; script-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; object-src 'none'");
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    if (config.secureCookies) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  const sendJson = (res, status, obj) => { res.statusCode = status; res.setHeader('Content-Type', 'application/json; charset=utf-8'); res.setHeader('Cache-Control', 'no-store'); res.end(JSON.stringify(obj)); };

  function serveStatic(req, res, pathname) {
    let rel = decodeURIComponent(pathname);
    if (rel === '/' || !path.extname(rel)) rel = '/index.html';
    const file = path.resolve(PUBLIC_DIR, '.' + rel);
    if (!file.startsWith(PUBLIC_DIR + path.sep) || !fs.existsSync(file) || !fs.statSync(file).isFile()) { res.statusCode = 404; return res.end('Not found'); }
    res.setHeader('Content-Type', MIME[path.extname(file)] || 'application/octet-stream');
    res.setHeader('Cache-Control', rel === '/index.html' ? 'no-cache' : 'public, max-age=300');
    fs.createReadStream(file).pipe(res);
  }

  return async function handler(req, res) {
    securityHeaders(res);
    const url = new URL(req.url, 'http://localhost');
    const ip = clientIp(req);
    if (!url.pathname.startsWith('/api/')) {
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.statusCode = 405; return res.end(); }
      return serveStatic(req, res, url.pathname);
    }
    try {
      if (!apiLimit.hit(ip)) throw new HttpError(429, 'rate_limited');
      // CSRF: state-changing requests must come from our own page (custom header + same origin).
      if (req.method !== 'GET') {
        if (req.headers['x-alpiki'] !== '1') throw new HttpError(403, 'csrf');
        const origin = req.headers.origin;
        if (origin && new URL(origin).host !== req.headers.host) throw new HttpError(403, 'csrf');
      }
      const r = routes.find(r => r.method === req.method && r.re.test(url.pathname));
      if (!r) throw new HttpError(404, 'not_found');
      const ctx = { req, res, url, ip, params: url.pathname.match(r.re).groups || {}, user: currentUser(req) };
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
