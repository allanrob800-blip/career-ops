// The re-evaluation rule of .claude/agents/evaluateur.md, step 5, against the real merge-tracker.mjs: a TSV for a
// republished posting must carry the EXISTING row's URL, or the merge adds a second row. Fictional data in a
// temporary CAREER_OPS_ROOT, `--dry-run` only, no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');
const OLD = 'https://jobs.exemple-acme.fr/offres/chef-de-projet-7';
const NEW = 'https://jobs.exemple-acme.fr/offres/chef-de-projet-marque-b-8';
const LINKEDIN = 'https://www.linkedin.com/jobs/view/4001234567';

const report = (date, url, score, extra = '') =>
  `# Évaluation : Acme — Chef de projet\n\n**Date:** ${date}\n${extra}**Score:** ${score}/5\n**URL:** ${url}\n**Legitimacy:** High Confidence\n\n## A) Résumé\nFictif.\n`;

/** Dry-run merge of one re-evaluation TSV carrying `tsvUrl`, over one tracker row keyed on `rowUrl`. */
function dryRunMerge(rowUrl, tsvUrl) {
  const root = mkdtempSync(join(tmpdir(), 'career-ops-republication-'));
  try {
    mkdirSync(join(root, 'data'), { recursive: true });
    mkdirSync(join(root, 'reports'), { recursive: true });
    mkdirSync(join(root, 'batch', 'tracker-additions'), { recursive: true });
    writeFileSync(join(root, 'reports', '012-acme-2026-11-20.md'), report('2026-11-20', rowUrl, '3.6'));
    writeFileSync(join(root, 'reports', '031-acme-2026-11-28.md'),
      report('2026-11-28', NEW, '4.2', '**Supersedes:** report #012\n'));
    writeFileSync(join(root, 'data', 'applications.md'), [
      '# Applications Tracker', '',
      '| # | Date | Company | Role | Score | Status | PDF | Report | Notes | URL |',
      '|---|---|---|---|---|---|---|---|---|---|',
      `| 5 | 2026-11-20 | Acme | Chef de projet | 3.6/5 | Evaluated | ❌ | [12](../reports/012-acme-2026-11-20.md) | Fictif | ${rowUrl} |`,
      '',
    ].join('\n'));
    writeFileSync(join(root, 'batch', 'tracker-additions', '031-acme.tsv'),
      'num\tdate\tcompany\trole\tstatus\tscore\tpdf\treport\tnotes\turl\n'
      + `5\t2026-11-28\tAcme\tChef de projet\tEvaluated\t4.2/5\t❌\t`
      + `[31](reports/031-acme-2026-11-28.md) / [12](reports/012-acme-2026-11-20.md)\tRepublication : package publié\t${tsvUrl}\n`);
    const env = { ...process.env, CAREER_OPS_ROOT: root };
    for (const k of ['CAREER_OPS_DATA_DIR', 'CAREER_OPS_TRACKER', 'CAREER_OPS_ADDITIONS', 'CAREER_OPS_BATCH_STATE']) delete env[k];
    const r = spawnSync(process.execPath, [join(PROJECT, 'merge-tracker.mjs'), '--dry-run'],
      { cwd: PROJECT, env, encoding: 'utf8', timeout: 30_000 });
    assert.equal(r.status, 0, `${r.stdout}${r.stderr}`);
    return `${r.stdout}${r.stderr}`;
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('republication: the new posting URL in the TSV adds a second row', () => {
  const out = dryRunMerge(OLD, NEW);
  assert.match(out, /Add #\d+: Acme/);
  assert.doesNotMatch(out, /Update: #/);
});

test("republication: the existing row's URL in the TSV updates that row", () => {
  const out = dryRunMerge(OLD, OLD);
  assert.match(out, /Update: #5 Acme/);
  assert.doesNotMatch(out, /Add #/);
});

test('republication: a row keyed on an aggregator URL is updated through that same URL', () => {
  const out = dryRunMerge(LINKEDIN, LINKEDIN);
  assert.match(out, /Update: #5 Acme/);
  assert.doesNotMatch(out, /Add #/);
});
