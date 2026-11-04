// Imports the Public Registry extract (No. 882026185899, 06.03.2026) and the consent document.
// Idempotent: only adds what is missing and never overwrites existing rows, roles or signatures.
import fs from 'node:fs';
import { tx, normId } from './db.js';
import { DOCUMENT_SLUG, DOCUMENT_CONTENT } from './document-content.js';

const REGISTRY = JSON.parse(fs.readFileSync(new URL('./registry.json', import.meta.url), 'utf8'));

// Couples registered as "A & B Surname" share one surname; restore it on the first name.
const NAME_FIX = {
  '562154664': { ka: 'როს ვაინ ფარქუჰარი', en: 'Ross Wayne Farquhar' },
  'A04551481': { ka: 'სალი ანნ დუ პრიზ', en: 'Sally Ann Du Preez' },
  '31840647': { en: 'Nachman Yitzhak Ziv' },
  '32719597': { en: 'Devorah Ziv' },
  '30435695': { en: 'Michal Ziv' },
};

export function seed(db) {
  return tx(db, () => {
    const stats = { units: 0, persons: 0, links: 0, document: 0 };
    const findId = db.prepare('SELECT person_id FROM identifiers WHERE value = ?');
    const addPerson = db.prepare('INSERT INTO persons (kind, name_ka, name_en) VALUES (?, ?, ?)');
    const addIdent = db.prepare('INSERT OR IGNORE INTO identifiers (value, kind, person_id) VALUES (?, ?, ?)');
    const findUnit = db.prepare('SELECT id FROM units WHERE code = ?');
    const addUnit = db.prepare('INSERT INTO units (num, code, type, label, floor, area) VALUES (?, ?, ?, ?, ?, ?)');
    const link = db.prepare('INSERT OR IGNORE INTO unit_owners (unit_id, person_id) VALUES (?, ?)');

    for (const u of REGISTRY) {
      let unit = findUnit.get(u.code);
      if (!unit) { addUnit.run(u.num, u.code, u.type, u.label, u.floor, u.area); unit = findUnit.get(u.code); stats.units++; }
      for (const o of u.owners) {
        const values = o.ids.map(i => ({ kind: i.kind, value: normId(i.value) })).filter(i => i.value);
        let personId = null;
        for (const i of values) { const hit = findId.get(i.value); if (hit) { personId = hit.person_id; break; } }
        if (personId == null) {
          const fix = values.map(v => NAME_FIX[v.value]).find(Boolean) || {};
          const r = addPerson.run(o.type, fix.ka || o.name_ka, fix.en || o.name_en);
          personId = Number(r.lastInsertRowid); stats.persons++;
        }
        for (const i of values) addIdent.run(i.value, i.kind, personId);
        if (link.run(unit.id, personId).changes) stats.links++;
      }
    }
    const doc = db.prepare('SELECT id FROM documents WHERE slug = ?').get(DOCUMENT_SLUG);
    if (!doc) { db.prepare('INSERT INTO documents (slug, content) VALUES (?, ?)').run(DOCUMENT_SLUG, JSON.stringify(DOCUMENT_CONTENT)); stats.document = 1; }
    return stats;
  });
}
