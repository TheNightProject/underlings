const THREAD_FILTERS = [['awaiting', 'Awaiting you'], ['open', 'Open'], ['all', 'All']];
const THREAD_MATCH = { awaiting: awaitsMe, open: (t) => !t.resolved, all: () => true };
const threadUrgency = (t, me) => (awaitsMe(t, me) ? 0 : t.resolved ? 2 : 1);
const MAX_REPLY = 20000;
const THREAD_TTL = 60000;
const NEEDS_VIEWS = ['overview', 'needs-you', 'full-auto'];
const threadReads = new Map();

function threadsChip(r) {
  if (!r.unresolved) return null;
  return el('button', { type: 'button', class: 'chip-btn', title: 'Read the threads here', onclick: () => slot('openMr', r.key, 'threads') },
    icon('message'), r.unresolved + ' unresolved');
}

function drawerThreads(ctx) {
  if (!ctx.detail) return drawerWaiting(ctx);
  const { discussions, me } = ctx.detail;
  if (!discussions.length) return empty('Nobody has commented on ' + short(ctx.key) + '.');
  const matching = (id) => discussions.filter((t) => THREAD_MATCH[id](t, me));
  const filter = threadFilter(matching);
  const kept = (t) => slot('threadKept', ctx.key, t) === true;
  const urgency = (t) => (kept(t) ? 0 : threadUrgency(t, me));
  const shown = discussions.filter((t) => THREAD_MATCH[filter](t, me) || kept(t)).sort((a, b) => urgency(a) - urgency(b));
  const card = { key: ctx.key, me, live: Boolean(ctx.row), prefix: '' };
  const bots = shown.filter((t) => t.bot);
  const people = shown.filter((t) => !t.bot);
  return [
    chips(THREAD_FILTERS.map(([id, label]) => [id, label + ' (' + matching(id).length + ')']), filter, (v) => { ui.mr.threadFilter = v; render(true); }, 'thread-chip-'),
    slot('fixButton', ctx),
    people.length ? el('div', { class: 'list' }, people.map((t) => threadCard(t, card))) : null,
    bots.length ? el('h3', { class: 'thread-group' }, icon('bot'), 'From bots (' + bots.length + ')') : null,
    bots.length ? el('div', { class: 'list bots' }, bots.map((t) => threadCard(t, card))) : null,
    shown.length ? null : empty(filter === 'awaiting' ? 'No thread is waiting on you.' : 'Every thread is resolved.'),
  ];
}

function threadFilter(matching) {
  if (ui.mr.threadFilter) return ui.mr.threadFilter;
  return matching('awaiting').length ? 'awaiting' : matching('open').length ? 'open' : 'all';
}

function threadCard(t, card) {
  return el('div', { class: 'row thread' },
    el('div', { class: 'row-head' }, threadPlace(t, card), threadPills(t, card.me)),
    noteList(t.notes),
    card.live ? threadControls(card.key, t, card.prefix, slot('fixThreadButton', card.key, t)) : null);
}

function threadPlace(t, card) {
  if (!t.path) return el('span', { class: 'meta' }, 'General');
  const label = t.path + (t.line ? ':' + t.line : '');
  if (!card.live) return el('span', { class: 'meta' }, label);
  return el('button', { type: 'button', class: 'linkish place', title: 'Show this line in the file', onclick: () => showFile(card.key, t.path, t.line ? { line: t.line } : null) },
    icon('file-text'), label);
}

function threadPills(t, me) {
  return [
    t.resolvable ? el('span', { class: 'pill ' + (t.resolved ? 's-done' : 's-quiet') }, t.resolved ? 'resolved' : 'open') : null,
    repliedToMe(t, me) ? el('span', { class: 'pill s-need' }, 'waiting on you') : null,
    t.handedBack ? el('span', { class: 'pill s-need' }, icon('undo'), 'handed back') : null,
    t.queuedReply ? el('span', { class: 'pill s-info' }, icon('reply'), 'reply queued') : null,
  ];
}

function noteList(notes) {
  return notes.map((n) => el('div', { class: 'note' },
    el('div', { class: 'meta' }, n.author + ' · ' + ago(n.createdAt)),
    el('div', { class: 'say' }, markdown(n.body))));
}

function threadControls(key, t, prefix, extra = null) {
  if (!forgeAllows(key, 'post')) return null;
  const resolve = t.resolvable ? resolveButton(key, t) : null;
  const ticket = slot('threadTicket', key, t, prefix) ?? {};
  if (ui.drafts.has('thread:' + t.id)) return [replyBox(key, t, prefix, resolve, extra), ticket.panel];
  return [el('div', { class: 'actions' }, button('Reply', 'reply', (e) => startReply(e, t, prefix)), resolve, extra, ticket.button), ticket.panel];
}

function replyBox(key, t, prefix, resolve, extra) {
  const draftKey = 'thread:' + t.id;
  const busyId = 'reply:' + t.id;
  const send = guarded(busyId, 'Send reply', 'send', 'Reply on ' + refNumber(key) + '?', () => sendReply(key, t, busyId), true);
  send.disabled = ui.busy.has(busyId) || !ui.drafts.get(draftKey).trim();
  const typed = (e) => {
    ui.drafts.set(draftKey, e.target.value);
    send.disabled = ui.busy.has(busyId) || !e.target.value.trim();
  };
  return el('div', { class: 'reply' },
    el('textarea', { id: prefix + 'reply-' + t.id, 'aria-label': 'Reply to this thread', placeholder: 'Write a reply. It goes to GitLab exactly as written.', maxlength: MAX_REPLY, oninput: typed }, ui.drafts.get(draftKey)),
    el('div', { class: 'actions' }, send, button('Cancel', 'x', () => { ui.drafts.delete(draftKey); render(true); }), resolve, extra));
}

function startReply(e, t, prefix) {
  const host = e.currentTarget.closest('#sheet') ?? e.currentTarget.closest('#drawer') ?? document.getElementById('main');
  ui.drafts.set('thread:' + t.id, '');
  render(true);
  [...host.querySelectorAll('textarea')].find((n) => n.id === prefix + 'reply-' + t.id)?.focus();
}

async function sendReply(key, t, busyId) {
  const draftKey = 'thread:' + t.id;
  const sent = await matrixAct('reply', { key, discussionId: t.id, body: ui.drafts.get(draftKey), expect: { notes: t.notes.length } }, busyId);
  if (sent) ui.drafts.delete(draftKey);
  rereadThreads(key);
}

function resolveButton(key, t) {
  const busyId = 'resolve:' + t.id;
  const wanted = !t.resolved;
  return guarded(busyId, wanted ? 'Resolve' : 'Reopen', wanted ? 'check-circle' : 'rotate-ccw', wanted ? 'Resolve this thread?' : 'Reopen this thread?',
    () => matrixAct('resolve', { key, discussionId: t.id, resolved: wanted }, busyId).then(() => rereadThreads(key)));
}

function threadActions(q, rows) {
  if (q) return q.status === 'pending' ? [ui.editing.has(q.id) ? editBox(q, 'sheet-edit-') : null, queueActions(q)] : null;
  const head = rows?.[0];
  if (!head?.discussionId || !ui.file) return null;
  const read = threadRead(ui.file.key, false)?.detail?.discussions.find((t) => t.id === head.discussionId);
  const thread = read ?? { id: head.discussionId, resolved: Boolean(head.resolved), resolvable: true, notes: rows.filter((r) => r.kind === 'author') };
  return threadControls(ui.file.key, thread, 'sheet-');
}

function itemThread(q) {
  if (q.kind === 'reply' && q.status === 'pending' && q.replyTo) return answeredComment(q);
  const id = postedThreadId(q);
  if (!id) return null;
  const owner = threadOwner(q, id);
  return owner.id === q.id ? postedThread(q, id) : threadElsewhere(owner);
}

function threadElsewhere(owner) {
  return el('div', { class: 'meta' }, icon('message'), owner.kind === 'finding' ? 'Its thread is shown with the finding.' : 'Its thread is shown with the latest reply.');
}

function answeredComment(q) {
  const read = threadRead(q.key, true);
  const me = read?.detail?.me;
  const notes = read?.detail?.discussions.find((t) => t.id === q.replyTo)?.notes ?? [];
  const answered = notes.findLast((n) => n.author !== me) ?? notes.at(-1);
  return el('div', { class: 'answers' },
    el('div', { class: 'meta' }, icon('reply'), 'In answer to'),
    answered ? noteList([answered]) : readState(read, 'the comment it answers'));
}

function postedThread(q, id) {
  const openKey = 'thread:' + id;
  const inDrawer = ui.mr?.key === q.key && Boolean(ui.mr.detail);
  if (!inDrawer && !ui.open.has(openKey)) {
    return el('button', { type: 'button', class: 'linkish', 'aria-expanded': 'false', onclick: () => toggle(ui.open, openKey) }, icon('message'), 'Show the thread');
  }
  const read = threadRead(q.key, true);
  const t = read?.detail?.discussions.find((d) => d.id === id);
  const finding = q.kind === 'finding';
  const shown = t && finding ? t.notes.slice(1) : t?.notes ?? [];
  return el('div', { class: 'thread' },
    inDrawer ? null : el('button', { type: 'button', class: 'linkish', 'aria-expanded': 'true', onclick: () => toggle(ui.open, openKey) }, icon('message'), 'Hide the thread'),
    t ? [
      el('div', { class: 'row-head' }, threadPills(t, read.detail.me), el('span', { class: 'meta' }, threadCount(finding, shown))),
      noteList(shown),
      liveMr(q.key) ? threadControls(q.key, t, 'item-') : null,
    ] : readState(read, 'the thread'));
}

function threadCount(finding, notes) {
  if (!finding) return plural(notes.length, 'comment');
  if (!notes.length) return 'No reply yet';
  return notes.length === 1 ? '1 reply' : notes.length + ' replies';
}

function readState(read, what) {
  if (read?.error) return el('div', { class: 'meta bad' }, 'Could not read ' + what + ': ' + read.error);
  return el('div', { class: 'meta' }, read?.detail && !read.loading ? 'GitLab no longer has ' + what + '.' : 'Reading ' + what + ' from GitLab…');
}

function handedBackThreads(key, row, comments = false) {
  const read = threadRead(key, NEEDS_VIEWS.includes(view()));
  if (!read?.detail) return readState(read, 'the threads');
  const { discussions, me } = read.detail;
  const left = new Set(comments ? (slot('commentsForYou', discussions, me) ?? []).map((t) => t.id) : []);
  const threads = discussions.filter((t) => awaitsMe(t, me) || left.has(t.id) || slot('threadKept', key, t) === true);
  if (!threads.length) return empty('Nothing on ' + short(key) + ' is waiting on you any more.');
  const card = { key, me, live: Boolean(row), prefix: 'needs-' };
  return el('div', { class: 'list' }, threads.map((t) => threadCard(t, card)));
}

const liveMr = (key) => state.matrix.inbox?.rows.some((r) => r.key === key) ?? false;

// Outside the drawer an MR's threads are read only while something on screen shows them, once a minute or when its queue changes.
function threadRead(key, load) {
  if (ui.mr?.key === key && ui.mr.detail) return { detail: ui.mr.detail, error: null };
  const read = threadReads.get(key);
  if (load && !read?.loading && !readIsCurrent(read, key)) readThreads(key);
  return threadReads.get(key) ?? null;
}

const readIsCurrent = (read, key) => Boolean(read) && read.queue === queueMark(key) && Date.now() - read.at <= THREAD_TTL;

async function readThreads(key) {
  const read = { detail: threadReads.get(key)?.detail ?? null, error: null, loading: true, at: Date.now(), queue: queueMark(key) };
  threadReads.set(key, read);
  try {
    read.detail = await api('/api/matrix/mr?' + new URLSearchParams({ key }));
  } catch (e) {
    read.error = e.message;
  }
  read.loading = false;
  read.at = Date.now();
  if (threadReads.get(key) === read) render(true);
}

function rereadThreads(key) {
  if (threadReads.has(key)) readThreads(key);
  else render(true);
}
