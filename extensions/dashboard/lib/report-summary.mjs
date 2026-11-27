// Pure: extracts a compact summary from an evaluation report (markdown string).

const MAX_POINTS = 3;
const MAX_LEN = 160;

function header(md, name) {
  const m = new RegExp('^\\*\\*' + name + ':\\*\\*[ \\t]*(.*)$', 'mi').exec(md);
  const v = m ? m[1].trim() : '';
  return v || null;
}

function clip(s) {
  const t = s.trim();
  return t.length > MAX_LEN ? t.slice(0, MAX_LEN) : t;
}

function matchSection(md) {
  const lines = md.split(/\r?\n/);
  const out = [];
  let inside = false;
  for (const line of lines) {
    if (/^#{1,6}\s/.test(line)) {
      inside = /match/i.test(line);
      continue;
    }
    if (inside) out.push(line);
  }
  return out;
}

export function summarizeReport(markdown, num) {
  const md = String(markdown ?? '');
  const scoreRaw = header(md, 'Score');
  const scoreM = scoreRaw && /(\d+(?:\.\d+)?)\s*\/\s*5/.exec(scoreRaw);
  const url = header(md, 'URL');
  const strengths = [];
  const gaps = [];
  for (const line of matchSection(md)) {
    const b = /^\s*[-*]\s+(.*\S)\s*$/.exec(line);
    if (!b) continue;
    const text = b[1];
    const isGap = /⚠️|⚠|❌/.test(text) || /\bgap\b/i.test(text);
    const isStrength = /✅/.test(text) || /\bstrength\b/i.test(text);
    if (isGap) { if (gaps.length < MAX_POINTS) gaps.push(clip(text)); }
    else if (isStrength) { if (strengths.length < MAX_POINTS) strengths.push(clip(text)); }
  }
  return {
    num,
    score: scoreM ? parseFloat(scoreM[1]) : null,
    archetype: header(md, 'Archetype'),
    legitimacy: header(md, 'Legitimacy'),
    url: url && url.startsWith('https://') ? url : null,
    strengths,
    gaps,
  };
}
