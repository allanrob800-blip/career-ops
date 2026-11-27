import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSnapshot, loadMatch } from '../lib/snapshot.mjs';
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
