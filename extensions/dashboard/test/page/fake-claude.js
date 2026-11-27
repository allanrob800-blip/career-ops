/*
 * Fake `window.claude` for page tests (injected before page scripts).
 *
 * State:  window.__fake = { db: {docs: {'snapshot/meta': {...}, 'requests/abc': {...}}},
 *                           mcp: {mode: 'ok'|'null'|'error', emails: [...], events: [...]},
 *                           user: {id: 'u1'} }
 * Calls:  window.__calls = [{ns, fn, args}] — every fake API call, in order.
 * API (ASSUMED shapes — Task 10 must reconcile with the real runtime):
 *   claude.use(name) -> Promise<namespace|null>   ('db' | 'mcp' | 'user'; mcp is null when mode==='null'; unknown -> null)
 *   db.doc(path).get()            -> Promise<{exists:boolean, data:object|undefined}>
 *   db.doc(path).set(data)        -> Promise<void>  (replaces)
 *   db.doc(path).update(patch)    -> Promise<void>  (shallow merge; creates when absent)
 *   db.doc(path).onSnapshot(cb)   -> unsubscribe fn; cb({exists,data}) fires async on subscribe and on every change
 *   db.collection(path).get()     -> Promise<{docs:[{id, path, exists:true, data}]}>  (direct children of path)
 *   db.collection(path).onSnapshot(cb) -> unsubscribe; cb({docs}) on subscribe and on every change under path
 *   db.collection(path).doc(k)    -> same as db.doc(path + '/' + k)
 *   mcp.watchTool(server, tool, input, handler, opts) -> unsubscribe fn. Async calls
 *        handler({type:'data', result:{payload:[...]}, cache:{storedAt}}) (payload = emails for
 *        tools whose name contains 'mail'/'search_mail', else events), or
 *        handler({type:'error', error:{code:'fake_error', retryable:true}}) when mode==='error'.
 *   mcp.callTool(server, tool, input) -> Promise<{payload:[...]}> (rejects with {code, retryable} in error mode)
 *   user.id() -> 'u1'
 */
(() => {
  const fake = (window.__fake = window.__fake || {});
  fake.db = fake.db || { docs: {} };
  fake.db.docs = fake.db.docs || {};
  fake.mcp = fake.mcp || { mode: 'ok', emails: [], events: [] };
  fake.user = fake.user || { id: 'u1' };
  window.__calls = [];

  const rec = (ns, fn, args) => window.__calls.push({ ns, fn, args: JSON.parse(JSON.stringify(args, (k, v) => (typeof v === 'function' ? '[fn]' : v)) || []) });
  const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const docs = () => fake.db.docs;
  const listeners = new Set(); // {fire}
  const notify = () => listeners.forEach((l) => queueMicrotask(l));
  const snap = (path) => ({ exists: path in docs(), data: clone(docs()[path]) });
  const children = (path) => Object.keys(docs())
    .filter((k) => k.startsWith(path + '/') && !k.slice(path.length + 1).includes('/'))
    .sort()
    .map((k) => ({ id: k.slice(path.length + 1), path: k, exists: true, data: clone(docs()[k]) }));

  function subscribe(read, cb) {
    let live = true;
    const fire = () => { if (live) cb(read()); };
    listeners.add(fire);
    setTimeout(fire, 0);
    return () => { live = false; listeners.delete(fire); };
  }

  function doc(path) {
    return {
      path,
      async get() { rec('db', 'doc.get', [path]); return snap(path); },
      async set(data) { rec('db', 'doc.set', [path, data]); docs()[path] = clone(data); notify(); },
      async update(patch) { rec('db', 'doc.update', [path, patch]); docs()[path] = { ...(docs()[path] || {}), ...clone(patch) }; notify(); },
      onSnapshot(cb) { rec('db', 'doc.onSnapshot', [path]); return subscribe(() => snap(path), cb); },
    };
  }
  function collection(path) {
    return {
      path,
      async get() { rec('db', 'collection.get', [path]); return { docs: children(path) }; },
      onSnapshot(cb) { rec('db', 'collection.onSnapshot', [path]); return subscribe(() => ({ docs: children(path) }), cb); },
      doc(k) { return doc(path + '/' + k); },
    };
  }
  const db = { doc, collection };

  const payloadFor = (tool) => (/mail|message/i.test(tool || '') ? fake.mcp.emails : fake.mcp.events) || [];
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
  const user = { id: () => fake.user.id };

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
