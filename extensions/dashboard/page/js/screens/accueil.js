/* Accueil: greeting, weekly goal ring, 4 KPI cards, « À faire », mini-week, sync date. Classic script. */
(() => {
  'use strict';
  const Screens = (globalThis.Screens = globalThis.Screens || {});
  const EMPTY = ['Rien à afficher pour l\'instant', 'La première synchronisation n\'a pas encore eu lieu. Ouvrez une session career-ops : Claude enverra vos données ici.'];
  const ACTIVE = new Set(['Applied', 'Responded', 'Assessment', 'Interview', 'Offer']);

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
    return [o.status, o.storedAt, (o.messages || []).map((m) => `${m && m.id}:${m && m.handled}`), (o.events || []).length];
  }

  function eventStart(e) {
    const t = Date.parse(e && e.start && typeof e.start.dateTime === 'string' ? e.start.dateTime : '');
    return Number.isNaN(t) ? null : t;
  }

  function todoHtml(snap, apps, state, ctx, today) {
    const { esc } = CapUI;
    const items = [];
    const o = ctx.outlook;
    if (!o) items.push('<li class="todo-quiet">Outlook non connecté</li>');
    else if (o.status === 'ok') {
      const n = (o.messages || []).filter((m) => m && !m.handled).length;
      if (n) items.push(`<li class="todo-item"><span class="todo-ico">${CapUI.ICON.chat}</span><a href="#messages"><span data-count="messages">${esc(n)}</span> ${n > 1 ? 'messages' : 'message'} à traiter</a></li>`);
      const next = (o.events || []).map((e) => ({ e, t: eventStart(e) })).filter((x) => x.t != null && x.t >= Date.now()).sort((a, b) => a.t - b.t)[0];
      if (next) items.push(`<li class="todo-item"><span class="todo-ico">${CapUI.ICON.users}</span><span>Prochain entretien : <strong>${esc(next.e.subject || 'Entretien')}</strong> · ${esc(CapUI.fmtStamp(new Date(next.t).toISOString()))}</span></li>`);
    } else {
      items.push(`<li class="todo-quiet">${o.status === 'loading' ? 'Outlook : chargement…' : 'Outlook indisponible pour l\'instant'}</li>`);
    }
    for (const f of snap.followups_due || []) {
      items.push(`<li class="todo-item" data-followup><span class="todo-ico">${CapUI.ICON.clock}</span>
        <button type="button" class="todo-link" data-open="${esc(f.num)}"><span>Relancer <strong>${esc(f.company)}</strong></span><span class="todo-sub">${esc(f.role)}</span></button>
        <span class="badge ${f.urgency === 'urgent' ? 'badge-acc' : 'badge-warn'}">${f.urgency === 'urgent' ? 'Urgent' : 'En retard'}</span></li>`);
    }
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
    if (o && o.status === 'ok') for (const e of o.events || []) { const t = eventStart(e); if (t != null) mark(new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris' }).format(new Date(t)), 'meet', `Entretien · ${e.subject || ''}`); }
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
    const sig = JSON.stringify([snap.generation, state.pending.map((p) => p.id + p.state), state.prefs.weekly_goal, outlookSig(ctx.outlook), today, state.stale, h1 && h1.textContent]);
    CapUI.rebuild(root, 'accueil', sig, () => paint(root, state, ctx, today));
  }

  function paint(root, state, ctx, today) {
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
      <section class="card glass todo rise" style="--i:6" id="todo" aria-labelledby="todo-title"><h2 id="todo-title" class="card-title">À faire</h2>
        <ul class="todo-list">${todoHtml(snap, apps, state, ctx, today)}</ul></section>
      <nav class="quick" aria-label="Raccourcis">
        <a class="card glass tile rise" style="--i:7" href="#offres"><span class="tile-ico">${CapUI.ICON.target}</span><span>Offres à évaluer</span></a>
        <a class="card glass tile rise" style="--i:8" href="#candidatures"><span class="tile-ico">${CapUI.ICON.case}</span><span>Candidatures en cours</span></a>
        <a class="card glass tile rise" style="--i:9" href="#analytique"><span class="tile-ico">${CapUI.ICON.chart}</span><span>Analytique</span></a>
        <a class="card glass tile rise" style="--i:10" href="#reglages"><span class="tile-ico">${CapUI.ICON.sliders}</span><span>Réglages</span></a>
      </nav>
      <p id="sync-note" class="sync${state.stale ? ' is-stale' : ''}">${esc(sync)}</p>
    </div>`;

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

  // one delegated listener per root
  function bind(root) {
    if (root.__capAccueil) return;
    root.__capAccueil = true;
    root.addEventListener('click', (e) => {
      const b = e.target.closest('[data-open]');
      if (!b) return;
      const n = parseInt(b.dataset.open, 10);
      if (Number.isInteger(n) && globalThis.CapApp) CapApp.openApp(n);
    });
  }

  Screens.accueil = { render(root, state, ctx) { bind(root); render(root, state, ctx); } };
})();
