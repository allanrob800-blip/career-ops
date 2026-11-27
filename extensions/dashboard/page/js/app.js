/* Cap — page shell: hash routing, navigation, "Plus" sheet, render coordinator. Classic script. */
(() => {
  'use strict';
  const ROUTES = ['accueil', 'offres', 'candidatures', 'planning', 'messages', 'analytique', 'reglages'];
  const EXTRA = ['planning', 'analytique', 'reglages'];
  const $ = (sel, root = document) => root.querySelector(sel);
  const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

  const sheet = $('#more-sheet');
  const moreBtn = $('#more-btn');

  function currentRoute() {
    const h = location.hash.replace(/^#/, '');
    return ROUTES.includes(h) ? h : 'accueil';
  }

  function closeSheet(restoreFocus) {
    if (sheet.hidden) return;
    sheet.hidden = true;
    moreBtn.setAttribute('aria-expanded', 'false');
    if (restoreFocus) moreBtn.focus();
  }

  function openSheet() {
    sheet.hidden = false;
    moreBtn.setAttribute('aria-expanded', 'true');
    const first = $('.sheet-item', sheet);
    if (first) first.focus();
  }

  function render() {
    const route = currentRoute();
    $$('[data-screen]').forEach((el) => { el.hidden = el.dataset.screen !== route; });
    $$('[data-route]').forEach((el) => {
      if (el.dataset.route === route) el.setAttribute('aria-current', 'page');
      else el.removeAttribute('aria-current');
    });
    moreBtn.classList.toggle('is-active', EXTRA.includes(route));
    closeSheet(false);
    if (globalThis.CapUI && route !== lastRoute) CapUI.closeDialog();
    const entering = route !== lastRoute;
    lastRoute = route;
    paint(entering);
    document.dispatchEvent(new CustomEvent('cap:route', { detail: { route } }));
  }

  // ---- render coordinator: one CapData subscription, the current screen re-renders on change ----
  const ACCENTS = ['corail', 'vert-eau', 'violet', 'bleu', 'ambre'];
  const ctx = {}; // shared screen context; ctx.outlook is the latest CapOutlook state
  let lastRoute = null;
  let dataState = null;
  let frame = 0;

  function applyPrefs(prefs) {
    const root = document.documentElement;
    if (ACCENTS.includes(prefs.accent)) root.dataset.accent = prefs.accent; else delete root.dataset.accent;
    if (prefs.reduced_motion) root.dataset.motion = 'reduce'; else delete root.dataset.motion;
  }

  function enter(section) {
    if (!globalThis.CapUI || CapUI.reduced()) return;
    section.classList.remove('is-entering');
    void section.offsetWidth; // restart the CSS animation
    section.classList.add('is-entering');
    clearTimeout(section.__capEnter);
    section.__capEnter = setTimeout(() => section.classList.remove('is-entering'), 1000);
  }

  function paint(entering) {
    frame = 0;
    const route = currentRoute();
    const section = $('#screen-' + route);
    const body = $('.screen-body', section);
    const screen = globalThis.Screens && globalThis.Screens[route];
    if (!screen || typeof screen.render !== 'function') return;
    const before = body.dataset.view;
    try { screen.render(body, dataState || { status: 'loading', snapshot: null, pending: [], prefs: {} }, ctx); }
    catch (e) { console.error('Cap: render failed', e); }
    const now = body.dataset.view || '';
    if ((entering || now !== before) && !now.startsWith('gate-')) enter(section);
  }
  const schedule = () => { if (!frame) frame = requestAnimationFrame(() => paint(false)); };

  // Outlook starts once, with the first snapshot that carries companies (never from a render). Later snapshots
  // and handled-message changes only refresh it: existing watches are never registered again.
  let outlookStarted = false;
  function syncOutlook(s) {
    const snap = s.snapshot;
    if (!globalThis.CapOutlook || !snap || !Array.isArray(snap.companies)) return;
    const companies = CapOutlook.rank(snap.companies, snap.apps);
    if (outlookStarted) { CapOutlook.update(companies); return; }
    outlookStarted = true;
    CapOutlook.start(companies, (o) => { ctx.outlook = o; schedule(); });
  }

  function onState(s) {
    dataState = s;
    applyPrefs(s.prefs || {});
    try { syncOutlook(s); } catch (e) { console.error('Cap: Outlook sync failed', e); }
    schedule();
  }

  moreBtn.addEventListener('click', () => (sheet.hidden ? openSheet() : closeSheet(true)));
  sheet.addEventListener('click', (e) => {
    if (e.target.closest('[data-close-sheet]')) closeSheet(true);
    else if (e.target.closest('a')) closeSheet(false);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(true); });
  window.addEventListener('hashchange', render);

  globalThis.CapApp = {
    ROUTES, ACCENTS, currentRoute, render,
    state: () => dataState,
    setContext(partial) { Object.assign(ctx, partial); schedule(); },
    openApp(num) {
      if (!globalThis.CapUI) return;
      CapUI.intent.openApp = num;
      if (currentRoute() === 'candidatures') paint(false); else location.hash = 'candidatures';
    },
    // Tests that drive CapData themselves set globalThis.CAP_MANUAL_START before load and call connect().
    connect() { if (globalThis.CapData) CapData.start(onState); },
  };
  render();
  if (!globalThis.CAP_MANUAL_START) CapApp.connect();
})();
