const TICKET_TABS = [['overview', 'Overview'], ['agent', 'Agent']];
const TICKETS_POLL_MS = 3000;
const TICKETS_REREAD_MS = 30000;
const KICKOFF_GRACE_MS = 5 * 60000;
const TICKET_LAYOUT_KEY = 'cc.ticketLayout';
let ticketSeq = 0;
let ticketsWake = null;

function ticketChip(r) {
  const listed = ticketList()?.tickets.find((t) => t.key === r.ticket);
  return ticketRef(r.ticket, listed?.status);
}

// The worker answers from its cache at once and says while it is still reading Jira, so until there is a list the page asks again soon.
const ticketsPending = (data) => Boolean(data && (data.loading || !data.read));

function ticketList() {
  const t = ui.tickets;
  const wait = ticketsPending(t.data) ? TICKETS_POLL_MS : TICKETS_REREAD_MS;
  if (!t.reading && Date.now() - t.at > wait) loadTickets();
  return t.data;
}

async function loadTickets(again = false) {
  const t = ui.tickets;
  t.reading = true;
  t.at = Date.now();
  try {
    t.data = await (again ? api('/api/matrix/tickets/refresh', {}) : api('/api/matrix/tickets'));
    t.error = null;
  } catch (e) {
    t.error = e.message;
  }
  t.reading = false;
  clearTimeout(ticketsWake);
  if (ticketsPending(t.data)) ticketsWake = setTimeout(() => render(true), TICKETS_POLL_MS);
  render(true);
}

function ticketLayout() {
  ui.tickets.layout ??= storedLayout(TICKET_LAYOUT_KEY);
  return ui.tickets.layout;
}

function setTicketLayout(layout) {
  ui.tickets.layout = layout;
  storeLayout(TICKET_LAYOUT_KEY, layout);
  render(true);
}

function viewTickets(d) {
  const t = ui.tickets;
  const data = ticketList();
  const tickets = data?.tickets ?? [];
  const statuses = [...new Set(tickets.map((x) => x.status))].sort();
  const epics = epicOptions(tickets);
  if (t.filter !== 'all' && !statuses.includes(t.filter)) t.filter = 'all';
  if (t.epic && !epics.some(([key]) => key === t.epic)) t.epic = '';
  const shown = tickets.filter((x) => (t.filter === 'all' || x.status === t.filter) && (!t.epic || epicGroup(x) === t.epic) && ticketMatches(x, t.search));
  return [
    header('Tickets', 'Your open tickets by epic, with the MRs that carry them.',
      layoutSwitch(ticketLayout(), setTicketLayout, 'ticket-layout-'), data?.read ? slot('syncButton', t, tickets) : null),
    slot('syncPanel', t),
    ticketsBanner(t, data),
    el('div', { class: 'filters' },
      chips([['all', 'All (' + tickets.length + ')'], ...statuses.map((s) => [s, s + ' (' + tickets.filter((x) => x.status === s).length + ')'])], t.filter, (v) => { t.filter = v; render(); }),
      searchBox('ticket-q', 'Search key, summary or epic', t.search, (v) => { t.search = v; render(true); }),
      picker('ticket-epic', 'Every epic', t.epic, epics, (v) => { t.epic = v; render(); })),
    !data ? (t.error ? null : el('p', { class: 'empty' }, icon('clock'), 'Reading your tickets from Jira…'))
      : shown.length ? ticketsShown(shown, tickets, d) : data.read && !data.off ? empty(tickets.length ? 'No ticket matches.' : 'You have no open tickets.') : null,
  ];
}

function ticketsShown(shown, tickets, d) {
  return (ticketLayout() === 'board' && slot('ticketBoard', shown, tickets, d)) || ticketGroups(shown, d);
}

// Each ticket is viewed once to learn its epic, so the ones not viewed yet wait in a group of their own.
const epicGroup = (x) => (!x.epicRead ? '~reading' : x.epic ? x.epic.key : '~none');
const epicTitle = (x) => (!x.epicRead ? 'Epic not read yet' : x.epic ? x.epic.summary || x.epic.key : 'No epic');

function byEpic(tickets) {
  const groups = groupBy(tickets, epicGroup);
  const title = (key) => epicTitle(groups.get(key)[0]);
  const rank = (key) => ['~none', '~reading'].indexOf(key) + 1;
  return [...groups.keys()].sort((a, b) => rank(a) - rank(b) || title(a).localeCompare(title(b))).map((key) => [key, groups.get(key), title(key)]);
}

function epicOptions(tickets) {
  return byEpic(tickets).map(([key, list, title]) => [key, list.length, title]);
}

function ticketMatches(x, search) {
  const q = search.trim().toLowerCase();
  return !q || [x.key, x.summary, x.epic?.key, x.epic?.summary].filter(Boolean).join(' ').toLowerCase().includes(q);
}

function ticketsBanner(t, data) {
  if (t.error) return banner('Could not read your tickets: ' + t.error, true);
  if (data?.off) return banner('Tickets are off until you set your Jira site.', false, ' ', el('a', { class: 'fix-link', ...inPage('#setup') }, icon('list-checks'), 'Set up Jira'));
  if (data?.error) return banner('Jira cannot be read right now, so ' + (data.read ? 'this is the list from ' + ago(data.fetchedAt) : 'there is no list to show') + '. acli said: ' + data.error, true, ' ', retryTicketsButton(t, data));
  if (data && !data.read) return el('p', { class: 'empty' }, icon('clock'), 'Reading your tickets from Jira…');
  return null;
}

function retryTicketsButton(t, data) {
  const busy = t.reading || data.loading;
  return el('button', { id: 'tickets-retry', disabled: busy, title: 'Read your tickets from Jira again now', onclick: retryTickets },
    icon(busy ? 'clock' : 'refresh'), busy ? 'Reading…' : 'Retry now');
}

function retryTickets() {
  const asked = loadTickets(true);
  render(true);
  return asked;
}

function ticketGroups(tickets, d) {
  return byEpic(tickets).map(([key, list, title]) => el('section', { class: 'section ticket-group', 'data-epic': key },
    el('h2', {}, icon('ticket'), title, key.startsWith('~') ? null : el('span', { class: 'meta' }, key), el('span', { class: 'meta' }, plural(list.length, 'ticket'))),
    el('div', { class: 'list' }, list.map((x) => ticketRow(x, d)))));
}

function ticketRow(x, d) {
  return el('div', { class: 'row ticket-row', 'data-key': x.key },
    el('div', { class: 'row-head' },
      ticketRef(x.key),
      el('span', { class: 'pill ' + statusTone(x.status) }, x.status),
      el('button', { type: 'button', class: 'ref', title: 'Open ' + x.key + ' here', onclick: () => openTicket(x.key) }, x.summary || x.key),
      kickoffChip(x, d)),
    ticketMrs(x),
    x.suggest ? el('div', { class: 'actions' }, suggestButton(x)) : null);
}

function ticketMrs(x) {
  return x.mrs.length ? el('div', { class: 'actions ticket-mrs' }, x.mrs.map((m) => mrRef(m.key, m.repo + ' ' + refNumber(m) + (m.draft ? ' (draft)' : '')))) : null;
}

function suggestButton(x) {
  const s = x.suggest;
  if (!s) return null;
  const id = 'ticket-suggest:' + x.key;
  return guarded(id, 'Move to ' + s.status + ': ' + s.why, 'chevron', 'Move ' + x.key + ' to ' + s.status + '?', () => moveTicket(x, s.status, id));
}

const STATUS_TONES = { 'To Do': 's-quiet', Blocked: 's-need', 'Peer Review': 's-info', QA: 's-moved', 'Design QA': 's-moved', 'In Progress': 's-working', 'In Design': 's-working', 'Release Ready': 's-done' };

function statusTone(status) {
  return STATUS_TONES[status] ?? (/^Ready for Release/.test(status) ? 's-done' : 's-accent');
}

function kickoffAgent(run, d) {
  return run?.terminal ? d.agents.find((a) => a.handle === run.terminal) ?? null : null;
}

// Like a fix agent, a kickoff agent lives as long as it is recorded, and a launch on its way counts too.
function kickoffAlive(run, d) {
  if (!run || run.status === 'launch failed') return false;
  if (!run.terminal) return Date.now() - Date.parse(run.startedAt) < KICKOFF_GRACE_MS;
  return Boolean(kickoffAgent(run, d));
}

function kickoffChip(x, d) {
  if (!kickoffAlive(x.run, d)) return null;
  const agent = kickoffAgent(x.run, d);
  return el('button', { type: 'button', class: 'chip-btn tone ' + (agent ? agentClass(agent) : 's-working'), title: 'Read and answer the agent on ' + x.key, onclick: () => openTicket(x.key, 'agent') },
    icon('bot'), agent ? 'agent ' + (slot('agentLabel', agent) ?? agent.state) : 'agent starting');
}

// A kickoff agent whose turn ended on a question is done, but waiting on you.
function kickoffAgentWaits(a) {
  return Boolean(a.handle) && /\?\s*$/.test(a.said ?? '') && (state.matrix.runs ?? []).some((run) => run.kickoff && run.status !== 'launch failed' && run.terminal === a.handle);
}

function openTicket(key, tab = 'overview') {
  if (!key) return;
  ui.mr = null;
  const fresh = ui.ticket?.key !== key;
  if (fresh) ui.ticket = { key, tab, detail: null, error: null, loading: false, moveTo: '' };
  else ui.ticket.tab = tab;
  render(true);
  if (fresh) document.querySelector('#drawer .drawer')?.focus({ preventScroll: true });
  if (!ui.ticket.loading && (!ui.ticket.detail || ui.ticket.error)) loadTicket();
}

function closeTicket() {
  const key = ui.ticket?.key;
  ui.ticket = null;
  render();
  const ref = [...document.querySelectorAll('#main .ticket-ref')].find((b) => b.dataset.ticket === key);
  (document.getElementById('ticket-card-' + key) ?? ref ?? document.getElementById('main')).focus({ preventScroll: true });
}

// Only the latest request may land, so opening another ticket quickly never shows the first one's detail.
async function loadTicket() {
  const t = ui.ticket;
  if (!t) return;
  const seq = ++ticketSeq;
  t.loading = true;
  render(true);
  try {
    const detail = await api('/api/matrix/ticket?' + new URLSearchParams({ key: t.key }));
    if (seq === ticketSeq) Object.assign(t, { detail, error: null });
  } catch (e) {
    if (seq === ticketSeq) t.error = e.message;
  }
  if (seq !== ticketSeq || ui.ticket !== t) return;
  t.loading = false;
  render(true);
}

function ticketDrawer(d) {
  const t = ui.ticket;
  const x = t.detail;
  const tab = TICKET_TABS.find(([id]) => id === t.tab) ?? TICKET_TABS[0];
  return el('aside', { class: 'drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Ticket ' + t.key, tabindex: '-1' },
    el('div', { class: 'drawer-head' },
      el('div', { class: 'drawer-title' },
        el('div', { class: 'title' }, x?.summary ?? t.key),
        metaLine(t.key, x?.status, t.loading ? 'reading Jira…' : null)),
      el('div', { class: 'actions' },
        outside(x?.url, 'Open in Jira'),
        el('button', { class: 'icon-only', title: 'Close (Esc)', 'aria-label': 'Close', onclick: closeTicket }, icon('x')))),
    el('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Ticket sections' }, TICKET_TABS.map(([id, label]) =>
      el('button', { class: 'tab', role: 'tab', id: 'ticket-tab-' + id, 'aria-selected': String(id === tab[0]), onclick: () => openTicket(t.key, id) }, label))),
    el('div', { class: 'drawer-body', role: 'tabpanel', 'aria-labelledby': 'ticket-tab-' + tab[0] },
      t.error ? banner(t.error, true) : null,
      tab[0] === 'agent' ? ticketAgentTab(t, d) : x ? ticketOverview(t, x, d) : t.error ? null : el('p', { class: 'empty' }, icon('clock'), 'Reading the ticket from Jira…')));
}

function ticketOverview(t, x, d) {
  const fact = (label, value) => [el('dt', {}, label), el('dd', {}, value)];
  return [
    el('dl', { class: 'kv' },
      fact('Status', el('span', { class: 'pill ' + statusTone(x.status) }, x.status)),
      fact('Epic', x.epic ? [x.epic.summary, ' ', el('span', { class: 'meta' }, x.epic.key)] : 'none'),
      fact('Type', x.type),
      fact('MRs', x.mrs.length ? el('div', { class: 'actions' }, x.mrs.map((m) => mrRef(m.key, m.repo + ' ' + refNumber(m) + ': ' + m.title))) : 'none open')),
    x.mine ? ticketActions(t, x, d) : el('p', { class: 'meta' }, x.key + ' is not one of your open tickets, so it is not moved or started from here.'),
    el('section', { class: 'section' }, el('h2', {}, 'Description'), x.description ? el('div', { class: 'ticket-desc' }, x.description) : el('p', { class: 'meta' }, 'No description.')),
  ];
}

function ticketActions(t, x, d) {
  return el('div', { class: 'ticket-actions' },
    x.suggest ? el('div', { class: 'actions' }, suggestButton(x)) : null,
    el('div', { class: 'actions' },
      el('select', { id: 'ticket-move-to', 'aria-label': 'Move ' + x.key + ' to', onchange: (e) => pickMove(t, e.target.value) },
        el('option', { value: '', selected: !t.moveTo }, 'Move to…'),
        x.targets.map((s) => el('option', { value: s, selected: s === t.moveTo }, s))),
      t.moveTo ? guarded('ticket-move:' + x.key, 'Move', 'chevron', 'Move ' + x.key + ' to ' + t.moveTo + '?', () => moveTicket(x, t.moveTo), true) : null),
    kickoffAlive(x.run, d)
      ? el('div', { class: 'actions' }, kickoffChip(x, d), el('span', { class: 'meta' }, 'Answer it in the Agent tab. It asks you before it pushes, raises an MR or touches Jira.'))
      : el('div', { class: 'actions' }, guarded('ticket-start:' + x.key, 'Start with an agent', 'bot', 'Start ' + x.key + ' with an agent' + '?', () => startKickoff(x))));
}

// A new target disarms Move, so what is sent is always the status the confirm named.
function pickMove(t, status) {
  t.moveTo = status;
  if (ui.armed === 'ticket-move:' + t.key) ui.armed = null;
  render(true);
}

async function moveTicket(x, status, busyId = 'ticket-move:' + x.key) {
  const done = await matrixAct('ticket-status', { key: x.key, status, expect: { status: x.status } }, busyId);
  if (done && ui.ticket?.key === x.key) ui.ticket.moveTo = '';
  ui.tickets.at = 0;
}

// Unlike matrixAct this hands back the worker's words, so the card or line that asked can say why a move did not happen.
async function requestMove(key, status, from) {
  try {
    return { moved: true, text: (await api('/api/matrix/ticket-status', { key, status, expect: { status: from } })).text };
  } catch (e) {
    return { moved: false, skipped: e.status === 409, text: e.message };
  }
}

async function startKickoff(x) {
  const done = await matrixAct('ticket-start', { key: x.key }, 'ticket-start:' + x.key);
  ui.tickets.at = 0;
  if (done && ui.ticket?.key === x.key) openTicket(x.key, 'agent');
}

function ticketAgentTab(t, d) {
  const run = t.detail?.run ?? ui.tickets.data?.tickets.find((x) => x.key === t.key)?.run ?? null;
  if (!run) return empty('No agent has started on ' + t.key + '.');
  const agent = kickoffAgent(run, d);
  const head = el('div', { class: 'row-head' },
    el('span', { class: 'pill ' + (agent ? agentClass(agent) : 's-quiet') }, icon('bot'), 'kickoff agent ' + (agent ? slot('agentLabel', agent) ?? agent.state : kickoffWord(run))),
    el('span', { class: 'meta' }, 'started ' + ago(run.startedAt)));
  if (agent) return el('div', { class: 'fix-run' }, head, slot('agentRow', agent, { pinned: true }));
  return el('div', { class: 'fix-run' }, head,
    el('p', { class: 'meta' }, kickoffGone(run)),
    run.tail.length && run.status !== 'launch failed' ? el('details', {}, el('summary', {}, 'Last output'), el('pre', {}, run.tail.join('\n'))) : null);
}

function kickoffWord(run) {
  if (run.status === 'launch failed') return 'did not start';
  return run.terminal ? 'closed' : 'starting';
}

function kickoffGone(run) {
  if (run.status === 'launch failed') return 'It did not start: ' + (run.tail[0] ?? 'no reason was given');
  return run.terminal ? 'It has been removed, so there is nothing to answer.' : 'It has not started yet.';
}
