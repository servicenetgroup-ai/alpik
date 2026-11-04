import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { openDb } from '../src/db.js';
import { seed } from '../src/seed.js';
import { createApp } from '../src/app.js';
import { config as baseConfig } from '../src/config.js';
import { generateAccessCode, normCode, hashSecret } from '../src/security.js';

const ADMIN_PID = '01020003679';   // Aleksi Simonishvili, unit 29ა (co-owned with Ia Khidasheli)
const A_PID = '01024024038';       // Khatuna Danelia: units 33ა, 40ა, parking 30
const B_PID = '61001021571';       // Natia Tkhilaishvili: units 3, 6ა
const PASSPORT_PID = 'MP4433152';  // Iuri Kolpak, passport number (second identifier)

let tmp, db, server, base, adminCode;
const config = { ...baseConfig, secureCookies: false, loginMaxPerIp: 1000 };

function png(w, h, ink) {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  if (ink) for (let y = 20; y < h - 20; y++) for (let x = 20; x < w - 20; x++) if ((x * 7 + y * 13) % 17 < 3) raw.writeUInt32BE(0x0b1a2bff, y * (w * 4 + 1) + 1 + x * 4);
  const chunk = (type, data) => { const len = Buffer.alloc(4); len.writeUInt32BE(data.length); const td = Buffer.concat([Buffer.from(type), data]); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(td)); return Buffer.concat([len, td, crc]); };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  const buf = Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
  return 'data:image/png;base64,' + buf.toString('base64');
}

async function call(method, url, { body, cookie, headers = {}, raw } = {}) {
  const h = { ...headers };
  if (method !== 'GET') h['x-alpiki'] ??= '1';
  if (body) h['content-type'] = 'application/json';
  if (cookie) h.cookie = cookie;
  const res = await fetch(base + url, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
  const setCookie = res.headers.get('set-cookie');
  const data = raw ? Buffer.from(await res.arrayBuffer()) : await res.json().catch(() => null);
  return { status: res.status, data, cookie: setCookie ? setCookie.split(';')[0] : null, headers: res.headers };
}
const login = async (pid, code) => call('POST', '/api/auth/login', { body: { personalId: pid, accessCode: code } });

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'alpiki-'));
  db = openDb(path.join(tmp, 'test.db'));
  seed(db);
  // Super admin is granted only by the CLI path (direct DB access), as in production.
  adminCode = generateAccessCode();
  db.prepare("UPDATE persons SET role = 'superadmin', code_hash = ? WHERE id = (SELECT person_id FROM identifiers WHERE value = ?)").run(hashSecret(normCode(adminCode)), ADMIN_PID);
  server = http.createServer(createApp({ db, config }));
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});
after(() => { server.close(); db.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

let admin, memberA, memberB, codeA, codeB, sigIdA;

test('registry import: 118 units, 104 owners, idempotent re-import', () => {
  assert.equal(db.prepare('SELECT COUNT(*) n FROM units').get().n, 118);
  assert.equal(db.prepare('SELECT COUNT(*) n FROM persons').get().n, 104);
  assert.deepEqual(seed(db), { units: 0, persons: 0, links: 0, document: 0 });
  assert.equal(db.prepare('SELECT COUNT(*) n FROM unit_owners').get().n, 135);
});

test('login requires an issued access code; errors do not reveal whether the ID exists', async () => {
  const noCode = await login(A_PID, 'AAAA-BBBB');
  const unknown = await login('99999999999', 'AAAA-BBBB');
  assert.equal(noCode.status, 401); assert.equal(unknown.status, 401);
  assert.deepEqual(noCode.data, unknown.data);
  const anon = await call('GET', '/api/me');
  assert.equal(anon.status, 401);
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
  const stored = db.prepare('SELECT code_hash FROM persons WHERE id = ?').get(idA).code_hash;
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
  const row = db.prepare('SELECT s.*, u.code FROM signatures s JOIN units u ON u.id = s.unit_id WHERE s.id = ?').get(sigIdA);
  assert.equal(row.code, '71.62.58.548.01.01.033ა'); assert.equal(row.document_id, 1);
  assert.equal(row.person_id, db.prepare('SELECT person_id FROM identifiers WHERE value = ?').get(A_PID).person_id);
  const img = await call('GET', `/api/me/signatures/${sigIdA}/image`, { cookie: memberA, raw: true });
  assert.equal(img.status, 200); assert.equal(img.headers.get('content-type'), 'image/png');
  assert.equal(crypto.createHash('sha256').update(img.data).digest('hex'), row.image_sha256);
  const me = await call('GET', '/api/me', { cookie: memberA });
  assert.equal(me.data.units.filter(u => u.signatures.length).length, 2);
});

test('duplicate signatures are rejected', async () => {
  const r = await call('POST', '/api/me/documents/1/signatures', { cookie: memberA, body: { unitCodes: ['71.62.58.548.01.01.033ა'], signedName: 'Khatuna Danelia', consent: true, image: png(600, 180, true) } });
  assert.equal(r.status, 409); assert.equal(r.data.error, 'already_signed');
  assert.equal(db.prepare('SELECT COUNT(*) n FROM signatures WHERE unit_id = (SELECT id FROM units WHERE code = ?) AND revoked_at IS NULL').get('71.62.58.548.01.01.033ა').n, 1);
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
  assert.equal(db.prepare('SELECT role FROM persons WHERE id = ?').get(id).role, 'member');
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
  assert.equal(db.prepare('SELECT COUNT(*) n FROM signatures WHERE unit_id = (SELECT id FROM units WHERE code = ?)').get('71.62.58.548.01.01.033ა').n, 2, 'revoked signature is kept for the record');
});

test('resetting an access code ends the member\'s sessions', async () => {
  const id = (await call('GET', '/api/me', { cookie: memberB })).data.user.id;
  await call('POST', `/api/admin/persons/${id}/access-code`, { cookie: admin });
  assert.equal((await call('GET', '/api/me', { cookie: memberB })).status, 401);
  assert.equal((await login(B_PID, codeB)).status, 401, 'old code no longer works');
});

test('repeated wrong codes lock the account', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await login(A_PID, 'ZZZZ-ZZZZ')).status, 401);
  const r = await login(A_PID, codeA);
  assert.equal(r.status, 429, 'correct code refused while locked');
});

test('logout ends the session', async () => {
  const r = await call('POST', '/api/auth/logout', { cookie: admin });
  assert.equal(r.status, 200);
  assert.equal((await call('GET', '/api/admin/overview', { cookie: admin })).status, 401);
});

test('audit log records the important actions', () => {
  const actions = new Set(db.prepare('SELECT action FROM audit_log').all().map(r => r.action));
  for (const a of ['login', 'login_failed', 'login_locked', 'access_code_issued', 'access_code_reset', 'signature_created', 'signature_denied', 'signature_revoked', 'export_csv', 'logout']) assert.ok(actions.has(a), a);
});

test('data survives a restart (reopen + migrations + seed)', () => {
  const file = db.prepare('PRAGMA database_list').get().file;
  const before = db.prepare('SELECT COUNT(*) n FROM signatures').get().n;
  const db2 = openDb(file); seed(db2);
  assert.equal(db2.prepare('SELECT COUNT(*) n FROM signatures').get().n, before);
  assert.equal(db2.prepare("SELECT role FROM persons WHERE id = (SELECT person_id FROM identifiers WHERE value = ?)").get(ADMIN_PID).role, 'superadmin');
  db2.close();
});

test('security headers are set', async () => {
  const r = await fetch(base + '/');
  assert.match(r.headers.get('content-security-policy'), /script-src 'self'/);
  assert.equal(r.headers.get('x-frame-options'), 'DENY');
  const trav = await fetch(base + '/..%2fsrc%2fapp.js');
  assert.notEqual(await trav.text(), fs.readFileSync(new URL('../src/app.js', import.meta.url), 'utf8'));
});
