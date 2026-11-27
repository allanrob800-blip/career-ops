#!/usr/bin/env node
// Applies change requests written by the dashboard page, strictly through set-status.mjs.
// Usage: node apply-requests.mjs --in requests.json [--dry-run]
// Prints a JSON array [{id, state: "applied"|"rejected", reason, applied_at}] on stdout.
import { readFileSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCareerOpsRoot, resolveTrackerPath } from '../../path-resolver.mjs';
import { trackerStatusByNum } from '../../stats.mjs';

const execFileP = promisify(execFile);
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SET_STATUS = join(PROJECT_ROOT, 'set-status.mjs');

export const CANONICAL_STATUSES = ['Evaluated', 'Speculative', 'Applied', 'Responded', 'Assessment', 'Interview', 'Offer', 'Hired', 'Rejected', 'Discarded', 'SKIP'];
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

const short = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 300) || 'set-status failed';

/** Returns an error string, or null when the request data is valid. */
export function validate(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return 'missing or malformed data';
  if (data.type !== 'status' && data.type !== 'note') return 'unknown request type';
  if (!Number.isInteger(data.ref) || data.ref <= 0) return 'ref must be a positive integer';
  if (typeof data.created_at !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(data.created_at) || Number.isNaN(Date.parse(data.created_at))) {
    return 'created_at is not a valid date';
  }
  if (data.note !== undefined && data.note !== null) {
    if (typeof data.note !== 'string') return 'note must be a string';
    if (data.note.length > 500) return 'note exceeds 500 characters';
    if (CONTROL_CHARS.test(data.note)) return 'note contains control characters';
  }
  if (data.type === 'status') {
    if (!CANONICAL_STATUSES.includes(data.to_status)) return 'to_status is not a canonical status';
  } else if (!data.note) {
    return 'note request without a note';
  }
  return null;
}

function currentStatus(ref) {
  const path = resolveTrackerPath(getCareerOpsRoot());
  const content = existsSync(path) ? readFileSync(path, 'utf8') : '';
  return trackerStatusByNum(content).get(ref) ?? null;
}

async function applyOne(entry, dryRun) {
  const id = entry && typeof entry === 'object' ? entry.id : undefined;
  const data = entry?.data;
  const reject = (reason) => ({ id, state: 'rejected', reason, applied_at: null });
  const invalid = validate(data);
  if (invalid) return reject(invalid);

  let toStatus = data.to_status;
  if (data.type === 'note') {
    toStatus = currentStatus(data.ref);
    if (!CANONICAL_STATUSES.includes(toStatus)) return reject('row not found or status unknown');
  }
  const args = [SET_STATUS, '--row', String(data.ref), toStatus, '--on', data.created_at.slice(0, 10), '--source', 'web', '--json'];
  if (data.note) args.push(`--note=${data.note}`);
  if (dryRun) args.push('--dry-run');
  try {
    await execFileP(process.execPath, args, { cwd: PROJECT_ROOT, env: process.env, maxBuffer: 4 * 1024 * 1024 });
    return { id, state: 'applied', reason: null, applied_at: new Date().toISOString() };
  } catch (err) {
    let reason = null;
    try { reason = JSON.parse(err.stdout).error; } catch { /* not JSON */ }
    return reject(short(reason || err.stderr || err.message));
  }
}

export async function applyRequests(requests, { dryRun = false } = {}) {
  const out = [];
  for (const entry of requests) {
    const data = entry?.data;
    if (data && typeof data === 'object' && data.state !== undefined && data.state !== 'pending') continue;
    out.push(await applyOne(entry, dryRun));
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--in');
  if (i < 0 || !argv[i + 1]) {
    console.error('Usage: node apply-requests.mjs --in <requests.json> [--dry-run]');
    process.exit(1);
  }
  let requests;
  try { requests = JSON.parse(readFileSync(argv[i + 1], 'utf8')); } catch (e) {
    console.error(`cannot read requests: ${e.message}`);
    process.exit(1);
  }
  if (!Array.isArray(requests)) { console.error('requests must be a JSON array'); process.exit(1); }
  console.log(JSON.stringify(await applyRequests(requests, { dryRun: argv.includes('--dry-run') })));
}
