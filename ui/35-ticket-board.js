const TICKET_LANES = ['To Do', 'In Progress', 'Peer Review', 'QA', 'Blocked'];
const TICKET_DRAG = 'application/x-cc-ticket';

function ticketLanes(tickets) {
  const others = [...new Set(tickets.map((x) => x.status))].filter((s) => !TICKET_LANES.includes(s)).sort();
  return [...TICKET_LANES, ...others];
}

const ticketLane = (x) => (ui.tickets.pending?.key === x.key ? ui.tickets.pending.to : x.status);
const laneTakes = (x, status) => status !== x.status && x.targets.includes(status);

function ticketBoard(shown, tickets, d) {
  settlePendingMove(tickets);
  const names = ticketLanes(tickets);
  const byLane = groupBy(shown, ticketLane);
  const lanes = names.map((s) => ({ id: s, label: s, tone: statusTone(s), items: byLane.get(s) ?? [] }));
  return kanban('Tickets by status', 'ticket-board', lanes, (x) => ticketCard(x, names, d),
    (lane) => ({ ondragover: (e) => dragOverLane(e, lane.id), ondrop: (e) => dropOnLane(e, lane.id) }));
}

function ticketCard(x, names, d) {
  const pending = ui.tickets.pending?.key === x.key ? ui.tickets.pending : null;
  const refused = ui.tickets.refused?.key === x.key ? ui.tickets.refused.why : null;
  const key = ticketRef(x.key);
  key.id = 'ticket-card-key-' + x.key;
  return el('article', {
    id: 'ticket-card-' + x.key, class: 'kanban-card ticket-card ' + statusTone(x.status), 'data-key': x.key, tabindex: '0', draggable: 'true', 'aria-label': x.key + ', ' + x.status + ': ' + x.summary,
    ondragstart: (e) => startTicketDrag(e, x), ondragend: endTicketDrag, onkeydown: (e) => { if (e.target === e.currentTarget && e.key === 'Enter') openTicket(x.key); },
  },
  el('div', { class: 'card-head' }, key, kickoffChip(x, d)),
  el('p', { class: 'card-summary' }, x.summary || x.key),
  x.epic ? el('span', { class: 'epic-label', title: x.epic.key }, x.epic.summary || x.epic.key) : null,
  ticketMrs(x),
  suggestButton(x),
  !pending ? cardMoveMenu(x, names) : pending.sent ? null : pendingMove(x, pending),
  refused ? el('p', { class: 'meta bad' }, 'Not moved: ' + refused) : null);
}

function cardMoveMenu(x, names) {
  const targets = names.filter((s) => laneTakes(x, s));
  if (!targets.length) return null;
  return el('select', { id: 'ticket-card-move-' + x.key, 'aria-label': 'Move ' + x.key + ' to', onchange: (e) => e.target.value && proposeMove(x, e.target.value) },
    el('option', { value: '' }, 'Move to…'),
    targets.map((s) => el('option', { value: s }, s)));
}

function pendingMove(x, p) {
  return el('div', { class: 'actions ticket-pending' },
    guarded('ticket-move:' + x.key, 'Move to ' + p.to, 'chevron', 'Move ' + x.key + ' to ' + p.to + '?', () => confirmMove(p), true),
    el('button', { type: 'button', id: 'ticket-cancel-' + x.key, disabled: ui.busy.has('ticket-move:' + x.key), onclick: () => cancelMove(x.key) }, 'Cancel'));
}

// Lanes are marked in place rather than re-rendered, since Chromium drops a drag whose source node is replaced as it starts.
function startTicketDrag(e, x) {
  ui.tickets.drag = x.key;
  e.dataTransfer.setData(TICKET_DRAG, x.key);
  e.dataTransfer.effectAllowed = 'move';
  for (const lane of document.querySelectorAll('#main .ticket-board .lane')) lane.dataset.drop = laneTakes(x, lane.dataset.lane) ? 'yes' : 'no';
}

function endTicketDrag() {
  ui.tickets.drag = null;
  for (const lane of document.querySelectorAll('#main .ticket-board .lane')) lane.removeAttribute('data-drop');
}

function draggedTicket(e) {
  if (!ui.tickets.drag || !e.dataTransfer?.types?.includes(TICKET_DRAG)) return null;
  return ui.tickets.data?.tickets.find((x) => x.key === ui.tickets.drag) ?? null;
}

function dragOverLane(e, status) {
  const x = draggedTicket(e);
  if (!x || !laneTakes(x, status)) return;
  e.preventDefault();
  e.dataTransfer.dropEffect = 'move';
}

function dropOnLane(e, status) {
  const x = draggedTicket(e);
  endTicketDrag();
  if (!x || !laneTakes(x, status)) return;
  e.preventDefault();
  proposeMove(x, status);
}

function proposeMove(x, to) {
  ui.armed = null;
  ui.tickets.pending = { key: x.key, from: x.status, to };
  ui.tickets.refused = null;
  render(true);
  document.getElementById('g-ticket-move:' + x.key)?.focus({ preventScroll: true });
}

function cancelMove(key) {
  ui.armed = null;
  ui.tickets.pending = null;
  render(true);
  focusCard(key);
}

async function confirmMove(p) {
  const id = 'ticket-move:' + p.key;
  ui.busy.add(id);
  render(true);
  const result = await requestMove(p.key, p.to, p.from);
  ui.busy.delete(id);
  toast(result.text, !result.moved);
  if (result.moved) p.sent = true;
  else if (ui.tickets.pending === p) {
    ui.tickets.pending = null;
    ui.tickets.refused = { key: p.key, why: result.text };
  }
  ui.tickets.at = 0;
  render(true);
  focusCard(p.key);
  refresh();
}

// Once the list shows the ticket anywhere but where the move started, the move is over, by this page or another.
function settlePendingMove(tickets) {
  const p = ui.tickets.pending;
  if (p && tickets.find((x) => x.key === p.key)?.status !== p.from) ui.tickets.pending = null;
}

function focusCard(key) {
  document.getElementById('ticket-card-' + key)?.focus({ preventScroll: true });
}
