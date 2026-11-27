import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, cpSync, writeFileSync, readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { selectForPrep, selectLetters } from '../select-for-prep.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(HERE, 'fixtures', 'root');
const REPO = resolve(HERE, '..', '..', '..');
const CLI = 'extensions/agents/select-for-prep.mjs';

const row = (num, over = {}) => ({
  num, status: 'Evaluated', score: 4.2, company: `Entreprise ${num}`, role: `Poste ${num}`,
  url: `https://jobs.example/offres/${num}`, report_num: num, ...over,
});
const store = (dossiers = {}) => ({ schema: 1, dossiers });
const pick = (c) => c.num;

test('selectForPrep keeps only Evaluated rows scored 4.0 or more', () => {
  const rows = [
    row(1, { score: 4.0 }),
    row(2, { score: 3.9 }),
    row(3, { score: null }),
    row(4, { status: 'Applied', score: 4.8 }),
    row(5, { status: 'SKIP', score: 4.5 }),
    row(6, { status: undefined }),
  ];
  const r = selectForPrep({ rows, legitimacyByReport: new Map(), store: store(), max: 10 });
  assert.deepEqual(r.candidates.map(pick), [1]);
  assert.deepEqual(r.skipped.map((s) => s.num), [2, 3, 4, 5, 6]);
  assert.ok(r.skipped.every((s) => typeof s.reason === 'string' && s.reason));
  assert.match(r.skipped.find((s) => s.num === 2).reason, /score/);
  assert.match(r.skipped.find((s) => s.num === 3).reason, /score/);
  assert.match(r.skipped.find((s) => s.num === 4).reason, /Applied/);
});

test('selectForPrep candidate shape is {num, report_num, company, role, score, url}', () => {
  const r = selectForPrep({ rows: [row(7, { score: 4.4 })], legitimacyByReport: new Map([[7, 'High Confidence']]), store: store(), max: 3 });
  assert.deepEqual(r, {
    candidates: [{ num: 7, report_num: 7, company: 'Entreprise 7', role: 'Poste 7', score: 4.4, url: 'https://jobs.example/offres/7' }],
    skipped: [],
  });
});

test('selectForPrep excludes Suspicious legitimacy, keeps the other tiers and an unknown one', () => {
  const rows = [row(1), row(2), row(3), row(4)];
  const legitimacyByReport = new Map([[1, 'Suspicious'], [2, 'Proceed with Caution'], [3, 'High Confidence']]);
  const r = selectForPrep({ rows, legitimacyByReport, store: store(), max: 10 });
  assert.deepEqual(r.candidates.map(pick), [2, 3, 4]);
  assert.deepEqual(r.skipped, [{ num: 1, reason: 'legitimacy Suspicious' }]);
});

test('selectForPrep skips a row with no evaluation report', () => {
  const r = selectForPrep({ rows: [row(1, { report_num: null })], legitimacyByReport: new Map(), store: store(), max: 3 });
  assert.deepEqual(r.candidates, []);
  assert.deepEqual(r.skipped.map((s) => s.num), [1]);
  assert.match(r.skipped[0].reason, /report/);
});

test('selectForPrep excludes pret and a_verifier dossiers, takes a_refaire ones back', () => {
  const rows = [row(1), row(2), row(3), row(4)];
  const s = store({ 1: { state: 'pret' }, 2: { state: 'a_verifier' }, 3: { state: 'a_refaire' } });
  const r = selectForPrep({ rows, legitimacyByReport: new Map(), store: s, max: 10 });
  assert.deepEqual(r.candidates.map(pick), [3, 4]);
  assert.deepEqual(r.skipped.map((x) => x.num), [1, 2]);
  assert.match(r.skipped[0].reason, /ready|pret/);
  assert.match(r.skipped[1].reason, /review|a_verifier/);
});

test('selectForPrep sorts by score descending then number ascending, and cuts at max', () => {
  const rows = [row(5, { score: 4.2 }), row(2, { score: 4.2 }), row(9, { score: 4.9 }), row(1, { score: 4.0 }), row(3, { score: 4.5 })];
  const r = selectForPrep({ rows, legitimacyByReport: new Map(), store: store(), max: 3 });
  assert.deepEqual(r.candidates.map(pick), [9, 3, 2]);
  assert.deepEqual(r.skipped.map((x) => x.num), [1, 5]);
  assert.ok(r.skipped.every((x) => /limit/.test(x.reason)));
  const none = selectForPrep({ rows, legitimacyByReport: new Map(), store: store(), max: 0 });
  assert.deepEqual(none.candidates, []);
  assert.equal(none.skipped.length, 5);
});

test('selectForPrep: max defaults to 3', () => {
  const rows = [row(1), row(2), row(3), row(4)];
  assert.equal(selectForPrep({ rows, legitimacyByReport: new Map(), store: store() }).candidates.length, 3);
});

test('selectForPrep lists skipped rows by number', () => {
  const rows = [row(8, { score: 3 }), row(9), row(2, { status: 'Applied' }), row(4), row(5), row(6)];
  const r = selectForPrep({ rows, legitimacyByReport: new Map([[9, 'Suspicious']]), store: store(), max: 2 });
  assert.deepEqual(r.candidates.map(pick), [4, 5]);
  assert.deepEqual(r.skipped.map((x) => x.num), [2, 6, 8, 9]);
});

test('selectLetters returns dossiers whose letter is a_completer with a filled why', () => {
  const s = store({
    1: { state: 'pret', letter: { state: 'a_completer', why: 'Raison.', why_at: '2026-11-27T08:00:00Z', pdf: null } },
    2: { state: 'pret', letter: { state: 'a_completer', why: null, why_at: null, pdf: null } },
    3: { state: 'pret', letter: { state: 'prete', why: 'Raison.', why_at: '2026-11-27T08:00:00Z', pdf: 'output/l.pdf' } },
    4: { state: 'pret' },
    10: { state: 'a_refaire', letter: { state: 'a_completer', why: 'Autre raison.', why_at: '2026-11-27T08:00:00Z', pdf: null } },
    5: { state: 'pret', letter: { state: 'a_completer', why: '   ', why_at: null, pdf: null } },
  });
  assert.deepEqual(selectLetters(s), [1, 10]);
  assert.deepEqual(selectLetters(store()), []);
});

const run = (args, root = FIXTURE_ROOT) => execFileSync('node', [CLI, ...args], {
  cwd: REPO,
  env: { ...process.env, CAREER_OPS_ROOT: root, CAREER_OPS_TRACKER: '', CAREER_OPS_DATA_DIR: '' },
  stdio: ['ignore', 'pipe', 'pipe'],
}).toString();

test('CLI with CAREER_OPS_ROOT=<fixtures> prints a valid JSON selection', () => {
  const out = JSON.parse(run([]));
  assert.deepEqual(out.candidates, [{
    num: 1, report_num: 1, company: 'Altair Conseil', role: 'Chef de projet data', score: 4.6,
    url: 'https://jobs.altair-conseil.example/offres/chef-de-projet-data',
  }]);
  assert.deepEqual(out.skipped.map((s) => s.num), [2, 3, 4, 5, 6]);
  assert.equal(out.skipped[0].reason, 'legitimacy Suspicious');
  assert.match(out.skipped[1].reason, /ready/);
  assert.match(out.skipped[2].reason, /score/);
  assert.match(out.skipped[3].reason, /Applied/);
  assert.match(out.skipped[4].reason, /report/);
});

test('CLI --max 0 cuts every candidate', () => {
  const out = JSON.parse(run(['--max', '0']));
  assert.deepEqual(out.candidates, []);
  assert.match(out.skipped.find((s) => s.num === 1).reason, /limit/);
});

test('CLI --letters prints {letters:[num…]}', () => {
  assert.deepEqual(JSON.parse(run(['--letters'])), { letters: [3] });
});

test('CLI: a bad argument or a corrupt data/dossiers.json exits non-zero', () => {
  assert.throws(() => run(['--max', 'trois']), (e) => e.status === 1 && /Usage/.test(e.stderr.toString()));
  assert.throws(() => run(['--bogus']), (e) => e.status === 1);
  const dir = mkdtempSync(join(tmpdir(), 'agents-select-'));
  try {
    const root = join(dir, 'root');
    cpSync(FIXTURE_ROOT, root, { recursive: true });
    writeFileSync(join(root, 'data', 'dossiers.json'), '{"schema": 1, "dossiers": ');
    assert.throws(() => run([], root), (e) => e.status === 1 && /dossiers\.json/.test(e.stderr.toString()));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI with an empty data root prints an empty selection', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agents-select-'));
  try {
    assert.deepEqual(JSON.parse(run([], dir)), { candidates: [], skipped: [] });
    assert.deepEqual(JSON.parse(run(['--letters'], dir)), { letters: [] });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI reads the tier a decorated Legitimacy line starts with', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agents-select-'));
  try {
    const root = join(dir, 'root');
    cpSync(FIXTURE_ROOT, root, { recursive: true });
    const rep = join(root, 'reports', '002-brume-studio.md');
    writeFileSync(rep, readFileSync(rep, 'utf8').replace('**Legitimacy:** Suspicious', '**Legitimacy:** suspicious — two signals (Block G)'));
    const out = JSON.parse(run([], root));
    assert.deepEqual(out.skipped.find((s) => s.num === 2), { num: 2, reason: 'legitimacy Suspicious' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
