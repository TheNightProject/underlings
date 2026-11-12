const QA_NO_MR = '(none)';
const QA_NOBODY = '(nobody)';
const QA_STEPS = [[1, 'qa-q1', '1'], [2, 'qa-q2', '2'], [4, 'qa-q3', '3 to 4'], [7, 'qa-q4', '5 to 7'], [Infinity, 'qa-q5', '8 or more']];

function qaBox() {
  ui.qa ??= { data: null, error: null, loading: false, at: null, repo: '', person: '', cell: null, drafts: {} };
  return ui.qa;
}

// The worker says when a read has finished, so the page reads again on every state it holds.
function qaData(box) {
  if (box.at !== state.generatedAt && !box.loading) loadQa(box);
  return box.data;
}

async function loadQa(box) {
  Object.assign(box, { loading: true, at: state.generatedAt });
  try {
    box.data = await api('/api/qa');
    box.error = null;
  } catch (e) {
    box.error = e.message;
  }
  box.loading = false;
  render(true);
}

function viewQa() {
  const box = qaBox();
  const data = qaData(box);
  const board = data?.board ?? null;
  const tickets = board ? qaFiltered(board.tickets, box) : [];
  const listed = qaListed(tickets, box);
  return [
    header('QA', 'Every ticket waiting for testing across the team, by repo and how long it has waited. Click a cell to list its tickets.',
      qaRefreshButton(data), board ? button('Copy for Slack', 'copy', () => copyQa(listed, board), true) : null),
    box.error ? banner('Could not read QA: ' + box.error, true) : null,
    data?.error ? banner((board ? 'The last read failed, so this is from ' + ago(board.generatedAt) + ': ' : 'Could not read QA: ') + data.error, true) : null,
    board && board.jql !== data.jql ? banner('This was read for ' + board.jql + '. Reading ' + data.jql + ' now.') : null,
    data && data.configured === false ? qaUnset(data) : qaWaiting(box, data),
    board ? [qaAbout(data), qaFilters(board, box), qaStrip(tickets), qaHeatSection(board, tickets, box), qaListSection(listed, box, board)] : null,
  ];
}

function qaUnset(data) {
  return el('div', { class: 'empty qa-unset' }, icon('flask'),
    el('div', {}, el('p', {}, 'QA lists every ticket waiting for testing once it knows where to look.'),
      el('p', { class: 'hint' }, 'In Settings, under QA, give the JQL for your tickets in QA, such as ', el('code', {}, data.example), '. Days in QA count from each ticket\'s last move to the status named ' + data.status + ', and the merged MRs are joined from ' + (data.group || 'the groups your open MRs are in') + '.'),
      el('a', { class: 'fix-link', ...inPage('#qa-settings') }, icon('settings'), 'Set up QA')));
}

function qaWaiting(box, data) {
  if (data?.board) return null;
  if (data?.refreshing) return el('p', { class: 'empty' }, icon('clock'), 'Reading every ticket in QA from Jira, and the merged MRs from GitLab…');
  if (!data && !box.error) return el('p', { class: 'empty' }, icon('clock'), 'Reading QA…');
  return null;
}

function qaRefreshButton(data) {
  const busy = Boolean(data?.refreshing) || ui.busy.has('qa-refresh');
  return el('button', { id: 'qa-refresh', disabled: busy || !data, title: 'Read Jira and the whole MR window again now', onclick: refreshQa },
    icon(busy ? 'clock' : 'refresh'), busy ? 'Reading…' : 'Refresh');
}

async function refreshQa() {
  if (await busyAct('/api/qa/refresh', {}, 'qa-refresh')) qaBox().at = null;
}

function qaAbout(data) {
  const b = data.board;
  return el('p', { class: 'hint qa-about' },
    'Read ' + ago(b.generatedAt) + ', again every 15 minutes. ', el('code', {}, b.jql),
    ', joined to MRs merged in ' + b.group + ' in the last ' + b.windowDays + ' days that name the ticket in their title or branch. Days in QA count today, from when Jira says each ticket last moved to ' + (b.status ?? 'QA') + '. ',
    el('a', { class: 'fix-link', ...inPage('#settings') }, 'Change the search'));
}

// Two repos can end in the same name, so those keep their group too.
function qaRepoLabels(tickets) {
  const paths = [...new Set(tickets.flatMap((t) => t.mrs.map((mr) => mr.project)))];
  const ends = groupBy(paths, (p) => p.split('/').pop());
  return new Map(paths.map((p) => [p, ends.get(p.split('/').pop()).length > 1 ? p.split('/').slice(-2).join('/') : p.split('/').pop()]));
}

function qaFiltered(tickets, box) {
  return tickets.filter((t) => {
    if (box.person === QA_NOBODY ? t.assignee : box.person && t.assignee !== box.person) return false;
    if (box.repo === QA_NO_MR) return !t.mrs.length;
    return !box.repo || t.mrs.some((mr) => mr.project === box.repo);
  });
}

function qaInCell(tickets, cell) {
  if (!cell) return tickets;
  return tickets.filter((t) => t.bucket === cell.bucket && (cell.repo === QA_NO_MR ? !t.mrs.length : t.mrs.some((mr) => mr.project === cell.repo)));
}

const qaAge = (t) => [t.days.from, t.days.to ?? Infinity];

function qaOldestFirst(a, b) {
  const [af, at] = qaAge(a);
  const [bf, bt] = qaAge(b);
  return bf - af || bt - at || a.key.localeCompare(b.key, 'en', { numeric: true });
}

function qaListed(tickets, box) {
  return [...qaInCell(tickets, box.cell)].sort(qaOldestFirst);
}

function qaDays(days) {
  if (days.to === null) return 'over ' + (days.from - 1) + 'd';
  return days.from === days.to ? days.from + 'd' : days.from + '-' + days.to + 'd';
}

const qaLines = (t) => t.mrs.reduce((n, mr) => n + mr.additions + mr.deletions, 0);

function qaFilters(board, box) {
  const count = (pick) => board.tickets.filter(pick).length;
  const pick = (key) => (e) => {
    Object.assign(box, { [key]: e.target.value, cell: null });
    render(true);
  };
  const clear = () => {
    Object.assign(box, { repo: '', person: '', cell: null });
    render(true);
  };
  return el('div', { class: 'filters qa-filters' }, qaRepoSelect(board, box, count, pick('repo')), qaPersonSelect(board, box, count, pick('person')),
    box.repo || box.person ? el('button', { class: 'linkish', onclick: clear }, 'Clear filters') : null);
}

function qaRepoSelect(board, box, count, onchange) {
  const repos = [...qaRepoLabels(board.tickets)].sort((a, b) => a[1].localeCompare(b[1]));
  return el('select', { id: 'qa-repo', 'aria-label': 'Repo', onchange },
    el('option', { value: '', selected: !box.repo }, 'Every repo'),
    repos.map(([path, label]) => el('option', { value: path, selected: box.repo === path }, label + ' (' + count((t) => t.mrs.some((mr) => mr.project === path)) + ')')),
    el('option', { value: QA_NO_MR, selected: box.repo === QA_NO_MR }, 'No merged MR (' + count((t) => !t.mrs.length) + ')'));
}

function qaPersonSelect(board, box, count, onchange) {
  const people = [...new Set(board.tickets.map((t) => t.assignee).filter(Boolean))].sort((a, b) => a.localeCompare(b));
  const unassigned = count((t) => !t.assignee);
  return el('select', { id: 'qa-person', 'aria-label': 'Assignee', onchange },
    el('option', { value: '', selected: !box.person }, 'Everyone'),
    people.map((p) => el('option', { value: p, selected: box.person === p }, p + ' (' + count((t) => t.assignee === p) + ')')),
    unassigned ? el('option', { value: QA_NOBODY, selected: box.person === QA_NOBODY }, 'Unassigned (' + unassigned + ')') : null);
}

function qaStrip(tickets) {
  const oldest = [...tickets].sort(qaOldestFirst)[0];
  const orphans = tickets.filter((t) => !t.mrs.length).length;
  const tile = (id, value, label, iconName, tone, extra) => el('div', { class: 'tile qa-tile ' + tone, id }, el('span', { class: 'ic' }, icon(iconName)), el('b', {}, value), ' ', el('span', {}, label, extra));
  return el('div', { class: 'qa-strip', role: 'group', 'aria-label': 'QA at a glance' },
    tile('qa-count', String(tickets.length), (tickets.length === 1 ? 'ticket' : 'tickets') + ' in QA', 'flask', 's-accent'),
    tile('qa-oldest', oldest ? qaDays(oldest.days) : 'none', oldest ? 'oldest, ' : 'nothing waiting', 'clock', oldest && oldest.days.from > 14 ? 's-working' : 's-quiet', oldest ? ticketRef(oldest.key) : null),
    tile('qa-orphans', String(orphans), 'with no merged MR', 'alert', orphans ? 's-need' : 's-quiet'));
}

function qaStep(n) {
  return QA_STEPS.find(([upTo]) => n <= upTo)[1];
}

function qaRows(board, tickets) {
  const labels = qaRepoLabels(board.tickets);
  const rows = new Map();
  const row = (repo, label) => rows.get(repo) ?? rows.set(repo, { repo, label, tickets: new Set() }).get(repo);
  for (const t of tickets) {
    const repos = new Set(t.mrs.map((mr) => mr.project));
    for (const repo of repos) row(repo, labels.get(repo)).tickets.add(t);
  }
  const sorted = [...rows.values()].sort((a, b) => b.tickets.size - a.tickets.size || a.label.localeCompare(b.label));
  const orphans = tickets.filter((t) => !t.mrs.length);
  return orphans.length ? [...sorted, { repo: QA_NO_MR, label: 'No merged MR', tickets: new Set(orphans), orphan: true }] : sorted;
}

function qaHeatSection(board, tickets, box) {
  const rows = qaRows(board, tickets);
  return el('section', { class: 'section qa-heat-section' },
    el('h2', {}, icon('dashboard'), 'Where it is piling up'),
    rows.length ? qaHeatmap(board, rows, box) : empty(box.repo || box.person ? 'Nothing in QA matches these filters.' : 'Nothing is waiting in QA.'),
    rows.length ? qaLegend() : null,
    rows.some((r) => r.orphan) ? el('p', { class: 'hint' }, 'A ticket with no merged MR usually means its MR names no ticket in its title or branch. A ticket with MRs in two repos counts in both rows.') : null);
}

function qaHeatmap(board, rows, box) {
  return el('div', { class: 'qa-heatwrap' }, el('table', { class: 'qa-heat', 'aria-label': 'Tickets in QA by repo and how long they have waited' },
    el('thead', {}, el('tr', {}, el('th', { scope: 'col', class: 'qa-repo' }, 'Repo'), board.buckets.map((b) => el('th', { scope: 'col' }, b.label)), el('th', { scope: 'col', class: 'qa-total' }, 'All'))),
    [rows.filter((r) => !r.orphan), rows.filter((r) => r.orphan)].map((part) => (part.length ? el('tbody', {}, part.map((r) => qaHeatRow(board, r, box))) : null))));
}

function qaHeatRow(board, r, box) {
  return el('tr', { class: r.orphan ? 'qa-orphan' : null, 'data-repo': r.repo },
    el('th', { scope: 'row', class: 'qa-repo', title: r.orphan ? 'Tickets with no merged MR' : r.repo }, r.orphan ? icon('alert') : null, el('span', {}, qaBreakable(r.label))),
    board.buckets.map((b) => el('td', {}, qaCell(r, b, box))),
    el('td', { class: 'qa-total num' }, String(r.tickets.size)));
}

// A narrow screen wraps a repo's path after a slash rather than inside a name.
function qaBreakable(label) {
  const parts = label.split('/');
  return parts.map((part, i) => (i < parts.length - 1 ? [part + '/', el('wbr')] : part));
}

function qaCell(row, bucket, box) {
  const inside = [...row.tickets].filter((t) => t.bucket === bucket.id).sort(qaOldestFirst);
  const where = row.label + ', ' + bucket.label.toLowerCase();
  if (!inside.length) return el('span', { class: 'qa-cell qa-none', role: 'img', 'aria-label': where + ': no tickets' });
  const picked = box.cell?.repo === row.repo && box.cell?.bucket === bucket.id;
  const label = where + ': ' + plural(inside.length, 'ticket') + ', oldest ' + inside[0].key + ' at ' + qaDays(inside[0].days);
  return el('button', {
    class: 'qa-cell ' + qaStep(inside.length), id: 'qa-cell:' + row.repo + ':' + bucket.id, 'aria-pressed': String(picked), 'aria-label': label,
    onclick: () => pickQaCell(picked ? null : { repo: row.repo, bucket: bucket.id, label: where }),
    onpointerenter: (e) => qaTip(e.currentTarget, label), onpointerleave: () => qaTip(null), onfocus: (e) => qaTip(e.currentTarget, label), onblur: () => qaTip(null),
  }, String(inside.length));
}

function pickQaCell(cell) {
  qaBox().cell = cell;
  qaTip(null);
  render(true);
  if (cell) document.getElementById('qa-list')?.scrollIntoView({ block: 'nearest' });
}

// One tooltip for the page, fixed to the viewport, so a cell near an edge never widens the page.
function qaTip(cell, text) {
  let tip = document.getElementById('qa-tip');
  if (!cell) {
    if (tip) tip.hidden = true;
    return;
  }
  if (!tip) {
    tip = el('div', { id: 'qa-tip', class: 'qa-tip', role: 'presentation', 'aria-hidden': 'true' });
    document.body.append(tip);
  }
  tip.textContent = text;
  tip.hidden = false;
  const at = cell.getBoundingClientRect();
  const width = Math.min(260, window.innerWidth - 16);
  tip.style.maxWidth = width + 'px';
  tip.style.left = Math.max(8, Math.min(at.left + at.width / 2 - width / 2, window.innerWidth - width - 8)) + 'px';
  tip.style.top = at.bottom + 6 + 'px';
}

document.addEventListener('scroll', () => qaTip(null), { capture: true, passive: true });

function qaLegend() {
  return el('div', { class: 'qa-legend', role: 'list', 'aria-label': 'Tickets per cell' },
    el('span', { class: 'qa-legend-title' }, 'Tickets per cell'),
    el('span', { class: 'qa-key', role: 'listitem' }, el('span', { class: 'qa-swatch qa-none' }), 'none'),
    QA_STEPS.map(([, step, label]) => el('span', { class: 'qa-key', role: 'listitem' }, el('span', { class: 'qa-swatch ' + step }), label)));
}

function qaListSection(listed, box, board) {
  const cell = box.cell;
  const labels = qaRepoLabels(board.tickets);
  return el('section', { class: 'section qa-list-section', id: 'qa-list' },
    el('h2', {}, icon('list-checks'), cell ? cell.label : 'Every ticket in QA', el('span', { class: 'meta' }, plural(listed.length, 'ticket') + ', oldest first')),
    cell ? el('button', { class: 'linkish', id: 'qa-all', onclick: () => pickQaCell(null) }, 'Show every ticket') : null,
    listed.length ? el('div', { class: 'list qa-tickets' }, listed.map((t) => qaTicketRow(t, labels))) : empty('No tickets here.'));
}

function qaTicketRow(t, labels) {
  const lines = qaLines(t);
  return el('div', { class: 'row qa-ticket', 'data-ticket': t.key },
    el('div', { class: 'row-head' }, ticketRef(t.key), el('span', { class: 'title' }, t.summary)),
    metaLine(t.assignee ?? 'Unassigned', qaDays(t.days) + ' in QA', t.mrs.length ? plural(lines, 'line') + ' changed' : null),
    t.mrs.length
      ? el('ul', { class: 'qa-mrs' }, t.mrs.map((mr) => el('li', {},
        el('button', { type: 'button', class: 'ref', title: 'Opens ' + mr.url + ' in your browser: ' + mr.title, onclick: () => openOutside(mr.url) }, labels.get(mr.project) + ' ' + refNumber(mr)), ' ',
        metaLine('merged ' + dateText(mr.mergedAt) + ' by ' + mr.author, el('span', { class: 'qa-size' }, el('span', { class: 'qa-add' }, '+' + mr.additions), ' ', el('span', { class: 'qa-del' }, '−' + mr.deletions))))))
      : el('p', { class: 'hint bad' }, icon('alert'), 'No merged MR names ' + t.key + ' in its title or branch.'));
}

function qaSlackText(listed, board) {
  const labels = qaRepoLabels(board.tickets);
  return listed.map((t) => {
    const mrs = t.mrs.length ? t.mrs.map((mr) => labels.get(mr.project) + ' ' + refNumber(mr)).join(', ') : 'no merged MR';
    return '- [' + t.key + '] ' + t.summary + ' (' + qaDays(t.days) + ' in QA, ' + mrs + ')';
  }).join('\n');
}

async function copyQa(listed, board) {
  if (!listed.length) return toast('Nothing to copy', true);
  if (await copyText(qaSlackText(listed, board))) toast('Copied ' + plural(listed.length, 'ticket') + ' for Slack');
  else toast('Could not copy the list', true);
}

const QA_FIELDS = [
  ['jql', 'Tickets in QA', 'The JQL for the tickets waiting for testing. Blank keeps the board empty.'],
  ['status', 'QA status', 'The status that means a ticket is in QA. Days in QA count from each ticket\'s last move to it, and moving a ticket to it earns in the game.'],
  ['group', 'Groups', 'GitLab groups, comma separated, whose merged MRs are joined to the tickets. Blank means the groups your open MRs are in.'],
];

function qaSettingsGroup() {
  const box = qaBox();
  if (box.settingsAt !== state.generatedAt && !box.settingsLoading) loadQaSettings(box);
  const s = box.settings;
  return el('section', { class: 'section settings-group', id: 'qa-settings' }, el('h2', {}, 'QA'),
    slot('featureSwitch', 'qa'),
    box.settingsError ? banner('Could not read the QA settings: ' + box.settingsError, true) : null,
    QA_FIELDS.map(([field, label, hint]) => qaField(box, s, field, label, hint)));
}

function qaPlaceholder(s, field) {
  if (!s) return '';
  return { jql: s.example, status: s.defaultStatus, group: s.ownGroups || 'acme' }[field];
}

function qaField(box, s, field, label, hint) {
  const value = box.drafts[field] ?? s?.[field] ?? '';
  const saved = s?.[field] ?? '';
  const shown = field === 'status' && saved === s?.defaultStatus ? '' : saved;
  const typed = box.drafts[field] !== undefined && box.drafts[field] !== shown;
  return el('div', { class: 'setting' }, el('label', { for: 'qa-' + field }, label),
    el('div', { class: 'control' },
      el('input', { id: 'qa-' + field, type: 'text', value: box.drafts[field] ?? shown, spellcheck: 'false', autocomplete: 'off', placeholder: qaPlaceholder(s, field),
        oninput: (e) => { box.drafts[field] = e.target.value; render(true); }, onkeydown: (e) => { if (e.key === 'Enter' && typed) saveQaSetting(field, value); } }),
      typed ? button('Save', 'check', () => saveQaSetting(field, value), true) : null),
    el('p', { class: 'hint' }, hint));
}

async function loadQaSettings(box) {
  Object.assign(box, { settingsLoading: true, settingsAt: state.generatedAt });
  try {
    box.settings = await api('/api/qa/settings');
    box.settingsError = null;
  } catch (e) {
    box.settingsError = e.message;
  }
  box.settingsLoading = false;
  render(true);
}

async function saveQaSetting(field, value) {
  const box = qaBox();
  const answer = await busyAct('/api/qa/settings', { [field]: value }, 'qa-settings');
  if (!answer) return;
  const { ok, text, ...settings } = answer;
  delete box.drafts[field];
  Object.assign(box, { settings, at: null });
  render(true);
}
