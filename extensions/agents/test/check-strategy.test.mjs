import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { validateSheet, checkStrategy, visibleText } from '../check-strategy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const CV_PATH = join(HERE, 'fixtures', 'cv-sample.html');
const CV = readFileSync(CV_PATH, 'utf8');
const CLI = 'extensions/agents/check-strategy.mjs';

// The fixture's .header-title is « Cheffe de projet   Transformation numérique ».
const sheet = (over = {}) => ({
  titre_cv: 'cheffe de projet transformation numérique',
  angle: 'Une cheffe de projet qui fait passer les équipes des processus papier aux outils partagés.',
  lettre_angle: 'Le portail interne comme preuve de méthode.',
  preuves: [
    { texte: 'Déploiement d\'un outil de gestion des connaissances', source: 'cv.md › expérience la plus récente' },
    { texte: 'Méthodes agiles', source: 'config/profile.yml' },
  ],
  mots_cles_repris: ['Conduite du changement', 'méthodes agiles', 'Power BI', 'gestion des connaissances'],
  mots_cles_ecartes: [{ mot: 'SAP', raison: 'aucune expérience correspondante dans cv.md' }],
  ecarts: [{ exigence: 'Anglais courant', traitement: 'non abordée' }],
  ...over,
});

test('checkStrategy is ok when the title matches .header-title up to case and spaces, and every keyword is in the CV', () => {
  assert.deepEqual(checkStrategy(sheet(), CV), { ok: true, reasons: [] });
  assert.equal(checkStrategy(sheet({ titre_cv: '  CHEFFE DE PROJET Transformation   numérique ' }), CV).ok, true);
});

test('checkStrategy names a different title, with both titles', () => {
  const r = checkStrategy(sheet({ titre_cv: 'Cheffe de projet data' }), CV);
  assert.equal(r.ok, false);
  assert.equal(r.reasons.length, 1);
  assert.match(r.reasons[0], /Cheffe de projet data/);
  assert.match(r.reasons[0], /Cheffe de projet Transformation numérique/);
});

test('checkStrategy keeps accents significant in the title', () => {
  assert.equal(checkStrategy(sheet({ titre_cv: 'Cheffe de projet transformation numerique' }), CV).ok, false);
});

test('checkStrategy names each keyword absent from the CV', () => {
  const r = checkStrategy(sheet({ mots_cles_repris: ['Power BI', 'SAP S/4HANA', 'Kubernetes'] }), CV);
  assert.equal(r.ok, false);
  assert.equal(r.reasons.length, 2);
  assert.match(r.reasons[0], /SAP S\/4HANA/);
  assert.match(r.reasons[1], /Kubernetes/);
});

test('checkStrategy matches keywords regardless of case and accents', () => {
  const r = checkStrategy(sheet({ mots_cles_repris: ['METHODES AGILES', 'competences cles', 'Université exemple', 'randonnee'] }), CV);
  assert.deepEqual(r, { ok: true, reasons: [] });
});

test('checkStrategy matches whole words only', () => {
  const r = checkStrategy(sheet({ mots_cles_repris: ['agile', 'Power B'] }), CV);
  assert.equal(r.ok, false);
  assert.equal(r.reasons.length, 2);
});

test('checkStrategy reads text without tags: markup, attributes, styles, scripts and comments are not CV text', () => {
  // Inline markup inside a field does not split it.
  const marked = CV
    .replace('Conduite du changement', 'Conduite du <strong>changement</strong>')
    .replace('<div class="header-title">Cheffe de projet   Transformation numérique</div>',
      '<div class="header-title">Cheffe de projet <span class="x">Transformation</span> numérique</div>');
  assert.deepEqual(checkStrategy(sheet(), marked), { ok: true, reasons: [] });
  // Words only found in tag names, attributes, CSS or HTML comments are absent.
  const withScript = CV.replace('</body>', '<script>const cache = "Kubernetes";</script></body>');
  const r = checkStrategy(sheet({ mots_cles_repris: ['competency-tag', 'mailto', 'margin', 'work experience', 'strong', 'Kubernetes'] }), withScript);
  assert.equal(r.ok, false);
  assert.equal(r.reasons.length, 6);
});

test('checkStrategy decodes entities and ignores ** bold markers', () => {
  const r = checkStrategy(sheet({
    mots_cles_repris: ['outils & méthodes agiles', 'd\'un outil', 'Power BI', 'recueil des besoins & recette',
      'd\'un portail', 'pilotage de programmes', 'centres d\'intérêt'],
  }), CV);
  assert.deepEqual(r, { ok: true, reasons: [] });
  const bold = CV.replace('>Cheffe de projet   Transformation numérique<', '>**Cheffe de projet** Transformation numérique<');
  assert.equal(checkStrategy(sheet(), bold).ok, true);
  assert.doesNotMatch(visibleText(CV), /\*\*/);
});

test('checkStrategy fails when the CV has no .header-title', () => {
  const r = checkStrategy(sheet(), CV.replace(/<div class="header-title">[^<]*<\/div>/, ''));
  assert.equal(r.ok, false);
  assert.match(r.reasons[0], /header-title/);
});

test('checkStrategy fails on a sheet with no title or no keyword list', () => {
  const r = checkStrategy({ angle: 'x' }, CV);
  assert.equal(r.ok, false);
  assert.equal(r.reasons.length, 2);
});

test('visibleText drops style, script, comments and tags', () => {
  const t = visibleText('<!DOCTYPE html><html><head><style>.a{color:red}</style></head><body><!-- note --><p>Un&nbsp;<b>deux</b></p><script>x()</script><p>trois</p></body></html>');
  assert.equal(t, 'Un deux trois');
});

test('validateSheet returns a bounded copy: strings of 600 characters at most, arrays of 12 items at most', () => {
  const long = 'é'.repeat(700);
  const input = sheet({ angle: long, mots_cles_repris: Array.from({ length: 20 }, (_, i) => `mot ${i}`) });
  const { sheet: out, errors } = validateSheet(input);
  assert.deepEqual(errors, []);
  assert.equal([...out.angle].length, 600);
  assert.equal(out.mots_cles_repris.length, 12);
  assert.equal(input.angle, long, 'the input is not changed');
  assert.equal(input.mots_cles_repris.length, 20);
  const nested = validateSheet(sheet({ preuves: Array.from({ length: 15 }, () => ({ texte: long, source: 'cv.md' })) })).sheet;
  assert.equal(nested.preuves.length, 12);
  assert.equal([...nested.preuves[0].texte].length, 600);
});

test('validateSheet keeps a valid sheet whole', () => {
  const { sheet: out, errors } = validateSheet(sheet({ verification: { ok: true, reasons: [] } }));
  assert.deepEqual(errors, []);
  assert.deepEqual(out, sheet({ verification: { ok: true, reasons: [] } }));
});

test('validateSheet accepts a sheet written before the letter: lettre_angle absent, null or blank is null', () => {
  const { lettre_angle: _omit, ...noLetter } = sheet();
  for (const input of [noLetter, sheet({ lettre_angle: null }), sheet({ lettre_angle: '' }), sheet({ lettre_angle: '   ' })]) {
    const { sheet: out, errors } = validateSheet(input);
    assert.deepEqual(errors, [], JSON.stringify(input.lettre_angle));
    assert.equal(out.lettre_angle, null);
  }
  const long = validateSheet(sheet({ lettre_angle: 'x'.repeat(700) })).sheet.lettre_angle;
  assert.equal([...long].length, 600, 'bounded when present');
  assert.match(validateSheet(sheet({ lettre_angle: 3 })).errors[0], /lettre_angle/);
});

test('validateSheet refuses a proof source outside cv.md, article-digest.md, config/profile.yml, modes/_profile.md', () => {
  const ok = ['cv.md', 'cv.md › expérience la plus récente', 'article-digest.md#projet', 'config/profile.yml',
    'modes/_profile.md › Archétypes'];
  for (const source of ok) assert.deepEqual(validateSheet(sheet({ preuves: [{ texte: 't', source }] })).errors, [], source);
  const bad = ['interview-prep/story-bank.md', 'documents/cv.md', 'cv.mdx', 'cv.md.bak', 'modes/_profile.mdx', '', 'CV.md'];
  for (const source of bad) {
    const { sheet: out, errors } = validateSheet(sheet({ preuves: [{ texte: 'ok', source: 'cv.md' }, { texte: 't', source }] }));
    assert.equal(errors.length, 1, source);
    assert.match(errors[0], /preuves\[1\]/);
    assert.deepEqual(out.preuves, [{ texte: 'ok', source: 'cv.md' }], 'the bad proof is dropped');
  }
});

test('validateSheet reports a missing or mistyped field', () => {
  assert.ok(validateSheet(null).errors.length > 0);
  assert.ok(validateSheet([]).errors.length > 0);
  const { errors } = validateSheet({ angle: 3, preuves: 'x', mots_cles_repris: [1, 'ok'], ecarts: [{ exigence: 'a' }] });
  assert.ok(errors.some((e) => /titre_cv/.test(e)));
  assert.ok(errors.some((e) => /angle/.test(e)));
  assert.ok(errors.some((e) => /preuves/.test(e)));
  assert.ok(errors.some((e) => /mots_cles_repris\[0\]/.test(e)));
  assert.ok(errors.some((e) => /ecarts\[0\]/.test(e)));
});

// ── CLI ──────────────────────────────────────────────────────────────────────

function runCli(args, root) {
  try {
    const stdout = execFileSync('node', [CLI, ...args], {
      cwd: REPO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, CAREER_OPS_ROOT: root },
    });
    return { code: 0, stdout };
  } catch (e) {
    return { code: e.status, stdout: e.stdout, stderr: e.stderr };
  }
}

function tempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), 'agents-strategy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'output'));
  writeFileSync(join(root, 'output', '003-exemple-cv.html'), CV);
  return root;
}

test('CLI prints {ok, reasons} and exits 0 when the sheet matches; paths are relative to the data root', (t) => {
  const root = tempRoot(t);
  writeFileSync(join(root, 'output', '003-exemple-strategie.json'), JSON.stringify(sheet()));
  const r = runCli(['--sheet', 'output/003-exemple-strategie.json', '--cv-html', 'output/003-exemple-cv.html'], root);
  assert.equal(r.code, 0, r.stderr);
  assert.deepEqual(JSON.parse(r.stdout), { ok: true, reasons: [] });
});

test('CLI exits 1 with the reasons when the check fails, sheet errors included', (t) => {
  const root = tempRoot(t);
  const file = join(root, 'output', '003-exemple-strategie.json');
  writeFileSync(file, JSON.stringify(sheet({
    titre_cv: 'Autre titre', preuves: [{ texte: 't', source: 'interview-prep/story-bank.md' }],
  })));
  const r = runCli(['--sheet', file, '--cv-html', CV_PATH], root);
  assert.equal(r.code, 1);
  const out = JSON.parse(r.stdout);
  assert.equal(out.ok, false);
  assert.equal(out.reasons.length, 2);
  assert.ok(out.reasons.some((x) => /preuves\[0\]/.test(x)));
  assert.ok(out.reasons.some((x) => /Autre titre/.test(x)));
});

test('CLI exits 1 on missing arguments or an unreadable file', (t) => {
  const root = tempRoot(t);
  assert.equal(runCli(['--sheet', 'output/x.json'], root).code, 1);
  const r = runCli(['--sheet', 'output/absent.json', '--cv-html', 'output/003-exemple-cv.html'], root);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /absent\.json/);
  writeFileSync(join(root, 'output', 'bad.json'), '{not json');
  assert.equal(runCli(['--sheet', 'output/bad.json', '--cv-html', 'output/003-exemple-cv.html'], root).code, 1);
});
