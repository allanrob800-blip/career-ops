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
import { summarizeReport } from './report-summary.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const TZ = 'Europe/Paris';
const TIMELINE_DAYS = 180;
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

  const apps = rows.map((row) => {
    const status = statusByNum.get(row.num) ?? 'Unknown';
    const reportNum = extractTrackerReportNumbers(row.report, '')[0] ?? null;
    const rep = reportNum != null ? reportByNum.get(reportNum) : null;
    const url = httpsOrNull(row.url) || (rep ? rep.url : null);
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
    };
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

  const companies = [];
  const byNorm = new Map();
  for (const a of apps) {
    const norm = normalizeCompany(a.company);
    let c = byNorm.get(norm);
    if (!c) { c = { name: a.company, norm, domains: [] }; byNorm.set(norm, c); companies.push(c); }
    if (a.url) for (const d of domainsFromUrl(a.url)) if (!c.domains.includes(d)) c.domains.push(d);
  }

  return {
    schema: 1,
    generation: now.toISOString(),
    generated_at: now.toISOString(),
    profile: { first_name: firstName(input.profileYaml) },
    apps,
    offers: parsePipeline(input.pipelineContent),
    stats: computeTrackerStats(input.trackerContent),
    timeline: days,
    followups_due: due,
    reports,
    companies,
  };
}
