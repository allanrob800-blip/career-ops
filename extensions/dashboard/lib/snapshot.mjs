// Pure snapshot builder. No file I/O except loading match.js; time only from input.now.
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { computeTrackerStats, trackerStatusByNum } from '../../../stats.mjs';
import {
  analyzeFromContent, computeUrgency, parseDate, daysBetween, statusLogAppliedDates,
} from '../../../followup-cadence.mjs';
import { resolveColumns, parseTrackerRow, extractTrackerReportNumbers } from '../../../tracker-parse.mjs';
import { closeDatesByUrl, closeDateForUrl } from '../../../lib/posting-close.mjs';
import { loadYaml } from '../../../lib/yaml-document.mjs';
import { isAggregatorUrl } from '../../../url-key.mjs';
import { summarizeReport } from './report-summary.mjs';
import { validateDossier } from '../../agents/lib/dossiers.mjs';
import { validateSheet } from '../../agents/check-strategy.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TZ = 'Europe/Paris';
const TIMELINE_DAYS = 180;
const CANONICAL = new Set(['Evaluated', 'Speculative', 'Applied', 'Responded', 'Assessment', 'Interview', 'Offer', 'Hired', 'Rejected', 'Discarded', 'SKIP']);
const APPLIED_OR_BEYOND = new Set(['Applied', 'Responded', 'Assessment', 'Interview', 'Offer', 'Hired']);

export function loadMatch() {
  const code = readFileSync(join(HERE, '..', 'page', 'js', 'match.js'), 'utf8');
  vm.runInThisContext(code, { filename: 'match.js' });
  return globalThis.CapMatch;
}

let matchCache = null;
const match = () => (matchCache ??= loadMatch());

const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
const parisDay = (d) => dayFmt.format(d);

function addDaysIso(iso, n) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

const isoDay = (s) => (/^\d{4}-\d{2}-\d{2}$/.test(String(s ?? '').trim()) ? String(s).trim() : null);
const httpsOrNull = (u) => (typeof u === 'string' && u.startsWith('https://') ? u : null);
const ASSET_ID = /^[A-Za-z0-9_-]{8,128}$/;
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/**
 * The CV assets recorded in data/dashboard.json (`cv_assets["<tracker num>"] = {asset_id, file, sha256}`), from its
 * raw text. Malformed JSON or another shape gives {}; only object entries under an integer key are kept.
 * export.mjs uses it too, to find the files to hash.
 */
export function parseCvAssets(text) {
  let doc = null;
  try { doc = JSON.parse(String(text ?? '')); } catch { return {}; }
  const out = {};
  if (!isObj(doc) || !isObj(doc.cv_assets)) return out;
  for (const [k, v] of Object.entries(doc.cv_assets)) if (/^\d+$/.test(k) && isObj(v)) out[String(parseInt(k, 10))] = v;
  return out;
}

const CV_PAGES_MAX = 6;
// Display bounds of apps[i].dossier (ruling R9), so one app item stays well under a snapshot part's size.
const SHEET_STRING_MAX = 300;
const SHEET_LIST_MAX = 8;
const ANSWERS_MAX = 12;
const ANSWER_Q_MAX = 300;
const ANSWER_A_MAX = 1000;
const REASONS_MAX = 5;
const REASON_MAX = 200;
const clip = (s, max) => {
  const cps = [...s];
  return cps.length > max ? `${cps.slice(0, max - 1).join('')}…` : s;
};
// The validated sheet for display: every string at most 300 characters, every list at most 8 items, at any depth.
const displaySheet = (v) => {
  if (typeof v === 'string') return clip(v, SHEET_STRING_MAX);
  if (Array.isArray(v)) return v.slice(0, SHEET_LIST_MAX).map(displaySheet);
  if (isObj(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, displaySheet(x)]));
  return v;
};
// The cv_assets entry fields of the CV and of the letter (extensions/agents/record-assets.mjs writes both).
const CV_FIELDS = { asset_id: 'asset_id', file: 'file', sha256: 'sha256', pages: 'pages' };
const LETTER_FIELDS = { asset_id: 'letter_asset_id', file: 'letter_file', sha256: 'letter_sha256', pages: 'letter_pages' };

// url only for an asset id the platform could have issued; pages: the PNG renders of that PDF (entry pages, in
// order, same id rule, at most 6), the only form the page can show (the frame refuses PDF links and downloads).
// stale only when export hashed the recorded file (input.cvFileHashes: {file: sha256 hex}): true means the PDF was
// regenerated after its upload, so its pages are out of date too.
function assetFor(entry, f, hashes) {
  const id = entry && entry[f.asset_id];
  const url = typeof id === 'string' && ASSET_ID.test(id) ? `/_blob/${id}` : null;
  const pages = entry && Array.isArray(entry[f.pages])
    ? entry[f.pages].filter((p) => typeof p === 'string' && ASSET_ID.test(p)).slice(0, CV_PAGES_MAX).map((p) => `/_blob/${p}`)
    : [];
  if (!url && !pages.length) return { url: null, pages: [], stale: null };
  const file = entry[f.file];
  const cur = typeof file === 'string' && Object.hasOwn(hashes, file) ? hashes[file] : null;
  const rec = typeof entry[f.sha256] === 'string' ? entry[f.sha256].toLowerCase() : null;
  return { url, pages, stale: typeof cur === 'string' ? cur.toLowerCase() !== rec : null };
}

function cvFor(entry, hashes) {
  const a = assetFor(entry, CV_FIELDS, hashes);
  return { cv_url: a.url, cv_pages: a.pages, cv_stale: a.stale };
}

// apps[i].dossier: what the dashboard shows of the dossier prepared for tracker row `num` (data/dossiers.json), with
// its strategy sheet (input.strategies[num], bounded by validateSheet, then for display) and its letter assets. null
// when the store has no valid dossier for that num. Answers and check reasons are bounded for display too.
function dossierFor(store, num, sheets, assetEntry, hashes) {
  const d = isObj(store) && isObj(store.dossiers) ? store.dossiers[String(num)] : null;
  if (validateDossier(d) !== null) return null;
  const sheet = isObj(sheets) && Object.hasOwn(sheets, String(num)) && isObj(sheets[String(num)]) ? displaySheet(validateSheet(sheets[String(num)]).sheet) : null;
  const letter = assetFor(assetEntry, LETTER_FIELDS, hashes);
  return {
    state: d.state,
    prepared_at: d.prepared_at,
    letter_state: d.letter.state,
    has_why: typeof d.letter.why === 'string' && d.letter.why.trim() !== '',
    message: d.message,
    answers: d.answers.slice(0, ANSWERS_MAX).map((x) => ({ q: clip(x.q, ANSWER_Q_MAX), a: clip(x.a, ANSWER_A_MAX) })),
    strategy: sheet,
    check_ok: d.check.ok,
    check_reasons: d.check.reasons.slice(0, REASONS_MAX).map((r) => clip(r, REASON_MAX)),
    retouche_pending: d.retouches.some((r) => r.done_at === null),
    letter_url: letter.url,
    letter_pages: letter.pages,
    letter_stale: letter.stale,
  };
}

function parseTracker(content) {
  const lines = String(content ?? '').replace(/\r/g, '').split('\n');
  const colmap = resolveColumns(lines);
  return lines.map((l) => parseTrackerRow(l, colmap)).filter(Boolean);
}

function lastChangeByNum(statusLogContent) {
  const out = new Map();
  for (const line of String(statusLogContent ?? '').replace(/\r/g, '').split('\n')) {
    if (!line.trim() || line.startsWith('#')) continue;
    const c = line.split('\t');
    const num = parseInt(c[0], 10);
    const d = isoDay(c[1]);
    if (!Number.isInteger(num) || !d) continue;
    if (!out.has(num) || d > out.get(num)) out.set(num, d);
  }
  return out;
}

function parsePipeline(content) {
  const offers = [];
  for (const line of String(content ?? '').replace(/\r/g, '').split('\n')) {
    const m = /^\s*-\s*\[ \]\s*(.+?)\s*$/.exec(line);
    if (!m) continue;
    const parts = m[1].split('|').map((s) => s.trim());
    if (!parts[0]) continue;
    offers.push({ url: parts[0], company: parts[1] || null, role: parts[2] || null });
  }
  return offers;
}

function firstName(profileYaml) {
  let doc = null;
  try { doc = loadYaml(String(profileYaml ?? '')); } catch { doc = null; }
  const name = doc && doc.candidate && doc.candidate.full_name;
  if (typeof name !== 'string') return null;
  return name.trim().split(/\s+/)[0] || null;
}

// Urgency is re-derived from input.now with followup-cadence's own exported
// math: analyzeFromContent reads the wall clock for it.
function followupsDue(trackerContent, followupsContent, statusLogContent, today) {
  const res = analyzeFromContent(trackerContent, followupsContent, { statusLogContent });
  if (res.error) return { due: [], byNum: new Map() };
  const now = parseDate(today);
  const byNum = new Map();
  const due = [];
  for (const e of res.entries) {
    let urgency = e.urgency;
    if (urgency !== 'cold') {
      if (e.nextOverride) {
        urgency = daysBetween(parseDate(e.nextOverride), now) >= 0 ? 'overdue' : 'waiting';
      } else {
        const appDate = parseDate(e.appliedDate);
        if (!appDate) continue;
        const last = e.followups[0] ? e.followups[0].date : null;
        const lastD = last ? parseDate(last) : null;
        urgency = computeUrgency(e.status, daysBetween(appDate, now), lastD ? daysBetween(lastD, now) : null, e.followupCount);
      }
    }
    byNum.set(e.num, { next: e.nextFollowupDate, urgency });
    if (urgency === 'overdue' || urgency === 'urgent') {
      due.push({ num: e.num, company: e.company, role: e.role, due: e.nextFollowupDate, urgency });
    }
  }
  due.sort((a, b) => (a.urgency === b.urgency ? 0 : a.urgency === 'urgent' ? -1 : 1) || a.num - b.num);
  return { due, byNum };
}

export function buildSnapshot(input) {
  const now = input.now;
  const today = parisDay(now);
  const rows = parseTracker(input.trackerContent);
  const statusByNum = trackerStatusByNum(input.trackerContent);
  const loggedApplied = statusLogAppliedDates(input.statusLogContent);
  const lastChange = lastChangeByNum(input.statusLogContent);
  const closeIndex = closeDatesByUrl(input.scanHistoryContent ?? '');
  const reports = (input.reports ?? []).map((r) => summarizeReport(r.content, r.num));
  const reportByNum = new Map(reports.map((r) => [r.num, r]));
  const { due, byNum: fu } = followupsDue(input.trackerContent, input.followupsContent, input.statusLogContent, today);
  const { normalizeCompany, domainsFromUrl } = match();
  const cvAssets = parseCvAssets(input.dashboardJson);
  const cvHashes = isObj(input.cvFileHashes) ? input.cvFileHashes : {};

  const apps = rows.filter((row) => CANONICAL.has(statusByNum.get(row.num))).map((row) => {
    const status = statusByNum.get(row.num);
    const reportNum = extractTrackerReportNumbers(row.report, row.notes)[0] ?? null;
    const rep = reportNum != null ? reportByNum.get(reportNum) : null;
    // The first linked report's URL first, as in select-for-prep.mjs: a re-evaluated republication keeps its row
    // keyed on the old URL (merge-tracker matches on it) while the new report names the posting that is live.
    const url = (rep ? rep.url : null) || httpsOrNull(row.url);
    const score = parseFloat(String(row.score || '').replace(/\*/g, ''));
    const date = isoDay(row.date);
    const appliedOn = loggedApplied.get(row.num) || (APPLIED_OR_BEYOND.has(status) ? date : null);
    const f = fu.get(row.num);
    return {
      num: row.num,
      date: row.date,
      company: row.company,
      role: row.role,
      score: Number.isNaN(score) ? null : score,
      status,
      url,
      report_num: reportNum,
      applied_on: appliedOn || null,
      last_change: lastChange.get(row.num) ?? null,
      next_followup: f ? f.next : null,
      followup_urgency: f ? f.urgency : null,
      closes_at: (url && closeDateForUrl(closeIndex, url)) || null,
      ...cvFor(cvAssets[String(row.num)], cvHashes),
      dossier: dossierFor(input.dossiers, row.num, input.strategies, cvAssets[String(row.num)], cvHashes),
    };
  });

  // Status proposals (data/proposals.json, validated by export): only for a tracked application whose status
  // they would change.
  const appByNum = new Map(apps.map((a) => [a.num, a]));
  const proposals = (Array.isArray(input.proposals) ? input.proposals : [])
    .filter((p) => isObj(p) && appByNum.has(p.ref) && appByNum.get(p.ref).status !== p.to_status)
    .map((p) => ({ id: p.id, ref: p.ref, company: appByNum.get(p.ref).company, from_status: appByNum.get(p.ref).status, to_status: p.to_status, evidence: p.evidence }));
  // The follow-up text to copy (data/relances.json, validated by export), when there is one.
  const relances = isObj(input.relances) ? input.relances : {};
  const followups = due.map((f) => {
    const r = Object.hasOwn(relances, String(f.num)) ? relances[String(f.num)] : null;
    return isObj(r) && typeof r.text === 'string' ? { ...f, text: r.text } : f;
  });

  const days = [];
  for (let i = TIMELINE_DAYS - 1; i >= 0; i--) days.push({ date: addDaysIso(today, -i), evaluated: 0, applied: 0 });
  const dayIdx = new Map(days.map((d, i) => [d.date, i]));
  for (const a of apps) {
    const e = dayIdx.get(isoDay(a.date));
    if (e != null) days[e].evaluated++;
    const p = dayIdx.get(a.applied_on);
    if (p != null) days[p].applied++;
  }

  // Domains feed the Outlook sender watches: one must name one employer. A job board or aggregator (career-ops'
  // own list, then match.js's) would pull in a whole board's mail; a domain two companies share names neither.
  const companies = [];
  const byNorm = new Map();
  for (const a of apps) {
    const norm = normalizeCompany(a.company);
    let c = byNorm.get(norm);
    if (!c) { c = { name: a.company, norm, domains: [] }; byNorm.set(norm, c); companies.push(c); }
    if (a.url && !isAggregatorUrl(a.url)) for (const d of domainsFromUrl(a.url)) if (!c.domains.includes(d)) c.domains.push(d);
  }
  const owners = new Map();
  for (const c of companies) for (const d of c.domains) owners.set(d, (owners.get(d) || 0) + 1);
  for (const c of companies) c.domains = c.domains.filter((d) => owners.get(d) === 1);

  return {
    schema: 1,
    generation: now.toISOString(),
    generated_at: now.toISOString(),
    profile: { first_name: firstName(input.profileYaml) },
    apps,
    offers: parsePipeline(input.pipelineContent),
    stats: computeTrackerStats(input.trackerContent),
    timeline: days,
    followups_due: followups,
    reports,
    proposals,
    companies,
  };
}
