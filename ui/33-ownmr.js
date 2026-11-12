const FIX_LAUNCH_GRACE_MS = 5 * 60 * 1000;
const ownFacts = { for: null, loading: false, mrs: {} };

function stateChips(r) {
  const rebase = r.flags.mine ? ownFactsFor(r.key)?.rebase : null;
  return [
    r.draft ? el('span', { class: 'pill s-quiet' }, 'draft') : null,
    r.flags.conflict ? el('span', { class: 'pill s-need' }, 'conflicts') : null,
    rebase?.state === 'failed' ? el('span', { class: 'pill s-need', title: rebase.error }, 'rebase failed') : null,
    r.flags.held ? el('span', { class: 'pill s-working' }, icon('lock'), 'held') : null,
    r.verdict ? el('span', { class: 'pill s-done' }, r.verdict.toLowerCase()) : null,
    r.flags.changed ? el('span', { class: 'pill s-moved', title: r.movedWhy ? 'Since your review: ' + r.movedWhy : null }, 'moved since review') : null,
    r.level ? el('span', { class: 'pill s-info' }, icon('zap'), 'auto: ' + r.level + (r.askedYou ? ', asked you' : '')) : null,
    r.flags.mine && r.autoMerge ? el('span', { class: 'pill s-working', title: forgeName(r.key) + ' merges it once every check passes' }, icon('merge'), 'merges when green') : null,
    r.agent ? el('span', { class: 'pill s-working' }, icon('bot'), 'agent ' + r.agent) : null,
    r.flags.mine ? fixChip(r.key) : null,
  ];
}

// A rebase, a merge and a fix agent each change the branch, so while one is under way the others are not offered.
function ownMrActions(r, d, where = 'row') {
  if (!r.flags.mine || !d.m.me || !forgeAllows(r.key, 'ownMr')) return null;
  const facts = ownFactsFor(r.key);
  if (fixAlive(r.key)) return readyButton(r);
  return [rebaseButton(r, facts), conflictsButton(r), readyButton(r), r.autoMerge ? cancelMergeButton(r) : mergeControl(r, facts, where)];
}

function cancelMergeButton(r) {
  const id = 'cancel-merge:' + r.key;
  return guarded(id, 'Cancel merge when green', 'x', 'Cancel merge when green on ' + refNumber(r) + '?', () => matrixAct('cancel-merge', { key: r.key, expect: { sha: r.sha } }, id));
}

function rebasing(key, facts) {
  return facts?.rebase?.state === 'running' || ui.busy.has('rebase:' + key);
}

const branchChanging = (key) => rebasing(key, ownFactsFor(key)) || ui.busy.has('merge:' + key);

// GitLab names only the first check that fails, and need_rebase only on fast-forward projects, so the branch says how far behind it is.
function rebaseButton(r, facts) {
  if (facts?.rebase?.state === 'running') return el('button', { disabled: true, title: 'GitLab is rebasing it' }, icon('clock'), 'Rebasing…');
  if (r.flags.conflict || !(facts?.behind > 0 || r.mergeStatus === 'NEED_REBASE')) return null;
  const id = 'rebase:' + r.key;
  const onto = facts?.target ? ' onto ' + facts.target : ' on GitLab';
  const behind = facts?.behind > 0 ? ', ' + plural(facts.behind, 'commit') + ' behind' : '';
  return guarded(id, 'Rebase', 'git-branch', 'Rebase ' + refNumber(r) + onto + behind + '?', () => matrixAct('rebase', { key: r.key, expect: { sha: r.sha } }, id));
}

function conflictsButton(r) {
  if (!r.flags.conflict || branchChanging(r.key)) return null;
  const id = 'fix-conflicts:' + r.key;
  return guarded(id, 'Fix conflicts with an agent', 'wrench', 'Fix the conflicts on ' + refNumber(r) + ' with an agent' + '?', () => matrixAct('fix', { key: r.key, conflicts: true, expect: { sha: r.sha } }, 'fix:' + r.key));
}

function readyButton(r) {
  if (!r.draft) return null;
  const id = 'ready:' + r.key;
  return guarded(id, 'Mark ready', 'check-circle', 'Mark ' + refNumber(r) + ' ready for review?', () => matrixAct('ready', { key: r.key, expect: { sha: r.sha } }, id));
}

// The worker decides from GitLab's merge status; the page offers only what it said, and says why when that is nothing.
function mergeControl(r, facts, where) {
  if (!facts) return null;
  const { merge, target } = facts;
  if (merge.can && target && !rebasing(r.key, facts)) return mergeButton(r, merge.can, target);
  return where === 'drawer' ? null : el('span', { class: 'merge-why', title: 'Why GitLab will not merge it yet' }, slot('mergeWords', merge, r.mergeStatus));
}

function mergeButton(r, can, target) {
  const id = 'merge:' + r.key;
  const send = () => matrixAct('merge', { key: r.key, expect: { sha: r.sha, can, target } }, id);
  if (can === 'now') return guarded(id, 'Merge', 'merge', 'Merge ' + refNumber(r) + ' into ' + target + '?', send, true);
  return guarded(id, 'Merge when green', 'merge', 'Merge ' + refNumber(r) + ' into ' + target + ' once the pipeline passes?', send);
}

function ownFactsFor(key) {
  if (state && !ownFacts.loading && ownFacts.for !== state) loadOwnFacts(state);
  return ownFacts.mrs[key] ?? null;
}

// Asked again for every snapshot, so a merge status, a rebase or a target branch moves as soon as the list does.
async function loadOwnFacts(snapshot) {
  ownFacts.loading = true;
  try {
    ownFacts.mrs = (await api('/api/matrix/own-mrs')).mrs ?? {};
  } catch {
    ownFacts.mrs = {};
  }
  Object.assign(ownFacts, { for: snapshot, loading: false });
  render(true);
}

function reviewersPicker(ctx) {
  const r = ctx.row;
  if (!r?.flags.mine || !ctx.mr || !ctx.d.m.me) return null;
  const current = ctx.mr.reviewers ?? [];
  const draft = 'reviewers:' + ctx.key;
  const picked = ui.drafts.get(draft) ?? current;
  const changed = !sameNames(picked, current);
  const pick = (next) => setReviewerDraft(ctx.key, current, next);
  return el('section', { class: 'reviewers', 'aria-label': 'Reviewers' },
    el('div', { class: 'row-head' },
      el('span', { class: 'meta' }, 'Reviewers'),
      picked.length ? picked.map((name) => reviewerChip(name, ctx.mr.approvedBy ?? [], () => pick(picked.filter((n) => n !== name)))) : el('span', { class: 'meta' }, 'nobody'),
      reviewerAdd(ctx, picked, (name) => pick([...picked, name]))),
    el('div', { class: 'actions' },
      changed ? saveReviewersButton(ctx, picked, current) : null,
      changed ? button('Undo', 'undo', () => pick(current)) : rerequestButton(ctx, current)));
}

function reviewerChip(name, approvedBy, remove) {
  const approved = approvedBy.includes(name);
  return el('span', { class: 'pill reviewer ' + (approved ? 's-done' : 's-info') },
    approved ? icon('check') : null, name,
    el('button', { type: 'button', class: 'icon-only', title: 'Take ' + name + ' off the reviewers', 'aria-label': 'Remove ' + name, onclick: remove }, icon('x')));
}

function reviewerAdd(ctx, picked, add) {
  const taken = new Set([...picked, ctx.row.author].map((n) => n.toLowerCase()));
  const people = (ctx.d.m.roster ?? []).map((p) => p.username).filter((name) => !taken.has(name));
  if (!people.length) return null;
  return el('select', { id: 'reviewer-add', 'aria-label': 'Add a reviewer', onchange: (e) => e.target.value && add(e.target.value) },
    el('option', { value: '' }, 'Add a reviewer…'),
    people.map((name) => el('option', { value: name }, name)));
}

const sameNames = (a, b) => JSON.stringify(a.map((n) => n.toLowerCase()).sort()) === JSON.stringify(b.map((n) => n.toLowerCase()).sort());

// A change after Save was armed disarms it, so what is sent is always the list the confirm named.
function setReviewerDraft(key, current, next) {
  const draft = 'reviewers:' + key;
  if (sameNames(next, current)) ui.drafts.delete(draft);
  else ui.drafts.set(draft, next);
  if (ui.armed === 'reviewers:' + key) ui.armed = null;
  render(true);
}

function saveReviewersButton(ctx, picked, current) {
  const id = 'reviewers:' + ctx.key;
  const names = picked.length ? picked.join(', ') : 'nobody';
  return guarded(id, 'Save reviewers', 'users', 'Set the reviewers of ' + refNumber(ctx.row) + ' to ' + names + '?', async () => {
    const saved = await matrixAct('reviewers', { key: ctx.key, reviewers: picked, expect: { sha: ctx.mr.sha, reviewers: current } }, id);
    if (saved) ui.drafts.delete('reviewers:' + ctx.key);
    render(true);
  }, true);
}

function rerequestButton(ctx, current) {
  const waiting = current.filter((name) => !(ctx.mr.approvedBy ?? []).includes(name));
  if (!waiting.length) return null;
  const id = 'rerequest:' + ctx.key;
  return guarded(id, 'Re-request review', 'refresh', 'Ask ' + waiting.join(', ') + ' to review ' + refNumber(ctx.row) + ' again?',
    () => matrixAct('rerequest', { key: ctx.key, reviewers: waiting, expect: { sha: ctx.mr.sha } }, id));
}

const openThreads = (discussions) => discussions.filter((t) => t.resolvable && !t.resolved);
const peopleThreads = (discussions) => openThreads(discussions).filter((t) => !t.bot);
const answeredLast = (t, me) => t.notes.at(-1)?.author === me;
const threadsToFix = (discussions, me) => peopleThreads(discussions).filter((t) => !answeredLast(t, me));
// The threads behind a comments reason, counted as the worker counts them: open ones you did not answer last, and plain comments newer than anything you said.
function commentsForYou(discussions, me) {
  const mineAt = discussions.filter((t) => answeredLast(t, me)).map((t) => t.notes.at(-1).createdAt).sort().at(-1) ?? '';
  return discussions.filter((t) => !t.bot && !answeredLast(t, me) && (t.resolvable ? !t.resolved : (t.notes.at(-1)?.createdAt ?? '') > mineAt));
}

const fixWhat = (n) => (n === 1 ? '1 comment' : n + ' comments');

function fixRunOf(key) {
  return (state.matrix.runs ?? []).find((run) => run.key === 'fix:' + key) ?? null;
}

function fixAgentOf(run) {
  if (!run?.terminal) return null;
  return state.agents.find((a) => a.handle === run.terminal) ?? null;
}

// The worker refuses a second fix while this holds; an agent that has ended its turn may be asking you to push.
function fixAlive(key) {
  if (ui.busy.has('fix:' + key)) return true;
  const run = fixRunOf(key);
  if (!run || run.status === 'launch failed') return false;
  if (!run.terminal) return Date.now() - Date.parse(run.startedAt) < FIX_LAUNCH_GRACE_MS;
  return Boolean(fixAgentOf(run));
}

// A fix agent's turn ends on the brief's question, so one that is still recorded and done is waiting on you.
function fixAgentWaits(a) {
  return Boolean(a.handle) && (state.matrix.runs ?? []).some((run) => run.key.startsWith('fix:') && run.status !== 'launch failed' && run.terminal === a.handle);
}

function fixChip(key) {
  if (!fixAlive(key)) return null;
  const agent = fixAgentOf(fixRunOf(key));
  const label = agent ? 'fix agent ' + (slot('agentLabel', agent) ?? agent.state) : 'fix agent starting';
  return el('button', { type: 'button', class: 'chip-btn tone ' + (agent ? agentClass(agent) : 's-working'), title: 'Read and answer the agent fixing this MR', onclick: () => slot('openMr', key, 'agent') }, icon('wrench'), label);
}

function sendFix(key, sha, threads, discussionId) {
  const counts = Object.fromEntries(threads.map((t) => [t.id, t.notes.length]));
  return matrixAct('fix', { key, ...(discussionId ? { discussionId } : {}), expect: { sha, threads: counts } }, 'fix:' + key);
}

function swept(key) {
  const run = fixRunOf(key);
  return Boolean(run) && run.status !== 'launch failed';
}

function fixAllButton(key, sha, threads, inMenu) {
  const id = 'fix:' + key;
  const what = (swept(key) ? 'Re-sweep ' : 'Fix ') + fixWhat(threads.length);
  const run = () => { ui.menu = null; sendFix(key, sha, threads, null); };
  const node = guarded(id, what + ' with an agent', 'wrench', what + ' on ' + refNumber(key) + ' with an agent' + '?', run, !inMenu);
  if (inMenu) node.setAttribute('role', 'menuitem');
  return node;
}

function fixButton(ctx) {
  const r = ctx.row;
  if (!r?.flags.mine || !ctx.detail || !ctx.d.m.me) return null;
  if (fixAlive(ctx.key)) return el('div', { class: 'foot fix' }, fixChip(ctx.key), el('span', { class: 'meta' }, 'Answer it in the Agent tab. Nothing reaches GitLab until you say yes there.'));
  if (branchChanging(ctx.key)) return el('div', { class: 'foot fix' }, el('span', { class: 'meta' }, 'An agent can start once GitLab has finished changing ' + refNumber(r) + '.'));
  const people = peopleThreads(ctx.detail.discussions);
  const fixable = threadsToFix(ctx.detail.discussions, ctx.detail.me);
  const bots = openThreads(ctx.detail.discussions).length - people.length;
  const waiting = people.length - fixable.length;
  const left = [
    waiting ? el('span', { class: 'meta' }, plural(waiting, 'thread') + ' you answered last ' + (waiting === 1 ? 'waits' : 'wait') + ' on the reviewer.') : null,
    bots ? el('span', { class: 'meta' }, plural(bots, 'open bot thread') + ' left out. Each has its own button.') : null,
  ].filter(Boolean);
  if (!fixable.length) return left.length ? el('div', { class: 'foot fix' }, left) : null;
  return el('div', { class: 'foot fix' }, fixAllButton(ctx.key, ctx.detail.mr.sha, fixable), left);
}

function fixThreadButton(key, t) {
  const r = state.matrix.inbox?.rows.find((row) => row.key === key);
  if (!r?.flags.mine || !t.resolvable || t.resolved || fixAlive(key) || branchChanging(key)) return null;
  const id = 'fix-one:' + t.id;
  const sha = ui.mr?.key === key && ui.mr.detail ? ui.mr.detail.mr.sha : r.sha;
  return guarded(id, 'Fix this with an agent', 'wrench', 'Fix 1 comment on ' + refNumber(r) + ' with an agent' + '?', () => sendFix(key, sha, [t], t.id));
}

// The list counts every open thread, bots' too, so the menu reads the threads before it offers a number.
function fixMenuItem(r) {
  if (!r.flags.mine || !r.unresolved) return null;
  if (fixAlive(r.key)) return mrMenuItem('fix-agent:' + r.key, 'Show the fix agent', 'terminal', () => slot('openMr', r.key, 'agent'));
  if (branchChanging(r.key)) return null;
  const read = slot('threadRead', r.key, true);
  if (!read?.detail) return el('button', { role: 'menuitem', disabled: true }, icon('clock'), read?.error ? 'Could not read the threads' : 'Reading the threads…');
  const fixable = threadsToFix(read.detail.discussions, read.detail.me);
  return fixable.length ? fixAllButton(r.key, read.detail.mr.sha, fixable, true) : null;
}

function fixAgentPanel(ctx) {
  const run = fixRunOf(ctx.key);
  if (!run) return null;
  const agent = fixAgentOf(run);
  const head = el('div', { class: 'row-head' },
    el('span', { class: 'pill ' + (agent ? agentClass(agent) : 's-quiet') }, icon('wrench'), 'fix agent ' + (agent ? slot('agentLabel', agent) ?? agent.state : fixRunWord(run))),
    el('span', { class: 'meta' }, 'started ' + ago(run.startedAt)),
    run.worktreePath ? el('span', { class: 'meta' }, run.worktreePath.replace(/^\/Users\/[^/]+/, '~')) : null);
  if (agent) return el('div', { class: 'fix-run' }, head, slot('agentRow', agent, { pinned: true }));
  return el('div', { class: 'fix-run' }, head,
    el('p', { class: 'meta' }, fixGone(run)),
    run.tail.length && run.status !== 'launch failed' ? el('details', {}, el('summary', {}, 'Last output'), el('pre', {}, run.tail.join('\n'))) : null);
}

function fixRunWord(run) {
  if (run.status === 'launch failed') return 'did not start';
  return run.terminal ? 'closed' : 'starting';
}

function fixGone(run) {
  if (run.status === 'launch failed') return 'It did not start: ' + (run.tail[0] ?? 'no reason was given');
  return run.terminal ? 'It has been removed, so there is nothing to answer.' : 'It has not started yet.';
}
