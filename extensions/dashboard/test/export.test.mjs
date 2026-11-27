import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, mkdtempSync, writeFileSync, rmSync, cpSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURE_ROOT } from './helpers.mjs';

const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

function hashTree(dir) {
  const h = createHash('sha256');
  const walk = (d) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) walk(p);
      else { h.update(relative(dir, p)); h.update(readFileSync(p)); }
    }
  };
  walk(dir);
  return h.digest('hex');
}

const run = (args = []) => execFileSync('node', ['extensions/dashboard/export.mjs', ...args], {
  cwd: REPO,
  env: { ...process.env, CAREER_OPS_ROOT: FIXTURE_ROOT, CAREER_OPS_TRACKER: '' },
}).toString();

test('export CLI runs read-only against fixture root', () => {
  const before = hashTree(FIXTURE_ROOT);
  const out = run();
  const { docs } = JSON.parse(out);
  assert.ok(docs.length >= 4);
  assert.equal(docs[0].path, 'snapshot/meta');
  assert.equal(hashTree(FIXTURE_ROOT), before);
});

test('export CLI --summary prints one line per document', () => {
  const docs = JSON.parse(run()).docs;
  const lines = run(['--summary']).trim().split('\n');
  assert.equal(lines.length, docs.length);
  assert.match(lines[0], /^snapshot\/meta\s+\d+/);
});

test('export CLI --sync-plan --current: parts first, then the meta flip with ifVersion and the old deletes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'dash-export-'));
  try {
    const current = join(dir, 'current.txt');
    writeFileSync(current, '{"collection":"snapshot","count":2}\n'
      + '{"id":"meta","data":{"parts":["snapshot/apps-0"]},"version":4,"updatedAt":"2026-11-26T10:00:00Z"}\n'
      + '{"id":"apps-0","data":{"generation":"old","items":[]},"version":2,"updatedAt":"2026-11-26T10:00:00Z"}\n');
    const before = hashTree(FIXTURE_ROOT);
    const { batches } = JSON.parse(run(['--sync-plan', '--current', current]));
    assert.equal(hashTree(FIXTURE_ROOT), before);
    const flat = batches.flat();
    const metaAt = flat.findIndex((o) => o.path === 'snapshot/meta');
    const meta = flat[metaAt];
    assert.equal(meta.op, 'set');
    assert.equal(meta.ifVersion, 4);
    assert.deepEqual(flat.slice(0, metaAt).map((o) => o.path), meta.data.parts);
    assert.ok(flat.slice(0, metaAt).every((o) => o.op === 'set' && !('ifVersion' in o) && o.data.generation === meta.data.generation));
    assert.deepEqual(flat.slice(metaAt + 1), [{ op: 'delete', path: 'snapshot/apps-0', ifVersion: 2 }]);
    assert.ok(batches.every((b) => b.length <= 50));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('export CLI --sync-plan without --current refuses (it would leave old parts behind)', () => {
  assert.throws(() => execFileSync('node', ['extensions/dashboard/export.mjs', '--sync-plan'], {
    cwd: REPO, env: { ...process.env, CAREER_OPS_ROOT: FIXTURE_ROOT, CAREER_OPS_TRACKER: '' }, stdio: 'pipe',
  }), /--current/);
});

// ---- CV links: export reads {DATA_ROOT}/data/dashboard.json and hashes the recorded files (temp copies only) ----
const ASSET = 'f00dfeed0123456789abcdef01234567';
const PAGE = 'f00dfeed0123456789abcdef0123pg01';
const sha = (s) => createHash('sha256').update(s).digest('hex');
function withRoot(fn) {
  const dir = mkdtempSync(join(tmpdir(), 'dash-cv-'));
  try {
    const root = join(dir, 'root');
    cpSync(FIXTURE_ROOT, root, { recursive: true });
    mkdirSync(join(root, 'output'), { recursive: true });
    return fn(root, dir);
  } finally { rmSync(dir, { recursive: true, force: true }); }
}
const appsAt = (root) => {
  const out = execFileSync('node', ['extensions/dashboard/export.mjs'], {
    cwd: REPO, env: { ...process.env, CAREER_OPS_ROOT: root, CAREER_OPS_TRACKER: '', CAREER_OPS_DATA_DIR: '', CAREER_OPS_PROFILE: '' },
  }).toString();
  const apps = JSON.parse(out).docs.filter((d) => d.path.startsWith('snapshot/apps-')).flatMap((d) => d.data.items);
  return Object.fromEntries(apps.map((a) => [a.num, a]));
};

test('export CLI: cv_url from data/dashboard.json, cv_stale from the PDF on disk', () => withRoot((root, dir) => {
  writeFileSync(join(root, 'output', 'cv-cobalt.pdf'), '%PDF-1.4 fictional cobalt');
  writeFileSync(join(root, 'output', 'cv-delta.pdf'), '%PDF-1.4 fictional delta, regenerated');
  writeFileSync(join(dir, 'outside.pdf'), 'outside the data root');
  writeFileSync(join(root, 'data', 'dashboard.json'), JSON.stringify({ slug: 'fictional', cv_assets: {
    3: { asset_id: ASSET, file: 'output/cv-cobalt.pdf', sha256: sha('%PDF-1.4 fictional cobalt') }, // same file: fresh
    4: { asset_id: ASSET, file: 'output/cv-delta.pdf', sha256: sha('%PDF-1.4 fictional delta') }, // regenerated: stale
    5: { asset_id: ASSET, file: 'output/missing.pdf', sha256: sha('x') }, // missing file: unknown
    6: { asset_id: 'javascript:alert(1)', file: 'output/cv-cobalt.pdf', sha256: sha('x') }, // invalid id: no link
    7: { asset_id: ASSET, file: '../outside.pdf', sha256: sha('x') }, // outside the data root: never hashed
    8: { asset_id: ASSET, file: 'output/cv-delta.pdf', sha256: sha('%PDF-1.4 fictional delta'), pages: [PAGE, 'javascript:alert(1)'] }, // PNG pages
  } }));
  const before = hashTree(root);
  const a = appsAt(root);
  assert.equal(hashTree(root), before, 'export stays read-only');
  assert.deepEqual([a[3].cv_url, a[3].cv_stale], [`/_blob/${ASSET}`, false]);
  assert.deepEqual([a[4].cv_url, a[4].cv_stale], [`/_blob/${ASSET}`, true]);
  assert.deepEqual([a[5].cv_url, a[5].cv_stale], [`/_blob/${ASSET}`, null]);
  assert.deepEqual([a[6].cv_url, a[6].cv_stale], [null, null]);
  assert.deepEqual([a[7].cv_url, a[7].cv_stale], [`/_blob/${ASSET}`, null]);
  assert.deepEqual([a[2].cv_url, a[2].cv_stale], [null, null]);
  assert.deepEqual([a[8].cv_pages, a[8].cv_stale], [[`/_blob/${PAGE}`], true]);
  assert.ok([2, 3, 4, 5, 6, 7].every((n) => Array.isArray(a[n].cv_pages) && a[n].cv_pages.length === 0));
}));

test('export CLI: malformed or absent data/dashboard.json -> no crash, cv_url null everywhere', () => withRoot((root) => {
  rmSync(join(root, 'data', 'dashboard.json'), { force: true });
  assert.ok(Object.values(appsAt(root)).every((x) => x.cv_url === null && x.cv_stale === null));
  writeFileSync(join(root, 'data', 'dashboard.json'), '{"slug": "fictional", "cv_assets": {"3": ');
  const a = appsAt(root);
  assert.equal(Object.keys(a).length, 8);
  assert.ok(Object.values(a).every((x) => x.cv_url === null && x.cv_stale === null));
}));

test('export CLI: the fixture root links app 1 to its fictional CV asset', () => {
  const items = JSON.parse(run()).docs.filter((d) => d.path.startsWith('snapshot/apps-')).flatMap((d) => d.data.items);
  assert.equal(items.find((x) => x.num === 1).cv_url, '/_blob/0123456789abcdef0123456789abcdef');
  assert.deepEqual(items.find((x) => x.num === 1).cv_pages, ['/_blob/0123456789abcdef0123456789abcd01', '/_blob/0123456789abcdef0123456789abcd02']);
  assert.deepEqual(items.find((x) => x.num === 8).cv_pages, []); // hostile page ids dropped
});

// ---- Dossiers, strategy sheets, letters, proposals and follow-up texts (data/*.json, output/*-strategie.json) ----
const exportAt = (root) => {
  const r = spawnSync('node', ['extensions/dashboard/export.mjs'], {
    cwd: REPO, encoding: 'utf8',
    env: { ...process.env, CAREER_OPS_ROOT: root, CAREER_OPS_TRACKER: '', CAREER_OPS_DATA_DIR: '', CAREER_OPS_PROFILE: '' },
  });
  assert.equal(r.status, 0, r.stderr);
  const { docs } = JSON.parse(r.stdout);
  const items = (kind) => docs.filter((d) => d.path.startsWith(`snapshot/${kind}-`)).flatMap((d) => d.data.items);
  return {
    stderr: r.stderr,
    apps: Object.fromEntries(items('apps').map((a) => [a.num, a])),
    proposals: items('proposals'),
    meta: docs.find((d) => d.path === 'snapshot/meta').data,
  };
};
const LETTER = 'f00dfeed0123456789abcdef0123lt01';
const readJson = (root, rel) => JSON.parse(readFileSync(join(root, rel), 'utf8'));
const writeJson = (root, rel, v) => writeFileSync(join(root, rel), JSON.stringify(v));

test('export CLI: the fixture root gives app 1 its dossier and strategy, quietly', () => {
  const r = exportAt(FIXTURE_ROOT);
  assert.equal(r.stderr, '');
  const d = r.apps[1].dossier;
  assert.equal(d.strategy.titre_cv, 'Product Manager');
  assert.deepEqual([d.state, d.letter_state, d.has_why, d.check_ok, d.retouche_pending], ['pret', 'a_completer', false, true, false]);
  assert.equal(r.apps[6].dossier.strategy, null); // its sheet file does not exist
  assert.equal(r.apps[6].dossier.state, 'a_verifier');
  assert.ok([2, 3, 4, 5, 7, 8].every((n) => r.apps[n].dossier === null));
  assert.deepEqual(r.proposals, []); // same status, unknown ref, invalid id
  assert.match(r.meta.followups_due.find((f) => f.num === 2).text, /^Bonjour,\n\nJe me permets/);
});

test('export CLI: a proposal whose status differs is exported with its company and current status', () => withRoot((root) => {
  const doc = readJson(root, 'data/proposals.json');
  doc.items.push({ id: 'p-2a1b2c3d4e5f6071', ref: 6, to_status: 'Offer',
    evidence: { from: 'rh@foxtrot.example', date: '2026-11-27T08:00:00Z', subject: 'Proposition', excerpt: 'Nous avons le plaisir de vous faire une offre.' } });
  writeJson(root, 'data/proposals.json', doc);
  const r = exportAt(root);
  assert.deepEqual(r.proposals, [{ id: 'p-2a1b2c3d4e5f6071', ref: 6, company: 'Foxtrot', from_status: 'Interview', to_status: 'Offer',
    evidence: { from: 'rh@foxtrot.example', date: '2026-11-27T08:00:00Z', subject: 'Proposition', excerpt: 'Nous avons le plaisir de vous faire une offre.' } }]);
  assert.ok(r.meta.parts.some((p) => p.startsWith('snapshot/proposals-')));
}));

test('export CLI: a corrupted dossiers.json does not stop the export (stderr warning, dossier null)', () => withRoot((root) => {
  writeFileSync(join(root, 'data', 'dossiers.json'), '{"schema": 1, "dossiers": {"1": ');
  const r = exportAt(root);
  assert.match(r.stderr, /dossiers\.json/);
  assert.equal(Object.keys(r.apps).length, 8);
  assert.ok(Object.values(r.apps).every((a) => a.dossier === null));
}));

test('export CLI: invalid proposals, relances or strategy files warn and give empty values', () => withRoot((root) => {
  writeFileSync(join(root, 'data', 'proposals.json'), '[not json');
  writeJson(root, 'data/relances.json', { schema: 1, items: [] });
  writeFileSync(join(root, 'output', '001-acme-strategie.json'), '{"titre_cv": ');
  const r = exportAt(root);
  assert.match(r.stderr, /proposals\.json/);
  assert.match(r.stderr, /relances\.json/);
  assert.match(r.stderr, /001-acme-strategie\.json/);
  assert.deepEqual(r.proposals, []);
  assert.ok(r.meta.followups_due.every((f) => !('text' in f)));
  assert.equal(r.apps[1].dossier.strategy, null);
  assert.equal(r.apps[1].dossier.state, 'pret');
}));

test('export CLI: absent dossiers, proposals and relances files give empty values, no warning', () => withRoot((root) => {
  for (const f of ['dossiers.json', 'proposals.json', 'relances.json']) rmSync(join(root, 'data', f));
  const r = exportAt(root);
  assert.equal(r.stderr, '');
  assert.ok(Object.values(r.apps).every((a) => a.dossier === null));
  assert.deepEqual(r.proposals, []);
  assert.ok(r.meta.followups_due.every((f) => !('text' in f)));
}));

test('export CLI: a strategy path that is not a regular file is not read', () => withRoot((root) => {
  mkdirSync(join(root, 'output', '006-foxtrot-strategie.json'));
  const r = exportAt(root);
  assert.equal(r.stderr, '');
  assert.equal(r.apps[6].dossier.strategy, null);
}));

test('export CLI: letter_stale is true when the letter PDF changed since its upload', () => withRoot((root, dir) => {
  writeFileSync(join(root, 'output', '001-acme-lettre.pdf'), '%PDF-1.4 fictional letter, regenerated');
  writeFileSync(join(root, 'output', '006-foxtrot-lettre.pdf'), '%PDF-1.4 fictional foxtrot letter');
  writeFileSync(join(dir, 'outside.pdf'), '%PDF-1.4 fictional foxtrot letter');
  const dash = readJson(root, 'data/dashboard.json');
  Object.assign(dash.cv_assets['1'], { letter_asset_id: LETTER, letter_file: 'output/001-acme-lettre.pdf',
    letter_sha256: sha('%PDF-1.4 fictional letter'), letter_pages: [PAGE] });
  dash.cv_assets['6'] = { letter_asset_id: LETTER, letter_file: 'output/006-foxtrot-lettre.pdf', letter_sha256: sha('%PDF-1.4 fictional foxtrot letter'), letter_pages: [PAGE] };
  writeJson(root, 'data/dashboard.json', dash);
  const before = hashTree(root);
  const r = exportAt(root);
  assert.equal(hashTree(root), before, 'export stays read-only');
  const d1 = r.apps[1].dossier;
  assert.deepEqual([d1.letter_url, d1.letter_pages, d1.letter_stale], [`/_blob/${LETTER}`, [`/_blob/${PAGE}`], true]);
  assert.equal(r.apps[1].cv_url, '/_blob/0123456789abcdef0123456789abcdef');
  assert.equal(r.apps[6].dossier.letter_stale, false);
  dash.cv_assets['6'].letter_file = '../outside.pdf';
  writeJson(root, 'data/dashboard.json', dash);
  assert.equal(exportAt(root).apps[6].dossier.letter_stale, null); // outside the data root: never hashed
}));

// ---- R9: a maximal dossier fits in one part; an oversize one loses its dossier, not the export ----
function maximalDossier(root, ch) {
  const long = ch.repeat(600);
  const twelve = (f) => Array.from({ length: 12 }, (_, i) => f(i));
  writeJson(root, 'output/001-acme-strategie.json', {
    titre_cv: long, angle: long, lettre_angle: long,
    preuves: twelve(() => ({ texte: long, source: `cv.md ${long}` })),
    mots_cles_repris: twelve(() => long),
    mots_cles_ecartes: twelve(() => ({ mot: long, raison: long })),
    ecarts: twelve(() => ({ exigence: long, traitement: long })),
    verification: { ok: false, reasons: twelve(() => long) },
  });
  const store = readJson(root, 'data/dossiers.json');
  Object.assign(store.dossiers['1'], {
    message: ch.repeat(1200),
    answers: Array.from({ length: 40 }, () => ({ q: ch.repeat(2000), a: ch.repeat(5000) })),
    check: { ok: false, reasons: Array.from({ length: 40 }, () => ch.repeat(2000)) },
  });
  writeJson(root, 'data/dossiers.json', store);
}

test('export CLI (R9): a dossier with every field at its maximum exports, and its app item fits in a part', () => withRoot((root) => {
  maximalDossier(root, 'x');
  const r = exportAt(root);
  assert.equal(r.stderr, '');
  const a = r.apps[1];
  assert.equal(a.dossier.strategy.preuves.length, 8);
  assert.equal(a.dossier.answers.length, 12);
  const itemBytes = Buffer.byteLength(JSON.stringify(a));
  assert.ok(itemBytes < 60000, `${itemBytes} bytes`);
}));

test('export CLI (R9): an app item still too large for a part loses its dossier with a warning', () => withRoot((root) => {
  maximalDossier(root, '\u{1F600}'); // 4 bytes per character in UTF-8
  const r = exportAt(root);
  assert.match(r.stderr, /app 1: dossier left out/);
  assert.equal(r.apps[1].dossier, null);
  assert.equal(r.apps[1].company, 'Acme');
  assert.equal(r.apps[6].dossier.state, 'a_verifier');
  assert.equal(Object.keys(r.apps).length, 8);
}));
