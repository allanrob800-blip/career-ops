#!/usr/bin/env node
// Read-only CLI: which evaluated offers the Expert CV et lettre prepares today, and which dossiers await their letter.
//   node extensions/agents/select-for-prep.mjs [--max 3]   → {"candidates":[…],"skipped":[…]}
//   node extensions/agents/select-for-prep.mjs --letters   → {"letters":[num…]}
// Status and score come from the tracker, legitimacy from each report's `**Legitimacy:** {tier}` line, dossier
// states from data/dossiers.json. Never writes to disk.
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { getCareerOpsRoot, resolveTrackerPath } from '../../path-resolver.mjs';
import { resolveColumns, parseTrackerRow, extractTrackerReportNumbers, parseScore } from '../../tracker-parse.mjs';
import { trackerStatusByNum } from '../../stats.mjs';
import { isMainModule } from '../../lib/is-main-module.mjs';
import { summarizeReport } from '../dashboard/lib/report-summary.mjs';
import { readDossiers } from './lib/dossiers.mjs';

export const MIN_SCORE = 4.0;
export const DEFAULT_MAX = 3;
const TIERS = ['High Confidence', 'Proceed with Caution', 'Suspicious'];
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

// Why an Evaluated row is not prepared today, or null when it may be. Checks run in this order; the first that
// fails is reported.
function exclusion(row, legitimacyByReport, dossiers) {
  if (typeof row.score !== 'number' || Number.isNaN(row.score)) return 'no score';
  if (row.score < MIN_SCORE) return `score below ${MIN_SCORE.toFixed(1)}`;
  const d = dossiers[String(row.num)];
  const state = isObj(d) ? d.state : null;
  if (state === 'pret') return 'dossier ready (pret)';
  if (state === 'a_verifier') return 'dossier awaiting review (a_verifier)';
  if (!Number.isInteger(row.report_num)) return 'no evaluation report';
  if (legitimacyByReport.get(row.report_num) === 'Suspicious') return 'legitimacy Suspicious';
  return null;
}

/**
 * The offers to prepare: Evaluated rows scored ≥ 4.0, not Suspicious, with no dossier in `pret` or `a_verifier`
 * (an `a_refaire` dossier is prepared again), by score descending then number ascending, at most `max`.
 * rows: [{num, status, score: number|null, company, role, url, report_num: number|null}].
 * legitimacyByReport: Map(report_num → tier). Every Evaluated row left out is in `skipped` with its reason, by
 * number; rows of any other status are not listed at all (the daily routine reads this output).
 */
export function selectForPrep({ rows, legitimacyByReport, store, max = DEFAULT_MAX }) {
  if (!Number.isInteger(max) || max < 0) throw new TypeError('max must be a non-negative integer');
  const dossiers = isObj(store) && isObj(store.dossiers) ? store.dossiers : {};
  const legit = legitimacyByReport instanceof Map ? legitimacyByReport : new Map();
  const kept = [];
  const skipped = [];
  for (const row of rows ?? []) {
    if (row.status !== 'Evaluated') continue;
    const reason = exclusion(row, legit, dossiers);
    if (reason) skipped.push({ num: row.num, reason });
    else kept.push(row);
  }
  kept.sort((a, b) => b.score - a.score || a.num - b.num);
  for (const row of kept.slice(max)) skipped.push({ num: row.num, reason: `daily limit reached (max ${max})` });
  skipped.sort((a, b) => a.num - b.num);
  const candidates = kept.slice(0, max).map(({ num, report_num, company, role, score, url }) => ({
    num, report_num, company, role, score, url: url ?? null,
  }));
  return { candidates, skipped };
}

/** Tracker numbers of the dossiers whose letter is `a_completer` and whose `why` is filled in, ascending. */
export function selectLetters(store) {
  const dossiers = isObj(store) && isObj(store.dossiers) ? store.dossiers : {};
  return Object.entries(dossiers)
    .filter(([k, d]) => /^\d+$/.test(k) && isObj(d) && isObj(d.letter) && d.letter.state === 'a_completer'
      && typeof d.letter.why === 'string' && d.letter.why.trim() !== '')
    .map(([k]) => parseInt(k, 10))
    .sort((a, b) => a - b);
}

// The canonical tier a `**Legitimacy:**` value starts with ("Suspicious — 3 signals" → "Suspicious"), else the value.
function legitimacyTier(value) {
  if (typeof value !== 'string') return null;
  return TIERS.find((t) => value.toLowerCase().startsWith(t.toLowerCase())) ?? value;
}

const read = (p) => (existsSync(p) ? readFileSync(p, 'utf8') : '');

// Tracker rows in the selectForPrep shape, plus the legitimacy of each report they link to.
function loadInput(root) {
  const trackerContent = read(resolveTrackerPath(root));
  const lines = trackerContent.replace(/\r/g, '').split('\n');
  const colmap = resolveColumns(lines);
  const parsed = lines.map((l) => parseTrackerRow(l, colmap)).filter(Boolean);
  const statusByNum = trackerStatusByNum(trackerContent);

  const reportsDir = join(root, 'reports');
  const reportFiles = existsSync(reportsDir) ? readdirSync(reportsDir).filter((f) => /^\d+-.*\.md$/.test(f)).sort() : [];
  const summaries = new Map();
  const summaryOf = (n) => {
    if (!summaries.has(n)) {
      const f = reportFiles.find((x) => parseInt(x, 10) === n);
      summaries.set(n, f ? summarizeReport(read(join(reportsDir, f)), n) : null);
    }
    return summaries.get(n);
  };

  const legitimacyByReport = new Map();
  const rows = parsed.map((row) => {
    const reportNum = extractTrackerReportNumbers(row.report, row.notes)[0] ?? null;
    const rep = reportNum != null ? summaryOf(reportNum) : null;
    if (rep) legitimacyByReport.set(reportNum, legitimacyTier(rep.legitimacy));
    const url = typeof row.url === 'string' && row.url.startsWith('https://') ? row.url : (rep ? rep.url : null);
    return {
      num: row.num,
      status: statusByNum.get(row.num) ?? null,
      score: /\d/.test(row.score) ? parseScore(row.score) : null,
      company: row.company,
      role: row.role,
      url,
      report_num: reportNum,
    };
  });
  return { rows, legitimacyByReport };
}

const USAGE = 'Usage: node extensions/agents/select-for-prep.mjs [--max N] [--letters]';

function parseArgs(argv) {
  const opts = { max: DEFAULT_MAX, letters: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--letters') opts.letters = true;
    else if (a === '--max' && /^\d+$/.test(argv[i + 1] ?? '')) opts.max = parseInt(argv[++i], 10);
    else return null;
  }
  return opts;
}

if (isMainModule(import.meta.url)) {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts) {
    console.error(USAGE);
    process.exit(1);
  }
  const root = getCareerOpsRoot();
  let store;
  try { store = readDossiers(root); } catch (e) {
    console.error(`cannot read data/dossiers.json: ${e.message}`);
    process.exit(1);
  }
  const out = opts.letters
    ? { letters: selectLetters(store) }
    : selectForPrep({ ...loadInput(root), store, max: opts.max });
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}
