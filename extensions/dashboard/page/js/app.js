/* Cap — page shell: hash routing, navigation, "Plus" sheet. Classic script. */
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
    const el = $('#screen-' + route);
    const screens = globalThis.Screens;
    if (screens && screens[route] && typeof screens[route].show === 'function') screens[route].show($('.screen-body', el));
    document.dispatchEvent(new CustomEvent('cap:route', { detail: { route } }));
  }

  moreBtn.addEventListener('click', () => (sheet.hidden ? openSheet() : closeSheet(true)));
  sheet.addEventListener('click', (e) => {
    if (e.target.closest('[data-close-sheet]')) closeSheet(true);
    else if (e.target.closest('a')) closeSheet(false);
  });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeSheet(true); });
  window.addEventListener('hashchange', render);

  globalThis.CapApp = { ROUTES, currentRoute, render };
  render();
})();
