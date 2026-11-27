import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, copyFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { renderPages, listPages } from '../render-pages.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, '..', '..', '..');
const PDF = join(HERE, 'fixtures', 'one-page.pdf');
const CLI = 'extensions/agents/render-pages.mjs';
const NO_PDFTOPPM = spawnSync('pdftoppm', ['-v']).error ? 'pdftoppm is not installed' : false;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function tempDir(t) {
  const dir = mkdtempSync(join(tmpdir(), 'agents-pages-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('renderPages renders one-page.pdf to one PNG', { skip: NO_PDFTOPPM }, (t) => {
  const out = join(tempDir(t), 'pages');
  const pages = renderPages(PDF, out);
  assert.equal(pages.length, 1);
  assert.equal(pages[0], join(out, 'page-1.png'));
  assert.deepEqual(readFileSync(pages[0]).subarray(0, 8), PNG_SIGNATURE);
});

test('renderPages removes pages left by an earlier render in the same folder', { skip: NO_PDFTOPPM }, (t) => {
  const out = tempDir(t);
  writeFileSync(join(out, 'page-2.png'), 'old');
  writeFileSync(join(out, 'page-03.png'), 'old');
  writeFileSync(join(out, 'notes.txt'), 'kept');
  assert.deepEqual(renderPages(PDF, out), [join(out, 'page-1.png')]);
  assert.equal(existsSync(join(out, 'page-2.png')), false);
  assert.equal(existsSync(join(out, 'notes.txt')), true);
});

test('renderPages throws on a file that is not a PDF', { skip: NO_PDFTOPPM }, (t) => {
  const dir = tempDir(t);
  writeFileSync(join(dir, 'x.pdf'), 'not a pdf');
  assert.throws(() => renderPages(join(dir, 'x.pdf'), join(dir, 'out')));
});

test('listPages sorts page PNGs by number, zero-padded or not, and ignores other files', (t) => {
  const dir = tempDir(t);
  for (const f of ['page-10.png', 'page-02.png', 'page-1.png', 'page-11.png', 'other-3.png', 'page-x.png', 'page-4.jpg']) {
    writeFileSync(join(dir, f), '');
  }
  assert.deepEqual(listPages(dir).map((p) => p.slice(dir.length + 1)), ['page-1.png', 'page-02.png', 'page-10.png', 'page-11.png']);
});

test('CLI prints {pages}; a relative --pdf is read from the data root', { skip: NO_PDFTOPPM }, (t) => {
  const root = tempDir(t);
  mkdirSync(join(root, 'output'));
  copyFileSync(PDF, join(root, 'output', '003-exemple-cv.pdf'));
  const out = join(root, 'tmp-pages');
  const stdout = execFileSync('node', [CLI, '--pdf', 'output/003-exemple-cv.pdf', '--out', out], {
    cwd: REPO, encoding: 'utf8', env: { ...process.env, CAREER_OPS_ROOT: root },
  });
  assert.deepEqual(JSON.parse(stdout), { pages: [join(out, 'page-1.png')] });
});

test('CLI exits 1 without --pdf and --out', (t) => {
  const r = spawnSync('node', [CLI, '--pdf', PDF], {
    cwd: REPO, encoding: 'utf8', env: { ...process.env, CAREER_OPS_ROOT: tempDir(t) },
  });
  assert.equal(r.status, 1);
  assert.match(r.stderr, /Usage/);
});
