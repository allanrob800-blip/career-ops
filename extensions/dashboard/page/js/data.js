/*
 * CapData: the page's data layer over the artifact `db` namespace (runtime contract 0.2.99).
 * One listener per query (snapshot / requests / handled collections, settings/prefs doc),
 * generation-safe snapshot assembly, change requests, preferences, handled messages.
 * Everything read from the db is untrusted data: this file never builds markup.
 */
(() => {
  'use strict';

  const DEFAULT_PREFS = Object.freeze({ weekly_goal: 3, accent: 'corail', reduced_motion: false });
  const GOAL_MIN = 1, GOAL_MAX = 10; // the settings screen's range
  const STATUSES = ['Evaluated', 'Speculative', 'Applied', 'Responded', 'Assessment', 'Interview', 'Offer', 'Hired', 'Rejected', 'Discarded', 'SKIP'];
  const CONTROL = /[\u0000-\u001F\u007F]/;
  const LOADING_MS = 10000;
  const RECENT_MS = 7 * 86400000;

  let onChange = null;
  let db = null;
  let started = false;
  let readyResolve;
  let ready = new Promise((r) => { readyResolve = r; });
  let timer = null;
  let ceiling = null; // the 10 s loading ceiling, independent of listener deliveries
  let ceilingPassed = false;
  const unsubs = [];

  // raw listener results
  let snapDocs = null; // Map id -> body, null until the first delivery
  let snapLive = false; // a delivery with fromCache:false (or an error) has been seen
  let reqDocs = new Map();
  let handledBodies = new Map();
  let prefsBody = null;
  let kept = null; // last complete, generation-consistent Snapshot
  let failed = false; // terminal listener error / timeout with nothing to show
  let prefsCur = null; // last known prefs (listener or own write)
  let prefsSeen = false; // the prefs listener has delivered: `prefs` is the stored value, not a default

  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const str = (v) => (typeof v === 'string' ? v : null);

  function normPrefs(body) {
    const out = { ...DEFAULT_PREFS };
    if (isObj(body)) {
      if (Number.isInteger(body.weekly_goal)) out.weekly_goal = Math.min(GOAL_MAX, Math.max(GOAL_MIN, body.weekly_goal));
      if (typeof body.accent === 'string' && body.accent && body.accent.length <= 32) out.accent = body.accent;
      if (typeof body.reduced_motion === 'boolean') out.reduced_motion = body.reduced_motion;
    }
    return out;
  }

  // Returns a complete Snapshot for the meta currently stored, or null while parts are missing/mixed.
  function assemble() {
    const meta = snapDocs && snapDocs.get('meta');
    if (!isObj(meta) || !Array.isArray(meta.parts) || meta.generation == null) return null;
    const out = { apps: [], offers: [], reports: [], proposals: [] };
    for (const path of meta.parts) {
      if (typeof path !== 'string') return null;
      const id = path.split('/')[1];
      const kind = id ? id.split('-')[0] : ''; // <kind>-<genId>-<n> (or the older <kind>-<n>)
      // a kind this page does not know (written by a newer export) is skipped, never a blank page
      if (!Object.hasOwn(out, kind)) continue;
      const part = snapDocs.get(id);
      if (!isObj(part) || part.generation !== meta.generation || !Array.isArray(part.items)) return null;
      out[kind] = out[kind].concat(part.items);
    }
    const { parts, ...rest } = meta;
    return { ...rest, ...out };
  }

  function pendingList() {
    const now = Date.now();
    const list = [];
    for (const [id, b] of reqDocs) {
      if (!isObj(b)) continue;
      const state = str(b.state) || 'pending';
      if (state !== 'pending') {
        const t = Date.parse(str(b.applied_at) || str(b.created_at) || '');
        if (!(now - t <= RECENT_MS)) continue;
      }
      list.push({
        id, type: str(b.type), ref: Number.isInteger(b.ref) ? b.ref : null,
        to_status: str(b.to_status), note: str(b.note), created_at: str(b.created_at),
        state, reason: str(b.reason),
      });
    }
    return list.sort((a, b) => String(a.created_at).localeCompare(String(b.created_at)));
  }

  function currentState() {
    const cand = assemble();
    if (cand && (!kept || kept.generation !== cand.generation)) kept = cand;
    const meta = snapDocs && snapDocs.get('meta');
    let status;
    if (kept) status = 'ok';
    else if (failed) status = 'unavailable';
    else if (snapLive && snapDocs && !snapDocs.has('meta')) status = 'empty';
    // a meta whose parts never all arrived (a sync cut short): say so rather than load forever
    else if (ceilingPassed && isObj(meta)) status = 'incomplete';
    else status = 'loading';
    return {
      status, snapshot: kept, pending: pendingList(), prefs: { ...(prefsCur || DEFAULT_PREFS) },
      // what the stored meta alone tells (Outlook can start from its companies when no snapshot is complete)
      meta: isObj(meta) ? { generated_at: str(meta.generated_at), companies: Array.isArray(meta.companies) ? meta.companies : [] } : null,
      prefs_loaded: prefsSeen || failed,
      synced_at: kept ? str(kept.generated_at) : null,
      stale: failed && !!kept,
    };
  }

  function emit() {
    if (!onChange) return;
    try { onChange(currentState()); } catch (e) { console.error('CapData onChange failed', e); }
  }

  function clearTimer() { if (timer) { clearTimeout(timer); timer = null; } }

  function listen(label, subscribe, onNext, retried) {
    try {
      const un = subscribe((snap) => {
        try { onNext(snap); } catch (e) { console.error(`CapData ${label} handler failed`, e); }
        emit();
      }, (err) => {
        if (!retried && err && err.code === 'unavailable') {
          // one retry after a short random delay (contract: retry `unavailable` once)
          setTimeout(() => listen(label, subscribe, onNext, true), 300 + Math.random() * 700);
          return;
        }
        if (label === 'snapshot') { snapLive = true; clearTimer(); }
        failed = true;
        emit();
      });
      if (typeof un === 'function') unsubs.push(un);
    } catch (e) {
      console.error(`CapData ${label} subscribe failed`, e);
      failed = true;
    }
  }

  function bodies(qs) {
    const m = new Map();
    for (const d of qs.docs) m.set(d.id, d.data());
    return m;
  }

  function begin() {
    listen('snapshot', (n, e) => db.collection('snapshot').onSnapshot(n, e), (qs) => {
      snapDocs = bodies(qs);
      if (!qs.metadata || !qs.metadata.fromCache) { snapLive = true; failed = false; clearTimer(); }
    });
    listen('requests', (n, e) => db.collection('requests').onSnapshot(n, e), (qs) => { reqDocs = bodies(qs); for (const id of reqDocs.keys()) ownReqs.delete(id); });
    listen('handled', (n, e) => db.collection('handled').onSnapshot(n, e), (qs) => { handledBodies = bodies(qs); });
    listen('prefs', (n, e) => db.doc('settings/prefs').onSnapshot(n, e), (s) => { prefsBody = s.exists ? s.data() : null; prefsCur = normPrefs(prefsBody); prefsSeen = true; });
  }

  function start(cb) {
    onChange = typeof cb === 'function' ? cb : null;
    if (started) { emit(); return; }
    started = true;
    emit();
    timer = setTimeout(() => { timer = null; if (!snapLive) { failed = true; emit(); } }, LOADING_MS);
    ceiling = setTimeout(() => { ceiling = null; ceilingPassed = true; emit(); }, LOADING_MS);
    (async () => {
      let claude = null;
      try { claude = globalThis.claude || null; } catch { /* absent */ }
      try { db = claude ? await claude.use('db') : null; } catch { db = null; }
      readyResolve(db);
      if (!db) { clearTimer(); failed = true; emit(); return; }
      begin();
    })();
  }

  // ---- writes: one at a time per document path ----
  const chains = new Map();
  function serial(path, task) {
    const prev = chains.get(path) || Promise.resolve();
    const run = prev.then(task, task);
    const tail = run.catch(() => {});
    chains.set(path, tail);
    tail.then(() => { if (chains.get(path) === tail) chains.delete(path); });
    return run;
  }

  async function getDb() {
    const d = await ready;
    if (!d) throw new Error('Base de données indisponible');
    return d;
  }

  async function writeWithRetry(fn) {
    try { return await fn(); } catch (e) {
      if (e && e.code === 'unavailable') {
        await new Promise((r) => setTimeout(r, 300 + Math.random() * 700));
        return fn();
      }
      throw e;
    }
  }

  // Requests written by this page that the listener may not have delivered yet (id -> body).
  const ownReqs = new Map();

  // created_at of a request written by this page: strictly later than the previous one, even in the same
  // millisecond (expectedStatus reads the latest pending status request by created_at; a tie would fall to the
  // random request ids).
  let lastStamp = 0;
  function stamp() {
    const now = Date.now();
    lastStamp = now > lastStamp ? now : lastStamp + 1;
    return new Date(lastStamp).toISOString();
  }

  async function writeRequest(d, body) {
    const id = crypto.randomUUID();
    ownReqs.set(id, body);
    try { await serial(`requests/${id}`, () => writeWithRetry(() => d.collection('requests').doc(id).set(body))); }
    catch (e) { ownReqs.delete(id); throw e; }
  }

  // The status the row will have once Claude applies what is already asked: the target of its latest
  // still-pending status request, else its status in the snapshot. null when the row is unknown.
  function expectedStatus(ref) {
    let best = null;
    const seen = new Set();
    const consider = (id, b) => {
      if (seen.has(id)) return;
      seen.add(id);
      if (!isObj(b) || b.state !== 'pending' || b.type !== 'status' || b.ref !== ref || !STATUSES.includes(b.to_status)) return;
      const t = str(b.created_at) || '';
      if (!best || t > best.t || (t === best.t && id > best.id)) best = { t, id, to: b.to_status };
    };
    for (const [id, b] of reqDocs) consider(id, b);
    for (const [id, b] of ownReqs) consider(id, b);
    if (best) return best.to;
    const snap = kept || assemble();
    const app = snap && Array.isArray(snap.apps) ? snap.apps.find((a) => isObj(a) && a.num === ref) : null;
    return app && STATUSES.includes(app.status) ? app.status : null;
  }

  function checkRef(ref) {
    if (!Number.isInteger(ref) || ref < 1) throw new Error('Référence de candidature invalide');
  }

  // from_status is read and the request written one at a time, so a second request chains on the first.
  function requestStatus(ref, to_status) {
    try {
      checkRef(ref);
      if (!STATUSES.includes(to_status)) throw new Error('Statut inconnu');
    } catch (e) { return Promise.reject(e); }
    return getDb().then((d) => serial('requests:status', async () => {
      const from_status = expectedStatus(ref);
      if (!from_status) throw new Error('Candidature introuvable dans les données synchronisées');
      await writeRequest(d, { type: 'status', ref, from_status, to_status, created_at: stamp(), state: 'pending' });
    }));
  }

  // Text typed in a request field, as one line: a Return (any whitespace run) is one space, edges trimmed, 1 to 500
  // characters, no control character. Throws with `what` (« Note », « Texte ») in the message.
  function oneLine(raw, what) {
    if (typeof raw !== 'string') throw new Error(`${what} vide`);
    const t = raw.replace(/\s+/g, ' ').trim();
    if (!t) throw new Error(`${what} vide`);
    if (t.length > 500) throw new Error(`${what} trop longue (500 caractères maximum)`);
    if (CONTROL.test(t)) throw new Error(`${what} : caractères de contrôle interdits`);
    return t;
  }

  function requestNote(ref, raw) {
    let note;
    try {
      checkRef(ref);
      note = oneLine(raw, 'Note'); // a Return in the field is a space in the tracker's one-line cell
    } catch (e) { return Promise.reject(e); }
    return getDb().then((d) => writeRequest(d, { type: 'note', ref, note, created_at: stamp(), state: 'pending' }));
  }

  // why (« Pourquoi cette entreprise ? ») and retouche texts go to the dossier store, which refuses a line break.
  function requestText(type, ref, raw) {
    let text;
    try {
      checkRef(ref);
      text = oneLine(raw, 'Réponse');
    } catch (e) { return Promise.reject(e); }
    return getDb().then((d) => writeRequest(d, { type, ref, text, created_at: stamp(), state: 'pending' }));
  }
  const requestWhy = (ref, raw) => requestText('why', ref, raw);
  const requestRetouche = (ref, raw) => requestText('retouche', ref, raw);

  function savePrefs(partial) {
    try {
      if (!isObj(partial)) throw new Error('Préférences invalides');
      for (const [k, v] of Object.entries(partial)) {
        if (k === 'weekly_goal') { if (!Number.isInteger(v) || v < GOAL_MIN || v > GOAL_MAX) throw new Error('Objectif hebdomadaire invalide'); }
        else if (k === 'accent') { if (typeof v !== 'string' || !v || v.length > 32 || CONTROL.test(v)) throw new Error('Accent invalide'); }
        else if (k === 'reduced_motion') { if (typeof v !== 'boolean') throw new Error('Mouvement réduit invalide'); }
        else throw new Error(`Préférence inconnue : ${k}`);
      }
    } catch (e) { return Promise.reject(e); }
    return getDb().then((d) => serial('settings/prefs', async () => {
      let base = prefsCur;
      if (!base) { // no listener delivery yet: read the stored doc rather than assume defaults
        const snap = await d.doc('settings/prefs').get();
        base = normPrefs(snap.exists ? snap.data() : null);
        prefsBody = snap.exists ? snap.data() : null;
      }
      const merged = { ...base, ...partial };
      if (prefsBody && JSON.stringify(prefsBody) === JSON.stringify(merged)) return; // no real change
      await writeWithRetry(() => d.doc('settings/prefs').set(merged));
      prefsCur = merged;
    }));
  }

  // handled/ doc ids: chars outside [A-Za-z0-9_-] become ~ + 2-digit hex of each UTF-8 byte.
  function encodeSeg(id) {
    const enc = new TextEncoder();
    let out = '';
    for (const ch of String(id)) {
      if (/[A-Za-z0-9_-]/.test(ch)) out += ch;
      else for (const b of enc.encode(ch)) out += '~' + b.toString(16).padStart(2, '0');
    }
    if (out.length <= 200) return out;
    let h = 0x811c9dc5; // FNV-1a over the full encoded id
    for (let i = 0; i < out.length; i++) { h ^= out.charCodeAt(i); h = Math.imul(h, 0x01000193) >>> 0; }
    return out.slice(0, 150) + '~' + h.toString(16).padStart(8, '0');
  }

  function markHandled(messageId) {
    if (typeof messageId !== 'string' || !messageId || messageId.length > 1000 || CONTROL.test(messageId)) return Promise.reject(new Error('Identifiant de message invalide'));
    return getDb().then((d) => {
      const path = `handled/${encodeSeg(messageId)}`;
      return serial(path, async () => {
        if (handledIds().has(messageId)) return;
        await writeWithRetry(() => d.doc(path).set({ message_id: messageId, at: new Date().toISOString() }));
      });
    });
  }

  function handledIds() {
    const s = new Set();
    for (const b of handledBodies.values()) if (isObj(b) && typeof b.message_id === 'string') s.add(b.message_id);
    return s;
  }

  function stop() {
    clearTimer();
    if (ceiling) { clearTimeout(ceiling); ceiling = null; }
    unsubs.splice(0).forEach((u) => { try { u(); } catch { /* ignore */ } });
    onChange = null;
  }

  globalThis.CapData = { start, stop, getState: currentState, requestStatus, requestNote, requestWhy, requestRetouche, expectedStatus, savePrefs, markHandled, handledIds, encodeSeg, STATUSES };
})();
