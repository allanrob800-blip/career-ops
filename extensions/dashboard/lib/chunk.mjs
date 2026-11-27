// Splits a snapshot into database documents, each under maxBytes of JSON, and plans the db_write calls of a sync.
const META_KEYS = ['schema', 'generation', 'generated_at', 'profile', 'stats', 'timeline', 'followups_due', 'companies'];
const ARRAYS = ['apps', 'offers', 'reports', 'proposals'];
const META = 'snapshot/meta';
const MAX_OPS = 50; // db_write: 1 to 50 ops per call
const MAX_BYTES = 60000;

const bytes = (v) => Buffer.byteLength(JSON.stringify(v));

/** Path-safe compact form of a generation: '2026-11-27T16:12:00.123Z' -> 'g20261127T161200123Z'. */
export function genId(generation) {
  const id = String(generation ?? '').replace(/[^A-Za-z0-9]/g, '');
  if (!id) throw new Error('snapshot generation is empty');
  return `g${id}`;
}

/** true when `item` fits alone in a part of `generation` (the largest item toDocs accepts). */
export function fitsInPart(item, generation, maxBytes = MAX_BYTES) {
  return bytes({ generation, items: [] }) + bytes(item) <= maxBytes;
}

// Part ids are per generation (snapshot/<kind>-<genId>-<n>): a new sync never overwrites a part the stored
// meta still lists, so a sync cut short leaves the previous generation whole.
function chunkArray(name, items, generation, maxBytes) {
  const prefix = `snapshot/${name}-${genId(generation)}`;
  const overhead = bytes({ generation, items: [] });
  const docs = [];
  let cur = [];
  let size = overhead;
  const flush = () => {
    if (cur.length) docs.push({ path: `${prefix}-${docs.length}`, data: { generation, items: cur } });
    cur = [];
    size = overhead;
  };
  for (const item of items) {
    const b = bytes(item);
    if (!fitsInPart(item, generation, maxBytes)) {
      throw new Error(`snapshot/${name}: a single item is ${overhead + b} bytes, over maxBytes (${maxBytes})`);
    }
    const add = b + (cur.length ? 1 : 0);
    if (size + add > maxBytes) flush();
    size += b + (cur.length ? 1 : 0);
    cur.push(item);
  }
  flush();
  return docs;
}

export function toDocs(snapshot, maxBytes = MAX_BYTES) {
  const parts = [];
  for (const name of ARRAYS) parts.push(...chunkArray(name, snapshot[name] ?? [], snapshot.generation, maxBytes));
  const meta = {};
  for (const k of META_KEYS) meta[k] = snapshot[k];
  meta.parts = parts.map((d) => d.path);
  if (bytes(meta) > maxBytes) throw new Error(`snapshot/meta is ${bytes(meta)} bytes, over maxBytes (${maxBytes})`);
  return [{ path: META, data: meta }, ...parts];
}

const chunks = (ops, size = MAX_OPS) => {
  const out = [];
  for (let i = 0; i < ops.length; i += size) out.push(ops.slice(i, i + size));
  return out;
};

/**
 * The db_write calls of one sync, in order. `docs` comes from toDocs; `current` is what `db_list snapshot`
 * returned ({id, data, version}; id with or without the `snapshot/` prefix).
 *   1. every new part, `set` (new documents: no ifVersion), in batches of at most 50;
 *   2. ONE batch: `snapshot/meta` set (ifVersion when it exists) and the deletes (ifVersion) of the stored
 *      documents the new meta does not list; deletes that do not fit follow in later batches, after the flip.
 * Returns {batches: [[op, …], …]}.
 */
export function syncPlan(docs, current = []) {
  const stored = new Map();
  for (const e of Array.isArray(current) ? current : []) {
    if (!e || typeof e.id !== 'string' || !e.id) continue;
    stored.set(e.id.includes('/') ? e.id : `snapshot/${e.id}`, e.version);
  }
  const meta = docs.find((d) => d.path === META);
  if (!meta) throw new Error('syncPlan: no snapshot/meta document');
  const keep = new Set(meta.data.parts);
  const guard = (op, path) => (stored.has(path) && stored.get(path) != null ? { ...op, ifVersion: stored.get(path) } : op);
  const sets = docs.filter((d) => d.path !== META).map((d) => guard({ op: 'set', path: d.path, data: d.data }, d.path));
  const deletes = [...stored.keys()].filter((p) => p !== META && !keep.has(p)).map((p) => guard({ op: 'delete', path: p }, p));
  const flip = [guard({ op: 'set', path: META, data: meta.data }, META), ...deletes.slice(0, MAX_OPS - 1)];
  return { batches: [...chunks(sets), flip, ...chunks(deletes.slice(MAX_OPS - 1))] };
}
