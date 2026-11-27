/*
 * CapPalette: the ⌘K / Ctrl+K search. Local only: it reads the snapshot already in memory (CapApp.state()),
 * never the db or the network. Companies, roles, offers and the seven screens; accent- and case-insensitive.
 * ARIA combobox (the field) + listbox (the results) with aria-activedescendant; ↑ ↓ Entrée Échap; Tab stays inside;
 * the focus goes back where it was on close. Every name comes from the db: markup only through CapUI.esc.
 */
(() => {
  'use strict';
  const SCREENS = [
    ['accueil', 'Accueil', 'M3 11.5 12 4l9 7.5M5.5 10v9.5h13V10'],
    ['offres', 'Offres', null, 'target'],
    ['candidatures', 'Candidatures', null, 'case'],
    ['planning', 'Planning', 'M3.5 10h17M8 3v4M16 3v4M6 5h12a2.5 2.5 0 0 1 2.5 2.5v10A2.5 2.5 0 0 1 18 20H6a2.5 2.5 0 0 1-2.5-2.5v-10A2.5 2.5 0 0 1 6 5z'],
    ['messages', 'Messages', null, 'chat'],
    ['analytique', 'Analytique', null, 'chart'],
    ['reglages', 'Réglages', null, 'sliders'],
  ];
  const KIND = { screen: 'Page', app: 'Candidature', offer: 'Offre' };
  const MAX = 12;
  const str = (v) => (typeof v === 'string' ? v : v == null ? '' : String(v));

  let el = null, input = null, list = null, status = null;
  let results = [];
  let active = 0;
  let back = null;

  const isOpen = () => !!el && !el.hidden;

  function icon(item) {
    if (item.path) return `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${item.path}"/></svg>`;
    return CapUI.ICON[item.icon] || '';
  }

  // Everything the palette can find, in display order for an equal score.
  function corpus() {
    const out = SCREENS.map(([route, label, path, ico]) => ({ kind: 'screen', route, label, sub: '', path, icon: ico }));
    const st = globalThis.CapApp && CapApp.state();
    const snap = st && st.snapshot;
    if (!snap) return out;
    for (const a of Array.isArray(snap.apps) ? snap.apps : []) {
      if (!a || !Number.isInteger(a.num)) continue;
      const role = str(a.role);
      out.push({ kind: 'app', num: a.num, label: str(a.company) || 'Entreprise non précisée', sub: [role, CapUI.statusLabel(a.status)].filter(Boolean).join(' · '), icon: 'case' });
    }
    for (const o of Array.isArray(snap.offers) ? snap.offers : []) {
      if (!o) continue;
      const label = str(o.company) || CapUI.hostOf(o.url) || 'Entreprise non précisée';
      out.push({ kind: 'offer', label, sub: [str(o.role), 'à évaluer'].filter(Boolean).join(' · '), icon: 'target' });
    }
    return out;
  }

  // All query words must appear; the label starting with the query ranks first, then a word of the label, etc.
  function search(q) {
    const items = corpus();
    const fq = CapUI.fold(q).trim().replace(/\s+/g, ' ');
    if (!fq) return items.filter((it) => it.kind === 'screen');
    const words = fq.split(' ');
    const rank = { screen: 3, app: 2, offer: 1 };
    return items.map((it, i) => {
      const label = CapUI.fold(it.label);
      const hay = `${label} ${CapUI.fold(it.sub)}`;
      if (!words.every((w) => hay.includes(w))) return null;
      let score = rank[it.kind];
      if (label.startsWith(fq)) score += 100;
      if (label.split(/[^a-z0-9]+/).some((w) => w.startsWith(words[0]))) score += 50;
      if (label.includes(fq)) score += 20;
      return { it, i, score };
    }).filter(Boolean).sort((a, b) => b.score - a.score || a.i - b.i).slice(0, MAX).map((x) => x.it);
  }

  function build() {
    if (el) return;
    el = document.createElement('div');
    el.id = 'palette';
    el.className = 'pal';
    el.hidden = true;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', 'pal-title');
    el.innerHTML = `<div class="pal-scrim" data-pal-close></div>
      <div class="pal-wrap"><div class="pal-panel">
        <h2 id="pal-title" class="sr-only">Rechercher dans Cap</h2>
        <div class="pal-field">
          <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg>
          <input id="pal-input" type="text" role="combobox" aria-autocomplete="list" aria-expanded="true" aria-controls="pal-list"
            aria-label="Rechercher une entreprise, un poste, une offre ou une page" placeholder="Entreprise, poste, offre, page…"
            autocomplete="off" autocapitalize="off" spellcheck="false" enterkeyhint="go">
          <button type="button" class="pal-esc" data-pal-close aria-label="Fermer la recherche"><kbd class="pal-esc-key">Échap</kbd>
            <svg class="pal-esc-x" viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
        </div>
        <ul id="pal-list" class="pal-list" role="listbox" aria-label="Résultats"></ul>
        <p id="pal-status" class="pal-status" role="status" aria-live="polite"></p>
        <p class="pal-hint" aria-hidden="true"><kbd class="kbd">↑</kbd><kbd class="kbd">↓</kbd> naviguer <kbd class="kbd">Entrée</kbd> ouvrir <kbd class="kbd">Échap</kbd> fermer</p>
      </div></div>`;
    document.body.append(el);
    input = el.querySelector('#pal-input');
    list = el.querySelector('#pal-list');
    status = el.querySelector('#pal-status');
    input.addEventListener('input', () => { active = 0; update(); });
    el.addEventListener('click', (e) => {
      const o = e.target.closest('[role=option]');
      if (o) { activate(Number(o.dataset.i)); return; }
      if (e.target.closest('[data-pal-close]')) close(true);
    });
    list.addEventListener('mousedown', (e) => e.preventDefault()); // keep the focus in the field
    list.addEventListener('pointermove', (e) => {
      const o = e.target.closest('[role=option]');
      if (o && Number(o.dataset.i) !== active) setActive(Number(o.dataset.i), false);
    });
  }

  function update() {
    const q = input.value;
    results = search(q);
    if (active >= results.length) active = 0;
    list.innerHTML = results.map((it, i) => `<li id="pal-opt-${i}" class="pal-opt" role="option" aria-selected="${i === active}" data-i="${i}">
      <span class="pal-ico">${icon(it)}</span> <span class="pal-text"><span class="pal-label">${CapUI.esc(it.label)}</span> <span class="pal-sub">${CapUI.esc(it.sub)}</span></span> <span class="pal-kind">${KIND[it.kind]}</span></li>`).join('');
    input.setAttribute('aria-expanded', String(results.length > 0));
    if (results.length) input.setAttribute('aria-activedescendant', `pal-opt-${active}`);
    else input.removeAttribute('aria-activedescendant');
    if (results.length) { status.textContent = CapUI.plural(results.length, 'résultat', 'résultats'); status.classList.add('sr-only'); }
    else { status.textContent = `Aucun résultat pour « ${q.trim()} ». Essayez un nom d'entreprise, un poste ou une page.`; status.classList.remove('sr-only'); }
  }

  function setActive(i, scroll = true) {
    if (!results.length) return;
    active = (i + results.length) % results.length;
    for (const o of list.querySelectorAll('[role=option]')) o.setAttribute('aria-selected', String(Number(o.dataset.i) === active));
    input.setAttribute('aria-activedescendant', `pal-opt-${active}`);
    const cur = list.querySelector(`#pal-opt-${active}`);
    if (scroll && cur) cur.scrollIntoView({ block: 'nearest' });
  }

  function activate(i) {
    const it = results[i];
    if (!it || !globalThis.CapApp) return;
    close(true);
    if (it.kind === 'screen') CapApp.show(it.route);
    else if (it.kind === 'app') CapApp.openApp(it.num);
    else { CapUI.intent.offerQuery = it.label; CapApp.show('offres'); }
  }

  function open() {
    build();
    if (isOpen()) return;
    if (globalThis.CapApp && CapApp.closeSheet) CapApp.closeSheet();
    back = document.activeElement;
    input.value = '';
    active = 0;
    update();
    el.hidden = false;
    input.focus();
  }

  function close(restore = true) {
    if (!isOpen()) return;
    el.hidden = true;
    const to = back;
    back = null;
    if (restore && to && to !== document.body && to.isConnected && typeof to.focus === 'function') to.focus({ preventScroll: true });
  }

  const isShortcut = (e) => (e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && (e.key === 'k' || e.key === 'K' || e.code === 'KeyK');

  // Window capture: runs before the in-page dialog's own handlers, so Échap and Tab act on the palette only.
  window.addEventListener('keydown', (e) => {
    if (isShortcut(e)) {
      e.preventDefault(); // the browser's own Ctrl+K (search bar) never fires
      if (!e.repeat) { if (isOpen()) close(true); else open(); }
      return;
    }
    if (!isOpen() || e.isComposing) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(true); return; }
    if (e.key === 'Tab') { e.stopPropagation(); CapUI.trapTab(el, e); return; }
    if (document.activeElement !== input) return;
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); setActive(active + (e.key === 'ArrowDown' ? 1 : -1)); }
    else if (e.key === 'Enter') { e.preventDefault(); activate(active); }
  }, true);

  // A route change from elsewhere (history, a link) closes it without moving the focus back.
  document.addEventListener('cap:route', () => close(false));

  const mac = /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent || '');
  for (const k of document.querySelectorAll('[data-shortcut]')) k.textContent = mac ? '⌘K' : 'Ctrl K';
  for (const b of document.querySelectorAll('#nav-search, #search-btn')) b.addEventListener('click', () => open());

  globalThis.CapPalette = { open, close: (restore = true) => close(restore), isOpen, search };
})();
