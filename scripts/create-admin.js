// Grants or removes the super-admin role directly in the database (needs DATABASE_URL).
// The role cannot be granted through the website or the API.
//   DATABASE_URL=... npm run create-admin -- --id 01020003679            grant role, print a new access code
//   DATABASE_URL=... npm run create-admin -- --id 01020003679 --revoke   remove the role
import { parseArgs } from 'node:util';
import { config } from '../src/config.js';
import { openDb, normId } from '../src/db.js';
import { seed } from '../src/seed.js';
import { generateAccessCode, normCode, hashSecret } from '../src/security.js';

const { values } = parseArgs({ options: { id: { type: 'string' }, revoke: { type: 'boolean', default: false }, 'no-code': { type: 'boolean', default: false } } });
const pid = normId(values.id);
if (!pid || !config.databaseUrl) { console.error('Usage: DATABASE_URL=... npm run create-admin -- --id <personal number> [--revoke] [--no-code]'); process.exit(1); }
const db = await openDb(config.databaseUrl);
await seed(db);
const hit = await db.get('SELECT person_id FROM identifiers WHERE value = ?', pid);
if (!hit) { console.error('No owner with this number in the registry.'); process.exit(2); }
const p = await db.get('SELECT * FROM persons WHERE id = ?', hit.person_id);
if (values.revoke) {
  await db.tx(async (t) => {
    await t.run("UPDATE persons SET role = 'member' WHERE id = ?", p.id);
    await t.run('DELETE FROM sessions WHERE person_id = ?', p.id);
    await t.run("INSERT INTO audit_log (action, target, details) VALUES ('role_revoked', ?, ?)", `person:${p.id}`, JSON.stringify({ via: 'cli' }));
  });
  console.log(`Super-admin role removed from ${p.name_en}.`);
} else {
  let code = null;
  await db.tx(async (t) => {
    await t.run("UPDATE persons SET role = 'superadmin' WHERE id = ?", p.id);
    if (!values['no-code']) {
      code = generateAccessCode();
      await t.run('UPDATE persons SET code_hash = ?, code_issued_at = ?, failed_logins = 0, locked_until = NULL WHERE id = ?', hashSecret(normCode(code)), new Date().toISOString(), p.id);
      await t.run('DELETE FROM sessions WHERE person_id = ?', p.id);
    }
    await t.run("INSERT INTO audit_log (action, target, details) VALUES ('role_granted', ?, ?)", `person:${p.id}`, JSON.stringify({ role: 'superadmin', via: 'cli' }));
  });
  console.log(`${p.name_en} is now super admin.`);
  if (code) console.log(`Access code (shown once): ${code}`);
}
await db.close();
