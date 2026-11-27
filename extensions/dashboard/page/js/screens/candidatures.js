/*
 * Candidatures: status filters, table (stacked cards on phones), columns by status above 1100px,
 * detail sheet with « Changer le statut » / « Ajouter une note » (written as requests, applied by Claude).
 */
(() => {
  'use strict';
  const Screens = (globalThis.Screens = globalThis.Screens || {});
  const EMPTY = ['Aucune candidature suivie pour l\'instant', 'Évaluez une offre dans career-ops : elle apparaîtra ici avec son statut et ses relances.'];
  const ui = { filter: 'all', layout: 'table' };
  let current = null; // { root, state }
  let detail = null; // { num, dlg }
  const wide = globalThis.matchMedia ? matchMedia('(min-width: 1100px)') : { matches: false, addEventListener() {} };
  const layout = () => (ui.layout === 'columns' && wide.matches ? 'columns' : 'table');
  wide.addEventListener('change', () => { if (current && current.root.isConnected) { current.root.dataset.sig = ''; render(current.root, current.state); } });

  const pendingFor = (state, num) => state.pending.filter((p) => p.ref === num && (p.state === 'pending' || p.state === 'rejected'));

  function pendingHtml(list) {
    const { esc } = CapUI;
    return list.map((p) => {
      const what = p.type === 'status' ? `statut → ${CapUI.statusLabel(p.to_status)}` : 'note';
      if (p.state === 'rejected') return `<span class="badge badge-warn" title="${esc(p.reason || '')}">Demande refusée (${esc(what)})${p.reason ? ` : ${esc(p.reason)}` : ''}</span>`;
      return `<span class="badge badge-pending"><i class="pulse" aria-hidden="true"></i>En attente de synchronisation <span class="badge-sub">(${esc(what)})</span></span>`;
    }).join('');
  }

  const statusChip = (s) => `<span class="status s-${CapUI.tone(s)}">${CapUI.esc(CapUI.statusLabel(s))}</span>`;

  function followHtml(a) {
    if (!CapUI.isoDay(a.next_followup)) return '—';
    const u = a.followup_urgency;
    const cls = u === 'overdue' ? ' late' : u === 'urgent' ? ' soon' : '';
    return `<span class="nowrap${cls}">${CapUI.esc(CapUI.fmtDay(a.next_followup))}</span>`;
  }

  function rowHtml(a, state) {
    const { esc } = CapUI;
    return `<tr data-num="${esc(a.num)}">
      <td data-l="N°" class="num">${esc(a.num)}</td>
      <td data-l="Entreprise" class="cell-co"><button type="button" class="row-open">${esc(a.company)}</button><div class="row-pending">${pendingHtml(pendingFor(state, a.num))}</div></td>
      <td data-l="Poste">${esc(a.role)}</td>
      <td data-l="Note" class="num">${a.score != null ? esc(CapUI.fmtNum(a.score)) : '—'}</td>
      <td data-l="Statut">${statusChip(a.status)}</td>
      <td data-l="Envoyée le" class="nowrap">${esc(CapUI.fmtDay(a.applied_on))}</td>
      <td data-l="Relance">${followHtml(a)}</td></tr>`;
  }

  function kanbanHtml(list, state) {
    const { esc } = CapUI;
    const cols = CapUI.STATUSES.map((s) => [s, list.filter((a) => a.status === s)]).filter(([, l]) => l.length);
    return `<div class="kanban scroll">${cols.map(([s, l]) => `<section class="kcol" aria-label="${esc(CapUI.statusLabel(s))}">
      <h3 class="kcol-head">${statusChip(s)}<span class="count">${esc(l.length)}</span></h3>
      ${l.map((a) => `<article class="card glass kcard" data-num="${esc(a.num)}"><button type="button" class="row-open">${esc(a.company)}</button>
        <p class="kcard-role">${esc(a.role)}</p><p class="kcard-meta">${a.score != null ? `${esc(CapUI.fmtNum(a.score))}/5` : ''}${CapUI.isoDay(a.next_followup) ? ` · relance ${esc(CapUI.fmtDay(a.next_followup))}` : ''}</p>
        <div class="row-pending">${pendingHtml(pendingFor(state, a.num))}</div></article>`).join('')}</section>`).join('')}</div>`;
  }

  function listHtml(apps, state) {
    const list = ui.filter === 'all' ? apps : apps.filter((a) => a.status === ui.filter);
    if (!list.length) return '<p class="empty-inline">Aucune candidature avec ce statut.</p>';
    if (layout() === 'columns') return kanbanHtml(list, state);
    return `<table class="stack apps"><caption class="sr-only">Candidatures</caption><thead><tr>
      <th scope="col" class="num">N°</th><th scope="col">Entreprise</th><th scope="col">Poste</th><th scope="col" class="num">Note</th>
      <th scope="col">Statut</th><th scope="col">Envoyée le</th><th scope="col">Relance</th></tr></thead>
      <tbody>${list.map((a) => rowHtml(a, state)).join('')}</tbody></table>`;
  }

  function sorted(snap) {
    return [...(snap.apps || [])].sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')) || b.num - a.num);
  }

  // ---- detail sheet ----
  function historyHtml(a) {
    const ev = [[a.date, 'Évaluée'], [a.applied_on, 'Candidature envoyée'], [a.last_change, `Dernier changement · ${CapUI.statusLabel(a.status)}`]]
      .filter(([d]) => CapUI.isoDay(d)).sort(([x], [y]) => x.localeCompare(y));
    const seen = new Set();
    return ev.filter(([d, t]) => { const k = d + t; if (seen.has(k)) return false; seen.add(k); return true; })
      .map(([d, t]) => `<li><span class="h-day">${CapUI.esc(CapUI.fmtDay(d))}</span><span>${CapUI.esc(t)}</span></li>`).join('');
  }

  function detailHtml(a, snap) {
    const { esc } = CapUI;
    const href = CapUI.safeHref(a.url);
    const report = (snap.reports || []).find((r) => r && r.num === a.report_num && a.report_num != null);
    const urg = { overdue: 'en retard', urgent: 'urgente', waiting: 'à venir', cold: 'sans réponse' }[a.followup_urgency] || '';
    const opts = CapUI.STATUSES.map((s) => `<option value="${s}"${s === a.status ? ' selected' : ''}>${esc(CapUI.statusLabel(s))} (${s})</option>`).join('');
    return `<p class="detail-role">${esc(a.role)}</p>
      <div class="detail-chips">${statusChip(a.status)}${a.score != null ? `<span class="status s-base">${esc(CapUI.fmtNum(a.score))}/5</span>` : ''}</div>
      <dl class="facts">
        <div><dt>Envoyée le</dt><dd>${esc(CapUI.fmtDay(a.applied_on))}</dd></div>
        <div><dt>Prochaine relance</dt><dd>${esc(CapUI.fmtDay(a.next_followup))}${urg && CapUI.isoDay(a.next_followup) ? ` · ${esc(urg)}` : ''}</dd></div>
        <div><dt>Clôture de l'offre</dt><dd>${esc(CapUI.fmtDay(a.closes_at))}</dd></div></dl>
      ${href ? `<p><a class="btn btn-soft" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${CapUI.ICON.link}<span>Voir l'offre</span></a></p>` : ''}
      <h3 class="sub-title">Historique</h3><ol class="history">${historyHtml(a) || '<li class="muted">Pas encore d\'historique.</li>'}</ol>
      ${report && CapUI.reportHtml ? `<details class="report-box"><summary>Résumé du rapport</summary>${CapUI.reportHtml(report)}</details>` : ''}
      <div id="detail-pending" class="detail-pending"></div>
      <form class="req" id="form-status" novalidate>
        <label for="detail-status">Changer le statut</label>
        <div class="req-row"><select id="detail-status">${opts}</select>
          <button type="submit" class="btn btn-acc" id="detail-status-send">Demander</button></div>
        <p class="req-err" id="err-status" role="alert" hidden></p></form>
      <form class="req" id="form-note" novalidate>
        <label for="detail-note">Ajouter une note</label>
        <textarea id="detail-note" rows="3" maxlength="500" placeholder="Ex. : relancer après le salon"></textarea>
        <div class="req-row"><span class="muted small" id="note-left">500 caractères au plus</span>
          <button type="submit" class="btn btn-acc" id="detail-note-send">Ajouter la note</button></div>
        <p class="req-err" id="err-note" role="alert" hidden></p></form>
      <p class="muted small">Claude applique ces demandes à la prochaine session career-ops.</p>`;
  }

  function refreshDetail(state) {
    if (!detail || !detail.dlg.el.isConnected) { detail = null; return; }
    const box = detail.dlg.el.querySelector('#detail-pending');
    const html = pendingHtml(pendingFor(state, detail.num));
    if (box.innerHTML !== html) box.innerHTML = html;
  }

  function openDetail(num) {
    const st = current && current.state;
    const a = st && st.snapshot && (st.snapshot.apps || []).find((x) => x.num === num);
    if (!a) return;
    const dlg = CapUI.dialog({ id: 'app-detail', title: String(a.company ?? ''), html: detailHtml(a, st.snapshot), onClose: () => { detail = null; } });
    detail = { num, dlg };
    refreshDetail(st);
    const showErr = (id, msg) => { const e = dlg.el.querySelector(id); e.textContent = msg; e.hidden = !msg; };
    dlg.el.querySelector('#form-status').addEventListener('submit', async (e) => {
      e.preventDefault();
      const to = dlg.el.querySelector('#detail-status').value;
      const expected = (CapData.expectedStatus && CapData.expectedStatus(num)) || a.status; // a pending request counts
      if (to === expected) { showErr('#err-status', to === a.status ? 'C\'est déjà le statut actuel.' : 'Ce statut est déjà demandé.'); return; }
      showErr('#err-status', '');
      try { await CapData.requestStatus(num, to); CapUI.toast('Demande enregistrée : Claude l\'appliquera à la prochaine session.'); }
      catch (err) { showErr('#err-status', (err && err.message) || 'La demande n\'a pas pu être enregistrée.'); }
    });
    const ta = dlg.el.querySelector('#detail-note');
    const left = dlg.el.querySelector('#note-left');
    const LEFT0 = left.textContent;
    ta.addEventListener('input', () => { left.textContent = `${500 - ta.value.length} caractères restants`; });
    dlg.el.querySelector('#form-note').addEventListener('submit', async (e) => {
      e.preventDefault();
      showErr('#err-note', '');
      try { await CapData.requestNote(num, ta.value); ta.value = ''; left.textContent = LEFT0; CapUI.toast('Note enregistrée : Claude l\'ajoutera à la prochaine session.'); }
      catch (err) { showErr('#err-note', (err && err.message) || 'La note n\'a pas pu être enregistrée.'); }
    });
  }

  function bind(root) {
    if (root.__capCand) return;
    root.__capCand = true;
    root.addEventListener('click', (e) => {
      const f = e.target.closest('[data-filter]');
      if (f) { ui.filter = f.dataset.filter; root.dataset.sig = ''; render(root, current.state); return; }
      const l = e.target.closest('[data-layout]');
      if (l) { ui.layout = l.dataset.layout; root.dataset.sig = ''; render(root, current.state); return; }
      const o = e.target.closest('.row-open');
      if (o) { const n = parseInt(o.closest('[data-num]').dataset.num, 10); if (Number.isInteger(n)) openDetail(n); }
    });
  }

  function render(root, state) {
    current = { root, state };
    bind(root);
    if (!CapUI.gate(root, state, EMPTY)) return;
    const snap = state.snapshot;
    const apps = sorted(snap);
    if (ui.filter !== 'all' && !apps.some((a) => a.status === ui.filter)) ui.filter = 'all';
    const sig = JSON.stringify([snap.generation, state.pending.map((p) => p.id + p.state), ui.filter, layout()]);
    CapUI.rebuild(root, 'candidatures', sig, () => {
      const { esc } = CapUI;
      if (!apps.length) { root.innerHTML = CapUI.emptyBlock(...EMPTY); return; }
      const counts = CapUI.STATUSES.map((s) => [s, apps.filter((a) => a.status === s).length]).filter(([, n]) => n);
      const chip = (key, label, n) => `<button type="button" class="fchip" data-filter="${esc(key)}" aria-pressed="${ui.filter === key}">${esc(label)}<span class="fchip-n">${esc(n)}</span></button>`;
      root.innerHTML = `<div class="toolbar">
          <div class="chips scroll" role="group" aria-label="Filtrer par statut">${chip('all', 'Toutes', apps.length)}${counts.map(([s, n]) => chip(s, CapUI.statusLabel(s), n)).join('')}</div>
          <div class="seg layout-seg" role="group" aria-label="Affichage">
            <button type="button" data-layout="table" aria-pressed="${ui.layout === 'table'}">Tableau</button><button type="button" data-layout="columns" aria-pressed="${ui.layout === 'columns'}">Colonnes</button></div></div>
        <div id="app-list" class="app-list layout-${layout()}">${listHtml(apps, state)}</div>`;
    });
    refreshDetail(state);
    if (CapUI.intent.openApp != null) {
      const n = CapUI.intent.openApp;
      delete CapUI.intent.openApp;
      openDetail(n);
    }
  }

  Screens.candidatures = { render };
})();
