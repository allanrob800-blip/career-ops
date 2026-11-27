import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateProposals, validateRelances } from '../lib/suivi-files.mjs';

const ID = 'p-0123456789abcdef';
const evidence = (over = {}) => ({
  from: 'rh@acme.example', date: '2026-11-26T09:12:00Z', subject: 'Suite à votre candidature',
  excerpt: 'Nous souhaitons vous rencontrer.', ...over,
});
const item = (over = {}) => ({ id: ID, ref: 3, to_status: 'Interview', evidence: evidence(), ...over });
const proposals = (items) => ({ schema: 1, generated_at: '2026-11-27T07:00:00Z', items });

test('validateProposals: a valid item is kept with its fields', () => {
  assert.deepEqual(validateProposals(proposals([item()])), [item()]);
});

test('validateProposals: invalid items are dropped, valid ones kept', () => {
  const bad = [
    item({ id: 'p-short' }), item({ id: '0123456789abcdef' }), item({ id: 'p-0123456789ABCDEF' }), item({ id: 42 }),
    item({ ref: 0 }), item({ ref: '3' }), item({ ref: 2.5 }),
    item({ to_status: 'Bogus' }), item({ to_status: '**Interview**' }), item({ to_status: null }),
    item({ evidence: null }), item({ evidence: 'x' }),
    item({ evidence: evidence({ from: '' }) }), item({ evidence: evidence({ date: 'hier' }) }),
    item({ evidence: evidence({ subject: 3 }) }), item({ evidence: evidence({ excerpt: null }) }),
    null, 'x', [],
  ];
  const good = item({ id: 'p-fedcba9876543210', ref: 5, to_status: 'Rejected' });
  assert.deepEqual(validateProposals(proposals([...bad, good])), [good]);
});

test('validateProposals: excerpt bounded to 280 characters; evidence whitespace collapsed', () => {
  const [p] = validateProposals(proposals([item({ evidence: evidence({ excerpt: `${'é'.repeat(400)}`, subject: 'Votre\n  candidature' }) })]));
  assert.equal([...p.evidence.excerpt].length, 280);
  assert.ok(p.evidence.excerpt.endsWith('…'));
  assert.equal(p.evidence.subject, 'Votre candidature');
});

test('validateProposals: a repeated id keeps the first item only', () => {
  const first = item();
  assert.deepEqual(validateProposals(proposals([first, item({ ref: 4 })])), [first]);
});

test('validateProposals: a file of another shape throws', () => {
  for (const doc of [null, [], 'x', {}, { schema: 2, items: [] }, { schema: 1, items: {} }]) {
    assert.throws(() => validateProposals(doc), /proposals/, JSON.stringify(doc));
  }
  assert.deepEqual(validateProposals(proposals([])), []);
});

const relances = (items) => ({ schema: 1, items });

test('validateRelances: keeps {text} per tracker num, with its line breaks', () => {
  const got = validateRelances(relances({ 2: { text: 'Bonjour,\r\n\r\nJe me permets de revenir vers vous.', generated_at: '2026-11-27T07:00:00Z' } }));
  assert.deepEqual(got, { 2: { text: 'Bonjour,\n\nJe me permets de revenir vers vous.' } });
});

test('validateRelances: invalid entries dropped; text of 1500 characters at most', () => {
  const got = validateRelances(relances({
    1: { text: 'a'.repeat(1500) },
    2: { text: 'a'.repeat(1501) },
    3: { text: '   ' },
    4: { text: 'bip\u0007' },
    5: 'texte',
    x: { text: 'clé non numérique' },
    0: { text: 'numéro nul' },
    '007': { text: 'Bonjour.' },
  }));
  assert.deepEqual(Object.keys(got).sort(), ['1', '7']);
  assert.equal(got[1].text.length, 1500);
  assert.equal(got[7].text, 'Bonjour.');
});

test('validateRelances: a file of another shape throws', () => {
  for (const doc of [null, [], 'x', {}, { schema: 2, items: {} }, { schema: 1, items: [] }]) {
    assert.throws(() => validateRelances(doc), /relances/, JSON.stringify(doc));
  }
  assert.deepEqual(validateRelances(relances({})), {});
});
