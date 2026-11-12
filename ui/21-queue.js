const SEVERITY_TONE = { CRITICAL: 's-need', MAJOR: 's-need', MINOR: 's-working', NIT: 's-quiet', QUESTION: 's-info' };
const HUNK_LINES = 10;
const STALE_HINT = 'The MR has new commits since this was written, so its line may now hold other code. Posting puts it on the same line number in the latest diff, or makes it a general comment if that line is gone.';

const QUEUE_FILTERS = [['pending', 'Waiting for you'], ['expired', 'Expired'], ['posted', 'Posted'], ['discarded', 'Discarded'], ['all', 'All'], ['archived', 'Archived']];

function viewQueue(d) {
  const archived = ui.queueFilter === 'archived';
  return [
    header('Review queue', 'What the review agents found. Nothing reaches GitLab until you post it, except for people in full auto after their hold window.',
      chips(QUEUE_FILTERS, ui.queueFilter, (v) => { ui.queueFilter = v; render(); }), cleanUpClosedButton(d.m.cleanup)),
    matrixBanners(d.m),
    archived ? null : slot('decideCards', d),
    archived ? archivedList() : queueGroups(d),
  ];
}

function queueShown(d) {
  if (ui.queueFilter === 'pending') return d.pending;
  return d.m.queue.filter((q) => ui.queueFilter === 'all' || q.status === ui.queueFilter);
}

function queueGroups(d) {
  const groups = groupBy(queueShown(d), (q) => q.key);
  const rows = new Map(d.rows.map((r) => [r.key, r]));
  const cleanup = new Map((d.m.cleanup?.groups ?? []).map((g) => [g.key, g]));
  return groups.size ? el('div', { class: 'list' }, [...groups].map(([key, items]) => queueGroup(key, items, rows.get(key), cleanup.get(key), d.pendingByMr.has(key)))) : empty('Nothing here.');
}

// Still waiting with no row means its repo is missing from the list, which says nothing about whether it closed.
function groupState(row, waiting) {
  if (row) return el('span', { class: 'text' }, row.title);
  return el('span', { class: 'pill s-quiet' }, waiting ? 'not in the MR list' : 'no longer open');
}

function queueGroup(key, items, row, cleanup, waiting) {
  const postAll = postAllButton(key, items);
  const archive = row || waiting ? null : archiveMrButton(key, cleanup);
  return el('div', { class: 'row' },
    el('div', { class: 'foot' },
      el('div', { class: 'row-head' }, mrRef(key, short(key), 'findings'), groupState(row, waiting)),
      postAll || archive ? el('div', { class: 'actions' }, postAll, archive) : null),
    slot('decideCard', row, null, 'queue'),
    items.map((q) => queueItem(q, Boolean(row))));
}

// The count is the worker's, over the whole queue, so the question names every item the click will move.
function archiveMrButton(key, cleanup) {
  if (!cleanup?.items) return null;
  const { items, mark } = cleanup;
  return guarded('archive:' + key, 'Archive', 'archive', 'Archive ' + plural(items, 'item') + ' on ' + short(key) + '?',
    () => matrixAct('archive-mr', { key, expect: { items, mark } }, 'archive:' + key));
}

function cleanUpClosedButton(cleanup) {
  const c = cleanup?.closed;
  if (!c || !(c.items + c.test)) return null;
  const parts = [c.mrs ? plural(c.items, 'item') + ' on ' + plural(c.mrs, 'merged MR') : null, c.test ? plural(c.test, 'test item') : null].filter(Boolean);
  return guarded('archive-closed', 'Clean up closed', 'archive', 'Archive ' + parts.join(' and ') + '?',
    () => matrixAct('archive-closed', { expect: { items: c.items, mrs: c.mrs, test: c.test, mark: c.mark } }, 'archive-closed'));
}

function archivedList() {
  const box = ui.queueArchive;
  const at = state.generatedAt + '#' + box.page;
  if (box.at !== at && !box.loading) loadArchivePage(box, at);
  if (box.error) return banner('Could not read the archive: ' + box.error, true);
  const data = box.data;
  if (!data) return el('p', { class: 'empty' }, icon('clock'), 'Reading the archive…');
  if (!data.total) return empty('Nothing has been archived yet.');
  const groups = groupBy(data.items, (q) => q.key);
  return [
    el('div', { class: 'list' }, [...groups].map(([key, items]) => el('div', { class: 'row' },
      el('div', { class: 'row-head' }, mrRef(key, short(key), 'findings')),
      items.map(archivedItem)))),
    archivePager(data),
  ];
}

async function loadArchivePage(box, at) {
  box.loading = true;
  try {
    box.data = await api('/api/matrix/queue-archive?page=' + box.page);
    box.error = null;
  } catch (e) {
    box.error = e.message;
  }
  Object.assign(box, { at, loading: false });
  render(true);
}

function archivePager(data) {
  const from = data.page * data.pageSize;
  const to = Math.min(from + data.items.length, data.total);
  const turn = (by) => { ui.queueArchive.page = data.page + by; render(); };
  return el('div', { class: 'foot' },
    el('span', { class: 'meta' }, (from + 1) + '–' + to + ' of ' + data.total + ', newest first'),
    el('div', { class: 'actions' },
      el('button', { id: 'archive-newer', disabled: data.page === 0, onclick: () => turn(-1) }, icon('up'), 'Newer'),
      el('button', { id: 'archive-older', disabled: to >= data.total, onclick: () => turn(1) }, icon('down'), 'Older')));
}

function archivedItem(q) {
  return el('div', { class: 'item' },
    el('div', { class: 'row-head' },
      el('span', { class: 'pill ' + (SEVERITY_TONE[q.severity] || 's-quiet') }, q.kind === 'verdict' ? 'verdict' : q.severity || q.kind),
      el('span', { class: 'pill ' + (q.status === 'posted' ? 's-done' : 's-quiet') }, q.status),
      el('span', { class: 'meta' }, ['Archived ' + ago(q.archivedAt), q.why, q.createdBy].filter(Boolean).join(' · '))),
    q.status === 'expired' ? notPosted(q) : null,
    el('details', {}, el('summary', {}, q.kind === 'verdict' ? (q.verdict === 'approve' ? 'Approve' : 'Request changes') : firstLine(q.body) || '(empty)'), markdown(q.body)));
}

function notPosted(q) {
  return el('div', { class: 'meta' }, 'Not posted: ' + (q.expiredReason || 'MR closed'));
}

function queueItem(q, mrOpen, where = '') {
  const pending = q.status === 'pending';
  return el('div', { class: 'item' },
    el('div', { class: 'row-head' },
      el('span', { class: 'pill ' + (SEVERITY_TONE[q.severity] || 's-quiet') }, q.kind === 'verdict' ? 'verdict' : q.severity || q.kind),
      pending ? null : el('span', { class: 'pill ' + (q.status === 'posted' ? 's-done' : 's-quiet') }, q.status),
      q.kind === 'reply' ? el('span', { class: 'pill s-info' }, 'reply' + (q.outcome ? ': ' + q.outcome : '')) : null,
      slot('autoPill', q, state.matrix),
      el('span', { class: 'meta' }, [q.createdBy, ago(q.postedAt || q.createdAt)].filter(Boolean).join(' · '))),
    q.auto?.held ? el('div', { class: 'meta' }, 'Handed back: ' + q.auto.held) : null,
    q.status === 'expired' ? notPosted(q) : null,
    q.kind === 'finding' ? codeBlock(q, mrOpen) : null,
    ui.editing.has(q.id)
      ? editBox(q, where + 'edit-')
      : el('details', { open: pending }, el('summary', {}, q.kind === 'verdict' ? (q.verdict === 'approve' ? 'Approve' : 'Request changes') : firstLine(q.body) || '(empty)'), markdown(q.body)),
    slot('itemThread', q),
    q.error ? el('div', { class: 'meta bad' }, 'Post failed: ' + q.error) : null,
    pending ? queueActions(q) : null);
}

function queueActions(q) {
  if (ui.editing.has(q.id)) {
    return el('div', { class: 'actions' },
      button('Save', 'check', () => saveEdit(q), true),
      button('Cancel', 'x', () => { ui.editing.delete(q.id); slot('markEditing', q.id, false); render(); }));
  }
  const verdict = q.kind === 'verdict';
  return el('div', { class: 'actions' },
    guarded('post:' + q.id, verdict ? (q.verdict === 'approve' ? 'Approve' : 'Request changes') : 'Post', 'send', 'Post to GitLab?', () => matrixAct('post', { id: q.id }, 'post:' + q.id), true),
    verdict ? null : button('Edit', 'pencil', () => { ui.editing.set(q.id, q.body); slot('markEditing', q.id, true); render(); refresh(); }),
    button('Discard', 'trash', () => matrixAct('discard', { id: q.id }, 'discard:' + q.id)));
}

function editBox(q, idPrefix) {
  return el('textarea', { id: idPrefix + q.id, 'aria-label': 'Edit comment', oninput: (e) => ui.editing.set(q.id, e.target.value) }, ui.editing.get(q.id));
}

function codeBlock(q, mrOpen) {
  const lines = hunkLines(q.hunk);
  if (!q.path && !lines.length) return el('div', { class: 'meta' }, 'General comment on the merge request, no code attached.');
  return el('div', { class: 'hunk' },
    el('div', { class: 'hunk-head' },
      el('span', { class: 'meta' }, q.path ? q.path + (q.line ? ':' + q.line : '') + (q.side === 'old' ? ' (removed line)' : '') : 'General comment, quoting existing code'),
      q.stale ? el('span', { class: 'pill s-moved', title: STALE_HINT }, 'code moved since') : null,
      q.path && mrOpen && q.status !== 'discarded' ? button('Show file', 'file', () => openFile(q.key, q.path, findingFocus(q))) : null),
    lines.length ? hunkView(q, lines) : el('div', { class: 'meta' }, 'No code was quoted with this finding.'));
}

// A posted finding is a GitLab thread in the file, with no queue id, so it is found by its line.
function findingFocus(q) {
  return { queueId: q.status === 'pending' ? q.id : null, line: q.line, side: q.side };
}

function hunkLines(hunk) {
  const lines = String(hunk || '').split('\n');
  while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
  return lines;
}

// Clipped at ten lines as the TUI does, but never above the line the comment is on.
function hunkView(q, lines) {
  const clipAt = Math.max(HUNK_LINES, (q.anchor ?? 0) + 2);
  const open = ui.hunkOpen.has(q.id) || lines.length <= clipAt;
  return [
    el('pre', { class: 'diff' }, el('code', {}, (open ? lines : lines.slice(0, clipAt)).map((text, i) => diffLine(text, i === q.anchor)))),
    lines.length > clipAt ? el('button', { class: 'linkish', 'aria-expanded': String(open), onclick: () => toggle(ui.hunkOpen, q.id) },
      open ? 'Show fewer lines' : '+' + plural(lines.length - clipAt, 'more line')) : null,
  ];
}

const lineTone = (text) => (text.startsWith('@@') ? 'hunkhead' : text[0] === '+' ? 'add' : text[0] === '-' ? 'del' : 'ctx');

function diffLine(text, anchored) {
  return el('span', { class: 'dl ' + lineTone(text) + (anchored ? ' anchor' : ''), title: anchored ? 'The line this comment is on' : null }, text || ' ');
}

function until(iso) {
  const s = Math.round((Date.parse(iso) - Date.now()) / 1000);
  return !iso ? 'soon' : s <= 0 ? 'now' : s < 90 ? 'in ' + s + ' s' : 'in ' + Math.round(s / 60) + ' min';
}

async function saveEdit(q) {
  await matrixAct('edit', { id: q.id, body: ui.editing.get(q.id) }, 'edit:' + q.id);
  ui.editing.delete(q.id);
  render();
}

// Posting everything skips verdicts, so they are not counted in what it posts.
const postableCount = (items) => items.filter((q) => q.status === 'pending' && q.kind !== 'verdict').length;

// Posting all sends the stored text, so an unsaved edit would go out as the original.
function postAllButton(key, items) {
  const n = postableCount(items);
  if (!n || !forgeAllows(key, 'post')) return null;
  if (items.some((q) => ui.editing.has(q.id))) return el('button', { disabled: true, title: 'Save or cancel the edit first' }, icon('pencil'), 'Finish editing to post all');
  return guarded('postall:' + key, 'Post all ' + n, 'send', 'Post ' + n + ' to GitLab?', () => matrixAct('post-all', { key }, 'postall:' + key), true);
}

const FINDING_FILTERS = [['needs', 'Needs you'], ['waiting', 'Waiting to post'], ['open', 'Open'], ['resolved', 'Resolved'], ['all', 'All']];
const FINDING_MATCH = {
  needs: (q, t, me) => waitsToPost(q) || (t && awaitsMe(t, me)),
  waiting: waitsToPost,
  open: (q, t) => t && !t.resolved,
  resolved: (q, t) => t?.resolved,
  all: () => true,
};
const FINDING_NONE = {
  needs: 'Nothing on this MR is waiting on you.',
  waiting: 'Nothing is waiting to post.',
  open: 'No thread from these findings is open.',
  resolved: 'No thread from these findings is resolved.',
};
const THREAD_COUNTED = ['open', 'resolved'];
const STATUS_WORDS = { pending: 'waiting to post', posted: 'posted', discarded: 'discarded', expired: 'expired' };

function drawerFindings(ctx) {
  const items = ctx.queued;
  if (!items.length) {
    const review = ctx.row ? slot('reviewButton', ctx.row, ctx.d) : null;
    return [empty('Nothing is queued for ' + short(ctx.key) + '.'), review ? el('div', { class: 'actions' }, review) : null];
  }
  const me = ctx.detail?.me;
  const entries = findingEntries(items, ctx.detail);
  const matching = (id) => entries.filter(({ q, t }) => FINDING_MATCH[id](q, t, me));
  const missing = threadsMissing(ctx, items);
  const filter = findingFilter(matching, missing);
  const kept = ({ t }) => Boolean(t) && slot('threadKept', ctx.key, t) === true;
  const urgency = (entry) => (kept(entry) ? 0 : findingUrgency(entry, me));
  const shown = entries.filter((entry) => FINDING_MATCH[filter](entry.q, entry.t, me) || kept(entry)).sort((a, b) => urgency(a) - urgency(b));
  const unsure = missing && (filter === 'needs' || THREAD_COUNTED.includes(filter));
  return [
    findingChips(matching, filter, missing),
    el('div', { class: 'foot' }, el('span', { class: 'meta' }, statusCounts(items)), postAllButton(ctx.key, items)),
    unsure ? threadsNote(missing) : null,
    shown.length ? shown.map(({ q }) => queueItem(q, Boolean(ctx.row), 'drawer-')) : unsure ? null : empty(FINDING_NONE[filter]),
  ];
}

// A thread is counted once, with the item that draws it, so a finding and the replies under it make one.
function findingEntries(items, detail) {
  const threads = new Map((detail?.discussions ?? []).map((t) => [t.id, t]));
  return items.map((q) => {
    const id = postedThreadId(q);
    return { q, t: id && threadOwner(q, id).id === q.id ? threads.get(id) ?? null : null };
  });
}

// A thread missing from a read still under way may be one posted since the last read, rather than one GitLab no longer has.
function threadsMissing(ctx, items) {
  if (ctx.detail && !ctx.loading) return null;
  const read = new Set((ctx.detail?.discussions ?? []).map((t) => t.id));
  if (!items.some((q) => postedThreadId(q) && !read.has(postedThreadId(q)))) return null;
  return ctx.error && !ctx.loading ? 'failed' : 'reading';
}

// Until the threads are read, Needs you may still have more in it, so the tab waits there rather than moving on.
function findingFilter(matching, missing) {
  if (ui.mr.findingFilter) return ui.mr.findingFilter;
  if (missing === 'reading') return 'needs';
  return ['needs', 'open'].find((id) => matching(id).length) ?? 'all';
}

function findingUrgency({ q, t }, me) {
  if (t && awaitsMe(t, me)) return 0;
  if (q.status === 'pending') return 1;
  if (t && !t.resolved) return 2;
  return q.status === 'posted' ? 3 : 4;
}

function statusCounts(items) {
  const counts = groupBy(items, (q) => q.status);
  return Object.entries(STATUS_WORDS).filter(([status]) => counts.has(status)).map(([status, words]) => counts.get(status).length + ' ' + words).join(', ');
}

function findingChips(matching, filter, missing) {
  const count = (id) => (missing && THREAD_COUNTED.includes(id) ? '…' : matching(id).length);
  return chips(FINDING_FILTERS.map(([id, label]) => [id, label + ' (' + count(id) + ')']), filter, (v) => { ui.mr.findingFilter = v; render(true); }, 'finding-chip-');
}

function threadsNote(missing) {
  if (missing === 'failed') return el('div', { class: 'meta bad' }, 'The threads could not be read, so posted findings are not counted here.');
  return el('p', { class: 'empty' }, icon('clock'), 'Reading the threads from GitLab, so posted findings may be missing from these counts.');
}
