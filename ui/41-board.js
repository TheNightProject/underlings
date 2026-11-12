const BOARD_COLUMNS = [
  ['total', 'Total', 'The four counts, weighted by the points below'],
  ['opened', 'Opened', 'MRs they opened in the window'],
  ['reviewed', 'Reviewed', 'Other people\'s MRs they commented on or approved, each counted once'],
  ['comments', 'Comments', 'Review comments on other people\'s MRs'],
  ['approved', 'Approved', 'Approvals of other people\'s MRs'],
];
const BOARD_MEDALS = [['🥇', 'First'], ['🥈', 'Second'], ['🥉', 'Third']];
const BOARD_SERIES = [['opened', 'Opened', 's-info'], ['merged', 'Merged', 's-done'], ['reviews', 'Reviews', 's-working']];
const LEGEND_TONES = { green: 's-done', red: 's-need', yellow: 's-working', gray: 's-quiet', cyan: 's-info', magenta: 's-moved', blue: 's-accent' };
const LEGEND_PIPELINES = { passed: 'SUCCESS', failed: 'FAILED', running: 'RUNNING', skipped: 'SKIPPED' };
let boardTicker = null;

function boardUi() {
  ui.board ??= { sort: 'total', scrollLeft: 0, data: null, error: null, seen: null, legend: false, legendData: null, legendError: null };
  return ui.board;
}

function viewLeaderboard() {
  const b = boardUi();
  loadBoard(b);
  const data = b.data;
  const board = data?.board ?? null;
  const building = Boolean(data?.startedAt);
  tickBoard(building);
  const sub = board
    ? `Who opened MRs and who reviewed them over the last ${plural(board.days, 'day')}, across ${plural(board.repos, 'repo')}.`
    : 'Who opened MRs and who reviewed them over the leaderboard window.';
  return [
    header('Leaderboard', sub, boardBuildButton(data)),
    state.matrix.available ? null : slot('engineBanner', state.matrix),
    data?.missing?.length ? banner('This review engine build cannot build the board: it has no ' + data.missing.join(', ') + '.', true, boardRebuild()) : null,
    b.error ? banner('Could not read the board: ' + b.error, true) : null,
    data?.error ? banner('The last build failed: ' + data.error, true) : null,
    !data && !b.error ? el('p', { class: 'meta' }, 'Loading…') : null,
    data && !board && !building ? banner('Not built yet. A build reads every MR and review in the window from GitLab, which takes about a minute.') : null,
    building ? boardProgress(data, Boolean(board)) : null,
    board ? boardResults(board, data.bots, building) : null,
  ];
}

// Refetched once per snapshot, so the broadcasts a build sends while it runs are what move its progress on.
function loadBoard(b) {
  if (b.seen === state.generatedAt) return;
  b.seen = state.generatedAt;
  api('/api/matrix/board')
    .then((data) => { b.data = data; b.error = null; }, (e) => { b.error = e.message; })
    .finally(() => { if (view() === 'leaderboard') render(true); });
}

function boardBuildButton(data) {
  const building = Boolean(data?.startedAt);
  const starting = ui.busy.has('board-build');
  const disabled = building || starting || !state.matrix.available;
  return el('button', { id: 'board-build', class: data?.board || building ? null : 'primary', disabled, onclick: () => startBoardBuild(data?.bots ?? false) },
    icon(building || starting ? 'clock' : data?.board ? 'rotate-ccw' : 'play'), building ? 'Building…' : starting ? 'Starting…' : data?.board ? 'Rebuild' : 'Build');
}

// Rebuild the engine comes with the self-heal file, and slot() would count its absence as a broken part of the page.
function boardRebuild() {
  return typeof rebuildButton === 'function' ? el('div', { class: 'actions board-rebuild' }, rebuildButton()) : null;
}

async function startBoardBuild(bots) {
  const b = boardUi();
  if (b.data) b.data = { ...b.data, bots };
  await matrixAct('board', { bots }, 'board-build');
  b.seen = null;
}

function boardProgress(data, keepsLast) {
  const p = data.progress;
  return section('Building',
    el('ol', { class: 'board-stages' }, data.stages.map((stage, i) => boardStage(stage, i, p))),
    el('p', { class: 'meta' },
      p ? plural(p.found.mrs, 'merge request') + ', ' + plural(p.found.comments, 'comment') : 'Starting',
      ' · ', el('span', { id: 'board-elapsed' }, boardElapsed(data.startedAt))),
    keepsLast ? el('p', { class: 'meta' }, 'The last build stays below until this one lands.') : null);
}

function boardStage(stage, i, p) {
  const done = Boolean(p && p.step > i);
  const current = p?.step === i;
  const total = current ? p.total : 0;
  const at = current ? Math.min(p.done, p.total) : 0;
  const share = done ? 1 : total > 0 ? at / total : 0;
  return el('li', { class: 'board-stage ' + (done ? 's-done' : current ? 's-info' : 's-quiet'), 'aria-current': current ? 'step' : null },
    icon(done ? 'check' : current ? 'play' : 'circle'),
    el('span', { class: 'name' }, stage),
    el('span', { class: 'bar', role: 'progressbar', 'aria-label': stage, 'aria-valuemin': 0, 'aria-valuemax': 100, 'aria-valuenow': Math.round(share * 100) },
      el('span', { style: 'width: ' + (share * 100).toFixed(1) + '%' })),
    el('span', { class: 'meta' }, total > 0 ? at + '/' + total : done ? 'done' : ''));
}

function boardElapsed(startedAt) {
  const s = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  return s < 60 ? s + ' s' : Math.floor(s / 60) + ' min ' + (s % 60) + ' s';
}

function tickBoard(building) {
  if (!building) {
    clearInterval(boardTicker);
    boardTicker = null;
    return;
  }
  boardTicker ??= setInterval(() => {
    const node = document.getElementById('board-elapsed');
    if (node && ui.board?.data?.startedAt) node.textContent = boardElapsed(ui.board.data.startedAt);
    else tickBoard(false);
  }, 1000);
}

function boardResults(board, bots, building) {
  const b = boardUi();
  const people = board.scores.length === 1 ? '1 person' : board.scores.length + ' people';
  const w = board.weights ?? {};
  return [
    el('div', { class: 'filters board-info' },
      metaLine('since ' + dateText(Date.parse(board.since)), plural(board.repos, 'repo'), people, 'built ' + ago(board.builtAt)),
      el('label', { class: 'board-toggle', title: 'Bots and CI accounts are left out unless this is on. Changing it rebuilds the board.' },
        el('input', { type: 'checkbox', id: 'board-bots', checked: bots, disabled: building || ui.busy.has('board-build') || !state.matrix.available, onchange: (e) => startBoardBuild(e.target.checked) }),
        'Count service accounts')),
    board.partial.length ? banner(plural(board.partial.length, 'repo') + ' had more activity than one window could hold, so their numbers are a floor: ' + board.partial.map((p) => p.split('/').pop()).join(', ') + '.', true) : null,
    section('Per day', el('div', { class: 'board-charts' }, BOARD_SERIES.map(([key, label, tone]) => lineChart(board.series[key] ?? [], { label, tone, end: board.builtAt })))),
    section('Scores',
      board.scores.length ? boardTable(boardSorted(board.scores, b.sort), b.sort) : empty('Nobody opened or reviewed an MR in the window.'),
      el('p', { class: 'meta' }, `Points: ${w.opened} per MR opened, ${w.reviewed} per MR reviewed, ${w.comments} per comment, ${w.approved} per approval.`)),
  ];
}

function boardSorted(scores, key) {
  const order = [key, ...BOARD_COLUMNS.map(([k]) => k).filter((k) => k !== key)];
  return [...scores].sort((a, b) => {
    for (const k of order) if (b[k] !== a[k]) return b[k] - a[k];
    return a.user.localeCompare(b.user);
  });
}

// render() attaches the new table only after this returns, so its sideways scroll is put back a microtask later.
function keepBoardScroll(wrap) {
  const b = boardUi();
  wrap.addEventListener('scroll', () => { if (wrap.isConnected) b.scrollLeft = wrap.scrollLeft; });
  Promise.resolve().then(() => { wrap.scrollLeft = b.scrollLeft; });
  return wrap;
}

function boardTable(rows, sort) {
  return keepBoardScroll(el('div', { class: 'tablewrap' }, el('table', { class: 'board-table' },
    el('thead', {}, el('tr', {},
      el('th', { scope: 'col', class: 'rank' }, el('span', { class: 'offscreen' }, 'Rank')),
      el('th', { scope: 'col', class: 'who' }, 'Who'),
      BOARD_COLUMNS.map(([key, label, hint]) => el('th', { scope: 'col', class: 'num', 'aria-sort': key === sort ? 'descending' : null },
        el('button', { id: 'board-sort-' + key, class: 'sort', title: hint + '. Sorts by this.', 'aria-pressed': String(key === sort), onclick: () => { boardUi().sort = key; render(true); } },
          label, key === sort ? icon('down') : null))))),
    el('tbody', {}, rows.map((s, i) => el('tr', {},
      el('td', { class: 'rank' }, i < BOARD_MEDALS.length ? el('span', { role: 'img', 'aria-label': BOARD_MEDALS[i][1], title: BOARD_MEDALS[i][1] }, BOARD_MEDALS[i][0]) : String(i + 1)),
      el('td', { class: 'who', title: s.user }, s.user),
      BOARD_COLUMNS.map(([key]) => el('td', { class: 'num' + (key === sort ? ' sorted' : '') }, String(s[key])))))))));
}

// Each line is scaled to its own peak, since reviews outnumber merges several times over and one scale flattens the rest.
function lineChart(values, { label, tone, end }) {
  const total = values.reduce((sum, v) => sum + v, 0);
  const peak = Math.max(0, ...values);
  const [w, h] = [300, 60];
  const x = (i) => (values.length > 1 ? (i / (values.length - 1)) * w : w / 2).toFixed(1);
  const y = (v) => (h - 2 - (peak ? (v / peak) * (h - 6) : 0)).toFixed(1);
  const points = values.map((v, i) => x(i) + ',' + y(v));
  const chart = boardSvg('svg', { viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: 'none', role: 'img', 'aria-label': `${label} per day: ${total} over ${plural(values.length, 'day')}, at most ${peak} in a day` },
    boardSvg('polygon', { class: 'area', points: [`0,${h - 2}`, ...points, `${w},${h - 2}`].join(' ') }),
    boardSvg('line', { class: 'base', x1: 0, y1: h - 2, x2: w, y2: h - 2 }),
    boardSvg('polyline', { class: 'line', points: points.join(' ') }));
  return el('figure', { class: 'board-chart ' + tone },
    el('figcaption', {}, el('b', {}, label), el('span', { class: 'meta' }, total + ' in all, at most ' + peak + ' a day')),
    chart,
    el('div', { class: 'axis meta' }, el('span', {}, dateText(end - Math.max(values.length - 1, 0) * 864e5)), el('span', {}, dateText(end))));
}

function boardSvg(tag, attrs, ...kids) {
  const node = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, v);
  node.append(...kids);
  return node;
}

function headerExtras() {
  return el('button', {
    id: 'legend-toggle', class: 'icon-only', title: 'What the colours and badges mean', 'aria-label': 'Key to the colours and badges',
    'aria-expanded': String(Boolean(ui.board?.legend)), 'aria-controls': 'legend', onclick: () => (boardUi().legend ? closeLegend(true) : openLegend()),
  }, icon('help'));
}

function openLegend() {
  const b = boardUi();
  b.legend = true;
  document.getElementById('legend-toggle')?.setAttribute('aria-expanded', 'true');
  legendPopover().focus();
  if (!b.legendData || b.legendData.missing.length) loadLegend(b);
}

function loadLegend(b) {
  b.legendError = null;
  api('/api/matrix/legend')
    .then((data) => { b.legendData = data; }, (e) => { b.legendError = e.message; })
    .finally(() => { if (b.legend) legendPopover(); });
}

function closeLegend(returnFocus) {
  boardUi().legend = false;
  legendPopover();
  const toggle = document.getElementById('legend-toggle');
  toggle?.setAttribute('aria-expanded', 'false');
  if (returnFocus) toggle?.focus();
}

// Kept outside main so a refresh mid-read leaves its scroll alone, and inside .app so an open drawer makes it inert.
function legendPopover() {
  const b = boardUi();
  let node = document.getElementById('legend');
  if (!node) {
    node = el('div', { id: 'legend', class: 'legend', role: 'dialog', 'aria-label': 'Key to the colours and badges', tabindex: '-1' });
    document.querySelector('.app').append(node);
  }
  node.hidden = !b.legend;
  if (!b.legend) return node;
  const body = b.legendError ? banner('Could not read the key: ' + b.legendError, true) : b.legendData ? legendGroups(b.legendData) : el('p', { class: 'meta' }, 'Loading…');
  node.replaceChildren(...[
    el('div', { class: 'legend-head' },
      el('h2', {}, 'Key'),
      el('button', { class: 'icon-only', title: 'Close (Esc)', 'aria-label': 'Close the key', onclick: () => closeLegend(true) }, icon('x'))),
    body,
  ].flat().filter(Boolean));
  return node;
}

function legendGroups(data) {
  const moods = typeof MOOD === 'object' ? MOOD : {};
  const pill = (mood) => el('span', { class: 'pill ' + (moods[mood]?.tone || 's-quiet') }, moods[mood]?.label ?? mood);
  const chip = (label) => (LEGEND_PIPELINES[label] ? slot('pipelineChip', { pipeline: LEGEND_PIPELINES[label] }) : null) ?? label;
  return [
    el('p', { class: 'meta' }, 'Each glyph is how the review engine marks a row; beside each is what it means, or how this page shows the same thing.'),
    legendGroup('Row colour', data.moods.map(({ mood, label }) => [pill(mood), label])),
    legendGroup('Review', data.review.map(({ glyph, label }) => [legendGlyph(glyph), label])),
    legendGroup('Pipeline', data.pipeline.map(({ glyph, colour, label }) => [legendGlyph(glyph, colour), chip(label)])),
    legendGroup('Ticket badges', data.tickets.map(({ glyph, label }) => [legendGlyph(glyph), label])),
    data.missing.length ? banner('This review engine build has no ' + data.missing.join(', ') + ', so part of the key is missing.', true, boardRebuild()) : null,
  ];
}

function legendGroup(title, entries) {
  if (!entries.length) return null;
  return el('section', { class: 'legend-group' }, el('h3', {}, title),
    el('dl', {}, entries.map(([look, meaning]) => [el('dt', {}, look), el('dd', {}, meaning)])));
}

function legendGlyph(glyph, colour) {
  return el('span', { class: 'legend-glyph ' + (LEGEND_TONES[colour] ?? '') }, glyph);
}

document.addEventListener('click', (e) => {
  if (ui.board?.legend && !e.target.closest?.('#legend') && !e.target.closest?.('#legend-toggle')) closeLegend(false);
});
