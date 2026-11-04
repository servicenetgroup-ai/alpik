// Opens the database, applies migrations, imports the registry and applies the super-admin
// setting from the environment. Cached per process; retried on the next request if it failed.
import { openDb, normId } from './db.js';
import { seed } from './seed.js';
import { normCode, hashSecret } from './security.js';

let pending = null;

export function getDb(config) {
  if (!pending) {
    pending = (async () => {
      let stage = 'connect + migrations', db;
      try {
        db = await openDb(config.databaseUrl);
        stage = 'registry import'; await seed(db);
        stage = 'super admin setup'; await applySuperadminEnv(db, config);
        return db;
      } catch (e) {
        db?.close().catch(() => {});
        e.message = `[${stage}] ${e.message}`;
        throw e;
      }
    })();
    pending.catch(() => { pending = null; });
  }
  return pending;
}

/**
 * The role is stored in the database. The environment can only *grant* it to the person named in
 * SUPERADMIN_ID (an owner-only setting in the hosting dashboard) and give them a first access code
 * if they have none. Nothing a website user does can change roles.
 */
export async function applySuperadminEnv(db, config) {
  const pid = normId(config.superadminId);
  if (!pid) return;
  const hit = await db.get('SELECT person_id FROM identifiers WHERE value = ?', pid);
  if (!hit) { console.warn('SUPERADMIN_ID does not match any owner in the registry'); return; }
  const p = await db.get('SELECT id, role, code_hash FROM persons WHERE id = ?', hit.person_id);
  if (p.role !== 'superadmin') {
    await db.run("UPDATE persons SET role = 'superadmin' WHERE id = ?", p.id);
    await db.run("INSERT INTO audit_log (action, target, details) VALUES ('role_granted', ?, ?)", `person:${p.id}`, JSON.stringify({ role: 'superadmin', via: 'environment' }));
  }
  const code = normCode(config.superadminInitialCode);
  if (!p.code_hash && code.length === 8) {
    await db.run('UPDATE persons SET code_hash = ?, code_issued_at = ? WHERE id = ? AND code_hash IS NULL', hashSecret(code), new Date().toISOString(), p.id);
    await db.run("INSERT INTO audit_log (action, target, details) VALUES ('access_code_issued', ?, ?)", `person:${p.id}`, JSON.stringify({ via: 'environment' }));
  } else if (!p.code_hash && config.superadminInitialCode) {
    console.warn('SUPERADMIN_INITIAL_CODE must have 8 letters/digits, e.g. ABCD-2345');
  }
}
