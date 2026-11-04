// Starts a throw-away local PostgreSQL 16 cluster that behaves like Neon for the client:
// TLS required, scram-sha-256 password auth. Used only by the tests.
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';

const BIN = ['/usr/lib/postgresql/16/bin', '/usr/lib/postgresql/17/bin', '/usr/lib/postgresql/15/bin'].find((d) => fs.existsSync(d + '/initdb'));

const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const asPg = (cmd, args) => execFileSync('runuser', ['-u', 'postgres', '--', cmd, ...args], { stdio: 'pipe' });

export async function startCluster() {
  if (process.env.TEST_DATABASE_URL) return { url: process.env.TEST_DATABASE_URL, stop() {} };
  if (!BIN) throw new Error('PostgreSQL binaries not found; set TEST_DATABASE_URL');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'alpiki-pg-'));
  fs.chmodSync(dir, 0o777);
  const data = path.join(dir, 'data');
  const pw = 'test-' + Math.random().toString(36).slice(2);
  fs.writeFileSync(path.join(dir, 'pw'), pw); fs.chmodSync(path.join(dir, 'pw'), 0o644);
  asPg(BIN + '/initdb', ['-D', data, '-U', 'postgres', '--auth=scram-sha-256', '--pwfile=' + path.join(dir, 'pw'), '-E', 'UTF8', '--locale=C.UTF-8']);
  execFileSync('openssl', ['req', '-new', '-x509', '-days', '2', '-nodes', '-subj', '/CN=localhost', '-keyout', data + '/server.key', '-out', data + '/server.crt'], { stdio: 'pipe' });
  execFileSync('chown', ['postgres:postgres', data + '/server.key', data + '/server.crt']);
  fs.chmodSync(data + '/server.key', 0o600);
  const port = await freePort();
  fs.appendFileSync(data + '/postgresql.conf', `\nport = ${port}\nlisten_addresses = '127.0.0.1'\nunix_socket_directories = '${dir}'\nssl = on\nfsync = off\nsynchronous_commit = off\n`);
  fs.writeFileSync(data + '/pg_hba.conf', 'hostssl all all 127.0.0.1/32 scram-sha-256\n');
  asPg(BIN + '/pg_ctl', ['-D', data, '-l', dir + '/log', '-w', 'start']);
  return {
    url: `postgres://postgres:${pw}@127.0.0.1:${port}/postgres?sslmode=require`,
    stop() { spawnSync('runuser', ['-u', 'postgres', '--', BIN + '/pg_ctl', '-D', data, '-m', 'immediate', 'stop'], { stdio: 'ignore' }); fs.rmSync(dir, { recursive: true, force: true }); },
  };
}

/** Creates a fresh database on the cluster and returns its URL. */
export async function freshDatabase(clusterUrl, name) {
  const { Db } = await import('../../src/pg.js');
  const admin = new Db(clusterUrl);
  await admin.exec(`DROP DATABASE IF EXISTS ${name}`);
  await admin.exec(`CREATE DATABASE ${name}`);
  await admin.close();
  const u = new URL(clusterUrl); u.pathname = '/' + name;
  return u.toString();
}
