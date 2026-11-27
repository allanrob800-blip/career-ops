/* Accueil: greeting, weekly goal ring, 4 KPI cards, « À faire » (follow-up texts to copy), « À envoyer » (ready dossiers),
 * « À confirmer » (status proposals), mini-week, sync date. Classic script. */
(() => {
  'use strict';
  const Screens = (globalThis.Screens = globalThis.Screens || {});
  const EMPTY = ['Rien à afficher pour l\'instant', 'La première synchronisation n\'a pas encore eu lieu. Ouvrez une session career-ops : Claude enverra vos données ici.'];
  const ACTIVE = new Set(['Applied', 'Responded', 'Assessment', 'Interview', 'Offer']);
  const PROPOSAL_ID = /^p-[0-9a-f]{16}$/;
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const txt = (v) => (typeof v === 'string' ? v.trim() : '');
  const parisDay = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' });
  const dismissed = new Set(); // proposals confirmed or ignored here, hidden before the handled/ listener delivers
  const shown = { followTexts: [], proposals: new Map() }; // what the last paint shows, for the click handlers

  function greeting(first) {
    const h = CapUI.parisHour();
    const g = h >= 5 && h < 12 ? 'Bonjour' : h >= 12 && h < 18 ? 'Bon après-midi' : 'Bonsoir';
    return first ? `${g} ${first}` : g;
  }

  // Weekly counts over the last 8 ISO weeks (oldest first).
  function weekly(mon, inWeek) {
    const out = [];
    for (let k = 7; k >= 0; k--) { const a = CapUI.addDays(mon, -7 * k); out.push(inWeek(a, CapUI.addDays(a, 6))); }
    return out;
  }

  function outlookSig(o) {
    if (!o) return null;
    const sec = (s) => s && [s.status, s.reason];
    return [o.status, o.reason, o.stale, o.storedAt, sec(o.mail), sec(o.calendar), (o.messages || []).map((m) => `${m && m.id}:${m && m.handled}`), (o.events || []).map((e) => [e && e.subject, e && e.startMs])];
  }

  // CapOutlook resolves the {dateTime, timeZone} wall-clock pair into startMs.
  function eventStart(e) {
    if (e && Number.isFinite(e.startMs)) return e.startMs;
    const t = Date.parse(e && e.start && typeof e.start.dateTime === 'string' ? e.start.dateTime : '');
    return Number.isNaN(t) ? null : t;
  }

  // The status a row will have once the pending requests are applied (CapData), else its status in the snapshot.
  const expected = (num, fallback) => (globalThis.CapData && CapData.expectedStatus(num)) || fallback;

  // « À envoyer »: the applications whose dossier is ready and that are not sent (nor closed, nor asked to be), oldest
  // prepared first.
  function toSend(apps) {
    const at = (a) => { const t = Date.parse(a.dossier.prepared_at); return Number.isNaN(t) ? Infinity : t; };
    return apps.filter((a) => {
      if (!isObj(a) || !Number.isInteger(a.num) || !isObj(a.dossier) || a.dossier.state !== 'pret') return false;
      const st = expected(a.num, a.status);
      return !CapUI.isoDay(a.applied_on) && !CapUI.SENT.has(st) && !CapUI.CLOSED.has(st);
    }).sort((a, b) => (at(a) - at(b)) || a.num - b.num);
  }

  // « À confirmer »: the well-formed proposals not handled yet, whose target is not already the expected status.
  function toConfirm(snap) {
    const handled = globalThis.CapData ? CapData.handledIds() : new Set();
    const seen = new Set();
    return (Array.isArray(snap.proposals) ? snap.proposals : []).filter((p) => {
      if (!isObj(p) || typeof p.id !== 'string' || !PROPOSAL_ID.test(p.id) || seen.has(p.id)) return false;
      if (!Number.isInteger(p.ref) || p.ref < 1 || !CapUI.STATUSES.includes(p.to_status) || !isObj(p.evidence)) return false;
      seen.add(p.id);
      if (handled.has(p.id) || dismissed.has(p.id)) return false;
      const st = expected(p.ref, null);
      return st != null && st !== p.to_status; // unknown row: nothing to confirm
    });
  }

  const statusChip = (s) => `<span class="status s-${CapUI.tone(s)}">${CapUI.esc(CapUI.statusLabel(s))}</span>`;

  function sendHtml(list) {
    const { esc } = CapUI;
    const rows = list.map((a) => {
      const t = Date.parse(a.dossier.prepared_at);
      const when = Number.isNaN(t) ? '' : ` · prêt le ${CapUI.fmtDay(parisDay.format(new Date(t)))}`;
      const letter = a.dossier.letter_state === 'a_completer' ? '<span class="send-note">lettre à compléter</span>' : '';
      return `<li class="todo-item" data-send="${esc(a.num)}"><span class="todo-ico">${CapUI.ICON.send}</span>
        <button type="button" class="todo-link" data-open="${esc(a.num)}"><span><strong>${esc(txt(a.company) || 'Entreprise non précisée')}</strong></span>
          <span class="todo-sub">${esc(txt(a.role))}${esc(when)}</span>${letter}</button></li>`;
    }).join('');
    return `<section class="card glass rise" style="--i:6" id="to-send" aria-labelledby="to-send-title"><h2 id="to-send-title" class="card-title">À envoyer</h2>
      <ul class="todo-list">${rows}</ul></section>`;
  }

  function confirmHtml(list, apps) {
    const { esc } = CapUI;
    const byNum = new Map(apps.filter(isObj).map((a) => [a.num, a]));
    const rows = list.map((p) => {
      const app = byNum.get(p.ref);
      const company = txt(p.company) || (app && txt(app.company)) || 'Entreprise non précisée';
      const from = CapUI.STATUSES.includes(p.from_status) ? p.from_status : app && app.status;
      const ev = p.evidence;
      const date = CapUI.isoDay(ev.date) ? CapUI.fmtDay(ev.date) : CapUI.fmtStamp(ev.date);
      const meta = [txt(ev.from), date === '—' ? '' : date].filter(Boolean).map(esc).join(' · ');
      return `<li class="prop" data-proposal="${esc(p.id)}">
        <p class="prop-head"><strong class="prop-co">${esc(company)}</strong>
          <span class="prop-move">${from ? statusChip(from) : ''}<span class="prop-arrow">→</span>${statusChip(p.to_status)}</span></p>
        <div class="prop-proof">${meta ? `<p class="prop-meta">${meta}</p>` : ''}${txt(ev.subject) ? `<p class="prop-subj">${esc(txt(ev.subject))}</p>` : ''}${txt(ev.excerpt) ? `<p class="prop-excerpt">${esc(txt(ev.excerpt))}</p>` : ''}</div>
        <div class="req-row prop-actions"><button type="button" class="btn btn-acc" id="confirm-${esc(p.id)}" data-confirm>Confirmer</button>
          <button type="button" class="btn btn-soft" id="ignore-${esc(p.id)}" data-ignore>Ignorer</button></div>
        <p class="req-err" role="alert" hidden></p></li>`;
    }).join('');
    return `<section class="card glass rise" style="--i:6" id="to-confirm" aria-labelledby="to-confirm-title"><h2 id="to-confirm-title" class="card-title">À confirmer</h2>
      <p class="card-note">Statuts proposés d'après vos e-mails. Confirmer crée une demande que Claude appliquera.</p>
      <ul class="prop-list">${rows}</ul></section>`;
  }

  function todoHtml(snap, apps, state, ctx, today) {
    const { esc } = CapUI;
    const items = [];
    const o = ctx.outlook;
    if (!o) items.push('<li class="todo-quiet">Outlook non connecté</li>');
    else {
      // Each Outlook section speaks for itself: a failed one shows its reason in place of its line, with a link
      // to the screen that explains it (and holds « Autoriser Outlook »). One line when both say the same thing.
      const mail = o.mail || o;
      const cal = o.calendar || o;
      const failed = (s) => s.status === 'error' || s.status === 'unavailable';
      const note = (s, id, route) => {
        const text = esc(s.reason || 'Outlook indisponible pour l\'instant');
        return s.status === 'error'
          ? `<li class="todo-item" data-outlook-note="${id}"><span class="todo-ico">${CapUI.ICON.gap}</span><a href="#${route}">${text}</a></li>`
          : `<li class="todo-quiet" data-outlook-note="${id}"><a href="#${route}">${text}</a></li>`;
      };
      if (mail.status === 'ok') {
        const n = (o.messages || []).filter((m) => m && !m.handled).length;
        if (n) items.push(`<li class="todo-item"><span class="todo-ico">${CapUI.ICON.chat}</span><a href="#messages"><span data-count="messages">${esc(n)}</span> ${n > 1 ? 'messages' : 'message'} à traiter</a></li>`);
      } else if (failed(mail)) items.push(note(mail, 'mail', 'messages'));
      if (cal.status === 'ok') {
        const next = (o.events || []).map((e) => ({ e, t: eventStart(e) })).filter((x) => x.t != null && x.t >= Date.now()).sort((a, b) => a.t - b.t)[0];
        if (next) items.push(`<li class="todo-item"><span class="todo-ico">${CapUI.ICON.users}</span><span>Prochain entretien : <strong>${esc(next.e.subject || 'Entretien')}</strong> · ${esc(CapUI.fmtStamp(new Date(next.t).toISOString()))}</span></li>`);
      } else if (failed(cal) && !(failed(mail) && mail.reason === cal.reason)) items.push(note(cal, 'calendar', 'planning'));
      if (mail.status === 'loading' || cal.status === 'loading') items.push('<li class="todo-quiet">Outlook : chargement…</li>');
      if (o.stale) items.push('<li class="todo-quiet">Outlook : peut-être pas à jour</li>');
    }
    const texts = [];
    for (const f of snap.followups_due || []) {
      // the follow-up text to copy, when the Suivi wrote one: shown as is (line breaks kept), copied from the data
      const text = f && typeof f.text === 'string' && f.text.trim() ? f.text : '';
      const copy = text ? `<div class="followup-box"><p class="msg-text followup-text">${esc(text)}</p>
        <div class="req-row"><button type="button" class="btn btn-soft followup-copy" data-copy="${texts.length}">${CapUI.ICON.copy}<span>Copier</span></button></div>
        <p class="req-err" role="alert" hidden></p></div>` : '';
      if (text) texts.push(text);
      items.push(`<li class="todo-item${text ? ' todo-follow' : ''}" data-followup><span class="todo-ico">${CapUI.ICON.clock}</span>
        <button type="button" class="todo-link" data-open="${esc(f.num)}"><span>Relancer <strong>${esc(f.company)}</strong></span><span class="todo-sub">${esc(f.role)}</span></button>
        <span class="badge ${f.urgency === 'urgent' ? 'badge-acc' : 'badge-warn'}">${f.urgency === 'urgent' ? 'Urgent' : 'En retard'}</span>${copy}</li>`);
    }
    shown.followTexts = texts;
    for (const a of apps) {
      if (!CapUI.isoDay(a.closes_at) || CapUI.CLOSED.has(a.status)) continue;
      const d = CapUI.daysBetween(today, a.closes_at);
      if (d < 0 || d > 7) continue;
      const when = d === 0 ? 'ferme aujourd\'hui' : d === 1 ? 'ferme demain' : `ferme dans ${d} jours`;
      items.push(`<li class="todo-item" data-closing><span class="todo-ico hot">${CapUI.ICON.flame}</span>
        <button type="button" class="todo-link" data-open="${esc(a.num)}"><span><strong>${esc(a.company)}</strong> ${esc(when)}</span><span class="todo-sub">${esc(a.role)}</span></button></li>`);
    }
    const waiting = state.pending.filter((p) => p.state === 'pending').length;
    const actionable = items.some((s) => s.includes('todo-item'));
    if (!actionable) items.push('<li class="todo-calm">Rien d\'urgent aujourd\'hui. Un bon moment pour évaluer une nouvelle offre.</li>');
    if (waiting) items.push(`<li class="todo-quiet">${esc(CapUI.plural(waiting, 'demande', 'demandes'))} en attente de synchronisation</li>`);
    return items.join('');
  }

  function weekHtml(apps, snap, ctx, today, wk) {
    const { esc } = CapUI;
    const marks = new Map();
    const horizon = CapUI.addDays(today, 7);
    const last = horizon > wk.sun ? horizon : wk.sun;
    const mark = (day, kind, text) => { if (!CapUI.isoDay(day) || day < wk.mon || day > last) return; if (!marks.has(day)) marks.set(day, []); marks.get(day).push({ kind, text }); };
    for (const a of apps) {
      mark(a.applied_on, 'sent', `Envoi · ${a.company}`);
      if (ACTIVE.has(a.status)) mark(a.next_followup, 'follow', `Relance · ${a.company}`);
      if (!CapUI.CLOSED.has(a.status)) mark(a.closes_at, 'close', `Clôture · ${a.company}`);
    }
    const o = ctx.outlook;
    if (o && o.status === 'ok') for (const e of o.events || []) { const t = eventStart(e); if (t != null) mark(parisDay.format(new Date(t)), 'meet', `Entretien · ${e.subject || ''}`); }
    let days = '';
    for (let i = 0; i < 7; i++) {
      const d = CapUI.addDays(wk.mon, i);
      const m = marks.get(d) || [];
      const cls = ['wd', d === today ? 'is-today' : '', d < today ? 'is-past' : ''].join(' ').trim();
      days += `<li class="${cls}" data-day="${d}"><span class="wd-name">${esc(CapUI.fmtWeekday(d))}</span><span class="wd-num">${esc(Number(d.slice(8)))}</span>
        <span class="wd-dots">${[...new Set(m.map((x) => x.kind))].map((k) => `<i class="dot-${k}"></i>`).join('')}</span></li>`;
    }
    const upcoming = [...marks.entries()].filter(([d]) => d >= today && d <= horizon).sort(([a], [b]) => a.localeCompare(b))
      .flatMap(([d, list]) => list.filter((x) => x.kind !== 'sent').map((x) => ({ d, ...x }))).slice(0, 4);
    const agenda = upcoming.length
      ? upcoming.map((x) => `<li class="ag ag-${x.kind}"><span class="ag-day">${esc(CapUI.fmtDay(x.d))}</span><span class="ag-text">${esc(x.text)}</span></li>`).join('')
      : '<li class="ag-none">Rien de prévu dans les 7 prochains jours.</li>';
    const big = Number(today.slice(8));
    return `<div class="week-head"><span class="week-big">${esc(big)}</span><span class="week-date">${esc(CapUI.fmtLong(today))}</span></div>
      <ol class="mini-week" aria-label="Semaine en cours">${days}</ol>
      <h3 class="sub-title">7 prochains jours</h3><ul class="agenda">${agenda}</ul>`;
  }

  function kpi(key, icon, label, cls, i) {
    return `<article class="card glass kpi rise ${cls}" data-kpi="${key}" style="--i:${i}">
      <div class="kpi-top"><span class="kpi-ico">${CapUI.ICON[icon]}</span><span class="chip" id="chip-${key}" hidden></span></div>
      <p class="kpi-num" id="kpi-${key}">0</p><p class="kpi-lbl">${label}</p><svg class="spark" id="spark-${key}" aria-hidden="true"></svg></article>`;
  }

  function render(root, state, ctx = {}) {
    const h1 = root.closest('section') && root.closest('section').querySelector('h1');
    const snap = state && state.snapshot;
    if (h1) h1.textContent = greeting(snap && snap.profile && typeof snap.profile.first_name === 'string' ? snap.profile.first_name : '');
    if (!CapUI.gate(root, state, EMPTY)) return;
    const today = CapUI.today();
    const apps = Array.isArray(snap.apps) ? snap.apps : [];
    // both lists also depend on the handled/ store and on requests written here (CapData), not only on `state`
    const lists = { send: toSend(apps), confirm: toConfirm(snap) };
    const sig = JSON.stringify([snap.generation, state.pending.map((p) => p.id + p.state), state.prefs.weekly_goal, outlookSig(ctx.outlook), today, state.stale, h1 && h1.textContent,
      lists.send.map((a) => a.num), lists.confirm.map((p) => p.id)]);
    CapUI.rebuild(root, 'accueil', sig, () => paint(root, state, ctx, today, lists));
  }

  function paint(root, state, ctx, today, lists) {
    const { esc } = CapUI;
    const snap = state.snapshot;
    const apps = Array.isArray(snap.apps) ? snap.apps : [];
    const wk = CapUI.week(today);
    const goal = state.prefs.weekly_goal;
    const done = apps.filter((a) => CapUI.isoDay(a.applied_on) && a.applied_on >= wk.mon && a.applied_on <= wk.sun).length;
    const f = CapUI.figures(apps);
    const active = apps.filter((a) => ACTIVE.has(a.status)).length;
    const toEval = (snap.offers || []).length + apps.filter((a) => a.status === 'Evaluated').length;
    const due = (snap.followups_due || []).length;
    const left = Math.max(0, goal - done);
    const title = left ? `Encore ${CapUI.plural(left, 'candidature', 'candidatures')} pour tenir le cap` : 'Cap tenu cette semaine';
    const sameMonth = wk.mon.slice(5, 7) === wk.sun.slice(5, 7);
    const kicker = `Semaine du ${sameMonth ? Number(wk.mon.slice(8)) : CapUI.fmtDay(wk.mon)} au ${CapUI.fmtDay(wk.sun)}`;
    const sync = `Synchronisé le ${CapUI.fmtStamp(state.synced_at)}${state.stale ? ' · peut-être pas à jour' : ''}`;

    root.innerHTML = `<div class="home">
      <section class="card hero rise" style="--i:0" aria-labelledby="hero-title">
        <div class="hero-text">
          <p class="hero-kicker">${esc(kicker)}</p>
          <h2 id="hero-title" class="hero-title">${esc(title)}</h2>
          <dl class="hero-figs">
            <div><dt>en cours</dt><dd>${esc(active)}</dd></div>
            <div><dt>à évaluer</dt><dd>${esc(toEval)}</dd></div>
            <div><dt>relances dues</dt><dd>${esc(due)}</dd></div>
          </dl>
          <div class="hero-actions"><a class="btn btn-on-acc" href="#offres">Voir les offres</a><a class="btn btn-ghost-acc" href="#candidatures">Mes candidatures</a></div>
        </div>
        <div class="hero-ring"><div class="ring" id="goal-ring"><p class="ring-in"><span id="goal-count"><b id="goal-n">0</b> sur ${esc(goal)}</span></p></div>
          <p class="ring-cap">objectif de la semaine</p></div>
      </section>
      <section class="card glass week rise" style="--i:1" aria-label="Cette semaine">${weekHtml(apps, snap, ctx, today, wk)}</section>
      <div class="kpis">
        ${kpi('sent', 'send', 'Candidatures envoyées', '', 2)}
        ${kpi('rate', 'chat', 'Taux de réponse', '', 3)}
        ${kpi('interviews', 'users', 'Entretiens', 'kpi-acc', 4)}
        ${kpi('offers', 'star', 'Offres reçues', '', 5)}
      </div>
      <div class="home-acts">
        <section class="card glass todo rise" style="--i:6" id="todo" aria-labelledby="todo-title"><h2 id="todo-title" class="card-title">À faire</h2>
          <ul class="todo-list">${todoHtml(snap, apps, state, ctx, today)}</ul></section>
        ${lists.send.length ? sendHtml(lists.send) : ''}
        ${lists.confirm.length ? confirmHtml(lists.confirm, apps) : ''}
      </div>
      <nav class="quick" aria-label="Raccourcis">
        <a class="card glass tile rise" style="--i:7" href="#offres"><span class="tile-ico">${CapUI.ICON.target}</span><span>Offres à évaluer</span></a>
        <a class="card glass tile rise" style="--i:8" href="#candidatures"><span class="tile-ico">${CapUI.ICON.case}</span><span>Candidatures en cours</span></a>
        <a class="card glass tile rise" style="--i:9" href="#analytique"><span class="tile-ico">${CapUI.ICON.chart}</span><span>Analytique</span></a>
        <a class="card glass tile rise" style="--i:10" href="#reglages"><span class="tile-ico">${CapUI.ICON.sliders}</span><span>Réglages</span></a>
      </nav>
      <p id="sync-note" class="sync${state.stale ? ' is-stale' : ''}">${esc(sync)}</p>
    </div>`;

    shown.proposals = new Map(lists.confirm.map((p) => [p.id, p]));
    CapUI.countUp(root.querySelector('#goal-n'), done, { key: 'goal' });
    CapCharts.ring(root.querySelector('#goal-ring'), done, goal);

    const inWeek = (pred) => (a0, a1) => apps.filter((a) => pred(a) && CapUI.isoDay(a.last_change || a.applied_on) && (a.last_change || a.applied_on) >= a0 && (a.last_change || a.applied_on) <= a1).length;
    const tl = Array.isArray(snap.timeline) ? snap.timeline : [];
    const sentWeekly = weekly(wk.mon, (a0, a1) => tl.filter((d) => d.date >= a0 && d.date <= a1).reduce((s, d) => s + (d.applied || 0), 0));
    const series = {
      sent: [f.sent, sentWeekly, (n) => `+${n} cette semaine`],
      rate: [f.rate, weekly(wk.mon, inWeek((a) => CapUI.REPLIED.has(a.status))), () => `${f.replied} sur ${f.sent}`],
      interviews: [f.interviews, weekly(wk.mon, inWeek((a) => CapUI.INTERVIEWED.has(a.status))), (n) => `+${n} cette semaine`],
      offers: [f.offers, weekly(wk.mon, inWeek((a) => CapUI.OFFERED.has(a.status))), (n) => `+${n} cette semaine`],
    };
    for (const [key, [value, pts, chip]] of Object.entries(series)) {
      const el = root.querySelector(`#kpi-${key}`);
      CapUI.countUp(el, value, { key: `kpi-${key}`, format: key === 'rate' ? CapUI.fmtPct : CapUI.fmtNum });
      CapCharts.spark(root.querySelector(`#spark-${key}`), pts);
      const thisWeek = pts[pts.length - 1];
      const c = root.querySelector(`#chip-${key}`);
      if (key === 'rate' ? f.sent > 0 : thisWeek > 0) { c.textContent = chip(thisWeek); c.hidden = false; }
    }
  }

  const showErr = (box, msg) => { const e = box.querySelector('.req-err'); e.textContent = msg; e.hidden = !msg; };

  async function copyFollowup(btn) {
    const box = btn.closest('.followup-box');
    const text = shown.followTexts[Number(btn.dataset.copy)];
    if (!box || text == null) return;
    showErr(box, '');
    if (await CapUI.copyText(text, box.querySelector('.followup-text'))) CapUI.toast('Texte de relance copié.');
    else showErr(box, CapUI.COPY_FAILED);
  }

  // « Confirmer »: a status request, then the proposal is marked handled. « Ignorer »: only marked handled.
  async function settleProposal(root, li, confirm) {
    const p = shown.proposals.get(li.dataset.proposal);
    if (!p || li.dataset.busy) return;
    li.dataset.busy = '1';
    const buttons = li.querySelectorAll('button');
    buttons.forEach((b) => { b.disabled = true; });
    showErr(li, '');
    try {
      if (confirm) {
        await CapData.requestStatus(p.ref, p.to_status);
        dismissed.add(p.id); // the request is written: the proposal is done even if marking it fails below
      }
      await CapData.markHandled(p.id);
      dismissed.add(p.id);
    } catch (err) {
      if (!dismissed.has(p.id)) {
        delete li.dataset.busy;
        buttons.forEach((b) => { b.disabled = false; });
        showErr(li, (err && err.message) || 'La demande n\'a pas pu être enregistrée.');
        return;
      }
    }
    const sec = li.closest('#to-confirm');
    li.remove();
    if (sec && !sec.querySelector('[data-proposal]')) sec.remove();
    const next = root.querySelector('#to-confirm [data-confirm]');
    if (next && (!document.activeElement || document.activeElement === document.body)) next.focus();
  }

  // one delegated listener per root
  function bind(root) {
    if (root.__capAccueil) return;
    root.__capAccueil = true;
    root.addEventListener('click', (e) => {
      const copy = e.target.closest('[data-copy]');
      if (copy) { copyFollowup(copy); return; }
      const act = e.target.closest('[data-confirm], [data-ignore]');
      if (act) { const li = act.closest('[data-proposal]'); if (li) settleProposal(root, li, act.hasAttribute('data-confirm')); return; }
      const b = e.target.closest('[data-open]');
      if (!b) return;
      const n = parseInt(b.dataset.open, 10);
      if (Number.isInteger(n) && globalThis.CapApp) CapApp.openApp(n);
    });
  }

  Screens.accueil = { render(root, state, ctx) { bind(root); render(root, state, ctx); } };
})();
