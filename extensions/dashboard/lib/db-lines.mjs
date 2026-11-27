// Reads what the artifact database tools print: db_query / db_list give a summary, then one JSON object per
// line {id, data, version, updatedAt}. Lines that are not such an object (summary, wrapper text) are ignored.
// A JSON array of {id, data, version?} is accepted as is.
const isObj = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

export function parseDbLines(text) {
  const src = String(text ?? '');
  try {
    const whole = JSON.parse(src);
    if (Array.isArray(whole)) return whole;
  } catch { /* line format */ }
  const out = [];
  for (const line of src.split(/\r?\n/)) {
    const t = line.trim();
    if (!t.startsWith('{')) continue;
    let o;
    try { o = JSON.parse(t); } catch { continue; }
    if (isObj(o) && typeof o.id === 'string' && 'data' in o) out.push(o);
  }
  return out;
}
