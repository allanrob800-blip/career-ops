/* Planning: the week in columns (>= 900px) or as a list by day; Outlook interviews and follow-ups from the snapshot. Classic script. */
(() => {
  'use strict';
  const Screens = (globalThis.Screens = globalThis.Screens || {});
  const EMPTY = ['Rien à afficher pour l\'instant', 'La première synchronisation n\'a pas encore eu lieu. Ouvrez une session career-ops : Claude enverra vos données ici.'];
  const ACTIVE = new Set(['Applied', 'Responded', 'Assessment', 'Interview', 'Offer']);
  const HORIZON_DAYS = 14; // the calendar watch covers the next 14 days
  const ui = { week: 0 };
  const hhmm = new Intl.DateTimeFormat('fr-FR', { timeZone: 'Europe/Paris', hour: '2-digit', minute: '2-digit' });

  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

  // day -> [{kind: 'meet' | 'due' | 'follow', ...}] ; interviews first (by start time), then follow-ups.
  function agenda(snap, events, today) {
    const days = new Map();
    const put = (day, item) => { if (!days.has(day)) days.set(day, []); days.get(day).push(item); };
    for (const e of events) if (CapUI.isoDay(e.day)) put(e.day, { kind: 'meet', e });
    const due = new Set();
    for (const f of Array.isArray(snap.followups_due) ? snap.followups_due : []) {
      if (!isObj(f) || !Number.isInteger(f.num)) continue;
      due.add(f.num);
      put(today, { kind: 'due', f }); // a follow-up that is due is something to do today
    }
    for (const a of Array.isArray(snap.apps) ? snap.apps : []) {
      if (!isObj(a) || !Number.isInteger(a.num) || due.has(a.num) || !ACTIVE.has(a.status)) continue;
      if (CapUI.isoDay(a.next_followup) && a.next_followup > today) put(a.next_followup, { kind: 'follow', a });
    }
    return days;
  }

  function card(it) {
    const { esc } = CapUI;
    if (it.kind === 'meet') {
      const e = it.e;
      const href = CapUI.safeHref(e.webLink);
      const time = e.time ? `${e.time}${e.endTime ? ` – ${e.endTime}` : ''}` : 'Toute la journée';
      const sub = [e.company, e.location].filter(Boolean).map(esc).join(' · ');
      return `<li class="ev ev-meet" data-t="${esc(e.time && Number.isFinite(e.startMs) ? e.startMs : 0)}">
        <p class="ev-time"><span class="nowrap">${esc(time)}</span>${e.zone ? ` <span class="ev-zone">${esc(e.zone)}</span>` : ''}</p>
        <p class="ev-title">${esc(e.subject || 'Entretien')}</p>${sub ? `<p class="ev-sub">${sub}</p>` : ''}
        ${href ? `<a class="ev-link" href="${esc(href)}" target="_blank" rel="noopener noreferrer">${CapUI.ICON.link}<span>Ouvrir dans Outlook</span></a>` : ''}</li>`;
    }
    const due = it.kind === 'due';
    const x = due ? it.f : it.a;
    const sub = [x.role, due && CapUI.isoDay(x.due) ? `prévue le ${CapUI.fmtDay(x.due)}` : ''].filter(Boolean).map(esc).join(' · ');
    return `<li class="ev ${due ? 'ev-due' : 'ev-follow'}"><button type="button" class="ev-btn" data-open="${esc(x.num)}">
      <span class="ev-time">${due ? 'Relance en retard' : 'Relance prévue'}</span>
      <span class="ev-title">Relancer ${esc(x.company)}</span>${sub ? `<span class="ev-sub">${sub}</span>` : ''}</button></li>`;
  }

  function weekLabel(mon, sun) {
    const same = mon.slice(5, 7) === sun.slice(5, 7);
    return `Semaine du ${same ? Number(mon.slice(8)) : CapUI.fmtDay(mon)} au ${CapUI.fmtDay(sun)}`;
  }

  function html(snap, sec, events, today, mon, last) {
    const { esc } = CapUI;
    const days = agenda(snap, events, today);
    const sun = CapUI.addDays(mon, 6);
    let cols = '';
    let any = false;
    for (let i = 0; i < 7; i++) {
      const d = CapUI.addDays(mon, i);
      const items = days.get(d) || [];
      if (items.length) any = true;
      const cls = ['day', d === today ? 'is-today' : '', d < today ? 'is-past' : '', items.length ? '' : 'is-empty'].filter(Boolean).join(' ');
      cols += `<li class="${cls}" data-day="${d}">
        <h2 class="day-head" id="day-${d}"><span class="day-name">${esc(CapUI.fmtWeekday(d))}</span><span class="day-num">${esc(Number(d.slice(8)))}</span><span class="sr-only">${esc(CapUI.fmtLong(d))}</span></h2>
        <ol class="day-list" aria-labelledby="day-${d}">${items.length ? items.map(card).join('') : '<li class="day-none">Rien de prévu</li>'}</ol></li>`;
    }
    const off = sec.status === 'unavailable' || sec.status === 'error';
    const fresh = sec.status === 'ok'
      ? `${sec.stale ? `${sec.reason} ` : ''}Agenda mis à jour le ${CapUI.fmtStamp(sec.storedAt)}${sec.stale ? ' · peut-être pas à jour' : ''}`
      : off ? '' : 'Agenda Outlook : chargement…';
    const inWeek = today >= mon && today <= sun;
    return `<div class="plan">
      <div class="toolbar outlook-bar">
        <div class="week-nav">
          <button type="button" class="icon-btn" id="plan-prev" aria-label="Semaine précédente"${ui.week <= 0 ? ' disabled' : ''}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m14.5 6-6 6 6 6"/></svg></button>
          <p class="week-label" id="plan-week" aria-live="polite">${esc(weekLabel(mon, sun))}</p>
          <button type="button" class="icon-btn" id="plan-next" aria-label="Semaine suivante"${ui.week >= last ? ' disabled' : ''}><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9.5 6 6 6-6 6"/></svg></button>
        </div>
        <p class="fresh${sec.stale ? ' is-stale' : ''}" id="plan-fresh">${esc(fresh)}</p>
      </div>
      ${off ? CapUI.outlookNote(sec, 'calendar') : ''}
      <div class="card glass plan-card rise" style="--i:0"><div class="plan-scroll scroll"><ol class="plan-grid" aria-label="${esc(weekLabel(mon, sun))}">${cols}</ol></div>
        ${any || inWeek ? '' : '<p class="empty-inline" id="plan-none">Rien de prévu cette semaine. Les entretiens de votre agenda Outlook et les relances à faire apparaîtront ici.</p>'}</div>
    </div>`;
  }

  // The red « now » line sits in today's list, after what has started and before what is still to come.
  function placeNow(root) {
    const list = root.querySelector('.day.is-today .day-list');
    let line = root.querySelector('.now-line');
    if (!list) { if (line) line.remove(); return; }
    if (!line) {
      line = document.createElement('li');
      line.className = 'now-line';
      line.setAttribute('aria-hidden', 'true');
      line.append(document.createElement('span'));
    }
    const now = Date.now();
    const label = hhmm.format(new Date(now));
    if (line.firstChild.textContent !== label) line.firstChild.textContent = label;
    const next = [...list.children].find((el) => el !== line && (!el.dataset.t || Number(el.dataset.t) > now)) || null;
    if (line.parentNode !== list || line.nextElementSibling !== next) list.insertBefore(line, next);
  }

  function render(root, state, ctx = {}) {
    if (!CapUI.gate(root, state, EMPTY)) { delete root.dataset.outlook; return; }
    const snap = state.snapshot;
    const o = ctx.outlook || {};
    const sec = o.calendar || { status: 'loading' };
    const events = sec.status === 'ok' && Array.isArray(o.events) ? o.events : [];
    const today = CapUI.today();
    const mon0 = CapUI.week(today).mon;
    const last = Math.floor(CapUI.daysBetween(mon0, CapUI.addDays(today, HORIZON_DAYS)) / 7);
    ui.week = Math.max(0, Math.min(last, ui.week));
    const mon = CapUI.addDays(mon0, 7 * ui.week);
    root.dataset.outlook = sec.status;
    const sig = JSON.stringify([snap.generation, today, ui.week, sec, events]);
    CapUI.rebuild(root, 'planning', sig, () => { root.innerHTML = html(snap, sec, events, today, mon, last); });
    placeNow(root);
  }

  // one delegated listener per root
  function bind(root) {
    if (root.__capPlanning) return;
    root.__capPlanning = true;
    root.addEventListener('click', (e) => {
      const auth = e.target.closest('[data-authorize]');
      if (auth) { if (!auth.disabled) CapOutlook.authorize(auth.dataset.authorize); return; } // callTool runs inside this click
      const nav = e.target.closest('#plan-prev, #plan-next');
      if (nav) { ui.week += nav.id === 'plan-next' ? 1 : -1; if (globalThis.CapApp) CapApp.setContext({}); return; }
      const b = e.target.closest('[data-open]');
      const n = b ? parseInt(b.dataset.open, 10) : NaN;
      if (Number.isInteger(n) && globalThis.CapApp) CapApp.openApp(n);
    });
    setInterval(() => { if (!root.closest('[hidden]') && root.dataset.view === 'planning') placeNow(root); }, 30000);
  }

  Screens.planning = { render(root, state, ctx) { bind(root); render(root, state, ctx); } };
})();
