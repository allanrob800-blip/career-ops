/*
 * CapData: the page's data layer over the artifact `db` namespace (runtime contract 0.2.99).
 * One listener per query (snapshot / requests / handled collections, settings/prefs doc),
 * generation-safe snapshot assembly, change requests, preferences, handled messages.
 * Everything read from the db is untrusted data: this file never builds markup.
 */
(() => {
  'use strict';

  const DEFAULT_PREFS = Object.freeze({ weekly_goal: 3, accent: 'corail', reduced_motion: false });
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

  const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const str = (v) => (typeof v === 'string' ? v : null);

  function normPrefs(body) {
    const out = { ...DEFAULT_PREFS };
    if (isObj(body)) {
      if (Number.isInteger(body.weekly_goal) && body.weekly_goal >= 1 && body.weekly_goal <= 100) out.weekly_goal = body.weekly_goal;
      if (typeof body.accent === 'string' && body.accent && body.accent.length <= 32) out.accent = body.accent;
      if (typeof body.reduced_motion === 'boolean') out.reduced_motion = body.reduced_motion;
    }
    return out;
  }

  // Returns a complete Snapshot for the meta currently stored, or null while parts are missing/mixed.
  function assemble() {
    const meta = snapDocs && snapDocs.get('meta');
    if (!isObj(meta) || !Array.isArray(meta.parts) || meta.generation == null) return null;
    const out = { apps: [], offers: [], reports: [] };
    for (const path of meta.parts) {
      if (typeof path !== 'string') return null;
      const id = path.split('/')[1];
      const part = id && snapDocs.get(id);
      if (!isObj(part) || part.generation !== meta.generation || !Array.isArray(part.items)) return null;
      const kind = id.replace(/-\d+$/, '');
      if (!(kind in out)) return null;
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
    let status;
    if (kept) status = 'ok';
    else if (failed) status = 'unavailable';
    else if (snapLive && snapDocs && !snapDocs.has('meta')) status = 'empty';
    else status = 'loading';
    return {
      status, snapshot: kept, pending: pendingList(), prefs: { ...(prefsCur || DEFAULT_PREFS) },
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
    listen('requests', (n, e) => db.collection('requests').onSnapshot(n, e), (qs) => { reqDocs = bodies(qs); });
    listen('handled', (n, e) => db.collection('handled').onSnapshot(n, e), (qs) => { handledBodies = bodies(qs); });
    listen('prefs', (n, e) => db.doc('settings/prefs').onSnapshot(n, e), (s) => { prefsBody = s.exists ? s.data() : null; prefsCur = normPrefs(prefsBody); });
  }

  function start(cb) {
    onChange = typeof cb === 'function' ? cb : null;
    if (started) { emit(); return; }
    started = true;
    emit();
    timer = setTimeout(() => { timer = null; if (!snapLive) { failed = true; emit(); } }, LOADING_MS);
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

  async function writeRequest(body) {
    const d = await getDb();
    const id = crypto.randomUUID();
    await serial(`requests/${id}`, () => writeWithRetry(() => d.collection('requests').doc(id).set(body)));
  }

  function checkRef(ref) {
    if (!Number.isInteger(ref) || ref < 1) throw new Error('Référence de candidature invalide');
  }

  function requestStatus(ref, to_status) {
    try {
      checkRef(ref);
      if (!STATUSES.includes(to_status)) throw new Error('Statut inconnu');
    } catch (e) { return Promise.reject(e); }
    return writeRequest({ type: 'status', ref, to_status, created_at: new Date().toISOString(), state: 'pending' });
  }

  function requestNote(ref, note) {
    try {
      checkRef(ref);
      if (typeof note !== 'string' || !note.trim()) throw new Error('Note vide');
      if (note.length > 500) throw new Error('Note trop longue (500 caractères maximum)');
      if (CONTROL.test(note)) throw new Error('Note : caractères de contrôle interdits');
    } catch (e) { return Promise.reject(e); }
    return writeRequest({ type: 'note', ref, note, created_at: new Date().toISOString(), state: 'pending' });
  }

  function savePrefs(partial) {
    try {
      if (!isObj(partial)) throw new Error('Préférences invalides');
      for (const [k, v] of Object.entries(partial)) {
        if (k === 'weekly_goal') { if (!Number.isInteger(v) || v < 1 || v > 100) throw new Error('Objectif hebdomadaire invalide'); }
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
    unsubs.splice(0).forEach((u) => { try { u(); } catch { /* ignore */ } });
    onChange = null;
  }

  globalThis.CapData = { start, stop, getState: currentState, requestStatus, requestNote, savePrefs, markHandled, handledIds, encodeSeg, STATUSES };
})();
