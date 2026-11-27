import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync, statSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { FIXTURE_ROOT } from './helpers.mjs';
import { validateDossier } from '../../agents/lib/dossiers.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, '..', 'apply-requests.mjs');
let tmp;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dash-apply-'));
  cpSync(FIXTURE_ROOT, join(tmp, 'root'), { recursive: true });
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const root = () => join(tmp, 'root');
const readTracker = () => readFileSync(join(root(), 'data/applications.md'), 'utf8');
const readStatusLog = () => readFileSync(join(root(), 'data/status-log.tsv'), 'utf8');
const row3 = () => readTracker().split('\n').find((x) => /^\|\s*3\s*\|/.test(x));

// `requests` is an array (legacy shape) or a string (written verbatim, e.g. the db_query line format).
function run(requests, extra = [], env = {}) {
  const input = join(tmp, 'in.json');
  writeFileSync(input, typeof requests === 'string' ? requests : JSON.stringify(requests));
  const out = execFileSync(process.execPath, [CLI, '--in', input, ...extra], {
    env: { ...process.env, CAREER_OPS_ROOT: root(), ...env },
    encoding: 'utf8',
  });
  return JSON.parse(out);
}
const req = (id, data) => ({ id, data: { created_at: '2026-11-26T18:00:00Z', state: 'pending', ...data } });
const st = (id, ref, from_status, to_status, extra = {}) => req(id, { type: 'status', ref, from_status, to_status, ...extra });
// The db_query / db_list tool output: a summary object, then one {id, data, version, updatedAt} per line.
const lines = (entries) => [JSON.stringify({ collection: 'requests', count: entries.length }),
  ...entries.map((e, i) => JSON.stringify({ version: i + 7, updatedAt: '2026-11-26T18:00:01Z', ...e }))].join('\n') + '\n';

test('valid status request is applied with the request date', () => {
  const res = run([st('r1', 3, 'Applied', 'Interview')]);
  assert.equal(res.results[0].state, 'applied');
  assert.equal(res.results[0].reason, null);
  assert.ok(res.results[0].applied_at);
  assert.match(readTracker(), /\|\s*3\s*\|.*\|\s*Interview\s*\|/);
  assert.match(readStatusLog(), /^3\t2026-11-26\t/m);
});

test('invalid requests are rejected without writing', () => {
  const before = readTracker();
  const { results } = run([
    st('a', 3, 'Applied', 'Hacked'),
    st('b', 999, 'Applied', 'Applied'),
    req('c', { type: 'note', ref: 3, note: 'x\u0007' }),
  ]);
  assert.deepEqual(results.map((r) => r.state), ['rejected', 'rejected', 'rejected']);
  assert.ok(results.every((r) => r.reason && r.applied_at === null));
  assert.equal(readTracker(), before);
});

test('malformed entries, bad dates and long notes are rejected; non-pending and state-less ignored', () => {
  const before = readTracker();
  const { results } = run([
    { id: 'm1' },
    { id: 'm2', data: 'nope' },
    st('m3', 3.5, 'Applied', 'Applied'),
    st('m4', 3, 'Applied', 'Applied', { created_at: 'not a date' }),
    req('m5', { type: 'note', ref: 3, note: 'x'.repeat(501) }),
    req('m6', { type: 'bogus', ref: 3 }),
    req('m7', { type: ['why'], ref: 1, text: 'x' }),
    st('done', 3, 'Applied', 'Interview', { state: 'applied' }),
    { id: 'nostate', data: { type: 'status', ref: 3, from_status: 'Applied', to_status: 'Interview', created_at: '2026-11-26T18:00:00Z' } },
  ]);
  assert.deepEqual(results.map((r) => r.id).sort(), ['m3', 'm4', 'm5', 'm6', 'm7']);
  assert.ok(results.every((r) => r.state === 'rejected' && r.reason));
  assert.equal(readTracker(), before);
});

test('--dry-run writes nothing and emits no ops', () => {
  const t = readTracker(), l = readStatusLog();
  const res = run(lines([st('r1', 3, 'Applied', 'Interview')]), ['--dry-run']);
  assert.equal(res.results[0].state, 'would_apply');
  assert.deepEqual(res.ops, []);
  assert.deepEqual(res.batches, []);
  assert.equal(readTracker(), t);
  assert.equal(readStatusLog(), l);
});

test('note-only request appends the note and keeps the status', () => {
  const { results } = run([req('n1', { type: 'note', ref: 3, note: '--looks like a flag' })]);
  assert.equal(results[0].state, 'applied');
  assert.match(row3(), /\|\s*Applied\s*\|/);
  assert.match(row3(), /--looks like a flag/);
});

// ---- I1: order and stale-status guard ----
test('two status requests on one row apply in created_at order, whatever the input order', () => {
  const a = st('ffff-a', 3, 'Applied', 'Interview', { created_at: '2026-11-26T18:00:00Z' });
  const b = st('0000-b', 3, 'Interview', 'Offer', { created_at: '2026-11-26T18:05:00Z' });
  const { results } = run([b, a]);
  assert.deepEqual(results.map((r) => [r.id, r.state]), [['ffff-a', 'applied'], ['0000-b', 'applied']]);
  assert.match(row3(), /\|\s*Offer\s*\|/);
  const log = readStatusLog().split('\n').filter((x) => x.startsWith('3\t2026-11-26'));
  assert.deepEqual(log.map((x) => x.split('\t').slice(2, 4).join('>')), ['Applied>Interview', 'Interview>Offer']);
});

test('same created_at: the id breaks the tie', () => {
  const a = st('a1', 3, 'Applied', 'Interview');
  const b = st('b2', 3, 'Interview', 'Offer');
  const { results } = run([b, a]);
  assert.deepEqual(results.map((r) => r.id), ['a1', 'b2']);
  assert.match(row3(), /\|\s*Offer\s*\|/);
});

test('a request whose from_status no longer matches is rejected without writing', () => {
  const t = readTracker(), l = readStatusLog();
  const { results } = run([st('old', 3, 'Responded', 'Interview')]);
  assert.equal(results[0].state, 'rejected');
  assert.match(results[0].reason, /Applied/);
  assert.equal(results[0].from_status_seen, 'Applied');
  assert.equal(readTracker(), t);
  assert.equal(readStatusLog(), l);
});

test('a re-applied older request cannot undo a newer change', () => {
  run([st('a', 3, 'Applied', 'Interview', { created_at: '2026-11-26T18:00:00Z' }), st('b', 3, 'Interview', 'Offer', { created_at: '2026-11-26T18:05:00Z' })]);
  const t = readTracker();
  const { results } = run([st('a', 3, 'Applied', 'Interview', { created_at: '2026-11-26T18:00:00Z' })]);
  assert.equal(results[0].state, 'rejected');
  assert.equal(readTracker(), t);
});

test('a status request without from_status is rejected with a clear reason', () => {
  const t = readTracker();
  const { results } = run([req('nf', { type: 'status', ref: 3, to_status: 'Interview' })]);
  assert.equal(results[0].state, 'rejected');
  assert.match(results[0].reason, /from_status/);
  const bad = run([st('nf2', 3, 'Bogus', 'Interview')]).results[0];
  assert.equal(bad.state, 'rejected');
  assert.match(bad.reason, /from_status/);
  assert.equal(readTracker(), t);
});

// ---- I2: db_query line format in, db_write ops out ----
test('line-format input: summary ignored, merge ops carry ifVersion and the result fields only', () => {
  const text = 'Résultat de la requête :\n' + lines([
    st('r1', 3, 'Applied', 'Interview'),
    st('done', 4, 'Applied', 'Offer', { state: 'applied' }),
    req('bad', { type: 'bogus', ref: 3 }),
  ]);
  const res = run(text);
  assert.deepEqual(res.results.map((r) => [r.id, r.state]), [['bad', 'rejected'], ['r1', 'applied']]); // same created_at: id order
  assert.equal(res.batches.length, 1);
  assert.deepEqual(res.batches[0], res.ops);
  const byPath = Object.fromEntries(res.ops.map((o) => [o.path, o]));
  assert.deepEqual(Object.keys(byPath).sort(), ['requests/bad', 'requests/r1']);
  const op = byPath['requests/r1'];
  assert.equal(op.op, 'merge');
  assert.equal(op.ifVersion, 7);
  assert.deepEqual(Object.keys(op.data).sort(), ['applied_at', 'from_status_seen', 'reason', 'state']);
  assert.equal(op.data.state, 'applied');
  assert.equal(op.data.from_status_seen, 'Applied');
  assert.equal(byPath['requests/bad'].ifVersion, 9);
  assert.deepEqual(Object.keys(byPath['requests/bad'].data).sort(), ['applied_at', 'reason', 'state']);
  assert.match(row3(), /\|\s*Interview\s*\|/);
});

test('more than 50 results are split into batches of at most 50 ops', () => {
  const many = Array.from({ length: 61 }, (_, i) => req(`x${String(i).padStart(2, '0')}`, { type: 'bogus', ref: 3 }));
  const res = run(lines(many));
  assert.equal(res.results.length, 61);
  assert.deepEqual(res.batches.map((b) => b.length), [50, 11]);
  assert.deepEqual(res.batches.flat(), res.ops);
});

// ---- M2: the request date is the Paris calendar day ----
test('--on is the Europe/Paris day of created_at (23:30 UTC is already the next day)', () => {
  const { results } = run([st('late', 3, 'Applied', 'Interview', { created_at: '2026-03-14T23:30:00Z' })], [], { TZ: 'UTC' });
  assert.equal(results[0].state, 'applied');
  assert.match(readStatusLog(), /^3\t2026-03-15\t/m);
});

test('a request made just now is not "in the future" for set-status, whatever TZ the caller runs in', () => {
  const now = new Date().toISOString();
  const day = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date(now));
  const { results } = run([st('now', 3, 'Applied', 'Interview', { created_at: now })], [], { TZ: 'Etc/GMT+12' });
  assert.equal(results[0].state, 'applied', results[0].reason);
  assert.match(readStatusLog(), new RegExp(`^3\\t${day}\\t`, 'm'));
});

// ---- contract: the exact body the page writes is accepted ----
// `calls(CapData)` makes the requests; returns every body the page wrote, in order.
async function pageBodies(calls = async (CapData) => {
  await CapData.requestStatus(3, 'Interview');
  await CapData.requestNote(3, 'Relancer\nvendredi');
}) {
  const written = [];
  const store = {
    'snapshot/meta': { schema: 1, generation: 'g', generated_at: '2026-11-26T10:00:00Z', companies: [], parts: ['snapshot/apps-g-0'] },
    'snapshot/apps-g-0': { generation: 'g', items: [{ num: 3, company: 'Cobalt SAS', status: 'Applied' }] },
  };
  const qs = (prefix) => ({ docs: Object.entries(store).filter(([k]) => k.startsWith(prefix + '/')).map(([k, v]) => ({ id: k.split('/')[1], data: () => v })), metadata: { fromCache: false } });
  const db = {
    collection: (name) => ({
      onSnapshot: (next) => { Promise.resolve().then(() => next(qs(name))); return () => {}; },
      doc: (id) => ({ set: async (body) => { written.push({ id, body: JSON.parse(JSON.stringify(body)) }); } }),
    }),
    doc: () => ({ onSnapshot: (next) => { Promise.resolve().then(() => next({ exists: false, data: () => undefined })); return () => {}; } }),
  };
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, crypto: globalThis.crypto, TextEncoder, claude: { use: async () => db } });
  vm.runInContext(readFileSync(join(HERE, '..', 'page', 'js', 'data.js'), 'utf8'), ctx);
  const CapData = ctx.CapData;
  CapData.start(() => {});
  await new Promise((r) => setTimeout(r, 20));
  await calls(CapData);
  CapData.stop();
  return written;
}

test('contract: the bodies CapData.requestStatus / requestNote write are accepted by apply-requests', async () => {
  const written = await pageBodies();
  assert.equal(written.length, 2);
  assert.equal(written[0].body.from_status, 'Applied');
  const res = run(lines(written.map((w) => ({ id: w.id, data: w.body }))));
  assert.deepEqual(res.results.map((r) => r.state), ['applied', 'applied'], JSON.stringify(res.results));
  assert.match(row3(), /\|\s*Interview\s*\|/);
  assert.match(row3(), /Relancer vendredi/);
});

// ---- why / retouche: the dossier store only, never the tracker ----
const dossiersFile = () => join(root(), 'data/dossiers.json');
const readStore = () => JSON.parse(readFileSync(dossiersFile(), 'utf8'));
const why = (id, ref, text, extra = {}) => req(id, { type: 'why', ref, text, ...extra });
const retouche = (id, ref, text, extra = {}) => req(id, { type: 'retouche', ref, text, ...extra });

test('the dossiers fixture matches the Dossier contract', () => {
  const store = readStore();
  assert.equal(store.schema, 1);
  for (const [num, d] of Object.entries(store.dossiers)) assert.equal(validateDossier(d), null, `dossier ${num}`);
});

test('a why request sets letter.why in dossiers.json, without set-status', () => {
  const trackerMtime = statSync(join(root(), 'data/applications.md')).mtimeMs;
  const t = readTracker(), l = readStatusLog();
  const { results, ops } = run([why('w1', 1, '  Leur   produit sert les équipes terrain.  ', { created_at: '2026-11-26T19:00:00Z' })]);
  assert.equal(results[0].state, 'applied', results[0].reason);
  assert.equal(results[0].reason, null);
  assert.ok(results[0].applied_at);
  const d = readStore().dossiers['1'];
  assert.equal(d.letter.why, 'Leur produit sert les équipes terrain.');
  assert.equal(d.letter.why_at, '2026-11-26T19:00:00Z');
  assert.equal(d.state, 'pret');
  assert.equal(validateDossier(d), null);
  assert.equal(statSync(join(root(), 'data/applications.md')).mtimeMs, trackerMtime);
  assert.equal(readTracker(), t);
  assert.equal(readStatusLog(), l);
  assert.deepEqual(Object.keys(ops[0].data).sort(), ['applied_at', 'reason', 'state']);
});

test('why / retouche texts with a line break, over 500 characters, a control character or empty are rejected', () => {
  const before = readFileSync(dossiersFile(), 'utf8');
  const { results } = run([
    why('t1', 1, 'Première ligne\nseconde ligne'),
    why('t2', 1, 'x'.repeat(501)),
    retouche('t3', 1, 'Ajouter\u0007 un chiffre'),
    retouche('t4', 1, '   '),
    why('t5', 1, ''),
    why('t6', 1, 42),
    retouche('t7', 1, undefined),
  ]);
  assert.deepEqual(results.map((r) => [r.id, r.state]), ['t1', 't2', 't3', 't4', 't5', 't6', 't7'].map((id) => [id, 'rejected']));
  assert.ok(results.every((r) => typeof r.reason === 'string' && r.reason && r.applied_at === null), JSON.stringify(results));
  assert.match(results[0].reason, /control/);
  assert.match(results[1].reason, /500/);
  assert.equal(readFileSync(dossiersFile(), 'utf8'), before);
});

test('a why / retouche request for an application without a dossier is rejected', () => {
  const before = readFileSync(dossiersFile(), 'utf8');
  const { results } = run([why('nd1', 2, 'Une bonne raison.'), retouche('nd2', 3, 'Raccourcir le message.')]);
  assert.deepEqual(results.map((r) => [r.state, r.reason]), [
    ['rejected', 'no dossier for this application'],
    ['rejected', 'no dossier for this application'],
  ]);
  assert.equal(readFileSync(dossiersFile(), 'utf8'), before);
});

test('no dossiers.json at all: the request is rejected, nothing is created', () => {
  rmSync(dossiersFile());
  const { results } = run([why('nf', 1, 'Une bonne raison.')]);
  assert.equal(results[0].state, 'rejected');
  assert.equal(results[0].reason, 'no dossier for this application');
  assert.equal(existsSync(dossiersFile()), false);
});

test('a retouche request appends the entry and sends the dossier back to a_refaire', () => {
  const { results } = run([retouche('rt1', 6, 'Mettre la roadmap en avant.', { created_at: '2026-11-26T20:15:00Z' })]);
  assert.equal(results[0].state, 'applied', results[0].reason);
  const store = readStore();
  const d = store.dossiers['6'];
  assert.equal(d.state, 'a_refaire');
  assert.deepEqual(d.retouches, [{ text: 'Mettre la roadmap en avant.', at: '2026-11-26T20:15:00Z', done_at: null }]);
  assert.equal(validateDossier(d), null);
  assert.equal(store.dossiers['1'].state, 'pret'); // the other dossier is untouched
});

test('mixed batch: created_at order, one write of the store, status still through set-status', () => {
  const { results } = run([
    retouche('m-b', 1, 'Second ajout.', { created_at: '2026-11-26T18:02:00Z' }),
    st('m-s', 3, 'Applied', 'Interview', { created_at: '2026-11-26T18:01:00Z' }),
    retouche('m-a', 1, 'Premier ajout.', { created_at: '2026-11-26T18:00:00Z' }),
    why('m-w', 1, 'Raison.', { created_at: '2026-11-26T18:03:00Z' }),
    why('m-x', 2, 'Sans dossier.', { created_at: '2026-11-26T18:04:00Z' }),
  ]);
  assert.deepEqual(results.map((r) => [r.id, r.state]), [
    ['m-a', 'applied'], ['m-s', 'applied'], ['m-b', 'applied'], ['m-w', 'applied'], ['m-x', 'rejected'],
  ]);
  const d = readStore().dossiers['1'];
  assert.deepEqual(d.retouches.map((r) => r.text), ['Premier ajout.', 'Second ajout.']);
  assert.equal(d.letter.why, 'Raison.');
  assert.equal(d.state, 'a_refaire');
  assert.match(row3(), /\|\s*Interview\s*\|/);
  const leftovers = readdirSync(join(root(), 'data')).filter((f) => f.endsWith('.tmp'));
  assert.deepEqual(leftovers, []);
});

test('--dry-run: why / retouche give would_apply and write nothing', () => {
  const before = readFileSync(dossiersFile(), 'utf8');
  const res = run([why('d1', 1, 'Une bonne raison.'), retouche('d2', 6, 'Raccourcir.'), why('d3', 2, 'Sans dossier.')], ['--dry-run']);
  assert.deepEqual(res.results.map((r) => [r.id, r.state]), [['d1', 'would_apply'], ['d2', 'would_apply'], ['d3', 'rejected']]);
  assert.ok(res.results.slice(0, 2).every((r) => r.reason === null && r.applied_at === null));
  assert.deepEqual(res.ops, []);
  assert.equal(readFileSync(dossiersFile(), 'utf8'), before);
});

test('an unreadable dossiers.json rejects the why / retouche requests and is left as is', () => {
  writeFileSync(dossiersFile(), '{ not json');
  const { results } = run([why('u1', 1, 'Une bonne raison.'), st('u2', 3, 'Applied', 'Interview')]);
  assert.equal(results.find((r) => r.id === 'u1').state, 'rejected');
  assert.match(results.find((r) => r.id === 'u1').reason, /dossiers\.json/);
  assert.equal(results.find((r) => r.id === 'u2').state, 'applied');
  assert.equal(readFileSync(dossiersFile(), 'utf8'), '{ not json');
});

// Contract with the page: the exact objects CapData.requestWhy / requestRetouche write ({type, ref, text, created_at,
// state: 'pending'}, the text typed with line breaks), read back through db_query.
test('contract: the why / retouche bodies CapData.requestWhy / requestRetouche write are accepted by apply-requests', async () => {
  const written = await pageBodies(async (CapData) => {
    await CapData.requestWhy(1, 'Leur produit\nsert les équipes terrain.');
    await new Promise((r) => setTimeout(r, 5)); // distinct created_at: the run applies requests in created_at order
    await CapData.requestRetouche(1, '  Ajouter un chiffre\r\nclé.  ');
  });
  assert.deepEqual(written.map((w) => [w.body.type, w.body.text]), [['why', 'Leur produit sert les équipes terrain.'], ['retouche', 'Ajouter un chiffre clé.']]);
  assert.deepEqual(Object.keys(written[0].body).sort(), ['created_at', 'ref', 'state', 'text', 'type']);
  const res = run(lines(written.map((w) => ({ id: w.id, data: w.body }))));
  assert.deepEqual(res.results.map((r) => [r.id, r.state]), written.map((w) => [w.id, 'applied']), JSON.stringify(res.results));
  assert.deepEqual(res.ops.map((o) => [o.path, o.ifVersion]), [[`requests/${written[0].id}`, 7], [`requests/${written[1].id}`, 8]]);
  const d = readStore().dossiers['1'];
  assert.equal(d.letter.why, 'Leur produit sert les équipes terrain.');
  assert.equal(d.retouches.at(-1).text, 'Ajouter un chiffre clé.');
  assert.equal(d.state, 'a_refaire');
});
