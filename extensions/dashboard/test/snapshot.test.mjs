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
