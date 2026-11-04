// Minimal PostgreSQL client (wire protocol v3) built on node:net / node:tls / node:crypto.
// Supports TLS (with SNI, as Neon requires), SCRAM-SHA-256 / MD5 / cleartext auth,
// parameterised queries (extended protocol), multi-statement scripts and transactions.
import net from 'node:net';
import tls from 'node:tls';
import crypto from 'node:crypto';

export class PgError extends Error {
  constructor(fields) {
    super(fields.M || 'PostgreSQL error');
    this.code = fields.C; this.detail = fields.D; this.constraint = fields.n; this.severity = fields.S;
  }
}

const TYPE_PARSERS = {
  16: (v) => v === 't',
  20: Number, 21: Number, 23: Number, 26: Number,
  700: Number, 701: Number, 1700: Number,
  17: (v) => Buffer.from(v.slice(2), 'hex'),
  114: JSON.parse, 3802: JSON.parse,
};

function parseUrl(url) {
  const u = new URL(url);
  const sslmode = u.searchParams.get('sslmode') || (/(^|\.)neon\.tech$|vercel-storage|supabase/.test(u.hostname) ? 'require' : 'disable');
  return {
    host: u.hostname, port: Number(u.port || 5432),
    user: decodeURIComponent(u.username), password: decodeURIComponent(u.password),
    database: decodeURIComponent(u.pathname.slice(1) || u.username),
    ssl: sslmode !== 'disable',
    rejectUnauthorized: sslmode === 'verify-full' || sslmode === 'verify-ca' ? true : (u.searchParams.get('sslrootcert') ? true : sslmode === 'require' ? !/^(localhost|127\.0\.0\.1)$/.test(u.hostname) : false),
  };
}

const int32 = (n) => { const b = Buffer.alloc(4); b.writeInt32BE(n); return b; };
const int16 = (n) => { const b = Buffer.alloc(2); b.writeInt16BE(n); return b; };
const cstr = (s) => Buffer.concat([Buffer.from(s, 'utf8'), Buffer.from([0])]);
const msg = (type, ...parts) => { const body = Buffer.concat(parts); return Buffer.concat([Buffer.from(type), int32(body.length + 4), body]); };

export class Connection {
  constructor(opts) { this.opts = opts; this.buf = Buffer.alloc(0); this.waiters = []; this.queue = []; this.dead = false; }

  static async connect(url, { timeoutMs = 10000 } = {}) {
    const c = new Connection(parseUrl(url));
    await Promise.race([
      c.#open(),
      new Promise((_, rej) => setTimeout(() => rej(new Error('PostgreSQL connection timed out')), timeoutMs).unref()),
    ]).catch((e) => { c.destroy(); throw e; });
    return c;
  }

  async #open() {
    const o = this.opts;
    let sock = net.connect({ host: o.host, port: o.port });
    sock.setNoDelay(true);
    await new Promise((res, rej) => { sock.once('connect', res); sock.once('error', rej); });
    if (o.ssl) {
      sock.write(Buffer.concat([int32(8), int32(80877103)]));
      const answer = await new Promise((res, rej) => { sock.once('data', (d) => res(d.toString('latin1', 0, 1))); sock.once('error', rej); });
      if (answer !== 'S') throw new Error('Server does not support SSL');
      sock = tls.connect({ socket: sock, servername: net.isIP(o.host) ? undefined : o.host, rejectUnauthorized: o.rejectUnauthorized });
      await new Promise((res, rej) => { sock.once('secureConnect', res); sock.once('error', rej); });
    }
    this.sock = sock;
    sock.on('data', (d) => this.#onData(d));
    sock.on('error', (e) => this.#fail(e));
    sock.on('close', () => this.#fail(new Error('PostgreSQL connection closed')));

    sock.write(Buffer.concat([
      (() => { const body = Buffer.concat([int32(196608), cstr('user'), cstr(o.user), cstr('database'), cstr(o.database), cstr('application_name'), cstr('alpiki-consent'), cstr('client_encoding'), cstr('UTF8'), Buffer.from([0])]); return Buffer.concat([int32(body.length + 4), body]); })(),
    ]));
    await this.#authenticate();
    for (;;) { const m = await this.#next(); if (m.type === 'Z') break; if (m.type === 'E') throw new PgError(m.fields); }
  }

  async #authenticate() {
    const o = this.opts;
    let scram;
    for (;;) {
      const m = await this.#next();
      if (m.type === 'E') throw new PgError(m.fields);
      if (m.type !== 'R') continue;
      const kind = m.body.readInt32BE(0);
      if (kind === 0) return;
      if (kind === 3) this.sock.write(msg('p', cstr(o.password)));
      else if (kind === 5) {
        const salt = m.body.subarray(4, 8);
        const inner = crypto.createHash('md5').update(o.password + o.user).digest('hex');
        const outer = crypto.createHash('md5').update(Buffer.concat([Buffer.from(inner), salt])).digest('hex');
        this.sock.write(msg('p', cstr('md5' + outer)));
      } else if (kind === 10) {
        const mechs = m.body.subarray(4).toString('utf8').split('\0').filter(Boolean);
        if (!mechs.includes('SCRAM-SHA-256')) throw new Error('No supported SASL mechanism: ' + mechs.join(','));
        const nonce = crypto.randomBytes(18).toString('base64');
        scram = { bare: 'n=*,r=' + nonce, nonce };
        const first = Buffer.from('n,,' + scram.bare);
        this.sock.write(msg('p', cstr('SCRAM-SHA-256'), int32(first.length), first));
      } else if (kind === 11) {
        const serverFirst = m.body.subarray(4).toString('utf8');
        const a = Object.fromEntries(serverFirst.split(',').map((kv) => [kv[0], kv.slice(2)]));
        if (!a.r.startsWith(scram.nonce)) throw new Error('SCRAM nonce mismatch');
        const salted = crypto.pbkdf2Sync(o.password.normalize('NFKC'), Buffer.from(a.s, 'base64'), Number(a.i), 32, 'sha256');
        const hmac = (k, d) => crypto.createHmac('sha256', k).update(d).digest();
        const clientKey = hmac(salted, 'Client Key');
        const storedKey = crypto.createHash('sha256').update(clientKey).digest();
        const finalNoProof = 'c=biws,r=' + a.r;
        const authMessage = scram.bare + ',' + serverFirst + ',' + finalNoProof;
        const sig = hmac(storedKey, authMessage);
        const proof = Buffer.from(clientKey.map((b, i) => b ^ sig[i]));
        scram.serverSig = hmac(hmac(salted, 'Server Key'), authMessage).toString('base64');
        this.sock.write(msg('p', Buffer.from(finalNoProof + ',p=' + proof.toString('base64'))));
      } else if (kind === 12) {
        const v = m.body.subarray(4).toString('utf8').split(',').find((x) => x.startsWith('v='));
        if (!v || v.slice(2) !== scram.serverSig) throw new Error('SCRAM server signature mismatch');
      } else throw new Error('Unsupported auth method ' + kind);
    }
  }

  #onData(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    while (this.buf.length >= 5) {
      const len = this.buf.readInt32BE(1);
      if (this.buf.length < len + 1) break;
      const type = String.fromCharCode(this.buf[0]);
      const body = this.buf.subarray(5, len + 1);
      this.buf = this.buf.subarray(len + 1);
      const m = { type, body };
      if (type === 'E' || type === 'N') {
        m.fields = {}; let i = 0;
        while (i < body.length && body[i] !== 0) { const k = String.fromCharCode(body[i]); const end = body.indexOf(0, i + 1); m.fields[k] = body.toString('utf8', i + 1, end); i = end + 1; }
        if (type === 'N') continue;
      }
      if (type === 'S' || type === 'K' || type === 'A') continue; // parameter status, key data, notifications
      const w = this.waiters.shift();
      if (w) w.resolve(m); else this.queue.push(m);
    }
  }

  #fail(e) {
    if (this.dead) return;
    this.dead = true; this.error = e;
    for (const w of this.waiters.splice(0)) w.reject(e);
  }

  #next() {
    if (this.queue.length) return Promise.resolve(this.queue.shift());
    if (this.dead) return Promise.reject(this.error);
    return new Promise((resolve, reject) => this.waiters.push({ resolve, reject }));
  }

  /** Parameterised query ($1, $2 …). Buffers are sent as binary (bytea). */
  async query(text, params = []) {
    if (this.dead) throw this.error;
    const formats = params.map((p) => (Buffer.isBuffer(p) ? 1 : 0));
    const values = params.map((p) => {
      if (p === null || p === undefined) return int32(-1);
      const b = Buffer.isBuffer(p) ? p : Buffer.from(typeof p === 'boolean' ? (p ? 't' : 'f') : p instanceof Date ? p.toISOString() : typeof p === 'object' ? JSON.stringify(p) : String(p), 'utf8');
      return Buffer.concat([int32(b.length), b]);
    });
    this.sock.write(Buffer.concat([
      msg('P', cstr(''), cstr(text), int16(0)),
      msg('B', cstr(''), cstr(''), int16(formats.length), ...formats.map(int16), int16(values.length), ...values, int16(0)),
      msg('D', Buffer.from('P'), cstr('')),
      msg('E', cstr(''), int32(0)),
      msg('S'),
    ]));
    let fields = [], rows = [], rowCount = 0, error = null;
    for (;;) {
      const m = await this.#next();
      if (m.type === 'T') fields = parseRowDescription(m.body);
      else if (m.type === 'D') rows.push(parseDataRow(m.body, fields));
      else if (m.type === 'C') { const n = /(\d+)$/.exec(m.body.toString('utf8', 0, m.body.length - 1)); rowCount = n ? Number(n[1]) : 0; }
      else if (m.type === 'E') error = new PgError(m.fields);
      else if (m.type === 'Z') { this.txStatus = String.fromCharCode(m.body[0]); break; }
    }
    if (error) throw error;
    return { rows, rowCount };
  }

  /** Simple-protocol script (several statements, no parameters). */
  async exec(text) {
    if (this.dead) throw this.error;
    this.sock.write(msg('Q', cstr(text)));
    let error = null;
    for (;;) {
      const m = await this.#next();
      if (m.type === 'E') error = new PgError(m.fields);
      else if (m.type === 'Z') { this.txStatus = String.fromCharCode(m.body[0]); break; }
    }
    if (error) throw error;
  }

  async close() { if (!this.dead) { try { this.sock.write(msg('X')); } catch (_) {} this.sock.end(); } this.dead = true; }
  destroy() { this.dead = true; this.sock?.destroy(); }
}

function parseRowDescription(b) {
  const n = b.readInt16BE(0); const fields = []; let i = 2;
  for (let k = 0; k < n; k++) {
    const end = b.indexOf(0, i); const name = b.toString('utf8', i, end); i = end + 1;
    const oid = b.readInt32BE(i + 6); i += 18;
    fields.push({ name, oid });
  }
  return fields;
}
function parseDataRow(b, fields) {
  const n = b.readInt16BE(0); const row = {}; let i = 2;
  for (let k = 0; k < n; k++) {
    const len = b.readInt32BE(i); i += 4;
    const f = fields[k];
    if (len === -1) { row[f.name] = null; continue; }
    const v = b.toString('utf8', i, i + len); i += len;
    const p = TYPE_PARSERS[f.oid];
    row[f.name] = p ? p(v) : v;
  }
  return row;
}

/** One shared connection per process with a mutex; reconnects after idle disconnects. */
export class Db {
  constructor(url) { this.url = url; this.conn = null; this.lock = Promise.resolve(); }

  async #conn() {
    if (!this.conn || this.conn.dead) this.conn = await Connection.connect(this.url);
    return this.conn;
  }
  #withLock(fn) {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => {});
    return run;
  }
  static sql(text) { // '?' placeholders → $1..$n (ignores ? inside quotes)
    let n = 0, out = '', q = false;
    for (const ch of text) { if (ch === "'") q = !q; out += ch === '?' && !q ? '$' + ++n : ch; }
    return out;
  }
  async #run(conn, text, params) { return conn.query(Db.sql(text), params); }

  query(text, params = []) {
    return this.#withLock(async () => {
      try { return await this.#run(await this.#conn(), text, params); }
      catch (e) {
        if (e instanceof PgError) throw e;
        this.conn?.destroy(); this.conn = null;           // connection-level failure: retry once
        return this.#run(await this.#conn(), text, params);
      }
    });
  }
  async get(text, ...params) { return (await this.query(text, params)).rows[0]; }
  async all(text, ...params) { return (await this.query(text, params)).rows; }
  async run(text, ...params) { return this.query(text, params); }
  exec(text) { return this.#withLock(async () => (await this.#conn()).exec(text)); }

  /** Runs fn inside BEGIN/COMMIT on the locked connection; fn receives the same get/all/run API. */
  tx(fn) {
    return this.#withLock(async () => {
      const conn = await this.#conn();
      const t = {
        get: async (s, ...p) => (await this.#run(conn, s, p)).rows[0],
        all: async (s, ...p) => (await this.#run(conn, s, p)).rows,
        run: (s, ...p) => this.#run(conn, s, p),
        exec: (s) => conn.exec(s),
      };
      await conn.exec('BEGIN');
      try { const r = await fn(t); await conn.exec('COMMIT'); return r; }
      catch (e) { if (!conn.dead) await conn.exec('ROLLBACK').catch(() => {}); throw e; }
    });
  }
  async close() { await this.conn?.close(); this.conn = null; }
}
