// Database layer: PostgreSQL (Neon on Vercel). Migrations are additive and idempotent and run under
// an advisory lock, so parallel cold starts cannot apply them twice and existing data is never dropped.
import { Db } from './pg.js';

const NOW = `to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`;

const MIGRATIONS = [
  // 1 — initial schema
  `
  CREATE TABLE persons (
    id            BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    kind          TEXT NOT NULL CHECK (kind IN ('person','company')),
    name_ka       TEXT NOT NULL,
    name_en       TEXT NOT NULL,
    role          TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','superadmin')),
    lang          TEXT NOT NULL DEFAULT 'ka' CHECK (lang IN ('ka','en','ru')),
    phone         TEXT,
    email         TEXT,
    note          TEXT,
    code_hash     TEXT,
    code_issued_at TEXT,
    failed_logins INTEGER NOT NULL DEFAULT 0,
    locked_until  TEXT,
    last_login_at TEXT,
    created_at    TEXT NOT NULL DEFAULT ${NOW}
  );
  CREATE TABLE identifiers (
    value      TEXT PRIMARY KEY,
    kind       TEXT NOT NULL,
    person_id  BIGINT NOT NULL REFERENCES persons(id)
  );
  CREATE INDEX idx_identifiers_person ON identifiers(person_id);
  CREATE TABLE units (
    id     BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    num    INTEGER NOT NULL,
    code   TEXT NOT NULL UNIQUE,
    type   TEXT NOT NULL,
    label  TEXT NOT NULL,
    floor  TEXT NOT NULL,
    area   DOUBLE PRECISION NOT NULL
  );
  CREATE TABLE unit_owners (
    unit_id   BIGINT NOT NULL REFERENCES units(id),
    person_id BIGINT NOT NULL REFERENCES persons(id),
    PRIMARY KEY (unit_id, person_id)
  );
  CREATE TABLE documents (
    id         BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    slug       TEXT NOT NULL UNIQUE,
    content    TEXT NOT NULL,
    status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
    created_at TEXT NOT NULL DEFAULT ${NOW}
  );
  CREATE TABLE signatures (
    id           BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    document_id  BIGINT NOT NULL REFERENCES documents(id),
    unit_id      BIGINT NOT NULL REFERENCES units(id),
    person_id    BIGINT NOT NULL REFERENCES persons(id),
    signed_name  TEXT NOT NULL,
    image        BYTEA NOT NULL,
    image_sha256 TEXT NOT NULL,
    lang         TEXT NOT NULL,
    ip           TEXT,
    user_agent   TEXT,
    signed_at    TEXT NOT NULL DEFAULT ${NOW},
    revoked_at   TEXT,
    revoked_by   BIGINT REFERENCES persons(id),
    revoke_reason TEXT
  );
  CREATE UNIQUE INDEX uq_signature_active ON signatures(document_id, unit_id, person_id) WHERE revoked_at IS NULL;
  CREATE INDEX idx_signatures_person ON signatures(person_id);
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    person_id  BIGINT NOT NULL REFERENCES persons(id),
    created_at TEXT NOT NULL DEFAULT ${NOW},
    expires_at TEXT NOT NULL,
    ip         TEXT,
    user_agent TEXT
  );
  CREATE INDEX idx_sessions_person ON sessions(person_id);
  CREATE TABLE audit_log (
    id        BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    at        TEXT NOT NULL DEFAULT ${NOW},
    actor_id  BIGINT REFERENCES persons(id),
    action    TEXT NOT NULL,
    target    TEXT,
    details   TEXT,
    ip        TEXT
  );
  CREATE INDEX idx_audit_target ON audit_log(target);
  CREATE TABLE rate_limits (
    key          TEXT PRIMARY KEY,
    window_start BIGINT NOT NULL,
    hits         INTEGER NOT NULL
  );
  CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
  `,
];

export async function openDb(url) {
  if (!url) throw new Error('DATABASE_URL is not set');
  const db = new Db(url);
  await db.tx(async (t) => {
    // Never wait forever behind another (possibly frozen) instance.
    await t.exec("SET LOCAL lock_timeout = '10s'; SET LOCAL statement_timeout = '15s'");
    await t.run('SELECT pg_advisory_xact_lock(7244110)');
    await t.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
    const v = (await t.get('SELECT COALESCE(MAX(version), 0) AS v FROM schema_version')).v;
    for (let i = v; i < MIGRATIONS.length; i++) {
      await t.exec(MIGRATIONS[i]);
      await t.run('INSERT INTO schema_version (version) VALUES (?)', i + 1);
    }
  });
  return db;
}

export const normId = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
