// Reads what the artifact database tools print: db_query / db_list give a summary, then one JSON object per
// line {id, data, version, updatedAt}, inside an <untrusted-document-…> tag. Lines that hold no such object
// (summary, tag, wrapper text) are ignored.
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
    // the tools wrap the lines in an <untrusted-document-…> tag, which may share a line with an object
    const i = line.indexOf('{'), j = line.lastIndexOf('}');
    if (i < 0 || j < i) continue;
    let o;
    try { o = JSON.parse(line.slice(i, j + 1)); } catch { continue; }
    // an entry is anything with an id (a tooLarge one has no data); the summary has none
    if (isObj(o) && typeof o.id === 'string' && o.id) out.push(o);
  }
  return out;
}
