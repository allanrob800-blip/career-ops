/* Analytique: timeline area chart (7 j / 30 j / 6 mois), funnel, status donut, response rate, in-progress list. */
(() => {
  'use strict';
  const Screens = (globalThis.Screens = globalThis.Screens || {});
  const EMPTY = ['Pas encore de données à analyser', 'Les courbes apparaîtront après vos premières candidatures, à la prochaine synchronisation.'];
  const ui = { period: '30' };
  const GROUPS = [
    ['À postuler', ['Evaluated', 'Speculative'], 'g1'],
    ['Envoyées', ['Applied'], 'g2'],
    ['En échange', ['Responded', 'Assessment'], 'g3'],
    ['Entretien', ['Interview'], 'g4'],
    ['Offre', ['Offer', 'Hired'], 'g5'],
    ['Fermées', ['Rejected', 'Discarded', 'SKIP'], 'g0'],
  ];
  const STAGE = { Applied: 25, Responded: 45, Assessment: 60, Interview: 75, Offer: 95 };

  // Period view of the 180-day timeline: daily for 7/30 days, weekly for « 6 mois ».
  function periodData(tl, period) {
    if (period !== 'all') {
      const d = tl.slice(-Number(period));
      return { labels: d.map((x) => CapUI.fmtDay(x.date)), tips: d.map((x) => CapUI.fmtLong(x.date)), applied: d.map((x) => x.applied || 0), evaluated: d.map((x) => x.evaluated || 0) };
    }
    const first = tl.findIndex((x) => x.applied || x.evaluated);
    const start = first < 0 ? Math.max(0, tl.length - 56) : Math.min(first, Math.max(0, tl.length - 56));
    const weeks = [];
    for (const x of tl.slice(start)) {
      const mon = CapUI.week(x.date).mon;
      let w = weeks[weeks.length - 1];
      if (!w || w.mon !== mon) { w = { mon, applied: 0, evaluated: 0 }; weeks.push(w); }
      w.applied += x.applied || 0;
      w.evaluated += x.evaluated || 0;
    }
    return { labels: weeks.map((w) => CapUI.fmtDay(w.mon)), tips: weeks.map((w) => `Semaine du ${CapUI.fmtDay(w.mon)}`), applied: weeks.map((w) => w.applied), evaluated: weeks.map((w) => w.evaluated) };
  }

  function tableHtml(d) {
    const { esc } = CapUI;
    return `<table class="data-table"><thead><tr><th scope="col">Période</th><th scope="col" class="num">Envoyées</th><th scope="col" class="num">Évaluées</th></tr></thead><tbody>${
      d.tips.map((t, i) => `<tr><td>${esc(t)}</td><td class="num">${esc(d.applied[i])}</td><td class="num">${esc(d.evaluated[i])}</td></tr>`).join('')}</tbody></table>`;
  }

  // Running totals over the period: sparse daily counts read as spikes, a cumulative curve reads as progress.
  const cumul = (arr) => { let t = 0; return arr.map((v) => (t += v)); };

  function drawTimeline(root, snap, animate) {
    const d = periodData(Array.isArray(snap.timeline) ? snap.timeline : [], ui.period);
    CapCharts.area(root.querySelector('#timeline-chart'), [
      { key: 'evaluated', label: 'Évaluées (cumul)', values: cumul(d.evaluated) },
      { key: 'applied', label: 'Envoyées (cumul)', values: cumul(d.applied), main: true },
    ], { ticks: d.labels, tips: d.tips, animate: animate && !CapUI.reduced() });
    root.querySelector('#timeline-table').innerHTML = tableHtml(d);
    const tot = d.applied.reduce((a, b) => a + b, 0);
    root.querySelector('#timeline-sum').textContent = `Cumul : ${CapUI.plural(tot, 'candidature envoyée', 'candidatures envoyées')} sur la période`;
    for (const b of root.querySelectorAll('[data-period]')) b.setAttribute('aria-pressed', String(b.dataset.period === ui.period));
  }

  function paint(root, snap) {
    const { esc } = CapUI;
    const apps = Array.isArray(snap.apps) ? snap.apps : [];
    const f = CapUI.figures(apps);
    const steps = [['Évaluées', f.total], ['Envoyées', f.sent], ['Réponses', f.replied], ['Entretiens', f.interviews], ['Offres', f.offers]];
    const funnel = steps.map(([label, n], i) => {
      const w = f.total ? Math.max(n ? 3 : 0, (n / f.total) * 100) : 0;
      const prev = i ? steps[i - 1][1] : null;
      const conv = i && prev ? ` · ${CapUI.fmtPct(Math.round((n / prev) * 100))}` : '';
      return `<li class="funnel-row"><span class="f-label">${esc(label)}</span><span class="f-track"><span class="f-bar" style="width:${w.toFixed(1)}%"></span></span>
        <span class="f-val"><strong>${esc(n)}</strong><small>${esc(conv)}</small></span></li>`;
    }).join('');
    const parts = GROUPS.map(([label, sts, cls]) => ({ label, cls, value: apps.filter((a) => sts.includes(a.status)).length }));
    const legend = parts.map((p) => `<li><i class="sw ${p.cls}" aria-hidden="true"></i><span>${esc(p.label)}</span><strong>${esc(p.value)}</strong></li>`).join('');
    const active = apps.filter((a) => STAGE[a.status]).sort((a, b) => STAGE[b.status] - STAGE[a.status]).slice(0, 6);
    const progress = active.length ? active.map((a) => `<li class="prog"><div class="prog-top"><span class="prog-co">${esc(a.company)}</span><span class="status s-${CapUI.tone(a.status)}">${esc(CapUI.statusLabel(a.status))}</span></div>
        <p class="prog-role">${esc(a.role)}</p><span class="meter" role="img" aria-label="${esc(`${CapUI.statusLabel(a.status)}, ${STAGE[a.status]} %`)}"><span style="width:${STAGE[a.status]}%"></span></span></li>`).join('')
      : '<li class="muted">Aucune candidature en cours.</li>';

    root.innerHTML = `<div class="ana">
      <section class="card glass ana-time rise" style="--i:0" aria-labelledby="t-time">
        <div class="card-head"><div><h2 id="t-time" class="card-title">Candidatures dans le temps</h2><p class="muted small" id="timeline-sum"></p></div>
          <div class="seg" role="group" aria-label="Période"><button type="button" data-period="7">7 j</button><button type="button" data-period="30">30 j</button><button type="button" data-period="all">6 mois</button></div></div>
        <ul class="legend"><li><i class="sw sw-main" aria-hidden="true"></i>Envoyées</li><li><i class="sw sw-alt" aria-hidden="true"></i>Évaluées</li></ul>
        <div class="fig fig-area"><svg id="timeline-chart" role="img" aria-label="Candidatures envoyées et offres évaluées sur la période"></svg></div>
        <details class="data-view"><summary>Voir les données</summary><div class="scroll" id="timeline-table"></div></details>
      </section>
      <section class="card glass ana-donut rise" style="--i:1" aria-labelledby="t-donut"><h2 id="t-donut" class="card-title">Répartition par statut</h2>
        <div class="fig fig-donut"><svg id="status-donut" role="img" aria-label="Répartition des candidatures par statut"></svg></div><ul class="legend legend-col">${legend}</ul></section>
      <section class="card glass ana-funnel rise" style="--i:2" aria-labelledby="t-funnel"><h2 id="t-funnel" class="card-title">Entonnoir</h2><ol class="funnel">${funnel}</ol></section>
      <section class="card glass ana-rate rise" style="--i:3" aria-labelledby="t-rate"><h2 id="t-rate" class="card-title">Taux de réponse</h2>
        <p class="big" id="rate-big">—</p><p class="muted">${f.sent ? `${esc(CapUI.plural(f.replied, 'réponse', 'réponses'))} sur ${esc(CapUI.plural(f.sent, 'candidature envoyée', 'candidatures envoyées'))}, refus compris.` : 'Aucune candidature envoyée pour l\'instant.'}</p>
        <p class="muted small">${f.sent ? `Entretiens obtenus : ${esc(CapUI.fmtPct(Math.round((f.interviews / f.sent) * 100)))} des envois.` : ''}</p></section>
      <section class="card glass ana-prog rise" style="--i:4" aria-labelledby="t-prog"><h2 id="t-prog" class="card-title">En cours</h2><ul class="progs">${progress}</ul></section>
    </div>`;
    CapUI.countUp(root.querySelector('#rate-big'), f.rate, { key: 'rate-big', format: CapUI.fmtPct });
    CapCharts.donut(root.querySelector('#status-donut'), parts, { sub: f.total > 1 ? 'candidatures' : 'candidature' });
    drawTimeline(root, snap, true);
  }

  let lastSnap = null;
  function render(root, state) {
    if (!CapUI.gate(root, state, EMPTY)) return;
    const snap = state.snapshot;
    lastSnap = snap;
    if (!(snap.apps || []).length) {
      if (root.dataset.view !== 'analytique-none') { root.innerHTML = CapUI.emptyBlock(...EMPTY); root.dataset.view = 'analytique-none'; }
      return;
    }
    CapUI.rebuild(root, 'analytique', String(snap.generation), () => paint(root, snap));
    if (!root.__capAna) {
      root.__capAna = true;
      root.addEventListener('click', (e) => {
        const b = e.target.closest('[data-period]');
        if (!b || b.dataset.period === ui.period || !lastSnap) return;
        ui.period = b.dataset.period;
        drawTimeline(root, lastSnap, true);
      });
    }
  }

  Screens.analytique = { render };
})();
