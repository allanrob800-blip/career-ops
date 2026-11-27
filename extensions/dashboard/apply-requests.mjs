#!/usr/bin/env node
// Applies change requests written by the dashboard page: status and note strictly through set-status.mjs;
// why and retouche only in the dossier store {DATA_ROOT}/data/dossiers.json, never in the tracker.
// Usage: node apply-requests.mjs --in <file> [--dry-run]
//   <file> is the output of `db_query requests` (or `db_list requests`): one JSON object per line,
//   {id, data, version, updatedAt}; lines that are not such an object (the summary, a wrapper) are ignored.
//   A JSON array of {id, data, version?} is accepted too.
// Prints {"ops":[…], "batches":[[…],…], "results":[…]} on stdout:
//   results  [{id, state: "applied"|"rejected"|"would_apply", reason, applied_at, from_status_seen?}]
//   ops      every write-back, as db_write ops: merge of the result fields only, with ifVersion
//   batches  the same ops cut into db_write calls of at most 50 ops (one call per batch, in order)
// Only entries whose data.state is exactly "pending" are considered. They run in created_at order, then id.
// The why / retouche requests of one run change one in-memory store, written once at the end (not in --dry-run).
import { readFileSync, existsSync } from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getCareerOpsRoot, resolveTrackerPath } from '../../path-resolver.mjs';
import { trackerStatusByNum } from '../../stats.mjs';
import { parseDbLines } from './lib/db-lines.mjs';
import { readDossiers, writeDossiers, setWhy, addRetouche, normalizeText } from '../agents/lib/dossiers.mjs';

const execFileP = promisify(execFile);
const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const SET_STATUS = join(PROJECT_ROOT, 'set-status.mjs');
const TZ = 'Europe/Paris';
const MAX_OPS = 50; // db_write: 1 to 50 ops per call

export const CANONICAL_STATUSES = ['Evaluated', 'Speculative', 'Applied', 'Responded', 'Assessment', 'Interview', 'Offer', 'Hired', 'Rejected', 'Discarded', 'SKIP'];
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
// Request types that change a dossier: type → the dossiers.mjs function that applies the text.
const DOSSIER_UPDATES = { why: setWhy, retouche: addRetouche };
const isDossierType = (type) => typeof type === 'string' && Object.hasOwn(DOSSIER_UPDATES, type);

const short = (s) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, 300) || 'set-status failed';
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
/** The Europe/Paris calendar day (YYYY-MM-DD) of an ISO timestamp. */
export const parisDay = (iso) => dayFmt.format(new Date(Date.parse(iso)));

/** Returns an error string, or null when the request data is valid. */
export function validate(data) {
  if (!isObj(data)) return 'missing or malformed data';
  if (data.type !== 'status' && data.type !== 'note' && !isDossierType(data.type)) return 'unknown request type';
  if (!Number.isInteger(data.ref) || data.ref <= 0) return 'ref must be a positive integer';
  if (typeof data.created_at !== 'string' || !/^\d{4}-\d{2}-\d{2}/.test(data.created_at) || Number.isNaN(Date.parse(data.created_at))) {
    return 'created_at is not a valid date';
  }
  if (data.note !== undefined && data.note !== null) {
    if (typeof data.note !== 'string') return 'note must be a string';
    if (data.note.length > 500) return 'note exceeds 500 characters';
    if (CONTROL_CHARS.test(data.note)) return 'note contains control characters';
  }
  if (isDossierType(data.type)) {
    if (typeof data.text !== 'string') return 'text must be a string';
    if (CONTROL_CHARS.test(data.text)) return 'text contains control characters (line breaks included)';
    if (normalizeText(data.text) === null) return 'text must be 1 to 500 characters with no control character';
  } else if (data.type === 'status') {
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

// The dossier store of one run, read on the first why / retouche request.
function dossierSession() {
  let root = null;
  let store = null;
  let readError = null;
  let changed = false;
  return {
    /** Applies one valid why / retouche request to the in-memory store: null, or the reason it was refused. */
    apply(data) {
      if (!store && !readError) {
        try {
          root = getCareerOpsRoot();
          store = readDossiers(root);
        } catch (e) {
          readError = short(`cannot read data/dossiers.json: ${e.message}`);
        }
      }
      if (readError) return readError;
      const res = DOSSIER_UPDATES[data.type](store, data.ref, data.text, data.created_at);
      if (!res.ok) return res.reason;
      changed = true;
      return null;
    },
    /** Writes the store when a request changed it: null, or the reason the write failed. */
    save() {
      if (!changed) return null;
      try {
        writeDossiers(root, store);
        return null;
      } catch (e) {
        return short(`cannot write data/dossiers.json: ${e.message}`);
      }
    },
  };
}

async function applyOne(entry, dryRun, dossiers) {
  const id = entry.id;
  const data = entry.data;
  const reject = (reason, seen) => ({ id, state: 'rejected', reason, applied_at: null, ...(seen ? { from_status_seen: seen } : {}) });
  const invalid = validate(data);
  if (invalid) return reject(invalid);

  if (isDossierType(data.type)) {
    const refused = dossiers.apply(data);
    if (refused) return reject(refused);
    return { id, state: dryRun ? 'would_apply' : 'applied', reason: null, applied_at: dryRun ? null : new Date().toISOString() };
  }

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
  const dossiers = dossierSession();
  const out = [];
  for (const entry of pending) out.push({ result: await applyOne(entry, dryRun, dossiers), version: entry.version });
  const writeError = dryRun ? null : dossiers.save();
  if (writeError) {
    // Nothing of this run reached dossiers.json: its why / retouche requests were not applied after all.
    out.forEach((a, i) => {
      if (a.result.state === 'applied' && isDossierType(pending[i].data.type)) a.result = { id: a.result.id, state: 'rejected', reason: writeError, applied_at: null };
    });
  }
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
