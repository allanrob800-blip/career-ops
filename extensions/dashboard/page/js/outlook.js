/*
 * CapOutlook: live, read-only Outlook through the artifact `mcp` capability (connector « Microsoft 365 »).
 * One watch per identity: five keyword searches, at most ten company domains, one calendar window.
 * It merges their results into one state for the screens. Display only: the page declares and uses the two
 * search tools and nothing else; it never sends, drafts, moves or deletes anything.
 * Everything received is untrusted data: this file never builds markup.
 */
(() => {
  'use strict';

  const SERVER = 'Microsoft 365';
  const MAIL = 'outlook_email_search';
  const CAL = 'outlook_calendar_search';
  const KEYWORDS = ['candidature', 'entretien', 'recrutement', 'interview', 'recruiter'];
  const PRIORITY = new Set(['Applied', 'Responded', 'Assessment', 'Interview', 'Offer']);
  const MAX_DOMAINS = 10;
  const LIMIT = 25;
  const REFETCH_MS = 300000;
  const LOADING_MS = 10000; // a section with no answer after this says Outlook is not answering
  const DAY_MS = 86400000;
  const HOUR_MS = 3600000;
  const PARIS = 'Europe/Paris';

  // ---- failure doctrine: branch on error.code, never on the message ----
  const CODES = new Set(['needs_reauth', 'server_not_connected', 'selection_required', 'server_not_found', 'server_unavailable',
    'not_in_manifest', 'blocked_by_policy', 'self_only', 'approval_required', 'tool_error', 'bad_request', 'cancelled', 'rate_limited',
    'upstream_error', 'not_granted', 'capability_disabled', 'capability_removed', 'transform_error', 'consent_required', 'user_changed']);
  const ABSENT = new Set(['not_granted', 'capability_disabled', 'capability_removed']); // same as no `mcp` at all
  const APPROVAL = new Set(['approval_required', 'consent_required']);
  // Authorization denials retract what is shown. `self_only` (owner-only page) and `user_changed` (another
  // account) are not in the doctrine's list: they retract too, which is the safe reading.
  const RETRACT = new Set([...ABSENT, ...APPROVAL, 'needs_reauth', 'server_not_connected', 'server_not_found', 'selection_required',
    'blocked_by_policy', 'not_in_manifest', 'self_only', 'user_changed']);
  const TEXT = {
    absent: 'Outlook n\'est pas accessible depuis cet appareil.',
    reauth: 'Reconnectez Microsoft 365 dans claude.ai → Réglages → Connecteurs.',
    connect: 'Ajoutez le connecteur Microsoft 365 dans claude.ai → Réglages → Connecteurs.',
    approve: 'Autorisez l\'accès à Outlook pour afficher vos messages.',
    denied: 'L\'accès à Outlook n\'est pas autorisé pour cette page.',
    transient: 'Outlook ne répond pas pour l\'instant.',
  };
  function reasonFor(code) {
    if (ABSENT.has(code)) return TEXT.absent;
    if (code === 'needs_reauth') return TEXT.reauth;
    if (code === 'server_not_connected' || code === 'server_not_found' || code === 'selection_required') return TEXT.connect;
    if (APPROVAL.has(code)) return TEXT.approve;
    if (code === 'not_in_manifest' || code === 'blocked_by_policy' || code === 'self_only') return TEXT.denied;
    return TEXT.transient;
  }
  const codeOf = (err) => (err && typeof err.code === 'string' && CODES.has(err.code) ? err.code : 'upstream_error');

  // ---- defensive readers ----
  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const text = (v, max = 400) => (typeof v === 'string' ? v : typeof v === 'number' && Number.isFinite(v) ? String(v) : '').slice(0, max);
  const ARRAY_KEYS = ['value', 'items', 'results', 'messages', 'events'];

  // Ruling R12: the items may arrive as one array (payload / structuredContent) or as one text block per item.
  function itemsOf(result) {
    if (!isObj(result)) return [];
    const sources = [result.structuredContent, result.payload];
    let list = sources.find(Array.isArray) || null;
    if (!list) {
      for (const src of sources) {
        const key = isObj(src) ? ARRAY_KEYS.find((k) => Array.isArray(src[k])) : null;
        if (key) { list = src[key]; break; }
      }
    }
    if (!list) {
      list = [];
      for (const block of Array.isArray(result.content) ? result.content : []) {
        if (!isObj(block) || block.type !== 'text' || typeof block.text !== 'string') continue;
        let v;
        try { v = JSON.parse(block.text); } catch { continue; }
        if (Array.isArray(v)) for (const x of v) list.push(x);
        else if (isObj(v)) list.push(v);
      }
    }
    return list.filter((o) => isObj(o) && !(('moreResults' in o || 'nextOffset' in o) && !('id' in o) && !('subject' in o)));
  }

  // An address field: a string, or {address, name} / {emailAddress: {address, name}}.
  function party(v) {
    if (typeof v === 'string') return { address: text(v, 320), name: '' };
    if (!isObj(v)) return { address: '', name: '' };
    const e = isObj(v.emailAddress) ? v.emailAddress : v;
    return { address: text(e.address, 320), name: text(e.name, 200) };
  }

  // ---- time: {dateTime, timeZone} is a wall-clock pair, never reinterpreted as UTC ----
  const WINDOWS_TZ = { utc: 'UTC', 'romance standard time': 'Europe/Paris', 'w. europe standard time': 'Europe/Berlin',
    'central europe standard time': 'Europe/Budapest', 'central european standard time': 'Europe/Warsaw', 'gmt standard time': 'Europe/London' };
  const WALL = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?(?:[.,]\d+)?)?\s*(Z|[+-]\d{2}:?\d{2})?$/i;
  const fmtCache = new Map();
  function partsIn(tz, ms) {
    let f = fmtCache.get(tz);
    if (!f) {
      f = new Intl.DateTimeFormat('en-CA', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' });
      fmtCache.set(tz, f);
    }
    const p = {};
    for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
    return p;
  }
  function ianaZone(tz) {
    if (typeof tz !== 'string' || !tz.trim()) return null;
    const z = WINDOWS_TZ[tz.trim().toLowerCase()] || tz.trim();
    try { partsIn(z, 0); return z; } catch { return null; }
  }
  // Offset (ms) of `tz` from UTC at the instant `ms`.
  function offsetAt(tz, ms) {
    const p = partsIn(tz, ms);
    return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute, +p.second) - Math.floor(ms / 1000) * 1000;
  }
  // -> {dateTime, timeZone, ms, day 'YYYY-MM-DD', time 'HH:MM'|null, zone label|null} or null when unreadable.
  function when(v) {
    const dateTime = typeof v === 'string' ? v : isObj(v) ? (typeof v.dateTime === 'string' ? v.dateTime : typeof v.date === 'string' ? v.date : null) : null;
    const timeZone = isObj(v) && typeof v.timeZone === 'string' && v.timeZone.trim() ? v.timeZone.trim().slice(0, 40) : null;
    const m = dateTime ? WALL.exec(dateTime.trim()) : null;
    if (!m) return null;
    const wall = Date.UTC(+m[1], +m[2] - 1, +m[3], +(m[4] || 0), +(m[5] || 0), +(m[6] || 0));
    if (Number.isNaN(wall) || +m[2] < 1 || +m[2] > 12 || +m[3] < 1 || +m[3] > 31 || +(m[4] || 0) > 23 || +(m[5] || 0) > 59) return null;
    const hasTime = m[4] != null;
    if (m[7]) { // an explicit offset is an instant: shown in Paris time
      const o = /^z$/i.test(m[7]) ? 0 : (m[7][0] === '-' ? -1 : 1) * (+m[7].slice(1, 3) * 60 + +m[7].slice(-2)) * 60000;
      const ms = wall - o;
      const p = partsIn(PARIS, ms);
      return { dateTime, timeZone, ms, day: `${p.year}-${p.month}-${p.day}`, time: hasTime ? `${p.hour}:${p.minute}` : null, zone: null };
    }
    const tz = ianaZone(timeZone);
    const zoneUsed = tz || PARIS; // no usable zone: read as the candidate's own time
    let ms = wall - offsetAt(zoneUsed, wall);
    ms = wall - offsetAt(zoneUsed, ms); // second pass settles daylight-saving edges
    const sameAsParis = !timeZone || (tz && offsetAt(tz, ms) === offsetAt(PARIS, ms));
    return { dateTime, timeZone, ms, day: `${m[1]}-${m[2]}-${m[3]}`, time: hasTime ? `${m[4]}:${m[5]}` : null, zone: sameAsParis ? null : timeZone };
  }

  // ---- state ----
  let onChange = null;
  let started = false;
  let mcp; // undefined until claude.use('mcp') settles, then the namespace or null
  let companies = [];
  let mailAfter = null;
  const watches = []; // {section, tool, input, key, domain, items: array|null, storedAt: ms|null, error: code|null, off}
  const busy = { mail: false, calendar: false };
  let lastSig = null;
  let waited = false; // LOADING_MS have passed since start

  function cleanCompanies(list) {
    const out = [];
    for (const c of Array.isArray(list) ? list : []) {
      if (!isObj(c) || typeof c.name !== 'string' || !c.name) continue;
      out.push({
        name: c.name, norm: typeof c.norm === 'string' ? c.norm : '',
        domains: (Array.isArray(c.domains) ? c.domains : []).filter((d) => typeof d === 'string' && /^(?=.{4,253}$)[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(d)),
      });
    }
    return out;
  }

  // Companies with an application in progress first (stable): they get the ten domain watches first.
  function rank(list, apps) {
    const hot = new Set();
    for (const a of Array.isArray(apps) ? apps : []) if (isObj(a) && PRIORITY.has(a.status) && typeof a.company === 'string') hot.add(a.company);
    const all = Array.isArray(list) ? list.filter(isObj) : [];
    return [...all.filter((c) => hot.has(c.name)), ...all.filter((c) => !hot.has(c.name))];
  }

  const sortedKeys = (k, v) => (isObj(v) ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, v[key]])) : v);

  // Freshness comes from result.cache.storedAt (epoch ms); a result without a usable stamp is fresh.
  function stampOf(result) {
    const v = isObj(result) && isObj(result.cache) ? result.cache.storedAt : null;
    return Number.isFinite(v) && v > 0 && v <= Date.now() + DAY_MS ? v : Date.now();
  }

  function onEvent(w, ev) {
    if (!isObj(ev)) return;
    if (ev.type === 'data') {
      w.items = itemsOf(ev.result);
      w.storedAt = stampOf(ev.result);
      w.error = null;
    } else if (ev.type === 'error') {
      const code = codeOf(ev.error);
      if (code === 'cancelled') return; // an abandoned refetch says nothing about Outlook
      w.error = code;
      // A denial concerns the whole section: drop what its other watches hold too, so nothing stale comes back.
      if (RETRACT.has(code)) for (const x of watches) if (x.section === w.section) { x.items = null; x.storedAt = null; }
    } else return;
    emit();
  }

  // Registers one watch per (tool, input) identity: a duplicate registration is `bad_request`.
  function register(section, tool, input) {
    const key = JSON.stringify([tool, input], sortedKeys);
    if (watches.some((w) => w.key === key)) return null;
    const w = { section, tool, input, key, domain: null, items: null, storedAt: null, error: null, off: null };
    watches.push(w);
    try { w.off = mcp.watchTool(SERVER, tool, input, (ev) => onEvent(w, ev), { refetchInterval: REFETCH_MS }); }
    catch (e) { console.error('CapOutlook: watch registration failed', e); w.error = 'upstream_error'; }
    return w;
  }

  function registerDomains() {
    if (!mcp) return;
    for (const c of companies) {
      if (watches.filter((w) => w.domain).length >= MAX_DOMAINS) return;
      const d = c.domains[0];
      if (!d || watches.some((w) => w.domain === d)) continue;
      const w = register('mail', MAIL, { sender: d, afterDateTime: mailAfter, limit: LIMIT });
      if (w) w.domain = d;
    }
  }

  function registerAll() {
    const now = Date.now();
    // Day / hour boundaries keep each watch identity stable, so a reload replays the cache instead of refetching.
    mailAfter = new Date(Math.floor((now - 30 * DAY_MS) / DAY_MS) * DAY_MS).toISOString();
    for (const query of KEYWORDS) register('mail', MAIL, { query, afterDateTime: mailAfter, limit: LIMIT });
    registerDomains();
    const from = Math.floor(now / HOUR_MS) * HOUR_MS;
    register('calendar', CAL, { query: '*', afterDateTime: new Date(from).toISOString(), beforeDateTime: new Date(from + 14 * DAY_MS).toISOString(), order: 'oldest', limit: LIMIT });
  }

  // ---- derived state ----
  const LOADING = { status: 'loading', reason: null, code: null };
  const SILENT = { status: 'error', reason: TEXT.transient, code: null };
  function sectionState(name) {
    if (mcp === undefined) return waited ? SILENT : LOADING;
    if (mcp === null) return { status: 'unavailable', reason: TEXT.absent, code: null };
    const ws = watches.filter((w) => w.section === name);
    const errs = ws.filter((w) => w.error).map((w) => w.error);
    const block = errs.find((c) => ABSENT.has(c)) || errs.find((c) => RETRACT.has(c));
    if (block) return { status: ABSENT.has(block) ? 'unavailable' : 'error', reason: reasonFor(block), code: block, canAuthorize: APPROVAL.has(block) };
    const got = ws.filter((w) => w.items !== null);
    if (!got.length) return errs.length ? { status: 'error', reason: TEXT.transient, code: errs[0] } : waited ? SILENT : LOADING;
    const stale = errs.length > 0; // transient failure: last good data stays, marked as possibly out of date
    return {
      status: 'ok', reason: stale ? TEXT.transient : null, code: stale ? errs[0] : null, stale,
      partial: ws.some((w) => w.items === null && !w.error),
      storedAt: new Date(Math.min(...got.map((w) => w.storedAt))).toISOString(),
      items: got.flatMap((w) => w.items),
    };
  }

  function messagesOf(items) {
    const handled = globalThis.CapData ? CapData.handledIds() : new Set();
    const seen = new Set();
    const out = [];
    for (const o of items) {
      if (typeof o.id !== 'string' || !o.id || o.id.length > 1000 || seen.has(o.id)) continue;
      seen.add(o.id);
      const from = party(o.sender);
      const m = {
        id: o.id, subject: text(o.subject), sender: from.address, senderName: text(o.senderName, 200) || from.name,
        receivedDateTime: text(o.receivedDateTime, 40), summary: text(o.summary, 600),
        webLink: typeof o.webLink === 'string' && o.webLink.length <= 2048 ? o.webLink : null,
      };
      m.company = CapMatch.matchCompany({ sender: m.sender, senderName: m.senderName, subject: m.subject }, companies);
      if (m.company === null && !CapMatch.isJobRelated({ subject: m.subject, text: m.summary })) continue;
      m.handled = handled.has(m.id);
      out.push(m);
    }
    const t = (m) => { const v = Date.parse(m.receivedDateTime); return Number.isNaN(v) ? -Infinity : v; };
    return out.sort((a, b) => t(b) - t(a)); // `order: newest` is not applied with `query`: sorted here
  }

  function eventsOf(items) {
    const seen = new Set();
    const out = [];
    for (const o of items) {
      const start = when(o.start);
      if (!start) continue;
      const subject = text(o.subject) || text(o.title);
      const key = typeof o.id === 'string' && o.id ? o.id : `${subject}|${start.dateTime}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const org = party(o.organizer);
      const fields = { subject, sender: org.address, senderName: org.name, text: text(o.summary) || text(o.bodyPreview) || text(o.description) };
      if (!CapMatch.isInterviewEvent(fields, companies)) continue;
      const end = when(o.end);
      const place = typeof o.location === 'string' ? o.location : isObj(o.location) ? o.location.displayName : null;
      out.push({
        subject, start: { dateTime: start.dateTime, timeZone: start.timeZone }, end: end ? { dateTime: end.dateTime, timeZone: end.timeZone } : null,
        location: text(place, 300) || null, company: CapMatch.matchCompany(fields, companies),
        webLink: typeof o.webLink === 'string' && o.webLink.length <= 2048 ? o.webLink : null,
        startMs: start.ms, day: start.day, time: o.isAllDay === true ? null : start.time, endTime: end && o.isAllDay !== true ? end.time : null, zone: start.zone,
      });
    }
    return out.sort((a, b) => a.startMs - b.startMs);
  }

  function publicSection(s, name) {
    return {
      status: s.status, reason: s.reason, code: s.code || null, stale: !!s.stale, partial: !!s.partial,
      storedAt: s.storedAt || null, canAuthorize: !!s.canAuthorize, authorizing: busy[name],
    };
  }

  function getState() {
    const m = sectionState('mail');
    const c = sectionState('calendar');
    const mail = publicSection(m, 'mail');
    const calendar = publicSection(c, 'calendar');
    const both = [mail, calendar];
    const status = mail.status === calendar.status ? mail.status
      : both.some((s) => s.status === 'ok') ? 'ok'
        : both.some((s) => s.status === 'loading') ? 'loading' : 'error';
    const first = both.find((s) => s.reason) || {};
    const stamps = both.map((s) => s.storedAt).filter(Boolean).sort();
    return {
      status, reason: status === 'ok' && !both.some((s) => s.stale) ? null : first.reason || null,
      messages: m.status === 'ok' ? messagesOf(m.items) : [],
      events: c.status === 'ok' ? eventsOf(c.items) : [],
      storedAt: stamps[0] || null, stale: both.some((s) => s.stale),
      mail, calendar,
    };
  }

  function emit() {
    if (!onChange) return;
    const state = getState();
    const sig = JSON.stringify(state);
    if (sig === lastSig) return;
    lastSig = sig;
    try { onChange(state); } catch (e) { console.error('CapOutlook onChange failed', e); }
  }

  // ---- public API ----
  function start(list, cb) {
    companies = cleanCompanies(list);
    onChange = typeof cb === 'function' ? cb : null;
    if (started) { emit(); return; }
    started = true;
    emit(); // 'loading'
    setTimeout(() => { waited = true; emit(); }, LOADING_MS);
    (async () => {
      let ns = null;
      try { ns = globalThis.claude ? await globalThis.claude.use('mcp') : null; } catch { ns = null; }
      mcp = ns && typeof ns.watchTool === 'function' ? ns : null;
      if (mcp) registerAll();
      emit();
    })();
  }

  // New snapshot or new handled ids: re-derive, and watch the domains that were not watched yet.
  function update(list) {
    if (!started) return;
    companies = cleanCompanies(list);
    registerDomains();
    emit();
  }

  // The « Autoriser Outlook » button: a watch never asks for approval, so the click makes the same call once.
  function authorize(section) {
    const name = section === 'calendar' ? 'calendar' : 'mail';
    const w = watches.find((x) => x.section === name && APPROVAL.has(x.error));
    if (!mcp || !w || busy[name] || typeof mcp.callTool !== 'function') return Promise.resolve();
    busy[name] = true;
    let call;
    try { call = mcp.callTool(SERVER, w.tool, w.input); } catch (e) { call = Promise.reject(e); } // still inside the click
    emit();
    return Promise.resolve(call).then((result) => {
      w.items = itemsOf(result);
      w.storedAt = stampOf(result);
      for (const x of watches) if (x.tool === w.tool && APPROVAL.has(x.error)) x.error = null; // granted: they refetch below
      try { if (typeof mcp.invalidate === 'function') mcp.invalidate(SERVER, w.tool); } catch (e) { console.error('CapOutlook: invalidate failed', e); }
    }, (err) => {
      const code = codeOf(err);
      if (code !== 'cancelled') w.error = code; // refused or failed: the code decides what the screen says
    }).then(() => { busy[name] = false; emit(); });
  }

  globalThis.CapOutlook = { start, update, authorize, rank, getState, itemsOf, when, SERVER, TOOLS: [MAIL, CAL] };
})();
