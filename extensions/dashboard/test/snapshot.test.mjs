import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot, loadMatch, parseCvAssets } from '../lib/snapshot.mjs';
import { loadFixtureInput } from './helpers.mjs';

const STATES = ['Evaluated', 'Speculative', 'Applied', 'Responded', 'Assessment', 'Interview', 'Offer', 'Hired', 'Rejected', 'Discarded', 'SKIP'];
const NOW = new Date('2026-11-27T10:00:00Z');

test('buildSnapshot on fixtures', () => {
  const s = buildSnapshot(loadFixtureInput(NOW));
  assert.equal(s.schema, 1);
  assert.equal(s.generation, NOW.toISOString());
  assert.equal(s.apps.length, 8);
  assert.equal(s.profile.first_name, 'Camille');
  assert.ok(s.apps.every((a) => STATES.includes(a.status)));
  assert.equal(s.offers.length, 3);
  assert.equal(s.timeline.length, 180);
  assert.ok(s.companies.find((c) => c.norm === 'acme'));
  assert.equal(s.apps.find((a) => a.num === 3).applied_on, '2026-11-24');
});

test('fixture facts used by later tasks', () => {
  const s = buildSnapshot(loadFixtureInput(NOW));
  const week = s.apps.filter((a) => a.applied_on >= '2026-11-23' && a.applied_on <= '2026-11-29');
  assert.equal(week.length, 3);
  assert.equal(s.apps.find((a) => a.num === 1).url, 'https://jobs.acme.fr/offres/product-manager-42');
  assert.equal(s.apps.find((a) => a.num === 1).report_num, 1);
  assert.ok(s.apps.some((a) => a.company === '<img src=x onerror=alert(1)>'));
  assert.deepEqual(s.offers.map((o) => o.company), [null, 'Société', 'Evil Corp']);
  assert.equal(s.offers[2].url, 'javascript:alert(1)');
  assert.ok(s.companies.find((c) => c.norm === 'acme').domains.includes('acme.fr'));
  assert.ok(s.followups_due.length >= 1);
  assert.ok(s.followups_due.every((f) => ['overdue', 'urgent'].includes(f.urgency)));
  assert.ok(s.followups_due.find((f) => f.num === 2 && f.urgency === 'overdue'));
  assert.equal(s.timeline.at(-1).date, '2026-11-27');
  assert.equal(s.reports[0].score, 4.2);
});

test('urgency depends on input.now, not the wall clock', () => {
  const early = buildSnapshot(loadFixtureInput(new Date('2026-11-12T10:00:00Z')));
  assert.equal(early.followups_due.find((f) => f.num === 2), undefined);
});

test('buildSnapshot on empty inputs', () => {
  const s = buildSnapshot({ trackerContent: '', statusLogContent: '', followupsContent: '',
    pipelineContent: '', reports: [], profileYaml: '', now: NOW });
  assert.deepEqual([s.apps, s.offers, s.followups_due, s.reports], [[], [], [], []]);
  assert.equal(s.profile.first_name, null);
  assert.equal(s.timeline.length, 180);
});

test('loadMatch returns CapMatch', () => {
  assert.equal(loadMatch().normalizeCompany('Cobalt SAS'), 'cobalt');
});

test('applied_on falls back to the row date when no status-log entry exists', () => {
  const s = buildSnapshot(loadFixtureInput(NOW));
  assert.equal(s.apps.find((a) => a.num === 4).applied_on, '2026-11-25');
});

test('rows with a non-canonical status are dropped', () => {
  const input = loadFixtureInput(NOW);
  input.trackerContent += '| 9 | 2026-11-26 | Weird Co | Role | 3.0/5 | Bogusstate | ❌ | — | x |\n';
  const s = buildSnapshot(input);
  assert.equal(s.apps.find((a) => a.num === 9), undefined);
  assert.equal(s.apps.length, 8);
  assert.ok(s.apps.every((a) => STATES.includes(a.status)));
});

// ---- I4: domain watches never target a job board ----
const TRACKER_URL = (rows) => `# Applications Tracker

| # | Date | Company | Role | Score | Status | PDF | Report | Notes | URL |
|---|------|---------|------|-------|--------|-----|--------|-------|-----|
${rows.map((r, i) => `| ${i + 1} | 2026-11-20 | ${r[0]} | Role | 4.0/5 | Applied | ❌ | — | Fictional | ${r[1]} |`).join('\n')}
`;

test('company domains: aggregators, the extended job-board list and shared domains are dropped', () => {
  const input = { trackerContent: TRACKER_URL([
    ['Hotel Exemple', 'https://www.apec.fr/candidat/offre/123'],
    ['Iris Exemple', 'https://iris.wd3.myworkdayjobs.com/fr/job/42'],
    ['Juno Exemple', 'https://jobs.welcomekit.co/juno/x'],
    ['Kilo Exemple', 'https://www.simplyhired.com/job/abc'],
    ['Lima Exemple', 'https://www.glassdoor.fr/job-listing/x'],
    ['Mike Exemple', 'https://careers.groupe-commun.test/offre/1'],
    ['November Exemple', 'https://jobs.groupe-commun.test/offre/2'],
    ['Oscar Exemple', 'https://careers.oscar-exemple.test/role/7'],
  ]), statusLogContent: '', followupsContent: '', pipelineContent: '', reports: [], profileYaml: '', now: NOW };
  const s = buildSnapshot(input);
  const doms = Object.fromEntries(s.companies.map((c) => [c.name, c.domains]));
  assert.deepEqual(doms['Hotel Exemple'], []);
  assert.deepEqual(doms['Iris Exemple'], []);
  assert.deepEqual(doms['Juno Exemple'], []);
  assert.deepEqual(doms['Kilo Exemple'], []); // career-ops' own aggregator list (url-key.mjs)
  assert.deepEqual(doms['Lima Exemple'], []);
  assert.deepEqual(doms['Mike Exemple'], []); // one domain for two companies: neither gets it
  assert.deepEqual(doms['November Exemple'], []);
  assert.deepEqual(doms['Oscar Exemple'], ['oscar-exemple.test']);
});

test('the fixture keeps its own employer domain', () => {
  const s = buildSnapshot(loadFixtureInput(NOW));
  assert.deepEqual(s.companies.find((c) => c.norm === 'acme').domains, ['acme.fr']);
});

// ---- M1: a report linked only from Notes still attaches to its row ----
test('a report linked only from the Notes cell attaches to its row', () => {
  const input = loadFixtureInput(NOW);
  input.trackerContent = input.trackerContent.replace(
    '| 1 | 2026-11-20 | Acme | Product Manager | 4.2/5 | Evaluated | ✅ | [1](reports/001-acme-pm.md) | Fictional fixture |',
    '| 1 | 2026-11-20 | Acme | Product Manager | 4.2/5 | Evaluated | ✅ | — | Fictional fixture, see [1](reports/001-acme-pm.md) |');
  assert.match(input.trackerContent, /see \[1\]/);
  const a = buildSnapshot(input).apps.find((x) => x.num === 1);
  assert.equal(a.report_num, 1);
  assert.equal(a.url, 'https://jobs.acme.fr/offres/product-manager-42');
});

// ---- CV links: data/dashboard.json -> cv_assets["<num>"] -> cv_url /_blob/<asset_id>, cv_stale from export's hashes ----
const ID = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
const SHA = 'aa'.repeat(32);
const dash = (assets) => JSON.stringify({ slug: 'fictional-slug', cv_assets: assets });
const appOf = (input, num) => buildSnapshot(input).apps.find((a) => a.num === num);

test('cv_url: a valid asset_id for the app num gives /_blob/<id>; other apps get null', () => {
  const input = loadFixtureInput(NOW);
  input.dashboardJson = dash({ 3: { asset_id: ID, file: 'output/cv-cobalt.pdf', sha256: SHA } });
  const s = buildSnapshot(input);
  assert.equal(s.apps.find((a) => a.num === 3).cv_url, `/_blob/${ID}`);
  assert.ok(s.apps.filter((a) => a.num !== 3).every((a) => a.cv_url === null && a.cv_stale === null));
});

test('cv_url: an asset_id outside [A-Za-z0-9_-]{8,128} is never linked', () => {
  for (const bad of ['short', '../../etc', 'javascript:alert(1)', 'https://evil.example/x.pdf', 'a'.repeat(129), 'abcdefgh/..', 'abc def ghi', 12345678, null, '']) {
    const input = loadFixtureInput(NOW);
    input.dashboardJson = dash({ 3: { asset_id: bad, file: 'output/cv.pdf', sha256: SHA } });
    input.cvFileHashes = { 'output/cv.pdf': 'bb'.repeat(32) };
    const a = appOf(input, 3);
    assert.equal(a.cv_url, null, String(bad));
    assert.equal(a.cv_stale, null, String(bad));
  }
  const ok = loadFixtureInput(NOW);
  ok.dashboardJson = dash({ 3: { asset_id: 'Ab_-0123', file: 'x', sha256: SHA } });
  assert.equal(appOf(ok, 3).cv_url, '/_blob/Ab_-0123');
});

test('cv_url: absent, malformed or oddly shaped dashboard.json leaves every cv_url null, no throw', () => {
  for (const json of [undefined, '', '{not json', 'null', '[]', '"x"', '{"slug":"s"}', '{"cv_assets":[]}', '{"cv_assets":{"3":"x"}}', '{"cv_assets":{"3":null}}']) {
    const input = loadFixtureInput(NOW);
    if (json !== undefined) input.dashboardJson = json;
    const s = buildSnapshot(input);
    assert.equal(s.apps.length, 8, String(json));
    assert.ok(s.apps.every((a) => a.cv_url === null && a.cv_stale === null), String(json));
  }
});

test('cv_stale: true when the file hash differs, false when it matches, null when the file was not hashed', () => {
  const input = loadFixtureInput(NOW);
  input.dashboardJson = dash({
    1: { asset_id: ID, file: 'output/a.pdf', sha256: SHA },
    3: { asset_id: ID, file: 'output/c.pdf', sha256: SHA.toUpperCase() },
    4: { asset_id: ID, file: 'output/d.pdf', sha256: SHA },
  });
  input.cvFileHashes = { 'output/a.pdf': 'bb'.repeat(32), 'output/c.pdf': SHA };
  const s = buildSnapshot(input);
  const by = (n) => s.apps.find((a) => a.num === n);
  assert.equal(by(1).cv_stale, true);
  assert.equal(by(3).cv_stale, false);
  assert.equal(by(4).cv_stale, null);
  assert.equal(by(4).cv_url, `/_blob/${ID}`);
});

test('parseCvAssets: keeps only well-formed entries keyed by tracker num', () => {
  assert.deepEqual(parseCvAssets('{bad'), {});
  assert.deepEqual(parseCvAssets(undefined), {});
  const got = parseCvAssets(dash({ 3: { asset_id: ID, file: 'output/c.pdf', sha256: SHA }, x: { asset_id: ID }, 4: 'nope' }));
  assert.deepEqual(Object.keys(got), ['3']);
  assert.equal(got['3'].file, 'output/c.pdf');
});

// ---- CV pages: cv_assets["<num>"].pages = [<asset id>, …] -> cv_pages ['/_blob/<id>', …] (PNG renders of the PDF) ----
const P1 = 'p1aaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const P2 = 'p2bbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

test('cv_pages: valid page ids become /_blob/<id> in order; other apps get []', () => {
  const input = loadFixtureInput(NOW);
  input.dashboardJson = dash({ 3: { asset_id: ID, file: 'output/c.pdf', sha256: SHA, pages: [P1, P2] } });
  const s = buildSnapshot(input);
  assert.deepEqual(s.apps.find((a) => a.num === 3).cv_pages, [`/_blob/${P1}`, `/_blob/${P2}`]);
  assert.ok(s.apps.filter((a) => a.num !== 3).every((a) => Array.isArray(a.cv_pages) && a.cv_pages.length === 0));
});

test('cv_pages: an invalid page id is dropped, the valid ones kept; at most 6 pages', () => {
  const input = loadFixtureInput(NOW);
  input.dashboardJson = dash({
    3: { asset_id: ID, pages: [P1, 'javascript:alert(1)', '../../etc/passwd', 'short', 'https://evil.example/x.png', 42, null, { id: P2 }, 'a'.repeat(129), P2] },
    4: { asset_id: ID, pages: Array.from({ length: 9 }, (_, i) => `page${i}xxxxxxxxxxxxxxxx`) },
  });
  const s = buildSnapshot(input);
  assert.deepEqual(s.apps.find((a) => a.num === 3).cv_pages, [`/_blob/${P1}`, `/_blob/${P2}`]);
  assert.deepEqual(s.apps.find((a) => a.num === 4).cv_pages, Array.from({ length: 6 }, (_, i) => `/_blob/page${i}xxxxxxxxxxxxxxxx`));
});

test('cv_pages: missing or not an array -> []; cv_url and cv_stale unchanged', () => {
  for (const pages of [undefined, null, 'x', P1, {}, { 0: P1 }, []]) {
    const input = loadFixtureInput(NOW);
    input.dashboardJson = dash({ 3: { asset_id: ID, file: 'output/c.pdf', sha256: SHA, ...(pages === undefined ? {} : { pages }) } });
    input.cvFileHashes = { 'output/c.pdf': 'bb'.repeat(32) };
    const a = appOf(input, 3);
    assert.deepEqual(a.cv_pages, [], String(pages));
    assert.equal(a.cv_url, `/_blob/${ID}`);
    assert.equal(a.cv_stale, true);
  }
  for (const json of [undefined, '{not json', '{"cv_assets":{"3":null}}']) {
    const input = loadFixtureInput(NOW);
    if (json !== undefined) input.dashboardJson = json;
    assert.ok(buildSnapshot(input).apps.every((a) => Array.isArray(a.cv_pages) && a.cv_pages.length === 0), String(json));
  }
});

test('cv_pages: pages without a valid PDF asset id still show; stale is computed from the PDF hash', () => {
  const input = loadFixtureInput(NOW);
  input.dashboardJson = dash({ 3: { file: 'output/c.pdf', sha256: SHA, pages: [P1] }, 4: { asset_id: 'bad', file: 'output/c.pdf', sha256: SHA, pages: [P2] } });
  input.cvFileHashes = { 'output/c.pdf': 'bb'.repeat(32) };
  const s = buildSnapshot(input);
  const by = (n) => s.apps.find((a) => a.num === n);
  assert.deepEqual([by(3).cv_url, by(3).cv_pages, by(3).cv_stale], [null, [`/_blob/${P1}`], true]);
  assert.deepEqual([by(4).cv_url, by(4).cv_pages, by(4).cv_stale], [null, [`/_blob/${P2}`], true]);
});

// ---- Dossiers: data/dossiers.json + strategy sheets + letter assets -> apps[i].dossier ----
const DOSSIER = (over = {}) => ({
  state: 'pret',
  prepared_at: '2026-11-26T07:55:00Z',
  report_num: 3,
  cv: { pdf: 'output/003-cobalt-cv.pdf', html: 'output/003-cobalt-cv.html' },
  letter: { state: 'a_completer', why: null, why_at: null, pdf: null },
  message: 'Bonjour, je vous propose ma candidature.',
  answers: [{ q: 'Disponibilité ?', a: 'Sous un mois.' }],
  strategy: 'output/003-cobalt-strategie.json',
  check: { ok: true, reasons: [] },
  retouches: [],
  ...over,
});
const SHEET = (over = {}) => ({
  titre_cv: 'Engineering Manager',
  angle: 'Mener des équipes plateforme.',
  lettre_angle: null,
  preuves: [{ texte: 'Équipe de six personnes', source: 'cv.md › expérience' }],
  mots_cles_repris: ['plateforme'],
  mots_cles_ecartes: [{ mot: 'Kubernetes', raison: 'absent de cv.md' }],
  ecarts: [{ exigence: 'Anglais courant', traitement: 'non revendiqué' }],
  verification: { ok: true, reasons: [] },
  ...over,
});
const withDossiers = (dossiers, extra = {}) => ({ ...loadFixtureInput(NOW), dossiers: { schema: 1, dossiers }, ...extra });

test('dossier: a valid dossier gives its fields and its bounded strategy sheet', () => {
  const s = buildSnapshot(withDossiers({ 3: DOSSIER() }, { strategies: { 3: SHEET() } }));
  const d = s.apps.find((a) => a.num === 3).dossier;
  assert.equal(d.strategy.titre_cv, 'Engineering Manager');
  assert.deepEqual(d.strategy.preuves, [{ texte: 'Équipe de six personnes', source: 'cv.md › expérience' }]);
  assert.deepEqual(
    [d.state, d.prepared_at, d.letter_state, d.has_why, d.message, d.answers, d.check_ok, d.check_reasons, d.retouche_pending],
    ['pret', '2026-11-26T07:55:00Z', 'a_completer', false, 'Bonjour, je vous propose ma candidature.', [{ q: 'Disponibilité ?', a: 'Sous un mois.' }], true, [], false],
  );
  assert.deepEqual([d.letter_url, d.letter_pages, d.letter_stale], [null, [], null]);
  assert.ok(s.apps.filter((a) => a.num !== 3).every((a) => a.dossier === null));
});

test('dossier: a sheet field of 5000 characters is bounded (600 by validateSheet, then 300 for display, R9)', () => {
  const s = buildSnapshot(withDossiers({ 3: DOSSIER() }, { strategies: { 3: SHEET({ angle: 'x'.repeat(5000) }) } }));
  const angle = s.apps.find((a) => a.num === 3).dossier.strategy.angle;
  assert.equal([...angle].length, 300);
  assert.ok(angle.endsWith('…'));
});

test('dossier (R9): sheet strings at most 300 characters and lists at most 8 items, at every depth', () => {
  const long = 'é'.repeat(700);
  const twelve = (f) => Array.from({ length: 12 }, (_, i) => f(i));
  const sheet = SHEET({
    titre_cv: long, angle: long, lettre_angle: long,
    preuves: twelve((i) => ({ texte: `${i}${long}`, source: `cv.md ${long}` })),
    mots_cles_repris: twelve((i) => `${i}${long}`),
    mots_cles_ecartes: twelve((i) => ({ mot: `${i}${long}`, raison: long })),
    ecarts: twelve((i) => ({ exigence: `${i}${long}`, traitement: long })),
    verification: { ok: false, reasons: twelve((i) => `${i}${long}`) },
  });
  const st = buildSnapshot(withDossiers({ 3: DOSSIER() }, { strategies: { 3: sheet } })).apps.find((a) => a.num === 3).dossier.strategy;
  const strings = [];
  const lists = [];
  const walk = (v) => {
    if (typeof v === 'string') strings.push(v);
    else if (Array.isArray(v)) { lists.push(v); v.forEach(walk); } else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  walk(st);
  assert.ok(strings.length > 0 && strings.every((x) => [...x].length <= 300));
  assert.deepEqual(lists.map((l) => l.length), [8, 8, 8, 8, 8]);
  assert.equal(st.verification.ok, false);
  assert.equal(st.preuves[7].texte.slice(0, 1), '7');
});

test('dossier (R9): answers at most 12 (q 300, a 1000 characters); check_reasons at most 5 of 200 characters', () => {
  const answers = Array.from({ length: 15 }, (_, i) => ({ q: `${i}${'q'.repeat(400)}`, a: 'a'.repeat(1500) }));
  const reasons = Array.from({ length: 7 }, (_, i) => `${i}${'r'.repeat(300)}`);
  const d = buildSnapshot(withDossiers({ 3: DOSSIER({ answers, check: { ok: false, reasons } }) })).apps.find((a) => a.num === 3).dossier;
  assert.equal(d.answers.length, 12);
  assert.ok(d.answers.every((x) => [...x.q].length === 300 && [...x.a].length === 1000));
  assert.deepEqual(d.check_reasons.map((r) => [...r].length), [200, 200, 200, 200, 200]);
  assert.equal(d.check_reasons[4][0], '4');
});

test('dossier: no sheet, or a sheet that is not an object, gives strategy null', () => {
  for (const strategies of [undefined, {}, { 3: null }, { 3: 'x' }, { 3: [] }]) {
    const d = buildSnapshot(withDossiers({ 3: DOSSIER() }, { strategies })).apps.find((a) => a.num === 3).dossier;
    assert.equal(d.strategy, null, JSON.stringify(strategies));
    assert.equal(d.state, 'pret');
  }
});

test('dossier: a num absent from the tracker is ignored; an invalid dossier gives null', () => {
  const s = buildSnapshot(withDossiers({ 42: DOSSIER(), 4: DOSSIER({ state: 'bogus' }), 5: 'x' }, { strategies: { 42: SHEET() } }));
  assert.equal(s.apps.length, 8);
  assert.equal(s.apps.find((a) => a.num === 42), undefined);
  assert.ok(s.apps.every((a) => a.dossier === null));
  for (const dossiers of [undefined, null, 'x', { schema: 1 }, { schema: 1, dossiers: [] }]) {
    const input = { ...loadFixtureInput(NOW), dossiers };
    assert.ok(buildSnapshot(input).apps.every((a) => a.dossier === null), JSON.stringify(dossiers));
  }
});

test('dossier: has_why, letter_state, retouche_pending, check reasons; answers capped at 12', () => {
  const answers = Array.from({ length: 25 }, (_, i) => ({ q: `Question ${i} ?`, a: `Réponse ${i}.` }));
  const s = buildSnapshot(withDossiers({
    3: DOSSIER({ letter: { state: 'prete', why: 'Leur produit plateforme.', why_at: '2026-11-26T20:00:00Z', pdf: 'output/003-lettre.pdf' }, answers }),
    4: DOSSIER({ state: 'a_refaire', letter: { state: 'a_completer', why: '   ', why_at: null, pdf: null },
      check: { ok: false, reasons: ['mot-clé absent du CV : « roadmap »'] },
      retouches: [{ text: 'Plus court.', at: '2026-11-25T10:00:00Z', done_at: '2026-11-26T07:00:00Z' }, { text: 'Titre.', at: '2026-11-26T10:00:00Z', done_at: null }] }),
    5: DOSSIER({ retouches: [{ text: 'Plus court.', at: '2026-11-25T10:00:00Z', done_at: '2026-11-26T07:00:00Z' }] }),
  }));
  const by = (n) => s.apps.find((a) => a.num === n).dossier;
  assert.deepEqual([by(3).letter_state, by(3).has_why, by(3).answers.length, by(3).answers[11].q], ['prete', true, 12, 'Question 11 ?']);
  assert.deepEqual([by(4).state, by(4).has_why, by(4).retouche_pending, by(4).check_ok, by(4).check_reasons],
    ['a_refaire', false, true, false, ['mot-clé absent du CV : « roadmap »']]);
  assert.equal(by(5).retouche_pending, false);
});

// letter_url / letter_pages / letter_stale follow the cv_url / cv_pages / cv_stale rules, from the letter_* fields.
test('dossier: letter_url, letter_pages and letter_stale follow the CV rules; CV fields untouched', () => {
  const input = withDossiers({ 1: DOSSIER({ report_num: 1 }), 3: DOSSIER(), 4: DOSSIER(), 5: DOSSIER() });
  input.dashboardJson = dash({
    3: { asset_id: ID, file: 'output/c.pdf', sha256: SHA, pages: [P1],
      letter_asset_id: ID, letter_file: 'output/l3.pdf', letter_sha256: SHA, letter_pages: [P2, 'javascript:alert(1)'] },
    4: { letter_asset_id: 'javascript:alert(1)', letter_file: 'output/l4.pdf', letter_sha256: SHA, letter_pages: [P1] },
    5: { letter_asset_id: ID, letter_file: 'output/l5.pdf', letter_sha256: SHA.toUpperCase() },
  });
  input.cvFileHashes = { 'output/c.pdf': SHA, 'output/l3.pdf': 'bb'.repeat(32), 'output/l4.pdf': SHA, 'output/l5.pdf': SHA };
  const s = buildSnapshot(input);
  const by = (n) => s.apps.find((a) => a.num === n);
  assert.deepEqual([by(3).dossier.letter_url, by(3).dossier.letter_pages, by(3).dossier.letter_stale], [`/_blob/${ID}`, [`/_blob/${P2}`], true]);
  assert.deepEqual([by(3).cv_url, by(3).cv_pages, by(3).cv_stale], [`/_blob/${ID}`, [`/_blob/${P1}`], false]);
  assert.deepEqual([by(4).dossier.letter_url, by(4).dossier.letter_pages, by(4).dossier.letter_stale], [null, [`/_blob/${P1}`], false]);
  assert.deepEqual([by(4).cv_url, by(4).cv_pages, by(4).cv_stale], [null, [], null]);
  assert.deepEqual([by(5).dossier.letter_url, by(5).dossier.letter_stale], [`/_blob/${ID}`, false]);
  assert.deepEqual([by(1).dossier.letter_url, by(1).dossier.letter_pages, by(1).dossier.letter_stale], [null, [], null]);
});

// ---- Proposals (data/proposals.json) and follow-up texts (data/relances.json) ----
const PROPOSAL = (over = {}) => ({
  id: 'p-0123456789abcdef', ref: 3, to_status: 'Interview',
  evidence: { from: 'rh@cobalt.example', date: '2026-11-26T09:12:00Z', subject: 'Entretien', excerpt: 'Seriez-vous disponible ?' },
  ...over,
});

test('proposals: kept when ref is in the tracker and differs from its current status', () => {
  const input = { ...loadFixtureInput(NOW), proposals: [
    PROPOSAL(),
    PROPOSAL({ id: 'p-1111111111111111', ref: 2, to_status: 'Applied' }), // already Applied
    PROPOSAL({ id: 'p-2222222222222222', ref: 42 }), // not in the tracker
    PROPOSAL({ id: 'p-3333333333333333', ref: 7, to_status: 'Interview' }),
  ] };
  const s = buildSnapshot(input);
  assert.deepEqual(s.proposals, [
    { id: 'p-0123456789abcdef', ref: 3, company: 'Cobalt SAS', from_status: 'Applied', to_status: 'Interview', evidence: PROPOSAL().evidence },
    { id: 'p-3333333333333333', ref: 7, company: 'Gamma Corp', from_status: 'Rejected', to_status: 'Interview', evidence: PROPOSAL().evidence },
  ]);
  for (const proposals of [undefined, null, 'x', {}]) assert.deepEqual(buildSnapshot({ ...loadFixtureInput(NOW), proposals }).proposals, []);
});

test('followups_due: text present when relances gives one for that num, absent otherwise', () => {
  const plain = buildSnapshot(loadFixtureInput(NOW));
  assert.ok(plain.followups_due.length >= 1);
  assert.ok(plain.followups_due.every((f) => !('text' in f)));
  const s = buildSnapshot({ ...loadFixtureInput(NOW), relances: { 2: { text: 'Bonjour,\n\nJe me permets de revenir vers vous.' }, 7: { text: 'Pas due.' } } });
  assert.equal(s.followups_due.find((f) => f.num === 2).text, 'Bonjour,\n\nJe me permets de revenir vers vous.');
  assert.ok(s.followups_due.filter((f) => f.num !== 2).every((f) => !('text' in f)));
  assert.deepEqual(s.followups_due.map((f) => f.num), plain.followups_due.map((f) => f.num)); // a text never makes a follow-up due
});
