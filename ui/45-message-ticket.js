
function startMessageTicket(src, ref, box) {
  const flow = { stage: 'drafting', summary: '', description: '', epic: box.data?.lastEpic ?? '', error: null };
  box.tickets.set(ref, flow);
  render(true);
  draftMessageTicket(src, ref, flow, box);
}

async function draftMessageTicket(src, ref, flow, box) {
  Object.assign(flow, { stage: 'drafting', error: null });
  render(true);
  try {
    const draft = await api(src.path + '/ticket-draft', src.body(ref));
    if (box.tickets.get(ref) !== flow) return;
    Object.assign(flow, { stage: 'form', summary: draft.summary, description: draft.description });
  } catch (e) {
    Object.assign(flow, { stage: 'failed', error: e.message });
  }
  render(true);
  byId(src.name + '-ticket-' + (flow.stage === 'form' ? 'summary' : 'retry') + '-' + ref)?.focus({ preventScroll: true });
}

function messageTicketPanel(src, ref, flow, box) {
  const id = (part) => src.name + '-ticket-' + part + '-' + ref;
  const cancel = el('button', { id: id('cancel'), type: 'button', onclick: () => { box.tickets.delete(ref); render(true); } }, icon('x'), 'Cancel');
  const body = flow.stage === 'form' ? messageTicketForm(src, ref, flow, box, id, cancel)
    : flow.stage === 'failed' ? [el('div', { class: 'meta bad', role: 'alert' }, flow.error), el('div', { class: 'actions' }, el('button', { id: id('retry'), class: 'primary', type: 'button', onclick: () => draftMessageTicket(src, ref, flow, box) }, icon('rotate-ccw'), 'Try again'), cancel)]
      : [el('p', { class: 'empty', role: 'status' }, icon('clock'), 'Claude is drafting the ticket…'), el('div', { class: 'actions' }, cancel)];
  const title = 'Ticket for this ' + src.what;
  return el('div', { class: 'ticket-panel', role: 'group', 'aria-label': title }, el('div', { class: 'ticket-head' }, icon('ticket'), title), body);
}

function messageTicketForm(src, ref, flow, box, id, cancel) {
  const busyId = src.name + '-ticket:' + ref;
  const busy = ui.busy.has(busyId);
  const epic = () => flow.epic.trim().toUpperCase();
  const ready = () => Boolean(flow.summary.trim() && flow.description.trim() && TICKET_KEY.test(epic()));
  const create = guarded(busyId, 'Create ticket', 'ticket', 'Create a ticket under ' + epic() + '?', () => createMessageTicket(src, ref, flow, box, busyId), true);
  create.disabled = busy || !ready();
  const typed = (field) => (e) => {
    flow[field] = e.target.value;
    if (field === 'epic') {
      if (ui.armed === busyId) ui.armed = null;
      return render(true);
    }
    create.disabled = ui.busy.has(busyId) || !ready();
  };
  return [
    el('div', { class: 'ticket-field' }, el('label', { for: id('summary') }, 'Summary'),
      el('input', { id: id('summary'), type: 'text', value: flow.summary, maxlength: 255, readonly: busy, spellcheck: 'true', autocomplete: 'off', oninput: typed('summary') })),
    el('div', { class: 'ticket-field' }, el('label', { for: id('description') }, 'Description'),
      el('textarea', { id: id('description'), maxlength: 20000, readonly: busy, oninput: typed('description') }, flow.description)),
    el('div', { class: 'ticket-field' }, el('label', { for: id('epic') }, 'Parent epic'),
      el('div', { class: 'ticket-epic' }, el('input', { id: id('epic'), type: 'text', value: flow.epic, placeholder: exampleKey(), readonly: busy, spellcheck: 'false', autocomplete: 'off', oninput: typed('epic') }),
        el('span', { class: 'meta' }, flow.epic && !TICKET_KEY.test(epic()) ? 'An epic key looks like ' + exampleKey() + '.' : ''))),
    el('p', { class: 'meta' }, newTicketType() + ', assigned to you. Nothing is sent to the person who wrote.'),
    el('div', { class: 'actions' }, create, cancel),
  ];
}

async function createMessageTicket(src, ref, flow, box, busyId) {
  const done = await busyAct(src.path + '/ticket', { ...src.body(ref), summary: flow.summary, description: flow.description, epic: flow.epic.trim().toUpperCase() }, busyId);
  if (!done) return;
  box.tickets.delete(ref);
  box.at = null;
  if (done.ticket) toast(done.text, false, slot('ticketLink', done.ticket.key, done.ticket.url, done.ticket.summary));
}
