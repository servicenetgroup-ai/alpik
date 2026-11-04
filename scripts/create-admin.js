// Grants or removes the super-admin role. Needs shell access to the server: the role
// cannot be granted through the website or the API.
//   npm run create-admin -- --id 01020003679            grant role and print a new access code
//   npm run create-admin -- --id 01020003679 --revoke   remove the role
import { parseArgs } from 'node:util';
import { config } from '../src/config.js';
import { openDb, normId, tx } from '../src/db.js';
import { seed } from '../src/seed.js';
import { generateAccessCode, normCode, hashSecret } from '../src/security.js';

const { values } = parseArgs({ options: { id: { type: 'string' }, revoke: { type: 'boolean', default: false }, 'no-code': { type: 'boolean', default: false } } });
const pid = normId(values.id);
if (!pid) { console.error('Usage: npm run create-admin -- --id <personal number> [--revoke] [--no-code]'); process.exit(1); }
const db = openDb(config.dbPath);
seed(db);
const hit = db.prepare('SELECT person_id FROM identifiers WHERE value = ?').get(pid);
if (!hit) { console.error('No member with this personal number in the registry.'); process.exit(2); }
const p = db.prepare('SELECT * FROM persons WHERE id = ?').get(hit.person_id);
if (values.revoke) {
  tx(db, () => {
    db.prepare("UPDATE persons SET role = 'member' WHERE id = ?").run(p.id);
    db.prepare('DELETE FROM sessions WHERE person_id = ?').run(p.id);
    db.prepare("INSERT INTO audit_log (action, target, details) VALUES ('role_revoked', ?, ?)").run(`person:${p.id}`, JSON.stringify({ via: 'cli' }));
  });
  console.log(`Super-admin role removed from ${p.name_en}.`);
} else {
  let code = null;
  tx(db, () => {
    db.prepare("UPDATE persons SET role = 'superadmin' WHERE id = ?").run(p.id);
    if (!values['no-code']) {
      code = generateAccessCode();
      db.prepare('UPDATE persons SET code_hash = ?, code_issued_at = ?, failed_logins = 0, locked_until = NULL WHERE id = ?').run(hashSecret(normCode(code)), new Date().toISOString(), p.id);
      db.prepare('DELETE FROM sessions WHERE person_id = ?').run(p.id);
    }
    db.prepare("INSERT INTO audit_log (action, target, details) VALUES ('role_granted', ?, ?)").run(`person:${p.id}`, JSON.stringify({ role: 'superadmin', via: 'cli' }));
  });
  console.log(`${p.name_en} is now super admin.`);
  if (code) console.log(`Access code (shown once): ${code}`);
}
db.close();
