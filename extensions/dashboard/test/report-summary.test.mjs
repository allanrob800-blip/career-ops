import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeReport } from '../lib/report-summary.mjs';
import { readFixture } from './helpers.mjs';

test('summarizeReport reads headers and caps bullets', () => {
  const r = summarizeReport(readFixture('reports/001-acme-pm.md'), 1);
  assert.equal(r.num, 1);
  assert.equal(r.score, 4.2);
  assert.equal(r.legitimacy, 'High Confidence');
  assert.equal(r.archetype, 'Product / Platform');
  assert.equal(r.url, 'https://jobs.acme.fr/offres/product-manager-42');
  assert.equal(r.strengths.length, 3);
  assert.equal(r.gaps.length, 3);
  assert.ok(r.strengths.every((s) => !s.includes('Not part of')));
});

test('summarizeReport nulls a non-https url and truncates', () => {
  const md = `**URL:** javascript:alert(1)\n**Score:** 3/5\n## B) Match with CV\n- ✅ ${'x'.repeat(300)}\n`;
  const r = summarizeReport(md, 7);
  assert.equal(r.url, null);
  assert.equal(r.score, 3);
  assert.equal(r.strengths[0].length, 160);
  assert.equal(r.archetype, null);
  assert.equal(r.legitimacy, null);
});

test('summarizeReport on empty input', () => {
  const r = summarizeReport('', 2);
  assert.deepEqual(r, { num: 2, score: null, archetype: null, legitimacy: null, url: null, strengths: [], gaps: [] });
});
