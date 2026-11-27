// Playwright harness: static server for page/, fake-claude injection, error collection.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, extname, dirname, normalize, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium, devices } from 'playwright';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PAGE_ROOT = join(HERE, '..', '..', 'page');
export const FAKE_CLAUDE = join(HERE, 'fake-claude.js');

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
};

export async function startServer() {
  const server = createServer(async (req, res) => {
    try {
      let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      if (p.endsWith('/')) p += 'index.html';
      const file = normalize(join(PAGE_ROOT, p));
      if (!file.startsWith(PAGE_ROOT + sep)) { res.writeHead(403).end(); return; }
      const body = await readFile(file);
      res.writeHead(200, { 'content-type': TYPES[extname(file)] || 'application/octet-stream' });
      res.end(body);
    } catch {
      res.writeHead(404).end('not found');
    }
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  return { url: `http://127.0.0.1:${port}/`, close: () => new Promise((r) => server.close(r)) };
}

// Preinstalled browser when the library/browser versions differ; plain launch() elsewhere.
const PREINSTALLED = '/opt/pw-browsers/chromium';
export function launchBrowser() {
  return existsSync(PREINSTALLED) ? chromium.launch({ executablePath: PREINSTALLED }) : chromium.launch();
}

function contextOptions(device) {
  if (device === 'iPhone 15 Pro Max') {
    return devices['iPhone 15 Pro Max'] || { viewport: { width: 430, height: 932 }, isMobile: true, hasTouch: true, deviceScaleFactor: 1 };
  }
  return { viewport: { width: device.width, height: device.height }, deviceScaleFactor: 1 };
}

/**
 * Opens the page. Returns { page, context, errors, close }.
 * opts: { url (server url), device, theme, reducedMotion, fake, hash, now (fixed Date.now: Date|string|number),
 *         manualStart (app.js does not start CapData; the test calls CapData.start itself),
 *         init (function run in the page before its scripts, e.g. to record events),
 *         block (a URL pattern whose requests are aborted, e.g. /app\.js$/) }
 */
export async function openPage(browser, opts) {
  const { url, device = { width: 1440, height: 900 }, theme, reducedMotion, fake, hash = '', now, manualStart, init } = opts;
  const context = await browser.newContext({
    ...contextOptions(device),
    ...(reducedMotion ? { reducedMotion: 'reduce' } : {}),
  });
  // Google Fonts is the only allowed external load; stub it so tests stay offline.
  await context.route(/https:\/\/fonts\.(googleapis|gstatic)\.com\//, (route) =>
    route.fulfill({ status: 200, contentType: 'text/css', body: '' }));
  if (now != null) await context.clock.setFixedTime(new Date(now)); // timers keep running
  if (opts.block) await context.route(opts.block, (route) => route.abort()); // e.g. a script that must not run
  await context.addInitScript({ path: FAKE_CLAUDE });
  if (manualStart) await context.addInitScript(() => { globalThis.CAP_MANUAL_START = true; });
  if (fake) await context.addInitScript((f) => { Object.assign(window.__fake, f); }, fake);
  if (init) await context.addInitScript(init);
  if (theme) {
    // <html> does not exist yet when init scripts run: set the attribute as soon as it appears.
    await context.addInitScript((t) => {
      const set = () => { if (document.documentElement) { document.documentElement.dataset.theme = t; return true; } return false; };
      if (set()) return;
      const mo = new MutationObserver(() => { if (set()) mo.disconnect(); });
      mo.observe(document, { childList: true });
    }, theme);
  }
  const page = await context.newPage();
  const errors = [];
  page.on('console', (m) => { if (m.type() === 'error') errors.push(`console: ${m.text()}`); });
  page.on('pageerror', (e) => errors.push(`pageerror: ${e.message}`));
  await page.goto(url + (hash ? `#${hash}` : ''), { waitUntil: 'load' });
  return { page, context, errors, close: () => context.close() };
}
