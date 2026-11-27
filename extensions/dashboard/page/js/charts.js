/*
 * CapCharts: SVG charts drawn at their real pixel size (each redraws through a named
 * ResizeObserver). Labels are escaped; colours come from CSS (accent = the one highlighted series).
 * Bars, meters and the funnel are HTML rows with % widths and live in the screens, not here.
 */
(() => {
  'use strict';
  const esc = (s) => globalThis.CapUI.esc(s);
  const r1 = (n) => Math.round(n * 10) / 10;

  // One observer per drawing surface; replacing the drawing disconnects the old one.
  function observe(node, draw) {
    if (node.__capRO) node.__capRO.disconnect();
    const capChartResize = new ResizeObserver(() => draw());
    capChartResize.observe(node);
    node.__capRO = capChartResize;
    draw();
  }
  const size = (node) => ({ W: node.clientWidth, H: node.clientHeight });

  // Monotone cubic (Fritsch–Carlson): smooth without overshooting below the baseline.
  function smooth(pts) {
    const n = pts.length;
    if (!n) return '';
    if (n === 1) return `M${r1(pts[0][0])},${r1(pts[0][1])}`;
    const m = [], t = [];
    for (let i = 0; i < n - 1; i++) m[i] = (pts[i + 1][1] - pts[i][1]) / (pts[i + 1][0] - pts[i][0] || 1);
    t[0] = m[0];
    t[n - 1] = m[n - 2];
    for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
    for (let i = 0; i < n - 1; i++) {
      if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
      const a = t[i] / m[i], b = t[i + 1] / m[i], s = a * a + b * b;
      if (s > 9) { const k = 3 / Math.sqrt(s); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; }
    }
    let d = `M${r1(pts[0][0])},${r1(pts[0][1])}`;
    for (let i = 0; i < n - 1; i++) {
      const [x0, y0] = pts[i], [x1, y1] = pts[i + 1], dx = (x1 - x0) / 3;
      d += `C${r1(x0 + dx)},${r1(y0 + t[i] * dx)} ${r1(x1 - dx)},${r1(y1 - t[i + 1] * dx)} ${r1(x1)},${r1(y1)}`;
    }
    return d;
  }

  function niceMax(v) {
    if (v <= 4) return Math.max(1, Math.ceil(v));
    const p = 10 ** Math.floor(Math.log10(v)), f = v / p;
    return (f <= 2 ? 2 : f <= 5 ? 5 : 10) * p;
  }

  /**
   * Area chart. series: [{key, label, values:number[], main?:bool}] (one main series, others quiet);
   * opts: {ticks: string[] (x labels), tips: string[] (tooltip titles), animate: bool}.
   */
  function area(svg, series, opts = {}) {
    svg.__capArea = { series, opts, animate: !!opts.animate };
    if (!svg.__capHover) hover(svg);
    observe(svg, () => drawArea(svg));
  }

  function drawArea(svg) {
    const st = svg.__capArea;
    if (!st) return;
    const { W, H } = size(svg);
    if (W < 10 || H < 10) return;
    const { series, opts } = st;
    const n = Math.max(1, ...series.map((s) => s.values.length));
    const narrow = W < 520;
    const pad = { l: 30, r: 14, t: 14, b: 28 };
    const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
    const max = niceMax(Math.max(0, ...series.flatMap((s) => s.values)));
    const x = (i) => pad.l + (n === 1 ? iw / 2 : (i * iw) / (n - 1));
    const y = (v) => pad.t + ih - (v / max) * ih;
    st.geom = { x, y, n, pad, W, H, iw };
    const gid = `grad-${svg.id || 'area'}`;
    let out = `<defs><linearGradient id="${esc(gid)}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" class="grad-a"/><stop offset="1" class="grad-b"/></linearGradient></defs>`;
    // three quiet gridlines with integer labels
    const ticks = [...new Set([0, Math.round(max / 2), max])];
    for (const v of ticks) out += `<line class="grid" x1="${pad.l}" x2="${W - pad.r}" y1="${r1(y(v))}" y2="${r1(y(v))}"/><text class="tick y" x="${pad.l - 8}" y="${r1(y(v) + 4)}" text-anchor="end">${esc(v)}</text>`;
    // x labels: at most 6 (3 on narrow screens), first and last kept
    const labels = opts.ticks || [];
    const want = narrow ? 3 : 6;
    const every = Math.max(1, Math.ceil(n / want));
    for (let i = 0; i < n; i++) {
      const show = i === n - 1 || (i % every === 0 && n - 1 - i >= every * 0.6);
      if (!labels[i] || !show) continue;
      const anchor = i === 0 && n > 1 ? 'start' : i === n - 1 && n > 1 ? 'end' : 'middle';
      out += `<text class="tick x" x="${r1(x(i))}" y="${H - 8}" text-anchor="${anchor}">${esc(labels[i])}</text>`;
    }
    const anim = st.animate ? ' draw' : '';
    for (const s of [...series].sort((a, b) => (a.main ? 1 : 0) - (b.main ? 1 : 0))) {
      const pts = s.values.map((v, i) => [x(i), y(v)]);
      const d = smooth(pts);
      if (s.main && pts.length > 1) out += `<path class="area-fill${anim}" fill="url(#${esc(gid)})" d="${d}L${r1(x(n - 1))},${r1(y(0))}L${r1(x(0))},${r1(y(0))}Z"/>`;
      out += `<path class="${s.main ? 'line-main' : 'line-alt'}${anim}" pathLength="1" d="${d}"/>`;
    }
    out += `<line class="guide" x1="0" x2="0" y1="${pad.t}" y2="${pad.t + ih}" visibility="hidden"/>`;
    for (const s of series) out += `<circle class="dot ${s.main ? 'dot-main' : 'dot-alt'}" r="4.5" cx="-20" cy="-20" visibility="hidden"/>`;
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
    svg.innerHTML = out;
    st.animate = false; // only the first drawing after a period change animates
  }

  function hover(svg) {
    svg.__capHover = true;
    const fig = svg.parentElement;
    let tip = fig.querySelector('.tip');
    if (!tip) { tip = document.createElement('div'); tip.className = 'tip'; tip.hidden = true; fig.append(tip); }
    const hide = () => { tip.hidden = true; svg.querySelectorAll('.guide, .dot').forEach((n) => n.setAttribute('visibility', 'hidden')); };
    svg.addEventListener('pointerleave', hide);
    svg.addEventListener('pointermove', (e) => {
      const st = svg.__capArea;
      if (!st || !st.geom) return;
      const { x, y, n, pad, iw, W } = st.geom;
      const rect = svg.getBoundingClientRect();
      const px = e.clientX - rect.left;
      const i = Math.max(0, Math.min(n - 1, Math.round(((px - pad.l) / (iw || 1)) * (n - 1))));
      const gx = x(i);
      const guide = svg.querySelector('.guide');
      if (!guide) return;
      guide.setAttribute('x1', gx); guide.setAttribute('x2', gx); guide.setAttribute('visibility', 'visible');
      const dots = svg.querySelectorAll('.dot');
      st.series.forEach((s, k) => { const v = s.values[i] ?? 0; dots[k].setAttribute('cx', gx); dots[k].setAttribute('cy', y(v)); dots[k].setAttribute('visibility', 'visible'); });
      tip.textContent = '';
      const h = document.createElement('strong');
      h.textContent = (st.opts.tips || [])[i] || '';
      tip.append(h);
      for (const s of st.series) {
        const row = document.createElement('span');
        row.className = s.main ? 'tip-main' : 'tip-alt';
        row.textContent = `${s.label} : ${s.values[i] ?? 0}`;
        tip.append(row);
      }
      tip.hidden = false;
      const left = Math.min(Math.max(gx - tip.offsetWidth / 2, 0), W - tip.offsetWidth);
      tip.style.transform = `translate(${Math.round(left)}px, 0)`;
    });
  }

  // Progress ring inside `el` (a sized box). Colour = currentColor; the label is HTML, not here.
  function ring(el, value, max) {
    const p = max > 0 ? Math.max(0, Math.min(1, value / max)) : 0;
    let svg = el.querySelector('svg.ring-svg');
    const fresh = !svg;
    if (fresh) {
      svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
      svg.setAttribute('class', 'ring-svg');
      svg.setAttribute('aria-hidden', 'true');
      el.prepend(svg);
    }
    el.__capRing = p;
    let first = fresh;
    observe(el, () => {
      const { W, H } = size(el);
      const s = Math.min(W, H);
      if (s < 10) return;
      const sw = Math.max(6, s * 0.085), r = (s - sw) / 2 - 2, c = s / 2, C = 2 * Math.PI * r;
      const target = C * (1 - el.__capRing);
      svg.setAttribute('viewBox', `0 0 ${s} ${s}`);
      svg.setAttribute('width', s); svg.setAttribute('height', s);
      const start = first && !globalThis.CapUI.reduced() ? C : target;
      svg.innerHTML = `<circle class="ring-track" cx="${c}" cy="${c}" r="${r1(r)}" stroke-width="${r1(sw)}"/>
        <circle class="ring-bar" cx="${c}" cy="${c}" r="${r1(r)}" stroke-width="${r1(sw)}" transform="rotate(-90 ${c} ${c})" stroke-dasharray="${r1(C)}" stroke-dashoffset="${r1(start)}"/>`;
      if (start !== target) {
        const bar = svg.querySelector('.ring-bar');
        requestAnimationFrame(() => requestAnimationFrame(() => bar.setAttribute('stroke-dashoffset', r1(target))));
      }
      first = false;
    });
  }

  // Donut: parts [{label, value, cls}] ; centre shows the total.
  function donut(svg, parts, opts = {}) {
    svg.__capDonut = { parts, opts };
    observe(svg, () => {
      const { W, H } = size(svg);
      const s = Math.min(W, H);
      if (s < 10) return;
      const { parts: ps } = svg.__capDonut;
      const total = ps.reduce((a, p) => a + p.value, 0);
      const c = s / 2, ro = s / 2 - 2, ri = ro * 0.68;
      let out = `<circle class="donut-track" cx="${c}" cy="${c}" r="${r1((ro + ri) / 2)}" stroke-width="${r1(ro - ri)}"/>`;
      const live = ps.filter((p) => p.value > 0);
      const gap = live.length > 1 ? 2.5 / ro : 0;
      let a0 = -Math.PI / 2;
      const pt = (r, a) => `${r1(c + r * Math.cos(a))},${r1(c + r * Math.sin(a))}`;
      for (const p of live) {
        const sweep = (p.value / total) * Math.PI * 2;
        const a1 = a0 + sweep;
        const s0 = a0 + gap / 2, s1 = Math.max(s0 + 0.001, a1 - gap / 2);
        let d;
        if (live.length === 1) {
          d = `M${pt(ro, -Math.PI / 2)}A${r1(ro)},${r1(ro)} 0 1 1 ${pt(ro, Math.PI / 2)}A${r1(ro)},${r1(ro)} 0 1 1 ${pt(ro, -Math.PI / 2)}Z`
            + `M${pt(ri, -Math.PI / 2)}A${r1(ri)},${r1(ri)} 0 1 0 ${pt(ri, Math.PI / 2)}A${r1(ri)},${r1(ri)} 0 1 0 ${pt(ri, -Math.PI / 2)}Z`;
        } else {
          const large = s1 - s0 > Math.PI ? 1 : 0;
          d = `M${pt(ro, s0)}A${r1(ro)},${r1(ro)} 0 ${large} 1 ${pt(ro, s1)}L${pt(ri, s1)}A${r1(ri)},${r1(ri)} 0 ${large} 0 ${pt(ri, s0)}Z`;
        }
        out += `<path class="slice ${esc(p.cls || '')}" d="${d}" fill-rule="evenodd"><title>${esc(p.label)} : ${esc(p.value)}</title></path>`;
        a0 = a1;
      }
      out += `<text class="donut-total" x="${c}" y="${r1(c + s * 0.03)}" text-anchor="middle">${esc(total)}</text>`
        + `<text class="donut-sub" x="${c}" y="${r1(c + s * 0.03 + 18)}" text-anchor="middle">${esc(opts.sub || '')}</text>`;
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      svg.innerHTML = `<g transform="translate(${r1((W - s) / 2)} ${r1((H - s) / 2)})">${out}</g>`;
    });
  }

  // Sparkline: points number[]; line in currentColor with a soft fill and an end dot.
  function spark(svg, points) {
    svg.__capSpark = points;
    observe(svg, () => {
      const { W, H } = size(svg);
      if (W < 10 || H < 6) return;
      const pts = svg.__capSpark.length ? svg.__capSpark : [0];
      const max = Math.max(1, ...pts), n = pts.length;
      const xy = pts.map((v, i) => [3 + (n === 1 ? (W - 6) / 2 : (i * (W - 6)) / (n - 1)), 3 + (H - 6) * (1 - v / max)]);
      const d = smooth(xy);
      const [lx, ly] = xy[xy.length - 1];
      svg.setAttribute('viewBox', `0 0 ${W} ${H}`);
      svg.innerHTML = `<path class="spark-fill" d="${d}L${r1(lx)},${H}L${r1(xy[0][0])},${H}Z"/><path class="spark-line" d="${d}"/><circle class="spark-dot" cx="${r1(lx)}" cy="${r1(ly)}" r="2.6"/>`;
    });
  }

  globalThis.CapCharts = { area, ring, donut, spark, smooth };
})();
