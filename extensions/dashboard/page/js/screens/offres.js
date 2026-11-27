/* Offres: offers to evaluate + evaluated-not-applied, sorted by score; text filter (also set from the palette); report summary panel. */
(() => {
  'use strict';
  const Screens = (globalThis.Screens = globalThis.Screens || {});
  const EMPTY = ['Aucune offre à évaluer pour l\'instant', 'Lancez un scan dans career-ops pour en trouver de nouvelles : elles apparaîtront ici, triées par note.'];
  const ui = { q: '', kind: 'all' };

  function items(snap) {
    const reports = new Map((snap.reports || []).filter((r) => r && Number.isInteger(r.num)).map((r) => [r.num, r]));
    const todo = (snap.offers || []).map((o, i) => ({
      key: `o${i}`, kind: 'todo', company: o.company || CapUI.hostOf(o.url) || 'Entreprise non précisée',
      role: o.role || 'Poste non précisé', url: o.url, score: null, report: null,
    }));
    const evaluated = (snap.apps || []).filter((a) => a.status === 'Evaluated').map((a) => ({
      key: `a${a.num}`, kind: 'evaluated', num: a.num, company: a.company, role: a.role, url: a.url,
      score: typeof a.score === 'number' ? a.score : null, report: reports.get(a.report_num) || null, date: a.date,
    }));
    return [...evaluated, ...todo].sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  }

  function card(it, i) {
    const { esc } = CapUI;
    const href = CapUI.safeHref(it.url);
    const host = CapUI.hostOf(it.url);
    const score = it.score != null ? `<span class="score-num">${esc(CapUI.fmtNum(it.score))}</span><span class="score-max">/5</span>` : '<span class="score-none">à évaluer</span>';
    const hay = CapUI.fold([it.company, it.role, host].join(' '));
    return `<li class="card glass offer rise" style="--i:${Math.min(i, 8)}" data-kind="${it.kind}" data-hay="${esc(hay)}">
      <div class="score${it.score != null && it.score >= 4 ? ' is-high' : ''}">${score}</div>
      <div class="offer-main"><p class="offer-co">${esc(it.company)}</p><p class="offer-role">${esc(it.role)}</p>
        <p class="offer-meta">${host ? esc(host) : 'Lien indisponible'}${it.date ? ` · évaluée le ${esc(CapUI.fmtDay(it.date))}` : ''}</p></div>
      <div class="offer-actions">
        ${href ? `<a class="btn btn-soft" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${CapUI.ICON.link}<span>Voir l'offre</span></a>` : ''}
        ${it.report ? `<button type="button" class="btn btn-soft" data-report="${esc(it.report.num)}">${CapUI.ICON.doc}<span>Rapport</span></button>` : ''}
      </div></li>`;
  }

  function applyFilter(root) {
    const q = CapUI.fold(ui.q.trim());
    let shown = 0;
    for (const li of root.querySelectorAll('.offer')) {
      const ok = (ui.kind === 'all' || li.dataset.kind === ui.kind) && (!q || li.dataset.hay.includes(q));
      li.hidden = !ok;
      if (ok) shown++;
    }
    const c = root.querySelector('#offer-count');
    if (c) c.textContent = CapUI.plural(shown, 'offre', 'offres');
    const none = root.querySelector('#offer-none');
    if (none) none.hidden = shown > 0;
    for (const b of root.querySelectorAll('[data-kind-filter]')) b.setAttribute('aria-pressed', String(b.dataset.kindFilter === ui.kind));
  }

  // Report summary panel (shared with Candidatures through CapUI.reportHtml).
  function reportHtml(r) {
    const { esc } = CapUI;
    const list = (arr, cls, icon) => (arr || []).map(CapUI.cleanBullet).filter(Boolean).map((s) => `<li class="${cls}">${icon}<span>${esc(s)}</span></li>`).join('');
    const href = CapUI.safeHref(r.url);
    return `<dl class="facts">
        <div><dt>Note</dt><dd>${r.score != null ? `${esc(CapUI.fmtNum(r.score))}/5` : '—'}</dd></div>
        <div><dt>Archétype</dt><dd>${esc(r.archetype || '—')}</dd></div>
        <div><dt>Légitimité</dt><dd>${esc(r.legitimacy || '—')}</dd></div></dl>
      <h3 class="sub-title">Points forts</h3><ul class="bullets">${list(r.strengths, 'good', CapUI.ICON.check) || '<li class="muted">Non renseignés</li>'}</ul>
      <h3 class="sub-title">Lacunes</h3><ul class="bullets">${list(r.gaps, 'gap', CapUI.ICON.gap) || '<li class="muted">Non renseignées</li>'}</ul>
      <p class="muted small">Résumé du rapport n° ${esc(r.num)} ; le rapport complet reste dans career-ops.</p>
      ${href ? `<p><a class="btn btn-soft" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${CapUI.ICON.link}<span>Voir l'offre</span></a></p>` : ''}`;
  }
  CapUI.reportHtml = reportHtml;

  function openReport(snap, num) {
    const r = (snap.reports || []).find((x) => x && x.num === num);
    if (!r) return;
    const app = (snap.apps || []).find((a) => a.report_num === num);
    CapUI.dialog({ id: 'report-panel', title: app ? `Rapport · ${app.company}` : `Rapport n° ${num}`, html: reportHtml(r) });
  }

  let lastSnap = null;
  function render(root, state) {
    if (!CapUI.gate(root, state, EMPTY)) return;
    const snap = state.snapshot;
    lastSnap = snap;
    const list = items(snap);
    CapUI.rebuild(root, 'offres', String(snap.generation), () => {
      const { esc } = CapUI;
      if (!list.length) { root.innerHTML = CapUI.emptyBlock(...EMPTY); return; }
      root.innerHTML = `<div class="toolbar">
          <label class="search"><span class="sr-only">Filtrer les offres</span>
            <svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="m16 16 4 4"/></svg>
            <input id="offer-filter" type="search" placeholder="Entreprise, poste, site…" autocomplete="off" value="${esc(ui.q)}"></label>
          <div class="seg" role="group" aria-label="Type d'offre">
            <button type="button" data-kind-filter="all">Toutes</button><button type="button" data-kind-filter="evaluated">Évaluées</button><button type="button" data-kind-filter="todo">À évaluer</button></div>
          <p class="count" id="offer-count" aria-live="polite"></p></div>
        <ul class="offers">${list.map(card).join('')}</ul>
        <p class="empty-inline" id="offer-none" hidden>Aucune offre ne correspond à ce filtre.</p>`;
    });
    if (CapUI.intent.offerQuery != null) { // from the ⌘K palette: show that offer
      ui.q = String(CapUI.intent.offerQuery);
      ui.kind = 'all';
      delete CapUI.intent.offerQuery;
      const f = root.querySelector('#offer-filter');
      if (f) f.value = ui.q;
    }
    applyFilter(root);
    if (!root.__capOffres) {
      root.__capOffres = true;
      root.addEventListener('input', (e) => { if (e.target.id === 'offer-filter') { ui.q = e.target.value; applyFilter(root); } });
      root.addEventListener('click', (e) => {
        const k = e.target.closest('[data-kind-filter]');
        if (k) { ui.kind = k.dataset.kindFilter; applyFilter(root); return; }
        const r = e.target.closest('[data-report]');
        if (r && lastSnap) openReport(lastSnap, parseInt(r.dataset.report, 10));
      });
    }
  }

  Screens.offres = { render };
})();
