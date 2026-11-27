/*
 * Réglages: accent (5 colours), weekly goal (1 to 10), « réduire les animations », last sync date.
 * Built once, then kept in step with the preferences (CapApp.prefs: stored doc + choices not yet confirmed).
 * A stored accent outside the list is shown as the default: no stored value ever reaches the markup.
 */
(() => {
  'use strict';
  const Screens = (globalThis.Screens = globalThis.Screens || {});
  const ACCENTS = [['corail', 'Corail'], ['vert-eau', 'Vert d\'eau'], ['violet', 'Violet'], ['bleu', 'Bleu'], ['ambre', 'Ambre']];
  const IDS = ACCENTS.map(([id]) => id);
  const GOAL_MIN = 1, GOAL_MAX = 10;
  const FAIL = 'Le réglage n\'a pas pu être enregistré. Réessayez dans un moment.';
  const systemReduced = globalThis.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };
  let last = null; // { root, state }

  function html() {
    const swatches = ACCENTS.map(([id, label]) => `<label class="swatch" for="acc-${id}">
        <input type="radio" name="accent" id="acc-${id}" value="${id}">
        <span class="sw-dot" data-swatch="${id}" aria-hidden="true"></span><span class="swatch-name">${label}</span>
        <span class="swatch-tick" aria-hidden="true">${CapUI.ICON.check}</span></label>`).join('');
    return `<div class="settings">
      <section class="card glass set-card rise" style="--i:0" aria-labelledby="set-accent">
        <fieldset class="set-fieldset"><legend id="set-accent" class="set-title">Couleur du thème</legend>
          <p class="set-help">L'accent change partout dans la page, tout de suite.</p>
          <div class="swatches">${swatches}</div></fieldset></section>
      <section class="card glass set-card rise" style="--i:1" aria-labelledby="set-goal">
        <div class="set-row"><div><h2 id="set-goal" class="set-title">Objectif hebdomadaire</h2>
            <p class="set-help">Candidatures envoyées par semaine, de ${GOAL_MIN} à ${GOAL_MAX}. Peu, mais bien ciblées.</p></div>
          <div class="stepper" role="group" aria-labelledby="set-goal">
            <button type="button" id="goal-minus" aria-label="Diminuer l'objectif">−</button>
            <output id="goal-value" aria-live="polite" aria-label="Candidatures par semaine">3</output>
            <button type="button" id="goal-plus" aria-label="Augmenter l'objectif">+</button></div></div></section>
      <section class="card glass set-card rise" style="--i:2" aria-labelledby="motion-label">
        <div class="set-row"><div><h2 id="motion-label" class="set-title">Réduire les animations</h2>
            <p class="set-help" id="motion-help">Coupe l'ouverture animée, les compteurs et les transitions entre écrans.</p></div>
          <button type="button" id="motion-switch" class="switch" role="switch" aria-checked="false" aria-labelledby="motion-label" aria-describedby="motion-help">
            <span class="switch-track"><span class="switch-thumb"></span></span></button></div></section>
      <section class="card glass set-card rise" style="--i:3" aria-labelledby="set-sync">
        <h2 id="set-sync" class="set-title">Dernière synchronisation</h2>
        <p id="sync-date" class="sync-date"></p>
        <p id="apply-note" class="set-help">Ces réglages s'appliquent tout de suite sur cette page. Les changements de statut et les notes demandés ici sont appliqués par Claude à la prochaine session career-ops.</p>
      </section></div>`;
  }

  function sync(root, state) {
    const p = (globalThis.CapApp && CapApp.prefs()) || state.prefs || {};
    const accent = IDS.includes(p.accent) ? p.accent : 'corail';
    for (const r of root.querySelectorAll('input[name=accent]')) r.checked = r.value === accent;
    const goal = Number.isInteger(p.weekly_goal) ? p.weekly_goal : 3;
    root.querySelector('#goal-value').textContent = CapUI.fmtNum(goal);
    const minus = root.querySelector('#goal-minus'), plus = root.querySelector('#goal-plus');
    const lost = (b, off) => off && document.activeElement === b;
    const moveFrom = lost(minus, goal <= GOAL_MIN) ? plus : lost(plus, goal >= GOAL_MAX) ? minus : null;
    minus.disabled = goal <= GOAL_MIN;
    plus.disabled = goal >= GOAL_MAX;
    if (moveFrom) moveFrom.focus(); // a button that becomes disabled would drop the keyboard focus
    root.querySelector('#motion-switch').setAttribute('aria-checked', String(p.reduced_motion === true));
    root.querySelector('#motion-help').textContent = systemReduced.matches
      ? 'Votre appareil demande déjà moins d\'animations : elles restent coupées, quel que soit ce réglage.'
      : 'Coupe l\'ouverture animée, les compteurs et les transitions entre écrans.';
    const d = root.querySelector('#sync-date');
    const s = state || {};
    if (s.synced_at) {
      d.textContent = `Le ${CapUI.fmtStamp(s.synced_at)}${s.stale ? ' · peut-être pas à jour' : ''}`;
      d.classList.toggle('is-stale', !!s.stale);
    } else {
      d.textContent = s.status === 'loading' ? 'Chargement…' : s.status === 'unavailable' ? 'Données indisponibles pour l\'instant'
        : s.status === 'incomplete' ? `${CapUI.INCOMPLETE}${s.meta && s.meta.generated_at ? ` (commencée le ${CapUI.fmtStamp(s.meta.generated_at)})` : ''}.`
          : 'Pas encore de synchronisation : ouvrez une session career-ops.';
      d.classList.remove('is-stale');
    }
  }

  function save(root, partial) {
    if (!globalThis.CapApp) return;
    CapApp.setPrefs(partial).catch(() => {
      CapUI.toast(FAIL, 'error');
      if (last && last.root === root && root.isConnected) sync(root, last.state);
    });
    sync(root, last ? last.state : {});
  }

  function bind(root) {
    if (root.__capSettings) return;
    root.__capSettings = true;
    root.addEventListener('change', (e) => {
      const r = e.target.closest('input[name=accent]');
      if (r && IDS.includes(r.value)) save(root, { accent: r.value });
    });
    root.addEventListener('click', (e) => {
      const b = e.target.closest('#goal-minus, #goal-plus, #motion-switch');
      if (!b || b.disabled) return;
      const p = CapApp.prefs();
      if (b.id === 'motion-switch') { save(root, { reduced_motion: p.reduced_motion !== true }); return; }
      const cur = Number.isInteger(p.weekly_goal) ? p.weekly_goal : 3;
      const next = Math.min(GOAL_MAX, Math.max(GOAL_MIN, cur + (b.id === 'goal-plus' ? 1 : -1)));
      if (next !== cur) save(root, { weekly_goal: next });
    });
  }

  function render(root, state) {
    last = { root, state };
    if (root.dataset.view !== 'reglages') { root.innerHTML = html(); root.dataset.view = 'reglages'; root.dataset.sig = ''; }
    bind(root);
    sync(root, state);
  }

  Screens.reglages = { render };
})();
