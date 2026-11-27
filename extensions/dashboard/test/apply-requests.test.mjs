import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { FIXTURE_ROOT } from './helpers.mjs';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'apply-requests.mjs');
let tmp;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'dash-apply-'));
  cpSync(FIXTURE_ROOT, join(tmp, 'root'), { recursive: true });
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const root = () => join(tmp, 'root');
const readTracker = () => readFileSync(join(root(), 'data/applications.md'), 'utf8');
const readStatusLog = () => readFileSync(join(root(), 'data/status-log.tsv'), 'utf8');

function run(requests, extra = []) {
  const input = join(tmp, 'in.json');
  writeFileSync(input, JSON.stringify(requests));
  const out = execFileSync(process.execPath, [CLI, '--in', input, ...extra], {
    env: { ...process.env, CAREER_OPS_ROOT: root() },
    encoding: 'utf8',
  });
  return JSON.parse(out);
}
const req = (id, data) => ({ id, data: { created_at: '2026-11-26T18:00:00Z', state: 'pending', ...data } });

test('valid status request is applied with the request date', () => {
  const res = run([req('r1', { type: 'status', ref: 3, to_status: 'Interview' })]);
  assert.equal(res[0].state, 'applied');
  assert.equal(res[0].reason, null);
  assert.ok(res[0].applied_at);
  assert.match(readTracker(), /\|\s*3\s*\|.*\|\s*Interview\s*\|/);
  assert.match(readStatusLog(), /^3\t2026-11-26\t/m);
});

test('invalid requests are rejected without writing', () => {
  const before = readTracker();
  const res = run([
    req('a', { type: 'status', ref: 3, to_status: 'Hacked' }),
    req('b', { type: 'status', ref: 999, to_status: 'Applied' }),
    req('c', { type: 'note', ref: 3, note: 'x\u0007' }),
  ]);
  assert.deepEqual(res.map((r) => r.state), ['rejected', 'rejected', 'rejected']);
  assert.ok(res.every((r) => r.reason && r.applied_at === null));
  assert.equal(readTracker(), before);
});

test('malformed entries, bad dates and long notes are rejected; non-pending ignored', () => {
  const before = readTracker();
  const res = run([
    { id: 'm1' },
    { id: 'm2', data: 'nope' },
    req('m3', { type: 'status', ref: 3.5, to_status: 'Applied' }),
    req('m4', { type: 'status', ref: 3, to_status: 'Applied', created_at: 'not a date' }),
    req('m5', { type: 'note', ref: 3, note: 'x'.repeat(501) }),
    req('m6', { type: 'bogus', ref: 3 }),
    req('done', { type: 'status', ref: 3, to_status: 'Interview', state: 'applied' }),
  ]);
  assert.deepEqual(res.map((r) => r.id), ['m1', 'm2', 'm3', 'm4', 'm5', 'm6']);
  assert.ok(res.every((r) => r.state === 'rejected' && r.reason));
  assert.equal(readTracker(), before);
});

test('--dry-run writes nothing', () => {
  const t = readTracker(), l = readStatusLog();
  const res = run([req('r1', { type: 'status', ref: 3, to_status: 'Interview' })], ['--dry-run']);
  assert.equal(res[0].state, 'applied');
  assert.equal(readTracker(), t);
  assert.equal(readStatusLog(), l);
});

test('note-only request appends the note and keeps the status', () => {
  const res = run([req('n1', { type: 'note', ref: 3, note: '--looks like a flag' })]);
  assert.equal(res[0].state, 'applied');
  const row = readTracker().split('\n').find((x) => /^\|\s*3\s*\|/.test(x));
  assert.match(row, /\|\s*Applied\s*\|/);
  assert.match(row, /--looks like a flag/);
});
