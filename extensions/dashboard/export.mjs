#!/usr/bin/env node
// Read-only CLI: prints {"docs":[...]} (or a per-document summary with --summary). Never writes to disk.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { getCareerOpsRoot, resolveTrackerPath, getProfilePath } from '../../path-resolver.mjs';
import { resolveColumns, parseTrackerRow, extractTrackerReportNumbers } from '../../tracker-parse.mjs';
import { buildSnapshot } from './lib/snapshot.mjs';
import { toDocs } from './lib/chunk.mjs';

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

const docs = toDocs(buildSnapshot(collectInput()));
if (process.argv.includes('--summary')) {
  for (const d of docs) console.log(`${d.path}\t${Buffer.byteLength(JSON.stringify(d.data))}`);
} else {
  process.stdout.write(JSON.stringify({ docs }));
}
