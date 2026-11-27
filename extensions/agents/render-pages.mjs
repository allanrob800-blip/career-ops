#!/usr/bin/env node
// Renders each page of a PDF to a PNG (A4 at 150 dpi, 1240 × 1754 px): the dashboard shows CVs and letters as page
// images, because its frame cannot open a PDF (extensions/dashboard/README.md, « CV des candidatures »).
//   node extensions/agents/render-pages.mjs --pdf <file.pdf> --out <folder>   → {"pages": ["<folder>/page-1.png", …]}
// A relative --pdf is read from the data root; a relative --out is taken from the current folder (a scratch folder).
import { execFileSync } from 'node:child_process';
import { mkdirSync, readdirSync, rmSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { getCareerOpsRoot } from '../../path-resolver.mjs';
import { isMainModule } from '../../lib/is-main-module.mjs';

const PREFIX = 'page';
// pdftoppm names pages <prefix>-1.png, <prefix>-2.png…, zero-padded to the page count's width (-01 from 10 pages).
const PAGE_FILE = new RegExp(`^${PREFIX}-(\\d+)\\.png$`);

/** The page PNGs in `outDir` (page-1.png, page-02.png…), by page number. */
export function listPages(outDir) {
  return readdirSync(outDir)
    .map((f) => ({ f, m: PAGE_FILE.exec(f) }))
    .filter(({ m }) => m)
    .sort((a, b) => parseInt(a.m[1], 10) - parseInt(b.m[1], 10))
    .map(({ f }) => join(outDir, f));
}

/**
 * Renders every page of `pdfPath` into `outDir` (created if needed) with `pdftoppm -r 150 -png`, run without a shell.
 * Page PNGs left there by an earlier render are removed first. Returns the PNG paths in page order; throws when
 * pdftoppm fails or renders nothing.
 */
export function renderPages(pdfPath, outDir) {
  const pdf = resolve(pdfPath);
  const out = resolve(outDir);
  if (!statSync(pdf).isFile()) throw new Error(`not a file: ${pdf}`);
  mkdirSync(out, { recursive: true });
  for (const p of listPages(out)) rmSync(p, { force: true });
  execFileSync('pdftoppm', ['-r', '150', '-png', pdf, join(out, PREFIX)], { stdio: ['ignore', 'ignore', 'pipe'] });
  const pages = listPages(out);
  if (!pages.length) throw new Error(`pdftoppm rendered no page from ${pdf}`);
  return pages;
}

const USAGE = 'Usage: node extensions/agents/render-pages.mjs --pdf <file.pdf> --out <folder>\n'
  + '(a relative --pdf is read from the data root, a relative --out from the current folder)';

function parseArgs(argv) {
  const opts = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = { '--pdf': 'pdf', '--out': 'out' }[argv[i]];
    if (!key || !argv[i + 1] || opts[key]) return null;
    opts[key] = argv[i + 1];
  }
  return opts.pdf && opts.out ? opts : null;
}

if (isMainModule(import.meta.url)) {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts) {
    console.error(USAGE);
    process.exit(1);
  }
  let pages;
  try {
    pages = renderPages(resolve(getCareerOpsRoot(), opts.pdf), resolve(opts.out));
  } catch (e) {
    console.error(`cannot render pages: ${e.stderr ? String(e.stderr).trim() || e.message : e.message}`);
    process.exit(1);
  }
  process.stdout.write(`${JSON.stringify({ pages }, null, 2)}\n`);
}
