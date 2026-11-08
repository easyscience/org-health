/* EasyScience org health board — renders data/latest.json and data/history.json. */
(async function () {
  const fmt = d3.format(',');
  const el = (tag, attrs = {}, ...kids) => {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else e.setAttribute(k, v);
    }
    for (const k of kids) if (k != null) e.append(k);
    return e;
  };
  const dash = '–';
  const n = (v, f = fmt) => (v == null ? dash : f(v));
  const ageLabel = (d) => (d == null ? dash : d < 1 ? '<1 d' : d < 60 ? `${Math.round(d)} d` : `${Math.round(d / 30)} mo`);
  const tip = document.getElementById('tip');
  const showTip = (ev, lines) => {
    tip.replaceChildren(...lines.map(([t, c]) => el('div', { class: c, text: t })));
    tip.hidden = false;
    const w = tip.offsetWidth, h = tip.offsetHeight;
    tip.style.left = Math.min(window.innerWidth - w - 8, Math.max(8, ev.clientX - w / 2)) + 'px';
    tip.style.top = Math.max(8, ev.clientY - h - 12) + 'px';
  };
  const hideTip = () => { tip.hidden = true; };

  let latest, history = [];
  try {
    latest = await (await fetch('data/latest.json', { cache: 'no-cache' })).json();
  } catch (e) {
    document.getElementById('takeaway').textContent = 'The latest snapshot could not be loaded. Re-run the build workflow.';
    return;
  }
  try { history = await (await fetch('data/history.json', { cache: 'no-cache' })).json(); } catch (e) { /* optional */ }

  const GATE = latest.docstring_gate ?? 45;
  const repos = latest.repos.map((r) => {
    const code = r.code[r.main_branch] || null;
    const gh = r.github || null;
    const ci = gh ? gh.ci[r.main_branch] || [] : null;
    const ciDefault = gh ? gh.ci[r.default_branch] || [] : null;
    return {
      ...r, c: code, gh,
      ciMain: ci,
      ciFailing: ci ? ci.filter((x) => x.conclusion === 'failure' || x.conclusion === 'timed_out').length : null,
      ciDefaultFailing: ciDefault ? ciDefault.filter((x) => x.conclusion === 'failure').length : null,
      cov: r.coverage ? r.coverage[r.main_branch] : null,
      release: (gh && gh.release && gh.release.tag) ? gh.release : r.latest_tag,
    };
  });
  const hasGH = repos.some((r) => r.gh);

  // ---------------------------------------------------------------- header
  document.getElementById('generated').textContent = 'Built ' + d3.utcFormat('%b %-d, %Y %H:%M UTC')(new Date(latest.generated));
  const failing = repos.filter((r) => r.ciFailing > 0);
  const coded = repos.filter((r) => r.c && r.c.sloc > 0);
  const lowDoc = coded.filter((r) => r.c.doc_coverage < GATE);
  const take = document.getElementById('takeaway');
  take.replaceChildren();
  const b = (t) => el('b', { text: String(t) });
  if (hasGH) {
    take.append(failing.length ? b(`${failing.length} of ${repos.length} repositories`) : b('No repository'),
      failing.length ? ` have failing CI on their development branch (${failing.map((r) => r.name).join(', ')}). ` : ' has failing CI on its development branch. ');
  }
  take.append(b(`${lowDoc.length} of ${coded.length}`), ` repositories with code are under the ${GATE}% docstring gate.`);
  if (hasGH) {
    const openPRs = d3.sum(repos, (r) => r.gh?.prs.open || 0);
    const stale = d3.sum(repos, (r) => (r.gh?.prs.list || []).filter((p) => !p.draft && p.age_days > 30).length);
    take.append(' ', b(fmt(openPRs)), ' pull requests are open, ', b(fmt(stale)), ' of them non-draft and older than 30 days.');
  }

  // ---------------------------------------------------------------- tiles
  const tiles = [
    ['Failing workflows', hasGH ? d3.sum(repos, (r) => r.ciFailing || 0) : null, 'Latest run, development branches', (v) => v > 0],
    ['Open issues', hasGH ? d3.sum(repos, (r) => r.gh?.issues.open || 0) : null, hasGH ? `${fmt(d3.sum(repos, (r) => r.gh?.issues.bugs || 0))} labelled bug` : 'Needs the GitHub API'],
    ['Open pull requests', hasGH ? d3.sum(repos, (r) => r.gh?.prs.open || 0) : null, hasGH ? `${fmt(d3.sum(repos, (r) => r.gh?.prs.awaiting_review || 0))} awaiting review` : 'Needs the GitHub API'],
    ['Python source lines', d3.sum(repos, (r) => r.c?.sloc || 0), `${fmt(d3.sum(repos, (r) => r.c?.qml_sloc || 0))} QML lines in apps`],
    ['Test functions', d3.sum(repos, (r) => r.c?.tests || 0), 'def test_… under tests/'],
    ['Commits, 12 months', d3.sum(repos, (r) => r.git.commits_12m), `${fmt(d3.sum(repos, (r) => r.git.commits_90d))} in the last 90 days`],
  ];
  document.getElementById('tiles').replaceChildren(...tiles.map(([l, v, note, alert]) =>
    el('div', { class: 'tile' + (alert && alert(v) ? ' alert' : '') },
      el('div', { class: 'tile-l', text: l }), el('div', { class: 'tile-v', text: n(v) }), el('div', { class: 'tile-n', text: note }))));

  // ---------------------------------------------------------------- sortable table helper
  function sortable(table, cols, rows, initial) {
    let sort = initial;
    const head = el('thead', {}, el('tr', {}, ...cols.map((c) => {
      const th = el('th', { class: c.cls });
      if (c.sort) {
        const btn = el('button', { type: 'button', text: c.label });
        btn.addEventListener('click', () => {
          sort = { key: c.key, dir: sort.key === c.key ? -sort.dir : (c.text ? 1 : -1) };
          draw();
        });
        th.append(btn);
      } else th.textContent = c.label;
      th.dataset.key = c.key;
      return th;
    })));
    const body = el('tbody');
    table.replaceChildren(head, body);
    function draw() {
      head.querySelectorAll('th').forEach((th) => {
        th.removeAttribute('aria-sort');
        if (th.dataset.key === sort.key) th.setAttribute('aria-sort', sort.dir > 0 ? 'ascending' : 'descending');
      });
      const col = cols.find((c) => c.key === sort.key);
      const val = col.sort;
      const sorted = rows.slice().sort((a, b2) => {
        const x = val(a), y = val(b2);
        if (x == null && y == null) return 0;
        if (x == null) return 1;
        if (y == null) return -1;
        return sort.dir * (typeof x === 'string' ? x.localeCompare(y) : x - y);
      });
      body.replaceChildren(...sorted.map((r) => el('tr', {}, ...cols.map((c) => {
        const td = el('td', { class: c.cls });
        const v = c.cell(r);
        if (v instanceof Node) td.append(v); else td.textContent = v ?? dash;
        const k = c.flag && c.flag(r);
        if (k) td.classList.add(k);
        return td;
      }))));
    }
    draw();
  }

  const repoLink = (r) => el('span', { class: 'repo' }, el('a', { href: r.url, target: '_blank', rel: 'noopener', text: r.name }));
  const docBar = (r) => {
    const v = r.c?.doc_coverage;
    if (v == null) return dash;
    const fill = el('span', { class: 'fill' + (v < GATE ? ' low' : '') });
    fill.style.width = Math.min(100, v) + '%';
    const gate = el('span', { class: 'gate' });
    gate.style.left = GATE + '%';
    return el('span', { class: 'bar' }, el('span', { class: v < GATE ? 'bad' : '', text: v.toFixed(1) + '%' }), el('span', { class: 'track' }, fill, gate));
  };
  const ciCell = (r) => {
    if (!r.ciMain) return dash;
    if (!r.ciMain.length) return el('span', { class: 'muted', text: 'no runs' });
    const ok = r.ciMain.filter((x) => x.conclusion === 'success').length;
    return r.ciFailing
      ? el('span', { class: 'bad', text: `${r.ciFailing} failing` })
      : el('span', { class: 'okc', text: `${ok}/${r.ciMain.length} passing` });
  };

  sortable(document.getElementById('score-table'), [
    { key: 'repo', label: 'Repository', cell: repoLink, sort: (r) => r.name, text: true },
    { key: 'family', label: 'Family', cls: 'l sec muted', cell: (r) => r.family, sort: (r) => r.family, text: true },
    { key: 'ci', label: 'CI', cell: ciCell, sort: (r) => r.ciFailing },
    { key: 'issues', label: 'Issues', cell: (r) => n(r.gh?.issues.open), sort: (r) => r.gh?.issues.open },
    { key: 'prs', label: 'PRs', cell: (r) => (r.gh ? `${r.gh.prs.open}${r.gh.prs.draft ? ` (${r.gh.prs.draft} draft)` : ''}` : dash), sort: (r) => r.gh?.prs.open },
    { key: 'oldest', label: 'Oldest PR', cls: 'sec', cell: (r) => ageLabel(r.gh?.prs.oldest_days), sort: (r) => r.gh?.prs.oldest_days, flag: (r) => (r.gh?.prs.oldest_days > 90 ? 'warn' : '') },
    { key: 'cov', label: 'Coverage', cell: (r) => (r.cov == null ? dash : r.cov.toFixed(1) + '%'), sort: (r) => r.cov },
    { key: 'doc', label: 'Docstrings', cell: docBar, sort: (r) => r.c?.doc_coverage },
    { key: 'sloc', label: 'SLOC', cls: 'sec', cell: (r) => (r.c?.sloc ? fmt(r.c.sloc) : 'no code'), sort: (r) => r.c?.sloc },
    { key: 'cc', label: 'Avg CC', cls: 'sec', cell: (r) => n(r.c?.avg_cc, (v) => v.toFixed(2)), sort: (r) => r.c?.avg_cc },
    { key: 'cx', label: 'CC ≥ C', cell: (r) => n(r.c?.complex_functions), sort: (r) => r.c?.complex_functions, flag: (r) => (r.c?.complex_functions >= 20 ? 'warn' : '') },
    { key: 'tests', label: 'Tests', cell: (r) => n(r.c?.tests), sort: (r) => r.c?.tests, flag: (r) => (r.c && r.c.sloc > 0 && r.c.tests === 0 ? 'bad' : '') },
    { key: 'commits', label: 'Commits 12 mo', cell: (r) => fmt(r.git.commits_12m), sort: (r) => r.git.commits_12m },
    { key: 'release', label: 'Release', cls: 'l sec', cell: (r) => (r.release ? `${r.release.tag} · ${r.release.date}` : 'none'), sort: (r) => r.release?.date, text: true },
    { key: 'unrel', label: 'Unreleased lines', cls: 'sec', cell: (r) => n(r.unreleased?.lines), sort: (r) => r.unreleased?.lines },
  ], repos, hasGH ? { key: 'ci', dir: -1 } : { key: 'commits', dir: -1 });

  // ---------------------------------------------------------------- CI matrix
  const ciTable = document.getElementById('ci-table');
  if (!hasGH) {
    ciTable.replaceChildren(el('tbody', {}, el('tr', {}, el('td', { class: 'muted', text: 'CI status needs the GitHub API step of the build.' }))));
  } else {
    const KEY = ['test.yml', 'tutorial-tests.yml', 'coverage.yml', 'lint-format.yml', 'docs.yml', 'security.yml', 'pypi-test.yml', 'installer.yml', 'quality.yml'];
    const files = new Set();
    repos.forEach((r) => Object.values(r.gh?.ci || {}).forEach((runs) => runs.forEach((x) => files.add(x.file))));
    const cols = KEY.filter((k) => files.has(k));
    const label = (f) => f.replace(/\.ya?ml$/, '');
    const rows = [];
    repos.forEach((r) => Object.keys(r.gh?.ci || {}).forEach((br) => rows.push({ r, br, runs: r.gh.ci[br] })));
    ciTable.replaceChildren(
      el('thead', {}, el('tr', {}, el('th', { text: 'Repository' }), el('th', { class: 'l', text: 'Branch' }), ...cols.map((c) => el('th', { text: label(c) })))),
      el('tbody', {}, ...rows.map(({ r, br, runs }) => el('tr', {},
        el('td', {}, br === r.default_branch ? repoLink(r) : ''),
        el('td', { class: 'l muted', text: br }),
        ...cols.map((c) => {
          const run = runs.find((x) => x.file === c);
          if (!run) return el('td', { class: 'muted', text: '·' });
          const state = run.status !== 'completed' ? 'running' : run.conclusion || 'neutral';
          const a = el('a', { class: 'chip ' + state, href: run.url, target: '_blank', rel: 'noopener', text: state === 'success' ? '✓' : state === 'failure' ? '✕' : state === 'running' ? '…' : '–' });
          a.addEventListener('pointerenter', (ev) => showTip(ev, [[`${r.name} · ${br} · ${label(c)}`, 'k'], [`${state} · ${d3.utcFormat('%b %-d %H:%M')(new Date(run.at))}`]]));
          a.addEventListener('pointerleave', hideTip);
          return el('td', {}, a);
        }))))
    );
  }

  // ---------------------------------------------------------------- PRs and flow
  const prRows = repos.flatMap((r) => (r.gh?.prs.list || []).map((p) => ({ ...p, repo: r })));
  prRows.sort((a, b2) => (b2.age_days || 0) - (a.age_days || 0));
  document.getElementById('pr-table').replaceChildren(
    el('thead', {}, el('tr', {}, el('th', { text: 'Repository' }), el('th', { class: 'l', text: 'Pull request' }), el('th', { class: 'l sec', text: 'Author' }), el('th', { text: 'Age' }))),
    el('tbody', {}, ...(hasGH ? prRows.map((p) => el('tr', { class: p.draft ? 'muted' : '' },
      el('td', {}, el('span', { class: 'repo', text: p.repo.name })),
      el('td', { class: 'l' }, el('a', { href: p.url, target: '_blank', rel: 'noopener', text: `#${p.number} ${(p.title || '').slice(0, 70)}` })),
      el('td', { class: 'l sec muted', text: p.author }),
      el('td', { class: !p.draft && p.age_days > 30 ? 'warn' : '', text: ageLabel(p.age_days) }))) : [el('tr', {}, el('td', { class: 'muted', text: 'Needs the GitHub API step of the build.' }))])));

  document.getElementById('flow-table').replaceChildren(
    el('thead', {}, el('tr', {}, ...['Repository', 'Issues opened', 'Issues closed', 'Net', 'PRs merged', 'Median days to merge'].map((t) => el('th', { text: t })))),
    el('tbody', {}, ...repos.filter((r) => r.gh).map((r) => {
      const i = r.gh.issues, p = r.gh.prs, net = i.opened_90d - i.closed_90d;
      return el('tr', {}, el('td', {}, repoLink(r)), el('td', { text: fmt(i.opened_90d) }), el('td', { text: fmt(i.closed_90d) }),
        el('td', { class: net > 0 ? 'warn' : 'okc', text: (net > 0 ? '+' : '') + net }),
        el('td', { text: fmt(p.merged_90d) }), el('td', { text: n(p.median_days_to_merge, (v) => v.toFixed(1)) }));
    })));

  // ---------------------------------------------------------------- small multiples
  const mult = document.getElementById('mult');
  const ymax = d3.max(repos, (r) => d3.max(r.git.monthly, (m) => m.commits)) || 1;
  const parseM = d3.utcParse('%Y-%m');
  const ordered = repos.slice().sort((a, b2) => b2.git.commits_12m - a.git.commits_12m);
  mult.replaceChildren(...ordered.map((r) => {
    const cell = el('div', {}, el('div', { class: 'mult-n' }, el('span', { text: r.name }), el('span', { text: fmt(r.git.commits_12m) })));
    const W = 220, H = 70, mb = 14;
    const x = d3.scaleBand(r.git.monthly.map((m) => m.month), [0, W]).padding(0.2);
    const y = d3.scaleLinear([0, ymax], [H - mb, 4]);
    const svg = d3.select(cell).append('svg').attr('viewBox', `0 0 ${W} ${H}`).attr('role', 'img').attr('aria-label', `${r.name} commits per month`);
    svg.append('line').attr('x1', 0).attr('x2', W).attr('y1', H - mb + 0.5).attr('y2', H - mb + 0.5).attr('stroke', 'var(--line)');
    svg.selectAll('rect').data(r.git.monthly).join('rect')
      .attr('x', (m) => x(m.month)).attr('width', x.bandwidth()).attr('y', (m) => y(m.commits)).attr('height', (m) => y(0) - y(m.commits))
      .attr('rx', 1.5).attr('fill', 'var(--accent)')
      .on('pointerenter pointermove', (ev, m) => showTip(ev, [[`${r.name} · ${d3.utcFormat('%b %Y')(parseM(m.month))}`, 'k'], [`${m.commits} commits`]]))
      .on('pointerleave', hideTip);
    const lab = (m) => d3.utcFormat('%b %y')(parseM(m.month));
    svg.append('text').attr('x', 0).attr('y', H - 2).attr('font-size', 10).attr('fill', 'var(--muted)').text(lab(r.git.monthly[0]));
    svg.append('text').attr('x', W).attr('y', H - 2).attr('text-anchor', 'end').attr('font-size', 10).attr('fill', 'var(--muted)').text(lab(r.git.monthly[r.git.monthly.length - 1]));
    return cell;
  }));

  // ---------------------------------------------------------------- trends
  const palette = ['#2b6cb0', '#c05621', '#2f855a', '#9b2c2c', '#6b46c1', '#b7791f', '#2c7a7b', '#97266d'];
  const sel = document.getElementById('trend-metric');
  function drawTrend() {
    const box = document.getElementById('trend');
    box.replaceChildren();
    const key = sel.value;
    const pts = history.filter((h) => h[key] != null).map((h) => ({ ...h, d: new Date(h.date) }));
    const dates = new Set(pts.map((p) => p.date));
    if (dates.size < 2) {
      box.append(el('p', { class: 'note', text: 'Trends appear after the second build that records this measure.' }));
      return;
    }
    const W = Math.max(320, box.clientWidth), H = 260, m = { t: 10, r: 120, b: 24, l: 40 };
    const x = d3.scaleUtc(d3.extent(pts, (p) => p.d), [m.l, W - m.r]);
    const y = d3.scaleLinear([0, d3.max(pts, (p) => p[key])], [H - m.b, m.t]).nice();
    const svg = d3.select(box).append('svg').attr('viewBox', `0 0 ${W} ${H}`);
    svg.append('g').attr('transform', `translate(0,${H - m.b})`).call(d3.axisBottom(x).ticks(Math.max(2, Math.floor(W / 120))).tickSizeOuter(0))
      .attr('font-size', null).attr('font-family', null).call((g) => g.selectAll('text').attr('fill', 'var(--muted)')).call((g) => g.selectAll('line,path').attr('stroke', 'var(--line)'));
    svg.append('g').attr('transform', `translate(${m.l},0)`).call(d3.axisLeft(y).ticks(5).tickSize(-(W - m.l - m.r)))
      .attr('font-size', null).attr('font-family', null).call((g) => g.select('.domain').remove())
      .call((g) => g.selectAll('line').attr('stroke', 'var(--grid)')).call((g) => g.selectAll('text').attr('fill', 'var(--muted)'));
    const series = d3.groups(pts, (p) => p.repo);
    const line = d3.line().x((p) => x(p.d)).y((p) => y(p[key]));
    const labels = [];
    series.forEach(([repo, s], i) => {
      const c = palette[i % palette.length];
      svg.append('path').datum(s).attr('fill', 'none').attr('stroke', c).attr('stroke-width', 2).attr('stroke-linecap', 'round').attr('stroke-linejoin', 'round').attr('d', line);
      const last = s[s.length - 1];
      labels.push({ x: x(last.d) + 6, y: y(last[key]), c, t: `${repo} ${fmt(last[key])}` });
    });
    // keep end labels at least 13px apart
    labels.sort((a, b2) => a.y - b2.y);
    for (let i = 1; i < labels.length; i++) labels[i].y = Math.max(labels[i].y, labels[i - 1].y + 13);
    const over = labels.length ? labels[labels.length - 1].y - (H - m.b) : 0;
    if (over > 0) labels.forEach((l) => { l.y -= over; });
    labels.forEach((l) => svg.append('text').attr('x', l.x).attr('y', l.y).attr('dy', '0.32em').attr('font-size', 11).attr('fill', l.c).text(l.t));
  }
  sel.addEventListener('change', drawTrend);
  drawTrend();
  window.addEventListener('resize', () => requestAnimationFrame(drawTrend));

  // ---------------------------------------------------------------- hotspots
  const hot = repos.flatMap((r) => (r.c?.hotspots || []).map((h) => ({ ...h, repo: r.name })));
  const hotTable = document.getElementById('hot-table');
  const q = document.getElementById('hot-q');
  function drawHot() {
    const s = q.value.trim().toLowerCase();
    const rows = hot.filter((h) => !s || `${h.repo} ${h.name} ${h.file}`.toLowerCase().includes(s));
    hotTable.replaceChildren(
      el('thead', {}, el('tr', {}, ...['Repository', 'Function', 'File', 'CC', 'Grade'].map((t, i) => el('th', { class: i === 1 ? 'l' : i === 2 ? 'l sec' : '', text: t })))),
      el('tbody', {}, ...rows.map((h) => el('tr', {},
        el('td', {}, el('span', { class: 'repo', text: h.repo })),
        el('td', { class: 'l mono', text: h.name }),
        el('td', { class: 'l sec mono muted', text: `${h.file}:${h.line}` }),
        el('td', { class: h.cc > 20 ? 'warn' : '', text: h.cc }),
        el('td', { text: h.rank })))));
  }
  q.addEventListener('input', drawHot);
  drawHot();
})();
