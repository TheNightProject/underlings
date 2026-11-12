const TICKET_TTL = 60000;
const MAX_TICKET_SUMMARY = 255;
const MAX_TICKET_TEXT = 20000;
const ticketReads = new Map();
const raisedHere = new Set();

function threadTicket(key, t, prefix) {
  const raised = raisedTickets(key)?.[t.id];
  if (raised?.ticket) return { button: raisedChip(raised, prefix + 'ticket-chip-' + t.id), panel: finished(raised) ? null : unfinishedTicket(key, t, raised, prefix) };
  if (raised) return { panel: t.resolved ? null : keylessTicket(raised) };
  const flow = ui.drafts.get('ticket:' + t.id);
  if (flow) return { button: null, panel: ticketPanel(key, t, flow) };
  if (!mayRaise(key, t)) return {};
  return { button: el('button', { id: prefix + 'ticket-make-' + t.id, title: 'Draft a Jira ticket from this thread, then reply and resolve it', onclick: (e) => startTicket(e, key, t, prefix) }, icon('ticket'), 'Make a ticket') };
}

const finished = (raised) => Boolean(raised.ticket && raised.replied && raised.resolved);
const seenOf = (t) => ({ notes: t.notes.map((n) => n.body) });

// A thread ticketed from this page, or one still waiting on its reply or resolve, stays in view so its chip and retry show.
function threadKept(key, t) {
  const raised = raisedTickets(key)?.[t.id];
  return Boolean(raised) && (raisedHere.has(key + '#' + t.id) || (!finished(raised) && !t.resolved));
}

function mayRaise(key, t) {
  const me = state.matrix.me;
  if (!me || t.resolved || !t.resolvable) return false;
  // A file sheet thread drawn before its MR is read has no note text to send as what the page saw.
  if (!t.notes.every((n) => typeof n.body === 'string')) return false;
  return t.notes.some((n) => n.author === me) || (state.matrix.inbox?.rows ?? []).some((r) => r.key === key && r.author === me);
}

function raisedTickets(key) {
  const read = ticketReads.get(key);
  if (!read || (!read.loading && Date.now() - read.at > TICKET_TTL)) readRaised(key);
  return ticketReads.get(key)?.records ?? null;
}

async function readRaised(key) {
  const read = { records: ticketReads.get(key)?.records ?? null, loading: true, at: Date.now() };
  ticketReads.set(key, read);
  const answer = await api('/api/matrix/thread-tickets?' + new URLSearchParams({ key })).catch(() => null);
  const changed = Boolean(answer) && JSON.stringify(answer.records) !== JSON.stringify(read.records);
  if (answer) read.records = answer.records;
  read.loading = false;
  read.at = Date.now();
  if (changed && ticketReads.get(key) === read) render(true);
}

function raisedChip(raised, id) {
  return ticketLink(raised.ticket, raised.url, raised.summary, id);
}

function ticketLink(key, url, summary, id) {
  return el('button', { id, type: 'button', class: 'chip-btn ticket-chip', title: 'Open ' + key + (summary ? ', ' + summary + ',' : '') + ' in your browser', onclick: () => openOutside(url) }, icon('ticket'), key);
}

function keylessTicket(raised) {
  const { epic } = raised;
  const text = raised.making ? 'A ticket is being made under ' + epic.key + '…'
    : 'A ticket under ' + epic.key + ' has no key here, as ' + raised.error + '. Look under the epic before raising another, then reply and resolve by hand.';
  return el('div', { class: 'ticket-panel' + (raised.making ? '' : ' warn'), role: 'group', 'aria-label': 'Ticket for this thread' },
    el('div', { class: raised.making ? 'meta' : 'meta bad' }, text),
    el('div', { class: 'actions' }, ticketLink(epic.key, epic.url, epic.summary)));
}

function unfinishedTicket(key, t, raised, prefix) {
  const busyId = 'ticket-finish:' + t.id;
  const what = raised.replied ? 'the thread is not resolved yet' : 'the reply has not posted';
  return el('div', { class: 'ticket-panel warn', role: 'group', 'aria-label': 'Ticket ' + raised.ticket },
    el('div', { class: 'meta bad' }, raised.ticket + (raised.linked ? ' is chosen' : ' is raised') + ', but ' + what + (raised.error ? ': ' + raised.error : '') + '.'),
    el('div', { class: 'actions' },
      guarded(busyId, raised.replied ? 'Retry the resolve' : 'Retry the reply and resolve', 'rotate-ccw', (raised.replied ? 'Resolve' : 'Reply and resolve') + ' on ' + refNumber(key) + '?',
        () => ticketWrite('/api/matrix/thread-ticket-finish', { key, discussionId: t.id }, busyId, key, t, prefix), true)));
}

function startTicket(e, key, t, prefix) {
  const host = e.currentTarget.closest('#sheet') ? 'sheet' : e.currentTarget.closest('#drawer') ? 'drawer' : 'main';
  const flow = { key, prefix, host, stage: 'checking' };
  ui.drafts.set('ticket:' + t.id, flow);
  checkForTicket(flow, t);
}

async function checkForTicket(flow, t) {
  setStage(flow, t, { stage: 'checking' }, 'cancel');
  try {
    const found = await api('/api/matrix/thread-ticket?' + new URLSearchParams({ key: flow.key, discussionId: t.id }));
    if (!ticketStillOpen(flow, t)) return;
    if (found.raised) return closeTicketFlow(flow, t, readRaised(flow.key));
    Object.assign(flow, { existing: found.existing, searchError: found.searchError, epic: found.epic, epicNote: found.epicNote, epicKey: found.epic?.key ?? '' });
    if (found.existing.length) return setStage(flow, t, { stage: 'found' }, 'first');
    askForDraft(flow, t);
  } catch (e) {
    if (ticketStillOpen(flow, t)) setStage(flow, t, { stage: 'failed', error: 'Could not look for a ticket: ' + e.message, retry: 'check' }, 'retry');
  }
}

async function askForDraft(flow, t) {
  setStage(flow, t, { stage: 'drafting' }, 'cancel');
  try {
    const draft = await api('/api/matrix/thread-ticket-draft', { key: flow.key, discussionId: t.id, epic: flow.epicKey });
    if (ticketStillOpen(flow, t)) setStage(flow, t, { stage: 'form', summary: draft.summary, description: draft.description }, 'summary');
  } catch (e) {
    if (ticketStillOpen(flow, t)) setStage(flow, t, { stage: 'failed', error: e.message, retry: 'draft' }, 'retry');
  }
}

const ticketStillOpen = (flow, t) => ui.drafts.get('ticket:' + t.id) === flow;

function setStage(flow, t, changes, focusOn) {
  const hadFocus = ticketHasFocus(flow, t);
  Object.assign(flow, changes);
  render(true);
  if (focusOn) focusTicket(flow, t, focusOn, hadFocus);
}

// An answer that lands while you are typing elsewhere leaves your focus where it is.
function ticketHasFocus(flow, t) {
  const active = document.activeElement;
  const id = active?.id ?? '';
  const nowhere = active === document.body || id === 'main' || ['drawer', 'sheet'].some((name) => active?.classList.contains(name));
  return nowhere || (id.startsWith(flow.prefix + 'ticket-') && id.endsWith(t.id));
}

function focusTicket(flow, t, part, allowed) {
  if (!allowed) return;
  const id = flow.prefix + 'ticket-' + part + '-' + t.id;
  const root = document.getElementById(flow.host) ?? document;
  [...root.querySelectorAll('[id]')].find((n) => n.id === id)?.focus();
}

function closeTicketFlow(flow, t, after) {
  ui.drafts.delete('ticket:' + t.id);
  render(true);
  focusTicket(flow, t, 'make', true);
  return after;
}

function ticketPanel(key, t, flow) {
  const id = (part) => flow.prefix + 'ticket-' + part + '-' + t.id;
  const cancel = el('button', { id: id('cancel'), onclick: () => closeTicketFlow(flow, t) }, icon('x'), 'Cancel');
  return el('div', { class: 'ticket-panel', role: 'group', 'aria-label': 'Ticket for this thread' },
    el('div', { class: 'ticket-head' }, icon('ticket'), 'Ticket for this thread'),
    flow.stage === 'form' ? ticketForm(key, t, flow, id, cancel)
      : flow.stage === 'found' ? ticketFound(key, t, flow, id, cancel)
        : flow.stage === 'failed' ? ticketFailed(t, flow, id, cancel)
          : [el('p', { class: 'empty', role: 'status' }, icon('clock'), flow.stage === 'drafting' ? 'Claude is drafting the ticket…' : 'Looking for a ticket that already covers this…'), el('div', { class: 'actions' }, cancel)]);
}

function ticketFailed(t, flow, id, cancel) {
  const again = () => (flow.retry === 'check' ? checkForTicket(flow, t) : askForDraft(flow, t));
  return [
    el('div', { class: 'meta bad', role: 'alert' }, flow.error),
    el('div', { class: 'actions' }, el('button', { id: id('retry'), class: 'primary', onclick: again }, icon('rotate-ccw'), 'Try again'), cancel),
  ];
}

function ticketFound(key, t, flow, id, cancel) {
  return [
    el('p', { class: 'text' }, flow.existing.length === 1 ? 'A ticket may already cover this thread.' : 'These tickets may already cover this thread.'),
    el('div', { class: 'ticket-found' }, flow.existing.map((found, i) => foundTicket(key, t, flow, found, i ? null : id('first')))),
    searchNote(flow),
    el('div', { class: 'actions' }, el('button', { id: id('new'), onclick: () => askForDraft(flow, t) }, icon('plus'), 'Draft a new ticket'), cancel),
  ];
}

function foundTicket(key, t, flow, found, firstId) {
  const busyId = 'ticket-link:' + t.id + ':' + found.key;
  const reply = guarded(busyId, 'Reply with ' + found.key + ' and resolve', 'reply', 'Reply and resolve on ' + refNumber(key) + '?',
    () => ticketWrite('/api/matrix/thread-ticket-link', { key, discussionId: t.id, ticket: found.key, expect: seenOf(t) }, busyId, key, t, flow.prefix), true);
  if (firstId) reply.id = firstId;
  return el('div', { class: 'ticket-match' },
    el('div', { class: 'row-head' }, ticketLink(found.key, found.url, found.summary), el('span', { class: 'text' }, found.summary)),
    el('div', { class: 'foot' }, metaLine(found.status, found.why), reply));
}

function searchNote(flow) {
  return flow.searchError ? el('div', { class: 'meta bad' }, 'Jira could not be searched (' + flow.searchError + '), so a ticket may already cover this.') : null;
}

function ticketForm(key, t, flow, id, cancel) {
  const busyId = 'ticket:' + t.id;
  const busy = ui.busy.has(busyId);
  const epic = () => flow.epicKey.trim().toUpperCase();
  const ready = () => Boolean(flow.summary.trim() && flow.description.trim() && TICKET_KEY.test(epic()));
  const create = guarded(busyId, 'Create ticket', 'ticket', 'Create a ticket under ' + epic() + '?', () => createTicketFromDraft(key, t, flow, epic(), busyId), true);
  create.disabled = busy || !ready();
  const typed = (field) => (e) => {
    flow[field] = e.target.value;
    create.disabled = ui.busy.has(busyId) || !ready();
  };
  const typedEpic = (e) => {
    flow.epicKey = e.target.value;
    if (ui.armed === busyId) ui.armed = null;
    render(true);
  };
  return [
    searchNote(flow),
    el('div', { class: 'ticket-field' },
      el('label', { for: id('summary') }, 'Summary'),
      el('input', { id: id('summary'), type: 'text', value: flow.summary, maxlength: MAX_TICKET_SUMMARY, readonly: busy, spellcheck: 'true', autocomplete: 'off', oninput: typed('summary') })),
    el('div', { class: 'ticket-field' },
      el('label', { for: id('description') }, 'Description'),
      el('textarea', { id: id('description'), maxlength: MAX_TICKET_TEXT, readonly: busy, oninput: typed('description') }, flow.description)),
    el('div', { class: 'ticket-field' },
      el('label', { for: id('epic') }, 'Parent epic'),
      el('div', { class: 'ticket-epic' },
        el('input', { id: id('epic'), type: 'text', value: flow.epicKey, placeholder: exampleKey(), readonly: busy, spellcheck: 'false', autocomplete: 'off', 'aria-describedby': id('epic-note'), oninput: typedEpic }),
        el('span', { class: 'meta', id: id('epic-note') }, epicNote(flow, epic())))),
    el('p', { class: 'meta' }, newTicketType() + ', assigned to you. Creating it also replies on the thread with the new key and resolves it.'),
    el('div', { class: 'actions' }, create, cancel),
  ];
}

function epicNote(flow, epic) {
  if (flow.epic && epic === flow.epic.key) return flow.epic.summary;
  return flow.epicNote && !epic ? flow.epicNote : epic && !TICKET_KEY.test(epic) ? 'An epic key looks like ' + exampleKey() + '.' : '';
}

function createTicketFromDraft(key, t, flow, epic, busyId) {
  const payload = { key, discussionId: t.id, expect: seenOf(t), summary: flow.summary, description: flow.description, epic };
  return ticketWrite('/api/matrix/thread-ticket', payload, busyId, key, t, flow.prefix);
}

// Once the ticket exists the card shows its record instead of the form, whether or not the reply and resolve went through.
async function ticketWrite(path, payload, busyId, key, t, prefix) {
  const done = await busyAct(path, payload, busyId);
  await readRaised(key);
  const raised = raisedTickets(key)?.[t.id];
  if (raised) {
    ui.drafts.delete('ticket:' + t.id);
    raisedHere.add(key + '#' + t.id);
  }
  rereadThreads(key);
  if (!done || !raised?.ticket) return;
  toast(done.text, false, ticketLink(raised.ticket, raised.url, raised.summary));
  const place = { prefix, host: ui.file ? 'sheet' : ui.mr ? 'drawer' : 'main' };
  focusTicket(place, t, 'chip', ticketHasFocus(place, t));
}
