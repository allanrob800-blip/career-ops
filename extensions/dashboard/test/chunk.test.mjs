import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toDocs } from '../lib/chunk.mjs';

const size = (d) => Buffer.byteLength(JSON.stringify(d));

function fakeSnapshot({ apps = 0, offers = 0, reports = 0 } = {}) {
  const mk = (n, label) => Array.from({ length: n }, (_, i) => ({ num: i, label, note: 'x'.repeat(200) }));
  return {
    schema: 1,
    generation: '2026-11-27T10:00:00.000Z',
    generated_at: '2026-11-27T10:00:00.000Z',
    profile: { first_name: 'Camille' },
    stats: { total: apps },
    timeline: [],
    followups_due: [],
    companies: [],
    apps: mk(apps, 'a'),
    offers: mk(offers, 'o'),
    reports: mk(reports, 'r'),
  };
}

test('toDocs keeps every doc under the limit and lists parts', () => {
  const big = fakeSnapshot({ apps: 900, offers: 50, reports: 30 });
  assert.ok(size(big) > 190000);
  const docs = toDocs(big);
  assert.ok(docs.every((d) => size(d.data) <= 60000));
  const meta = docs.find((d) => d.path === 'snapshot/meta').data;
  assert.deepEqual(meta.parts, docs.filter((d) => d.path !== 'snapshot/meta').map((d) => d.path));
  assert.ok(docs.every((d) => d.path === 'snapshot/meta' || d.data.generation === big.generation));
  assert.ok(docs.some((d) => d.path === 'snapshot/apps-1'));
  assert.ok(docs.some((d) => d.path === 'snapshot/offers-0'));
  assert.ok(docs.some((d) => d.path === 'snapshot/reports-0'));
  const apps = docs.filter((d) => d.path.startsWith('snapshot/apps-')).flatMap((d) => d.data.items);
  assert.equal(apps.length, 900);
  assert.deepEqual(apps.map((a) => a.num), big.apps.map((a) => a.num));
});

test('toDocs meta carries the snapshot fields', () => {
  const docs = toDocs(fakeSnapshot({ apps: 2 }));
  const meta = docs[0].data;
  assert.equal(docs[0].path, 'snapshot/meta');
  for (const k of ['schema', 'generation', 'generated_at', 'profile', 'stats', 'timeline', 'followups_due', 'companies', 'parts']) assert.ok(k in meta, k);
  assert.equal('apps' in meta, false);
});

test('toDocs throws when a single item exceeds maxBytes', () => {
  const s = fakeSnapshot({ apps: 1 });
  s.apps[0].note = 'y'.repeat(5000);
  assert.throws(() => toDocs(s, 1000), /maxBytes/);
});
