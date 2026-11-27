// Task 7: Accueil, Offres, Candidatures, Analytique on the fixture snapshot (and an empty db).
// Task 8 adds Planning and Messages to the shared layout, touch-target, hostile-data and empty-state checks.
// Task 9 adds Réglages, the open palette, the search buttons and the home Outlook failure rows to layout and touch targets.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateSync, crc32 } from 'node:zlib';
import { startServer, launchBrowser, openPage } from './harness.mjs';
import { fixtureDocs, EMAILS, EVENTS, NOW } from './fixtures.mjs';

const SHOTS = join(tmpdir(), 'cap-shots');
const SCREENS = ['accueil', 'offres', 'candidatures', 'analytique'];
const OUTLOOK = ['planning', 'messages']; // Task 8: need a delivered Outlook section before they are measured
const ALL = [...SCREENS, ...OUTLOOK];
const EVERY = [...ALL, 'reglages']; // Réglages has no empty gate: it renders without a snapshot

let server, browser, DOCS;
before(async () => { DOCS = fixtureDocs(); server = await startServer(); browser = await launchBrowser(); mkdirSync(SHOTS, { recursive: true }); });
after(async () => { await browser?.close(); await server?.close(); });

async function open(opts = {}) {
  const { docs = DOCS, mcp = {}, ...rest } = opts;
  const fake = { db: { docs: structuredClone(docs) }, mcp: { mode: 'ok', emails: EMAILS, events: EVENTS, ...mcp } };
  const p = await openPage(browser, { url: server.url, now: NOW, fake, ...rest });
  p.page.setDefaultTimeout(5000);
  p.dialogs = [];
  p.page.on('dialog', (d) => { p.dialogs.push(d.message()); d.dismiss().catch(() => {}); });
  return p;
}
const body = (name) => `#screen-${name} .screen-body`;
async function go(p, name, view = name) {
  await p.page.evaluate((n) => { location.hash = n; }, name);
  await p.page.waitForFunction(([sel, v, o]) => {
    const el = document.querySelector(sel);
    return el?.dataset.view === v && (!o || el.dataset.outlook === 'ok');
  }, [body(name), view, view === name && OUTLOOK.includes(name)]);
  await p.page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}

test('Accueil: greeting, weekly goal 3 sur 3 (ISO week 23-29/11, Paris), KPI cards', async () => {
  const p = await open({ hash: 'accueil' });
  try {
    await go(p, 'accueil');
    await p.page.waitForFunction(() => document.getElementById('goal-count')?.textContent.replace(/\s+/g, ' ').trim() === '3 sur 3');
    assert.match(await p.page.locator('#h-accueil').innerText(), /^Bonjour Camille/);
    await p.page.waitForFunction(() => document.querySelector('[data-kpi=sent] .kpi-num')?.textContent.trim() === '6');
    await p.page.waitForFunction(() => document.querySelector('[data-kpi=rate] .kpi-num')?.textContent.replace(/\s/g, '') === '50%');
    assert.equal((await p.page.locator('[data-kpi=interviews] .kpi-num').innerText()).trim(), '1');
    assert.equal((await p.page.locator('[data-kpi=offers] .kpi-num').innerText()).trim(), '0');
    await p.page.waitForFunction(() => document.querySelector('[data-count=messages]'));
    const todo = await p.page.locator('#todo').innerText();
    assert.match(todo, /Borealis/); // overdue follow-up
    assert.doesNotMatch(todo, /Outlook non connecté/); // Task 8 provides ctx.outlook
    assert.match(todo, /2\s+messages à traiter/);
    assert.equal(await p.page.locator('.mini-week [data-day]').count(), 7);
    assert.match(await p.page.locator('#sync-note').innerText(), /Synchronisé/);
    assert.deepEqual(p.errors, []);
  } finally { await p.close(); }
});

test('Accueil: offer closing within 7 days shows a flame (SVG, no emoji)', async () => {
  const docs = structuredClone(DOCS);
  const part = Object.keys(docs).find((k) => k.startsWith('snapshot/apps-'));
  docs[part].items.find((a) => a.num === 1).closes_at = '2026-11-30';
  const p = await open({ docs });
  try {
    await go(p, 'accueil');
    const row = p.page.locator('#todo [data-closing]', { hasText: 'Acme' });
    assert.equal(await row.count(), 1);
    assert.equal(await row.locator('svg.flame').count(), 1);
    assert.doesNotMatch(await row.innerText(), /\u{1F525}/u);
  } finally { await p.close(); }
});

test('hostile company name renders as text everywhere, no img, no dialog', async () => {
  const p = await open();
  try {
    for (const s of ALL) {
      await go(p, s);
      assert.equal(await p.page.locator('img[src=x]').count(), 0, `img on ${s}`);
    }
    await go(p, 'candidatures');
    assert.ok(await p.page.locator('text=<img src=x').first().isVisible());
    await p.page.waitForTimeout(100);
    assert.deepEqual(p.dialogs, []);
    assert.deepEqual(p.errors, []);
  } finally { await p.close(); }
});

test('Offres: sorted by score, javascript: url never linked, https links kept, report panel', async () => {
  const p = await open();
  try {
    await go(p, 'offres');
    assert.equal(await p.page.locator('a[href^="javascript"]').count(), 0);
    assert.ok(await p.page.locator('.offer', { hasText: 'Evil Corp' }).isVisible());
    assert.ok(await p.page.locator('a[href^="https://jobs.acme.fr/"]').count() >= 1);
    const first = await p.page.locator('.offer').first().innerText();
    assert.match(first, /Acme/); // the only scored offer comes first
    await p.page.locator('#offer-filter').fill('evil');
    assert.equal(await p.page.locator('.offer:visible').count(), 1);
    await p.page.locator('#offer-filter').fill('');
    await p.page.locator('.offer', { hasText: 'Acme' }).locator('button[data-report]').click();
    const dlg = p.page.locator('.dlg[role=dialog][aria-modal=true]');
    assert.ok(await dlg.isVisible());
    const txt = await dlg.innerText();
    assert.match(txt, /Product \/ Platform/);
    assert.match(txt, /five years leading product teams/);
    assert.doesNotMatch(txt, /[✅❌⚠]/u);
    await p.page.keyboard.press('Escape');
    assert.equal(await dlg.count(), 0);
    assert.deepEqual(p.errors, []);
  } finally { await p.close(); }
});

test('Candidatures: status filter, detail sheet, status request -> pending doc + row badge', async () => {
  const p = await open();
  try {
    await go(p, 'candidatures');
    await p.page.locator('[data-filter=Applied]').click();
    assert.equal(await p.page.locator('#app-list [data-num]:visible').count(), 3);
    await p.page.locator('[data-filter=all]').click();
    await p.page.locator('#app-list [data-num="3"] .row-open').click();
    const dlg = p.page.locator('.dlg[role=dialog][aria-modal=true]');
    assert.match(await dlg.innerText(), /Cobalt SAS/);
    const options = await dlg.locator('#detail-status option').evaluateAll((os) => os.map((o) => o.value));
    assert.deepEqual(options, ['Evaluated', 'Speculative', 'Applied', 'Responded', 'Assessment', 'Interview', 'Offer', 'Hired', 'Rejected', 'Discarded', 'SKIP']);
    await dlg.locator('#detail-status').selectOption('Interview');
    await dlg.locator('#detail-status-send').click();
    await p.page.waitForFunction(() => Object.entries(window.__fake.db.docs).some(([k, v]) => k.startsWith('requests/') && v.ref === 3 && v.from_status === 'Applied' && v.to_status === 'Interview' && v.state === 'pending' && v.type === 'status'));
    await p.page.waitForFunction(() => /En attente de synchronisation/.test(document.querySelector('#app-list [data-num="3"]')?.textContent || ''));
    assert.match(await dlg.innerText(), /En attente de synchronisation/);
    // a second request on the same row chains on the pending one; asking for the pending target again is refused
    await dlg.locator('#detail-status').selectOption('Interview');
    await dlg.locator('#detail-status-send').click();
    assert.match(await dlg.locator('#err-status').innerText(), /déjà/);
    // note: typed with a Return, sent as one line; the counter starts over
    await dlg.locator('#detail-note').fill('Relancer après');
    await dlg.locator('#detail-note').press('Enter');
    await dlg.locator('#detail-note').pressSequentially('le salon');
    assert.match(await dlg.locator('#note-left').innerText(), /restants/);
    await dlg.locator('#detail-note-send').click();
    await p.page.waitForFunction(() => Object.values(window.__fake.db.docs).some((v) => v.type === 'note' && v.ref === 3 && v.note === 'Relancer après le salon'));
    await p.page.waitForFunction(() => document.querySelector('#detail-note').value === '' && document.querySelector('#note-left').textContent === '500 caractères au plus');
    assert.equal(await dlg.locator('#err-note').isVisible(), false);
    assert.deepEqual(p.errors, []);
  } finally { await p.close(); }
});

test('Candidatures: column view by status above 1100px only', async () => {
  const p = await open();
  try {
    await go(p, 'candidatures');
    await p.page.locator('[data-layout=columns]').click();
    assert.ok(await p.page.locator('.kanban .kcol').first().isVisible());
    assert.ok(await p.page.locator('.kanban [data-num="6"]').isVisible());
  } finally { await p.close(); }
  const q = await open({ device: { width: 720, height: 900 } });
  try {
    await go(q, 'candidatures');
    assert.equal(await q.page.locator('[data-layout=columns]').isVisible(), false);
  } finally { await q.close(); }
});

test('Analytique: period toggle redraws the curve; funnel, donut, response rate', async () => {
  const p = await open();
  try {
    await go(p, 'analytique');
    const d = () => p.page.locator('#timeline-chart path.line-main').getAttribute('d');
    await p.page.locator('[data-period="7"]').click();
    const d7 = await d();
    await p.page.locator('[data-period="all"]').click();
    const dAll = await d();
    assert.ok(d7 && dAll && d7 !== dAll);
    assert.equal(await p.page.locator('[data-period="all"]').getAttribute('aria-pressed'), 'true');
    // the timeline holds 180 days: the widest period says so
    assert.deepEqual(await p.page.locator('[data-period]').allInnerTexts(), ['7 j', '30 j', '6 mois']);
    assert.equal(await p.page.locator('.funnel-row').count(), 5);
    assert.ok(await p.page.locator('#status-donut path').count() >= 3);
    await p.page.waitForFunction(() => document.getElementById('rate-big')?.textContent.replace(/\s/g, '') === '50%');
    assert.deepEqual(p.errors, []);
  } finally { await p.close(); }
});

test('empty database: every screen shows its French empty state, no console error', async () => {
  const p = await open({ docs: {} });
  try {
    const expect = { accueil: /synchronisation/, offres: /Aucune offre/, candidatures: /Aucune candidature/, analytique: /Pas encore/, planning: /synchronisation/, messages: /synchronisation/ };
    for (const s of ALL) {
      await go(p, s, 'gate-empty');
      const e = p.page.locator(`${body(s)} .empty`);
      assert.ok(await e.isVisible(), s);
      assert.match(await e.innerText(), expect[s]);
    }
    assert.deepEqual(p.errors, []);
  } finally { await p.close(); }
});

test('accent tokens keep AA contrast for text and filled surfaces (5 accents x light/dark)', async () => {
  for (const theme of ['light', 'dark']) {
    const p = await open({ theme, docs: {} });
    try {
      const res = await p.page.evaluate(() => {
        const cv = document.createElement('canvas').getContext('2d', { willReadFrequently: true });
        const rgb = (c) => { cv.clearRect(0, 0, 1, 1); cv.fillStyle = '#000'; cv.fillStyle = c; cv.fillRect(0, 0, 1, 1); return [...cv.getImageData(0, 0, 1, 1).data].slice(0, 3).map((v) => v / 255); };
        const lum = (c) => { const [r, g, b] = rgb(c).map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4)); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
        const cr = (a, b) => { const x = lum(a), y = lum(b); return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
        document.documentElement.style.transition = 'none'; // read the target accent, not the animated --acc
        const probe = document.createElement('div');
        document.body.append(probe);
        const v = (name) => { probe.style.color = `var(${name})`; return getComputedStyle(probe).color; };
        const out = [];
        for (const a of ['corail', 'vert-eau', 'violet', 'bleu', 'ambre']) {
          document.documentElement.dataset.accent = a;
          out.push({ a, ink: cr(v('--acc-ink'), v('--bg')), inkGlass: cr(v('--acc-ink'), v('--glass-solid')), fill1: cr(v('--on-acc'), v('--acc-fill')), fill2: cr(v('--on-acc'), v('--acc-fill2')), acc: v('--acc') });
        }
        probe.remove();
        return out;
      });
      const accs = new Set(res.map((r) => r.acc));
      assert.equal(accs.size, 5, 'each accent changes --acc');
      for (const r of res) for (const k of ['ink', 'inkGlass', 'fill1', 'fill2']) assert.ok(r[k] >= 4.5, `${theme} ${r.a} ${k} ${r[k].toFixed(2)}`);
    } finally { await p.close(); }
  }
});

test('reduced motion (prefs): no running animations after render', async () => {
  const docs = { ...DOCS, 'settings/prefs': { weekly_goal: 3, accent: 'corail', reduced_motion: true } };
  const p = await open({ docs });
  try {
    await go(p, 'accueil');
    await p.page.waitForFunction(() => document.documentElement.dataset.motion === 'reduce');
    await go(p, 'analytique');
    await p.page.waitForTimeout(100);
    assert.equal(await p.page.evaluate(() => document.getAnimations().length), 0);
    assert.equal((await p.page.locator('#rate-big').innerText()).replace(/\s/g, ''), '50%');
  } finally { await p.close(); }
});

// No horizontal overflow at 4 widths x 3 theme modes; one screenshot per screen (outside the repo).
const overflowScan = () => {
  const W = document.documentElement.clientWidth;
  const clipped = (n) => { for (; n && n !== document.body; n = n.parentElement) { const r = n.getBoundingClientRect(); if (r.width <= 1 || r.height <= 1) return true; } return false; };
  const bad = [];
  for (const el of document.querySelectorAll('body *')) {
    const sc = el.closest('.scroll');
    if (sc && sc !== el) continue;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) continue;
    const name = `${el.tagName.toLowerCase()}.${[...el.classList].join('.')}#${el.id}`;
    if (r.right > W + 1 || r.left < -1) bad.push(`${name} [${Math.round(r.left)}, ${Math.round(r.right)}]`);
    // content wider than its own box (global min-width:0 lets nowrap children shrink below their text)
    // (.scroll containers scroll on purpose; visually-hidden boxes, e.g. .sr-only or the phone table header, are 1px wide)
    else if (!el.closest('.scroll, .sr-only, .backdrop') && !clipped(el) && el.scrollWidth > el.clientWidth + 1 && el.clientWidth > 0) bad.push(`${name} content ${el.scrollWidth} > box ${el.clientWidth}`);
  }
  return { sw: document.documentElement.scrollWidth, W, bad: bad.slice(0, 6) };
};
for (const width of [360, 430, 720, 1440]) {
  for (const theme of ['light', 'dark', undefined]) {
    test(`layout ${width}px theme=${theme ?? 'none'}: no horizontal overflow, screenshots`, async () => {
      const p = await open({ device: { width, height: 900 }, theme, reducedMotion: true });
      try {
        for (const s of EVERY) {
          await go(p, s);
          await p.page.waitForTimeout(30);
          const r = await p.page.evaluate(overflowScan);
          assert.ok(r.sw <= r.W, `${s}: scrollWidth ${r.sw} > ${r.W}`);
          assert.deepEqual(r.bad, [], `${s}: elements past the right edge`);
          await p.page.screenshot({ path: join(SHOTS, `${s}-${width}-${theme ?? 'auto'}.png`), fullPage: true });
        }
        // the open palette, with results, over the last screen
        await go(p, 'accueil');
        await p.page.keyboard.press('Control+K');
        await p.page.locator('#palette').waitFor();
        await p.page.locator('#pal-input').fill('a');
        await p.page.waitForFunction(() => document.querySelectorAll('#pal-list [role=option]').length > 3);
        const r = await p.page.evaluate(overflowScan);
        assert.ok(r.sw <= r.W, `palette: scrollWidth ${r.sw} > ${r.W}`);
        assert.deepEqual(r.bad, [], 'palette: elements past the right edge');
        const box = await p.page.locator('#palette .pal-panel').boundingBox();
        assert.ok(box.x >= 0 && box.x + box.width <= width && box.y >= 0, `palette panel inside the viewport: ${JSON.stringify(box)}`);
        await p.page.screenshot({ path: join(SHOTS, `palette-${width}-${theme ?? 'auto'}.png`) });
        assert.deepEqual(p.errors, []);
      } finally { await p.close(); }
    });
  }
}

const tooSmall = (sel) => [...document.querySelectorAll(`${sel} :is(button, a[href], summary, select, input, textarea)`)]
  .map((el) => ({ el, r: el.getBoundingClientRect() }))
  .filter(({ r }) => r.width > 0 && r.height > 0 && r.height < 44)
  .map(({ el, r }) => `${el.tagName.toLowerCase()}.${[...el.classList].join('.')} "${el.textContent.trim().slice(0, 20)}" ${Math.round(r.height)}px`);

// Binding rule: every interactive control in a screen has a hit area >= 44px tall (430px phone).
// No inline text links inside paragraphs exist in these screens, so nothing is excluded.
test('touch targets: buttons, links, summaries and fields in screens are >= 44px tall at 430px', async () => {
  const p = await open({ device: { width: 430, height: 900 }, reducedMotion: true });
  try {
    for (const s of EVERY) {
      await go(p, s);
      assert.deepEqual(await p.page.evaluate(tooSmall, body(s)), [], s);
    }
    // the magnifier (phone search button), then the open palette: field, close button and every result row
    await go(p, 'accueil');
    const glass = await p.page.locator('#search-btn').boundingBox();
    assert.ok(glass.width >= 44 && glass.height >= 44, `search button ${glass.width}x${glass.height}`);
    await p.page.locator('#search-btn').click();
    await p.page.locator('#palette').waitFor();
    await p.page.locator('#pal-input').fill('a');
    await p.page.waitForFunction(() => document.querySelectorAll('#pal-list [role=option]').length > 3);
    assert.deepEqual(await p.page.evaluate(tooSmall, '#palette'), [], 'palette');
    const rows = await p.page.locator('#pal-list [role=option]').evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().height)));
    assert.ok(rows.every((h) => h >= 44), `result rows ${rows}`);
    await p.page.keyboard.press('Escape');
    // « Plus » sheet items
    await p.page.locator('#more-btn').click();
    await p.page.locator('#more-sheet').waitFor();
    assert.deepEqual(await p.page.evaluate(tooSmall, '#more-sheet'), [], 'sheet');
  } finally { await p.close(); }
});

// Carried from Task 8: the Outlook failure rows of « À faire » are links and must be 44px tall too.
for (const [label, mcp, count] of [
  ['one reason for both sections (error)', { mode: 'error', code: 'needs_reauth' }, 1],
  ['two different reasons', { mode: 'error', code: 'needs_reauth', byTool: { outlook_calendar_search: { code: 'approval_required' } } }, 2],
  ['calendar only, mail working', { byTool: { outlook_calendar_search: { mode: 'error', code: 'upstream_error' } } }, 1],
  ['connector absent (quiet rows)', { mode: 'null' }, 1],
]) {
  test(`touch targets: home Outlook failure rows are >= 44px tall at 430px — ${label}`, async () => {
    const p = await open({ device: { width: 430, height: 900 }, reducedMotion: true, mcp });
    try {
      await go(p, 'accueil');
      const notes = p.page.locator('#todo [data-outlook-note]');
      await p.page.waitForFunction((n) => document.querySelectorAll('#todo [data-outlook-note]').length === n, count);
      for (const a of await notes.locator('a').all()) {
        const b = await a.boundingBox();
        assert.ok(b.height >= 44, `failure row link ${Math.round(b.height)}px`);
      }
      assert.ok(await notes.locator('a').count() >= count);
      assert.deepEqual(await p.page.evaluate(tooSmall, body('accueil')), []);
      const r = await p.page.evaluate(overflowScan);
      assert.deepEqual(r.bad, []);
    } finally { await p.close(); }
  });
}

// ---- CV viewer in the detail sheet: the PNG pages (/_blob/<asset id>) shown in the page, never a PDF link ----
// The frame refuses same-origin links in a new tab, downloads, <object>/<embed> and window.open: only <img> works.
const PAGES = ['/_blob/0123456789abcdef0123456789abcd01', '/_blob/0123456789abcdef0123456789abcd02']; // fixture app 1
const NOTE = 'Le PDF n\'est pas téléchargeable depuis le tableau de bord : demandez-le à Claude dans la session.';
const MISSING = 'Page indisponible. Elle sera rétablie à la prochaine synchronisation.';
const STALE = 'Ce CV a été modifié depuis son envoi sur le tableau de bord.';

// A tiny white A4-shaped PNG (124x175), built here so no binary fixture lives in the repo.
function tinyPng(w = 124, h = 175) {
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td) >>> 0);
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3, 0xff)]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
const PNG = tinyPng();

// Serves /_blob/<id> as the platform would for an uploaded PNG; ids in `missing` answer 404.
async function openCv(opts = {}) {
  const { missing = [], ...rest } = opts;
  const p = await open(rest);
  p.blobs = [];
  await p.context.route(/\/_blob\//, (route) => {
    const path = new URL(route.request().url()).pathname;
    p.blobs.push(path);
    if (missing.includes(path)) return route.fulfill({ status: 404, body: 'not found' });
    return route.fulfill({ status: 200, contentType: 'image/png', body: PNG });
  });
  return p;
}
const withApp = (num, patch) => {
  const docs = structuredClone(DOCS);
  for (const [k, v] of Object.entries(docs)) if (k.startsWith('snapshot/apps-')) for (const a of v.items) if (a.num === num) Object.assign(a, patch);
  return docs;
};
async function openSheet(p, num) {
  await go(p, 'candidatures');
  await p.page.locator(`#app-list [data-num="${num}"] .row-open`).click();
  const dlg = p.page.locator('.dlg[role=dialog][aria-modal=true]');
  await dlg.waitFor();
  return dlg;
}
async function openViewer(p, num) {
  const dlg = await openSheet(p, num);
  await dlg.locator('button.cv-open').click();
  await dlg.locator('.cv-view').waitFor();
  return dlg;
}
const loaded = (p) => p.page.waitForFunction(() => { const i = document.querySelector('.cv-view img'); return i && i.complete && i.naturalWidth > 0; });
// Only the « Failed to load resource » line a 404 image logs is expected; anything else is a real error.
const realErrors = (p) => p.errors.filter((e) => !/Failed to load resource/.test(e));

test('CV viewer: « Voir le CV » only when pages exist; row marked « CV »; no PDF link, no new tab', async () => {
  const p = await openCv({ device: { width: 430, height: 900 }, reducedMotion: true });
  try {
    await go(p, 'candidatures');
    assert.equal(await p.page.locator('#app-list [data-num="1"] .cv-mark').count(), 1);
    assert.equal(await p.page.locator('#app-list .cv-mark').count(), 1); // app 8's hostile ids were dropped by export
    let dlg = await openSheet(p, 3);
    assert.equal(await dlg.locator('button.cv-open').count(), 0);
    await p.page.keyboard.press('Escape');
    dlg = await openSheet(p, 1);
    const btn = dlg.locator('button.cv-open');
    assert.equal(await btn.count(), 1);
    assert.equal((await btn.innerText()).trim(), 'Voir le CV');
    assert.match(await btn.getAttribute('class'), /\bbtn btn-soft\b/);
    assert.equal(await btn.locator('svg').count(), 1);
    assert.ok((await btn.boundingBox()).height >= 44);
    assert.equal(await p.page.locator('a[href*="_blob"], a.cv-link, a[download], object, embed').count(), 0);
    assert.equal(await dlg.locator('.cv-stale').count(), 0);
    assert.equal(await dlg.locator('img').count(), 0, 'no page image is fetched before the viewer opens');
    assert.deepEqual(p.blobs, []);
    assert.deepEqual(await p.page.evaluate(tooSmall, '.dlg'), []);
    assert.deepEqual(p.errors, []);
  } finally { await p.close(); }
});

test('CV viewer: opens in the sheet with one lazy image per page, exact /_blob/ src, note, focus on Retour', async () => {
  const p = await openCv({ device: { width: 430, height: 932 }, reducedMotion: true });
  try {
    const dlg = await openViewer(p, 1);
    const imgs = dlg.locator('.cv-view img');
    assert.equal(await imgs.count(), 2);
    for (let i = 0; i < 2; i++) {
      const img = imgs.nth(i);
      assert.equal(await img.getAttribute('src'), PAGES[i]);
      assert.equal(await img.getAttribute('alt'), `CV — page ${i + 1} sur 2`);
      assert.equal(await img.getAttribute('loading'), 'lazy');
      assert.equal(await img.getAttribute('decoding'), 'async');
    }
    assert.equal(await dlg.locator('.detail-main').isVisible(), false);
    assert.equal(await dlg.locator('#form-note').isVisible(), false);
    assert.equal((await dlg.locator('.cv-note').innerText()).trim(), NOTE);
    assert.equal(await dlg.locator('.cv-stale').isVisible(), false);
    assert.equal(await p.page.evaluate(() => document.activeElement?.classList.contains('cv-back')), true);
    assert.equal((await dlg.locator('.cv-back').innerText()).trim(), '← Retour');
    assert.match(await p.page.locator('.dlg-title').innerText(), /^CV/);
    await loaded(p);
    // full-height sheet on the phone; every image as wide as the viewer, inside the screen
    const panel = await dlg.locator('.dlg-panel').boundingBox();
    assert.ok(panel.height >= 932 - 2 && panel.y <= 1, `panel ${JSON.stringify(panel)}`);
    const first = await imgs.nth(0).boundingBox();
    const box = await dlg.locator('.cv-pages').boundingBox();
    assert.ok(first.x >= 0 && first.x + first.width <= 430, `img ${JSON.stringify(first)}`);
    assert.ok(Math.abs(first.width - box.width) <= 1, `img ${first.width} vs viewer ${box.width}`);
    assert.ok(first.width >= 380, `img only ${first.width}px wide`);
    assert.ok(first.height > first.width * 1.3, 'A4 portrait aspect');
    assert.equal(await imgs.nth(0).evaluate((i) => getComputedStyle(i).backgroundColor), 'rgb(255, 255, 255)');
    assert.notEqual(await imgs.nth(0).evaluate((i) => getComputedStyle(i).boxShadow), 'none');
    const r = await p.page.evaluate(overflowScan);
    assert.ok(r.sw <= r.W, `scrollWidth ${r.sw} > ${r.W}`);
    assert.deepEqual(r.bad, []);
    assert.deepEqual(await p.page.evaluate(tooSmall, '.dlg'), []);
    assert.equal(await p.page.evaluate(() => document.getAnimations().length), 0, 'no animation under reduced motion');
    assert.ok(p.blobs.every((b) => PAGES.includes(b)));
    await p.page.screenshot({ path: join(SHOTS, 'cv-viewer-430.png') });
    assert.deepEqual(p.errors, []);
  } finally { await p.close(); }
});

test('CV viewer: Retour restores the detail (focus on « Voir le CV »), Escape goes back then closes, × closes', async () => {
  const p = await openCv({ device: { width: 1440, height: 900 }, reducedMotion: true });
  try {
    let dlg = await openViewer(p, 1);
    await dlg.locator('#detail-note').evaluate((t) => { t.value = 'brouillon'; }); // hidden but kept
    await dlg.locator('.cv-back').click();
    assert.equal(await dlg.locator('.cv-view').isVisible(), false);
    assert.equal(await dlg.locator('.detail-main').isVisible(), true);
    assert.equal(await dlg.locator('#detail-note').inputValue(), 'brouillon');
    assert.equal(await p.page.evaluate(() => document.activeElement?.classList.contains('cv-open')), true);
    assert.equal((await p.page.locator('.dlg-title').innerText()).trim(), 'Acme');
    // Escape in the viewer: back to the detail, the sheet stays open; Escape again closes it
    await dlg.locator('button.cv-open').click();
    await dlg.locator('.cv-view').waitFor();
    await p.page.keyboard.press('Escape');
    assert.equal(await p.page.locator('.dlg').count(), 1);
    assert.equal(await dlg.locator('.detail-main').isVisible(), true);
    assert.equal(await p.page.evaluate(() => document.activeElement?.classList.contains('cv-open')), true);
    await p.page.keyboard.press('Escape');
    assert.equal(await p.page.locator('.dlg').count(), 0);
    // × from the viewer closes the whole sheet; focus goes back to the row
    dlg = await openViewer(p, 1);
    await dlg.locator('.dlg-head [data-dlg-close]').click();
    assert.equal(await p.page.locator('.dlg').count(), 0);
    assert.equal(await p.page.evaluate(() => document.activeElement?.closest('[data-num]')?.dataset.num), '1');
    // reopening starts on the detail, not the viewer
    dlg = await openSheet(p, 1);
    assert.equal(await dlg.locator('.detail-main').isVisible(), true);
    assert.equal(await dlg.locator('.cv-view').count(), 0);
    // Tab stays inside the sheet while the viewer is open
    await dlg.locator('button.cv-open').click();
    for (let i = 0; i < 6; i++) {
      await p.page.keyboard.press('Tab');
      assert.equal(await p.page.evaluate(() => !!document.activeElement?.closest('.dlg') && !document.activeElement.closest('.detail-main')), true);
    }
    // PC: a wider panel than the detail sheet, images fit it
    await loaded(p);
    const img = await dlg.locator('.cv-view img').first().boundingBox();
    assert.ok(img.width >= 700 && img.x >= 0 && img.x + img.width <= 1440, `img ${JSON.stringify(img)}`);
    await p.page.screenshot({ path: join(SHOTS, 'cv-viewer-1440.png') });
    assert.deepEqual(p.errors, []);
  } finally { await p.close(); }
});

test('CV viewer: hostile or malformed cv_pages are never rendered as an image source', async () => {
  const bads = ['javascript:alert(1)', 'https://evil.example/x.png', '/_blob/../x', '/_blob/short', `${PAGES[0]}?x=1`, ` ${PAGES[0]}`,
    `//evil.example${PAGES[0]}`, `${PAGES[0]}/`, `${PAGES[0]}"onerror="alert(1)`, `/_blob/${'a'.repeat(129)}`, 'data:image/png;base64,AAAA', 42, null, { src: PAGES[0] }];
  for (const pages of [bads, PAGES[0], { 0: PAGES[0] }, null]) {
    const p = await openCv({ docs: withApp(1, { cv_pages: pages, cv_stale: true }) });
    try {
      await go(p, 'candidatures');
      assert.equal(await p.page.locator('.cv-mark').count(), 0, JSON.stringify(pages));
      const dlg = await openSheet(p, 1);
      assert.equal(await dlg.locator('button.cv-open').count(), 0, JSON.stringify(pages));
      assert.equal(await dlg.locator('.cv-stale').count(), 0);
      assert.equal(await p.page.locator('img, a[href*="_blob"], a[href^="javascript"], [src*="evil"]').count(), 0);
      assert.deepEqual(p.dialogs, []);
      assert.deepEqual(p.errors, []);
    } finally { await p.close(); }
  }
  // mixed: only the valid entry is shown, and the count follows it; at most 6 pages
  const many = Array.from({ length: 8 }, (_, i) => `/_blob/0123456789abcdef0123456789abcd${String(i).padStart(2, '0')}`);
  for (const [pages, want] of [[[...bads, PAGES[1]], [PAGES[1]]], [many, many.slice(0, 6)]]) {
    const p = await openCv({ docs: withApp(1, { cv_pages: pages }) });
    try {
      const dlg = await openViewer(p, 1);
      const srcs = await dlg.locator('.cv-view img').evaluateAll((l) => l.map((i) => i.getAttribute('src')));
      assert.deepEqual(srcs, want);
      assert.equal(await dlg.locator('.cv-view img').last().getAttribute('alt'), `CV — page ${want.length} sur ${want.length}`);
      assert.equal(await p.page.locator('img').count(), want.length);
      assert.deepEqual(p.dialogs, []);
      assert.deepEqual(p.errors, []);
    } finally { await p.close(); }
  }
});

test('CV viewer: a stale CV shows the note in the detail and the viewer; no overflow at 360px', async () => {
  const p = await openCv({ device: { width: 360, height: 800 }, reducedMotion: true, docs: withApp(1, { cv_stale: true }) });
  try {
    const dlg = await openSheet(p, 1);
    assert.equal((await dlg.locator('.detail-main .cv-stale').innerText()).trim(), STALE);
    await dlg.locator('button.cv-open').click();
    assert.equal((await dlg.locator('.cv-view .cv-stale').innerText()).trim(), STALE);
    await loaded(p);
    const img = await dlg.locator('.cv-view img').first().boundingBox();
    assert.ok(img.x >= 0 && img.x + img.width <= 360, `img ${JSON.stringify(img)}`);
    const r = await p.page.evaluate(overflowScan);
    assert.ok(r.sw <= r.W, `scrollWidth ${r.sw} > ${r.W}`);
    assert.deepEqual(r.bad, []);
    assert.equal(await dlg.locator('.dlg-panel').evaluate((e) => e.scrollWidth <= e.clientWidth), true);
    await p.page.screenshot({ path: join(SHOTS, 'cv-viewer-360.png') });
    assert.deepEqual(p.errors, []);
  } finally { await p.close(); }
});

test('CV viewer: a page that fails to load is replaced by a French message, no broken image', async () => {
  const p = await openCv({ device: { width: 430, height: 932 }, reducedMotion: true, missing: [PAGES[1]] });
  try {
    const dlg = await openViewer(p, 1);
    await dlg.locator('.cv-page').nth(1).scrollIntoViewIfNeeded();
    await p.page.waitForFunction(() => document.querySelectorAll('.cv-view .cv-missing').length === 1);
    assert.equal((await dlg.locator('.cv-missing').innerText()).trim(), MISSING);
    assert.deepEqual(await dlg.locator('.cv-view img').evaluateAll((l) => l.map((i) => i.getAttribute('src'))), [PAGES[0]]);
    assert.equal(await dlg.locator('.cv-page').count(), 2, 'the page keeps its place in the stack');
    assert.ok(p.blobs.includes(PAGES[1]));
    assert.deepEqual(realErrors(p), []);
  } finally { await p.close(); }
});
