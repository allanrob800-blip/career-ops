/* Messages: job-search e-mails from Outlook, one thread per company, read-only. Classic script. */
(() => {
  'use strict';
  const Screens = (globalThis.Screens = globalThis.Screens || {});
  const EMPTY = ['Rien à afficher pour l\'instant', 'La première synchronisation n\'a pas encore eu lieu. Ouvrez une session career-ops : Claude enverra vos données ici.'];
  const NONE = ['Aucun message lié à votre recherche', 'Les e-mails des 30 derniers jours venant d\'une entreprise suivie, ou parlant de candidature ou d\'entretien, apparaîtront ici.'];
  const OTHER = 'Non rattachés';
  const sending = new Set(); // ids whose « traité » write is in flight (or done, until the listener confirms it)

  // Threads in order of their most recent message (the list arrives newest first); unattached messages last.
  function threads(messages) {
    const map = new Map();
    for (const m of messages) {
      const key = m.company === null ? null : String(m.company);
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(m);
    }
    const out = [...map.entries()].filter(([k]) => k !== null).map(([name, list]) => ({ name, list, other: false }));
    if (map.has(null)) out.push({ name: OTHER, list: map.get(null), other: true });
    return out;
  }

  function bubble(m) {
    const { esc } = CapUI;
    const href = CapUI.safeHref(m.webLink);
    const who = m.senderName || m.sender || 'Expéditeur inconnu';
    const addr = m.senderName && m.sender ? `<span class="bubble-addr">${esc(m.sender)}</span>` : '';
    const action = m.handled
      ? `<span class="badge badge-pending">${CapUI.ICON.check}<span>Traité</span></span>`
      : `<button type="button" class="btn btn-acc" data-handle="${esc(m.id)}"${sending.has(m.id) ? ' disabled' : ''}>Marquer comme traité</button>`;
    return `<li class="bubble${m.handled ? ' is-handled' : ''}" data-msg="${esc(m.id)}">
      <p class="bubble-from"><strong>${esc(who)}</strong>${addr}</p>
      <p class="bubble-subject">${esc(m.subject || '(sans objet)')}</p>
      ${m.summary ? `<p class="bubble-text">${esc(m.summary)}</p>` : ''}
      <div class="bubble-foot"><span class="bubble-time nowrap">${esc(CapUI.fmtStamp(m.receivedDateTime))}</span>
        <span class="bubble-actions">${href ? `<a class="btn btn-soft" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${CapUI.ICON.link}<span>Ouvrir dans Outlook</span></a>` : ''}${action}</span></div></li>`;
  }

  function thread(t, i) {
    const { esc } = CapUI;
    const initial = t.other ? CapUI.ICON.chat : esc([...t.name.trim()][0] || '?');
    return `<section class="card glass thread rise" style="--i:${Math.min(i, 8)}" data-group="${esc(t.name)}" aria-labelledby="thread-${i}-title">
      <header class="thread-head"><span class="avatar${t.other ? ' avatar-quiet' : ''}" aria-hidden="true">${initial}</span>
        <h2 id="thread-${i}-title" class="card-title thread-title">${esc(t.name)} <span class="thread-n">(${esc(t.list.length)})</span></h2></header>
      <ol class="bubbles">${t.list.map(bubble).join('')}</ol></section>`;
  }

  function html(sec, messages) {
    const { esc } = CapUI;
    if (sec.status === 'unavailable' || sec.status === 'error') return CapUI.outlookNote(sec, 'mail');
    if (sec.status !== 'ok' || (sec.partial && !messages.length)) {
      return `<div class="loading" role="status"><span class="sr-only">Chargement des messages Outlook…</span>${'<div class="card glass skel"></div>'.repeat(2)}</div>`;
    }
    const todo = messages.filter((m) => !m.handled).length;
    const fresh = `${sec.stale ? `${sec.reason} ` : ''}Mis à jour le ${CapUI.fmtStamp(sec.storedAt)}${sec.stale ? ' · peut-être pas à jour' : ''}`;
    const count = messages.length ? `${todo ? `${CapUI.fmtNum(todo)} à traiter` : 'Tout est traité'} · ${CapUI.plural(messages.length, 'message', 'messages')}` : '';
    return `<div class="msgs">
      <div class="toolbar outlook-bar"><p class="count" id="msg-count">${esc(count)}</p><p class="fresh${sec.stale ? ' is-stale' : ''}" id="msg-fresh">${esc(fresh)}</p></div>
      ${messages.length ? `<div class="threads">${threads(messages).map(thread).join('')}</div>` : CapUI.emptyBlock(...NONE)}
      <p class="read-only">Lecture seule : Cap n'envoie et ne modifie aucun e-mail.</p></div>`;
  }

  function render(root, state, ctx = {}) {
    if (!CapUI.gate(root, state, EMPTY)) { delete root.dataset.outlook; return; }
    const o = ctx.outlook || {};
    const sec = o.mail || { status: 'loading' };
    const messages = sec.status === 'ok' && Array.isArray(o.messages) ? o.messages : [];
    for (const id of sending) if (!messages.some((m) => m.id === id && !m.handled)) sending.delete(id);
    root.dataset.outlook = sec.status;
    const sig = JSON.stringify([sec, messages.map((m) => [m.id, m.handled, m.company, m.subject, m.receivedDateTime]), [...sending]]);
    CapUI.rebuild(root, 'messages', sig, () => { root.innerHTML = html(sec, messages); });
  }

  // one delegated listener per root
  function bind(root) {
    if (root.__capMessages) return;
    root.__capMessages = true;
    root.addEventListener('click', (e) => {
      const auth = e.target.closest('[data-authorize]');
      if (auth) { if (!auth.disabled) CapOutlook.authorize(auth.dataset.authorize); return; } // callTool runs inside this click
      const b = e.target.closest('[data-handle]');
      if (!b || b.disabled) return;
      const id = b.dataset.handle;
      b.disabled = true;
      sending.add(id);
      CapData.markHandled(id).catch((err) => {
        console.error('Cap: markHandled failed', err);
        sending.delete(id);
        if (b.isConnected) b.disabled = false;
        CapUI.toast('Impossible d\'enregistrer pour l\'instant. Réessayez dans un moment.', 'error');
      });
    });
  }

  Screens.messages = { render(root, state, ctx) { bind(root); render(root, state, ctx); } };
})();
