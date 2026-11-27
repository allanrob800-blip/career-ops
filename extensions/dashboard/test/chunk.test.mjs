import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toDocs, genId, syncPlan } from '../lib/chunk.mjs';
import { parseDbLines } from '../lib/db-lines.mjs';

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
  assert.ok(docs.some((d) => d.path === 'snapshot/apps-g20261127T100000000Z-1'));
  assert.ok(docs.some((d) => d.path === 'snapshot/offers-g20261127T100000000Z-0'));
  assert.ok(docs.some((d) => d.path === 'snapshot/reports-g20261127T100000000Z-0'));
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

// ---- I3: per-generation part ids and the sync plan ----
test('part ids carry a path-safe form of the generation; two generations never share a part id', () => {
  const a = toDocs(fakeSnapshot({ apps: 2, offers: 1, reports: 1 }));
  const s2 = fakeSnapshot({ apps: 2, offers: 1, reports: 1 });
  s2.generation = '2026-11-27T16:12:00.123Z';
  const b = toDocs(s2);
  const parts = (docs) => docs.filter((d) => d.path !== 'snapshot/meta').map((d) => d.path);
  for (const p of parts(a)) assert.match(p, /^snapshot\/(apps|offers|reports)-g20261127T100000000Z-\d+$/);
  assert.ok(parts(b).includes('snapshot/apps-g20261127T161200123Z-0'));
  assert.equal(parts(a).filter((p) => parts(b).includes(p)).length, 0);
  assert.equal(genId('2026-11-27T16:12:00.123Z'), 'g20261127T161200123Z');
});

const cur = (path, version, data = {}) => ({ id: path.replace(/^snapshot\//, ''), data, version, updatedAt: '2026-11-26T10:00:00Z' });

test('syncPlan: new parts first (set, no ifVersion), then one batch flipping meta and deleting old parts', () => {
  const docs = toDocs(fakeSnapshot({ apps: 2, offers: 1, reports: 1 }));
  const current = [cur('snapshot/meta', 3, { parts: ['snapshot/apps-0'] }), cur('snapshot/apps-0', 1), cur('snapshot/offers-0', 2), cur('snapshot/reports-0', 5)];
  const { batches } = syncPlan(docs, current);
  assert.equal(batches.length, 2);
  const newParts = docs.filter((d) => d.path !== 'snapshot/meta');
  assert.deepEqual(batches[0], newParts.map((d) => ({ op: 'set', path: d.path, data: d.data })));
  const [meta, ...dels] = batches[1];
  assert.deepEqual(meta, { op: 'set', path: 'snapshot/meta', data: docs[0].data, ifVersion: 3 });
  assert.deepEqual(dels, [
    { op: 'delete', path: 'snapshot/apps-0', ifVersion: 1 },
    { op: 'delete', path: 'snapshot/offers-0', ifVersion: 2 },
    { op: 'delete', path: 'snapshot/reports-0', ifVersion: 5 },
  ]);
});

test('syncPlan on an empty database: meta without ifVersion, nothing to delete', () => {
  const docs = toDocs(fakeSnapshot({ apps: 1 }));
  const { batches } = syncPlan(docs, []);
  const last = batches.at(-1);
  assert.deepEqual(last, [{ op: 'set', path: 'snapshot/meta', data: docs[0].data }]);
});

test('syncPlan keeps every batch at 50 ops or fewer; overflowing deletes come after the meta flip', () => {
  const s = fakeSnapshot({ apps: 0 });
  const docs = [{ path: 'snapshot/meta', data: { ...toDocs(s)[0].data, parts: [] } }];
  for (let i = 0; i < 60; i++) docs.push({ path: `snapshot/apps-g1-${i}`, data: { generation: 'g1', items: [] } });
  docs[0].data.parts = docs.slice(1).map((d) => d.path);
  const current = [cur('snapshot/meta', 9)];
  for (let i = 0; i < 120; i++) current.push(cur(`snapshot/apps-g0-${i}`, i + 1));
  const { batches } = syncPlan(docs, current);
  assert.ok(batches.every((b) => b.length >= 1 && b.length <= 50));
  assert.deepEqual(batches.map((b) => b.length), [50, 10, 50, 50, 21]);
  assert.deepEqual(batches[2][0].path, 'snapshot/meta');
  assert.ok(batches.slice(0, 2).flat().every((o) => o.op === 'set' && !('ifVersion' in o)));
  assert.ok(batches.slice(2).flat().slice(1).every((o) => o.op === 'delete' && Number.isInteger(o.ifVersion)));
  assert.equal(batches.slice(2).flat().length - 1, 120);
});

test('an interrupted sync leaves the previous generation whole in the database', () => {
  const s0 = fakeSnapshot({ apps: 3 }); s0.generation = '2026-11-26T10:00:00.000Z';
  const s1 = fakeSnapshot({ apps: 4 }); s1.generation = '2026-11-27T10:00:00.000Z';
  const store = new Map(toDocs(s0).map((d, i) => [d.path, { data: d.data, version: i + 1 }]));
  const current = [...store].map(([path, v]) => cur(path, v.version, v.data));
  const { batches } = syncPlan(toDocs(s1), current);
  for (const op of batches[0]) store.set(op.path, { data: op.data, version: 1 }); // the sync stops here
  const meta = store.get('snapshot/meta').data;
  assert.equal(meta.generation, s0.generation);
  for (const p of meta.parts) assert.equal(store.get(p).data.generation, s0.generation, p);
});

test('parseDbLines: tool line format, wrapper lines ignored; a JSON array passes through', () => {
  const text = 'Voici le résultat\n{"collection":"snapshot","count":2}\n{"id":"meta","data":{"a":1},"version":3,"updatedAt":"x"}\nnot json\n{"id":"apps-0","data":{},"version":1}\n';
  assert.deepEqual(parseDbLines(text).map((e) => [e.id, e.version]), [['meta', 3], ['apps-0', 1]]);
  assert.deepEqual(parseDbLines('[{"id":"a","data":{}}]'), [{ id: 'a', data: {} }]);
  assert.deepEqual(parseDbLines(''), []);
});
