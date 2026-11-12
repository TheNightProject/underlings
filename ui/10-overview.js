const STAT_LINKS = {
  waiting: ['#merge-requests', () => scopeMrs('asking')],
  firstReview: ['#merge-requests', () => scopeMrs('asking')],
  findings: ['#review-queue', () => { ui.queueFilter = 'posted'; }],
  open: ['#merge-requests', () => scopeMrs('mine')],
  fullAuto: ['#full-auto', () => { ui.peopleSearch = ''; }],
  runs: ['#review-runs', null],
};
const STAT_WORDS = { good: 'better', bad: 'worse' };
const FATE_TONES = { posted: 'viz-c1', discarded: 'viz-c2', handedBack: 'viz-c3', waiting: 'viz-c4', withdrawn: 'viz-c5' };
const PEOPLE_TONES = { sent: 'viz-c1', handedBack: 'viz-c3' };
const LINES_SHOWN = 8;
const KEYS_IN_TIP = 3;

function statsUi() {
  ui.stats ??= { data: null, error: null, seen: null };
  return ui.stats;
}

function viewOverview(d) {
  const s = statsUi();
  loadStats(s);
  const live = state.matrix.available;
  return [
    header('Overview', 'How your reviewing and your own MRs are going, this week against the week before.'),
    live ? null : slot('engineBanner', state.matrix),
    slot('calendarNextUp'),
    live ? statsState(s) : null,
    s.data ? statTiles(s.data.headline) : null,
    s.data ? statCharts(s.data.charts) : null,
    overviewQa(),
    el('div', { class: 'two' },
      section('Needs you now', needsNowList()),
      section('Working now', lineList(workingLines(d), 'No agent is working right now.', '#agents'))),
    s.data ? statDefinitions(s.data) : null,
  ];
}

// Refetched once per snapshot, and the last figures stay on screen while the next ones load.
function loadStats(s) {
  if (s.seen === state.generatedAt) return;
  s.seen = state.generatedAt;
  api('/api/stats?' + new URLSearchParams(pageLocale().timeZone ? { tz: pageLocale().timeZone } : {}))
    .then((data) => {
      if (!Array.isArray(data?.headline)) throw new Error('the worker sent no figures, so it may need a Reload');
      s.data = data;
      s.error = null;
    })
    .catch((e) => { s.error = e.message; })
    .finally(() => { if (view() === 'overview') render(true); });
}

function statsState(s) {
  if (s.error) return el('p', { class: 'stat-state bad' }, icon('alert'), 'Could not work out the figures: ' + s.error);
  return s.data ? null : el('p', { class: 'stat-state' }, icon('clock'), 'Working out the figures…');
}

function statTiles(headline) {
  return el('div', { class: 'stats' }, headline.map(statTile));
}

function statTile(h) {
  const [hash, setup] = STAT_LINKS[h.id] ?? ['#overview'];
  const known = h.value != null;
  return el('a', { class: 'stat', id: 'stat-' + h.id, ...inPage(hash, setup) },
    el('span', { class: 'stat-label' }, h.label),
    known ? el('b', { class: 'stat-value' }, statFigure(h.value, h.unit)) : el('span', { class: 'stat-empty' }, h.empty),
    known ? statDelta(h) : null,
    known && h.note ? statNote(h) : null);
}

function statNote(h) {
  return h.alert ? el('span', { class: 'stat-note alert' }, icon('alert'), h.note) : el('span', { class: 'stat-note' }, h.note);
}

function statFigure(value, unit) {
  return unit === 'duration' ? vizDuration(value) : vizCompact(value);
}

function statDelta(h) {
  if (h.change == null) return el('span', { class: 'stat-delta none' }, h.before ?? 'Nothing to compare with');
  return el('span', { class: 'stat-delta ' + h.tone },
    h.change ? icon(h.change > 0 ? 'up' : 'down') : null,
    statChange(h.change, h.unit) + ' on the week before',
    STAT_WORDS[h.tone] ? el('span', { class: 'offscreen' }, ', ' + STAT_WORDS[h.tone]) : null);
}

function statChange(change, unit) {
  if (!change) return 'No change';
  return (change > 0 ? '+' : '−') + statFigure(Math.abs(change), unit);
}

function statDay(key, brief) {
  return dayText(key, brief ? { weekday: 'short', day: 'numeric' } : { weekday: 'long', day: 'numeric', month: 'short' });
}

function statDate(iso) {
  return dateText(iso);
}

function statCharts(c) {
  return el('div', { class: 'stat-charts' },
    perDayFigure(c.perDay), severityFigure(c.severity), stagesFigure(c.stages), mergeFigure(c.merge), agesFigure(c.ages), peopleFigure(c.people));
}

function perDayFigure(chart) {
  const tones = chart.series.map(([id]) => FATE_TONES[id]);
  const columns = chart.days.map((day) => {
    const values = chart.series.map(([id]) => day[id]);
    return { label: statDay(day.day, true), values, readout: { title: statDay(day.day), rows: chart.series.map(([, label], j) => [String(values[j]), label.toLowerCase(), tones[j]]) } };
  });
  return vizFigure({
    id: 'per-day', title: chart.title, sub: 'last 14 days', wide: true, empty: chart.empty,
    legend: chart.series.map(([, label], j) => [label, tones[j]]),
    draw: (width) => vizColumns({ id: 'per-day', columns, tones, width }),
    table: vizTable('per-day', ['Day', ...chart.series.map(([, label]) => label)], chart.days.map((day) => [statDay(day.day), ...chart.series.map(([id]) => String(day[id]))])),
  });
}

const ordinalTone = (i, count, mostFirst) => 'viz-o' + (mostFirst ? Math.max(1, count - i) : Math.min(count, i + 1));

function severityFigure(chart) {
  const rows = chart.rows.map((r, i) => ({
    label: r.label, values: [r.total], tones: [ordinalTone(i, 5, true)],
    readout: { title: r.label, rows: [[String(r.total), 'raised'], ...chart.series.map(([id, label]) => [String(r[id]), label.toLowerCase()])] },
  }));
  return vizFigure({
    id: 'severity', title: chart.title, sub: 'last 7 days', empty: chart.empty,
    draw: (width) => vizBars({ id: 'severity', rows, width }),
    table: vizTable('severity', ['Severity', 'Raised', ...chart.series.map(([, label]) => label)], chart.rows.map((r) => [r.label, String(r.total), ...chart.series.map(([id]) => String(r[id]))])),
  });
}

function stagesFigure(chart) {
  const rows = chart.rows.map((r, i) => ({
    label: r.label, values: [r.count], tones: [ordinalTone(i, 5)],
    readout: { title: r.label, rows: [[String(r.count), r.count === 1 ? 'MR' : 'MRs']], note: someKeys(r.mrs) },
  }));
  return vizFigure({
    id: 'stages', title: chart.title, sub: 'now', empty: chart.empty,
    draw: (width) => vizBars({ id: 'stages', rows, width }),
    table: vizTable('stages', ['Stage', 'MRs', 'Which'], chart.rows.map((r) => [r.label, String(r.count), r.mrs.map((mr) => short(mr.key)).join(', ')])),
  });
}

function someKeys(mrs) {
  const named = mrs.slice(0, KEYS_IN_TIP).map((mr) => short(mr.key)).join(', ');
  return mrs.length > KEYS_IN_TIP ? named + ' and ' + (mrs.length - KEYS_IN_TIP) + ' more' : named || null;
}

function mergeFigure(chart) {
  const points = chart.points.map((p) => ({ ms: p.ms, readout: { title: short(p.key) + ' ' + p.title, rows: [[vizDuration(p.ms), 'to merge'], [statDate(p.mergedAt), 'merged']] } }));
  return vizFigure({
    id: 'merge', title: chart.title, sub: chart.empty ? 'last 30 days' : plural(points.length, 'MR') + ' merged in the last 30 days', wide: true, empty: chart.empty,
    draw: (width) => vizDots({ id: 'merge', points, median: chart.median, width }),
    table: vizTable('merge', ['MR', 'To merge', 'Merged'], [...chart.points].reverse().map((p) => [short(p.key) + ' ' + p.title, vizDuration(p.ms), statDate(p.mergedAt)])),
  });
}

function agesFigure(chart) {
  const rows = chart.rows.map((r, i) => ({ label: r.label, values: [r.count], tones: [ordinalTone(i, 5)], readout: { title: r.label, rows: [[String(r.count), 'waiting']] } }));
  return vizFigure({
    id: 'ages', title: chart.title, sub: chart.oldestAt ? 'oldest queued ' + ago(chart.oldestAt) : 'now', empty: chart.empty,
    draw: (width) => vizBars({ id: 'ages', rows, width }),
    table: vizTable('ages', ['Waiting', 'Items'], chart.rows.map((r) => [r.label, String(r.count)])),
  });
}

function peopleFigure(chart) {
  const tones = chart.series.map(([id]) => PEOPLE_TONES[id]);
  const rows = chart.rows.map((r) => ({
    label: r.person, values: chart.series.map(([id]) => r[id]), tones,
    readout: { title: r.person, rows: chart.series.map(([id, label], j) => [String(r[id]), label.toLowerCase(), tones[j]]) },
  }));
  return vizFigure({
    id: 'people', title: chart.title, sub: 'last 7 days', empty: chart.empty,
    legend: chart.series.map(([, label], j) => [label, tones[j]]),
    draw: (width) => vizBars({ id: 'people', rows, width }),
    table: vizTable('people', ['Person', ...chart.series.map(([, label]) => label)], chart.rows.map((r) => [r.person, ...chart.series.map(([id]) => String(r[id]))])),
  });
}

function statDefinitions(data) {
  const g = data.gitlab;
  const read = g.fetchedAt ? 'GitLab was last read ' + ago(g.fetchedAt) : 'GitLab has not been read yet';
  return el('section', { class: 'section' }, vizDisclosure('stat-defs', { class: 'stat-defs' }, el('summary', { id: 'stat-defs' }, 'How these are worked out'),
    el('dl', { class: 'kv' }, data.definitions.map(({ name, defines }) => [el('dt', {}, name), el('dd', {}, defines)])),
    el('p', { class: 'meta' }, read + (g.error ? ', and the last try failed: ' + g.error : '') + '. It is read again at most every 15 minutes.')));
}

// Shares the QA view's read and cache, so the Overview never starts a Jira read of its own.
function overviewQa() {
  if (!featureOn('qa')) return null;
  const board = qaData(qaBox())?.board;
  if (!board) return null;
  const rows = qaRows(board, board.tickets);
  return section('QA', qaStrip(board.tickets), rows.length
    ? el('div', { class: 'lines' }, rows.slice(0, LINES_SHOWN).map(overviewQaLine), el('a', { class: 'line-more', ...inPage('#qa') }, 'Open QA'))
    : empty('Nothing is waiting in QA.'));
}

function overviewQaLine(row) {
  const oldest = [...row.tickets].sort(qaOldestFirst)[0];
  return el('a', { class: 'line', ...inPage('#qa', () => Object.assign(qaBox(), { repo: row.repo, person: '', cell: null })) },
    el('span', { class: 'pill ' + (row.orphan ? 's-need' : 's-accent') }, String(row.tickets.size)),
    el('span', { class: 'line-title', title: row.label }, row.label),
    el('span', { class: 'meta' }, 'oldest ' + qaDays(oldest.days)));
}

function needsNowList() {
  const now = slot('needsNow') ?? { lines: [], more: null };
  return [lineList(now.lines, 'Nothing is waiting on you.', '#needs-you'), now.more ? el('a', { class: 'line-more', ...inPage('#needs-you') }, now.more) : null];
}

function workingLines(d) {
  return d.working.map((a) => ({ tone: 's-working', count: 'working', title: a.name, at: a.since, hash: '#agents', setup: () => { ui.agentFilter = 'working'; ui.agentSearch = ''; } }));
}

function lineList(lines, none, allHash) {
  if (!lines.length) return empty(none);
  return el('div', { class: 'lines' },
    lines.slice(0, LINES_SHOWN).map((line) => el('a', { class: 'line', ...inPage(line.hash, line.setup) },
      el('span', { class: 'pill ' + line.tone }, line.count),
      el('span', { class: 'line-title', title: line.title }, line.title),
      el('span', { class: 'meta' }, ago(line.at)))),
    lines.length > LINES_SHOWN ? el('a', { class: 'line-more', ...inPage(allHash) }, 'All ' + lines.length) : null);
}
