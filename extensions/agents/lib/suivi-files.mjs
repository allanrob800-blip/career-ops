// The two files the Suivi agent writes for the dashboard (extensions/docs/plans/2026-11-27-agents.md, « Contrats de
// fichiers ») and their validation, for extensions/dashboard/export.mjs:
//   {DATA_ROOT}/data/proposals.json  { schema: 1, generated_at, items: [{id, ref, to_status, evidence: {from, date, subject, excerpt}}] }
//   {DATA_ROOT}/data/relances.json   { schema: 1, items: { "<tracker num>": {text, generated_at} } }
// Both take the parsed JSON and do no I/O. A file of another shape throws; an invalid entry is dropped.

const SCHEMA = 1;
const EXCERPT_MAX = 280;
const RELANCE_MAX = 1500;
// templates/states.yml: the statuses set-status.mjs accepts.
const CANONICAL = new Set(['Evaluated', 'Speculative', 'Applied', 'Responded', 'Assessment', 'Interview', 'Offer', 'Hired', 'Rejected', 'Discarded', 'SKIP']);
// "p-" then the first 16 hex digits of sha1(message_id + to_status).
const PROPOSAL_ID = /^p-[0-9a-f]{16}$/;
const ISO = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;
// Control characters other than the line feed and the tab a follow-up text keeps.
const CONTROL_BUT_LINES = /[^\P{Cc}\n\t]/u;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isIso = (v) => typeof v === 'string' && ISO.test(v) && !Number.isNaN(Date.parse(v));
// One line of evidence: whitespace runs (line breaks, control characters included) become one space.
const oneLine = (s) => s.replace(/[\s\p{Cc}]+/gu, ' ').trim();
const bound = (s, max) => {
  const cps = [...s];
  return cps.length > max ? `${cps.slice(0, max - 1).join('')}…` : s;
};

// {from, date, subject, excerpt} with the strings on one line and the excerpt bounded, or null.
function evidenceOf(e) {
  if (!isObj(e) || typeof e.from !== 'string' || !isIso(e.date) || typeof e.subject !== 'string' || typeof e.excerpt !== 'string') return null;
  const from = oneLine(e.from);
  if (!from) return null;
  return { from: bound(from, EXCERPT_MAX), date: e.date, subject: bound(oneLine(e.subject), EXCERPT_MAX), excerpt: bound(oneLine(e.excerpt), EXCERPT_MAX) };
}

/**
 * The valid status proposals of data/proposals.json, in file order: {id, ref, to_status, evidence}. An item with an
 * id other than p-<16 hex>, a ref that is not a positive integer, a to_status outside the canonical states, or
 * evidence without from, an ISO date, subject and excerpt strings is dropped, as is a repeated id. The evidence
 * strings are put on one line and bounded to 280 characters. Throws when `json` is not {schema: 1, items: [...]}.
 */
export function validateProposals(json) {
  if (!isObj(json) || json.schema !== SCHEMA || !Array.isArray(json.items)) throw new Error(`proposals must be {schema: ${SCHEMA}, items: [...]}`);
  const out = [];
  const seen = new Set();
  for (const p of json.items) {
    if (!isObj(p) || typeof p.id !== 'string' || !PROPOSAL_ID.test(p.id) || seen.has(p.id)) continue;
    if (!Number.isInteger(p.ref) || p.ref < 1 || !CANONICAL.has(p.to_status)) continue;
    const evidence = evidenceOf(p.evidence);
    if (!evidence) continue;
    seen.add(p.id);
    out.push({ id: p.id, ref: p.ref, to_status: p.to_status, evidence });
  }
  return out;
}

/**
 * The follow-up texts of data/relances.json, {"<tracker num>": {text}}: the text to copy, its line breaks kept (CRLF
 * becomes LF), edges trimmed. An entry under a key that is not a positive integer, or whose text is empty, longer than
 * 1500 characters or holds a control character other than a line break or a tab, is dropped: a cut text is not one to
 * send. Throws when `json` is not {schema: 1, items: {}}.
 */
export function validateRelances(json) {
  if (!isObj(json) || json.schema !== SCHEMA || !isObj(json.items)) throw new Error(`relances must be {schema: ${SCHEMA}, items: {}}`);
  const out = {};
  for (const [k, v] of Object.entries(json.items)) {
    const num = /^\d+$/.test(k) ? parseInt(k, 10) : 0;
    if (num < 1 || !isObj(v) || typeof v.text !== 'string') continue;
    const text = v.text.replace(/\r\n?/g, '\n').trim();
    if (!text || [...text].length > RELANCE_MAX || CONTROL_BUT_LINES.test(text)) continue;
    out[String(num)] = { text };
  }
  return out;
}
