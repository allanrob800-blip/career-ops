import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const FIXTURE_ROOT = join(dirname(fileURLToPath(import.meta.url)), 'fixtures', 'root');

export function readFixture(rel) {
  return readFileSync(join(FIXTURE_ROOT, rel), 'utf8');
}

/** Reads the fixture files into the buildSnapshot input shape. */
export function loadFixtureInput(now) {
  const reports = readdirSync(join(FIXTURE_ROOT, 'reports'))
    .filter((f) => /^(\d+)-.*\.md$/.test(f))
    .map((f) => ({ num: parseInt(f, 10), content: readFixture(`reports/${f}`) }));
  return {
    trackerContent: readFixture('data/applications.md'),
    statusLogContent: readFixture('data/status-log.tsv'),
    followupsContent: readFixture('data/follow-ups.md'),
    pipelineContent: readFixture('data/pipeline.md'),
    scanHistoryContent: existsSync(join(FIXTURE_ROOT, 'data/scan-history.tsv')) ? readFixture('data/scan-history.tsv') : '',
    reports,
    profileYaml: readFixture('config/profile.yml'),
    now,
  };
}
