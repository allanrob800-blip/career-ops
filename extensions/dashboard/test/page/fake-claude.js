/*
 * Fake `window.claude` for page tests (injected before page scripts).
 * Mirrors the real claude.ai artifact runtime contract 0.2.99 for the `db`, `user` and `mcp` namespaces
 * (see .superpowers/sdd/.../db-api.md and mcp-api.md).
 *
 * State:  window.__fake = { db: {docs: {'snapshot/meta': {...}, 'requests/abc': {...}}},
 *                           mcp: {mode: 'ok'|'null'|'error', code, retryable, shape: 'array'|'blocks',
 *                                 emails: [...], events: [...], storedAt, latencyMs, deny,
 *                                 byTool: {outlook_calendar_search: {mode, code, ...}}},   (per-tool overrides)
 *                           user: {id: 'u1'} }      (a missing/partial `db`, `db.docs` or `mcp` is normalized;
 *                                                    every field is read at call time, so tests may change it live)
 * Calls:  window.__calls = [{ns, fn, args}] — every fake API call, in order.
 * API:
 *   claude.use(name) -> Promise<namespace|null>   ('db' | 'mcp' | 'user' | 'downloads'; mcp is null when mode==='null'; unknown -> null)
 *   db (frozen): doc(path) / collection(path) THROW TypeError on a bad path (document = even segment count,
 *        collection = odd; segment chars [A-Za-z0-9_-.~:@+], not '.'/'..', <=200 bytes; <=16 segments, <=1000 bytes).
 *   DocumentReference {id, path, get(), set(data), update(data), delete(), onSnapshot(next, error?), collection(sub)}
 *        get() -> DocumentSnapshot {id, exists, data() (METHOD; body or undefined), metadata:{fromCache:false, hasPendingWrites:false}} (frozen)
 *        set replaces (creates); update merges recursively (arrays replace) and REJECTS {code:'invalid_argument'} if the doc is missing.
 *   CollectionReference {id, path, doc(id?) (mints an id), add(data), where, orderBy, limit, get(), onSnapshot(next, error?)}
 *        QuerySnapshot {docs, size, empty, docChanges(), metadata}; docs ordered by id unless orderBy.
 *   window.__fake.db.latencyMs (optional) delays the FIRST delivery of every listener (setTimeout).
 *   onSnapshot fires asynchronously (microtask, independent of timers) on subscribe, then only when a document
 *        under the listener's own path changes (a doc listener: that doc; a collection listener: its direct children).
 *   mcp (frozen; `claude.use('mcp')` is null when mode === 'null'). Only the server 'Microsoft 365' with the tools
 *        outlook_email_search (serves fake.mcp.emails) and outlook_calendar_search (serves fake.mcp.events) exists:
 *        another server -> error `server_not_found`, another tool -> error `not_in_manifest`. The fake does not
 *        filter by input: every e-mail watch gets all of fake.mcp.emails (the page must filter and dedupe).
 *   mcp.watchTool(server, tool, input, handler, options?) -> SYNCHRONOUS unsubscribe. A non-function handler throws
 *        TypeError synchronously. The first delivery is asynchronous (setTimeout; fake.mcp.latencyMs delays it):
 *          handler({type:'data', result:{content:[{type:'text', text}], payload, cache?}})
 *          handler({type:'error', error:{code, server, message, retryable?}})     when mode === 'error'
 *        Error code = fake.mcp.code (default 'upstream_error'); `retryable: true` only when fake.mcp.retryable.
 *        shape 'array' (default): ONE text block holding the JSON array, payload = that array.
 *        shape 'blocks': one text block PER item, payload = the first item only (first text block parsed).
 *        cache = {storedAt: fake.mcp.storedAt (epoch ms), revalidating:false} when storedAt is set; absent = fresh.
 *        A second live registration of the same (server, tool, input) gets an error event `bad_request`.
 *   mcp.callTool(server, tool, input?, options?) -> Promise<CallToolResult {content, payload, cache?}>; REJECTS an
 *        McpError {code, server, message, retryable?} in error mode. A call may ask the user for approval: when the
 *        code is approval_required / consent_required the fake "approves" (mode becomes 'ok' and the call
 *        resolves) unless fake.mcp.deny is set.
 *   mcp.invalidate(server?, tool?, input?) -> re-delivers (setTimeout, after fake.mcp.latencyMs) to the matching live watches.
 *   window.__mcpRefetch(only?) (test control, not part of the API) -> re-delivers to every live watch, as a poll
 *        would; `only(tool, input)` limits it to the watches it returns true for.
 *   user: id() -> Promise<'u1'>, can(cap) -> true, canEdit() -> true, isOwner() -> true
 *   downloads (`claude.use('downloads')`; window.__fake.downloads = {mode: 'null'|'ok'|'error', code, status}):
 *        mode 'null' (the default: the capability is not declared yet) -> use() resolves null.
 *        save({filename, data}) -> Promise<{status}> (fake.downloads.status, default 'saved'); in mode 'error' it
 *        REJECTS {code, message} with fake.downloads.code (default 'bad_request'). Every call is recorded in
 *        window.__downloads as {filename, blob: data instanceof Blob, type, size} (and in __calls).
 */
(() => {
  const fake = (window.__fake = window.__fake || {});
  fake.db = fake.db || {};
  fake.db.docs = fake.db.docs || {};
  fake.mcp = fake.mcp || {};
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
    const latency = (fake.db && fake.db.latencyMs) || 0; // optional delay of the first delivery
    if (latency > 0) setTimeout(l.fire, latency); else Promise.resolve().then(l.fire);
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

  // ---- mcp ----
  const MCP_SERVER = 'Microsoft 365';
  const MCP_TOOLS = { outlook_email_search: 'emails', outlook_calendar_search: 'events' };
  const mcpCfg = () => (fake.mcp = fake.mcp || {}); // harness may replace fake.mcp after init
  const sorted = (k, v) => (isPlain(v) ? Object.fromEntries(Object.keys(v).sort().map((key) => [key, v[key]])) : v);
  const identity = (server, tool, input) => JSON.stringify([server, tool, input ?? {}], sorted);
  const toolCfg = (tool) => ({ ...mcpCfg(), ...((mcpCfg().byTool || {})[tool] || {}) }); // byTool overrides the rest
  function mcpError(code, retryable) {
    const e = { code, server: MCP_SERVER, message: `fake ${code}` };
    if (retryable) e.retryable = true;
    return e;
  }
  // -> {error: McpError} | {result: CallToolResult}, from the configuration at call time
  function outcome(server, tool) {
    const c = toolCfg(tool);
    if (server !== MCP_SERVER) return { error: mcpError('server_not_found') };
    if (!(tool in MCP_TOOLS)) return { error: mcpError('not_in_manifest') };
    if (c.mode === 'error') return { error: mcpError(c.code || 'upstream_error', c.retryable) };
    const items = clone(c[MCP_TOOLS[tool]] || []);
    const result = c.shape === 'blocks'
      ? { content: items.map((it) => ({ type: 'text', text: JSON.stringify(it) })), payload: items[0] }
      : { content: [{ type: 'text', text: JSON.stringify(items) }], payload: items };
    if (c.storedAt != null) result.cache = { storedAt: c.storedAt, revalidating: false };
    return { result };
  }
  const watches = new Map(); // identity -> {server, tool, key, input, deliver}
  const mcp = Object.freeze({
    watchTool(server, tool, input, handler, opts) {
      if (typeof handler !== 'function') throw new TypeError('mcp.watchTool: handler must be a function');
      rec('mcp', 'watchTool', [server, tool, input, opts]);
      const key = identity(server, tool, input);
      let live = true;
      if (watches.has(key)) {
        setTimeout(() => { if (live) handler({ type: 'error', error: mcpError('bad_request') }); }, 0);
        return () => { live = false; };
      }
      const w = {
        server, tool, key, input: clone(input ?? {}),
        deliver() {
          if (!live) return;
          const o = outcome(server, tool);
          handler(o.error ? { type: 'error', error: o.error } : { type: 'data', result: o.result });
        },
      };
      watches.set(key, w);
      setTimeout(w.deliver, mcpCfg().latencyMs || 0);
      return () => { live = false; if (watches.get(key) === w) watches.delete(key); };
    },
    async callTool(server, tool, input) {
      rec('mcp', 'callTool', [server, tool, input]);
      const own = (mcpCfg().byTool || {})[tool];
      const c = own && own.mode ? own : mcpCfg(); // the object that holds this tool's mode
      if (c.mode === 'error' && (c.code === 'approval_required' || c.code === 'consent_required') && !toolCfg(tool).deny) c.mode = 'ok';
      const o = outcome(server, tool);
      if (o.error) throw o.error;
      return o.result;
    },
    invalidate(server, tool, input) {
      rec('mcp', 'invalidate', [server, tool, input]);
      const key = input === undefined ? null : identity(server, tool, input);
      for (const w of watches.values()) {
        if ((server === undefined || w.server === server) && (tool === undefined || w.tool === tool) && (key === null || w.key === key)) setTimeout(w.deliver, mcpCfg().latencyMs || 0);
      }
    },
  });
  window.__mcpRefetch = (only) => { for (const w of [...watches.values()]) if (!only || only(w.tool, w.input)) w.deliver(); };
  // ---- downloads ----
  window.__downloads = [];
  const dlCfg = () => (fake.downloads = fake.downloads || {});
  const downloads = Object.freeze({
    async save(opts) {
      const o = isPlain(opts) ? opts : {};
      const data = o.data;
      const entry = { filename: o.filename, blob: typeof Blob !== 'undefined' && data instanceof Blob, type: data && data.type, size: data && data.size };
      window.__downloads.push(entry);
      rec('downloads', 'save', [entry]);
      const c = dlCfg();
      if (c.mode === 'error') return fail(c.code || 'bad_request', `fake ${c.code || 'bad_request'}`);
      return { status: c.status || 'saved' };
    },
  });
  const user = Object.freeze({ id: async () => fake.user.id, can: () => true, canEdit: () => true, isOwner: () => true });

  window.claude = {
    async use(name) {
      rec('claude', 'use', [name]);
      if (name === 'db') return db;
      if (name === 'user') return user;
      if (name === 'mcp') return mcpCfg().mode === 'null' ? null : mcp;
      if (name === 'downloads') return (dlCfg().mode || 'null') === 'null' ? null : downloads;
      return null;
    },
  };
})();
