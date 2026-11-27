import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
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
