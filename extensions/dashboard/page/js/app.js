/* Cap — page shell: hash routing, navigation, "Plus" sheet, render coordinator, preferences, opening reveal. Classic script. */
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
    if (globalThis.CapPalette) CapPalette.close();
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
  const ACCENTS = ['corail', 'vert-eau', 'violet', 'bleu', 'ambre']; // the only values that reach data-accent
  const DEFAULT_PREFS = { weekly_goal: 3, accent: 'corail', reduced_motion: false };
  const ctx = {}; // shared screen context; ctx.outlook is the latest CapOutlook state
  let lastRoute = null;
  let dataState = null;
  let frame = 0;

  // ---- preferences: the stored doc, plus the choices made here and not yet confirmed by the db ----
  const override = {};
  const prefs = () => ({ ...DEFAULT_PREFS, ...(dataState && dataState.prefs), ...override });
  function applyPrefs(p) {
    const root = document.documentElement;
    // whitelist: a stored value outside ACCENTS (unknown or hostile) falls back to the default accent
    if (ACCENTS.includes(p.accent)) root.dataset.accent = p.accent; else delete root.dataset.accent;
    if (p.reduced_motion === true) root.dataset.motion = 'reduce'; else delete root.dataset.motion;
  }
  // Drops the overrides the stored prefs now carry.
  function settle(stored) {
    for (const k of Object.keys(override)) if (stored && stored[k] === override[k]) delete override[k];
  }
  // Shows the change at once, then writes settings/prefs. Rejects (and puts the stored value back) on failure.
  function setPrefs(partial) {
    Object.assign(override, partial);
    applyPrefs(prefs());
    schedule();
    let write;
    try { write = globalThis.CapData ? Promise.resolve(CapData.savePrefs(partial)) : Promise.reject(new Error('Base indisponible')); }
    catch (e) { write = Promise.reject(e); }
    return write.then(() => {
      try { settle(CapData.getState().prefs); } catch { /* keep the override until the listener delivers */ }
    }, (err) => {
      for (const [k, v] of Object.entries(partial)) if (override[k] === v) delete override[k];
      applyPrefs(prefs());
      schedule();
      throw err;
    });
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
    const view = { ...(dataState || { status: 'loading', snapshot: null, pending: [] }), prefs: prefs() };
    try { screen.render(body, view, ctx); }
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

  // ---- opening: a circular reveal of #stage and a blur lift of #main, once per load ----
  // <html class="cap-boot"> hides #stage (CSS, motion allowed only) until the first data and the stored prefs are
  // known, so the reveal shows real content and honours a stored « réduire les animations ». The wrappers that
  // animate carry no backdrop-filter themselves. No answer within BOOT_MS: the page shows itself without the reveal.
  const BOOT_MS = 1000;
  const html = document.documentElement;
  const stage = $('#stage');
  let booted = false;
  function finishBoot(reveal) {
    if (booted) return;
    booted = true;
    clearTimeout(bootTimer);
    if (reveal && stage && globalThis.CapUI && !CapUI.reduced()) {
      const done = () => html.classList.remove('cap-open');
      stage.addEventListener('animationend', (e) => { if (e.target === stage) done(); });
      stage.addEventListener('animationcancel', (e) => { if (e.target === stage) done(); });
      setTimeout(done, 1200); // safety: never leave the class behind
      html.classList.add('cap-open');
    }
    html.classList.remove('cap-boot');
  }
  const bootTimer = setTimeout(() => finishBoot(false), BOOT_MS);
  if (!globalThis.CapUI || CapUI.reduced()) finishBoot(false);

  function onState(s) {
    dataState = s;
    settle(s.prefs);
    applyPrefs(prefs());
    if (s.status === 'unavailable' || (s.status !== 'loading' && s.prefs_loaded)) finishBoot(true);
    try { syncOutlook(s); } catch (e) { console.error('Cap: Outlook sync failed', e); }
    schedule();
  }

  moreBtn.addEventListener('click', () => (sheet.hidden ? openSheet() : closeSheet(true)));
  sheet.addEventListener('click', (e) => {
    if (e.target.closest('[data-close-sheet]')) closeSheet(true);
    else if (e.target.closest('a')) closeSheet(false);
  });
  document.addEventListener('keydown', (e) => {
    if (sheet.hidden) return;
    if (e.key === 'Escape') closeSheet(true);
    else if (e.key === 'Tab') CapUI.trapTab(sheet, e); // aria-modal sheet: focus stays on its three links
  });
  window.addEventListener('hashchange', render);

  globalThis.CapApp = {
    ROUTES, ACCENTS, currentRoute, render, prefs, setPrefs,
    state: () => dataState,
    closeSheet: () => closeSheet(false),
    setContext(partial) { Object.assign(ctx, partial); schedule(); },
    // Goes to a screen; repaints it when it is already shown (so a pending CapUI.intent is consumed).
    show(route) {
      if (!ROUTES.includes(route)) return;
      if (currentRoute() === route) paint(false); else location.hash = route;
    },
    openApp(num) {
      if (!globalThis.CapUI) return;
      CapUI.intent.openApp = num;
      CapApp.show('candidatures');
    },
    // Tests that drive CapData themselves set globalThis.CAP_MANUAL_START before load and call connect().
    connect() { if (globalThis.CapData) CapData.start(onState); },
  };
  render();
  if (!globalThis.CAP_MANUAL_START) CapApp.connect();
})();
