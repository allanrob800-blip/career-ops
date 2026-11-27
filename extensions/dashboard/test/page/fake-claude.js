/*
 * Fake `window.claude` for page tests (injected before page scripts).
 * Mirrors the real claude.ai artifact runtime contract 0.2.99 for the `db` and `user` namespaces
 * (see .superpowers/sdd/.../db-api.md). The `mcp` namespace is still an ASSUMED shape (Task 10).
 *
 * State:  window.__fake = { db: {docs: {'snapshot/meta': {...}, 'requests/abc': {...}}},
 *                           mcp: {mode: 'ok'|'null'|'error', emails: [...], events: [...]},
 *                           user: {id: 'u1'} }      (a missing/partial `db` or `db.docs` is normalized)
 * Calls:  window.__calls = [{ns, fn, args}] — every fake API call, in order.
 * API:
 *   claude.use(name) -> Promise<namespace|null>   ('db' | 'mcp' | 'user'; mcp is null when mode==='null'; unknown -> null)
 *   db (frozen): doc(path) / collection(path) THROW TypeError on a bad path (document = even segment count,
 *        collection = odd; segment chars [A-Za-z0-9_-.~:@+], not '.'/'..', <=200 bytes; <=16 segments, <=1000 bytes).
 *   DocumentReference {id, path, get(), set(data), update(data), delete(), onSnapshot(next, error?), collection(sub)}
 *        get() -> DocumentSnapshot {id, exists, data() (METHOD; body or undefined), metadata:{fromCache:false, hasPendingWrites:false}} (frozen)
 *        set replaces (creates); update merges recursively (arrays replace) and REJECTS {code:'invalid_argument'} if the doc is missing.
 *   CollectionReference {id, path, doc(id?) (mints an id), add(data), where, orderBy, limit, get(), onSnapshot(next, error?)}
 *        QuerySnapshot {docs, size, empty, docChanges(), metadata}; docs ordered by id unless orderBy.
 *   onSnapshot fires asynchronously (microtask, independent of timers) on subscribe, then only when a document
 *        under the listener's own path changes (a doc listener: that doc; a collection listener: its direct children).
 *   mcp.watchTool(server, tool, input, handler, opts) -> unsubscribe fn. Async calls
 *        handler({type:'data', result:{payload:[...]}, cache:{storedAt}}) (payload = emails for
 *        tools whose name contains 'mail'/'search_mail', else events), or
 *        handler({type:'error', error:{code:'fake_error', retryable:true}}) when mode==='error'.
 *   mcp.callTool(server, tool, input) -> Promise<{payload:[...]}> (rejects with {code, retryable} in error mode)
 *   user: id() -> Promise<'u1'>, can(cap) -> true, canEdit() -> true, isOwner() -> true
 */
(() => {
  const fake = (window.__fake = window.__fake || {});
  fake.db = fake.db || {};
  fake.db.docs = fake.db.docs || {};
  fake.mcp = fake.mcp || { mode: 'ok', emails: [], events: [] };
  fake.user = fake.user || { id: 'u1' };
  window.__calls = [];

  const rec = (ns, fn, args) => window.__calls.push({ ns, fn, args: JSON.parse(JSON.stringify(args, (k, v) => (typeof v === 'function' ? '[fn]' : v)) || []) });
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const docs = () => { fake.db = fake.db || {}; return (fake.db.docs = fake.db.docs || {}); }; // harness may replace fake.db after init
  const fail = (code, message) => Promise.reject({ code, message });
  const isPlain = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);
  const deepFreeze = (v) => { if (v && typeof v === 'object') { Object.values(v).forEach(deepFreeze); Object.freeze(v); } return v; };

  // ---- path grammar ----
  const SEG = /^[A-Za-z0-9_\-.~:@+]+$/;
  const bytes = (s) => new TextEncoder().encode(s).length;
  function segments(path, wantEven) {
    if (typeof path !== 'string' || !path) throw new TypeError('db: path must be a non-empty string');
    const segs = path.split('/');
    if (segs.length > 16 || bytes(path) > 1000) throw new TypeError('db: path too long');
    for (const s of segs) {
      if (!SEG.test(s) || s === '.' || s === '..' || bytes(s) > 200) throw new TypeError(`db: invalid path segment "${s}"`);
    }
    if ((segs.length % 2 === 0) !== wantEven) throw new TypeError(`db: "${path}" is not a ${wantEven ? 'document' : 'collection'} path`);
    return segs;
  }

  // ---- snapshots (cached per path+version so unchanged docs keep identity) ----
  const versions = {};
  const bump = (path) => { versions[path] = (versions[path] || 0) + 1; };
  const snapCache = new Map();
  function docSnap(path) {
    const v = versions[path] || 0;
    const hit = snapCache.get(path);
    if (hit && hit.v === v) return hit.snap;
    const exists = path in docs();
    const body = exists ? deepFreeze(clone(docs()[path])) : undefined;
    const snap = Object.freeze({
      id: path.split('/').pop(), exists, data: () => body,
      metadata: Object.freeze({ fromCache: false, hasPendingWrites: false }),
    });
    snapCache.set(path, { v, snap });
    return snap;
  }
  const childPaths = (path) => Object.keys(docs()).filter((k) => k.startsWith(path + '/') && !k.slice(path.length + 1).includes('/'));

  // ---- listeners: only notified for writes under their own path ----
  const listeners = new Set(); // {kind:'doc'|'col', path, fire}
  function changed(path) {
    const parent = path.slice(0, path.lastIndexOf('/'));
    for (const l of listeners) if ((l.kind === 'doc' && l.path === path) || (l.kind === 'col' && l.path === parent)) Promise.resolve().then(l.fire);
  }
  function subscribe(kind, path, read, next, error) {
    if (typeof next !== 'function') throw new TypeError('db: onSnapshot needs a callback');
    let live = true;
    const l = { kind, path, fire: () => { if (!live) return; try { next(read()); } catch (e) { if (typeof error === 'function') error({ code: 'unavailable', message: String(e) }); } } };
    listeners.add(l);
    Promise.resolve().then(l.fire);
    return () => { live = false; listeners.delete(l); };
  }

  const validBody = (data) => {
    if (!isPlain(data)) throw { code: 'invalid_argument', message: 'body must be a plain object' };
    let json;
    try { json = JSON.stringify(data); } catch { throw { code: 'invalid_argument', message: 'body is not JSON' }; }
    if (bytes(json) > 256 * 1024) throw { code: 'resource_exhausted', message: 'body too large' };
    return JSON.parse(json);
  };
  function merge(base, patch) {
    const out = { ...base };
    for (const [k, v] of Object.entries(patch)) out[k] = isPlain(v) && isPlain(out[k]) ? merge(out[k], v) : v;
    return out;
  }

  function doc(path) {
    const segs = segments(path, true);
    const write = (fn, body) => { docs()[path] = body; bump(path); changed(path); };
    return Object.freeze({
      id: segs[segs.length - 1], path,
      async get() { rec('db', 'doc.get', [path]); return docSnap(path); },
      async set(data) { rec('db', 'doc.set', [path, data]); let b; try { b = validBody(data); } catch (e) { return Promise.reject(e); } write('set', b); },
      async update(data) {
        rec('db', 'doc.update', [path, data]);
        let b; try { b = validBody(data); } catch (e) { return Promise.reject(e); }
        if (!(path in docs())) return fail('invalid_argument', 'document does not exist');
        write('update', merge(docs()[path], b));
      },
      async delete() { rec('db', 'doc.delete', [path]); if (path in docs()) { delete docs()[path]; bump(path); changed(path); } },
      onSnapshot(next, error) { rec('db', 'doc.onSnapshot', [path]); return subscribe('doc', path, () => docSnap(path), next, error); },
      collection(sub) { return collection(path + '/' + sub); },
    });
  }

  function query(path, ops) {
    const run = () => {
      let list = childPaths(path).map((p) => docSnap(p));
      for (const [f, op, val] of ops.where) {
        const cmp = { '==': (a) => a === val, '!=': (a) => a !== val, '<': (a) => a < val, '<=': (a) => a <= val, '>': (a) => a > val, '>=': (a) => a >= val }[op];
        if (!cmp) throw new TypeError(`db: unsupported operator ${op}`);
        list = list.filter((s) => cmp((s.data() || {})[f]));
      }
      list.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
      if (ops.order) {
        const { f, dir } = ops.order;
        list.sort((a, b) => { const x = (a.data() || {})[f], y = (b.data() || {})[f]; return (x < y ? -1 : x > y ? 1 : 0) * (dir === 'desc' ? -1 : 1); });
      }
      if (ops.limit != null) list = list.slice(0, ops.limit);
      return list;
    };
    let prev = null;
    const read = () => {
      const list = run();
      const before = prev || [];
      const changes = [];
      list.forEach((d, i) => { const o = before.indexOf(d); if (o === -1) changes.push({ type: 'added', doc: d, oldIndex: -1, newIndex: i }); });
      before.forEach((d, o) => { if (!list.includes(d)) changes.push({ type: 'removed', doc: d, oldIndex: o, newIndex: -1 }); });
      prev = list;
      return Object.freeze({ docs: Object.freeze(list), size: list.length, empty: list.length === 0, docChanges: () => changes, metadata: Object.freeze({ fromCache: false, hasPendingWrites: false }) });
    };
    return {
      where: (f, op, val) => query(path, { ...ops, where: [...ops.where, [f, op, val]] }),
      orderBy: (f, dir) => query(path, { ...ops, order: { f, dir } }),
      limit: (n) => query(path, { ...ops, limit: n }),
      async get() { rec('db', 'collection.get', [path]); return read(); },
      onSnapshot(next, error) { rec('db', 'collection.onSnapshot', [path]); return subscribe('col', path, read, next, error); },
    };
  }
  let idSeq = 0;
  function collection(path) {
    const segs = segments(path, false);
    return Object.freeze({
      ...query(path, { where: [] }),
      id: segs[segs.length - 1], path,
      doc(id) { return doc(path + '/' + (id === undefined ? `auto${Date.now().toString(36)}${(idSeq++).toString(36)}` : id)); },
      async add(data) { rec('db', 'collection.add', [path, data]); const ref = this.doc(); await ref.set(data); return ref; },
    });
  }
  const db = Object.freeze({ doc, collection });

  const mcp = {
    watchTool(server, tool, input, handler, opts) {
      rec('mcp', 'watchTool', [server, tool, input, opts]);
      let live = true;
      setTimeout(() => {
        if (!live) return;
        if (fake.mcp.mode === 'error') handler({ type: 'error', error: { code: 'fake_error', retryable: true } });
        else handler({ type: 'data', result: { payload: clone(payloadFor(tool)) }, cache: { storedAt: new Date().toISOString() } });
      }, 0);
      return () => { live = false; };
    },
    async callTool(server, tool, input) {
      rec('mcp', 'callTool', [server, tool, input]);
      if (fake.mcp.mode === 'error') throw { code: 'fake_error', retryable: true };
      return { payload: clone(payloadFor(tool)) };
    },
  };
  const user = Object.freeze({ id: async () => fake.user.id, can: () => true, canEdit: () => true, isOwner: () => true });

  window.claude = {
    async use(name) {
      rec('claude', 'use', [name]);
      if (name === 'db') return db;
      if (name === 'user') return user;
      if (name === 'mcp') return fake.mcp.mode === 'null' ? null : mcp;
      return null;
    },
  };
})();
