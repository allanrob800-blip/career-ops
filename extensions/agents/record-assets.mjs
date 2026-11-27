#!/usr/bin/env node
// Records the artifact assets of a prepared application's CV or letter in {DATA_ROOT}/data/dashboard.json, under
// cv_assets["<tracker num>"] (extensions/dashboard/README.md, « CV des candidatures »):
//   kind cv     → asset_id, file, sha256, pages
//   kind letter → letter_asset_id, letter_file, letter_sha256, letter_pages
//   node extensions/agents/record-assets.mjs --num N --kind cv|letter --pdf <file.pdf> --upload <upload_asset result>
// The upload file holds the upload_asset tool result as returned, {"assets": [{opaque_id, content_type, sha256…}]},
// in the order the files were sent: the PDF first, then its pages. A relative --pdf is read from the data root, a
// relative --upload from the current folder. Prints {num, kind, entry}.
import { createHash, randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync, renameSync, rmSync, mkdirSync, statSync } from 'node:fs';
import { join, resolve, relative, isAbsolute, sep } from 'node:path';
import { getCareerOpsRoot } from '../../path-resolver.mjs';
import { isMainModule } from '../../lib/is-main-module.mjs';

// The ids extensions/dashboard/lib/snapshot.mjs turns into /_blob/<id> addresses, and its page limit.
const ASSET_ID = /^[A-Za-z0-9_-]{8,128}$/;
const PAGES_MAX = 6;
const FIELDS = {
  cv: { asset_id: 'asset_id', file: 'file', sha256: 'sha256', pages: 'pages' },
  letter: { asset_id: 'letter_asset_id', file: 'letter_file', sha256: 'letter_sha256', pages: 'letter_pages' },
};

const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
const dashboardPath = (root) => join(root, 'data', 'dashboard.json');

// The PDF as a data-root-relative path with / separators, after checking it is a regular file inside the root.
function pdfInRoot(root, pdfPath) {
  if (typeof pdfPath !== 'string' || !pdfPath) throw new Error('pdfPath must be a path');
  const abs = resolve(root, pdfPath);
  const rel = relative(resolve(root), abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`the PDF must be inside the data root: ${abs}`);
  let st;
  try { st = statSync(abs); } catch (e) { throw new Error(`cannot read the PDF ${abs}: ${e.code ?? e.message}`); }
  if (!st.isFile()) throw new Error(`the PDF is not a regular file: ${abs}`);
  return { abs, file: rel.split(sep).join('/') };
}

// [pdfId, [pageIds]] from the upload_asset results, in send order, after checking ids, order and page count.
function assetIds(uploaded, sha256) {
  if (!Array.isArray(uploaded) || !uploaded.every(isObj)) throw new Error('uploaded must be a list of {opaque_id}');
  if (uploaded.length < 2) throw new Error('uploaded must hold the PDF, then at least one page');
  if (uploaded.length - 1 > PAGES_MAX) throw new Error(`uploaded holds ${uploaded.length - 1} pages, ${PAGES_MAX} at most`);
  uploaded.forEach((a, i) => {
    if (typeof a.opaque_id !== 'string' || !ASSET_ID.test(a.opaque_id)) {
      throw new Error(`uploaded[${i}]: asset id must match ${ASSET_ID.source}`);
    }
    const want = i === 0 ? 'application/pdf' : 'image/png';
    if (a.content_type !== undefined && a.content_type !== want) {
      throw new Error(`uploaded[${i}]: content_type is ${a.content_type}, expected ${want} (the PDF first, then its pages)`);
    }
  });
  const sent = uploaded[0].sha256;
  if (sent !== undefined && (typeof sent !== 'string' || sent.toLowerCase() !== sha256)) {
    throw new Error('uploaded[0]: its sha256 is not the PDF\'s: the PDF changed after the upload, or another file was sent');
  }
  return [uploaded[0].opaque_id, uploaded.slice(1).map((a) => a.opaque_id)];
}

// data/dashboard.json as an object; {} when absent. Throws on anything else, so it is never overwritten blindly.
function readDashboard(root) {
  let text;
  try { text = readFileSync(dashboardPath(root), 'utf8'); } catch (e) {
    if (e.code === 'ENOENT') return {};
    throw e;
  }
  let doc;
  try { doc = JSON.parse(text); } catch (e) { throw new Error(`data/dashboard.json is not valid JSON: ${e.message}`); }
  if (!isObj(doc)) throw new Error('data/dashboard.json must hold a JSON object');
  if (doc.cv_assets !== undefined && !isObj(doc.cv_assets)) throw new Error('data/dashboard.json: cv_assets must be an object');
  return doc;
}

// Atomic write: a temporary file beside it, then a rename over it.
function writeDashboard(root, doc) {
  const file = dashboardPath(root);
  mkdirSync(join(root, 'data'), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(doc, null, 2)}\n`);
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

/**
 * Records the uploaded PDF (uploaded[0]) and its pages (uploaded[1…]) of application `num`'s CV or letter in
 * {root}/data/dashboard.json, with the PDF's path (data-root relative) and sha256. Every other key of the file and of
 * the entry is kept. Returns the entry as written. Throws, writing nothing, on an asset id outside
 * ^[A-Za-z0-9_-]{8,128}$, a PDF outside the data root, an upload whose order or sha256 does not match, or a
 * dashboard.json that is not a JSON object.
 */
export function recordAssets({ root, num, kind, pdfPath, uploaded }) {
  if (!Number.isInteger(num) || num < 1) throw new Error('num must be a positive integer');
  const fields = Object.hasOwn(FIELDS, kind) ? FIELDS[kind] : null;
  if (!fields) throw new Error('kind must be cv or letter');
  const { abs, file } = pdfInRoot(root, pdfPath);
  const sha256 = createHash('sha256').update(readFileSync(abs)).digest('hex');
  const [pdfId, pages] = assetIds(uploaded, sha256);
  const doc = readDashboard(root);
  if (!doc.cv_assets) doc.cv_assets = {};
  const key = String(num);
  const entry = isObj(doc.cv_assets[key]) ? doc.cv_assets[key] : {};
  Object.assign(entry, { [fields.asset_id]: pdfId, [fields.file]: file, [fields.sha256]: sha256, [fields.pages]: pages });
  doc.cv_assets[key] = entry;
  writeDashboard(root, doc);
  return entry;
}

// ── CLI ──────────────────────────────────────────────────────────────────────

const USAGE = 'Usage: node extensions/agents/record-assets.mjs --num N --kind cv|letter --pdf <file.pdf> --upload <upload_asset result.json>\n'
  + '(a relative --pdf is read from the data root, a relative --upload from the current folder)';

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = { '--num': 'num', '--kind': 'kind', '--pdf': 'pdf', '--upload': 'upload' }[argv[i]];
    if (!key || !argv[i + 1] || opts[key]) return null;
    opts[key] = argv[i + 1];
  }
  if (!opts.pdf || !opts.upload || !/^\d+$/.test(opts.num ?? '') || !Object.hasOwn(FIELDS, opts.kind ?? '')) return null;
  return { ...opts, num: parseInt(opts.num, 10) };
}

if (isMainModule(import.meta.url)) {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts) {
    console.error(USAGE);
    process.exit(1);
  }
  try {
    const result = JSON.parse(readFileSync(resolve(opts.upload), 'utf8'));
    if (!isObj(result) || !Array.isArray(result.assets)) throw new Error('the upload file must hold {"assets": […]}');
    const entry = recordAssets({ root: getCareerOpsRoot(), num: opts.num, kind: opts.kind, pdfPath: opts.pdf, uploaded: result.assets });
    process.stdout.write(`${JSON.stringify({ num: opts.num, kind: opts.kind, entry }, null, 2)}\n`);
  } catch (e) {
    console.error(`cannot record assets: ${e.message}`);
    process.exit(1);
  }
}
