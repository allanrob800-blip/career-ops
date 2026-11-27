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

test('selectForPrep keeps only Evaluated rows scored 4.0 or more, and lists no other status', () => {
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
  assert.deepEqual(r.skipped.map((s) => s.num), [2, 3], 'Applied, SKIP and unknown-status rows are not listed');
  assert.ok(r.skipped.every((s) => typeof s.reason === 'string' && s.reason));
  assert.match(r.skipped.find((s) => s.num === 2).reason, /score/);
  assert.match(r.skipped.find((s) => s.num === 3).reason, /score/);
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

test('selectForPrep treats a decorated Suspicious tier as Suspicious', () => {
  const rows = [row(1), row(2), row(3), row(4)];
  const legitimacyByReport = new Map([[1, '**Suspicious**'], [2, '⚠️ Suspicious'], [3, 'suspicious (2 signals)']]);
  const r = selectForPrep({ rows, legitimacyByReport, store: store(), max: 10 });
  assert.deepEqual(r.candidates.map(pick), [4]);
  assert.ok(r.skipped.every((x) => x.reason === 'legitimacy Suspicious'));
});

test('selectForPrep: dossiers prepared on the Paris day `today` count against max', () => {
  const rows = [row(1), row(2), row(3), row(4)];
  const prepared = (at) => ({ state: 'pret', prepared_at: at });
  const today = '2026-11-27';
  const s = store({
    10: prepared('2026-11-27T06:40:00Z'),
    11: prepared('2026-11-26T23:30:00Z'), // 00:30 on the 27th in Paris: today
    12: prepared('2026-11-26T22:30:00Z'), // 23:30 on the 26th in Paris: yesterday
    13: prepared('2026-11-26T07:50:00Z'), // yesterday
  });
  const r = selectForPrep({ rows, legitimacyByReport: new Map(), store: s, max: 3, today });
  assert.deepEqual(r.candidates.map(pick), [1]);
  assert.deepEqual(r.skipped.map((x) => x.num), [2, 3, 4]);
  assert.ok(r.skipped.every((x) => /limit/.test(x.reason)));

  const yesterday = store({ 12: prepared('2026-11-26T22:30:00Z'), 13: prepared('2026-11-26T07:50:00Z') });
  assert.equal(selectForPrep({ rows, legitimacyByReport: new Map(), store: yesterday, max: 3, today }).candidates.length, 3);

  const many = store({ 10: prepared('2026-11-27T06:40:00Z'), 11: prepared('2026-11-27T07:00:00Z'), 14: prepared('2026-11-27T08:00:00Z'), 15: prepared('2026-11-27T09:00:00Z') });
  const none = selectForPrep({ rows, legitimacyByReport: new Map(), store: many, max: 3, today });
  assert.deepEqual(none.candidates, [], 'the cap never goes below 0');
  assert.equal(none.skipped.length, 4);

  assert.equal(selectForPrep({ rows, legitimacyByReport: new Map(), store: s, max: 3 }).candidates.length, 3, 'no today: nothing counted');
});

test('selectForPrep refuses an invalid max or today', () => {
  const args = { rows: [row(1)], legitimacyByReport: new Map(), store: store() };
  assert.throws(() => selectForPrep({ ...args, max: -1 }), TypeError);
  assert.throws(() => selectForPrep({ ...args, max: 1.5 }), TypeError);
  assert.throws(() => selectForPrep({ ...args, max: '3' }), TypeError);
  assert.throws(() => selectForPrep({ ...args, today: '27/11/2026' }), TypeError);
});

test('selectForPrep: max defaults to 3', () => {
  const rows = [row(1), row(2), row(3), row(4)];
  assert.equal(selectForPrep({ rows, legitimacyByReport: new Map(), store: store() }).candidates.length, 3);
});

test('selectForPrep lists skipped rows by number', () => {
  const rows = [row(8, { score: 3 }), row(9), row(2, { status: 'Applied' }), row(4), row(5), row(6)];
  const r = selectForPrep({ rows, legitimacyByReport: new Map([[9, 'Suspicious']]), store: store(), max: 2 });
  assert.deepEqual(r.candidates.map(pick), [4, 5]);
  assert.deepEqual(r.skipped.map((x) => x.num), [6, 8, 9]);
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
  assert.deepEqual(out.skipped.map((s) => s.num), [2, 3, 4, 6], 'row 5 (Applied) is not listed');
  assert.equal(out.skipped[0].reason, 'legitimacy Suspicious');
  assert.match(out.skipped[1].reason, /ready/);
  assert.match(out.skipped[2].reason, /score/);
  assert.match(out.skipped[3].reason, /report/);
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

// Runs fn(root) on a temp copy of the fixture root.
function withRoot(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'agents-select-'));
  try {
    const root = join(dir, 'root');
    cpSync(FIXTURE_ROOT, root, { recursive: true });
    return fn(root);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const edit = (file, from, to) => {
  const before = readFileSync(file, 'utf8');
  assert.ok(before.includes(from), `fixture text not found: ${from}`);
  writeFileSync(file, before.replace(from, to));
};

test('CLI treats any Legitimacy value that mentions suspicious as Suspicious', () => {
  for (const value of ['suspicious — two signals (Block G)', '**Suspicious**', '⚠️ Suspicious', 'Likely SUSPICIOUS (2 signals)']) {
    withRoot((root) => {
      edit(join(root, 'reports', '002-brume-studio.md'), '**Legitimacy:** Suspicious', `**Legitimacy:** ${value}`);
      const out = JSON.parse(run([], root));
      assert.deepEqual(out.skipped.find((s) => s.num === 2), { num: 2, reason: 'legitimacy Suspicious' }, value);
      assert.deepEqual(out.candidates.map(pick), [1]);
    });
  }
});

test('CLI skips a row whose linked report file does not exist', () => withRoot((root) => {
  edit(join(root, 'data', 'applications.md'), '| 4.1/5 | Evaluated | ❌ | — |', '| 4.1/5 | Evaluated | ❌ | [7](reports/007-fjord-mobilite.md) |');
  const out = JSON.parse(run([], root));
  assert.deepEqual(out.skipped.find((s) => s.num === 6), { num: 6, reason: 'no evaluation report' });
  assert.deepEqual(out.candidates.map(pick), [1]);
}));

test('CLI keeps only an https:// URL from the report', () => withRoot((root) => {
  edit(join(root, 'reports', '001-altair-conseil.md'), '**URL:** https://', '**URL:** http://');
  assert.equal(JSON.parse(run([], root)).candidates[0].url, null);
}));

test('CLI with a dossier prepared today (Paris) counts it against --max', () => withRoot((root) => {
  const file = join(root, 'data', 'dossiers.json');
  const s = JSON.parse(readFileSync(file, 'utf8'));
  s.dossiers['3'].prepared_at = new Date().toISOString();
  writeFileSync(file, JSON.stringify(s));
  assert.deepEqual(JSON.parse(run(['--max', '1'], root)).candidates, []);
  assert.deepEqual(JSON.parse(run(['--max', '2'], root)).candidates.map(pick), [1]);
}));
