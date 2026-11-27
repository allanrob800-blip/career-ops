import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
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
