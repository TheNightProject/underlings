const DRAWER_TABS = [
  ['overview', 'Overview', 'drawerOverview'],
  ['findings', 'Findings', 'drawerFindings'],
  ['threads', 'Threads', 'drawerThreads'],
  ['pipeline', 'Pipeline', 'drawerPipeline'],
  ['files', 'Files', 'drawerFiles'],
  ['agent', 'Agent', 'drawerAgent'],
];
// A tab shows only when the MR's forge can do what it is for.
const TAB_NEEDS = { findings: 'post', agent: 'agents' };
const drawerTabs = (key) => DRAWER_TABS.filter(([id]) => !TAB_NEEDS[id] || forgeAllows(key, TAB_NEEDS[id]));
let mrSeq = 0;

function openMr(key, tab = 'overview') {
  ui.ticket = null;
  const fresh = ui.mr?.key !== key;
  if (fresh) ui.mr = { key, tab, detail: null, error: null, loading: false };
  else ui.mr.tab = tab;
  render(true);
  if (fresh) document.querySelector('#drawer .drawer')?.focus({ preventScroll: true });
  if (!ui.mr.loading && (!ui.mr.detail || ui.mr.error)) loadMr();
}

function closeDrawer() {
  if (ui.ticket) slot('closeTicket');
  else closeMr();
}

function closeMr() {
  const key = ui.mr?.key;
  ui.mr = null;
  render();
  (listedRef(key) ?? document.getElementById('main')).focus({ preventScroll: true });
}

// Only the latest request may land, so opening another MR quickly never shows the first one's detail.
async function loadMr() {
  const m = ui.mr;
  const seq = ++mrSeq;
  m.loading = true;
  m.mark = queueMark(m.key);
  render(true);
  try {
    const detail = await api('/api/matrix/mr?' + new URLSearchParams({ key: m.key }));
    if (seq === mrSeq) Object.assign(m, { detail, error: null });
  } catch (e) {
    if (seq === mrSeq) m.error = e.message;
  }
  if (seq !== mrSeq || ui.mr !== m) return;
  m.loading = false;
  render(true);
  rereadIfQueueMoved();
}

// A post from the TUI or full auto opens a thread the drawer has not read, so a change to its MR's queue reads the MR again.
function rereadIfQueueMoved() {
  const m = ui.mr;
  if (m && !m.loading && m.mark !== queueMark(m.key)) loadMr();
}

function renderDrawer(d) {
  const host = document.getElementById('drawer');
  const open = ui.mr ?? ui.ticket;
  const place = open ? open.key + ' ' + open.tab : '';
  const scroll = host.dataset.place === place ? host.querySelector('.drawer-body')?.scrollTop ?? 0 : 0;
  host.dataset.place = place;
  host.hidden = !open;
  host.inert = Boolean(ui.file);
  document.querySelector('.app').inert = Boolean(open || ui.file);
  document.body.classList.toggle('drawer-open', Boolean(open));
  host.replaceChildren(...(ui.mr ? [drawer(drawerContext(ui.mr, d))] : ui.ticket ? [slot('ticketDrawer', d)].filter(Boolean) : []));
  const body = host.querySelector('.drawer-body');
  if (body) body.scrollTop = scroll;
}

function drawerContext(m, d) {
  const row = d.rows.find((r) => r.key === m.key) ?? null;
  const queued = queuedFor(m.key);
  return { key: m.key, tab: m.tab, row, queued, detail: m.detail, error: m.error, loading: m.loading, mr: m.detail?.mr ?? row, url: knownUrl(m.key, d), d };
}

function knownUrl(key, d) {
  const seen = [d.rows, d.m.queue, d.m.runs, d.m.watches].flat().find((x) => x.key === key && x.webUrl);
  return ui.mr?.detail?.mr.webUrl ?? seen?.webUrl ?? null;
}

function drawer(ctx) {
  const tabs = drawerTabs(ctx.key);
  const tab = tabs.find(([id]) => id === ctx.tab) ?? tabs[0];
  return el('aside', { class: 'drawer', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Merge request ' + ctx.key, tabindex: '-1' },
    el('div', { class: 'drawer-head' },
      el('div', { class: 'drawer-title' },
        el('div', { class: 'title' }, ctx.mr?.title ?? short(ctx.key)),
        metaLine(drawerRef(ctx.key), ctx.mr?.author, ctx.loading ? 'reading ' + forgeName(ctx.key) + '…' : ctx.detail ? 'read ' + ago(ctx.detail.fetchedAt) : null)),
      el('div', { class: 'actions' },
        outside(ctx.url, 'Open on ' + forgeName(ctx.key)),
        el('button', { class: 'icon-only', title: 'Close (Esc)', 'aria-label': 'Close', onclick: closeMr }, icon('x')))),
    el('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Merge request sections' }, tabs.map(([id, label]) =>
      el('button', { class: 'tab', role: 'tab', id: 'mr-tab-' + id, 'aria-selected': String(id === tab[0]), onclick: () => openMr(ctx.key, id) }, label))),
    el('div', { class: 'drawer-body', role: 'tabpanel', 'aria-labelledby': 'mr-tab-' + tab[0] },
      ctx.error ? banner('Could not read ' + ctx.key + ' from ' + forgeName(ctx.key) + ': ' + ctx.error, true) : null,
      tab[0] === 'findings' ? slot('decideCard', ctx.row, ctx.d, 'drawer') : null,
      slot(tab[2], ctx)));
}

const drawerRef = (key) => (keyProvider(key) === 'github' ? el('span', { class: 'forge-ref' }, forgeMark(key), key) : short(key));

function drawerWaiting(ctx) {
  return ctx.error ? null : el('p', { class: 'empty' }, icon('clock'), keyProvider(ctx.key) === 'github' ? 'Reading the pull request from GitHub…' : 'Reading the MR from GitLab…');
}

let fileSeq = 0;

function openFile(key, path, focus = null) {
  ui.file = { key, path, focus, folded: false, view: null, error: null, loading: false, reveal: 'focus' };
  loadFile();
}

// Other ui files open the sheet by this name.
const showFile = openFile;

function closeFile() {
  ui.file = null;
  render();
  if (ui.mr) document.querySelector('#drawer .drawer')?.focus({ preventScroll: true });
  else document.getElementById('main').focus({ preventScroll: true });
}

// Only the latest request may land, so switching files quickly never shows the wrong one.
async function loadFile() {
  const f = ui.file;
  const seq = ++fileSeq;
  f.loading = true;
  render(true);
  try {
    const query = new URLSearchParams({ key: f.key, path: f.path });
    if (f.folded) query.set('folded', '1');
    const view = await api('/api/matrix/file?' + query);
    if (seq === fileSeq) Object.assign(f, { view, path: view.path, error: null });
  } catch (e) {
    if (seq === fileSeq) f.error = e.message;
  }
  if (seq !== fileSeq || ui.file !== f) return;
  f.loading = false;
  render(true);
  if (f.reveal != null) revealThread(f);
}

// reveal is 'focus' for the finding the sheet opened on, or the number of a thread to keep in view.
function revealThread(f) {
  const blocks = [...document.querySelectorAll('#sheet .fthread')];
  const kept = typeof f.reveal === 'number';
  const block = kept ? blocks.find((b) => Number(b.dataset.thread) === f.reveal) : blocks.find((b) => b.classList.contains('focus')) ?? blocks[0];
  f.reveal = null;
  block?.scrollIntoView({ block: kept ? 'start' : 'center' });
  document.querySelector('#sheet .sheet')?.focus({ preventScroll: true });
}

function sheetThreads() {
  const body = document.querySelector('#sheet .sheet-body');
  return { top: body.getBoundingClientRect().top + 8, blocks: [...body.querySelectorAll('.fthread')] };
}

function threadAtTop() {
  const { top, blocks } = sheetThreads();
  const at = blocks.find((b) => b.getBoundingClientRect().bottom > top) ?? blocks[blocks.length - 1];
  return at ? Number(at.dataset.thread) : null;
}

function stepThread(direction) {
  const { top, blocks } = sheetThreads();
  const next = direction > 0
    ? blocks.find((b) => b.getBoundingClientRect().top > top + 24)
    : blocks.reverse().find((b) => b.getBoundingClientRect().top < top - 24);
  next?.scrollIntoView({ block: 'start' });
}

function renderSheet(d) {
  const host = document.getElementById('sheet');
  const scroll = host.querySelector('.sheet-body')?.scrollTop ?? 0;
  host.hidden = !ui.file;
  document.body.classList.toggle('sheet-open', Boolean(ui.file));
  host.replaceChildren(...(ui.file ? [fileSheet(ui.file, d)] : []));
  const body = host.querySelector('.sheet-body');
  if (body) body.scrollTop = scroll;
}

function fileSheet(f, d) {
  const v = f.view;
  return el('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'File ' + f.path, tabindex: '-1' },
    el('div', { class: 'sheet-head' },
      el('div', { class: 'foot' },
        el('div', { class: 'file-title' },
          el('div', { class: 'title' }, f.path),
          el('div', { class: 'meta' }, short(f.key) + (v?.sha ? ' at ' + v.sha.slice(0, 8) : '') + (f.loading ? ', loading…' : ''))),
        el('div', { class: 'actions' },
          v && v.commentedPaths.length > 1 ? filePicker(f, v) : null,
          chips([[false, 'Whole file'], [true, 'Commented lines']], f.folded, (folded) => { Object.assign(f, { folded, reveal: threadAtTop() }); loadFile(); }),
          el('button', { class: 'icon-only', title: 'Previous comment', 'aria-label': 'Previous comment', onclick: () => stepThread(-1) }, icon('up')),
          el('button', { class: 'icon-only', title: 'Next comment', 'aria-label': 'Next comment', onclick: () => stepThread(1) }, icon('down')),
          el('button', { class: 'icon-only', title: 'Close (Esc)', 'aria-label': 'Close', onclick: closeFile }, icon('x')))),
      v ? fileNotes(v, f.key) : null),
    el('div', { class: 'sheet-body' },
      f.error ? el('div', { class: 'fpad' }, banner('Could not load the file: ' + f.error, true))
        : v ? fileDoc(f, d) : el('p', { class: 'empty fpad' }, 'Reading the file at the MR head…')));
}

function filePicker(f, v) {
  const paths = [...new Set([f.path, ...v.commentedPaths])];
  return el('select', { id: 'file-path', 'aria-label': 'Commented file', onchange: (e) => { Object.assign(f, { path: e.target.value, focus: null, view: null, reveal: 'focus' }); loadFile(); } },
    paths.map((p) => el('option', { value: p, selected: p === f.path }, p)));
}

function fileNotes(v, key) {
  const counts = [plural(v.threads, 'comment thread'), v.pending ? v.pending + ' not posted yet' : null].filter(Boolean).join(', ');
  return [
    el('div', { class: 'meta' }, counts + '.'),
    v.unplaced ? el('div', { class: 'meta bad' }, plural(v.unplaced, 'thread') + ' on this file found no line to sit under, most likely because they were written against older code.') : null,
    v.fileTooBig ? el('div', { class: 'meta' }, 'The file is too big to show whole, so this is its diff on its own.')
      : v.source === 'diff' ? el('div', { class: 'meta bad' }, 'The file could not be read at this commit, so this is its diff on its own.') : null,
    v.tooLarge ? el('div', { class: 'meta' }, forgeName(key) + ' collapsed this file\'s diff, so no line is marked as changed.') : null,
    !v.diffComplete ? el('div', { class: 'meta' }, 'The MR has more files than were read, so changes may be missing.')
      : !v.inDiff ? el('div', { class: 'meta' }, 'The merge request does not change this file.') : null,
  ];
}

// The code is built once per view and only the threads are redrawn, since a file can run to thousands of rows.
function fileDoc(f, d) {
  const v = f.view;
  if (!v.rows.some((r) => r.kind === 'code')) return el('p', { class: 'empty fpad' }, 'Nothing in this file to show.');
  if (f.doc?.view !== v) f.doc = codeDoc(v, f.focus);
  const queue = new Map(d.m.queue.map((q) => [q.id, q]));
  for (const t of f.doc.threads) {
    const block = threadBlock(t.rows, queue, t.focus);
    t.node.replaceWith(block);
    t.node = block;
  }
  return f.doc.node;
}

function codeDoc(v, focus) {
  const segments = docSegments(v.rows);
  const focused = focusIndex(segments, focus);
  const threads = [];
  const node = el('div', { class: 'fdoc' }, segments.map((s, i) => {
    if (!s.rows) return docRow(s.row);
    const t = { rows: s.rows, focus: i === focused, node: document.createComment('') };
    threads.push(t);
    return t.node;
  }));
  return { view: v, node, threads };
}

function focusIndex(segments, focus) {
  if (!focus) return -1;
  if (focus.queueId) return segments.findIndex((s) => s.rows?.[0].queueId === focus.queueId);
  const at = segments.findIndex((s) => s.row?.kind === 'code' && s.row.line === focus.line && (s.row.change === '-') === (focus.side === 'old'));
  return at >= 0 && segments[at + 1]?.rows ? at + 1 : -1;
}

function docSegments(rows) {
  const out = [];
  for (const row of rows) {
    const last = out[out.length - 1];
    if (row.thread != null && last?.thread === row.thread) last.rows.push(row);
    else out.push(row.thread != null ? { thread: row.thread, rows: [row] } : { row });
  }
  return out;
}

const CHANGE_TONE = { '+': 'add', '-': 'del', ' ': 'ctx' };

function docRow(row) {
  if (row.kind === 'gap') return row.text ? el('div', { class: 'fgap' }, row.text) : null;
  if (row.kind !== 'code') return null;
  return el('div', { class: 'frow ' + CHANGE_TONE[row.change] },
    el('span', { class: 'ln', title: row.change === '-' ? 'Removed line' : null }, row.line ?? ''),
    el('span', { class: 'mk' }, row.change === ' ' ? '' : row.change),
    el('span', { class: 'tx' }, row.text || ' '));
}

function threadBlock(rows, queue, focus) {
  const id = rows[0].queueId;
  const q = queue.get(id);
  return el('div', { class: 'fthread' + (id ? ' pending' : '') + (focus ? ' focus' : ''), 'data-queue-id': id, 'data-thread': rows[0].thread },
    noteBlocks(rows),
    slot('threadActions', q, rows));
}

function noteBlocks(rows) {
  const notes = [];
  for (const row of rows) {
    if (row.kind === 'author') notes.push({ who: row.text, lines: [] });
    else notes[notes.length - 1]?.lines.push(row.text);
  }
  return notes.map((n) => [el('div', { class: 'who' }, n.who), el('div', { class: 'say' }, markdown(n.lines.join('\n')))]);
}
