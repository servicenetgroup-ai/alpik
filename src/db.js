// Database layer: SQLite via Node's built-in driver. Schema migrations are additive and idempotent,
// so starting a new version never drops existing data.
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS = [
  // 1 — initial schema
  `
  CREATE TABLE persons (
    id            INTEGER PRIMARY KEY,
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
    created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE identifiers (
    value      TEXT PRIMARY KEY,               -- normalised: A-Z0-9 only
    kind       TEXT NOT NULL,                   -- P/N, C/N, ID
    person_id  INTEGER NOT NULL REFERENCES persons(id)
  );
  CREATE INDEX idx_identifiers_person ON identifiers(person_id);
  CREATE TABLE units (
    id     INTEGER PRIMARY KEY,
    num    INTEGER NOT NULL,
    code   TEXT NOT NULL UNIQUE,
    type   TEXT NOT NULL,
    label  TEXT NOT NULL,
    floor  TEXT NOT NULL,
    area   REAL NOT NULL
  );
  CREATE TABLE unit_owners (
    unit_id   INTEGER NOT NULL REFERENCES units(id),
    person_id INTEGER NOT NULL REFERENCES persons(id),
    PRIMARY KEY (unit_id, person_id)
  );
  CREATE TABLE documents (
    id         INTEGER PRIMARY KEY,
    slug       TEXT NOT NULL UNIQUE,
    content    TEXT NOT NULL,                   -- JSON {ka:{...}, en:{...}, ru:{...}}
    status     TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed')),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
  );
  CREATE TABLE signatures (
    id           INTEGER PRIMARY KEY,
    document_id  INTEGER NOT NULL REFERENCES documents(id),
    unit_id      INTEGER NOT NULL REFERENCES units(id),
    person_id    INTEGER NOT NULL REFERENCES persons(id),
    signed_name  TEXT NOT NULL,
    image        BLOB NOT NULL,                 -- PNG bytes
    image_sha256 TEXT NOT NULL,
    lang         TEXT NOT NULL,
    ip           TEXT,
    user_agent   TEXT,
    signed_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    revoked_at   TEXT,
    revoked_by   INTEGER REFERENCES persons(id),
    revoke_reason TEXT
  );
  -- one active signature per owner, per unit, per document
  CREATE UNIQUE INDEX uq_signature_active ON signatures(document_id, unit_id, person_id) WHERE revoked_at IS NULL;
  CREATE INDEX idx_signatures_person ON signatures(person_id);
  CREATE TABLE sessions (
    token_hash TEXT PRIMARY KEY,
    person_id  INTEGER NOT NULL REFERENCES persons(id),
    created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    expires_at TEXT NOT NULL,
    ip         TEXT,
    user_agent TEXT
  );
  CREATE TABLE audit_log (
    id        INTEGER PRIMARY KEY,
    at        TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    actor_id  INTEGER REFERENCES persons(id),
    action    TEXT NOT NULL,
    target    TEXT,
    details   TEXT,
    ip        TEXT
  );
  CREATE INDEX idx_audit_at ON audit_log(at);
  `,
];

export function openDb(file) {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;');
  db.exec('CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)');
  const row = db.prepare('SELECT MAX(version) AS v FROM schema_version').get();
  let v = row?.v ?? 0;
  for (let i = v; i < MIGRATIONS.length; i++) {
    tx(db, () => {
      db.exec(MIGRATIONS[i]);
      db.prepare('INSERT INTO schema_version (version) VALUES (?)').run(i + 1);
    });
  }
  return db;
}

export function tx(db, fn) {
  db.exec('BEGIN IMMEDIATE');
  try { const r = fn(); db.exec('COMMIT'); return r; }
  catch (e) { db.exec('ROLLBACK'); throw e; }
}

export const normId = (s) => String(s ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
