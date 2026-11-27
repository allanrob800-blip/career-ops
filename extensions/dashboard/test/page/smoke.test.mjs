import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, launchBrowser, openPage } from './harness.mjs';

let server, browser;
before(async () => { server = await startServer(); browser = await launchBrowser(); });
after(async () => { await browser?.close(); await server?.close(); });

const SCREENS = ['accueil', 'offres', 'candidatures', 'planning', 'messages', 'analytique', 'reglages'];

for (const [label, device] of [['iphone', 'iPhone 15 Pro Max'], ['desktop', { width: 1440, height: 900 }], ['narrow', { width: 360, height: 740 }], ['tablet', { width: 720, height: 900 }]]) {
  test(`smoke ${label}: title, nav visible, no horizontal scroll, no errors`, async () => {
    const p = await openPage(browser, { url: server.url, device });
    try {
      assert.equal(await p.page.title(), 'Cap');
      if (label === 'iphone' || label === 'desktop') assert.ok(await p.page.locator('#nav').isVisible());
      const { sw, cw } = await p.page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
      assert.ok(sw <= cw, `scrollWidth ${sw} > clientWidth ${cw}`);
      assert.deepEqual(p.errors, []);
    } finally { await p.close(); }
  });
}

test('routing: hash selects screen, unknown falls back to accueil, aria-current set', async () => {
  const p = await openPage(browser, { url: server.url, device: { width: 1440, height: 900 } });
  try {
    for (const name of SCREENS) {
      await p.page.evaluate((n) => { location.hash = n; }, name);
      await p.page.waitForFunction((n) => !document.getElementById(`screen-${n}`).hidden, name);
      const visible = await p.page.evaluate(() => [...document.querySelectorAll('[data-screen]')].filter((e) => !e.hidden).map((e) => e.dataset.screen));
      assert.deepEqual(visible, [name]);
      assert.equal(await p.page.locator('#nav [aria-current="page"]').getAttribute('href'), `#${name}`);
    }
    await p.page.evaluate(() => { location.hash = 'nimportequoi'; });
    await p.page.waitForFunction(() => !document.getElementById('screen-accueil').hidden);
    assert.deepEqual(p.errors, []);
  } finally { await p.close(); }
});

test('mobile: tab bar shows 5 items, Plus opens sheet with 3 more', async () => {
  const p = await openPage(browser, { url: server.url, device: 'iPhone 15 Pro Max' });
  try {
    const labels = await p.page.locator('#nav a:visible, #nav button:visible').allInnerTexts();
    assert.deepEqual(labels.map((s) => s.trim()), ['Accueil', 'Offres', 'Candidatures', 'Messages', 'Plus']);
    await p.page.locator('#nav button', { hasText: 'Plus' }).click();
    const sheet = p.page.locator('#more-sheet');
    assert.ok(await sheet.isVisible());
    assert.deepEqual((await sheet.locator('a').allInnerTexts()).map((s) => s.trim()), ['Planning', 'Analytique', 'Réglages']);
    await sheet.locator('a', { hasText: 'Planning' }).click();
    await p.page.waitForFunction(() => location.hash === '#planning');
    assert.ok(!(await sheet.isVisible()));
    for (const b of await p.page.locator('#nav a:visible, #nav button:visible').all()) {
      const box = await b.boundingBox();
      assert.ok(box.height >= 44 && box.width >= 44, 'touch target >= 44px');
    }
    assert.deepEqual(p.errors, []);
  } finally { await p.close(); }
});

test('themes and reduced motion load without errors; dark theme darkens background', async () => {
  const bg = {};
  for (const theme of ['light', 'dark']) {
    const p = await openPage(browser, { url: server.url, device: { width: 1440, height: 900 }, theme, reducedMotion: true });
    try {
      bg[theme] = await p.page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      assert.deepEqual(p.errors, []);
    } finally { await p.close(); }
  }
  assert.notEqual(bg.light, bg.dark);
});

test('fake claude: use() resolves namespaces, null for mcp null mode and unknown', async () => {
  const p = await openPage(browser, { url: server.url, fake: { db: { docs: { 'snapshot/meta': { v: 1 } } }, mcp: { mode: 'null' } } });
  try {
    const r = await p.page.evaluate(async () => {
      const db = await window.claude.use('db');
      const metaSnap = await db.doc('snapshot/meta').get();
      const meta = { exists: metaSnap.exists, data: metaSnap.data() };
      const events = [];
      const unsub = db.doc('snapshot/meta').onSnapshot((s) => events.push(s.data().v));
      await new Promise((r) => setTimeout(r, 20));
      await db.doc('snapshot/meta').update({ v: 2 });
      unsub();
      return { meta, events, mcp: await window.claude.use('mcp'), nope: await window.claude.use('zzz'), uid: await (await window.claude.use('user')).id(), calls: window.__calls.length };
    });
    assert.equal(r.meta.exists, true);
    assert.deepEqual(r.meta.data, { v: 1 });
    assert.deepEqual(r.events, [1, 2]);
    assert.equal(r.mcp, null);
    assert.equal(r.nope, null);
    assert.equal(r.uid, 'u1');
    assert.ok(r.calls > 0);
  } finally { await p.close(); }
});
