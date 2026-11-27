import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, mkdirSync, readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import {
  readDossiers, writeDossiers, validateDossier, normalizeText, setWhy, addRetouche,
} from '../lib/dossiers.mjs';

const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'root');

const AT = '2026-11-27T08:00:00Z';

function withTmp(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'agents-dossiers-'));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

// A complete dossier as the file contract describes it (fictional).
function dossier(over = {}) {
  return {
    state: 'pret',
    prepared_at: '2026-11-26T07:55:00Z',
    report_num: 3,
    cv: { pdf: 'output/003-cedre-energie-cv.pdf', html: 'output/003-cedre-energie-cv.html' },
    letter: { state: 'a_completer', why: null, why_at: null, pdf: null },
    message: 'Bonjour, je vous propose ma candidature.',
    answers: [{ q: 'Disponibilité ?', a: 'Sous un mois.' }],
    strategy: 'output/003-cedre-energie-strategie.json',
    check: { ok: true, reasons: [] },
    retouches: [],
    ...over,
  };
}
const storeWith = (d = dossier()) => ({ schema: 1, dossiers: { 3: d } });

test('readDossiers: absent file gives an empty store', () => withTmp((root) => {
  assert.deepEqual(readDossiers(root), { schema: 1, dossiers: {} });
}));

test('readDossiers: invalid JSON throws', () => withTmp((root) => {
  mkdirSync(join(root, 'data'));
  writeFileSync(join(root, 'data', 'dossiers.json'), '{"schema": 1, "dossiers": {');
  assert.throws(() => readDossiers(root), SyntaxError);
}));

test('readDossiers: a JSON document of another shape throws', () => withTmp((root) => {
  mkdirSync(join(root, 'data'));
  writeFileSync(join(root, 'data', 'dossiers.json'), '{"schema": 2, "dossiers": {}}');
  assert.throws(() => readDossiers(root), /schema/);
  writeFileSync(join(root, 'data', 'dossiers.json'), '[]');
  assert.throws(() => readDossiers(root), /schema/);
}));

test('readDossiers: reads the fixture store', () => {
  const store = readDossiers(FIXTURE_ROOT);
  assert.deepEqual(Object.keys(store.dossiers).sort(), ['1', '3']);
  for (const d of Object.values(store.dossiers)) assert.equal(validateDossier(d), null);
});

test('writeDossiers then readDossiers give back the same object, and no .tmp file is left', () => withTmp((root) => {
  const store = storeWith(dossier({ letter: { state: 'a_completer', why: 'Une raison « précise ».', why_at: AT, pdf: null } }));
  writeDossiers(root, store);
  assert.deepEqual(readDossiers(root), store);
  writeDossiers(root, store); // overwrite in place
  assert.deepEqual(readDossiers(root), store);
  assert.deepEqual(readdirSync(join(root, 'data')), ['dossiers.json']);
  assert.ok(readFileSync(join(root, 'data', 'dossiers.json'), 'utf8').endsWith('\n'));
}));

test('writeDossiers refuses a store of another shape and leaves nothing behind', () => withTmp((root) => {
  assert.throws(() => writeDossiers(root, { schema: 1 }), /schema/);
  assert.throws(() => writeDossiers(root, null), /schema/);
  assert.deepEqual(readdirSync(root).flatMap((d) => readdirSync(join(root, d))), []);
}));

test('normalizeText collapses whitespace, trims, and refuses empty, long or control text', () => {
  assert.equal(normalizeText('a\n\n b'), 'a b');
  assert.equal(normalizeText('  Pourquoi\tcette   entreprise ?  '), 'Pourquoi cette entreprise ?');
  assert.equal(normalizeText('a'.repeat(500)), 'a'.repeat(500));
  assert.equal(normalizeText('a'.repeat(501)), null);
  assert.equal(normalizeText(`  ${'a'.repeat(500)}  `), 'a'.repeat(500), 'edges are trimmed before the length check');
  assert.equal(normalizeText('é'.repeat(500)), 'é'.repeat(500));
  assert.equal(normalizeText(''), null);
  assert.equal(normalizeText(' \n\t '), null);
  assert.equal(normalizeText('a\u0000b'), null);
  assert.equal(normalizeText('a\u0007b'), null);
  assert.equal(normalizeText('a\u009Fb'), null);
  assert.equal(normalizeText(null), null);
  assert.equal(normalizeText(42), null);
  assert.equal(normalizeText('<img src=x onerror=alert(1)>'), '<img src=x onerror=alert(1)>', 'escaping is the display side’s job');
});

test('setWhy on an existing dossier sets letter.why and why_at without changing state', () => {
  const store = storeWith();
  assert.deepEqual(setWhy(store, 3, '  Leur mission\n me parle.  ', AT), { ok: true });
  const d = store.dossiers['3'];
  assert.equal(d.letter.why, 'Leur mission me parle.');
  assert.equal(d.letter.why_at, AT);
  assert.equal(d.letter.state, 'a_completer');
  assert.equal(d.state, 'pret');
  assert.equal(validateDossier(d), null);
});

test('setWhy accepts the number as a string key too', () => {
  const store = storeWith();
  assert.deepEqual(setWhy(store, '3', 'Raison.', AT), { ok: true });
  assert.equal(store.dossiers['3'].letter.why, 'Raison.');
});

test('setWhy / addRetouche on an unknown number: no dossier for this application', () => {
  const store = storeWith();
  const before = structuredClone(store);
  assert.deepEqual(setWhy(store, 99, 'Raison.', AT), { ok: false, reason: 'no dossier for this application' });
  assert.deepEqual(addRetouche(store, 99, 'Retouche.', AT), { ok: false, reason: 'no dossier for this application' });
  assert.deepEqual(addRetouche(store, 'abc', 'Retouche.', AT), { ok: false, reason: 'no dossier for this application' });
  assert.deepEqual(store, before);
});

test('setWhy / addRetouche refuse invalid text or date and change nothing', () => {
  const store = storeWith();
  const before = structuredClone(store);
  for (const fn of [setWhy, addRetouche]) {
    assert.equal(fn(store, 3, 'a'.repeat(501), AT).ok, false);
    assert.equal(fn(store, 3, '   ', AT).ok, false);
    assert.equal(fn(store, 3, 'a\u0000b', AT).ok, false);
    assert.equal(fn(store, 3, 'Texte.', 'hier').ok, false);
    assert.equal(fn(store, 3, 'Texte.', null).ok, false);
  }
  assert.deepEqual(store, before);
});

test('addRetouche appends {text, at, done_at:null} and sets state to a_refaire', () => {
  for (const state of ['pret', 'a_verifier', 'a_refaire']) {
    const store = storeWith(dossier({ state, retouches: [{ text: 'Ancienne.', at: '2026-11-20T10:00:00Z', done_at: '2026-11-21T07:50:00Z' }] }));
    assert.deepEqual(addRetouche(store, 3, 'Raccourcir\n\nle résumé.', AT), { ok: true });
    const d = store.dossiers['3'];
    assert.equal(d.state, 'a_refaire');
    assert.deepEqual(d.retouches, [
      { text: 'Ancienne.', at: '2026-11-20T10:00:00Z', done_at: '2026-11-21T07:50:00Z' },
      { text: 'Raccourcir le résumé.', at: AT, done_at: null },
    ]);
    assert.equal(validateDossier(d), null);
  }
});

test('validateDossier accepts the contract shape', () => {
  assert.equal(validateDossier(dossier()), null);
  assert.equal(validateDossier(dossier({ state: 'a_verifier', check: { ok: false, reasons: ['titre différent'] } })), null);
  assert.equal(validateDossier(dossier({ letter: { state: 'prete', why: 'Raison.', why_at: AT, pdf: 'output/003-lettre.pdf' } })), null);
});

test('validateDossier names the first problem', () => {
  const bad = [
    null,
    [],
    dossier({ state: 'ready' }),
    dossier({ prepared_at: 'hier' }),
    dossier({ report_num: 0 }),
    dossier({ report_num: '3' }),
    dossier({ cv: { pdf: 'output/cv.pdf' } }),
    dossier({ cv: { pdf: '/etc/passwd', html: 'output/cv.html' } }),
    dossier({ cv: { pdf: '../outside.pdf', html: 'output/cv.html' } }),
    dossier({ letter: { state: 'done', why: null, why_at: null, pdf: null } }),
    dossier({ letter: { state: 'a_completer', why: 7, why_at: null, pdf: null } }),
    dossier({ letter: { state: 'a_completer', why: null, why_at: 'hier', pdf: null } }),
    dossier({ message: 'x'.repeat(1201) }),
    dossier({ answers: [{ q: 'Q' }] }),
    dossier({ answers: {} }),
    dossier({ strategy: '' }),
    dossier({ check: { ok: 'yes', reasons: [] } }),
    dossier({ check: { ok: true, reasons: [1] } }),
    dossier({ retouches: [{ text: 'T', at: AT }] }),
    dossier({ retouches: [{ text: '', at: AT, done_at: null }] }),
    dossier({ retouches: null }),
  ];
  for (const d of bad) {
    const r = validateDossier(d);
    assert.equal(typeof r, 'string', `expected a reason for ${JSON.stringify(d)?.slice(0, 120)}`);
    assert.ok(r.length > 0);
  }
  assert.equal(validateDossier(dossier({ message: 'x'.repeat(1200) })), null);
});
