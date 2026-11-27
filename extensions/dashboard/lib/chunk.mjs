// Splits a snapshot into database documents, each under maxBytes of JSON.
const META_KEYS = ['schema', 'generation', 'generated_at', 'profile', 'stats', 'timeline', 'followups_due', 'companies'];
const ARRAYS = ['apps', 'offers', 'reports'];

const bytes = (v) => Buffer.byteLength(JSON.stringify(v));

function chunkArray(name, items, generation, maxBytes) {
  const overhead = bytes({ generation, items: [] });
  const docs = [];
  let cur = [];
  let size = overhead;
  const flush = () => {
    if (cur.length) docs.push({ path: `snapshot/${name}-${docs.length}`, data: { generation, items: cur } });
    cur = [];
    size = overhead;
  };
  for (const item of items) {
    const b = bytes(item);
    if (overhead + b > maxBytes) {
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

export function toDocs(snapshot, maxBytes = 60000) {
  const parts = [];
  for (const name of ARRAYS) parts.push(...chunkArray(name, snapshot[name] ?? [], snapshot.generation, maxBytes));
  const meta = {};
  for (const k of META_KEYS) meta[k] = snapshot[k];
  meta.parts = parts.map((d) => d.path);
  if (bytes(meta) > maxBytes) throw new Error(`snapshot/meta is ${bytes(meta)} bytes, over maxBytes (${maxBytes})`);
  return [{ path: 'snapshot/meta', data: meta }, ...parts];
}
