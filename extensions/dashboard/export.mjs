#!/usr/bin/env node
// Read-only CLI: prints {"docs":[...]} (or a per-document summary with --summary). Never writes to disk.
// --sync-plan --current <file>: <file> is the `db_list snapshot` output; prints {"batches":[[op,…],…]}, the
// db_write calls of the sync in order (new parts, then the snapshot/meta flip with the old parts' deletes).
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { getCareerOpsRoot, resolveTrackerPath, getProfilePath } from '../../path-resolver.mjs';
import { resolveColumns, parseTrackerRow, extractTrackerReportNumbers } from '../../tracker-parse.mjs';
import { buildSnapshot } from './lib/snapshot.mjs';
import { toDocs, syncPlan } from './lib/chunk.mjs';
import { parseDbLines } from './lib/db-lines.mjs';

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');

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

  return {
    trackerContent,
    statusLogContent: read(join(dataDir, 'status-log.tsv')),
    followupsContent: read(join(dataDir, 'follow-ups.md')),
    pipelineContent: read(join(dataDir, 'pipeline.md')),
    scanHistoryContent: read(join(dataDir, 'scan-history.tsv')),
    reports,
    profileYaml: read(getProfilePath(root)),
    now,
  };
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
const docs = toDocs(buildSnapshot(collectInput()));
if (current) {
  process.stdout.write(JSON.stringify(syncPlan(docs, current)));
} else if (argv.includes('--summary')) {
  for (const d of docs) console.log(`${d.path}\t${Buffer.byteLength(JSON.stringify(d.data))}`);
} else {
  process.stdout.write(JSON.stringify({ docs }));
}
