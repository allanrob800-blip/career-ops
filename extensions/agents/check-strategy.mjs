#!/usr/bin/env node
// The strategy sheet the Expert CV et lettre writes for each prepared application ({DATA_ROOT}/output/
// {num}-{entreprise}-strategie.json, spec § 6.3), and its consistency check against the generated CV HTML:
//   node extensions/agents/check-strategy.mjs --sheet <json> --cv-html <html>   → {"ok": …, "reasons": […]}
// Exit code 1 when ok is false. A relative path is read from the data root (dossier paths are data-root relative).
// The CV HTML is the exact source of the PDF generate-pdf.mjs renders, so its visible text is the PDF's text.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getCareerOpsRoot } from '../../path-resolver.mjs';
import { isMainModule } from '../../lib/is-main-module.mjs';

const STRING_MAX = 600;
const ARRAY_MAX = 12;
// A proof cites a primary, user-authored file (AGENTS.md, Source-of-Truth Boundary): its name, then nothing or a
// separator (« cv.md › expérience la plus récente »), never a longer file name (cv.md.bak, cv.mdx).
const SOURCE = /^(?:cv\.md|article-digest\.md|config\/profile\.yml|modes\/_profile\.md)(?![\w./-])/;
const SOURCE_LIST = 'cv.md, article-digest.md, config/profile.yml ou modes/_profile.md';

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const isText = (v) => typeof v === 'string' && v.trim() !== '';
const bound = (s) => {
  const cps = [...s];
  return cps.length > STRING_MAX ? `${cps.slice(0, STRING_MAX - 1).join('')}…` : s;
};
// One wording per problem, so the CLI can merge validateSheet errors and checkStrategy reasons without repeats.
const mustBeText = (field) => `${field} doit être un texte non vide`;
const mustBeList = (field) => `${field} doit être une liste`;

// ── Visible text ─────────────────────────────────────────────────────────────

// Elements whose content is never shown on the page.
const HIDDEN = /<(head|title|style|script|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi;
const COMMENT = /<!--[\s\S]*?-->/g;
// <!DOCTYPE …>, <![CDATA[…]]> and <?…?> declarations.
const DECLARATION = /<!\[CDATA\[[\s\S]*?\]\]>|<[!?][^>]*>/g;
// Inline elements join their text to the neighbouring text (« Conduite du <strong>changement</strong> »); every
// other tag separates words.
const INLINE = new Set(['a', 'abbr', 'b', 'bdi', 'bdo', 'cite', 'code', 'data', 'dfn', 'em', 'i', 'kbd', 'mark', 'q',
  's', 'samp', 'small', 'span', 'strong', 'sub', 'sup', 'time', 'u', 'var', 'wbr', 'font']);
const TAG = /<\/?([a-zA-Z][\w-]*)\b(?:[^>"']|"[^"]*"|'[^']*')*>/g;
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', thinsp: ' ', ensp: ' ', emsp: ' ',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', laquo: '«', raquo: '»',
  hellip: '…', ndash: '–', mdash: '—', middot: '·', bull: '•', euro: '€',
  copy: '©', reg: '®', trade: '™', deg: '°', times: '×',
  agrave: 'à', acirc: 'â', auml: 'ä', ccedil: 'ç', eacute: 'é', egrave: 'è', ecirc: 'ê', euml: 'ë', icirc: 'î',
  iuml: 'ï', ocirc: 'ô', ouml: 'ö', ugrave: 'ù', ucirc: 'û', uuml: 'ü', yuml: 'ÿ', oelig: 'œ', aelig: 'æ',
  Agrave: 'À', Acirc: 'Â', Ccedil: 'Ç', Eacute: 'É', Egrave: 'È', Ecirc: 'Ê', Icirc: 'Î', Ocirc: 'Ô', Ucirc: 'Û',
  OElig: 'Œ', AElig: 'Æ',
};

function decodeEntities(s) {
  return s.replace(/&(#\d+|#x[0-9a-f]+|[a-z][a-z0-9]*);/gi, (m, name) => {
    if (name[0] !== '#') return Object.hasOwn(ENTITIES, name) ? ENTITIES[name] : m;
    const cp = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return cp > 0 && cp <= 0x10ffff && !(cp >= 0xd800 && cp <= 0xdfff) ? String.fromCodePoint(cp) : m;
  });
}

// Text of an HTML fragment with no markup: tags dropped, entities decoded, `**` bold markers removed (generate-pdf.mjs
// turns them into <strong>), whitespace collapsed.
function fragmentText(html) {
  const text = html.replace(TAG, (_, name) => (INLINE.has(name.toLowerCase()) ? '' : ' '));
  return decodeEntities(text).replace(/\*\*/g, '').replace(/\s+/g, ' ').trim();
}

const stripHidden = (html) => html.replace(COMMENT, ' ').replace(DECLARATION, ' ').replace(HIDDEN, ' ');

/** The text a reader sees in the CV: no styles, scripts, head, comments, tags or attributes. */
export function visibleText(html) {
  return fragmentText(stripHidden(String(html ?? '')));
}

// The visible text of the first element whose class list holds `header-title`, or null when there is none.
function headerTitle(html) {
  const body = stripHidden(html);
  const open = /<([a-zA-Z][\w-]*)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/g;
  for (let m; (m = open.exec(body));) {
    const cls = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/i.exec(m[2]);
    const tokens = cls ? (cls[1] ?? cls[2] ?? cls[3]).split(/\s+/) : [];
    if (!tokens.includes('header-title')) continue;
    const tag = m[1].toLowerCase();
    const start = open.lastIndex;
    const pair = new RegExp(`<(/?)${tag}\\b(?:[^>"']|"[^"]*"|'[^']*')*>`, 'gi');
    pair.lastIndex = start;
    let depth = 1;
    for (let p; (p = pair.exec(body));) {
      depth += p[1] ? -1 : 1;
      if (depth === 0) return fragmentText(body.slice(start, p.index));
    }
    return fragmentText(body.slice(start));
  }
  return null;
}

const sameApostrophe = (s) => s.replace(/[’‘ʼ]/g, "'");
// Title comparison: equal up to case and whitespace (accents count).
const titleKey = (s) => sameApostrophe(s.normalize('NFC')).replace(/\s+/g, ' ').trim().toLowerCase();
// Keyword search: case and accents ignored.
const fold = (s) => sameApostrophe(s.normalize('NFD').replace(/\p{M}/gu, '')).replace(/\s+/g, ' ').trim().toLowerCase();
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&');

/**
 * The consistency check of spec § 6.3: `titre_cv` is the CV's `.header-title` (up to case and whitespace), and each
 * `mots_cles_repris` appears, as whole words, in the CV's visible text (case and accents ignored).
 * reasons names the different title and each absent keyword.
 */
export function checkStrategy(sheet, cvHtml) {
  const reasons = [];
  const s = isObj(sheet) ? sheet : {};
  const html = String(cvHtml ?? '');
  if (!isText(s.titre_cv)) reasons.push(mustBeText('titre_cv'));
  else {
    const cvTitle = headerTitle(html);
    if (cvTitle === null || cvTitle === '') reasons.push('le CV n\'a pas de titre sous le nom (élément .header-title)');
    else if (titleKey(s.titre_cv) !== titleKey(cvTitle)) {
      reasons.push(`titre du CV différent : la fiche dit « ${s.titre_cv.trim()} », le CV affiche « ${cvTitle} »`);
    }
  }
  if (!Array.isArray(s.mots_cles_repris)) reasons.push(mustBeList('mots_cles_repris'));
  else {
    const text = fold(visibleText(html));
    s.mots_cles_repris.forEach((kw, i) => {
      if (!isText(kw)) { reasons.push(mustBeText(`mots_cles_repris[${i}]`)); return; }
      const re = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRe(fold(kw))}(?![\\p{L}\\p{N}])`, 'u');
      if (!re.test(text)) reasons.push(`mot-clé absent du CV : « ${kw.trim()} »`);
    });
  }
  return { ok: reasons.length === 0, reasons };
}

// ── Sheet validation ─────────────────────────────────────────────────────────

// A list field: each valid item bounded, each invalid one reported and dropped, at most 12 kept.
function boundList(value, field, item, errors) {
  if (!Array.isArray(value)) { errors.push(mustBeList(field)); return null; }
  const out = [];
  value.forEach((v, i) => {
    const r = item(v, `${field}[${i}]`);
    if (typeof r === 'string') errors.push(r);
    else out.push(r.value);
  });
  return out.slice(0, ARRAY_MAX);
}

const textItem = (v, at) => (isText(v) ? { value: bound(v) } : mustBeText(at));
// An item {a, b} of two non-empty strings.
const pairItem = (a, b) => (v, at) => {
  if (!isObj(v)) return `${at} doit être {${a}, ${b}}`;
  if (!isText(v[a])) return mustBeText(`${at}.${a}`);
  if (!isText(v[b])) return mustBeText(`${at}.${b}`);
  return { value: { [a]: bound(v[a]), [b]: bound(v[b]) } };
};
const proofItem = (v, at) => {
  const r = pairItem('texte', 'source')(v, at);
  if (typeof r === 'string') return r;
  return SOURCE.test(v.source) ? r : `${at}.source doit commencer par ${SOURCE_LIST} (reçu « ${bound(v.source)} »)`;
};

/**
 * A bounded copy of a strategy sheet (strings of 600 characters at most, lists of 12 items at most, unknown fields
 * dropped) and the problems found. Required: titre_cv, angle (texts), preuves, mots_cles_repris (lists). Optional:
 * lettre_angle (absent, null or blank: null in the copy), mots_cles_ecartes, ecarts, verification. An invalid item, such as a proof whose source is not
 * cv.md, article-digest.md, config/profile.yml or modes/_profile.md, is reported and left out of the copy.
 */
export function validateSheet(sheet) {
  const errors = [];
  if (!isObj(sheet)) return { sheet: {}, errors: ['la fiche stratégie doit être un objet JSON'] };
  const out = {};
  for (const field of ['titre_cv', 'angle']) {
    if (isText(sheet[field])) out[field] = bound(sheet[field]);
    else errors.push(mustBeText(field));
  }
  // The sheet is written before the letter, which waits for the candidate's « Pourquoi cette entreprise ? »:
  // lettre_angle absent, null or blank is null.
  const la = sheet.lettre_angle;
  if (isText(la)) out.lettre_angle = bound(la);
  else if (la === undefined || la === null || typeof la === 'string') out.lettre_angle = null;
  else errors.push('lettre_angle doit être un texte ou null');
  const lists = [
    ['preuves', true, proofItem],
    ['mots_cles_repris', true, textItem],
    ['mots_cles_ecartes', false, pairItem('mot', 'raison')],
    ['ecarts', false, pairItem('exigence', 'traitement')],
  ];
  for (const [field, required, item] of lists) {
    if (!required && sheet[field] === undefined) continue;
    const list = boundList(sheet[field], field, item, errors);
    if (list) out[field] = list;
  }
  const v = sheet.verification;
  if (v !== undefined) {
    if (isObj(v) && typeof v.ok === 'boolean' && Array.isArray(v.reasons) && v.reasons.every((r) => typeof r === 'string')) {
      out.verification = { ok: v.ok, reasons: v.reasons.slice(0, ARRAY_MAX).map(bound) };
    } else errors.push('verification doit être {ok, reasons}');
  }
  return { sheet: out, errors };
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const USAGE = 'Usage: node extensions/agents/check-strategy.mjs --sheet <fiche.json> --cv-html <cv.html>\n'
  + '(a relative path is read from the data root)';

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = { '--sheet': 'sheet', '--cv-html': 'cvHtml' }[argv[i]];
    if (!key || !argv[i + 1] || opts[key]) return null;
    opts[key] = argv[i + 1];
  }
  return opts.sheet && opts.cvHtml ? opts : null;
}

if (isMainModule(import.meta.url)) {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts) {
    console.error(USAGE);
    process.exit(1);
  }
  const root = getCareerOpsRoot();
  let raw;
  let html;
  try {
    const sheetPath = resolve(root, opts.sheet);
    try { raw = JSON.parse(readFileSync(sheetPath, 'utf8')); } catch (e) { throw new Error(`${sheetPath}: ${e.message}`); }
    html = readFileSync(resolve(root, opts.cvHtml), 'utf8');
  } catch (e) {
    console.error(`cannot read input: ${e.message}`);
    process.exit(1);
  }
  const { sheet, errors } = validateSheet(raw);
  const check = checkStrategy(sheet, html);
  const reasons = [...new Set([...errors, ...check.reasons])];
  const ok = reasons.length === 0;
  process.stdout.write(`${JSON.stringify({ ok, reasons }, null, 2)}\n`);
  process.exit(ok ? 0 : 1);
}
