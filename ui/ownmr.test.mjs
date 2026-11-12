import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openPage } from './testkit.mjs';

const KEY = 'acme/engine!88';
const THEIRS = 'acme/engine!7';
const AT = '2026-11-05T12:00:00Z';
const SHA = 'aaa111';

function row(extra = {}) {
  return {
    key: KEY, iid: 88, repo: 'engine', title: 'Make the engine faster', webUrl: 'https://gitlab.com/acme/engine/-/merge_requests/88', author: 'frank', reviewers: ['ivan', 'ed'],
    approvedBy: ['ed'], draft: false, pipeline: 'SUCCESS', ticket: 'ABC-1', updatedAt: AT, unresolved: 3, threads: null, mergeStatus: 'MERGEABLE', sourceBranch: 'feat/88',
    sha: SHA, agentHandle: null, watch: null, flags: { mine: true }, phase: 'open', count: 0, mood: 'quiet', verdict: null, agent: null, level: null, ...extra,
  };
}

function theirs() {
  return row({ key: THEIRS, iid: 7, author: 'ivan', reviewers: ['frank'], approvedBy: [], flags: { waitingOnYou: true }, mood: 'awaitingYou' });
}

const note = (author, body) => ({ author, body, createdAt: AT, system: false });
const thread = (id, extra = {}) => ({ id, resolved: false, resolvable: true, path: null, line: null, notes: [note('ivan', 'Change ' + id)], awaitsYou: false, bot: false, handedBack: false, queuedReply: null, ...extra });
const DISCUSSIONS = [
  thread('d-1', { notes: [note('ivan', 'Rename this'), note('frank', 'Which way?'), note('ivan', 'load_rows')] }),
  thread('d-2', { notes: [note('rupert', 'NAB: cache it')], path: 'src/app.py', line: 4 }),
  thread('d-bot', { notes: [note('acme-review-bot', 'Summary of the change')], bot: true }),
  thread('d-done', { resolved: true }),
];

function detail(r, discussions = DISCUSSIONS) {
  return {
    key: r.key, me: 'frank', fetchedAt: AT,
    mr: { iid: r.iid, repo: r.repo, title: r.title, webUrl: r.webUrl, author: r.author, reviewers: r.reviewers, approvedBy: r.approvedBy, draft: r.draft, conflicts: false, pipeline: r.pipeline, mergeStatus: r.mergeStatus, sourceBranch: r.sourceBranch, sha: r.sha, ticket: r.ticket, createdAt: AT, updatedAt: AT, unresolved: 3 },
    discussions, jobs: [], merge: { status: 'mergeable', words: 'ready to merge', tone: 'ready' },
    detail: { description: '', clipped: false, targetBranch: 'main', changes: '2', notes: 4 }, files: { complete: true, list: [] }, missing: {}, settled: [],
  };
}

const MERGEABLE = { merge: { status: 'mergeable', words: 'ready to merge', tone: 'ready', can: 'now' }, target: 'main', behind: 0, rebase: null };

const FIX = 'claude:00000088-0000-4000-8000-000000000000';
const PUSH = 'Push 2 commits to feat/88 and post 2 replies on !88? (yes/no)';

function agent(state = 'done') {
  return {
    handle: FIX, name: 'fix-Engine-88', title: 'fix !88', kind: 'fix', mr: KEY, ticket: null, worktree: '/work/fix-Engine-88', cwd: '/work',
    state, since: 1009, lastAt: Date.parse(AT), alive: state !== 'done', said: state === 'done' ? PUSH : '', outcome: state === 'done' ? 'success' : null, ask: null,
  };
}

const fixRun = (extra = {}) => ({ key: 'fix:' + KEY, webUrl: row().webUrl, startedAt: AT, status: 'running', worktreePath: '/work/fix-Engine-88', tail: [], terminal: FIX, ...extra });

function snapshot({ rows = [row(), theirs()], runs = [], agents = [] } = {}) {
  return {
    generatedAt: AT,
    version: { ui: 1, lib: 1, worker: 1, loaded: 1 },
    agents,
    artifacts: [],
    matrix: {
      available: true, running: false, me: 'frank', paused: false, holdSeconds: null, holdWhileReviewing: false,
      inbox: { fetchedAt: AT, loading: false, error: null, repoCount: 1, rows },
      fullAuto: [], roster: [{ username: 'rupert' }, { username: 'ivan' }, { username: 'trent' }], watches: [], verdicts: {}, queue: [], runs, autoPasses: [],
    },
  };
}

async function page({ snap = snapshot(), facts = { [KEY]: MERGEABLE }, discussions = DISCUSSIONS, hash = 'merge-requests' } = {}) {
  const posts = [];
  const p = await openPage({
    respond(path, init) {
      if (init?.method === 'POST') {
        posts.push([path, JSON.parse(init.body)]);
        return { ok: true, text: 'Done' };
      }
      const url = new URL(path, 'http://page');
      if (url.pathname === '/api/matrix/own-mrs') return { mrs: p.facts };
      if (url.pathname === '/api/matrix/mr') return detail(snap.matrix.inbox.rows.find((r) => r.key === url.searchParams.get('key')), discussions);
      if (url.pathname === '/api/matrix/decide') return { tidies: false, mrs: {} };
      if (url.pathname === '/api/agents/conversation') return { ...agent(), pending: null, entries: [{ kind: 'said', at: 1, text: PUSH }] };
      return null;
    },
  });
  p.facts = facts;
  p.show(snap, hash);
  await p.settle(60);
  return Object.assign(p, { posts });
}

const buttons = (p, where = '#main') => p.$$(where + ' button');
const named = (p, label, where = '#main') => buttons(p, where).find((b) => b.textContent === label) ?? null;
const ownRow = (p) => p.$$('#main .mr').find((m) => m.querySelector('.ref')?.dataset.key === KEY);
const theirRow = (p) => p.$$('#main .mr').find((m) => m.querySelector('.ref')?.dataset.key === THEIRS);

async function twoClicks(p, label, confirm, where = '#main') {
  const first = named(p, label, where);
  assert.ok(first, `${label} is offered`);
  first.click();
  const armed = p.$$(where + ' button.armed')[0];
  assert.equal(armed?.textContent, confirm);
  assert.deepEqual(p.posts, [], 'the first click sends nothing');
  armed.click();
  await p.settle(30);
}

async function inDrawer(p, tab) {
  p.run(`openMr('${KEY}', '${tab}')`);
  await p.settle(60);
}

test('your own mergeable MR offers Merge into its target, and sends the head it showed after two clicks', async () => {
  const p = await page();
  await twoClicks(p, 'Merge', 'Merge !88 into main?');
  assert.deepEqual(p.posts, [['/api/matrix/merge', { key: KEY, expect: { sha: SHA, can: 'now', target: 'main' } }]]);
  assert.deepEqual(p.errors, []);
});

test('while the pipeline runs it offers Merge when green, and a blocked MR says why in words with no merge button', async () => {
  const p = await page({ facts: { [KEY]: { ...MERGEABLE, merge: { status: 'ci_still_running', words: 'waiting for the pipeline', tone: 'waiting', can: 'green' } } } });
  await twoClicks(p, 'Merge when green', 'Merge !88 into main once the pipeline passes?');
  assert.deepEqual(p.posts, [['/api/matrix/merge', { key: KEY, expect: { sha: SHA, can: 'green', target: 'main' } }]]);
  const blocked = await page({ facts: { [KEY]: { merge: { status: 'not_approved', words: 'needs approval', tone: 'blocked', can: null }, target: null, rebase: null } } });
  assert.equal(ownRow(blocked).querySelector('.merge-why')?.textContent, 'needs approval');
  assert.equal(named(blocked, 'Merge')?.textContent ?? null, null);
  assert.equal(named(blocked, 'Merge when green')?.textContent ?? null, null);
});

test("someone else's MR offers none of your own-MR actions", async () => {
  const p = await page({ snap: snapshot({ rows: [row({ draft: true, mergeStatus: 'NEED_REBASE' }), theirs()] }), facts: { [KEY]: MERGEABLE, [THEIRS]: MERGEABLE } });
  const labels = theirRow(p).querySelectorAll('button').map((b) => b.textContent);
  for (const label of ['Merge', 'Rebase', 'Mark ready', 'Merge when green']) assert.ok(!labels.includes(label), label);
  assert.ok(ownRow(p).querySelectorAll('button').some((b) => b.textContent === 'Rebase'));
});

const BLOCKED = (status, words, extra = {}) => ({ merge: { status, words, tone: 'blocked', can: null }, target: 'main', behind: 0, rebase: null, ...extra });

test('a branch GitLab wants rebased offers Rebase, shows Rebasing… while GitLab works, and says why one failed', async () => {
  const behind = BLOCKED('need_rebase', 'needs rebase', { target: null });
  const p = await page({ snap: snapshot({ rows: [row({ mergeStatus: 'NEED_REBASE' })] }), facts: { [KEY]: behind } });
  await twoClicks(p, 'Rebase', 'Rebase !88 on GitLab?');
  assert.deepEqual(p.posts, [['/api/matrix/rebase', { key: KEY, expect: { sha: SHA } }]]);
  const running = await page({ snap: snapshot({ rows: [row({ mergeStatus: 'NEED_REBASE' })] }), facts: { [KEY]: { ...behind, rebase: { state: 'running', since: 1, error: null } } } });
  assert.equal(named(running, 'Rebase')?.textContent ?? null, null);
  assert.equal(named(running, 'Rebasing…')?.disabled, true);
  const failed = await page({ snap: snapshot({ rows: [row({ mergeStatus: 'NEED_REBASE' })] }), facts: { [KEY]: { ...behind, rebase: { state: 'failed', since: 1, error: 'Rebase failed: resolve the conflicts locally' } } } });
  const pill = ownRow(failed).querySelectorAll('.pill').find((n) => n.textContent === 'rebase failed');
  assert.equal(pill?.getAttribute('title'), 'Rebase failed: resolve the conflicts locally');
  assert.ok(named(failed, 'Rebase'), 'and it can be tried again');
});

test('a branch behind its target offers Rebase whatever check GitLab names first, and says how far behind it is', async () => {
  const changes = await page({ snap: snapshot({ rows: [row({ mergeStatus: 'REQUESTED_CHANGES' })] }), facts: { [KEY]: BLOCKED('requested_changes', 'blocked: changes requested', { behind: 54 }) } });
  await twoClicks(changes, 'Rebase', 'Rebase !88 onto main, 54 commits behind?');
  assert.deepEqual(changes.posts, [['/api/matrix/rebase', { key: KEY, expect: { sha: SHA } }]]);
  const draft = await page({ snap: snapshot({ rows: [row({ draft: true, mergeStatus: 'DRAFT_STATUS' })] }), facts: { [KEY]: BLOCKED('draft_status', 'blocked: still a draft', { behind: 6 }) } });
  assert.ok(named(draft, 'Mark ready') && named(draft, 'Rebase'));
  const level = await page({ snap: snapshot({ rows: [row({ mergeStatus: 'REQUESTED_CHANGES' })] }), facts: { [KEY]: BLOCKED('requested_changes', 'blocked: changes requested') } });
  assert.equal(named(level, 'Rebase')?.textContent ?? null, null, 'a branch level with its target has nothing to rebase');
});

test('a conflicting branch offers no rebase GitLab would refuse, and hands the conflicts to an agent instead', async () => {
  const p = await page({ snap: snapshot({ rows: [row({ mergeStatus: 'REQUESTED_CHANGES', flags: { mine: true, conflict: true } })] }), facts: { [KEY]: BLOCKED('requested_changes', 'blocked: changes requested', { behind: 12 }) } });
  assert.equal(named(p, 'Rebase')?.textContent ?? null, null);
  await twoClicks(p, 'Fix conflicts with an agent', 'Fix the conflicts on !88 with an agent?');
  assert.deepEqual(p.posts, [['/api/matrix/fix', { key: KEY, conflicts: true, expect: { sha: SHA } }]]);
});

test('the merge confirm names the branch GitLab targets now, and sends it so the worker can check it', async () => {
  const p = await page({ facts: { [KEY]: { ...MERGEABLE, target: 'feat/base' } } });
  await twoClicks(p, 'Merge', 'Merge !88 into feat/base?');
  assert.deepEqual(p.posts, [['/api/matrix/merge', { key: KEY, expect: { sha: SHA, can: 'now', target: 'feat/base' } }]]);
  const unknown = await page({ facts: { [KEY]: { ...MERGEABLE, target: null } } });
  assert.equal(named(unknown, 'Merge')?.textContent ?? null, null, 'no merge is offered into a branch the page could not name');
});

test('a draft offers Mark ready, guarded and naming the MR', async () => {
  const p = await page({ snap: snapshot({ rows: [row({ draft: true, mergeStatus: 'DRAFT_STATUS' })] }), facts: { [KEY]: { merge: { status: 'draft_status', words: 'blocked: still a draft', tone: 'blocked', can: null }, target: null, rebase: null } } });
  await twoClicks(p, 'Mark ready', 'Mark !88 ready for review?');
  assert.deepEqual(p.posts, [['/api/matrix/ready', { key: KEY, expect: { sha: SHA } }]]);
});

test('reviewers are picked from the roster in the drawer and saved in two clicks naming the new list', async () => {
  const p = await page();
  await inDrawer(p, 'overview');
  const picker = p.$('#drawer .reviewers');
  assert.ok(picker, 'the picker shows on your own MR');
  const add = p.$('#drawer #reviewer-add');
  assert.deepEqual(add.querySelectorAll('option').map((o) => o.textContent), ['Add a reviewer…', 'rupert', 'trent'], 'only people not already on it');
  add.value = 'rupert';
  p.fire(add, 'change');
  await twoClicks(p, 'Save reviewers', 'Set the reviewers of !88 to ivan, ed, rupert?', '#drawer');
  assert.deepEqual(p.posts, [['/api/matrix/reviewers', { key: KEY, reviewers: ['ivan', 'ed', 'rupert'], expect: { sha: SHA, reviewers: ['ivan', 'ed'] } }]]);
});

test('a change after Save is armed disarms it, and Undo puts the list back', async () => {
  const p = await page();
  await inDrawer(p, 'overview');
  const add = p.$('#drawer #reviewer-add');
  add.value = 'rupert';
  p.fire(add, 'change');
  named(p, 'Save reviewers', '#drawer').click();
  assert.ok(p.$('#drawer button.armed'));
  p.$$('#drawer .reviewer button').find((b) => b.getAttribute('aria-label') === 'Remove ivan').click();
  assert.equal(p.$('#drawer button.armed')?.textContent ?? null, null);
  assert.deepEqual(p.$$('#drawer .reviewer').map((n) => n.textContent), ['ed', 'rupert']);
  named(p, 'Undo', '#drawer').click();
  assert.deepEqual(p.$$('#drawer .reviewer').map((n) => n.textContent), ['ivan', 'ed']);
  assert.equal(named(p, 'Save reviewers', '#drawer')?.textContent ?? null, null);
});

test('Re-request review asks again of the reviewers who have not approved', async () => {
  const p = await page();
  await inDrawer(p, 'overview');
  await twoClicks(p, 'Re-request review', 'Ask ivan to review !88 again?', '#drawer');
  assert.deepEqual(p.posts, [['/api/matrix/rerequest', { key: KEY, reviewers: ['ivan'], expect: { sha: SHA } }]]);
});

test('the Threads tab counts the open threads people started, lists bot threads apart, and fixes the count it showed', async () => {
  const p = await page();
  await inDrawer(p, 'threads');
  assert.match(p.$('#drawer .foot.fix').textContent, /1 open bot thread left out/);
  assert.match(p.$('#drawer .thread-group').textContent, /From bots \(1\)/);
  assert.equal(p.$$('#drawer .list.bots .thread').length, 1);
  assert.match(p.$('#drawer .list.bots').textContent, /Summary of the change/);
  await twoClicks(p, 'Fix 2 comments with an agent', 'Fix 2 comments on !88 with an agent?', '#drawer');
  assert.deepEqual(p.posts, [['/api/matrix/fix', { key: KEY, expect: { sha: SHA, threads: { 'd-1': 3, 'd-2': 1 } } }]]);
});

test('a thread you answered last is left to its reviewer, and the count and payload leave it out', async () => {
  const answered = thread('d-3', { notes: [note('ed', 'Why a set?'), note('frank', 'Order does not matter here')] });
  const p = await page({ discussions: [...DISCUSSIONS, answered] });
  await inDrawer(p, 'threads');
  assert.match(p.$('#drawer .foot.fix').textContent, /1 thread you answered last waits on the reviewer\./);
  await twoClicks(p, 'Fix 2 comments with an agent', 'Fix 2 comments on !88 with an agent?', '#drawer');
  assert.deepEqual(p.posts, [['/api/matrix/fix', { key: KEY, expect: { sha: SHA, threads: { 'd-1': 3, 'd-2': 1 } } }]]);
});

test('after a fix agent has been and gone the button is a re-sweep of what is waiting on you now', async () => {
  const p = await page({ snap: snapshot({ runs: [fixRun({ tail: ['Pushed 2 commits'] })] }) });
  await inDrawer(p, 'threads');
  await twoClicks(p, 'Re-sweep 2 comments with an agent', 'Re-sweep 2 comments on !88 with an agent?', '#drawer');
  assert.equal(p.posts.length, 1);
  const failed = await page({ snap: snapshot({ runs: [fixRun({ status: 'launch failed', terminal: null, tail: ['No checkout'] })] }) });
  await inDrawer(failed, 'threads');
  assert.ok(named(failed, 'Fix 2 comments with an agent', '#drawer'), 'a fix that never started has swept nothing');
});

test('a single thread, a bot\'s too, can be given to an agent on its own', async () => {
  const p = await page();
  await inDrawer(p, 'threads');
  const card = p.$$('#drawer .list.bots .thread')[0];
  card.querySelectorAll('button').find((b) => b.textContent === 'Fix this with an agent').click();
  assert.equal(p.$('#drawer button.armed')?.textContent, 'Fix 1 comment on !88 with an agent?');
  p.$('#drawer button.armed').click();
  await p.settle(30);
  assert.deepEqual(p.posts, [['/api/matrix/fix', { key: KEY, discussionId: 'd-bot', expect: { sha: SHA, threads: { 'd-bot': 1 } } }]]);
  p.$('#drawer #thread-chip-all').click();
  const resolved = p.$$('#drawer .thread').find((t) => /Change d-done/.test(t.textContent));
  assert.ok(resolved, 'the resolved thread shows under All');
  assert.equal(resolved.querySelectorAll('button').some((b) => b.textContent === 'Fix this with an agent'), false, 'and offers no fix');
});

test('the row menu reads the threads, then offers the same count as the Threads tab', async () => {
  const p = await page();
  ownRow(p).querySelector('.menu-wrap button').click();
  await p.settle(60);
  const item = p.$$('#main .menu button').find((b) => b.textContent === 'Fix 2 comments with an agent');
  assert.ok(item, 'the menu offers the fix');
  assert.equal(item.getAttribute('role'), 'menuitem');
  item.click();
  const armed = p.$('#main .menu button.armed');
  assert.equal(armed?.textContent, 'Fix 2 comments on !88 with an agent?');
  armed.click();
  await p.settle(30);
  assert.deepEqual(p.posts, [['/api/matrix/fix', { key: KEY, expect: { sha: SHA, threads: { 'd-1': 3, 'd-2': 1 } } }]]);
});

test('no fix is offered on someone else\'s MR', async () => {
  const p = await page();
  p.run(`openMr('${THEIRS}', 'threads')`);
  await p.settle(60);
  assert.equal(p.$('#drawer .foot.fix')?.textContent ?? null, null);
  assert.ok(!buttons(p, '#drawer').some((b) => /with an agent/.test(b.textContent)));
  theirRow(p).querySelector('.menu-wrap button').click();
  await p.settle(60);
  assert.ok(!p.$$('#main .menu button').some((b) => /with an agent/.test(b.textContent)));
});

test('while a fix agent is open the triggers give way to it, and its Agent tab is its console', async () => {
  const p = await page({ snap: snapshot({ runs: [fixRun()], agents: [agent('done')] }) });
  const chip = ownRow(p).querySelectorAll('button').find((b) => /^fix agent/.test(b.textContent));
  assert.equal(chip?.textContent, 'fix agent asks you');
  assert.match(chip.className, /s-need/);
  await inDrawer(p, 'threads');
  assert.ok(!buttons(p, '#drawer').some((b) => /with an agent/.test(b.textContent)));
  assert.match(p.$('#drawer .foot.fix').textContent, /Nothing reaches GitLab until you say yes there/);
  await inDrawer(p, 'agent');
  assert.match(p.$('#drawer .fix-run').textContent, /fix agent asks you/);
  assert.equal(p.$('#drawer .fix-run .agent .pill')?.textContent, 'asks you');
  assert.match(p.$('#drawer .fix-run').textContent, /~?\/work\/fix-Engine-88/);
  assert.match(p.$('#drawer .chat').textContent, /Push 2 commits to feat\/88 and post 2 replies on !88\? \(yes\/no\)/);
  const box = p.document.getElementById('agent-reply-' + FIX);
  box.value = 'yes';
  p.fire(box, 'input');
  await twoClicks(p, 'Send', 'Send “yes” to fix-Engine-88?', '#drawer');
  assert.deepEqual(p.posts.map(([path, body]) => [path, body.handle, body.text]), [['/api/matrix/agent-reply', FIX, 'yes']]);
});

test('the menu says where the fix agent is instead of starting another', async () => {
  const p = await page({ snap: snapshot({ runs: [fixRun()], agents: [agent('working')] }) });
  ownRow(p).querySelector('.menu-wrap button').click();
  await p.settle(30);
  p.$$('#main .menu button').find((b) => b.textContent === 'Show the fix agent').click();
  await p.settle(60);
  assert.equal(p.run('ui.mr.tab'), 'agent');
});

test('a fix run whose agent has gone, or that failed to start, says so and lets another start', async () => {
  const gone = await page({ snap: snapshot({ runs: [fixRun({ tail: ['Pushed 2 commits'] })] }) });
  await inDrawer(gone, 'agent');
  assert.equal(gone.$('#drawer .fix-run .pill').textContent, 'fix agent closed');
  assert.match(gone.$('#drawer .fix-run').textContent, /It has been removed/);
  assert.match(gone.$('#drawer .fix-run details').textContent, /Pushed 2 commits/);
  await inDrawer(gone, 'threads');
  assert.ok(named(gone, 'Re-sweep 2 comments with an agent', '#drawer'));
  const failed = await page({ snap: snapshot({ runs: [fixRun({ status: 'launch failed', terminal: null, tail: ['No checkout of Engine at /work/engine'] })] }) });
  await inDrawer(failed, 'agent');
  assert.equal(failed.$('#drawer .fix-run .pill').textContent, 'fix agent did not start');
  assert.match(failed.$('#drawer .fix-run').textContent, /It did not start: No checkout of Engine at \/work\/engine/);
});

test('a fix agent whose turn ended on its question shows on its MR\'s card, and opens in place', async () => {
  const snap = snapshot({ runs: [fixRun()], agents: [agent('done')] });
  const reason = { kind: 'fix-asks', why: 'the fix agent asks before it pushes', tier: 'interrupt', tab: 'agent', next: 'answer', handle: agent('done').handle };
  snap.attention = { cards: [{ key: KEY, group: 'mine', title: 'Make the engine faster', iid: 88, repo: 'engine', reasons: [reason], top: reason, since: new Date().toISOString(), interrupt: true, muted: null }], agents: [], system: [], count: 1, prefs: {}, toasts: [], offers: [] };
  const needs = await page({ snap, hash: 'needs-you' });
  const card = needs.$('#main .need-card');
  assert.match(card.querySelector('.row-head').textContent, /fix agent asks/);
  card.querySelectorAll('button').find((b) => b.textContent === 'Show here').click();
  const listed = needs.$$('#main .need-card .agent');
  assert.equal(listed.length, 1);
  assert.equal(listed[0].querySelector('.pill')?.textContent, 'asks you');
  const agents = await page({ snap, hash: 'agents' });
  assert.equal(agents.$$('#main .agent').length, 1, 'the Agents view shows it among the active ones, not the finished');
});

test('while a fix is being started every other way to start one on that MR gives way, so one click makes one agent', async () => {
  const p = await page();
  await inDrawer(p, 'threads');
  const card = p.$$('#drawer .thread').find((t) => /Rename this/.test(t.textContent));
  card.querySelectorAll('button').find((b) => b.textContent === 'Fix this with an agent').click();
  p.$('#drawer button.armed').click();
  assert.equal(p.posts.length, 1);
  assert.ok(!buttons(p, '#drawer').some((b) => /with an agent/.test(b.textContent)), 'no other fix is offered while the first is on its way');
  assert.ok(ownRow(p).querySelectorAll('button').some((b) => b.textContent === 'fix agent starting'));
  assert.equal(named(p, 'Merge')?.textContent ?? null, null);
  await p.settle(30);
});

test('a rebase or a merge waits while a fix agent is open, and no fix starts while GitLab rebases', async () => {
  const fixing = await page({ snap: snapshot({ rows: [row({ mergeStatus: 'MERGEABLE' })], runs: [fixRun()], agents: [agent('working')] }), facts: { [KEY]: { ...MERGEABLE, behind: 3 } } });
  for (const label of ['Merge', 'Rebase', 'Merge when green']) assert.equal(named(fixing, label)?.textContent ?? null, null, label);
  await inDrawer(fixing, 'overview');
  for (const label of ['Merge', 'Rebase']) assert.equal(named(fixing, label, '#drawer')?.textContent ?? null, null, label);
  const rebasing = await page({ facts: { [KEY]: { ...MERGEABLE, behind: 3, rebase: { state: 'running', since: 1, error: null } } } });
  assert.equal(named(rebasing, 'Merge')?.textContent ?? null, null);
  await inDrawer(rebasing, 'threads');
  assert.ok(!buttons(rebasing, '#drawer').some((b) => /with an agent/.test(b.textContent)));
  assert.match(rebasing.$('#drawer .foot.fix').textContent, /once GitLab has finished changing !88/);
  ownRow(rebasing).querySelector('.menu-wrap button').click();
  await rebasing.settle(60);
  assert.ok(!rebasing.$$('#main .menu button').some((b) => /with an agent/.test(b.textContent)));
});
