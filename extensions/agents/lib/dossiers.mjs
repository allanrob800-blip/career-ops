// The per-application dossier store, {DATA_ROOT}/data/dossiers.json:
//   { schema: 1, dossiers: { "<tracker num>": Dossier } }
// See extensions/docs/plans/2026-11-27-agents.md, "Contrats de fichiers", for the Dossier shape.
// setWhy and addRetouche change the store in memory; only writeDossiers touches the disk.
import { readFileSync, writeFileSync, renameSync, mkdirSync, rmSync } from 'node:fs';
import { join, isAbsolute } from 'node:path';
import { randomBytes } from 'node:crypto';

const SCHEMA = 1;
const TEXT_MAX = 500;
const MESSAGE_MAX = 1200;
const STATES = new Set(['pret', 'a_verifier', 'a_refaire']);
const LETTER_STATES = new Set(['a_completer', 'prete']);
const NO_DOSSIER = 'no dossier for this application';
const CONTROL = /\p{Cc}/u;
const ISO = /^\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:\d{2})?)?$/;

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isIso = (v) => typeof v === 'string' && ISO.test(v) && !Number.isNaN(Date.parse(v));
const isText = (v) => typeof v === 'string' && v.trim() !== '';
// A data-root-relative path: no absolute path, no `..` segment.
const isRelPath = (v) => isText(v) && !isAbsolute(v) && !v.split(/[\\/]/).includes('..');
const chars = (s) => [...s].length;

const dossiersPath = (root) => join(root, 'data', 'dossiers.json');

function shapeError(store) {
  if (!isObj(store) || store.schema !== SCHEMA || !isObj(store.dossiers)) return `dossiers store must be {schema: ${SCHEMA}, dossiers: {}}`;
  return null;
}

/** The store in {root}/data/dossiers.json. Absent file: an empty store. Invalid JSON or another shape: throws. */
export function readDossiers(root) {
  let text;
  try { text = readFileSync(dossiersPath(root), 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return { schema: SCHEMA, dossiers: {} };
    throw e;
  }
  const store = JSON.parse(text);
  const err = shapeError(store);
  if (err) throw new Error(err);
  return store;
}

/** Writes the store atomically: a temporary file beside it, then a rename over it. */
export function writeDossiers(root, store) {
  const err = shapeError(store);
  if (err) throw new Error(err);
  const file = dossiersPath(root);
  mkdirSync(join(root, 'data'), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`);
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * Text typed on the page (`why`, `retouche`): whitespace runs (line breaks included) become one space, edges are
 * trimmed. null when the result is empty, longer than 500 characters, or still holds a control character.
 */
export function normalizeText(raw) {
  if (typeof raw !== 'string') return null;
  const t = raw.replace(/\s+/g, ' ').trim();
  if (!t || chars(t) > TEXT_MAX || CONTROL.test(t)) return null;
  return t;
}

/** null when `d` matches the Dossier contract, else the first problem found. */
export function validateDossier(d) {
  if (!isObj(d)) return 'dossier must be an object';
  if (!STATES.has(d.state)) return 'state must be pret, a_verifier or a_refaire';
  if (!isIso(d.prepared_at)) return 'prepared_at must be an ISO date';
  if (!Number.isInteger(d.report_num) || d.report_num < 1) return 'report_num must be a positive integer';
  if (!isObj(d.cv) || !isRelPath(d.cv.pdf) || !isRelPath(d.cv.html)) return 'cv must be {pdf, html} relative paths';
  const l = d.letter;
  if (!isObj(l) || !LETTER_STATES.has(l.state)) return 'letter.state must be a_completer or prete';
  if (l.why !== null && typeof l.why !== 'string') return 'letter.why must be a string or null';
  if (l.why_at !== null && !isIso(l.why_at)) return 'letter.why_at must be an ISO date or null';
  if (l.pdf !== null && !isRelPath(l.pdf)) return 'letter.pdf must be a relative path or null';
  if (typeof d.message !== 'string' || chars(d.message) > MESSAGE_MAX) return `message must be a string of at most ${MESSAGE_MAX} characters`;
  if (!Array.isArray(d.answers) || !d.answers.every((x) => isObj(x) && isText(x.q) && typeof x.a === 'string')) return 'answers must be [{q, a}]';
  if (!isRelPath(d.strategy)) return 'strategy must be a relative path';
  if (!isObj(d.check) || typeof d.check.ok !== 'boolean' || !Array.isArray(d.check.reasons)
    || !d.check.reasons.every((r) => typeof r === 'string')) return 'check must be {ok: boolean, reasons: [string]}';
  if (!Array.isArray(d.retouches) || !d.retouches.every((r) => isObj(r) && isText(r.text) && isIso(r.at)
    && (r.done_at === null || isIso(r.done_at)))) return 'retouches must be [{text, at, done_at}]';
  return null;
}

// The dossier stored under tracker number `num`, or null.
function dossierFor(store, num) {
  const n = typeof num === 'number' ? num : /^\d+$/.test(String(num ?? '')) ? parseInt(num, 10) : NaN;
  if (!Number.isInteger(n) || !isObj(store) || !isObj(store.dossiers)) return null;
  const d = store.dossiers[String(n)];
  return isObj(d) ? d : null;
}

// Shared checks of setWhy / addRetouche: {d, text} or {error}.
function prepare(store, num, raw, at) {
  const d = dossierFor(store, num);
  if (!d) return { error: NO_DOSSIER };
  const text = normalizeText(raw);
  if (text === null) return { error: `text must be 1 to ${TEXT_MAX} characters with no control character` };
  if (!isIso(at)) return { error: 'at must be an ISO date' };
  return { d, text };
}

/** The candidate's answer to « Pourquoi cette entreprise ? »: sets letter.why and letter.why_at, no state changes. */
export function setWhy(store, num, text, at) {
  const p = prepare(store, num, text, at);
  if (p.error) return { ok: false, reason: p.error };
  if (!isObj(p.d.letter)) p.d.letter = { state: 'a_completer', why: null, why_at: null, pdf: null };
  p.d.letter.why = p.text;
  p.d.letter.why_at = at;
  return { ok: true };
}

/** A retouche request: appends {text, at, done_at: null} and sends the dossier back to a_refaire. */
export function addRetouche(store, num, text, at) {
  const p = prepare(store, num, text, at);
  if (p.error) return { ok: false, reason: p.error };
  if (!Array.isArray(p.d.retouches)) p.d.retouches = [];
  p.d.retouches.push({ text: p.text, at, done_at: null });
  p.d.state = 'a_refaire';
  return { ok: true };
}
