const MOODS = [
  ['awaitingYou', 'Waiting on me', 's-need'], ['moved', 'Code moved', 's-moved'], ['reviewing', 'Reviewing now', 's-working'],
  ['approved', 'Approved', 's-done'], ['reviewed', 'I reviewed', 's-info'], ['unreviewed', 'No reviewer', 's-quiet'], ['quiet', 'Others on it', ''],
];
const MOOD = Object.fromEntries(MOODS.map(([k, label, tone]) => [k, { label, tone }]));
const PHASE = {
  running: () => 'review running', stalled: () => 'review ended with nothing', ready: (n) => n + ' to post',
  awaiting: (n) => n + ' replied to you', moved: (n) => 'code moved under ' + n, open: (n) => n + ' open', posted: (n) => n + ' posted',
};
const MERGE_TONE = { ready: 's-done', waiting: 's-working', blocked: 's-need' };
const PIPE_TONE = { SUCCESS: 's-done', FAILED: 's-need', CANCELED: 's-need', RUNNING: 's-working', PENDING: 's-working', CREATED: 's-working', PREPARING: 's-working', WAITING_FOR_RESOURCE: 's-working', SCHEDULED: 's-working' };
const MR_SHOWN = 150;
const MR_LAYOUT_KEY = 'cc.mrLayout';
const DESCRIPTION_LINES = 14;
const SINCE_FILES = 12;
const mrRefs = () => new RegExp([/\[([^\]\n]+)\]\((https:\/\/[^)\s]+)\)/, mrUrlPattern(), JIRA_URL, MR_SHORT_REF, new RegExp('\\b(' + TICKET_KEY_SOURCE + ')\\b'), ...githubRefSources()].map((r) => r.source).join('|'), 'g');

function scopeMrs(scope) {
  Object.assign(ui, { mrSearch: '', mrScope: scope, mrMood: 'all', mrRepo: '', mrPerson: '' });
}

function mrFilters(rows) {
  const q = ui.mrSearch.toLowerCase();
  return rows.filter((r) => (ui.mrScope === 'all' || (ui.mrScope === 'asking' ? r.flags.waitingOnYou : ui.mrScope === 'mine' ? r.flags.mine : r.flags.watched))
    && (ui.mrMood === 'all' || r.mood === ui.mrMood)
    && (!ui.mrRepo || r.repo === ui.mrRepo)
    && (!ui.mrPerson || r.author === ui.mrPerson)
    && (!q || [r.title, r.author, r.ticket || '', r.repo, refNumber(r), r.reviewers.join(' ')].join(' ').toLowerCase().includes(q)));
}

function tally(rows, pick) {
  const counts = new Map();
  for (const r of rows) for (const v of [pick(r)].flat()) counts.set(v, (counts.get(v) || 0) + 1);
  return [...counts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
}

function mrLayout() {
  ui.mrLayout ??= storedLayout(MR_LAYOUT_KEY);
  return ui.mrLayout;
}

function setMrLayout(layout) {
  ui.mrLayout = layout;
  storeLayout(MR_LAYOUT_KEY, layout);
  render(true);
}

function picker(id, label, value, options, onPick) {
  return el('select', { id, 'aria-label': label, onchange: (e) => onPick(e.target.value) },
    el('option', { value: '' }, label),
    options.map(([v, n, name = v]) => el('option', { value: v, selected: v === value }, name + ' (' + n + ')')));
}

function viewMergeRequests(d) {
  const g = d.m.inbox ?? { rows: [] };
  const shown = mrFilters(d.rows);
  const moodCounts = tally(d.rows, (r) => r.mood);
  const count = (k) => moodCounts.find(([mood]) => mood === k)?.[1] || 0;
  const reset = () => { scopeMrs('all'); render(); };
  const filtered = ui.mrSearch || ui.mrScope !== 'all' || ui.mrMood !== 'all' || ui.mrRepo || ui.mrPerson;
  return [
    header('Merge requests', g.fetchedAt ? `${d.rows.length} open across ${g.repoCount} repos, updated ${ago(g.fetchedAt)}${g.loading ? ', refreshing' : ''}.` : 'Loading every open MR in your repos…',
      layoutSwitch(mrLayout(), setMrLayout, 'mr-layout-'), button('Refresh ' + listedForges(d.rows), 'refresh', () => matrixAct('refresh', {}, 'refresh'))),
    matrixBanners(d.m),
    el('div', { class: 'filters' },
      chips([['all', 'All'], ['asking', 'Asking me (' + d.asking.length + ')'], ['mine', 'Mine (' + d.mine.length + ')'], ['watched', 'Watched']], ui.mrScope, (v) => { ui.mrScope = v; render(); }),
      searchBox('mr-q', 'Search title, ticket, person, !iid', ui.mrSearch, (v) => { ui.mrSearch = v; render(true); })),
    el('div', { class: 'filters' },
      chips([['all', 'Any status'], ...MOODS.filter(([k]) => count(k)).map(([k, label]) => [k, label + ' ' + count(k)])], ui.mrMood, (v) => { ui.mrMood = v; render(); }),
      picker('mr-repo', 'Every repo', ui.mrRepo, tally(d.rows, (r) => r.repo), (v) => { ui.mrRepo = v; render(); }),
      picker('mr-person', 'Any author', ui.mrPerson, tally(d.rows, (r) => r.author), (v) => { ui.mrPerson = v; render(); }),
      filtered ? button('Clear filters', 'x', reset) : null),
    shown.length ? [mrShown(shown.slice(0, MR_SHOWN), d), shown.length > MR_SHOWN ? el('p', { class: 'meta' }, 'Showing ' + MR_SHOWN + ' of ' + shown.length + '. Narrow the filters to see the rest.') : null]
      : empty(g.fetchedAt ? 'No merge request matches.' : 'Waiting for GitLab.'),
  ];
}

// Names the forges the list holds, so a list with only GitLab's still says just GitLab.
function listedForges(rows) {
  return rows.some((r) => r.provider === 'github') ? 'GitLab and GitHub' : 'GitLab';
}

function mrShown(rows, d) {
  return (mrLayout() === 'board' && slot('mrBoard', rows, d)) || el('div', { class: 'list' }, rows.map((r) => mrRow(r, d)));
}

function mrRow(r, d) {
  const mood = MOOD[r.mood];
  const queued = d.pendingByMr.get(r.key) || [];
  const open = queued.length > 0 && ui.mrOpen.has(r.key);
  return el('div', { class: 'mr ' + mood.tone },
    el('div', { class: 'main' },
      el('div', { class: 'row-head' },
        mood.tone ? el('span', { class: 'pill ' + mood.tone, title: r.mood === 'moved' && r.movedWhy ? 'Since your review: ' + r.movedWhy : null }, mood.label) : null,
        queued.length ? disclosure(r.key, queued.length, open) : null,
        PHASE[r.phase] && !(queued.length && r.phase === 'ready') ? el('span', { class: 'meta' }, PHASE[r.phase](r.count)) : null,
        mrRef(r.key, r.title, queued.length ? 'findings' : 'overview')),
      el('div', { class: 'row-head' },
        metaLine(rowRef(r), slot('ticketChip', r), r.author + (r.reviewers.length ? ' → ' + r.reviewers.join(', ') : ''), ago(r.updatedAt)),
        slot('pipelineChip', r),
        slot('stateChips', r),
        slot('threadsChip', r),
        readOnlyNote(r.key))),
    el('div', { class: 'actions' },
      postAllButton(r.key, queued),
      slot('agentButton', r, d),
      slot('reviewButton', r, d),
      slot('ownMrActions', r, d),
      approveButton(r, d),
      holdButton(r),
      slot('mrMenu', r, d)),
    slot('decideCard', r, d),
    open ? el('div', { class: 'mr-queue' }, queued.map((q) => queueItem(q, true))) : null);
}

function approveButton(r, d) {
  if (r.flags.mine || !d.m.me || !forgeAllows(r.key, 'post')) return null;
  const approved = r.flags.youApproved;
  return guarded('approve:' + r.key, approved ? 'Withdraw' : 'Approve', approved ? 'undo' : 'thumbsup', approved ? 'Withdraw approval?' : 'Approve on GitLab?',
    () => matrixAct('approve', { key: r.key, approving: !approved }, 'approve:' + r.key));
}

function holdButton(r) {
  if (r.flags.mine || !forgeAllows(r.key, 'hold')) return null;
  if (r.flags.held && r.flags.heldByMe === false) return el('span', { class: 'pill s-working', title: 'Only they can lift it' }, icon('lock'), 'held by ' + (heldBy(r) || 'another reviewer'));
  const held = r.flags.held;
  return guarded('hold:' + r.key, held ? 'Release' : 'Hold', held ? 'unlock' : 'lock', held ? 'Lift the hold?' : 'Block the merge?',
    () => matrixAct('hold', { key: r.key, held: !held }, 'hold:' + r.key));
}

function heldBy(r) {
  const me = state.matrix?.me;
  return Object.entries(r.reviewStates ?? {}).filter(([name, s]) => s === 'REQUESTED_CHANGES' && name !== me).map(([name]) => name).join(', ');
}

function disclosure(key, n, open) {
  return el('button', { class: 'disclose', 'aria-expanded': String(open), title: open ? 'Hide the comments' : 'Read the comments here', onclick: () => toggle(ui.mrOpen, key) },
    icon('chevron'), n + ' to post');
}

function reviewButton(r, d) {
  if (r.agent || r.agentStarting || !forgeAllows(r.key, 'agents')) return null;
  const id = 'review:' + r.key;
  if (r.flags.mine) return guarded(id, 'Review my MR', 'eyes', 'Self-review ' + refNumber(r) + '?', () => matrixAct('review-own', { key: r.key }, id));
  const queued = d.pendingByMr.get(r.key) || [];
  return guarded(id, 'Review', 'eyes', d.m.holdWhileReviewing ? 'Review ' + refNumber(r) + ' and hold it?' : 'Review ' + refNumber(r) + '?',
    () => matrixAct('review', { key: r.key }, id), !queued.length && r.flags.waitingOnYou);
}

function drawerOverview(ctx) {
  const mr = ctx.mr;
  if (!mr) return ctx.loading ? drawerWaiting(ctx) : empty(ctx.key + ' is not in the open list.');
  const row = ctx.row;
  const mood = row && MOOD[row.mood];
  return [
    sinceSummary(ctx),
    row ? el('div', { class: 'row-head' }, mood?.tone ? el('span', { class: 'pill ' + mood.tone }, mood.label) : null, slot('stateChips', row), readOnlyNote(row.key)) : null,
    overviewFacts(ctx, mr, ctx.detail?.detail ?? null),
    slot('reviewersPicker', ctx),
    row ? el('div', { class: 'actions' }, postAllButton(row.key, ctx.queued), slot('reviewButton', row, ctx.d), slot('ownMrActions', row, ctx.d, 'drawer'), approveButton(row, ctx.d), holdButton(row)) : null,
    describeMr(ctx, mr),
  ];
}

function sinceSummary(ctx) {
  const since = ctx.detail?.since;
  if (!since) return null;
  const shown = since.paths.slice(0, SINCE_FILES);
  return el('section', { class: 'since', 'aria-label': 'Since your review' },
    el('p', {}, el('b', {}, 'Since your review' + (since.at ? ' ' + ago(since.at) : '') + ': '), since.words ?? 'nothing has moved.'),
    shown.length ? el('div', { class: 'files since-files' }, shown.map((path) => el('button', { type: 'button', class: 'file-row', 'data-path': path, title: 'Show ' + path, onclick: () => openFile(ctx.key, path) }, icon('file-text'), el('span', { class: 'path' }, pathText(path))))) : null,
    since.paths.length > SINCE_FILES ? el('p', { class: 'meta' }, 'and ' + plural(since.paths.length - SINCE_FILES, 'more file')) : null);
}

function overviewFacts(ctx, mr, more) {
  const fact = (label, value) => [el('dt', {}, label), el('dd', {}, value)];
  const people = (names) => (names?.length ? names.join(', ') : 'nobody');
  return el('dl', { class: 'kv' },
    fact('Author', mr.author),
    fact('Reviewers', people(mr.reviewers?.map((name) => (mr.approvedBy?.includes(name) ? name + ' (approved)' : name)))),
    fact('Approved by', people(mr.approvedBy)),
    fact('Merge status', mergeWords(ctx.detail?.merge, mr.mergeStatus, ctx.key)),
    fact('Branches', el('span', { class: 'meta' }, (mr.sourceBranch ?? '?') + ' → ' + (more?.targetBranch ?? '?'))),
    fact('Pipeline', pipelineButton(ctx.key, mr.pipeline)),
    fact('Ticket', ticketRef(mr.ticket) ?? 'none'),
    fact('Changes', changeLinks(ctx, mr, more)),
    fact('Updated', [ago(mr.updatedAt), mr.sha ? el('span', { class: 'meta' }, ' at ' + mr.sha.slice(0, 8)) : null]));
}

function mergeWords(merge, raw, key) {
  if (!merge) return String(raw ?? 'unknown').toLowerCase().replace(/_/g, ' ');
  return el('span', { class: 'pill ' + MERGE_TONE[merge.tone], title: forgeName(key) + ': ' + merge.status }, merge.words);
}

function pipelineButton(key, status) {
  const label = !status ? 'none on the head' : status === 'SUCCESS' ? 'passed' : status.toLowerCase().replace(/_/g, ' ');
  return el('button', { class: 'chip-btn tone ' + (PIPE_TONE[status] ?? 's-quiet'), title: 'Show the pipeline\'s jobs', onclick: () => openMr(key, 'pipeline') }, icon('activity'), label);
}

function changeLinks(ctx, mr, more) {
  const files = String(more?.changes ?? ctx.detail?.files?.list.length ?? '');
  return el('span', { class: 'actions' },
    files ? el('button', { class: 'linkish', onclick: () => openMr(ctx.key, 'files') }, files + (files === '1' ? ' file' : ' files') + ' changed') : null,
    el('button', { class: 'linkish', onclick: () => openMr(ctx.key, 'threads') }, (mr.unresolved ?? 0) + ' unresolved'),
    more?.notes != null ? el('span', { class: 'meta' }, plural(more.notes, 'comment')) : null);
}

function describeMr(ctx, mr) {
  const more = ctx.detail?.detail;
  const refs = knownRefs(ctx);
  return el('section', { class: 'mr-doc', 'aria-label': 'Title and description' },
    el('h3', {}, withRefs(mr.title ?? '', refs)),
    more ? mrDescription(ctx.key, more, refs)
      : ctx.detail ? el('p', { class: 'meta bad' }, 'The description could not be read: ' + (ctx.detail.missing?.detail ?? 'unknown') + '.')
        : ctx.loading ? el('p', { class: 'meta' }, 'Reading the description…') : null);
}

// Only the Jira projects the open MRs use count as tickets, so UTF-8 or SHA-256 stays text.
function knownRefs(ctx) {
  const rows = ctx.d.rows;
  return {
    here: keyPath(ctx.key),
    github: keyProvider(ctx.key) === 'github',
    mrs: new Set([...rows.map((r) => r.key), ...ctx.d.m.queue.map((q) => q.key)]),
    projects: new Set([...ownProjects(), ...[...rows, ctx.mr].map((r) => r?.ticket?.split('-')[0]).filter(Boolean)]),
  };
}

function mrDescription(key, more, refs) {
  if (!more.description) return el('p', { class: 'meta' }, 'No description.');
  const lines = more.description.split('\n');
  const long = lines.length > DESCRIPTION_LINES;
  const open = ui.open.has('desc:' + key);
  const shown = long && !open ? lines.slice(0, DESCRIPTION_LINES).join('\n') + '\n…' : more.description;
  return [
    el('div', { class: 'mr-desc' }, markdown(shown, { text: (run) => withRefs(run, refs), link: (label, url) => linkRef(label, url, refs) })),
    long ? el('button', { class: 'linkish', 'aria-expanded': String(open), onclick: () => toggle(ui.open, 'desc:' + key) }, open ? 'Show less' : 'Show all ' + lines.length + ' lines') : null,
    more.clipped ? el('p', { class: 'meta' }, 'The description runs on past this on ' + forgeName(key) + '.') : null,
  ];
}

// Text only: references become buttons, and one the page cannot open stays as written.
function withRefs(text, refs) {
  const out = [];
  let at = 0;
  for (const m of text.matchAll(mrRefs())) {
    const node = refFor(m, refs);
    if (!node) continue;
    out.push(text.slice(at, m.index), node);
    at = m.index + m[0].length;
  }
  out.push(text.slice(at));
  return out.filter((part) => part !== '');
}

function refFor([whole, label, link, urlProject, urlIid, jiraKey, project, iid, ticket, prProject, prIid, ghProject, ghIid], refs) {
  if (link) return linkRef(label, link, refs);
  if (jiraKey) return ticketRef(jiraKey);
  if (ticket) return refs.projects.has(ticket.split('-')[0]) ? ticketRef(ticket) : null;
  if (prProject || ghIid) return githubRef(whole, prProject ?? ghProject, prIid ?? ghIid, refs);
  const key = urlProject ? keyOf({ projectPath: urlProject, iid: urlIid }) : keyOf({ projectPath: refProject(project, refs.here), iid });
  return refs.mrs.has(key) ? mrRef(key, whole) : null;
}

function linkRef(label, link, refs) {
  const jira = JIRA_URL.exec(link);
  if (jira) return ticketRef(jira[1]);
  const key = keyInUrl(link);
  return refs.mrs.has(key) ? mrRef(key, label) : null;
}

// In a pull request a bare number is that repo's and owner/repo with a number is another; anywhere else a bare number could be anything, so it stays text.
function githubRef(whole, project, iid, refs) {
  const projectPath = project?.includes('/') ? project : !project && refs.github ? refs.here : null;
  const key = projectPath && keyOf({ provider: 'github', projectPath, iid });
  return key && refs.mrs.has(key) ? mrRef(key, whole) : null;
}

// GitLab reads !12 as this project, repo!12 as a sibling in the same group, and a/b!12 as a full path.
function refProject(project, here) {
  if (!project) return here;
  return project.includes('/') ? project : here.slice(0, here.lastIndexOf('/') + 1) + project;
}

function commentedPaths(ctx) {
  const paths = new Map();
  const at = (path) => paths.get(path) ?? paths.set(path, { threads: 0, queued: 0 }).get(path);
  for (const t of ctx.detail?.discussions ?? []) if (t.path) at(t.path).threads += 1;
  for (const q of ctx.queued) if (q.path && q.status === 'pending') at(q.path).queued += 1;
  return paths;
}

function drawerFiles(ctx) {
  const files = ctx.detail?.files;
  const commented = commentedPaths(ctx);
  if (!ctx.detail && !commented.size) return ctx.loading ? drawerWaiting(ctx) : empty('No file of ' + short(ctx.key) + ' could be read.');
  const changed = files?.list ?? [];
  const extra = [...commented.keys()].filter((path) => !changed.some((f) => f.path === path || f.oldPath === path)).sort();
  const entries = [...changed, ...extra.map((path) => ({ path, gone: Boolean(files?.complete) }))];
  const readable = Boolean(ctx.row);
  return [
    el('div', { class: 'foot' },
      el('span', { class: 'meta' }, filesSummary(changed, commented)),
      readable && commented.size ? button('First commented file', 'message', () => openFile(ctx.key, '')) : null),
    filesNotice(ctx, files),
    readable ? null : el('p', { class: 'meta' }, short(ctx.key) + ' is no longer open, so its files cannot be shown.'),
    entries.length ? el('div', { class: 'files' }, entries.map((f) => fileRow(ctx.key, f, commented.get(f.path) ?? commented.get(f.oldPath), readable)))
      : files?.complete ? empty('The MR changes no file.') : null,
  ];
}

function filesNotice(ctx, files) {
  if (files) return files.complete ? null : el('p', { class: 'meta' }, forgeName(ctx.key) + ' listed only the first ' + files.list.length + ' files.');
  if (ctx.loading) return el('p', { class: 'meta' }, 'Reading the changed files…');
  return ctx.detail ? el('p', { class: 'meta bad' }, 'The changed files could not be read: ' + (ctx.detail.missing?.files ?? 'unknown') + '.') : null;
}

function filesSummary(changed, commented) {
  const sum = (k) => changed.reduce((n, f) => n + f[k], 0);
  const parts = [changed.length ? plural(changed.length, 'file') + ' changed, +' + sum('added') + ' −' + sum('removed') : null, commented.size ? commented.size + ' commented on' : null];
  return parts.filter(Boolean).join(', ') || 'No changed file was listed.';
}

function fileRow(key, f, notes, readable) {
  const marks = [
    changeMark(f),
    notes?.threads ? el('span', { class: 'pill s-moved' }, icon('message'), plural(notes.threads, 'thread')) : null,
    notes?.queued ? el('span', { class: 'pill s-working' }, notes.queued + ' not posted') : null,
  ].filter(Boolean);
  const parts = [icon('file-text'), el('span', { class: 'path' }, pathText(f.path)), lineDelta(f), marks.length ? el('span', { class: 'marks' }, marks) : null];
  const rowClass = 'file-row' + (notes ? ' commented' : '');
  if (!readable) return el('div', { class: rowClass }, parts);
  return el('button', { type: 'button', class: rowClass, 'data-path': f.path, title: 'Show ' + f.path + ' with its comments', onclick: () => openFile(key, f.path) }, parts);
}

function changeMark(f) {
  if (f.gone) return el('span', { class: 'pill s-quiet' }, 'not in the diff now');
  if (!f.change || f.change === 'modified') return null;
  return el('span', { class: 'pill s-info' }, f.change === 'renamed' ? 'renamed from ' + f.oldPath : f.change);
}

function lineDelta(f) {
  if (!f.change) return null;
  if (f.tooLarge) return el('span', { class: 'meta' }, 'too large to count');
  return el('span', { class: 'delta' }, el('span', { class: 'plus' }, '+' + f.added), ' ', el('span', { class: 'minus' }, '−' + f.removed));
}

// A narrow drawer breaks the path after a slash before it splits a name.
function pathText(path) {
  const dirs = path.split('/');
  const name = dirs.pop();
  return [el('span', { class: 'dir' }, dirs.map((d) => [d + '/', el('wbr')])), name];
}
