// Imports the Public Registry extract (No. 882026185899, 06.03.2026) and the consent document.
// Idempotent: only adds what is missing and never overwrites existing rows, roles or signatures.
// After a successful import a marker in `meta` makes later cold starts skip the work.
import { normId } from './db.js';
import { DOCUMENT_SLUG, DOCUMENT_CONTENT } from './document-content.js';
import REGISTRY from './registry.js';

const MARKER = 'seed_registry_882026185899';

// Couples registered as "A & B Surname" share one surname; restore it on the first name.
const NAME_FIX = {
  '562154664': { ka: 'როს ვაინ ფარქუჰარი', en: 'Ross Wayne Farquhar' },
  'A04551481': { ka: 'სალი ანნ დუ პრიზ', en: 'Sally Ann Du Preez' },
  '31840647': { en: 'Nachman Yitzhak Ziv' },
  '32719597': { en: 'Devorah Ziv' },
  '30435695': { en: 'Michal Ziv' },
};

export async function seed(db, { force = false } = {}) {
  const stats = { units: 0, persons: 0, links: 0, document: 0 };
  if (!force && await db.get('SELECT 1 FROM meta WHERE key = ?', MARKER)) return stats;
  return db.tx(async (t) => {
    await t.run('SELECT pg_advisory_xact_lock(7244111)');
    const units = new Map((await t.all('SELECT id, code FROM units')).map((u) => [u.code, u.id]));
    const idents = new Map((await t.all('SELECT value, person_id FROM identifiers')).map((i) => [i.value, i.person_id]));
    const links = new Set((await t.all('SELECT unit_id, person_id FROM unit_owners')).map((l) => l.unit_id + ':' + l.person_id));

    for (const u of REGISTRY) {
      let unitId = units.get(u.code);
      if (!unitId) {
        unitId = (await t.get('INSERT INTO units (num, code, type, label, floor, area) VALUES (?, ?, ?, ?, ?, ?) RETURNING id', u.num, u.code, u.type, u.label, u.floor, u.area)).id;
        units.set(u.code, unitId); stats.units++;
      }
      for (const o of u.owners) {
        const values = o.ids.map((i) => ({ kind: i.kind, value: normId(i.value) })).filter((i) => i.value);
        let personId = values.map((v) => idents.get(v.value)).find((x) => x != null) ?? null;
        if (personId == null) {
          const fix = values.map((v) => NAME_FIX[v.value]).find(Boolean) || {};
          personId = (await t.get('INSERT INTO persons (kind, name_ka, name_en) VALUES (?, ?, ?) RETURNING id', o.type, fix.ka || o.name_ka, fix.en || o.name_en)).id;
          stats.persons++;
        }
        for (const v of values) if (!idents.has(v.value)) { await t.run('INSERT INTO identifiers (value, kind, person_id) VALUES (?, ?, ?) ON CONFLICT DO NOTHING', v.value, v.kind, personId); idents.set(v.value, personId); }
        const key = unitId + ':' + personId;
        if (!links.has(key)) { await t.run('INSERT INTO unit_owners (unit_id, person_id) VALUES (?, ?) ON CONFLICT DO NOTHING', unitId, personId); links.add(key); stats.links++; }
      }
    }
    if (!await t.get('SELECT id FROM documents WHERE slug = ?', DOCUMENT_SLUG)) {
      await t.run('INSERT INTO documents (slug, content) VALUES (?, ?)', DOCUMENT_SLUG, JSON.stringify(DOCUMENT_CONTENT));
      stats.document = 1;
    }
    await t.run('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO NOTHING', MARKER, new Date().toISOString());
    return stats;
  });
}
