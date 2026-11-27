#!/usr/bin/env node
// Applies change requests written by the dashboard page, strictly through set-status.mjs.
// Usage: node apply-requests.mjs --in <file> [--dry-run]
//   <file> is the output of `db_query requests` (or `db_list requests`): one JSON object per line,
//   {id, data, version, updatedAt}; lines that are not such an object (the summary, a wrapper) are ignored.
//   A JSON array of {id, data, version?} is accepted too.
// Prints {"ops":[…], "batches":[[…],…], "results":[…]} on stdout:
//   results  [{id, state: "applied"|"rejected"|"would_apply", reason, applied_at, from_status_seen?}]
//   ops      every write-back, as db_write ops: merge of the result fields only, with ifVersion
//   batches  the same ops cut into db_write calls of at most 50 ops (one call per batch, in order)
// Only entries whose data.state is exactly "pending" are considered. They run in created_at order, then id.
import { readFileSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCareerOpsRoot, resolveTrackerPath } from '../../path-resolver.mjs';
import { trackerStatusByNum } from '../../stats.mjs';
import { parseDbLines } from './lib/db-lines.mjs';

const execFileP = promisify(execFile);
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SET_STATUS = join(PROJECT_ROOT, 'set-status.mjs');
const TZ = 'Europe/Paris';
const MAX_OPS = 50; // db_write: 1 to 50 ops per call

export const CANONICAL_STATUSES = ['Evaluated', 'Speculative', 'Applied', 'Responded', 'Assessment', 'Interview', 'Offer', 'Hired', 'Rejected', 'Discarded', 'SKIP'];
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;

const short = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 300) || 'set-status failed';
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
/** The Europe/Paris calendar day (YYYY-MM-DD) of an ISO timestamp. */
export const parisDay = (iso) => dayFmt.format(new Date(Date.parse(iso)));

/** Returns an error string, or null when the request data is valid. */
export function validate(data) {
  if (!isObj(data)) return 'missing or malformed data';
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
    if (!CANONICAL_STATUSES.includes(data.from_status)) {
      return 'status request without a canonical from_status (written by an older page): ask again from the dashboard';
    }
  } else if (!data.note) {
    return 'note request without a note';
  }
  return null;
}

/** Reads the requests file: a JSON array, or the db_query / db_list line format. */
export const parseInput = parseDbLines;

function currentStatus(ref) {
  const path = resolveTrackerPath(getCareerOpsRoot());
  const content = existsSync(path) ? readFileSync(path, 'utf8') : '';
  return trackerStatusByNum(content).get(ref) ?? null;
}

// set-status --json prints one JSON document last on stdout (pretty-printed on success).
function lastJson(stdout) {
  const s = String(stdout ?? '').trim();
  try { return JSON.parse(s); } catch { /* fall through */ }
  const i = s.lastIndexOf('\n{');
  try { return i >= 0 ? JSON.parse(s.slice(i + 1)) : null; } catch { return null; }
}

async function applyOne(entry, dryRun) {
  const id = entry.id;
  const data = entry.data;
  const reject = (reason, seen) => ({ id, state: 'rejected', reason, applied_at: null, ...(seen ? { from_status_seen: seen } : {}) });
  const invalid = validate(data);
  if (invalid) return reject(invalid);

  let toStatus = data.to_status;
  if (data.type === 'note') {
    toStatus = currentStatus(data.ref);
    if (!CANONICAL_STATUSES.includes(toStatus)) return reject('row not found or status unknown');
  }
  const args = [SET_STATUS, '--row', String(data.ref), toStatus, '--on', parisDay(data.created_at), '--source', 'web', '--json'];
  // The status the page saw when the request was made: set-status refuses (under its lock) when the row moved since.
  if (data.type === 'status') args.push('--expect-status', data.from_status);
  if (data.note) args.push(`--note=${data.note}`);
  if (dryRun) args.push('--dry-run');
  try {
    // TZ: set-status compares --on with its LOCAL today; the request day is a Paris day.
    const { stdout } = await execFileP(process.execPath, args, { cwd: PROJECT_ROOT, env: { ...process.env, TZ }, maxBuffer: 4 * 1024 * 1024 });
    const res = lastJson(stdout);
    const seen = res && typeof res.oldStatus === 'string' ? res.oldStatus : null;
    return {
      id, state: dryRun ? 'would_apply' : 'applied', reason: null, applied_at: dryRun ? null : new Date().toISOString(),
      ...(seen ? { from_status_seen: seen } : {}),
    };
  } catch (err) {
    const res = lastJson(err.stdout);
    const reason = res && res.error;
    const seen = res && typeof res.currentStatus === 'string' ? res.currentStatus : null;
    return reject(short(reason || err.stderr || err.message), seen);
  }
}

const createdKey = (e) => (isObj(e.data) && typeof e.data.created_at === 'string' ? e.data.created_at : '');
function byCreated(a, b) {
  const x = createdKey(a), y = createdKey(b);
  if (x !== y) return x < y ? -1 : 1;
  const i = String(a.id ?? ''), j = String(b.id ?? '');
  return i < j ? -1 : i > j ? 1 : 0;
}

/** Pending entries only, oldest first. Returns the results in the order they were applied. */
export async function applyRequests(entries, { dryRun = false } = {}) {
  const pending = (Array.isArray(entries) ? entries : [])
    .filter((e) => isObj(e) && isObj(e.data) && e.data.state === 'pending')
    .sort(byCreated);
  const out = [];
  for (const entry of pending) out.push({ result: await applyOne(entry, dryRun), version: entry.version });
  return out;
}

const docId = (id) => String(id).replace(/^requests\//, '');

/** db_write ops for the results: merge the result fields only, guarded by the version that was read. */
export function writeBackOps(applied) {
  return applied.map(({ result, version }) => {
    const data = { state: result.state, reason: result.reason, applied_at: result.applied_at };
    if (result.from_status_seen) data.from_status_seen = result.from_status_seen;
    const op = { op: 'merge', path: `requests/${docId(result.id)}`, data };
    if (version !== undefined && version !== null) op.ifVersion = version;
    return op;
  });
}

export function toBatches(ops, size = MAX_OPS) {
  const out = [];
  for (let i = 0; i < ops.length; i += size) out.push(ops.slice(i, i + size));
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--in');
  if (i < 0 || !argv[i + 1]) {
    console.error('Usage: node apply-requests.mjs --in <db_query output or JSON array> [--dry-run]');
    process.exit(1);
  }
  let text;
  try { text = readFileSync(argv[i + 1], 'utf8'); } catch (e) {
    console.error(`cannot read requests: ${e.message}`);
    process.exit(1);
  }
  const dryRun = argv.includes('--dry-run');
  const applied = await applyRequests(parseInput(text), { dryRun });
  const results = applied.map((a) => a.result);
  const ops = dryRun ? [] : writeBackOps(applied.filter((a) => typeof a.result.id === 'string' && a.result.id));
  const missing = dryRun ? [] : ops.filter((o) => !('ifVersion' in o)).map((o) => o.path);
  const out = { ops, batches: toBatches(ops), results };
  if (missing.length) out.warnings = [`no version in the input for ${missing.join(', ')}: db_write refuses these ops; read the requests with db_query`];
  console.log(JSON.stringify(out));
}
