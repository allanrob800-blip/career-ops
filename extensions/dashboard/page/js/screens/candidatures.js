/*
 * Candidatures: status filters, table (stacked cards on phones), columns by status above 1100px,
 * detail sheet with « Changer le statut » / « Ajouter une note » (written as requests, applied by Claude),
 * « Voir le CV » / « Voir la lettre »: the PDF's pages as images, shown in the same sheet (« ← Retour » or Escape
 * goes back), and the « Espace CV » of a prepared dossier: strategy, downloads, message, why, retouche, refusal.
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

  const REQ_LABEL = { note: 'note', why: 'pourquoi cette entreprise', retouche: 'retouche' };
  function pendingHtml(list) {
    const { esc } = CapUI;
    return list.map((p) => {
      const what = p.type === 'status' ? `statut → ${CapUI.statusLabel(p.to_status)}` : REQ_LABEL[p.type] || 'note';
      if (p.state === 'rejected') return `<span class="badge badge-warn" title="${esc(p.reason || '')}">Demande refusée (${esc(what)})${p.reason ? ` : ${esc(p.reason)}` : ''}</span>`;
      return `<span class="badge badge-pending"><i class="pulse" aria-hidden="true"></i>En attente de synchronisation <span class="badge-sub">(${esc(what)})</span></span>`;
    }).join('');
  }

  // The CV is shown as its page images (/_blob/<asset id>, PNG): the frame refuses PDF links, downloads, <object>,
  // <embed> and window.open, so cv_url (the PDF) is never linked. Only exact /_blob/<id> strings, at most 6 pages.
  const CV_MAX_PAGES = 6;
  const blobPages = (list) => (Array.isArray(list) ? list.map((v) => CapUI.blobHref(v)).filter(Boolean).slice(0, CV_MAX_PAGES) : []);
  const cvPages = (a) => blobPages(a.cv_pages);
  const CV_STALE = '<p class="cv-stale small">Ce CV a été modifié depuis son envoi sur le tableau de bord.</p>';
  const LETTER_STALE = '<p class="cv-stale small">Cette lettre a été modifiée depuis son envoi sur le tableau de bord.</p>';
  const CV_MISSING = 'Page indisponible. Elle sera rétablie à la prochaine synchronisation.';
  const NO_PDF = '<p class="muted small cv-note">Le PDF n\'est pas téléchargeable depuis le tableau de bord : demandez-le à Claude dans la session.</p>';
  const cvMark = (a) => (cvPages(a).length ? '<span class="cv-mark" title="CV disponible">CV</span>' : '');

  // ---- the prepared dossier (apps[i].dossier, untrusted): only the expected shapes are kept ----
  const DOSSIER_STATES = { pret: ['Prête', 'badge-good'], a_verifier: ['À vérifier', 'badge-warn'], a_refaire: ['Retouche demandée', 'badge-pending'] };
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const txt = (v) => (typeof v === 'string' ? v.trim() : '');
  const texts = (v) => (Array.isArray(v) ? v.map(txt).filter(Boolean) : []);
  const pairs = (v, k1, k2) => (Array.isArray(v) ? v.filter(isObj).map((x) => [txt(x[k1]), txt(x[k2])]).filter(([x]) => x) : []);
  function dossierOf(a) {
    const d = a && a.dossier;
    if (!isObj(d) || !Object.hasOwn(DOSSIER_STATES, d.state)) return null;
    const s = isObj(d.strategy) ? d.strategy : null;
    return {
      state: d.state,
      letter_state: d.letter_state, has_why: d.has_why === true,
      message: txt(d.message),
      check_reasons: d.state === 'a_verifier' ? texts(d.check_reasons) : [],
      strategy: s && {
        titre_cv: txt(s.titre_cv), angle: txt(s.angle), lettre_angle: txt(s.lettre_angle),
        preuves: pairs(s.preuves, 'texte', 'source'), repris: texts(s.mots_cles_repris),
        ecartes: pairs(s.mots_cles_ecartes, 'mot', 'raison'), ecarts: pairs(s.ecarts, 'exigence', 'traitement'),
      },
      letter_url: CapUI.blobHref(d.letter_url), letter_pages: blobPages(d.letter_pages), letter_stale: d.letter_stale === true,
    };
  }
  const dossierBadge = (d) => (d ? `<span class="badge ${DOSSIER_STATES[d.state][1]} dossier-badge">${CapUI.esc(DOSSIER_STATES[d.state][0])}</span>` : '');

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
      <td data-l="Entreprise" class="cell-co"><button type="button" class="row-open">${esc(a.company)}</button>${cvMark(a)}${dossierBadge(dossierOf(a))}<div class="row-pending">${pendingHtml(pendingFor(state, a.num))}</div></td>
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
      ${l.map((a) => `<article class="card glass kcard" data-num="${esc(a.num)}"><button type="button" class="row-open">${esc(a.company)}</button>${cvMark(a)}${dossierBadge(dossierOf(a))}
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

  const cvOpenBtn = () => `<button type="button" class="btn btn-soft cv-open">${CapUI.ICON.doc}<span>Voir le CV</span></button>`;

  function strategyHtml(s) {
    const { esc } = CapUI;
    const list = (title, items) => (items.length ? `<h4 class="strat-h">${esc(title)}</h4><ul class="strat-list">${items.join('')}</ul>` : '');
    const pair = ([x, y], sep) => `<li><strong>${esc(x)}</strong>${y ? `${sep}${esc(y)}` : ''}</li>`;
    return `<div class="strat">
      ${s.titre_cv ? `<p class="strat-title">${esc(s.titre_cv)}</p>` : ''}
      ${s.angle ? `<p class="strat-angle">${esc(s.angle)}</p>` : ''}
      ${list('Preuves', s.preuves.map(([t, src]) => `<li>${esc(t)}${src ? `<span class="strat-src">Source : ${esc(src)}</span>` : ''}</li>`))}
      ${s.repris.length ? `<h4 class="strat-h">Mots-clés repris</h4><ul class="kw">${s.repris.map((k) => `<li class="chip">${esc(k)}</li>`).join('')}</ul>` : ''}
      ${list('Mots-clés écartés', s.ecartes.map((p) => pair(p, ' : ')))}
      ${list('Écarts', s.ecarts.map((p) => pair(p, ' : ')))}</div>`;
  }

  // The « Espace CV » of a prepared dossier, in the order: strategy, viewers, downloads, message, why, retouche, refusal.
  function cvSpaceHtml(a, d, state) {
    const { esc } = CapUI;
    const pend = pendingFor(state, a.num).filter((p) => p.state === 'pending');
    const viewers = [cvPages(a).length ? cvOpenBtn() : '', d.letter_pages.length ? `<button type="button" class="btn btn-soft letter-open">${CapUI.ICON.doc}<span>Voir la lettre</span></button>` : ''].join('');
    const cvUrl = CapUI.blobHref(a.cv_url);
    const dls = [
      cvUrl ? `<button type="button" class="btn btn-soft dl-btn" data-dl="cv">${CapUI.ICON.download}<span>Télécharger le CV (PDF)</span></button>` : '',
      d.letter_url ? `<button type="button" class="btn btn-soft dl-btn" data-dl="letter">${CapUI.ICON.download}<span>Télécharger la lettre (PDF)</span></button>` : '',
    ].join('');
    const askWhy = d.letter_state === 'a_completer' && !d.has_why;
    const WHY_DONE = '<p class="req-done" role="status">Envoyé. Claude écrira la lettre à la prochaine session.</p>';
    return `<section class="cv-space" aria-labelledby="cv-space-title">
      <div class="cv-space-head"><h3 class="sub-title" id="cv-space-title">Espace CV</h3>${dossierBadge(d)}</div>
      ${d.check_reasons.length ? `<ul class="check-reasons small">${d.check_reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>` : ''}
      ${d.strategy ? strategyHtml(d.strategy) : ''}
      ${viewers ? `<div class="detail-links cv-viewers">${viewers}</div>` : ''}
      ${dls ? `<div class="detail-links cv-downloads" hidden>${dls}</div>` : ''}
      ${d.message ? `<div class="msg-box"><h4 class="strat-h">Message au recruteur</h4><p class="msg-text">${esc(d.message)}</p>
        <div class="req-row"><button type="button" class="btn btn-soft msg-copy">${CapUI.ICON.copy}<span>Copier</span></button></div>
        <p class="req-err" id="err-copy" role="alert" hidden></p></div>` : ''}
      ${askWhy ? (pend.some((p) => p.type === 'why') ? `<div class="req">${WHY_DONE}</div>` : `<form class="req" id="form-why" novalidate>
        <label for="detail-why">Pourquoi cette entreprise ?</label>
        <textarea id="detail-why" rows="3" maxlength="500" placeholder="Ce qui vous attire chez elle, en une ou deux phrases"></textarea>
        <div class="req-row"><span class="muted small">Claude s'en sert pour écrire la lettre.</span>
          <button type="submit" class="btn btn-acc" id="why-send">Envoyer</button></div>
        <p class="req-err" id="err-why" role="alert" hidden></p></form>`) : ''}
      <form class="req" id="form-retouche" novalidate>
        <label for="detail-retouche">Demander une retouche</label>
        <textarea id="detail-retouche" rows="3" maxlength="500" placeholder="Ex. : mettre le projet le plus récent en avant"></textarea>
        <div class="req-row"><span class="muted small">500 caractères au plus</span>
          <button type="submit" class="btn btn-acc" id="retouche-send">Demander la retouche</button></div>
        <p class="req-err" id="err-retouche" role="alert" hidden></p></form>
      <div class="refuse" id="refuse">
        <div class="req-row refuse-ask"><button type="button" class="btn btn-soft" id="refuse-btn">Refuser cette offre</button></div>
        <div class="req-row refuse-confirm" hidden><span class="small">La candidature passera en « ${esc(CapUI.statusLabel('Discarded'))} ».</span>
          <span class="refuse-actions"><button type="button" class="btn btn-acc" id="refuse-confirm">Confirmer le refus</button>
          <button type="button" class="btn btn-soft" id="refuse-cancel">Annuler</button></span></div>
        <p class="req-err" id="err-refuse" role="alert" hidden></p></div></section>`;
  }

  function detailHtml(a, snap, state) {
    const { esc } = CapUI;
    const href = CapUI.safeHref(a.url);
    const cv = cvPages(a).length > 0;
    const d = dossierOf(a);
    const links = [
      href ? `<a class="btn btn-soft" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${CapUI.ICON.link}<span>Voir l'offre</span></a>` : '',
      cv && !d ? cvOpenBtn() : '', // with a dossier, « Voir le CV » sits in the Espace CV
    ].join('');
    const report = (snap.reports || []).find((r) => r && r.num === a.report_num && a.report_num != null);
    const urg = { overdue: 'en retard', urgent: 'urgente', waiting: 'à venir', cold: 'sans réponse' }[a.followup_urgency] || '';
    const opts = CapUI.STATUSES.map((s) => `<option value="${s}"${s === a.status ? ' selected' : ''}>${esc(CapUI.statusLabel(s))} (${s})</option>`).join('');
    return `<div class="detail-main"><p class="detail-role">${esc(a.role)}</p>
      <div class="detail-chips">${statusChip(a.status)}${a.score != null ? `<span class="status s-base">${esc(CapUI.fmtNum(a.score))}/5</span>` : ''}</div>
      <dl class="facts">
        <div><dt>Envoyée le</dt><dd>${esc(CapUI.fmtDay(a.applied_on))}</dd></div>
        <div><dt>Prochaine relance</dt><dd>${esc(CapUI.fmtDay(a.next_followup))}${urg && CapUI.isoDay(a.next_followup) ? ` · ${esc(urg)}` : ''}</dd></div>
        <div><dt>Clôture de l'offre</dt><dd>${esc(CapUI.fmtDay(a.closes_at))}</dd></div></dl>
      ${links ? `<div class="detail-links">${links}</div>` : ''}
      ${cv && a.cv_stale === true ? CV_STALE : ''}
      ${d ? cvSpaceHtml(a, d, state) : ''}
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
      <p class="muted small">Claude applique ces demandes à la prochaine session career-ops.</p></div>`;
  }

  // The two page viewers of the sheet: the CV, and the letter of a prepared dossier.
  const VIEWS = {
    cv: { label: 'CV', opener: '.cv-open', pages: (a) => cvPages(a), stale: (a) => (a.cv_stale === true ? CV_STALE : '') },
    letter: { label: 'Lettre', opener: '.letter-open', pages: (a) => (dossierOf(a) ? dossierOf(a).letter_pages : []), stale: (a) => (dossierOf(a) && dossierOf(a).letter_stale ? LETTER_STALE : '') },
  };

  // A viewer, inside the detail sheet: one image per page, as wide as the sheet (A4 aspect reserved before load).
  // The « not downloadable » note only where this host cannot save files.
  function viewHtml(kind, a, pages) {
    const { esc } = CapUI;
    const v = VIEWS[kind];
    const n = pages.length;
    return `<div class="cv-view" data-view="${kind}">
      <div class="cv-bar"><button type="button" class="btn btn-soft cv-back"><span><span aria-hidden="true">← </span>Retour</span></button>
        <span class="muted small">${esc(CapUI.plural(n, 'page', 'pages'))}</span></div>
      ${v.stale(a)}
      <div class="cv-pages">${pages.map((src, i) => `<figure class="cv-page"><img src="${esc(src)}" alt="${v.label} — page ${i + 1} sur ${n}" width="1240" height="1754" loading="lazy" decoding="async"></figure>`).join('')}</div>
      ${CapUI.canDownload() === true ? '' : NO_PDF}</div>`;
  }

  function refreshDetail(state) {
    if (!detail || !detail.dlg.el.isConnected) { detail = null; return; }
    const box = detail.dlg.el.querySelector('#detail-pending');
    const html = pendingHtml(pendingFor(state, detail.num));
    if (box.innerHTML !== html) box.innerHTML = html;
  }

  // The Espace CV's controls: downloads (only where the host can save files), copy, why, retouche, two-step refusal.
  function bindCvSpace(dlg, a, num, showErr) {
    const space = dlg.el.querySelector('.cv-space');
    if (!space) return;
    const d = dossierOf(a);
    const dlRow = space.querySelector('.cv-downloads');
    if (dlRow) {
      CapUI.downloads().then((ns) => { if (!ns) dlRow.remove(); else dlRow.hidden = false; });
      const company = String(a.company ?? '');
      const target = { cv: () => [a.cv_url, CapUI.pdfName('CV', company)], letter: () => [d.letter_url, CapUI.pdfName('Lettre', company)] };
      dlRow.addEventListener('click', async (e) => {
        const btn = e.target.closest('[data-dl]');
        if (!btn) return;
        const res = await CapUI.downloadAsset(...target[btn.dataset.dl]());
        if (res === 'unavailable') dlRow.remove();
      });
    }

    const copy = space.querySelector('.msg-copy');
    if (copy) {
      copy.addEventListener('click', async () => {
        showErr('#err-copy', '');
        try {
          if (!navigator.clipboard || typeof navigator.clipboard.writeText !== 'function') throw new Error('no clipboard');
          await navigator.clipboard.writeText(d.message);
          CapUI.toast('Message copié.');
        } catch {
          showErr('#err-copy', 'Copie impossible : sélectionnez le texte.');
          const sel = getSelection(), range = document.createRange();
          range.selectNodeContents(space.querySelector('.msg-text'));
          sel.removeAllRanges(); sel.addRange(range);
        }
      });
    }

    // why / retouche: one line of text each; once written, the form gives way to « Envoyé. … »
    const textForm = (form, field, err, send, done) => {
      if (!form) return;
      form.addEventListener('submit', async (e) => {
        e.preventDefault();
        showErr(err, '');
        try {
          await send(num, form.querySelector(field).value);
          form.innerHTML = `<p class="req-done" role="status" tabindex="-1">${CapUI.esc(done)}</p>`;
          form.querySelector('.req-done').focus();
        } catch (ex) { showErr(err, (ex && ex.message) || 'La demande n\'a pas pu être enregistrée.'); }
      });
    };
    textForm(space.querySelector('#form-why'), '#detail-why', '#err-why', CapData.requestWhy, 'Envoyé. Claude écrira la lettre à la prochaine session.');
    textForm(space.querySelector('#form-retouche'), '#detail-retouche', '#err-retouche', CapData.requestRetouche, 'Envoyé. Claude fera la retouche à la prochaine session.');

    // « Refuser cette offre »: a first click asks for confirmation in place; « Confirmer le refus » asks for Discarded.
    const refuse = space.querySelector('#refuse');
    const ask = refuse.querySelector('.refuse-ask'), confirmRow = refuse.querySelector('.refuse-confirm');
    const step = (confirming) => { ask.hidden = confirming; confirmRow.hidden = !confirming; };
    refuse.querySelector('#refuse-btn').addEventListener('click', () => { showErr('#err-refuse', ''); step(true); refuse.querySelector('#refuse-cancel').focus(); });
    refuse.querySelector('#refuse-cancel').addEventListener('click', () => { step(false); refuse.querySelector('#refuse-btn').focus(); });
    refuse.querySelector('#refuse-confirm').addEventListener('click', async () => {
      const expected = (CapData.expectedStatus && CapData.expectedStatus(num)) || a.status;
      if (expected === 'Discarded') { step(false); showErr('#err-refuse', a.status === 'Discarded' ? 'C\'est déjà le statut actuel.' : 'Ce statut est déjà demandé.'); return; }
      try {
        await CapData.requestStatus(num, 'Discarded');
        refuse.innerHTML = '<p class="req-done" role="status" tabindex="-1">Refus demandé : Claude l\'appliquera à la prochaine session.</p>';
        refuse.querySelector('.req-done').focus();
      } catch (err) { step(false); showErr('#err-refuse', (err && err.message) || 'La demande n\'a pas pu être enregistrée.'); }
    });
  }

  function openDetail(num) {
    const st = current && current.state;
    const a = st && st.snapshot && (st.snapshot.apps || []).find((x) => x.num === num);
    if (!a) return;
    const title = String(a.company ?? '');
    const dlg = CapUI.dialog({ id: 'app-detail', title, html: detailHtml(a, st.snapshot, st), onClose: () => { detail = null; }, onEscape: () => hideView() });
    detail = { num, dlg };
    refreshDetail(st);
    // « Voir le CV » / « Voir la lettre » swap the sheet's content for a viewer; the detail stays in the DOM (hidden),
    // so a note being typed survives, and « ← Retour » / Escape restore it with focus on the button that opened it.
    // The dialog's own focus trap skips [hidden] content, and × still closes the whole sheet.
    const main = dlg.el.querySelector('.detail-main');
    const panel = dlg.el.querySelector('.dlg-panel');
    const titleEl = dlg.el.querySelector('.dlg-title');
    const views = {};
    let shown = null, scrollBack = 0;
    function showView(kind) {
      const pages = VIEWS[kind].pages(a);
      if (!pages.length) return;
      let view = views[kind];
      if (!view) {
        dlg.body.insertAdjacentHTML('beforeend', viewHtml(kind, a, pages));
        view = views[kind] = dlg.body.querySelector(`.cv-view[data-view="${kind}"]`);
        view.querySelector('.cv-back').addEventListener('click', hideView);
        // error does not bubble: listen in the capture phase; the page keeps its place in the stack, as a message
        view.addEventListener('error', (e) => {
          const img = e.target;
          if (!(img instanceof HTMLImageElement) || !img.closest('.cv-page')) return;
          const msg = document.createElement('p');
          msg.className = 'cv-missing';
          msg.textContent = CV_MISSING;
          img.closest('.cv-page').classList.add('is-missing');
          img.replaceWith(msg);
        }, true);
      }
      scrollBack = panel.scrollTop;
      main.hidden = true;
      view.hidden = false;
      shown = kind;
      dlg.el.classList.add('is-cv');
      titleEl.textContent = `${VIEWS[kind].label} — ${title}`;
      panel.scrollTop = 0;
      view.querySelector('.cv-back').focus();
    }
    function hideView() {
      const view = shown && views[shown];
      if (!view || view.hidden) return false;
      view.hidden = true;
      main.hidden = false;
      dlg.el.classList.remove('is-cv');
      titleEl.textContent = title;
      panel.scrollTop = scrollBack;
      const btn = main.querySelector(VIEWS[shown].opener);
      shown = null;
      if (btn) btn.focus();
      return true;
    }
    for (const kind of Object.keys(VIEWS)) {
      const btn = main.querySelector(VIEWS[kind].opener);
      if (btn) btn.addEventListener('click', () => showView(kind));
    }
    const showErr = (id, msg) => { const e = dlg.el.querySelector(id); e.textContent = msg; e.hidden = !msg; };
    bindCvSpace(dlg, a, num, showErr);
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
