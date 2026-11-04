import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { openDb } from '../src/db.js';
import { seed } from '../src/seed.js';
import { createApp } from '../src/app.js';
import { config as baseConfig } from '../src/config.js';
import { generateAccessCode, normCode, hashSecret } from '../src/security.js';
import { applySuperadminEnv } from '../src/bootstrap.js';
import { startCluster, freshDatabase } from './helpers/pgcluster.js';

const ADMIN_PID = '01020003679';   // Aleksi Simonishvili, unit 29ა (co-owned with Ia Khidasheli)
const A_PID = '01024024038';       // Khatuna Danelia: units 33ა, 40ა, parking 30
const B_PID = '61001021571';       // Natia Tkhilaishvili: units 3, 6ა
const PASSPORT_PID = 'MP4433152';  // Iuri Kolpak, passport number (second identifier)

let cluster, dbUrl, db, server, base, strictServer, strictBase, adminCode;
const config = { ...baseConfig, secureCookies: false, loginMaxPerIp: 1000 };

function png(w, h, ink) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  if (ink) for (let y = 20; y < h - 20; y++) for (let x = 20; x < w - 20; x++) if ((x * 7 + y * 13) % 17 < 3) raw.writeUInt32BE(0x0b1a2bff, y * (w * 4 + 1) + 1 + x * 4);
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td)); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const buf = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  return 'data:image/png;base64,' + buf.toString('base64');
}

async function call(method, url, { body, cookie, headers = {}, raw, at } = {}) {
  const h = { ...headers };
  if (method !== 'GET') h['x-alpiki'] ??= '1';
  if (body) h['content-type'] = 'application/json';
  if (cookie) h.cookie = cookie;
  const res = await fetch((at || base) + url, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const setCookie = res.headers.get('set-cookie');
  const data = raw ? Buffer.from(await res.arrayBuffer()) : await res.json().catch(() => null);
  return { status: res.status, data, cookie: setCookie ? setCookie.split(';')[0] : null, headers: res.headers };
}
const login = async (pid, code, at) => call('POST', '/api/auth/login', { body: { personalId: pid, accessCode: code }, at });

before(async () => {
  cluster = await startCluster();
  dbUrl = await freshDatabase(cluster.url, 'alpiki_api_test');
  db = await openDb(dbUrl);
  await seed(db);
  // Super admin is granted only outside the website (environment / CLI with database access).
  adminCode = generateAccessCode();
  await applySuperadminEnv(db, { superadminId: ADMIN_PID, superadminInitialCode: adminCode });
  server = http.createServer(createApp({ db, config }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
  // Same database, but with REQUIRE_ACCESS_CODE=1 (owners also need a code).
  strictServer = http.createServer(createApp({ db, config: { ...config, requireMemberCode: true } }));
  await new Promise(r => strictServer.listen(0, '127.0.0.1', r));
  strictBase = `http://127.0.0.1:${strictServer.address().port}`;
});
after(async () => { server.close(); strictServer.close(); await db.close(); cluster.stop(); });

let admin, admin2, memberA, memberB, codeA, codeB, sigIdA;

test('registry import: 118 units, 104 owners, idempotent re-import', async () => {
  assert.equal((await db.get('SELECT COUNT(*) n FROM units')).n, 118);
  assert.equal((await db.get('SELECT COUNT(*) n FROM persons')).n, 104);
  assert.deepEqual(await seed(db), { units: 0, persons: 0, links: 0, document: 0 });
  assert.deepEqual(await seed(db, { force: true }), { units: 0, persons: 0, links: 0, document: 0 }, 'full re-import adds nothing');
  assert.equal((await db.get('SELECT COUNT(*) n FROM unit_owners')).n, 135);
});

test('owners sign in with the ID number alone; unknown numbers are refused', async () => {
  const cfg = await call('GET', '/api/auth/config');
  assert.deepEqual(cfg.data, { memberCode: false });
  const unknown = await login('99999999999', '');
  assert.equal(unknown.status, 401); assert.equal(unknown.data.error, 'unknown_id');
  const ok = await login(B_PID, '');
  assert.equal(ok.status, 200); assert.equal(ok.data.user.role, 'member');
  assert.equal((await call('GET', '/api/me')).status, 401, 'no cookie, no data');
});

test('the super admin always needs the access code as well', async () => {
  const noCode = await login(ADMIN_PID, '');
  assert.equal(noCode.status, 401); assert.equal(noCode.data.error, 'code_required');
  const wrong = await login(ADMIN_PID, 'ZZZZ-ZZZY');
  assert.equal(wrong.status, 401); assert.equal(wrong.data.error, 'invalid_credentials');
  await db.run('UPDATE persons SET failed_logins = 0 WHERE id = (SELECT person_id FROM identifiers WHERE value = ?)', ADMIN_PID);
});

test('with REQUIRE_ACCESS_CODE=1 owners need a code too', async () => {
  assert.deepEqual((await call('GET', '/api/auth/config', { at: strictBase })).data, { memberCode: true });
  const r = await login(A_PID, '', strictBase);
  assert.equal(r.status, 401); assert.equal(r.data.error, 'code_required');
});

test('super admin signs in and issues access codes', async () => {
  const r = await login(ADMIN_PID, adminCode.toLowerCase().replace('-', ' ')); // format-tolerant
  assert.equal(r.status, 200); assert.equal(r.data.user.role, 'superadmin');
  admin = r.cookie;
  const persons = (await call('GET', '/api/admin/persons?q=' + A_PID, { cookie: admin })).data.persons;
  assert.equal(persons.length, 1);
  const idA = persons[0].id;
  const idB = (await call('GET', '/api/admin/persons?q=' + B_PID, { cookie: admin })).data.persons[0].id;
  codeA = (await call('POST', `/api/admin/persons/${idA}/access-code`, { cookie: admin })).data.code;
  codeB = (await call('POST', `/api/admin/persons/${idB}/access-code`, { cookie: admin })).data.code;
  assert.match(codeA, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  const stored = (await db.get('SELECT code_hash FROM persons WHERE id = ?', idA)).code_hash;
  assert.ok(stored.startsWith('scrypt$') && !stored.includes(normCode(codeA)), 'code stored only as a hash');
});

test('member signs in and sees only their own units', async () => {
  const r = await login(A_PID, codeA);
  assert.equal(r.status, 200); assert.equal(r.data.user.role, 'member');
  memberA = r.cookie;
  const me = await call('GET', '/api/me', { cookie: memberA });
  assert.equal(me.status, 200);
  assert.deepEqual(me.data.units.map(u => u.label).sort(), ['30', '33ა', '40ა']);
  assert.ok(me.data.user.ids.every(i => i.masked.includes('•')), 'own IDs are masked');
  assert.ok(!JSON.stringify(me.data).includes('Tkhilaishvili'), 'no other member data');
  memberB = (await login(B_PID, codeB)).cookie;
});

test('member cannot reach admin API or other members\' data by direct calls', async () => {
  for (const [m, u] of [['GET', '/api/admin/overview'], ['GET', '/api/admin/units'], ['GET', '/api/admin/persons'], ['GET', '/api/admin/persons/1'], ['GET', '/api/admin/audit'], ['GET', '/api/admin/export.csv'], ['POST', '/api/admin/persons/1/access-code'], ['PATCH', '/api/admin/persons/1'], ['GET', '/api/admin/signatures/1/image']]) {
    const r = await call(m, u, { cookie: memberA, body: m === 'PATCH' ? { note: 'x' } : undefined });
    assert.equal(r.status, 403, `${m} ${u}`);
  }
  // signing someone else's unit (Natia's apartment 3)
  const r = await call('POST', '/api/me/documents/1/signatures', { cookie: memberA, body: { unitCodes: ['71.62.58.548.01.01.003'], signedName: 'Khatuna Danelia', consent: true, image: png(600, 180, true) } });
  assert.equal(r.status, 403); assert.equal(r.data.error, 'not_your_unit');
});

test('signature is saved, linked to member, unit and document, and can be read back', async () => {
  const image = png(600, 180, true);
  const r = await call('POST', '/api/me/documents/1/signatures', { cookie: memberA, body: { unitCodes: ['71.62.58.548.01.01.033ა', '71.62.58.548.01.04.030'], signedName: 'Khatuna Danelia', consent: true, image, lang: 'en' } });
  assert.equal(r.status, 200); assert.equal(r.data.signatures.length, 2);
  sigIdA = r.data.signatures[0].id;
  const row = (await db.get('SELECT s.*, u.code FROM signatures s JOIN units u ON u.id = s.unit_id WHERE s.id = ?', sigIdA));
  assert.equal(row.code, '71.62.58.548.01.01.033ა'); assert.equal(row.document_id, 1);
  assert.equal(row.person_id, (await db.get('SELECT person_id FROM identifiers WHERE value = ?', A_PID)).person_id);
  const img = await call('GET', `/api/me/signatures/${sigIdA}/image`, { cookie: memberA, raw: true });
  assert.equal(img.status, 200); assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal(crypto.createHash('sha256').update(img.data).digest('hex'), row.image_sha256);
  const me = await call('GET', '/api/me', { cookie: memberA });
  assert.equal(me.data.units.filter(u => u.signatures.length).length, 2);
});

test('duplicate signatures are rejected', async () => {
  const r = await call('POST', '/api/me/documents/1/signatures', { cookie: memberA, body: { unitCodes: ['71.62.58.548.01.01.033ა'], signedName: 'Khatuna Danelia', consent: true, image: png(600, 180, true) } });
  assert.equal(r.status, 409); assert.equal(r.data.error, 'already_signed');
  assert.equal((await db.get('SELECT COUNT(*) n FROM signatures WHERE unit_id = (SELECT id FROM units WHERE code = ?) AND revoked_at IS NULL', '71.62.58.548.01.01.033ა')).n, 1);
});

test('signature input is validated', async () => {
  const body = { unitCodes: ['71.62.58.548.01.01.040ა'], signedName: 'Khatuna Danelia', consent: true, image: png(600, 180, true) };
  assert.equal((await call('POST', '/api/me/documents/1/signatures', { cookie: memberA, body: { ...body, consent: false } })).data.error, 'consent_required');
  assert.equal((await call('POST', '/api/me/documents/1/signatures', { cookie: memberA, body: { ...body, image: 'data:image/png;base64,AAAA' } })).data.error, 'invalid_signature');
  assert.equal((await call('POST', '/api/me/documents/1/signatures', { cookie: memberA, body: { ...body, signedName: '' } })).data.error, 'invalid_name');
});

test('member B cannot read member A\'s signature image', async () => {
  const r = await call('GET', `/api/me/signatures/${sigIdA}/image`, { cookie: memberB, raw: true });
  assert.equal(r.status, 404);
  const me = await call('GET', '/api/me', { cookie: memberB });
  assert.ok(!JSON.stringify(me.data).includes('Danelia'));
});

test('super admin sees the whole database, filters and signatures', async () => {
  const all = await call('GET', '/api/admin/units', { cookie: admin });
  assert.equal(all.data.units.length, 118);
  const signed = await call('GET', '/api/admin/units?status=signed', { cookie: admin });
  assert.deepEqual(signed.data.units.map(u => u.label).sort(), ['30', '33ა']);
  const unsigned = await call('GET', '/api/admin/units?status=unsigned', { cookie: admin });
  assert.equal(unsigned.data.units.length, 116);
  const byName = await call('GET', '/api/admin/persons?q=danelia', { cookie: admin });
  assert.equal(byName.data.persons[0].status, 'partial');
  const byPassport = await call('GET', '/api/admin/persons?q=' + PASSPORT_PID, { cookie: admin });
  assert.equal(byPassport.data.persons[0].name_en, 'Iuri Kolpak');
  const img = await call('GET', `/api/admin/signatures/${sigIdA}/image`, { cookie: admin, raw: true });
  assert.equal(img.status, 200);
  const ov = await call('GET', '/api/admin/overview', { cookie: admin });
  assert.equal(ov.data.units.signed, 2); assert.equal(ov.data.signatures, 2);
  const csv = await call('GET', '/api/admin/export.csv', { cookie: admin, raw: true });
  assert.equal(csv.status, 200); assert.ok(csv.data.toString('utf8').includes('Khatuna Danelia'));
});

test('roles cannot be changed through the API', async () => {
  const id = (await call('GET', '/api/me', { cookie: memberA })).data.user.id;
  const r = await call('PATCH', `/api/admin/persons/${id}`, { cookie: admin, body: { role: 'superadmin' } });
  assert.equal(r.status, 403);
  const self = await call('PATCH', '/api/admin/persons/' + id, { cookie: memberA, body: { role: 'superadmin' } });
  assert.equal(self.status, 403);
  assert.equal((await db.get('SELECT role FROM persons WHERE id = ?', id)).role, 'member');
});

test('state-changing requests without the anti-CSRF header or from another origin are refused', async () => {
  const r = await call('PUT', '/api/me/lang', { cookie: memberA, body: { lang: 'ru' }, headers: { 'x-alpiki': '0' } });
  assert.equal(r.status, 403);
  const o = await call('PUT', '/api/me/lang', { cookie: memberA, body: { lang: 'ru' }, headers: { origin: 'https://evil.example' } });
  assert.equal(o.status, 403);
  const ok = await call('PUT', '/api/me/lang', { cookie: memberA, body: { lang: 'ru' } });
  assert.equal(ok.status, 200);
  assert.equal((await call('GET', '/api/auth/session', { cookie: memberA })).data.user.lang, 'ru');
});

test('admin can revoke a signature; the member can sign again', async () => {
  assert.equal((await call('POST', `/api/admin/signatures/${sigIdA}/revoke`, { cookie: admin, body: { reason: 'Signed by mistake' } })).status, 200);
  const r = await call('POST', '/api/me/documents/1/signatures', { cookie: memberA, body: { unitCodes: ['71.62.58.548.01.01.033ა'], signedName: 'Khatuna Danelia', consent: true, image: png(600, 180, true) } });
  assert.equal(r.status, 200);
  assert.equal((await db.get('SELECT COUNT(*) n FROM signatures WHERE unit_id = (SELECT id FROM units WHERE code = ?)', '71.62.58.548.01.01.033ა')).n, 2, 'revoked signature is kept for the record');
});

test('resetting an access code ends the member\'s sessions', async () => {
  const id = (await call('GET', '/api/me', { cookie: memberB })).data.user.id;
  await call('POST', `/api/admin/persons/${id}/access-code`, { cookie: admin });
  assert.equal((await call('GET', '/api/me', { cookie: memberB })).status, 401);
  assert.equal((await login(B_PID, codeB, strictBase)).status, 401, 'old code no longer works where codes are required');
});

test('repeated wrong codes lock the account (where codes are required)', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await login(A_PID, 'ZZZZ-ZZZZ', strictBase)).status, 401);
  const r = await login(A_PID, codeA, strictBase);
  assert.equal(r.status, 429, 'correct code refused while locked');
});

test('logout ends the session', async () => {
  const r = await call('POST', '/api/auth/logout', { cookie: admin });
  assert.equal(r.status, 200);
  assert.equal((await call('GET', '/api/admin/overview', { cookie: admin })).status, 401);
  admin2 = (await login(ADMIN_PID, adminCode)).cookie;
});

test('audit log records the important actions', async () => {
  const actions = new Set((await db.all('SELECT action FROM audit_log')).map(r => r.action));
  for (const a of ['login', 'login_failed', 'login_locked', 'access_code_issued', 'access_code_reset', 'signature_created', 'signature_denied', 'signature_revoked', 'export_csv', 'logout']) assert.ok(actions.has(a), a);
});

test('data survives a restart (new connection + migrations + seed)', async () => {
  const before = (await db.get('SELECT COUNT(*) n FROM signatures')).n;
  const db2 = await openDb(dbUrl); await seed(db2, { force: true });
  assert.equal((await db2.get('SELECT COUNT(*) n FROM signatures')).n, before);
  assert.equal((await db2.get('SELECT role FROM persons WHERE id = (SELECT person_id FROM identifiers WHERE value = ?)', ADMIN_PID)).role, 'superadmin');
  assert.equal((await db2.get('SELECT MAX(version) v FROM schema_version')).v, 1);
  await db2.close();
});

test('parallel cold starts apply migrations and import only once', async () => {
  const url = await freshDatabase(cluster.url, 'alpiki_parallel_test');
  const dbs = await Promise.all([1, 2, 3, 4].map(() => openDb(url)));
  const stats = await Promise.all(dbs.map((d) => seed(d)));
  assert.equal(stats.reduce((n, s) => n + s.units, 0), 118);
  assert.equal((await dbs[0].get('SELECT COUNT(*) n FROM units')).n, 118);
  assert.equal((await dbs[0].get('SELECT COUNT(*) n FROM schema_version')).n, 1);
  await Promise.all(dbs.map((d) => d.close()));
});

test('super-admin environment setting only grants the role and a first code', async () => {
  const id = (await db.get('SELECT person_id FROM identifiers WHERE value = ?', ADMIN_PID)).person_id;
  const hashBefore = (await db.get('SELECT code_hash FROM persons WHERE id = ?', id)).code_hash;
  await applySuperadminEnv(db, { superadminId: ADMIN_PID, superadminInitialCode: 'ZZZZ-9999' });
  assert.equal((await db.get('SELECT code_hash FROM persons WHERE id = ?', id)).code_hash, hashBefore, 'existing code is not replaced from the environment');
  assert.equal((await login(ADMIN_PID, 'ZZZZ-9999')).status, 401);
  await applySuperadminEnv(db, { superadminId: '00000000000' });
  assert.equal((await db.get("SELECT COUNT(*) n FROM persons WHERE role = 'superadmin'")).n, 1);
});

test('Vercel-style invocation: rewritten path and pre-parsed body', async () => {
  const handler = createApp({ db: () => Promise.resolve(db), config, serveStatic: false });
  const fake = (method, url, body, headers = {}) => new Promise((resolve) => {
    const res = { statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k.toLowerCase()] = v; }, end(b) { resolve({ status: this.statusCode, headers: this.headers, body: b ? JSON.parse(String(b)) : null }); } };
    const req = { method, url, body, headers: { host: 'alpik-one.vercel.app', 'x-alpiki': '1', 'x-forwarded-for': '203.0.113.9', ...headers }, socket: {} };
    handler(req, res);
  });
  const bad = await fake('POST', '/api/index?__p=/api/auth/login', { personalId: A_PID, accessCode: 'ZZZZ-ZZZA' });
  assert.equal(bad.status, 429, 'account still locked from the previous test');
  const sess = await fake('GET', '/api/index?__p=/api/auth/session');
  assert.equal(sess.status, 401);
  const nf = await fake('GET', '/api/index?__p=/api/nope');
  assert.equal(nf.status, 404);
  const str = await fake('POST', '/api/index?__p=/api/auth/login', 'not json');
  assert.equal(str.status, 400);
  const page = await fake('GET', '/');
  assert.equal(page.status, 404, 'static files are left to Vercel');
});

test('database outage returns a clear 503, not a crash', async () => {
  const handler = createApp({ db: () => Promise.reject(new Error('down')), config, serveStatic: false });
  const r = await new Promise((resolve) => {
    const res = { statusCode: 0, setHeader() {}, end(b) { resolve({ status: this.statusCode, body: JSON.parse(String(b)) }); } };
    handler({ method: 'GET', url: '/api/auth/session', headers: { host: 'x' }, socket: {} }, res);
  });
  assert.equal(r.status, 503); assert.equal(r.body.error, 'database_unavailable');
});

test('search input cannot inject SQL', async () => {
  const r = await call('GET', "/api/admin/persons?q=" + encodeURIComponent("' OR 1=1; DROP TABLE persons; --"), { cookie: admin2 });
  assert.equal(r.status, 200); assert.equal(r.data.persons.length, 0);
  assert.equal((await db.get('SELECT COUNT(*) n FROM persons')).n, 104);
});

test('health endpoint reports the database connection', async () => {
  const r = await call('GET', '/api/health');
  assert.deepEqual(r.data, { ok: true, database: 'connected' });
});

test('security headers are set', async () => {
  const r = await fetch(base + '/');
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  const trav = await fetch(base + '/..%2fsrc%2fapp.js');
  assert.notEqual(await trav.text(), fs.readFileSync(new URL('../src/app.js', import.meta.url), 'utf8'));
});
