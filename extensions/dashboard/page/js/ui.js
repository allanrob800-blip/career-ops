/*
 * CapUI: escaping, safe links, Paris dates, animated counters, short notices, in-page dialog,
 * and the loading / empty / unavailable gate shared by every screen. Classic script.
 * Every value read from the db is untrusted: build markup only through esc() and safeHref().
 */
(() => {
  'use strict';
  const TZ = 'Europe/Paris';
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ESC[c]);

  // https:// only; returns the normalized href or null.
  function safeHref(url) {
    if (typeof url !== 'string' || !/^https:\/\//i.test(url.trim())) return null;
    try { const u = new URL(url.trim()); return u.protocol === 'https:' && u.hostname ? u.href : null; } catch { return null; }
  }
  const hostOf = (url) => { const h = safeHref(url); return h ? new URL(h).hostname.replace(/^www\./, '') : null; };
  const fold = (s) => String(s ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

  // ---- statuses ----
  const STATUSES = ['Evaluated', 'Speculative', 'Applied', 'Responded', 'Assessment', 'Interview', 'Offer', 'Hired', 'Rejected', 'Discarded', 'SKIP'];
  const LABEL = {
    Evaluated: 'Évaluée', Speculative: 'Spontanée', Applied: 'Envoyée', Responded: 'Réponse reçue', Assessment: 'Exercice',
    Interview: 'Entretien', Offer: 'Offre', Hired: 'Embauche', Rejected: 'Refusée', Discarded: 'Abandonnée', SKIP: 'Écartée',
  };
  const statusLabel = (s) => LABEL[s] || String(s ?? '');
  const SENT = new Set(['Applied', 'Responded', 'Assessment', 'Interview', 'Offer', 'Hired']);
  const REPLIED = new Set(['Responded', 'Assessment', 'Interview', 'Offer', 'Hired', 'Rejected']);
  const INTERVIEWED = new Set(['Interview', 'Offer', 'Hired']);
  const OFFERED = new Set(['Offer', 'Hired']);
  const CLOSED = new Set(['Rejected', 'Discarded', 'SKIP', 'Hired']);
  const tone = (s) => (s === 'Offer' || s === 'Hired' ? 'good' : s === 'Interview' || s === 'Assessment' || s === 'Responded' ? 'acc' : CLOSED.has(s) ? 'off' : 'base');
  const isSent = (a) => !!a.applied_on || SENT.has(a.status);

  // Figures shared by Accueil and Analytique.
  function figures(apps) {
    const sent = apps.filter(isSent);
    const replied = sent.filter((a) => REPLIED.has(a.status)).length;
    return {
      total: apps.length, sent: sent.length, replied,
      interviews: apps.filter((a) => INTERVIEWED.has(a.status)).length,
      offers: apps.filter((a) => OFFERED.has(a.status)).length,
      rate: sent.length ? Math.round((replied / sent.length) * 100) : null,
    };
  }

  // ---- Paris dates (ISO day strings 'YYYY-MM-DD') ----
  const dayFmt = new Intl.DateTimeFormat('en-CA', { timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit' });
  const hourFmt = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', hourCycle: 'h23' });
  const today = () => dayFmt.format(new Date());
  const parisHour = () => parseInt(hourFmt.format(new Date()), 10);
  const isoDay = (s) => (typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : null);
  const noon = (iso) => new Date(`${iso}T12:00:00Z`);
  function addDays(iso, n) { const d = noon(iso); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); }
  const daysBetween = (a, b) => Math.round((noon(b) - noon(a)) / 86400000);
  function week(iso = today()) { const dow = (noon(iso).getUTCDay() + 6) % 7; const mon = addDays(iso, -dow); return { mon, sun: addDays(mon, 6) }; }
  const fDay = new Intl.DateTimeFormat('fr-FR', { timeZone: 'UTC', day: 'numeric', month: 'short' });
  const fLong = new Intl.DateTimeFormat('fr-FR', { timeZone: 'UTC', weekday: 'long', day: 'numeric', month: 'long' });
  const fWd = new Intl.DateTimeFormat('fr-FR', { timeZone: 'UTC', weekday: 'short' });
  const fTime = new Intl.DateTimeFormat('fr-FR', { timeZone: TZ, hour: '2-digit', minute: '2-digit' });
  const fmtDay = (iso) => (isoDay(iso) ? fDay.format(noon(iso)) : '—');
  const fmtLong = (iso) => (isoDay(iso) ? fLong.format(noon(iso)) : '—');
  const fmtWeekday = (iso) => fWd.format(noon(iso)).replace('.', '');
  function fmtStamp(ts) { const t = Date.parse(ts); if (Number.isNaN(t)) return '—'; const d = new Date(t); return `${fDay.format(noon(dayFmt.format(d)))} à ${fTime.format(d)}`; }

  const nf = new Intl.NumberFormat('fr-FR', { maximumFractionDigits: 1 });
  const fmtNum = (n) => (n == null || Number.isNaN(n) ? '—' : nf.format(n));
  const fmtPct = (n) => (n == null ? '—' : `${nf.format(n)} %`);
  const plural = (n, one, many) => `${fmtNum(n)} ${n > 1 ? many : one}`;

  // ---- motion ----
  const mq = globalThis.matchMedia ? matchMedia('(prefers-reduced-motion: reduce)') : null;
  const reduced = () => !!(mq && mq.matches) || document.documentElement.dataset.motion === 'reduce';

  // Counts from the last shown value (per key) to `to`. Same value or reduced motion: no animation.
  const shown = new Map();
  function countUp(el, to, opts = {}) {
    const fmt = opts.format || fmtNum;
    const key = opts.key || el.id;
    const from = shown.has(key) ? shown.get(key) : 0;
    shown.set(key, to);
    if (to == null || opts.reduced || reduced() || from === to || !Number.isFinite(to)) { el.textContent = fmt(to); return; }
    const t0 = performance.now();
    const dur = 900;
    const step = (t) => {
      const k = Math.min(1, (t - t0) / dur);
      const e = 1 - (1 - k) ** 3;
      const v = from + (to - from) * e;
      el.textContent = fmt(k < 1 ? (Number.isInteger(to) ? Math.round(v) : Math.round(v * 10) / 10) : to);
      if (k < 1 && el.isConnected) requestAnimationFrame(step);
    };
    el.textContent = fmt(from);
    requestAnimationFrame(step);
  }

  // ---- short notices ----
  function toast(msg, kind = 'info') {
    let host = document.getElementById('toasts');
    if (!host) {
      host = document.createElement('div');
      host.id = 'toasts';
      host.setAttribute('role', 'status');
      host.setAttribute('aria-live', 'polite');
      document.body.append(host);
    }
    const t = document.createElement('div');
    t.className = `toast toast-${kind === 'error' ? 'error' : 'info'}`;
    t.textContent = msg;
    host.append(t);
    setTimeout(() => t.remove(), 3600);
  }

  // ---- in-page dialog (no alert/confirm/prompt) ----
  let current = null;
  const FOCUSABLE = 'a[href], button:not([disabled]), select, textarea, input, [tabindex]:not([tabindex="-1"])';
  function dialog({ title, html = '', id = 'cap-dialog', onClose } = {}) {
    closeDialog();
    const back = document.activeElement;
    const el = document.createElement('div');
    el.className = 'dlg';
    el.id = id;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    el.setAttribute('aria-labelledby', `${id}-title`);
    el.innerHTML = `<div class="dlg-scrim" data-dlg-close></div>
      <div class="dlg-wrap"><div class="dlg-panel">
        <header class="dlg-head"><h2 id="${esc(id)}-title" class="dlg-title"></h2>
          <button type="button" class="icon-btn" data-dlg-close aria-label="Fermer"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 6l12 12M18 6 6 18"/></svg></button></header>
        <div class="dlg-body">${html}</div></div></div>`;
    el.querySelector('.dlg-title').textContent = title || '';
    const close = () => {
      if (current !== api) return;
      current = null;
      document.removeEventListener('keydown', onKey, true);
      el.remove();
      if (onClose) try { onClose(); } catch (e) { console.error(e); }
      if (back && back.isConnected && typeof back.focus === 'function') back.focus();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); return; }
      if (e.key !== 'Tab') return;
      const f = [...el.querySelectorAll(FOCUSABLE)].filter((n) => !n.closest('[hidden]'));
      if (!f.length) return;
      const first = f[0], last = f[f.length - 1];
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    };
    el.addEventListener('click', (e) => { if (e.target.closest('[data-dlg-close]')) close(); });
    document.addEventListener('keydown', onKey, true);
    document.body.append(el);
    const api = { el, body: el.querySelector('.dlg-body'), close };
    current = api;
    el.querySelector('.dlg-head .icon-btn').focus();
    return api;
  }
  function closeDialog() { if (current) current.close(); }

  // ---- loading / empty / unavailable gate ----
  const UNAVAILABLE = ['Données indisponibles pour l\'instant', 'La base de la page ne répond pas. Réessayez dans un moment : vos données ne sont pas perdues.'];
  function emptyBlock(title, text) {
    return `<div class="card empty glass"><svg class="empty-ico" viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5l3 2"/></svg>
      <p class="empty-title">${esc(title)}</p><p class="empty-text">${esc(text)}</p></div>`;
  }
  // Returns true when the screen should render its content.
  function gate(root, state, empty) {
    let view, html;
    if (!state || state.status === 'loading') {
      view = 'gate-loading';
      html = `<div class="loading" role="status"><span class="sr-only">Chargement des données…</span>${'<div class="card glass skel"></div>'.repeat(3)}</div>`;
    } else if (state.status === 'unavailable' && !state.snapshot) {
      view = 'gate-unavailable';
      html = emptyBlock(...UNAVAILABLE);
    } else if (state.status === 'empty' || !state.snapshot) {
      view = 'gate-empty';
      html = emptyBlock(...empty);
    } else return true;
    if (root.dataset.view !== view) { root.innerHTML = html; root.dataset.view = view; root.dataset.sig = ''; }
    return false;
  }

  // Rebuild only when the inputs changed; keeps focus and caret in a rebuilt field with the same id.
  function rebuild(root, view, sig, build) {
    if (root.dataset.view === view && root.dataset.sig === sig) return false;
    const a = document.activeElement;
    const keep = a && root.contains(a) && a.id ? { id: a.id, s: a.selectionStart, e: a.selectionEnd } : null;
    const first = root.dataset.view !== view;
    build(first);
    root.dataset.view = view;
    root.dataset.sig = sig;
    if (keep) {
      const n = document.getElementById(keep.id);
      if (n) { n.focus(); try { if (keep.s != null) n.setSelectionRange(keep.s, keep.e); } catch { /* not a text field */ } }
    }
    return true;
  }

  const ICON = {
    flame: '<svg class="flame" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3c.5 3.2 4.5 5.4 4.5 10a4.5 4.5 0 0 1-9 0c0-2.2 1.2-3.6 2.3-4.6.3 1.6 1.1 2.6 2.2 3 0-3 .3-5.7 0-8.4z"/></svg>',
    link: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M14 4h6v6M20 4l-9 9M18 14v4.5A1.5 1.5 0 0 1 16.5 20h-11A1.5 1.5 0 0 1 4 18.5v-11A1.5 1.5 0 0 1 5.5 6H10"/></svg>',
    doc: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 3.5h7l4 4v13H7z"/><path d="M14 3.5v4h4M9.5 12h6M9.5 15.5h6"/></svg>',
    send: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 12 20 4l-4 16-4-6.5z"/><path d="M12 13.5 20 4"/></svg>',
    chat: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H11l-4.5 3.5V16A2.5 2.5 0 0 1 4 13.5z"/></svg>',
    users: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="9" cy="9" r="3.5"/><path d="M3 19.5c.6-3.2 3-5 6-5s5.4 1.8 6 5M15.5 5.6a3.5 3.5 0 0 1 0 6.8M17.5 14.8c1.8.6 3 2.2 3.5 4.7"/></svg>',
    star: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z"/></svg>',
    clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v5l3 2"/></svg>',
    target: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r=".6"/></svg>',
    case: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3.5" y="7" width="17" height="12.5" rx="2.5"/><path d="M9 7V5.5A1.5 1.5 0 0 1 10.5 4h3A1.5 1.5 0 0 1 15 5.5V7M3.5 13h17"/></svg>',
    chart: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4.5 19.5V10M10.5 19.5V5M16.5 19.5v-7M21 19.5H3"/></svg>',
    sliders: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h9M17 7h3M4 17h3M11 17h9"/><circle cx="15" cy="7" r="2"/><circle cx="9" cy="17" r="2"/></svg>',
    check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>',
    gap: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 7v6M12 16.5v.5"/><circle cx="12" cy="12" r="8.5"/></svg>',
  };

  // Strip leading emoji / pictographs and "Strength:" style prefixes from report bullets.
  const cleanBullet = (s) => String(s ?? '').replace(/^[\s\p{Extended_Pictographic}️‍]+/u, '').replace(/^(strength|gap|point fort|lacune)\s*:\s*/i, '').trim();

  const intent = {}; // cross-screen requests, e.g. { openApp: 3 } consumed by Candidatures

  globalThis.CapUI = {
    esc, safeHref, hostOf, fold, countUp, toast, dialog, closeDialog, gate, rebuild, reduced, emptyBlock,
    STATUSES, statusLabel, tone, isSent, figures, SENT, REPLIED, INTERVIEWED, OFFERED, CLOSED,
    today, parisHour, isoDay, addDays, daysBetween, week, fmtDay, fmtLong, fmtWeekday, fmtStamp, fmtNum, fmtPct, plural,
    ICON, cleanBullet, intent,
  };
})();
