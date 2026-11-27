// Task 8: live, read-only Outlook (Messages, Planning, « à traiter » on Accueil) against the fake `mcp`.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startServer, launchBrowser, openPage } from './harness.mjs';
import { fixtureDocs, EMAILS, EVENTS, NOW } from './fixtures.mjs';

const SERVER = 'Microsoft 365';
const TOOLS = ['outlook_email_search', 'outlook_calendar_search'];

let server, browser, DOCS;
before(async () => { DOCS = fixtureDocs(); server = await startServer(); browser = await launchBrowser(); });
after(async () => { await browser?.close(); await server?.close(); });

async function open(opts = {}) {
  const { docs = DOCS, mcp = {}, ...rest } = opts;
  const fake = { db: { docs: structuredClone(docs) }, mcp: { mode: 'ok', emails: EMAILS, events: EVENTS, ...mcp } };
  const p = await openPage(browser, { url: server.url, now: NOW, reducedMotion: true, fake, ...rest });
  p.page.setDefaultTimeout(5000);
  p.dialogs = [];
  p.page.on('dialog', (d) => { p.dialogs.push(d.message()); d.dismiss().catch(() => {}); });
  return p;
}
const body = (name) => `#screen-${name} .screen-body`;
// Waits for the screen to be rendered and for its Outlook section to reach `outlook` (ok | error | unavailable).
async function go(p, name, outlook = 'ok') {
  await p.page.evaluate((n) => { location.hash = n; }, name);
  await p.page.waitForFunction(([sel, n, o]) => {
    const el = document.querySelector(sel);
    return el?.dataset.view === n && (o === null || el.dataset.outlook === o);
  }, [body(name), name, name === 'messages' || name === 'planning' ? outlook : null]);
  await p.page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))));
}
const settle = (p) => p.page.evaluate(() => new Promise((r) => setTimeout(() => requestAnimationFrame(() => requestAnimationFrame(r)), 60)));
const groups = (p) => p.page.locator(`${body('messages')} [data-group] .thread-title`).allInnerTexts().then((a) => a.map((s) => s.replace(/\s+/g, ' ').trim()));
const mcpCalls = (p) => p.page.evaluate(() => window.__calls.filter((c) => c.ns === 'mcp'));
const setMcp = (p, patch) => p.page.evaluate((x) => { Object.assign(window.__fake.mcp, x); window.__mcpRefetch(); }, patch);

for (const shape of ['array', 'blocks']) {
  test(`Messages (${shape} payload): Acme (1) and Non rattachés (1), promo and trailer dropped`, async () => {
    const p = await open({ mcp: { shape } });
    try {
      await go(p, 'messages');
      assert.deepEqual(await groups(p), ['Acme (1)', 'Non rattachés (1)']);
      const txt = await p.page.locator(body('messages')).innerText();
      assert.match(txt, /Suite à notre échange/);
      assert.match(txt, /Votre candidature/);
      assert.doesNotMatch(txt, /Black Friday/);
      assert.equal(await p.page.locator(`${body('messages')} .bubble`).count(), 2);
      const link = p.page.locator(`${body('messages')} [data-group="Acme"] a`, { hasText: 'Ouvrir dans Outlook' });
      assert.equal(await link.getAttribute('href'), 'https://outlook.office365.com/owa/?ItemID=AAMk-acme-1');
      assert.equal(await p.page.locator(`${body('messages')} button`, { hasText: 'Marquer comme traité' }).count(), 2);
      assert.deepEqual(p.errors, []);
    } finally { await p.close(); }
  });

  test(`Planning (${shape} payload): interviews on their day, other events dropped, follow-ups from the snapshot`, async () => {
    const p = await open({ mcp: { shape } });
    try {
      await go(p, 'planning');
      const today = p.page.locator(`${body('planning')} [data-day="2026-11-27"]`);
      assert.match(await today.innerText(), /Point avec Acme/);
      assert.match(await today.innerText(), /15:30/);
      assert.match(await today.innerText(), /UTC/); // not Paris time: the zone is named
      assert.match(await today.innerText(), /Borealis/); // overdue follow-up, to do today
      assert.equal(await today.locator('.now-line').count(), 1);
      const all = await p.page.locator(body('planning')).innerText();
      assert.doesNotMatch(all, /Dentiste/);
      assert.doesNotMatch(all, /Foxtrot : Head of Product/); // next week
      await p.page.locator('#plan-next').click();
      const monday = p.page.locator(`${body('planning')} [data-day="2026-11-30"]`);
      await monday.locator('.ev', { hasText: 'Entretien Foxtrot' }).waitFor();
      const ev = await monday.innerText();
      assert.match(ev, /14:00/);
      assert.match(ev, /Visio Teams/);
      assert.doesNotMatch(ev, /Europe\/Paris/);
      assert.equal(await monday.locator('a[href="https://outlook.office365.com/calendar/item/evt-foxtrot"]').count(), 1);
      assert.match(await p.page.locator(`${body('planning')} [data-day="2026-12-01"]`).innerText(), /Cobalt/); // planned follow-up
      assert.deepEqual(p.errors, []);
    } finally { await p.close(); }
  });
}

test('Planning: week in columns at 1440px, list by day at 430px', async () => {
  const tops = async (p) => p.page.locator(`${body('planning')} [data-day]:visible`).evaluateAll((els) => els.map((e) => Math.round(e.getBoundingClientRect().top)));
  const wide = await open();
  try {
    await go(wide, 'planning');
    const t = await tops(wide);
    assert.equal(t.length, 7);
    assert.equal(new Set(t).size, 1, 'seven columns side by side');
  } finally { await wide.close(); }
  const phone = await open({ device: { width: 430, height: 900 } });
  try {
    await go(phone, 'planning');
    const t = await tops(phone);
    assert.ok(t.length >= 1 && new Set(t).size === t.length, 'days stacked');
    assert.ok(await phone.page.locator(`${body('planning')} [data-day="2026-11-27"]`).isVisible());
  } finally { await phone.close(); }
});

test('hostile subject, sender, location and links render as text: no element, no link, no dialog', async () => {
  const emails = [
    { id: 'x-1', subject: '<script>alert(1)</script> candidature', sender: '"><img src=x onerror=alert(2)>@acme.fr', senderName: '<img src=x onerror=alert(3)>', receivedDateTime: '2026-11-26T09:12:00Z', summary: '<b onmouseover=alert(4)>entretien</b>', webLink: 'javascript:alert(5)' },
    { id: 'x-2', subject: 'Entretien', sender: 'rh@acme.fr', senderName: 'RH', receivedDateTime: '2026-11-26T10:00:00Z', summary: '', webLink: 'http://outlook.office365.com/owa/?ItemID=x-2' },
    { id: 'x-3" data-x="1', subject: 'Recrutement', sender: 'rh@acme.fr', senderName: 'RH', receivedDateTime: 'pas une date', summary: 'ok', webLink: 'https://outlook.office365.com/owa/?a="><img src=x>' },
  ];
  const events = [
    { id: 'e-1', subject: 'Entretien <script>alert(6)</script>', start: { dateTime: '2026-11-27T11:00:00', timeZone: '<img src=x onerror=alert(7)>' }, end: null, location: { displayName: '<img src=x onerror=alert(8)>' }, webLink: 'javascript:alert(9)' },
    { id: 'e-2', subject: 'Interview', start: 'n\'importe quoi', location: 42 },
  ];
  const p = await open({ mcp: { emails, events } });
  try {
    await go(p, 'messages');
    const m = p.page.locator(body('messages'));
    assert.ok(await m.locator('text=<script>alert(1)</script> candidature').first().isVisible());
    assert.ok(await m.locator('text=<img src=x onerror=alert(3)>').first().isVisible());
    assert.equal(await m.locator('script, img, b').count(), 0);
    assert.equal(await m.locator('a[href^="javascript"], a[href^="http:"]').count(), 0);
    assert.equal(await m.locator('.bubble', { hasText: 'candidature' }).locator('a').count(), 0);
    assert.equal(await m.locator('.bubble', { hasText: 'Entretien' }).locator('a').count(), 0); // http: is not linked
    assert.equal(await m.locator('.bubble', { hasText: 'Recrutement' }).locator('a[href^="https://outlook.office365.com/"]').count(), 1);
    assert.equal(await m.locator('[data-x]').count(), 0);
    await go(p, 'planning');
    const pl = p.page.locator(body('planning'));
    assert.ok(await pl.locator('text=Entretien <script>alert(6)</script>').first().isVisible());
    assert.ok(await pl.locator('text=<img src=x onerror=alert(8)>').first().isVisible());
    assert.equal(await pl.locator('script, img').count(), 0);
    assert.equal(await pl.locator('a[href^="javascript"]').count(), 0);
    await go(p, 'accueil');
    assert.equal(await p.page.locator(`${body('accueil')} script, ${body('accueil')} img`).count(), 0);
    await p.page.waitForTimeout(100);
    assert.deepEqual(p.dialogs, []);
    assert.deepEqual(p.errors, []);
  } finally { await p.close(); }
});

test('mcp unavailable (null): Messages and Planning say so, Accueil and follow-ups still render', async () => {
  const p = await open({ mcp: { mode: 'null' } });
  try {
    await go(p, 'messages', 'unavailable');
    assert.match(await p.page.locator(body('messages')).innerText(), /Outlook n'est pas accessible depuis cet appareil/);
    assert.equal(await p.page.locator(`${body('messages')} button`).count(), 0);
    await go(p, 'planning', 'unavailable');
    const pl = await p.page.locator(body('planning')).innerText();
    assert.match(pl, /Outlook n'est pas accessible depuis cet appareil/);
    assert.match(pl, /Borealis/);
    await go(p, 'accueil');
    await p.page.waitForFunction(() => document.getElementById('goal-count')?.textContent.replace(/\s+/g, ' ').trim() === '3 sur 3');
    assert.match(await p.page.locator('#todo').innerText(), /Outlook n'est pas accessible depuis cet appareil/);
    assert.deepEqual(await mcpCalls(p), []);
    assert.deepEqual(p.errors, []);
  } finally { await p.close(); }
});

const COPY = {
  needs_reauth: /Reconnectez Microsoft 365 dans claude\.ai → Réglages → Connecteurs\./,
  server_not_connected: /Ajoutez le connecteur Microsoft 365 dans claude\.ai → Réglages → Connecteurs\./,
  selection_required: /Ajoutez le connecteur Microsoft 365 dans claude\.ai → Réglages → Connecteurs\./,
  not_in_manifest: /L'accès à Outlook n'est pas autorisé pour cette page\./,
  blocked_by_policy: /L'accès à Outlook n'est pas autorisé pour cette page\./,
  not_granted: /Outlook n'est pas accessible depuis cet appareil\./,
  server_unavailable: /Outlook ne répond pas pour l'instant\./,
  forbidden: /Outlook ne répond pas pour l'instant\./, // unknown code: treated as upstream_error
};
test('error from the first delivery: one French message per error code, no data, no button', async () => {
  for (const [code, copy] of Object.entries(COPY)) {
    const p = await open({ mcp: { mode: 'error', code } });
    try {
      const status = code === 'not_granted' ? 'unavailable' : 'error';
      await go(p, 'messages', status);
      const m = p.page.locator(body('messages'));
      assert.match(await m.innerText(), copy, code);
      assert.equal(await m.locator('.outlook-note').count(), 1, `${code}: one message for Outlook`);
      assert.equal(await m.locator('.bubble, button').count(), 0, code);
      await go(p, 'planning', status);
      assert.match(await p.page.locator(body('planning')).innerText(), copy, code);
      assert.equal(await p.page.locator(`${body('planning')} .outlook-note`).count(), 1);
      assert.equal((await mcpCalls(p)).filter((c) => c.fn !== 'watchTool').length, 0, `${code}: no retry, no call`);
      assert.deepEqual(p.errors, []);
    } finally { await p.close(); }
  }
});

test('authorization error after a good delivery retracts the data on every screen', async () => {
  const p = await open();
  try {
    await go(p, 'messages');
    assert.equal(await p.page.locator(`${body('messages')} .bubble`).count(), 2);
    await setMcp(p, { mode: 'error', code: 'needs_reauth' });
    await go(p, 'messages', 'error');
    const m = p.page.locator(body('messages'));
    assert.match(await m.innerText(), COPY.needs_reauth);
    assert.equal(await m.locator('.bubble').count(), 0);
    assert.doesNotMatch(await m.innerText(), /Suite à notre échange|Acme/);
    await go(p, 'planning', 'error');
    assert.equal(await p.page.locator(`${body('planning')} .ev-meet`).count(), 0);
    assert.doesNotMatch(await p.page.locator(body('planning')).innerText(), /Point avec Acme/);
    await go(p, 'accueil');
    const todo = await p.page.locator('#todo').innerText();
    assert.doesNotMatch(todo, /à traiter|Prochain entretien/);
    assert.match(todo, COPY.needs_reauth);
    assert.equal((await mcpCalls(p)).filter((c) => c.fn !== 'watchTool').length, 0, 'never retried');
    assert.deepEqual(p.errors, []);
  } finally { await p.close(); }
});

test('an authorization error on one watch retracts the whole section: nothing stale comes back', async () => {
  const p = await open({ mcp: { storedAt: 1e20 } }); // an absurd cache stamp must not break the page
  try {
    await go(p, 'messages');
    assert.deepEqual(await groups(p), ['Acme (1)', 'Non rattachés (1)']);
    const one = (tool, input) => input.query === 'candidature';
    await p.page.evaluate((src) => { Object.assign(window.__fake.mcp, { mode: 'error', code: 'needs_reauth' }); window.__mcpRefetch(new Function(`return ${src}`)()); }, one.toString());
    await go(p, 'messages', 'error');
    assert.equal(await p.page.locator(`${body('messages')} .bubble`).count(), 0);
    await go(p, 'planning'); // the calendar watch did not fail
    // that watch recovers with fewer messages: what the other watches held before the denial stays retracted
    await p.page.evaluate((src) => {
      Object.assign(window.__fake.mcp, { mode: 'ok', emails: window.__fake.mcp.emails.filter((m) => m.id !== 'AAMk-acme-1') });
      window.__mcpRefetch(new Function(`return ${src}`)());
    }, one.toString());
    await go(p, 'messages');
    assert.deepEqual(await groups(p), ['Non rattachés (1)']);
    assert.deepEqual(p.errors, []);
  } finally { await p.close(); }
});

// Accueil reads each section: a failure of one must not look like « nothing to process ».
const notes = (p) => p.page.locator('#todo [data-outlook-note]');
test('Accueil: mail needs approval while the calendar works: approval copy for messages, next interview kept', async () => {
  const p = await open({ mcp: { byTool: { outlook_email_search: { mode: 'error', code: 'approval_required' } } } });
  try {
    await go(p, 'planning');
    await go(p, 'accueil');
    await notes(p).first().waitFor();
    assert.equal(await notes(p).count(), 1);
    const link = p.page.locator('#todo [data-outlook-note="mail"] a[href="#messages"]');
    assert.match(await link.innerText(), /Autorisez l'accès à Outlook pour afficher vos messages\./);
    const todo = await p.page.locator('#todo').innerText();
    assert.match(todo, /Prochain entretien : Point avec Acme/);
    assert.equal(await p.page.locator('[data-count=messages]').count(), 0);
    assert.equal(await p.page.locator('#todo button', { hasText: 'Autoriser Outlook' }).count(), 0);
    await link.click();
    await go(p, 'messages', 'error'); // the button lives on the screen the line links to
    assert.equal(await p.page.locator(`${body('messages')} button`, { hasText: 'Autoriser Outlook' }).count(), 1);
    assert.equal((await mcpCalls(p)).filter((c) => c.fn === 'callTool').length, 0);
    assert.deepEqual(p.errors, []);
  } finally { await p.close(); }
});

test('Accueil: calendar needs a reconnection while mail works: messages count kept, calendar reason shown', async () => {
  const p = await open({ mcp: { byTool: { outlook_calendar_search: { mode: 'error', code: 'needs_reauth' } } } });
  try {
    await go(p, 'messages');
    await go(p, 'accueil');
    await notes(p).first().waitFor();
    assert.equal(await notes(p).count(), 1);
    assert.match(await p.page.locator('#todo [data-outlook-note="calendar"] a[href="#planning"]').innerText(), COPY.needs_reauth);
    assert.equal((await p.page.locator('[data-count=messages]').innerText()).trim(), '2');
    assert.doesNotMatch(await p.page.locator('#todo').innerText(), /Prochain entretien/);
    assert.deepEqual(p.errors, []);
  } finally { await p.close(); }
});

test('Accueil: both sections failing with the same reason give one line, different reasons give two', async () => {
  const same = await open({ mcp: { mode: 'error', code: 'needs_reauth' } });
  try {
    await go(same, 'messages', 'error');
    await go(same, 'planning', 'error');
    await go(same, 'accueil');
    await notes(same).first().waitFor();
    assert.equal(await notes(same).count(), 1);
    assert.match(await same.page.locator('#todo [data-outlook-note] a[href="#messages"]').innerText(), COPY.needs_reauth);
    assert.equal((await same.page.locator('#todo').innerText()).match(/Reconnectez/g).length, 1);
  } finally { await same.close(); }
  const two = await open({ mcp: { mode: 'error', code: 'needs_reauth', byTool: { outlook_calendar_search: { code: 'server_unavailable' } } } });
  try {
    await go(two, 'messages', 'error');
    await go(two, 'planning', 'error');
    await go(two, 'accueil');
    await notes(two).nth(1).waitFor();
    assert.match(await two.page.locator('#todo [data-outlook-note="mail"]').innerText(), COPY.needs_reauth);
    assert.match(await two.page.locator('#todo [data-outlook-note="calendar"]').innerText(), COPY.server_unavailable);
    assert.deepEqual(two.errors, []);
  } finally { await two.close(); }
});

test('transient error after a good delivery keeps the data with « peut-être pas à jour »', async () => {
  const p = await open({ mcp: { storedAt: Date.parse('2026-11-27T08:30:00Z') } });
  try {
    await go(p, 'messages');
    assert.match(await p.page.locator('#msg-fresh').innerText(), /Mis à jour le 27 nov\. à 09:30/);
    assert.doesNotMatch(await p.page.locator(body('messages')).innerText(), /peut-être pas à jour/);
    await setMcp(p, { mode: 'error', code: 'server_unavailable', retryable: true });
    await p.page.waitForFunction((sel) => /peut-être pas à jour/.test(document.querySelector(sel)?.textContent || ''), body('messages'));
    assert.deepEqual(await groups(p), ['Acme (1)', 'Non rattachés (1)']);
    assert.equal(await p.page.locator(`${body('messages')} .bubble`).count(), 2);
    assert.match(await p.page.locator('#msg-fresh').innerText(), /Mis à jour le 27 nov\. à 09:30/);
    await go(p, 'planning');
    const pl = await p.page.locator(body('planning')).innerText();
    assert.match(pl, /Point avec Acme/);
    assert.match(pl, /peut-être pas à jour/);
    await go(p, 'accueil');
    assert.equal((await p.page.locator('[data-count=messages]').innerText()).trim(), '2');
    assert.match(await p.page.locator('#todo').innerText(), /peut-être pas à jour/);
    // back to normal on the next good delivery
    await setMcp(p, { mode: 'ok' });
    await go(p, 'messages');
    await p.page.waitForFunction((sel) => !/peut-être pas à jour/.test(document.querySelector(sel)?.textContent || ''), body('messages'));
    assert.deepEqual(p.errors, []);
  } finally { await p.close(); }
});

test('approval_required: « Autoriser Outlook » calls callTool once on click and renders its result', async () => {
  const p = await open({ mcp: { mode: 'error', code: 'approval_required' } });
  try {
    await go(p, 'messages', 'error');
    const m = p.page.locator(body('messages'));
    assert.match(await m.innerText(), /Autorisez l'accès à Outlook pour afficher vos messages\./);
    assert.equal(await m.locator('.bubble').count(), 0);
    const btn = m.locator('button', { hasText: 'Autoriser Outlook' });
    assert.equal(await btn.count(), 1);
    await settle(p);
    assert.equal((await mcpCalls(p)).filter((c) => c.fn === 'callTool').length, 0, 'a watch never asks for approval');
    const watched = (await mcpCalls(p)).filter((c) => c.fn === 'watchTool' && c.args[1] === 'outlook_email_search').map((c) => JSON.stringify(c.args.slice(0, 3)));
    // slow refetch: the watches stay silent after the click, so only the callTool result can fill the screen
    await p.page.evaluate(() => { window.__fake.mcp.latencyMs = 600000; });
    await btn.click();
    await go(p, 'messages');
    assert.deepEqual(await groups(p), ['Acme (1)', 'Non rattachés (1)']);
    const calls = (await mcpCalls(p)).filter((c) => c.fn === 'callTool');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args[0], SERVER);
    assert.equal(calls[0].args[1], 'outlook_email_search');
    assert.ok(watched.includes(JSON.stringify(calls[0].args.slice(0, 3))), 'the same call as one of the watches');
    assert.equal(await m.locator('button', { hasText: 'Autoriser Outlook' }).count(), 0);
    const inv = (await mcpCalls(p)).filter((c) => c.fn === 'invalidate');
    assert.deepEqual(inv.map((c) => c.args.slice(0, 2)), [[SERVER, 'outlook_email_search']]);
    assert.deepEqual(p.errors, []);
  } finally { await p.close(); }
});

test('approval refused: the button stays, one call per click, nothing rendered', async () => {
  const p = await open({ mcp: { mode: 'error', code: 'approval_required', deny: true } });
  try {
    await go(p, 'planning', 'error');
    const pl = p.page.locator(body('planning'));
    const btn = pl.locator('button', { hasText: 'Autoriser Outlook' });
    await btn.click();
    await p.page.waitForFunction(() => window.__calls.some((c) => c.fn === 'callTool'));
    await settle(p);
    const calls = (await mcpCalls(p)).filter((c) => c.fn === 'callTool');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].args[1], 'outlook_calendar_search');
    assert.equal(await btn.count(), 1);
    assert.equal(await btn.isEnabled(), true);
    assert.equal(await pl.locator('.ev-meet').count(), 0);
    assert.deepEqual(p.errors, []);
  } finally { await p.close(); }
});

test('« Marquer comme traité »: Accueil goes from 2 to 1 message à traiter, handled/{id} is written', async () => {
  const p = await open();
  try {
    await go(p, 'accueil');
    await p.page.waitForFunction(() => document.querySelector('[data-count=messages]')?.textContent.trim() === '2');
    assert.doesNotMatch(await p.page.locator('#todo').innerText(), /Outlook non connecté/);
    assert.match(await p.page.locator('#todo').innerText(), /Prochain entretien : Point avec Acme/);
    await go(p, 'messages');
    await p.page.locator(`${body('messages')} [data-group="Acme"] button`, { hasText: 'Marquer comme traité' }).click();
    await p.page.waitForFunction(() => window.__fake.db.docs['handled/AAMk-acme-1']?.message_id === 'AAMk-acme-1');
    await p.page.waitForFunction((sel) => document.querySelector(`${sel} [data-group="Acme"] .bubble`)?.classList.contains('is-handled'), body('messages'));
    assert.equal(await p.page.locator(`${body('messages')} [data-group="Acme"] button`).count(), 0);
    assert.equal(await p.page.locator(`${body('messages')} button`, { hasText: 'Marquer comme traité' }).count(), 1);
    await go(p, 'accueil');
    await p.page.waitForFunction(() => document.querySelector('[data-count=messages]')?.textContent.trim() === '1');
    assert.deepEqual(p.errors, []);
  } finally { await p.close(); }
});

test('a message handled before the page opened is not « à traiter »', async () => {
  const docs = { ...DOCS, 'handled/AAMk-inconnu-1': { message_id: 'AAMk-inconnu-1', at: '2026-11-26T10:00:00Z' } };
  const p = await open({ docs });
  try {
    await go(p, 'accueil');
    await p.page.waitForFunction(() => document.querySelector('[data-count=messages]')?.textContent.trim() === '1');
    await go(p, 'messages');
    assert.equal(await p.page.locator(`${body('messages')} .bubble.is-handled`).count(), 1);
  } finally { await p.close(); }
});

test('only the two read tools are watched, once per identity, with the documented inputs', async () => {
  const p = await open();
  try {
    for (const s of ['accueil', 'messages', 'planning', 'offres', 'messages', 'planning']) await go(p, s);
    await settle(p);
    const calls = await mcpCalls(p);
    assert.ok(calls.length > 0);
    for (const c of calls) {
      assert.equal(c.fn, 'watchTool', 'display only: no callTool, no other API');
      assert.equal(c.args[0], SERVER);
      assert.ok(TOOLS.includes(c.args[1]), c.args[1]);
      assert.deepEqual(c.args[3], { refetchInterval: 300000 });
    }
    const ids = calls.map((c) => JSON.stringify(c.args.slice(0, 3)));
    assert.equal(new Set(ids).size, ids.length, 'one watch per identity');
    const mail = calls.filter((c) => c.args[1] === 'outlook_email_search').map((c) => c.args[2]);
    assert.deepEqual(mail.filter((i) => i.query).map((i) => i.query), ['candidature', 'entretien', 'recrutement', 'interview', 'recruiter']);
    assert.deepEqual(mail.filter((i) => i.sender).map((i) => i.sender), ['acme.fr']);
    for (const i of mail) {
      assert.equal(i.limit, 25);
      assert.equal(i.afterDateTime, '2026-10-28T00:00:00.000Z'); // 30 days before, on a day boundary (cache-stable)
      assert.equal('folderName' in i, false);
      assert.ok(!(i.query && i.sender));
    }
    const cal = calls.filter((c) => c.args[1] === 'outlook_calendar_search').map((c) => c.args[2]);
    assert.deepEqual(cal, [{ query: '*', afterDateTime: '2026-11-27T09:00:00.000Z', beforeDateTime: '2026-12-11T09:00:00.000Z', order: 'oldest', limit: 25 }]);
    assert.deepEqual(p.errors, []);
  } finally { await p.close(); }
});

test('a later snapshot with a new company domain adds one watch and re-registers none', async () => {
  const p = await open();
  try {
    await go(p, 'messages');
    const before = (await mcpCalls(p)).length;
    await p.page.evaluate(async () => {
      const db = await claude.use('db');
      const docs = structuredClone(window.__fake.db.docs);
      const meta = docs['snapshot/meta'];
      meta.generation = 'g-next';
      meta.companies.find((c) => c.name === 'Borealis').domains = ['borealis.test'];
      for (const part of meta.parts) await db.doc(part).set({ ...docs[part], generation: 'g-next' });
      await db.doc('snapshot/meta').set(meta);
    });
    await p.page.waitForFunction((n) => window.__calls.filter((c) => c.ns === 'mcp').length > n, before);
    await settle(p);
    const added = (await mcpCalls(p)).slice(before);
    assert.equal(added.length, 1);
    assert.equal(added[0].fn, 'watchTool');
    // an Applied company is asked before an Evaluated one, but existing watches are left alone
    assert.deepEqual(added[0].args[2], { sender: 'borealis.test', afterDateTime: '2026-10-28T00:00:00.000Z', limit: 25 });
    await go(p, 'messages'); // still ok: no bad_request from a duplicate registration
    assert.deepEqual(await groups(p), ['Acme (1)', 'Non rattachés (1)']);
    assert.deepEqual(p.errors, []);
  } finally { await p.close(); }
});

test('empty database: Messages and Planning show their French empty state and Outlook is not started', async () => {
  const p = await openPage(browser, { url: server.url, now: NOW, fake: { db: { docs: {} }, mcp: { mode: 'ok', emails: EMAILS, events: EVENTS } } });
  try {
    for (const s of ['messages', 'planning']) {
      await p.page.evaluate((n) => { location.hash = n; }, s);
      await p.page.waitForFunction((sel) => document.querySelector(sel)?.dataset.view === 'gate-empty', body(s));
      assert.match(await p.page.locator(`${body(s)} .empty`).innerText(), /synchronisation/);
    }
    assert.deepEqual(await mcpCalls(p), []);
    assert.deepEqual(p.errors, []);
  } finally { await p.close(); }
});

test('no message and no event: realistic empty states', async () => {
  const p = await open({ mcp: { emails: [{ moreResults: false }], events: [] } });
  try {
    await go(p, 'messages');
    assert.match(await p.page.locator(`${body('messages')} .empty`).innerText(), /Aucun message lié à votre recherche/);
    await go(p, 'planning');
    assert.equal(await p.page.locator(`${body('planning')} .ev-meet`).count(), 0);
    assert.match(await p.page.locator(body('planning')).innerText(), /Borealis/);
    assert.deepEqual(p.errors, []);
  } finally { await p.close(); }
});

test('itemsOf: array, wrapped array and text blocks give the same items; trailers and junk are dropped', async () => {
  const p = await open();
  try {
    const r = await p.page.evaluate(() => {
      const a = { id: 'a', subject: 'A' }, b = { id: 'b', subject: 'B' }, trailer = { moreResults: true, nextOffset: 25 };
      const ids = (res) => CapOutlook.itemsOf(res).map((o) => o.id);
      const text = (v) => ({ type: 'text', text: typeof v === 'string' ? v : JSON.stringify(v) });
      return {
        payload: ids({ content: [], payload: [a, b, trailer] }),
        structured: ids({ structuredContent: [a, b], payload: 'ignored' }),
        wrapped: ids({ payload: { value: [a, b, trailer], total: 2 } }),
        wrappedKeys: ['items', 'results', 'messages', 'events'].map((k) => ids({ structuredContent: { [k]: [a] } }).join()),
        blocks: ids({ content: [text(a), text(b), text(trailer)], payload: a }),
        blockArray: ids({ content: [text([a, b])], payload: 'not json' }),
        junk: ids({ content: [text('pas du JSON'), { type: 'image', data: 'x' }, text(a), text('42'), null], payload: 'pas du JSON' }),
        mixed: ids({ payload: [a, null, 'x', 3, [b], trailer] }),
        none: [ids(null), ids({}), ids({ payload: 'texte' }), ids('x')],
      };
    });
    assert.deepEqual(r, {
      payload: ['a', 'b'], structured: ['a', 'b'], wrapped: ['a', 'b'], wrappedKeys: ['a', 'a', 'a', 'a'],
      blocks: ['a', 'b'], blockArray: ['a', 'b'], junk: ['a'], mixed: ['a'], none: [[], [], [], []],
    });
  } finally { await p.close(); }
});

test('event times: a {dateTime, timeZone} pair keeps its wall clock and resolves to the right instant', async () => {
  const p = await open();
  try {
    const r = await p.page.evaluate(() => {
      const w = (v) => { const x = CapOutlook.when(v); return x && [x.day, x.time, x.zone, new Date(x.ms).toISOString()]; };
      return {
        paris: w({ dateTime: '2026-11-30T14:00:00.0000000', timeZone: 'Europe/Paris' }),
        parisSummer: w({ dateTime: '2026-07-01T09:30:00', timeZone: 'Europe/Paris' }),
        windows: w({ dateTime: '2026-11-30T14:00:00.0000000', timeZone: 'Romance Standard Time' }),
        berlin: w({ dateTime: '2026-11-30T14:00:00', timeZone: 'Europe/Berlin' }),
        utc: w({ dateTime: '2026-11-30T14:00:00.0000000', timeZone: 'UTC' }),
        newYork: w({ dateTime: '2026-11-30T20:00:00', timeZone: 'America/New_York' }),
        offset: w('2026-11-30T23:30:00Z'),
        offset2: w({ dateTime: '2026-11-30T14:00:00+02:00' }),
        noZone: w({ dateTime: '2026-11-30T14:00:00' }),
        dateOnly: w({ date: '2026-12-02' }),
        bad: [w(null), w('demain'), w({ dateTime: '2026-13-40T99:00:00', timeZone: 'UTC' }), w({ dateTime: 42 })],
      };
    });
    assert.deepEqual(r.paris, ['2026-11-30', '14:00', null, '2026-11-30T13:00:00.000Z']);
    assert.deepEqual(r.parisSummer, ['2026-07-01', '09:30', null, '2026-07-01T07:30:00.000Z']);
    assert.deepEqual(r.windows, ['2026-11-30', '14:00', null, '2026-11-30T13:00:00.000Z']);
    assert.deepEqual(r.berlin, ['2026-11-30', '14:00', null, '2026-11-30T13:00:00.000Z']); // same clock as Paris: no label
    assert.deepEqual(r.utc, ['2026-11-30', '14:00', 'UTC', '2026-11-30T14:00:00.000Z']);
    assert.deepEqual(r.newYork, ['2026-11-30', '20:00', 'America/New_York', '2026-12-01T01:00:00.000Z']);
    assert.deepEqual(r.offset, ['2026-12-01', '00:30', null, '2026-11-30T23:30:00.000Z']); // an instant: shown in Paris time
    assert.deepEqual(r.offset2, ['2026-11-30', '13:00', null, '2026-11-30T12:00:00.000Z']);
    assert.deepEqual(r.noZone, ['2026-11-30', '14:00', null, '2026-11-30T13:00:00.000Z']);
    assert.deepEqual(r.dateOnly.slice(0, 3), ['2026-12-02', null, null]);
    assert.deepEqual(r.bad, [null, null, null, null]);
  } finally { await p.close(); }
});
