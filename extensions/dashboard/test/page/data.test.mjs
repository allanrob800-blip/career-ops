import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, launchBrowser, openPage } from './harness.mjs';

let server, browser;
before(async () => { server = await startServer(); browser = await launchBrowser(); });
after(async () => { await browser?.close(); await server?.close(); });

// Task 3 layout: snapshot/meta + snapshot/{apps,offers,reports}-N parts sharing one generation.
function gen(g, n = 1) {
  const docs = {};
  const parts = [];
  const add = (kind, items) => { const p = `snapshot/${kind}-0`; parts.push(p); docs[p] = { generation: g, items }; };
  add('apps', Array.from({ length: n }, (_, i) => ({ num: i + 1, company: `Co${g}-${i}` })));
  add('offers', [{ url: `https://example.test/${g}` }]);
  add('reports', [{ num: 1, title: `R${g}` }]);
  docs['snapshot/meta'] = { schema: 1, generation: g, generated_at: `2026-11-2${g.slice(-1)}T10:00:00Z`, profile: {}, stats: {}, timeline: [], followups_due: [], companies: [], parts };
  return docs;
}
const metaOnly = (docs) => ({ 'snapshot/meta': docs['snapshot/meta'] });

async function open(fake, opts = {}) {
  const p = await openPage(browser, { url: server.url, manualStart: true, fake: { db: { docs: fake } }, ...opts });
  await p.page.evaluate(() => { window.__states = []; CapData.start((s) => window.__states.push(JSON.parse(JSON.stringify(s)))); });
  return p;
}
const last = (p) => p.page.evaluate(() => window.__states[window.__states.length - 1]);
const settle = (p) => p.page.evaluate(() => new Promise((r) => setTimeout(r, 60)));
const writeDoc = (p, path, body) => p.page.evaluate(async ([path, body]) => (await (await claude.use('db')).doc(path).set(body)), [path, body]);

test('generation safety: new meta alone keeps old generation, complete parts switch', async () => {
  const g1 = gen('g1'), g2 = gen('g2', 2);
  const p = await open({ ...g1 });
  try {
    await settle(p);
    let s = await last(p);
    assert.equal(s.status, 'ok');
    assert.equal(s.snapshot.generation, 'g1');
    assert.equal(s.snapshot.apps.length, 1);
    assert.equal(s.synced_at, g1['snapshot/meta'].generated_at);
    await writeDoc(p, 'snapshot/meta', g2['snapshot/meta']);
    await settle(p);
    assert.equal((await last(p)).snapshot.generation, 'g1');
    for (const part of g2['snapshot/meta'].parts) { await writeDoc(p, part, g2[part]); await settle(p); }
    s = await last(p);
    assert.equal(s.snapshot.generation, 'g2');
    assert.equal(s.snapshot.apps.length, 2);
    assert.equal(s.snapshot.offers.length, 1);
    assert.equal(s.snapshot.reports[0].title, 'Rg2');
    assert.deepEqual(p.errors, []);
  } finally { await p.close(); }
});

test('a half-written first generation stays loading, then becomes ok', async () => {
  const g1 = gen('g1');
  const p = await open(metaOnly(g1));
  try {
    await settle(p);
    assert.equal((await last(p)).status, 'loading');
    for (const part of g1['snapshot/meta'].parts) await writeDoc(p, part, g1[part]);
    await settle(p);
    assert.equal((await last(p)).status, 'ok');
  } finally { await p.close(); }
});

test('empty database: status empty', async () => {
  const p = await open({});
  try {
    await settle(p);
    const s = await last(p);
    assert.equal(s.status, 'empty');
    assert.equal(s.snapshot, null);
    assert.deepEqual(s.prefs, { weekly_goal: 3, accent: 'corail', reduced_motion: false });
  } finally { await p.close(); }
});

test('db null -> unavailable within 11 s (simulated clock); never-answering db too', async () => {
  for (const mode of ['null', 'hang']) {
    const p = await openPage(browser, { url: server.url, manualStart: true });
    try {
      await p.page.clock.install();
      await p.page.evaluate((mode) => {
        window.__states = [];
        const orig = claude.use.bind(claude);
        claude.use = (n) => (n === 'db' ? (mode === 'null' ? Promise.resolve(null) : new Promise(() => {})) : orig(n));
        CapData.start((s) => window.__states.push(s.status));
      }, mode);
      await p.page.clock.runFor(11000);
      const statuses = await p.page.evaluate(() => window.__states);
      assert.equal(statuses[statuses.length - 1], 'unavailable', mode);
      assert.equal(statuses[0], 'loading');
    } finally { await p.close(); }
  }
});

test('absent window.claude is treated as unavailable', async () => {
  const p = await openPage(browser, { url: server.url, manualStart: true });
  try {
    await p.page.evaluate(() => { delete window.claude; window.__states = []; CapData.start((s) => window.__states.push(s.status)); });
    await settle(p);
    assert.equal(await p.page.evaluate(() => window.__states.at(-1)), 'unavailable');
  } finally { await p.close(); }
});

// A complete generation whose apps carry statuses (rows 3 and 4 Applied, 5 Interview).
function withApps(apps) {
  return {
    'snapshot/meta': { schema: 1, generation: 'gs', generated_at: '2026-11-26T10:00:00Z', profile: {}, stats: {}, timeline: [], followups_due: [], companies: [], parts: ['snapshot/apps-gs-0'] },
    'snapshot/apps-gs-0': { generation: 'gs', items: apps },
  };
}
const APPS = [{ num: 3, company: 'Cobalt', status: 'Applied' }, { num: 4, company: 'Delta', status: 'Applied' }, { num: 5, company: 'Echo', status: 'Interview' }];

test('requestStatus writes a pending request; validation rejects bad input', async () => {
  const p = await open(withApps(APPS));
  try {
    await settle(p);
    await p.page.evaluate(() => CapData.requestStatus(3, 'Interview'));
    await p.page.evaluate(() => CapData.requestNote(4, 'Relancer vendredi'));
    const reqs = await p.page.evaluate(async () => {
      const q = await (await claude.use('db')).collection('requests').get();
      return q.docs.map((d) => ({ id: d.id, ...d.data() }));
    });
    assert.equal(reqs.length, 2);
    const st = reqs.find((r) => r.type === 'status');
    assert.match(st.id, /^[0-9a-f-]{36}$/);
    assert.deepEqual({ ref: st.ref, from_status: st.from_status, to_status: st.to_status, state: st.state }, { ref: 3, from_status: 'Applied', to_status: 'Interview', state: 'pending' });
    assert.ok(!Number.isNaN(Date.parse(st.created_at)));
    const nt = reqs.find((r) => r.type === 'note');
    assert.deepEqual({ ref: nt.ref, note: nt.note, state: nt.state }, { ref: 4, note: 'Relancer vendredi', state: 'pending' });
    assert.ok(!('to_status' in nt) && !('note' in st));
    await settle(p);
    assert.equal((await last(p)).pending.length, 2);
    const bad = await p.page.evaluate(async () => {
      const out = [];
      for (const f of [() => CapData.requestStatus(0, 'Interview'), () => CapData.requestStatus(1.5, 'Interview'), () => CapData.requestStatus(1, 'Nope'),
        () => CapData.requestNote(1, ''), () => CapData.requestNote(1, ' \n\t '), () => CapData.requestNote(1, 'x'.repeat(501)), () => CapData.requestNote(1, 'a\u0007b'), () => CapData.requestNote('2', 'ok'),
        () => CapData.requestStatus(99, 'Interview')]) {
        try { await f(); out.push('ok'); } catch (e) { out.push(e instanceof Error ? 'error' : 'other'); }
      }
      return out;
    });
    assert.deepEqual(bad, Array(9).fill('error'));
    assert.equal(await p.page.evaluate(async () => (await (await claude.use('db')).collection('requests').get()).size), 2);
  } finally { await p.close(); }
});

test('pending keeps pending + recent outcomes, drops old ones', async () => {
  const now = Date.now();
  const iso = (d) => new Date(now - d * 86400000).toISOString();
  const p = await open({
    'requests/a': { type: 'status', ref: 1, to_status: 'Applied', created_at: iso(0.1), state: 'pending' },
    'requests/b': { type: 'status', ref: 2, to_status: 'Offer', created_at: iso(2), state: 'applied', applied_at: iso(1.9) },
    'requests/c': { type: 'note', ref: 3, note: 'n', created_at: iso(3), state: 'rejected', reason: 'row not found', applied_at: null },
    'requests/d': { type: 'status', ref: 4, to_status: 'Offer', created_at: iso(20), state: 'applied', applied_at: iso(19) },
  });
  try {
    await settle(p);
    const s = await last(p);
    assert.deepEqual(s.pending.map((r) => r.state).sort(), ['applied', 'pending', 'rejected']);
    assert.equal(s.pending.find((r) => r.state === 'rejected').reason, 'row not found');
    assert.ok(!s.pending.some((r) => r.ref === 4));
  } finally { await p.close(); }
});

test('savePrefs merges, survives a new snapshot generation, uses set', async () => {
  const g1 = gen('g1'), g2 = gen('g2');
  const p = await open({ ...g1, 'settings/prefs': { weekly_goal: 3, accent: 'ocean', reduced_motion: true } });
  try {
    await settle(p);
    await p.page.evaluate(() => CapData.savePrefs({ weekly_goal: 4 }));
    for (const [path, body] of Object.entries(g2)) await writeDoc(p, path, body);
    await settle(p);
    const s = await last(p);
    assert.equal(s.snapshot.generation, 'g2');
    assert.deepEqual(s.prefs, { weekly_goal: 4, accent: 'ocean', reduced_motion: true });
    const calls = await p.page.evaluate(() => window.__calls.filter((c) => c.args[0] === 'settings/prefs' && /set|update/.test(c.fn)).map((c) => c.fn));
    assert.deepEqual(calls, ['doc.set']);
    const bad = await p.page.evaluate(async () => {
      const out = [];
      for (const v of [{ weekly_goal: 0 }, { weekly_goal: 'x' }, { reduced_motion: 'no' }, { accent: '' }, { other: 1 }]) {
        try { await CapData.savePrefs(v); out.push('ok'); } catch { out.push('error'); }
      }
      return out;
    });
    assert.deepEqual(bad, Array(5).fill('error'));
  } finally { await p.close(); }
});

test('savePrefs works when settings/prefs does not exist yet (defaults + partial)', async () => {
  const p = await open({});
  try {
    await settle(p);
    await p.page.evaluate(() => Promise.all([CapData.savePrefs({ weekly_goal: 5 }), CapData.savePrefs({ accent: 'ocean' })]));
    await settle(p);
    assert.deepEqual((await last(p)).prefs, { weekly_goal: 5, accent: 'ocean', reduced_motion: false });
  } finally { await p.close(); }
});

test('markHandled / handledIds: encoded doc id, raw id in body, one listener per query', async () => {
  const p = await open({});
  try {
    await settle(p);
    const raw = 'AAMk=ADB/x+y==';
    await p.page.evaluate((raw) => CapData.markHandled(raw), raw);
    await settle(p);
    const r = await p.page.evaluate(async () => {
      const q = await (await claude.use('db')).collection('handled').get();
      return { ids: q.docs.map((d) => d.id), body: q.docs[0].data(), set: [...CapData.handledIds()], subs: window.__calls.filter((c) => /onSnapshot/.test(c.fn)).map((c) => `${c.fn}:${c.args[0]}`) };
    });
    assert.deepEqual(r.ids, ['AAMk~3dADB~2fx~2by~3d~3d']);
    assert.equal(r.body.message_id, raw);
    assert.ok(!Number.isNaN(Date.parse(r.body.at)));
    assert.deepEqual(r.set, [raw]);
    assert.deepEqual(r.subs.sort(), ['collection.onSnapshot:handled', 'collection.onSnapshot:requests', 'collection.onSnapshot:snapshot', 'doc.onSnapshot:settings/prefs']);
    const long = await p.page.evaluate(() => { const a = CapData.encodeSeg('=' .repeat(100)), b = CapData.encodeSeg('=' .repeat(100)), c = CapData.encodeSeg('=' .repeat(101)); return { a, same: a === b, diff: a !== c, len: a.length }; });
    assert.ok(long.same && long.diff && long.len <= 200);
    assert.deepEqual(p.errors, []);
  } finally { await p.close(); }
});

test('fake db mirrors the real API: update on missing doc rejects, path grammar throws, scoped notifications', async () => {
  const p = await openPage(browser, { url: server.url, manualStart: true, fake: { db: {} } });
  try {
    const r = await p.page.evaluate(async () => {
      const db = await claude.use('db');
      const out = {};
      try { await db.doc('settings/prefs').update({ a: 1 }); out.upd = 'ok'; } catch (e) { out.upd = e.code; }
      for (const [k, f] of Object.entries({ odd: () => db.doc('snapshot'), even: () => db.collection('snapshot/meta'), chars: () => db.doc('handled/a=b'), dots: () => db.doc('handled/..') })) {
        try { f(); out[k] = 'ok'; } catch (e) { out[k] = e instanceof TypeError ? 'TypeError' : 'other'; }
      }
      let hits = 0;
      const un = db.collection('requests').onSnapshot(() => { hits++; });
      await new Promise((r) => setTimeout(r, 20));
      const base = hits;
      await db.doc('settings/prefs').set({ a: 1 });
      await db.doc('requests/x').set({ a: 1 });
      await new Promise((r) => setTimeout(r, 20));
      un();
      out.extra = hits - base;
      const ref = await db.collection('requests').add({ b: 1 });
      const s = await ref.get();
      out.add = [typeof s.data, s.exists, s.data().b, s.metadata.fromCache];
      const q = await db.collection('requests').get();
      out.q = [q.size, q.empty, typeof q.docChanges];
      return out;
    });
    assert.deepEqual(r, { upd: 'invalid_argument', odd: 'TypeError', even: 'TypeError', chars: 'TypeError', dots: 'TypeError', extra: 1, add: ['function', true, 1, false], q: [2, false, 'function'] });
  } finally { await p.close(); }
});

test('savePrefs before the first prefs delivery merges onto the stored doc', async () => {
  const stored = { weekly_goal: 7, accent: 'ocean', reduced_motion: true };
  const p = await openPage(browser, { url: server.url, manualStart: true, fake: { db: { docs: { 'settings/prefs': stored }, latencyMs: 200 } } });
  try {
    await p.page.evaluate(() => { window.__states = []; CapData.start((s) => window.__states.push(JSON.parse(JSON.stringify(s)))); });
    await p.page.evaluate(() => CapData.savePrefs({ reduced_motion: false }));
    const body = await p.page.evaluate(async () => (await (await claude.use('db')).doc('settings/prefs').get()).data());
    assert.deepEqual(body, { weekly_goal: 7, accent: 'ocean', reduced_motion: false });
    await p.page.evaluate(() => new Promise((r) => setTimeout(r, 400)));
    assert.deepEqual((await last(p)).prefs, body);
  } finally { await p.close(); }
});

test('from_status: the target of the row\'s latest pending status request, else the snapshot status', async () => {
  const p = await open({ ...withApps(APPS),
    'requests/old': { type: 'status', ref: 4, from_status: 'Applied', to_status: 'Responded', created_at: '2026-11-25T08:00:00Z', state: 'pending' },
    'requests/done': { type: 'status', ref: 4, from_status: 'Responded', to_status: 'Offer', created_at: '2026-11-25T09:00:00Z', state: 'applied', applied_at: '2026-11-25T10:00:00Z' },
  });
  try {
    await settle(p);
    // two requests in a row, without waiting for the listener: the second chains on the first
    await p.page.evaluate(() => Promise.all([CapData.requestStatus(3, 'Interview'), CapData.requestStatus(3, 'Offer')]));
    await p.page.evaluate(() => CapData.requestStatus(4, 'Interview'));
    await p.page.evaluate(() => CapData.requestStatus(5, 'Offer'));
    const reqs = await p.page.evaluate(async () => (await (await claude.use('db')).collection('requests').get()).docs.map((d) => d.data()));
    const mine = reqs.filter((r) => r.state === 'pending' && r.created_at > '2026-11-26').sort((a, b) => a.created_at.localeCompare(b.created_at) || a.to_status.localeCompare(b.to_status));
    const pairs = mine.map((r) => `${r.ref}:${r.from_status}>${r.to_status}`);
    assert.deepEqual(pairs.filter((x) => x.startsWith('3:')), ['3:Applied>Interview', '3:Interview>Offer']);
    assert.deepEqual(pairs.filter((x) => !x.startsWith('3:')), ['4:Responded>Interview', '5:Interview>Offer']);
    assert.equal(await p.page.evaluate(() => CapData.expectedStatus(3)), 'Offer');
    assert.equal(await p.page.evaluate(() => CapData.expectedStatus(99)), null);
  } finally { await p.close(); }
});

test('requestNote: a Return (or any whitespace run) becomes one space before the checks', async () => {
  const p = await open(withApps(APPS));
  try {
    await settle(p);
    await p.page.evaluate(() => CapData.requestNote(3, '  Relancer\nvendredi\r\n\tmerci  '));
    await p.page.evaluate(() => CapData.requestNote(3, `a${' '.repeat(600)}b`));
    const notes = await p.page.evaluate(async () => (await (await claude.use('db')).collection('requests').get()).docs.map((d) => d.data().note).sort());
    assert.deepEqual(notes, ['Relancer vendredi merci', 'a b']);
  } finally { await p.close(); }
});

test('weekly_goal is kept within 1-10, like the settings screen', async () => {
  const p = await open({ ...withApps(APPS), 'settings/prefs': { weekly_goal: 50, accent: 'corail', reduced_motion: false } });
  try {
    await settle(p);
    assert.equal((await last(p)).prefs.weekly_goal, 10);
    const r = await p.page.evaluate(async () => {
      const out = [];
      for (const v of [11, 10, 1]) { try { await CapData.savePrefs({ weekly_goal: v }); out.push('ok'); } catch { out.push('error'); } }
      return out;
    });
    assert.deepEqual(r, ['error', 'ok', 'ok']);
  } finally { await p.close(); }
});
