#!/usr/bin/env node
// Read-only CLI: prints {"docs":[...]} (or a per-document summary with --summary). Never writes to disk.
// --sync-plan --current <file>: <file> is the `db_list snapshot` output; prints {"batches":[[op,…],…]}, the
// db_write calls of the sync in order (new parts, then the snapshot/meta flip with the old parts' deletes).
import { readFileSync, existsSync, readdirSync, statSync } from 'node:fs';
import { join, dirname, resolve, relative, isAbsolute } from 'node:path';
import { createHash } from 'node:crypto';
import { getCareerOpsRoot, resolveTrackerPath, getProfilePath } from '../../path-resolver.mjs';
import { resolveColumns, parseTrackerRow, extractTrackerReportNumbers } from '../../tracker-parse.mjs';
import { buildSnapshot, parseCvAssets } from './lib/snapshot.mjs';
import { readDossiers, validateDossier } from '../agents/lib/dossiers.mjs';
import { validateProposals, validateRelances } from '../agents/lib/suivi-files.mjs';
import { toDocs, syncPlan, fitsInPart, metaFits } from './lib/chunk.mjs';
import { parseDbLines } from './lib/db-lines.mjs';

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');

const warn = (msg) => process.stderr.write(`export: ${msg}\n`);

// The absolute path of `file` (data-root relative) when it resolves inside the data root and is a regular file,
// else null.
function fileInRoot(root, file) {
  if (typeof file !== 'string' || !file) return null;
  const abs = resolve(root, file);
  const rel = relative(root, abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) return null;
  try { return statSync(abs).isFile() ? abs : null; } catch { return null; }
}

// Current sha256 of each CV and letter file recorded in data/dashboard.json that exists under the data root, keyed
// by the recorded `file` / `letter_file`. A path that leaves the data root, or is not a regular file, is not hashed
// (cv_stale / letter_stale stay null).
function cvFileHashes(root, dashboardJson) {
  const out = {};
  for (const entry of Object.values(parseCvAssets(dashboardJson))) {
    for (const file of [entry.file, entry.letter_file]) {
      if (typeof file !== 'string' || Object.hasOwn(out, file)) continue;
      const abs = fileInRoot(root, file);
      if (!abs) continue;
      try { out[file] = createHash('sha256').update(readFileSync(abs)).digest('hex'); } catch { /* unreadable: unknown */ }
    }
  }
  return out;
}

// data/<name> parsed and validated by `validate`; absent: `empty`; invalid JSON or shape: a warning and `empty`.
function readSuiviFile(root, name, validate, empty) {
  const p = join(root, 'data', name);
  if (!existsSync(p)) return empty;
  try { return validate(JSON.parse(readFileSync(p, 'utf8'))); } catch (e) {
    warn(`data/${name} ignored: ${e.message}`);
    return empty;
  }
}

// The dossier store (data/dossiers.json) and the strategy sheet of each valid dossier ({num: parsed JSON}). A store
// that cannot be read gives a warning and no dossier. A sheet is read only from a regular file inside the data root;
// one that is not valid JSON gives a warning and no sheet.
function dossiersAndSheets(root) {
  let store;
  try { store = readDossiers(root); } catch (e) {
    warn(`data/dossiers.json ignored: ${e.message}`);
    return { dossiers: { schema: 1, dossiers: {} }, strategies: {} };
  }
  const strategies = {};
  for (const [num, d] of Object.entries(store.dossiers)) {
    const abs = validateDossier(d) === null ? fileInRoot(root, d.strategy) : null;
    if (!abs) continue;
    try { strategies[num] = JSON.parse(readFileSync(abs, 'utf8')); } catch (e) {
      warn(`strategy sheet ${d.strategy} ignored: ${e.message}`);
    }
  }
  return { dossiers: store, strategies };
}

export function collectInput(now = new Date()) {
  const root = getCareerOpsRoot();
  const trackerPath = resolveTrackerPath(root);
  const dataDir = dirname(trackerPath);
  const trackerContent = read(trackerPath);

  const lines = trackerContent.replace(/\r/g, '').split('\n');
  const colmap = resolveColumns(lines);
  const nums = new Set();
  for (const l of lines) {
    const row = parseTrackerRow(l, colmap);
    if (row) for (const n of extractTrackerReportNumbers(row.report, row.notes)) nums.add(n);
  }
  const reportsDir = join(root, 'reports');
  const reports = existsSync(reportsDir)
    ? readdirSync(reportsDir)
        .filter((f) => /^\d+-.*\.md$/.test(f) && nums.has(parseInt(f, 10)))
        .sort()
        .map((f) => ({ num: parseInt(f, 10), content: read(join(reportsDir, f)) }))
    : [];
  const dashboardJson = read(join(root, 'data', 'dashboard.json'));

  return {
    trackerContent,
    statusLogContent: read(join(dataDir, 'status-log.tsv')),
    followupsContent: read(join(dataDir, 'follow-ups.md')),
    pipelineContent: read(join(dataDir, 'pipeline.md')),
    scanHistoryContent: read(join(dataDir, 'scan-history.tsv')),
    reports,
    profileYaml: read(getProfilePath(root)),
    dashboardJson,
    cvFileHashes: cvFileHashes(root, dashboardJson),
    ...dossiersAndSheets(root),
    proposals: readSuiviFile(root, 'proposals.json', validateProposals, []),
    relances: readSuiviFile(root, 'relances.json', validateRelances, {}),
    now,
  };
}

// Last guard (ruling R9): an app whose item would not fit in a snapshot part loses its dossier, with a warning,
// rather than stopping the whole export.
function fitApps(snapshot) {
  for (const a of snapshot.apps) {
    if (a.dossier !== null && !fitsInPart(a, snapshot.generation)) {
      warn(`app ${a.num}: dossier left out of the snapshot (too large for one part)`);
      a.dossier = null;
    }
  }
  return snapshot;
}

// Same guard for snapshot/meta: the follow-up texts (up to 1500 characters each) are the part of it that grows
// with the data. While meta is over the limit, the largest text left is dropped, with a warning; the follow-up
// itself stays listed. Runs after fitApps, since the parts meta lists depend on the apps.
function fitMeta(snapshot) {
  const withText = (snapshot.followups_due ?? [])
    .filter((f) => typeof f.text === 'string')
    .sort((a, b) => Buffer.byteLength(JSON.stringify(b.text)) - Buffer.byteLength(JSON.stringify(a.text)) || a.num - b.num);
  for (const f of withText) {
    if (metaFits(snapshot)) break;
    delete f.text;
    warn(`follow-up ${f.num}: text left out of the snapshot (snapshot/meta too large)`);
  }
  return snapshot;
}

const argv = process.argv.slice(2);
let current = null;
if (argv.includes('--sync-plan')) {
  const i = argv.indexOf('--current');
  if (i < 0 || !argv[i + 1]) {
    console.error('Usage: node export.mjs --sync-plan --current <db_list snapshot output> (an empty file for a first sync)');
    process.exit(1);
  }
  try { current = parseDbLines(readFileSync(argv[i + 1], 'utf8')); } catch (e) {
    console.error(`cannot read --current: ${e.message}`);
    process.exit(1);
  }
}
const docs = toDocs(fitMeta(fitApps(buildSnapshot(collectInput()))));
if (current) {
  process.stdout.write(JSON.stringify(syncPlan(docs, current)));
} else if (argv.includes('--summary')) {
  for (const d of docs) console.log(`${d.path}\t${Buffer.byteLength(JSON.stringify(d.data))}`);
} else {
  process.stdout.write(JSON.stringify({ docs }));
}
