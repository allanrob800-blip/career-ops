// Task 9: ⌘K palette, Réglages, accent themes, opening animation, « Plus » sheet focus trap.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, launchBrowser, openPage } from './harness.mjs';
import { fixtureDocs, EMAILS, EVENTS, NOW } from './fixtures.mjs';

let server, browser, DOCS;
before(async () => { DOCS = fixtureDocs(); server = await startServer(); browser = await launchBrowser(); });
after(async () => { await browser?.close(); await server?.close(); });

// Records every CSS animation that starts, with its end time (delay + duration).
const recordAnimations = () => {
  window.__anims = [];
  document.addEventListener('animationstart', (e) => {
    const a = e.target.getAnimations().find((x) => x.animationName === e.animationName);
    window.__anims.push({ name: e.animationName, on: e.target.id || e.target.tagName.toLowerCase(), end: a ? a.effect.getComputedTiming().endTime : null });
  }, true);
};

async function open(opts = {}) {
  const { docs = DOCS, reducedMotion = true, ...rest } = opts;
  const fake = { db: { docs: structuredClone(docs) }, mcp: { mode: 'ok', emails: EMAILS, events: EVENTS } };
  const p = await openPage(browser, { url: server.url, now: NOW, fake, reducedMotion, init: recordAnimations, ...rest });
  p.page.setDefaultTimeout(5000);
  p.dialogs = [];
  p.page.on('dialog', (d) => { p.dialogs.push(d.message()); d.dismiss().catch(() => {}); });
  return p;
}
const body = (name) => `#screen-${name} .screen-body`;
async function go(p, name, view = name) {
  await p.page.evaluate((n) => { location.hash = n; }, name);
  await p.page.waitForFunction(([sel, v]) => document.querySelector(sel)?.dataset.view === v, [body(name), view]);
  await p.page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}
const palette = (p) => p.page.locator('#palette');
const options = (p) => p.page.locator('#pal-list [role=option]');
const optionTexts = (p) => options(p).evaluateAll((els) => els.map((e) => e.textContent.replace(/\s+/g, ' ').trim()));
const activeId = (p) => p.page.evaluate(() => document.activeElement && document.activeElement.id);
const prefsDoc = (p) => p.page.evaluate(() => window.__fake.db.docs['settings/prefs']);
const acc = (p) => p.page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--acc').trim());

test('Control+K then « acme »: first result is Acme; Enter opens its sheet in Candidatures', async () => {
  const p = await open();
  try {
    await go(p, 'accueil');
    assert.equal(await palette(p).isVisible(), false);
    await p.page.keyboard.press('Control+K');
    await palette(p).waitFor();
    assert.equal(await palette(p).getAttribute('role'), 'dialog');
    assert.equal(await palette(p).getAttribute('aria-modal'), 'true');
    assert.equal(await activeId(p), 'pal-input');
    const input = p.page.locator('#pal-input');
    assert.equal(await input.getAttribute('role'), 'combobox');
    assert.equal(await input.getAttribute('aria-controls'), 'pal-list');
    assert.equal(await p.page.locator('#pal-list').getAttribute('role'), 'listbox');
    await p.page.keyboard.type('acme');
    await p.page.waitForFunction(() => /Acme/.test(document.querySelector('#pal-list [role=option]')?.textContent || ''));
    const first = options(p).first();
    assert.match(await first.innerText(), /^Acme/);
    assert.equal(await first.getAttribute('aria-selected'), 'true');
    assert.equal(await input.getAttribute('aria-activedescendant'), await first.getAttribute('id'));
    await p.page.keyboard.press('Enter');
    await p.page.waitForFunction(() => location.hash === '#candidatures');
    const dlg = p.page.locator('#app-detail[role=dialog]');
    await dlg.waitFor();
    assert.match(await dlg.locator('.dlg-title').innerText(), /^Acme$/);
    assert.match(await dlg.innerText(), /Product Manager/);
    assert.equal(await palette(p).isVisible(), false);
    assert.deepEqual(p.errors, []);
  } finally { await p.close(); }
});

test('Meta+K opens too and toggles; the shortcut prevents the browser default', async () => {
  const p = await open();
  try {
    await go(p, 'accueil');
    await p.page.evaluate(() => { window.addEventListener('keydown', (e) => { if (e.key.toLowerCase() === 'k' && window.__kPrevented === undefined) setTimeout(() => { window.__kPrevented = e.defaultPrevented; }); }); });
    await p.page.keyboard.press('Meta+K');
    await p.page.waitForFunction(() => window.__kPrevented !== undefined);
    assert.equal(await p.page.evaluate(() => window.__kPrevented), true);
    await palette(p).waitFor();
    await p.page.keyboard.press('Meta+K');
    await palette(p).waitFor({ state: 'hidden' });
    // a bare « k » never opens it
    await p.page.keyboard.press('k');
    await p.page.waitForTimeout(50);
    assert.equal(await palette(p).isVisible(), false);
  } finally { await p.close(); }
});

test('Escape closes the palette and gives the focus back (desktop search button, phone magnifier)', async () => {
  const d = await open();
  try {
    await go(d, 'accueil');
    const btn = d.page.locator('#nav-search');
    assert.ok(await btn.isVisible());
    await btn.focus();
    await d.page.keyboard.press('Control+K');
    await palette(d).waitFor();
    await d.page.keyboard.type('zzz');
    await d.page.keyboard.press('Escape');
    await palette(d).waitFor({ state: 'hidden' });
    assert.equal(await activeId(d), 'nav-search');
    // reopening starts from an empty query
    await btn.click();
    await palette(d).waitFor();
    assert.equal(await d.page.locator('#pal-input').inputValue(), '');
    await d.page.locator('#palette button[data-pal-close]').click();
    await palette(d).waitFor({ state: 'hidden' });
    assert.equal(await activeId(d), 'nav-search');
    assert.deepEqual(d.errors, []);
  } finally { await d.close(); }
  const m = await open({ device: 'iPhone 15 Pro Max' });
  try {
    await go(m, 'accueil');
    const glass = m.page.locator('#search-btn');
    assert.ok(await glass.isVisible());
    assert.equal(await m.page.locator('#nav-search').isVisible(), false);
    assert.match(await glass.getAttribute('aria-label'), /Rechercher/);
    await glass.click();
    await palette(m).waitFor();
    assert.equal(await activeId(m), 'pal-input');
    const vh = m.page.viewportSize().height;
    await m.page.locator('#palette .pal-scrim').click({ position: { x: 20, y: vh - 30 } }); // below the panel
    await palette(m).waitFor({ state: 'hidden' });
    assert.equal(await activeId(m), 'search-btn');
    assert.deepEqual(m.errors, []);
  } finally { await m.close(); }
});

test('search ignores accents and case, covers companies, roles, offers and the seven screens', async () => {
  const p = await open();
  try {
    await go(p, 'accueil');
    await p.page.keyboard.press('Control+K');
    await palette(p).waitFor();
    // no query: the seven screens
    assert.deepEqual((await optionTexts(p)).map((t) => t.replace(/ Page$/, '')), ['Accueil', 'Offres', 'Candidatures', 'Planning', 'Messages', 'Analytique', 'Réglages']);
    const input = p.page.locator('#pal-input');
    await input.fill('REGLAGES');
    assert.match((await optionTexts(p))[0], /^Réglages/);
    await input.fill('ECHO sys');
    assert.match((await optionTexts(p))[0], /^Echo Systems/);
    await input.fill('data lead'); // a role
    assert.match((await optionTexts(p))[0], /^Borealis.*Data Lead/);
    await input.fill('societe'); // an offer, stored as « Société »
    const offer = (await optionTexts(p))[0];
    assert.match(offer, /^Société/);
    assert.match(offer, /Offre/);
    await input.fill('qwertyuiop');
    assert.equal(await options(p).count(), 0);
    assert.match(await p.page.locator('#pal-status').innerText(), /Aucun résultat/);
    assert.equal(await input.getAttribute('aria-activedescendant'), null);
    // Enter with no result does nothing
    await p.page.keyboard.press('Enter');
    assert.ok(await palette(p).isVisible());
    // an offer opens the Offres screen filtered on it
    await input.fill('evil');
    assert.match((await optionTexts(p))[0], /^Evil Corp/);
    await p.page.keyboard.press('Enter');
    await p.page.waitForFunction(() => location.hash === '#offres');
    await p.page.waitForFunction(() => document.querySelector('#offer-filter')?.value === 'Evil Corp');
    assert.equal(await p.page.locator('.offer:visible').count(), 1);
    // a screen name navigates
    await p.page.keyboard.press('Control+K');
    await palette(p).waitFor();
    await p.page.locator('#pal-input').fill('analy');
    await p.page.keyboard.press('Enter');
    await p.page.waitForFunction(() => location.hash === '#analytique');
    assert.equal(await palette(p).isVisible(), false);
    assert.deepEqual(p.errors, []);
  } finally { await p.close(); }
});

test('keyboard: arrows move the active option and wrap, Tab stays inside, click opens, no network while searching', async () => {
  const p = await open();
  try {
    await go(p, 'accueil');
    await p.page.waitForFunction(() => document.querySelector('[data-count=messages]')); // Outlook delivered
    const requests = [];
    p.page.on('request', (r) => requests.push(r.url()));
    const calls = await p.page.evaluate(() => window.__calls.length);
    await p.page.keyboard.press('Control+K');
    await palette(p).waitFor();
    const input = p.page.locator('#pal-input');
    const active = () => input.getAttribute('aria-activedescendant');
    const selected = () => p.page.locator('#pal-list [role=option][aria-selected=true]').evaluateAll((els) => els.map((e) => e.id));
    assert.equal(await active(), 'pal-opt-0');
    await p.page.keyboard.press('ArrowDown');
    assert.equal(await active(), 'pal-opt-1');
    assert.deepEqual(await selected(), ['pal-opt-1']);
    await p.page.keyboard.press('ArrowUp');
    await p.page.keyboard.press('ArrowUp'); // wraps to the last
    assert.equal(await active(), 'pal-opt-6');
    await p.page.keyboard.press('ArrowDown'); // wraps to the first
    assert.equal(await active(), 'pal-opt-0');
    assert.equal(await activeId(p), 'pal-input'); // focus never leaves the field while navigating
    for (let i = 0; i < 5; i++) {
      await p.page.keyboard.press('Tab');
      assert.ok(await p.page.evaluate(() => document.getElementById('palette').contains(document.activeElement)), `Tab ${i} left the palette`);
    }
    for (let i = 0; i < 3; i++) {
      await p.page.keyboard.press('Shift+Tab');
      assert.ok(await p.page.evaluate(() => document.getElementById('palette').contains(document.activeElement)), `Shift+Tab ${i} left the palette`);
    }
    await input.fill('fox');
    await input.fill('foxtrot head');
    await options(p).first().click();
    await p.page.waitForFunction(() => location.hash === '#candidatures');
    assert.match(await p.page.locator('#app-detail .dlg-title').innerText(), /^Foxtrot$/);
    assert.deepEqual(requests, []);
    assert.equal(await p.page.evaluate(() => window.__calls.length), calls, 'no db / mcp call while searching');
    assert.deepEqual(p.errors, []);
  } finally { await p.close(); }
});

test('hostile names stay text in the results: no element, no dialog', async () => {
  const p = await open();
  try {
    await go(p, 'accueil');
    await p.page.keyboard.press('Control+K');
    await palette(p).waitFor();
    await p.page.locator('#pal-input').fill('img src');
    assert.match((await optionTexts(p))[0], /<img src=x onerror=alert\(1\)>/);
    assert.equal(await p.page.locator('#palette img').count(), 0);
    await p.page.locator('#pal-input').fill('<script>alert(1)</script>');
    assert.match(await p.page.locator('#pal-status').innerText(), /<script>alert\(1\)<\/script>/);
    assert.equal(await p.page.locator('#palette script').count(), 0);
    await p.page.waitForTimeout(100);
    assert.deepEqual(p.dialogs, []);
    assert.deepEqual(p.errors, []);
  } finally { await p.close(); }
});

test('typing in a dialog field never opens the palette; the shortcut does, and Escape returns to the field', async () => {
  const p = await open();
  try {
    await go(p, 'candidatures');
    await p.page.locator('#app-list [data-num="3"] .row-open').click();
    const note = p.page.locator('#detail-note');
    await note.click();
    await p.page.keyboard.type('ok k K /');
    assert.equal(await palette(p).isVisible(), false);
    assert.equal(await note.inputValue(), 'ok k K /');
    await p.page.keyboard.press('Control+K');
    await palette(p).waitFor();
    assert.equal(await activeId(p), 'pal-input');
    await p.page.keyboard.press('Escape'); // closes the palette only
    await palette(p).waitFor({ state: 'hidden' });
    assert.ok(await p.page.locator('#app-detail').isVisible());
    assert.equal(await activeId(p), 'detail-note');
    assert.equal(await note.inputValue(), 'ok k K /');
    await p.page.keyboard.press('Escape'); // then the dialog
    assert.equal(await p.page.locator('#app-detail').count(), 0);
    assert.deepEqual(p.errors, []);
  } finally { await p.close(); }
});

test('Réglages: choosing « Bleu » changes --acc everywhere and writes settings/prefs', async () => {
  const p = await open();
  try {
    await go(p, 'reglages');
    assert.equal(await acc(p), 'rgb(255, 90, 78)'); // corail by default
    const radios = p.page.locator(`${body('reglages')} input[name=accent]`);
    assert.deepEqual(await radios.evaluateAll((els) => els.map((e) => e.value)), ['corail', 'vert-eau', 'violet', 'bleu', 'ambre']);
    assert.equal(await p.page.locator('input[name=accent]:checked').getAttribute('value'), 'corail');
    await p.page.locator('input[name=accent][value=bleu]').check();
    await p.page.waitForFunction(() => getComputedStyle(document.documentElement).getPropertyValue('--acc').trim() === 'rgb(47, 107, 255)');
    assert.equal(await p.page.evaluate(() => document.documentElement.dataset.accent), 'bleu');
    await p.page.waitForFunction(() => window.__fake.db.docs['settings/prefs']?.accent === 'bleu');
    assert.deepEqual(await prefsDoc(p), { weekly_goal: 3, accent: 'bleu', reduced_motion: false });
    assert.equal(await p.page.locator('input[name=accent]:checked').getAttribute('value'), 'bleu');
    // the accent reaches other screens
    await go(p, 'accueil');
    assert.equal(await p.page.evaluate(() => getComputedStyle(document.querySelector('.week-big')).getPropertyValue('--acc').trim()), 'rgb(47, 107, 255)');
    assert.deepEqual(p.errors, []);
  } finally { await p.close(); }
});

test('Réglages: weekly goal 1 to 10, reduced motion switch, sync date and the « prochaine session » line', async () => {
  const p = await open({ reducedMotion: false });
  try {
    await go(p, 'reglages');
    const value = () => p.page.locator('#goal-value').innerText().then((s) => s.trim());
    assert.equal(await value(), '3');
    await p.page.locator('#goal-plus').click();
    assert.equal(await value(), '4');
    await p.page.waitForFunction(() => window.__fake.db.docs['settings/prefs']?.weekly_goal === 4);
    for (let i = 0; i < 8; i++) if (await p.page.locator('#goal-plus').isEnabled()) await p.page.locator('#goal-plus').click();
    assert.equal(await value(), '10');
    assert.equal(await p.page.locator('#goal-plus').isDisabled(), true);
    for (let i = 0; i < 12; i++) if (await p.page.locator('#goal-minus').isEnabled()) await p.page.locator('#goal-minus').click();
    assert.equal(await value(), '1');
    assert.equal(await p.page.locator('#goal-minus').isDisabled(), true);
    await p.page.waitForFunction(() => window.__fake.db.docs['settings/prefs']?.weekly_goal === 1);
    // the home ring follows
    await go(p, 'accueil');
    await p.page.waitForFunction(() => /sur 1$/.test(document.getElementById('goal-count')?.textContent.replace(/\s+/g, ' ').trim() || ''));
    await go(p, 'reglages');
    const sw = p.page.locator('#motion-switch');
    assert.equal(await sw.getAttribute('role'), 'switch');
    assert.equal(await sw.getAttribute('aria-checked'), 'false');
    await sw.click();
    await p.page.waitForFunction(() => document.documentElement.dataset.motion === 'reduce');
    assert.equal(await sw.getAttribute('aria-checked'), 'true');
    await p.page.waitForFunction(() => window.__fake.db.docs['settings/prefs']?.reduced_motion === true);
    assert.deepEqual(await prefsDoc(p), { weekly_goal: 1, accent: 'corail', reduced_motion: true });
    await p.page.waitForTimeout(100);
    assert.equal(await p.page.evaluate(() => document.getAnimations().length), 0);
    const text = await p.page.locator(body('reglages')).innerText();
    assert.match(text, /Dernière synchronisation/);
    assert.match(await p.page.locator('#sync-date').innerText(), /27 nov\. à \d{2}:\d{2}/);
    assert.match(await p.page.locator('#apply-note').innerText(), /Claude.*prochaine session/);
    assert.deepEqual(p.errors, []);
  } finally { await p.close(); }
});

test('Réglages works on an empty database and says no sync happened yet', async () => {
  const p = await open({ docs: {} });
  try {
    await go(p, 'reglages');
    assert.match(await p.page.locator('#sync-date').innerText(), /Pas encore de synchronisation/);
    await p.page.locator('input[name=accent][value=violet]').check();
    await p.page.waitForFunction(() => window.__fake.db.docs['settings/prefs']?.accent === 'violet');
    assert.deepEqual(await prefsDoc(p), { weekly_goal: 3, accent: 'violet', reduced_motion: false });
    assert.deepEqual(p.errors, []);
  } finally { await p.close(); }
});

test('a failed preference write puts the previous value back and says so', async () => {
  const p = await open();
  try {
    await go(p, 'reglages');
    await p.page.evaluate(() => { CapData.savePrefs = () => Promise.reject(new Error('refus')); });
    await p.page.locator('input[name=accent][value=ambre]').click(); // not check(): the radio goes back at once
    await p.page.locator('.toast-error').waitFor();
    assert.match(await p.page.locator('.toast-error').innerText(), /n'a pas pu être enregistré/);
    assert.equal(await p.page.locator('input[name=accent]:checked').getAttribute('value'), 'corail');
    assert.notEqual(await p.page.evaluate(() => document.documentElement.dataset.accent), 'ambre');
    assert.equal(await prefsDoc(p), undefined);
  } finally { await p.close(); }
});

for (const stored of ['ocean', '"><img src=x onerror=alert(1)>', 'bleu violet']) {
  test(`stored accent ${JSON.stringify(stored)} falls back to corail and never reaches the markup`, async () => {
    const docs = { ...DOCS, 'settings/prefs': { weekly_goal: 3, accent: stored, reduced_motion: false } };
    const p = await open({ docs });
    try {
      await go(p, 'reglages');
      await p.page.waitForFunction(() => window.CapApp.state()?.prefs.accent != null && window.CapApp.state().status === 'ok');
      assert.equal(await acc(p), 'rgb(255, 90, 78)');
      const a = await p.page.evaluate(() => document.documentElement.dataset.accent);
      assert.ok(a === undefined || a === 'corail', `data-accent=${a}`);
      assert.equal(await p.page.locator('input[name=accent]:checked').getAttribute('value'), 'corail');
      const leak = await p.page.evaluate((v) => [...document.querySelectorAll('*')].filter((el) => [...el.attributes].some((at) => at.value.includes(v))).length, stored);
      assert.equal(leak, 0, 'stored value found in an attribute');
      assert.equal(await p.page.locator('img[src=x]').count(), 0);
      await go(p, 'accueil');
      await p.page.waitForTimeout(50);
      assert.deepEqual(p.dialogs, []);
      assert.deepEqual(p.errors, []);
    } finally { await p.close(); }
  });
}

test('prefers-reduced-motion: nothing animates (no animation 100 ms after load), no opening reveal', async () => {
  const p = await open({ reducedMotion: true });
  try {
    await p.page.waitForTimeout(100);
    assert.equal(await p.page.evaluate(() => document.getAnimations().length), 0);
    await go(p, 'accueil');
    await p.page.keyboard.press('Control+K');
    await palette(p).waitFor();
    await p.page.waitForTimeout(100);
    assert.equal(await p.page.evaluate(() => document.getAnimations().length), 0);
    assert.deepEqual(await p.page.evaluate(() => window.__anims), []);
    assert.equal(await p.page.evaluate(() => document.documentElement.classList.contains('cap-boot')), false);
    assert.equal(await p.page.evaluate(() => getComputedStyle(document.getElementById('stage')).clipPath), 'none');
  } finally { await p.close(); }
});

test('opening: one circular clip-path reveal with a blur lift, under 900 ms, once per load, nothing left running', async () => {
  const p = await open({ reducedMotion: false, docs: {} });
  try {
    await p.page.waitForFunction(() => window.__anims.some((a) => a.name === 'cap-reveal'));
    const during = await p.page.evaluate(() => {
      const by = (name) => document.getAnimations().find((a) => a.animationName === name);
      const frames = (name) => (by(name) ? by(name).effect.getKeyframes() : []);
      const reveal = by('cap-reveal'), lift = by('cap-unblur');
      return {
        revealOn: reveal?.effect.target.id, liftOn: lift?.effect.target.id,
        clip: frames('cap-reveal').map((k) => k.clipPath), blur: frames('cap-unblur').map((k) => k.filter),
        glass: [reveal, lift].filter(Boolean).map((a) => getComputedStyle(a.effect.target).backdropFilter),
      };
    });
    assert.equal(during.revealOn, 'stage');
    assert.equal(during.liftOn, 'main');
    assert.match(during.clip[0], /^circle\(0/);
    assert.match(during.clip.at(-1), /^circle\(/);
    assert.match(during.blur[0], /^blur\(/);
    assert.deepEqual(during.glass, ['none', 'none'], 'the animated wrappers carry no backdrop-filter');
    await p.page.waitForFunction(() => !document.documentElement.classList.contains('cap-open'));
    const opening = (await p.page.evaluate(() => window.__anims)).filter((a) => /^cap-(reveal|unblur)$/.test(a.name));
    assert.deepEqual(opening.map((a) => a.name).sort(), ['cap-reveal', 'cap-unblur']);
    for (const a of opening) assert.ok(a.end > 0 && a.end < 900, `${a.name} ends at ${a.end} ms`);
    assert.equal(await p.page.evaluate(() => document.getAnimations().length), 0);
    assert.equal(await p.page.evaluate(() => getComputedStyle(document.getElementById('stage')).clipPath), 'none');
    assert.equal(await p.page.evaluate(() => getComputedStyle(document.getElementById('main')).filter), 'none');
    // not replayed by navigation or by a preference change
    await go(p, 'reglages');
    await p.page.locator('input[name=accent][value=bleu]').check();
    await go(p, 'offres', 'gate-empty');
    await p.page.waitForTimeout(150);
    assert.equal((await p.page.evaluate(() => window.__anims)).filter((a) => a.name === 'cap-reveal').length, 1);
    assert.deepEqual(p.errors, []);
  } finally { await p.close(); }
});

test('opening with data: the home screen ends with no animation left running', async () => {
  const p = await open({ reducedMotion: false });
  try {
    await go(p, 'accueil');
    await p.page.waitForFunction(() => window.__anims.some((a) => a.name === 'cap-reveal'));
    await p.page.waitForFunction(() => !document.documentElement.classList.contains('cap-open') && !document.querySelector('.is-entering'));
    await p.page.waitForFunction(() => document.getAnimations().length === 0);
    assert.ok(await p.page.locator('#goal-count').isVisible());
  } finally { await p.close(); }
});

test('stored « réduire les animations »: the opening reveal never starts and the page is shown', async () => {
  const docs = { ...DOCS, 'settings/prefs': { weekly_goal: 3, accent: 'corail', reduced_motion: true } };
  const p = await open({ reducedMotion: false, docs });
  try {
    await go(p, 'accueil');
    await p.page.waitForFunction(() => document.documentElement.dataset.motion === 'reduce');
    await p.page.waitForTimeout(250);
    const names = (await p.page.evaluate(() => window.__anims)).map((a) => a.name);
    assert.ok(!names.includes('cap-reveal') && !names.includes('cap-unblur'), names.join(','));
    assert.equal(await p.page.evaluate(() => document.documentElement.classList.contains('cap-boot')), false);
    assert.equal(await p.page.evaluate(() => getComputedStyle(document.getElementById('stage')).clipPath), 'none');
    assert.equal(await p.page.evaluate(() => document.getAnimations().length), 0);
  } finally { await p.close(); }
});

test('no database answer: the page stops waiting and shows itself without the reveal', async () => {
  const p = await open({ reducedMotion: false, manualStart: true });
  try {
    assert.equal(await p.page.evaluate(() => document.documentElement.classList.contains('cap-boot')), true);
    await p.page.waitForFunction(() => !document.documentElement.classList.contains('cap-boot'), null, { timeout: 2000 });
    assert.equal(await p.page.evaluate(() => getComputedStyle(document.getElementById('stage')).clipPath), 'none');
    assert.ok(!(await p.page.evaluate(() => window.__anims)).some((a) => a.name === 'cap-reveal'));
  } finally { await p.close(); }
});

test('« Plus » sheet: modal dialog, Tab stays inside, Escape closes and returns to the button', async () => {
  const p = await open({ device: 'iPhone 15 Pro Max' });
  try {
    await go(p, 'accueil');
    const sheet = p.page.locator('#more-sheet');
    assert.equal(await sheet.getAttribute('role'), 'dialog');
    assert.equal(await sheet.getAttribute('aria-modal'), 'true');
    await p.page.locator('#more-btn').click();
    await sheet.waitFor();
    const focused = () => p.page.evaluate(() => document.activeElement.textContent.trim());
    assert.equal(await focused(), 'Planning');
    const seen = [];
    for (let i = 0; i < 4; i++) { await p.page.keyboard.press('Tab'); seen.push(await focused()); }
    assert.deepEqual(seen, ['Analytique', 'Réglages', 'Planning', 'Analytique']);
    await p.page.keyboard.press('Shift+Tab');
    await p.page.keyboard.press('Shift+Tab');
    assert.equal(await focused(), 'Réglages'); // wrapped backwards from the first item
    await p.page.keyboard.press('Escape');
    await sheet.waitFor({ state: 'hidden' });
    assert.equal(await activeId(p), 'more-btn');
    // the trap is released: Tab moves on in the page
    await p.page.keyboard.press('Tab');
    assert.notEqual(await activeId(p), 'more-btn');
    assert.deepEqual(p.errors, []);
  } finally { await p.close(); }
});
