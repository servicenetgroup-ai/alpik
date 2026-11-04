import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import { DOCUMENT_CONTENT } from '../src/document-content.js';

const ctx = { window: {} };
vm.runInNewContext(fs.readFileSync(new URL('../public/i18n.js', import.meta.url), 'utf8'), ctx);
const I18N = ctx.window.I18N;
const app = fs.readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');
const api = fs.readFileSync(new URL('../src/app.js', import.meta.url), 'utf8');

test('all three languages have exactly the same keys and no empty values', () => {
  const ka = Object.keys(I18N.ka).sort();
  for (const l of ['en', 'ru']) assert.deepEqual(Object.keys(I18N[l]).sort(), ka, l);
  for (const l of ['ka', 'en', 'ru']) for (const [k, v] of Object.entries(I18N[l])) assert.ok(String(v).trim(), `${l}.${k}`);
});

test('placeholders match across languages', () => {
  const ph = (s) => (s.match(/\{\w+\}/g) || []).sort().join();
  for (const k of Object.keys(I18N.ka)) for (const l of ['en', 'ru']) assert.equal(ph(I18N[l][k]), ph(I18N.ka[k]), `${l}.${k}`);
});

test('every literal key used by the interface exists', () => {
  const keys = [...app.matchAll(/\bt\('([a-zA-Z.]+[a-zA-Z])'/g)].map((m) => m[1]);
  assert.ok(keys.length > 100);
  for (const k of new Set(keys)) assert.ok(k in I18N.ka, k);
});

test('every dynamic key family is complete', () => {
  const fam = {
    'unit.': ['apartment', 'auxiliary', 'commercial', 'parking'],
    'status.': ['signed', 'partial', 'unsigned', 'nocode', 'all', 'revoked'],
  };
  for (const [p, list] of Object.entries(fam)) for (const x of list) assert.ok(p + x in I18N.ka, p + x);
  const actions = new Set([...api.matchAll(/audit\([^,]+,\s*(?:[^']*\?\s*)?'(\w+)'(?:\s*:\s*'(\w+)')?/g)].flatMap((m) => [m[1], m[2]]).filter(Boolean));
  for (const a of ['role_granted', 'role_revoked']) actions.add(a);
  for (const a of actions) assert.ok('audit.' + a in I18N.ka, 'audit.' + a);
  const codes = new Set([...api.matchAll(/HttpError\(\d+, '(\w+)'/g)].map((m) => m[1]));
  for (const c of codes) if (!['bad_json', 'csrf', 'nothing_to_update', 'invalid_language'].includes(c)) assert.ok('err.' + c in I18N.ka, 'err.' + c);
});

test('no untranslated Georgian or Russian text is hard-coded in the interface code', () => {
  const stripped = app.replace(/'ქარ'|'РУС'/g, '');
  assert.equal(/[Ⴀ-ჿЀ-ӿ]/.test(stripped), false);
});

test('the signed document exists in all three languages with the same structure', () => {
  const shape = (c) => c.sections.map((s) => [s.tone, s.items.length, s.demands?.items.length ?? 0, !!s.intro]);
  for (const l of ['en', 'ru']) assert.deepEqual(shape(DOCUMENT_CONTENT[l]), shape(DOCUMENT_CONTENT.ka), l);
});
