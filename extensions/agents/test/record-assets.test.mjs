import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, copyFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { recordAssets } from '../record-assets.mjs';
import { parseCvAssets } from '../../dashboard/lib/snapshot.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const PDF = join(HERE, 'fixtures', 'one-page.pdf');
const PDF_SHA = createHash('sha256').update(readFileSync(PDF)).digest('hex');
const CLI = 'extensions/agents/record-assets.mjs';
const CV_FILE = 'output/003-exemple-cv.pdf';
const LETTER_FILE = 'output/003-exemple-lettre.pdf';

const DASHBOARD = {
  slug: '00000000-0000-4000-8000-000000000000',
  url: 'https://claude.ai/artifact/00000000-0000-4000-8000-000000000000',
  published: { version: 'v-exemple', at: '2026-11-20T08:00:00Z' },
  cv_assets: {
    3: { asset_id: 'oldPdfAsset01', file: CV_FILE, sha256: 'a'.repeat(64), pages: ['oldPageAsset01'],
      letter_asset_id: 'oldLetterPdf01', letter_file: LETTER_FILE, letter_sha256: 'b'.repeat(64), letter_pages: ['oldLetterPage1'] },
    5: { asset_id: 'otherPdfAsset5', file: 'output/005-autre-cv.pdf', sha256: 'c'.repeat(64), pages: ['otherPageAss5'] },
  },
};

// A data root with data/dashboard.json and the fixture PDF as the CV and the letter of application 3.
function tempRoot(t, dashboard = DASHBOARD) {
  const root = mkdtempSync(join(tmpdir(), 'agents-assets-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'data'));
  mkdirSync(join(root, 'output'));
  copyFileSync(PDF, join(root, CV_FILE));
  copyFileSync(PDF, join(root, LETTER_FILE));
  if (dashboard !== null) writeFileSync(join(root, 'data', 'dashboard.json'), typeof dashboard === 'string' ? dashboard : JSON.stringify(dashboard, null, 2));
  return root;
}
const readDashboard = (root) => JSON.parse(readFileSync(join(root, 'data', 'dashboard.json'), 'utf8'));
const uploaded = (...ids) => ids.map((opaque_id, i) => ({
  opaque_id, url: `/_blob/${opaque_id}`, content_type: i === 0 ? 'application/pdf' : 'image/png',
}));

test('recordAssets kind cv writes asset_id, file, sha256 and pages, and keeps every other key', (t) => {
  const root = tempRoot(t);
  const entry = recordAssets({ root, num: 3, kind: 'cv', pdfPath: CV_FILE, uploaded: uploaded('newPdfAsset01', 'newPage1Asset', 'newPage2Asset') });
  const doc = readDashboard(root);
  const expected = {
    ...DASHBOARD.cv_assets[3],
    asset_id: 'newPdfAsset01', file: CV_FILE, sha256: PDF_SHA, pages: ['newPage1Asset', 'newPage2Asset'],
  };
  assert.deepEqual(doc.cv_assets['3'], expected);
  assert.deepEqual(entry, expected);
  assert.deepEqual(doc.cv_assets['5'], DASHBOARD.cv_assets[5]);
  assert.deepEqual({ ...doc, cv_assets: null }, { ...DASHBOARD, cv_assets: null });
  assert.deepEqual(readdirSync(join(root, 'data')), ['dashboard.json'], 'no temporary file is left');
  assert.deepEqual(parseCvAssets(readFileSync(join(root, 'data', 'dashboard.json'), 'utf8'))['3'].pages, ['newPage1Asset', 'newPage2Asset']);
});

test('recordAssets kind letter writes the letter_* fields and leaves the CV fields alone', (t) => {
  const root = tempRoot(t);
  recordAssets({ root, num: 3, kind: 'letter', pdfPath: join(root, LETTER_FILE), uploaded: uploaded('letterPdfNew1', 'letterPageNew1') });
  const doc = readDashboard(root);
  assert.deepEqual(doc.cv_assets['3'], {
    ...DASHBOARD.cv_assets[3],
    letter_asset_id: 'letterPdfNew1', letter_file: LETTER_FILE, letter_sha256: PDF_SHA, letter_pages: ['letterPageNew1'],
  });
  assert.deepEqual(doc.cv_assets['5'], DASHBOARD.cv_assets[5]);
});

test('recordAssets adds an entry for a new application, and creates dashboard.json when it is absent', (t) => {
  const root = tempRoot(t);
  recordAssets({ root, num: 7, kind: 'letter', pdfPath: LETTER_FILE, uploaded: uploaded('letterPdfNew7', 'letterPageNew7') });
  assert.deepEqual(readDashboard(root).cv_assets['7'], {
    letter_asset_id: 'letterPdfNew7', letter_file: LETTER_FILE, letter_sha256: PDF_SHA, letter_pages: ['letterPageNew7'],
  });
  const bare = tempRoot(t, null);
  recordAssets({ root: bare, num: 3, kind: 'cv', pdfPath: CV_FILE, uploaded: uploaded('newPdfAsset01', 'newPage1Asset') });
  assert.deepEqual(readDashboard(bare), {
    cv_assets: { 3: { asset_id: 'newPdfAsset01', file: CV_FILE, sha256: PDF_SHA, pages: ['newPage1Asset'] } },
  });
});

test('recordAssets refuses an asset id outside ^[A-Za-z0-9_-]{8,128}$ and writes nothing', (t) => {
  const root = tempRoot(t);
  const before = readFileSync(join(root, 'data', 'dashboard.json'), 'utf8');
  for (const bad of ['short', 'has space id', '../../etc/x', 'x'.repeat(129), 42, undefined]) {
    assert.throws(() => recordAssets({ root, num: 3, kind: 'cv', pdfPath: CV_FILE, uploaded: uploaded('newPdfAsset01', bad) }), /asset id/, String(bad));
    assert.throws(() => recordAssets({ root, num: 3, kind: 'cv', pdfPath: CV_FILE, uploaded: uploaded(bad, 'newPage1Asset') }), /asset id/, String(bad));
  }
  assert.equal(readFileSync(join(root, 'data', 'dashboard.json'), 'utf8'), before);
});

test('recordAssets refuses bad arguments', (t) => {
  const root = tempRoot(t);
  const ok = { root, num: 3, kind: 'cv', pdfPath: CV_FILE, uploaded: uploaded('newPdfAsset01', 'newPage1Asset') };
  assert.throws(() => recordAssets({ ...ok, kind: 'photo' }), /kind/);
  assert.throws(() => recordAssets({ ...ok, num: 0 }), /num/);
  assert.throws(() => recordAssets({ ...ok, num: '3' }), /num/);
  assert.throws(() => recordAssets({ ...ok, uploaded: uploaded('newPdfAsset01') }), /page/, 'the PDF alone, no page');
  assert.throws(() => recordAssets({ ...ok, uploaded: uploaded('newPdfAsset01', ...Array.from({ length: 7 }, (_, i) => `pageAsset0${i}`)) }), /page/);
  assert.throws(() => recordAssets({ ...ok, uploaded: 'x' }), /uploaded/);
  assert.throws(() => recordAssets({ ...ok, pdfPath: 'output/absent.pdf' }), /absent\.pdf/);
  assert.throws(() => recordAssets({ ...ok, pdfPath: PDF }), /data root/, 'a PDF outside the data root');
  assert.throws(() => recordAssets({ ...ok, pdfPath: '../x.pdf' }), /data root/);
  assert.throws(() => recordAssets({ ...ok, pdfPath: 'output' }), /file/);
});

test('recordAssets refuses an upload that does not match: content types out of order, or another PDF', (t) => {
  const root = tempRoot(t);
  const ok = { root, num: 3, kind: 'cv', pdfPath: CV_FILE };
  const swapped = uploaded('newPdfAsset01', 'newPage1Asset').map((a, i) => ({ ...a, content_type: i === 0 ? 'image/png' : 'application/pdf' }));
  assert.throws(() => recordAssets({ ...ok, uploaded: swapped }), /content_type/);
  const other = uploaded('newPdfAsset01', 'newPage1Asset');
  other[0].sha256 = 'd'.repeat(64);
  assert.throws(() => recordAssets({ ...ok, uploaded: other }), /sha256/);
  const same = uploaded('newPdfAsset01', 'newPage1Asset');
  same[0].sha256 = PDF_SHA.toUpperCase();
  recordAssets({ ...ok, uploaded: same });
  assert.equal(readDashboard(root).cv_assets['3'].asset_id, 'newPdfAsset01');
});

test('recordAssets refuses an unreadable dashboard.json and leaves it as it was', (t) => {
  for (const content of ['{not json', '[]', '{"cv_assets": []}']) {
    const root = tempRoot(t, content);
    assert.throws(() => recordAssets({ root, num: 3, kind: 'cv', pdfPath: CV_FILE, uploaded: uploaded('newPdfAsset01', 'newPage1Asset') }), /dashboard\.json/);
    assert.equal(readFileSync(join(root, 'data', 'dashboard.json'), 'utf8'), content);
  }
});

// ── CLI ──────────────────────────────────────────────────────────────────────

const runCli = (args, root) => spawnSync('node', [CLI, ...args], {
  cwd: REPO, encoding: 'utf8', env: { ...process.env, CAREER_OPS_ROOT: root },
});

test('CLI reads the upload_asset result and records the assets', (t) => {
  const root = tempRoot(t);
  const upload = join(root, 'upload.json');
  writeFileSync(upload, JSON.stringify({
    assets: uploaded('newPdfAsset01', 'newPage1Asset').map((a) => ({ ...a, sha256: a.content_type === 'application/pdf' ? PDF_SHA : 'e'.repeat(64) })),
  }));
  const r = runCli(['--num', '3', '--kind', 'cv', '--pdf', CV_FILE, '--upload', upload], root);
  assert.equal(r.status, 0, r.stderr);
  const doc = readDashboard(root);
  assert.equal(doc.cv_assets['3'].asset_id, 'newPdfAsset01');
  assert.deepEqual(doc.cv_assets['3'].pages, ['newPage1Asset']);
  assert.deepEqual(JSON.parse(r.stdout), { num: 3, kind: 'cv', entry: doc.cv_assets['3'] });
});

test('CLI exits 1 on bad arguments or a bad upload file, and writes nothing', (t) => {
  const root = tempRoot(t);
  const before = readFileSync(join(root, 'data', 'dashboard.json'), 'utf8');
  const upload = join(root, 'upload.json');
  writeFileSync(upload, JSON.stringify({ assets: uploaded('newPdfAsset01', 'newPage1Asset') }));
  for (const args of [
    ['--num', '3', '--kind', 'cv', '--pdf', CV_FILE],
    ['--num', 'x', '--kind', 'cv', '--pdf', CV_FILE, '--upload', upload],
    ['--num', '3', '--kind', 'photo', '--pdf', CV_FILE, '--upload', upload],
    ['--num', '3', '--kind', 'cv', '--pdf', CV_FILE, '--upload', join(root, 'absent.json')],
  ]) {
    const r = runCli(args, root);
    assert.equal(r.status, 1, args.join(' '));
    assert.ok(r.stderr.trim(), 'an explanation on stderr');
  }
  writeFileSync(upload, JSON.stringify({ items: [] }));
  assert.equal(runCli(['--num', '3', '--kind', 'cv', '--pdf', CV_FILE, '--upload', upload], root).status, 1);
  assert.equal(readFileSync(join(root, 'data', 'dashboard.json'), 'utf8'), before);
  assert.equal(existsSync(join(root, 'data', 'dashboard.json')), true);
});
