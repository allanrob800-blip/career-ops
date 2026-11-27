import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
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
});
