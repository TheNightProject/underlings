import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collect } from './attention.mjs';
import { mergeChoice } from './ownmr.mjs';
import { mr } from './testkit.mjs';

const NOW = Date.parse('2026-11-06T12:00:00Z');
const MIN = 60_000;
const ago = (m) => new Date(NOW - m * MIN).toISOString();
const KEY = 'acme/engine!1121';
const OWN = 'acme/portal!88';

function input(over = {}) {
  return {
    now: NOW, me: 'frank', mrs: [], queue: [], memory: {}, runs: {}, state: { watches: {}, verdicts: {}, reviewHolds: {} },
    rules: { people: [], onRequest: null, optedOut: new Set() }, threads: new Map(), todos: [], agents: [], driver: { state: 'here', why: '' },
    fetchError: null, fetchedAt: ago(1), pollMs: 90_000, waiting: null, driverTurns: 0, mergeChoice,
    engine: {
      levelForMr: (m, me, rules) => rules.people.find((p) => p.username === m.author)?.level ?? (rules.onRequest && m.reviewers.includes(me) && !m.draft ? rules.onRequest : null),
      isRepeat: () => false,
      findingPrint: (c) => `${c.position?.new_path ?? ''}|${String(c.body).toLowerCase()}`,
      changeSince: (watch, m) => ({ headMoved: watch.seen.sha !== m.sha, resolved: Math.max(0, (watch.seen.unresolved ?? 0) - m.unresolvedThreads), notes: 0, approvals: 0, pipeline: null }),
      heldByMe: (m, me) => (m.reviewStates?.[me] ?? (m.mergeStatus === 'REQUESTED_CHANGES' ? 'REQUESTED_CHANGES' : '')) === 'REQUESTED_CHANGES',
      changesRequestedBy: (m) => Object.entries(m.reviewStates ?? {}).filter(([, s]) => s === 'REQUESTED_CHANGES').map(([n]) => n),
    },
    ...over,
  };
}

const theirs = (extra = {}) => mr('acme/engine', 1121, { author: 'judy', updatedAt: ago(30), ...extra });
const mine = (extra = {}) => mr('acme/portal', 88, { author: 'frank', reviewers: ['judy'], updatedAt: ago(30), ...extra });
const finding = (id, extra = {}) => ({ id, status: 'pending', projectPath: 'acme/engine', iid: 1121, severity: 'MINOR', body: `finding ${id}`, createdAt: ago(20), createdBy: 'agent', ...extra });
const entry = (id, extra = {}) => ({ id, resolvable: true, resolved: false, openedBy: 'frank', mine: true, lastNoteId: 2, lastAt: ago(10), lastAuthor: 'judy', fromPerson: true, ...extra });
const kinds = (out) => out.items.map((i) => i.kind);
const only = (out, kind) => out.items.filter((i) => i.kind === kind);

test('1, a review asked of you: Overview, Review, an interrupt; not for a draft or an MR full auto reviews', () => {
  const [asked] = only(collect(input({ mrs: [theirs()] })), 'asked');
  assert.deepEqual([asked.tier, asked.tab, asked.next, asked.why], ['interrupt', 'overview', 'review', 'asks for your review']);
  assert.deepEqual(only(collect(input({ mrs: [theirs({ draft: true })] })), 'asked'), []);
  assert.deepEqual(only(collect(input({ mrs: [theirs()], rules: { people: [], onRequest: 'shadow', optedOut: new Set() } })), 'asked'), []);
});

test('3, findings to post: Findings, Post all, worded with the big ones; full auto\'s own and shadow items never read as to approve', () => {
  const queue = [finding('a', { severity: 'MAJOR' }), finding('b'), finding('c', { auto: { pass: 'p', level: 'comments', sendAt: ago(-1) } }), finding('d', { auto: { pass: 'p', level: 'shadow' } })];
  const [f] = only(collect(input({ mrs: [theirs()], queue })), 'findings');
  assert.deepEqual([f.tier, f.tab, f.next, f.why, f.count], ['interrupt', 'findings', 'post-all', '2 to post, 1 MAJOR', 2]);
});

test('3, findings wait to settle while their run works, for ten minutes after the last landed', () => {
  const runs = { [KEY]: { key: KEY, status: 'working', startedAt: ago(30) } };
  assert.equal(only(collect(input({ mrs: [theirs()], queue: [finding('a', { createdAt: ago(2) })], runs })), 'findings')[0].settled, false);
  assert.equal(only(collect(input({ mrs: [theirs()], queue: [finding('a', { createdAt: ago(11) })], runs })), 'findings')[0].settled, true);
});

test('4, a re-review that answered your threads says fixed, not fixed and new', () => {
  const queue = [finding('a', { kind: 'reply', replyTo: 'd1', outcome: 'fixed' }), finding('b', { kind: 'reply', replyTo: 'd2', outcome: 'not-fixed' }), finding('c', { severity: 'MINOR' })];
  assert.equal(only(collect(input({ mrs: [theirs()], queue })), 'findings')[0].why, '1 fixed, 1 not fixed, 1 new MINOR');
});

test('5, a shadow pass result: Findings, decide, with what it would do', () => {
  const memory = { [KEY]: { key: KEY, pass: { id: 'p1', settled: 'finished', doneAt: ago(5), launchedAt: ago(20) } } };
  const queue = [finding('a', { auto: { pass: 'p1', level: 'shadow' } }), finding('v', { kind: 'verdict', verdict: 'approve', auto: { pass: 'p1', level: 'shadow' } })];
  const [s] = only(collect(input({ mrs: [theirs()], queue, memory })), 'shadow');
  assert.deepEqual([s.tier, s.tab, s.next, s.why], ['interrupt', 'findings', 'decide', 'shadow review would approve, 1 to post']);
  assert.deepEqual(only(collect(input({ mrs: [theirs()], queue })), 'findings'), [], 'and shadow items never read as to post');
});

test('6, held back for you: an interrupt for a held verdict or MAJOR, a badge for a NIT, nothing for housekeeping', () => {
  const held = (id, severity, why, extra = {}) => finding(id, { severity, auto: { pass: 'p', level: 'comments', held: why }, ...extra });
  assert.equal(only(collect(input({ mrs: [theirs()], queue: [held('a', 'MAJOR', 'over the cap of 8 comments for one pass')] })), 'held')[0].tier, 'interrupt');
  assert.equal(only(collect(input({ mrs: [theirs()], queue: [held('a', 'NIT', 'over the cap of 8 comments for one pass')] })), 'held')[0].tier, 'badge');
  const verdict = only(collect(input({ mrs: [theirs()], queue: [held('v', 'MINOR', 'the pipeline failed', { kind: 'verdict', verdict: 'approve' })] })), 'held')[0];
  assert.deepEqual([verdict.next, verdict.why], ['decide', 'full auto would approve, but the pipeline failed']);
  assert.deepEqual(only(collect(input({ mrs: [theirs()], queue: [held('a', 'MAJOR', 'a newer pass has replaced it')] })), 'held'), []);
});

test('7, a handed-back thread you have answered leaves the list', () => {
  const memory = { [KEY]: { key: KEY, handedBack: ['d1'] } };
  const waiting = input({ mrs: [theirs()], memory, threads: new Map([[KEY, { threads: [entry('d1')] }]]) });
  const [h] = only(collect(waiting), 'handed');
  assert.deepEqual([h.tier, h.tab, h.next], ['interrupt', 'threads', 'reply']);
  const answered = input({ mrs: [theirs()], memory, threads: new Map([[KEY, { threads: [entry('d1', { lastAuthor: 'frank', fromPerson: false })] }]]) });
  assert.deepEqual(only(collect(answered), 'handed'), []);
});

test('8, someone replied to you: Threads, Reply, named; not a bot, not yet settled within a poll', () => {
  const threads = new Map([[KEY, { threads: [entry('d1'), entry('d2', { lastNoteId: 9 })] }]]);
  const [r] = only(collect(input({ mrs: [theirs()], threads })), 'replied');
  assert.deepEqual([r.tier, r.tab, r.next, r.why, r.settled], ['interrupt', 'threads', 'reply', 'judy replied on 2 threads', true]);
  assert.match(r.id, /d1@2,d2@9$/);
  const bot = new Map([[KEY, { threads: [entry('d1', { fromPerson: false, lastAuthor: 'gitlab-bot' })] }]]);
  assert.deepEqual(only(collect(input({ mrs: [theirs()], threads: bot })), 'replied'), []);
  const fresh = new Map([[KEY, { threads: [entry('d1', { lastAt: ago(0.5) })] }]]);
  assert.equal(only(collect(input({ mrs: [theirs()], threads: fresh })), 'replied')[0].settled, false);
});

test('8, a reply on an author at Comments waits for full auto, and shows once its pass settles without replying', () => {
  const rules = { people: [{ username: 'judy', level: 'comments' }], onRequest: null, optedOut: new Set() };
  const threads = new Map([[KEY, { threads: [entry('d1')] }]]);
  const running = { [KEY]: { key: KEY, pass: { id: 'p', launchedAt: ago(5) } } };
  assert.deepEqual(only(collect(input({ mrs: [theirs()], rules, threads, memory: running })), 'replied'), []);
  const settled = { [KEY]: { key: KEY, pass: { id: 'p', launchedAt: ago(5), doneAt: ago(1), settled: 'finished' } } };
  assert.equal(only(collect(input({ mrs: [theirs()], rules, threads, memory: settled })), 'replied').length, 1);
  const answered = [finding('r', { kind: 'reply', replyTo: 'd1', createdAt: ago(2), auto: { pass: 'p', level: 'comments' } })];
  assert.deepEqual(only(collect(input({ mrs: [theirs()], rules, threads, memory: settled, queue: answered })), 'replied'), []);
});

test('9, a to-do from a person on a listed MR; never a bot or one of yours', () => {
  const todos = [{ id: 5, action: 'mentioned', key: KEY, author: 'judy', createdAt: ago(3) }, { id: 6, action: 'mentioned', key: KEY, author: 'renovate-bot', createdAt: ago(3) }, { id: 7, action: 'mentioned', key: 'other/repo!1', author: 'judy', createdAt: ago(3) }];
  const out = only(collect(input({ mrs: [theirs()], todos })), 'todo');
  assert.deepEqual(out.map((i) => [i.id, i.tab, i.next]), [['todo:5', 'threads', 'reply']]);
});

test('10, ready for your verdict again after new commits, once nothing waits on the author', () => {
  const state = { watches: {}, verdicts: { [KEY]: { verdict: 'changes', at: ago(60), sha: 'old' } }, reviewHolds: {} };
  const [v] = only(collect(input({ mrs: [theirs()], state })), 'verdict');
  assert.deepEqual([v.tier, v.tab, v.next, v.why], ['interrupt', 'findings', 'decide', 'ready for your verdict, new commits']);
  const waitingOnThem = new Map([[KEY, { threads: [entry('d1', { lastAuthor: 'frank', fromPerson: false })] }]]);
  assert.deepEqual(only(collect(input({ mrs: [theirs()], state, threads: waitingOnThem })), 'verdict'), [], 'one of your threads still waits on them');
  assert.deepEqual(only(collect(input({ mrs: [theirs()], state, queue: [finding('a')] })), 'verdict'), [], 'something is pending');
});

test('11, asked again, from the ledger\'s last review state', () => {
  const out = collect(input({ mrs: [theirs({ reviewStates: { frank: 'UNREVIEWED' } })] }), { [KEY]: { reviewState: 'REQUESTED_CHANGES' } });
  assert.deepEqual(only(out, 'rerequest').map((i) => [i.tier, i.tab, i.next]), [['interrupt', 'overview', 'decide']]);
});

test('12, a push reset your approval', () => {
  const state = { watches: {}, verdicts: { [KEY]: { verdict: 'approved', at: ago(60), sha: 'old' } }, reviewHolds: {} };
  const [r] = only(collect(input({ mrs: [theirs()], state })), 'reset');
  assert.deepEqual([r.tier, r.why], ['interrupt', 'your approval was reset by a push']);
});

test('13, a watched MR that moved with re-review off; re-review on says nothing', () => {
  const watch = (auto) => ({ watches: { [KEY]: { key: KEY, auto, seen: { sha: 'old', unresolved: 0 }, reviewedAt: ago(90) } }, verdicts: {}, reviewHolds: {} });
  assert.deepEqual(only(collect(input({ mrs: [theirs()], state: watch(false) })), 'moved').map((i) => [i.tab, i.next]), [['overview', 'review']]);
  assert.deepEqual(only(collect(input({ mrs: [theirs()], state: watch(true) })), 'moved'), []);
});

test('17, your comments are up: a badge only, since your own post caused it', () => {
  const queue = [finding('a', { status: 'posted', postedAt: ago(5), auto: { pass: 'p', level: 'shadow' } })];
  const [v] = only(collect(input({ mrs: [theirs()], queue })), 'verdict');
  assert.deepEqual([v.tier, v.next], ['badge', 'decide'], 'and a shadow finding you posted yourself counts');
});

test('19, holding with nothing queued: a badge offering Release', () => {
  const state = { watches: {}, verdicts: {}, reviewHolds: { [KEY]: { at: ago(60), sha: 'aaa111' } } };
  const [h] = only(collect(input({ mrs: [theirs({ reviewStates: { frank: 'REQUESTED_CHANGES' } })], state })), 'holding');
  assert.deepEqual([h.tier, h.next], ['badge', 'release']);
});

test('25 and 26, comments on your MR from people, plain comments included, and a change request on its own waits 45 minutes', () => {
  const threads = new Map([[OWN, { threads: [entry('d1', { mine: false, openedBy: 'judy' }), entry('n1', { resolvable: false, mine: false, openedBy: 'alice', lastAuthor: 'alice' })] }]]);
  const [c] = only(collect(input({ mrs: [mine({ reviewStates: { judy: 'REQUESTED_CHANGES' } })], threads })), 'comments');
  assert.deepEqual([c.group, c.tier, c.tab, c.next, c.why], ['mine', 'interrupt', 'threads', 'fix-threads', 'judy and alice left 2 comments and requested changes']);
  const [alone] = only(collect(input({ mrs: [mine({ reviewStates: { judy: 'REQUESTED_CHANGES' } })] })), 'changes');
  assert.deepEqual([alone.settleAfterMs, alone.why], [45 * MIN, 'judy requested changes']);
});

test('27, 28, 29: a failed pipeline, conflicts and a branch behind, each with its own next step', () => {
  assert.deepEqual(only(collect(input({ mrs: [mine({ pipeline: 'FAILED' })] })), 'red').map((i) => [i.tier, i.tab, i.next]), [['interrupt', 'pipeline', 'fix-pipeline']]);
  assert.deepEqual(only(collect(input({ mrs: [mine({ conflicts: true })] })), 'conflict').map((i) => [i.tier, i.next]), [['badge', 'fix-conflicts']]);
  assert.deepEqual(only(collect(input({ mrs: [mine({ conflicts: true, autoMerge: true })] })), 'conflict').map((i) => i.tier), ['interrupt'], 'it interrupts once merge when green is set');
  assert.deepEqual(only(collect(input({ mrs: [mine({ mergeStatus: 'NEED_REBASE' })] })), 'rebase').map((i) => i.next), ['rebase']);
});

test('30 and 31: ready to merge interrupts, waiting on checks is a badge offering merge when green', () => {
  assert.deepEqual(only(collect(input({ mrs: [mine()] })), 'mergeable').map((i) => [i.tier, i.next]), [['interrupt', 'merge']]);
  assert.deepEqual(only(collect(input({ mrs: [mine({ mergeStatus: 'NOT_APPROVED' })] })), 'approvals').map((i) => [i.tier, i.next]), [['badge', 'merge-green']]);
  assert.deepEqual(only(collect(input({ mrs: [mine({ autoMerge: true })] })), 'mergeable'), [], 'not while merge when green is set');
});

test('33: GitLab dropped merge when green', () => {
  const out = collect(input({ mrs: [mine({ autoMerge: false, pipeline: 'FAILED' })] }), { [OWN]: { autoMerge: true } });
  assert.deepEqual(only(out, 'mwg-dropped').map((i) => [i.tier, i.next]), [['interrupt', 'merge-green']]);
});

test('34: a fix agent that asks interrupts, whether it waits on a question or its turn ended on the push question', () => {
  const runs = { [`fix:${OWN}`]: { key: `fix:${OWN}`, status: 'working', startedAt: ago(20), terminal: 't-fix' } };
  const agent = (state, said) => [{ handle: 't-fix', state, said, since: ago(1), name: 'fix-88', title: 'fix !88' }];
  const done = only(collect(input({ mrs: [mine()], runs, agents: agent('done', 'Push 2 commits to feat/88 and post 3 replies on !88? (yes/no)') })), 'fix-asks');
  assert.deepEqual(done.map((i) => [i.tier, i.tab, i.next]), [['interrupt', 'agent', 'answer']]);
  assert.deepEqual(only(collect(input({ mrs: [mine()], runs, agents: agent('waiting', '') })), 'fix-asks').map((i) => i.tier), ['interrupt']);
  assert.deepEqual(only(collect(input({ mrs: [mine()], runs, agents: agent('done', 'All done.') })), 'fix-asks'), []);
  assert.deepEqual(only(collect(input({ mrs: [mine()], runs, agents: agent('done', 'Push?') })), 'agent'), [], 'and it is not listed again under Agents waiting');
});

test('27, a retry that fails again on the same head counts once more, from the ledger\'s last pipeline', () => {
  const red = (m, last) => only(collect(input({ mrs: [m] }), last), 'red')[0].id;
  const first = red(mine({ pipeline: 'FAILED', pipelineId: 41 }), {});
  const out = collect(input({ mrs: [mine({ pipeline: 'FAILED', pipelineId: 41 })] }), {});
  assert.equal(red(mine({ pipeline: 'FAILED', pipelineId: 41 }), { [OWN]: out.facts[OWN] }), first, 'still red is not news');
  const running = collect(input({ mrs: [mine({ pipeline: 'RUNNING', pipelineId: 41 })] }), { [OWN]: out.facts[OWN] });
  assert.notEqual(red(mine({ pipeline: 'FAILED', pipelineId: 41 }), { [OWN]: running.facts[OWN] }), first, 'red again after the retry ran');
  assert.notEqual(red(mine({ pipeline: 'FAILED', pipelineId: 42 }), { [OWN]: out.facts[OWN] }), first, 'and a new pipeline on the same head');
});

test('32, merge when green merged it: an interrupt from what was kept of it, a badge when someone else merged it, nothing when you merged it here', () => {
  const gone = (end, extra = {}) => ({ key: OWN, at: NOW - 5 * MIN, facts: { autoMerge: true, title: 'Ship the portal' }, end, ...extra });
  const [m] = only(collect(input({ departed: [gone({ state: 'merged', mergedBy: 'frank' })] })), 'merged');
  assert.deepEqual([m.key, m.group, m.tier, m.id, m.why, m.next, m.later], [OWN, 'mine', 'interrupt', `${OWN}:merged`, 'merge when green merged it', 'dismiss', 'merged']);
  assert.equal(collect(input({ departed: [gone({ state: 'merged', mergedBy: 'frank' })] })).cards[0].title, 'Ship the portal');
  const [other] = only(collect(input({ departed: [gone({ state: 'merged', mergedBy: 'judy' })] })), 'merged');
  assert.deepEqual([other.tier, other.why], ['badge', 'judy merged it']);
  assert.deepEqual(only(collect(input({ departed: [gone({ state: 'merged', mergedBy: 'frank' })], mergedHere: new Set([OWN]) })), 'merged'), []);
  assert.deepEqual(only(collect(input({ departed: [gone({ state: 'closed', mergedBy: null })] })), 'merged'), [], 'closed is not merged');
  assert.deepEqual(only(collect(input({ departed: [gone(undefined)] })), 'merged'), [], 'missing is not merged');
  assert.deepEqual(only(collect(input({ departed: [gone({ state: 'merged', mergedBy: 'frank' }, { facts: { autoMerge: false } })] })), 'merged'), [], 'only merge when green');
});

test('35, the fix agent finished once its terminal is done or gone and the head moved, counting its replies and resolutions', () => {
  const run = { [`fix:${OWN}`]: { key: `fix:${OWN}`, status: 'running', startedAt: ago(20), terminal: 't-fix', sha: 'old111' } };
  const threads = new Map([[OWN, { threads: [entry('d1', { lastAuthor: 'frank', lastAt: ago(5), resolved: true }), entry('d2', { lastAuthor: 'frank', lastAt: ago(4) }), entry('d3', { lastAuthor: 'frank', lastAt: ago(30) })] }]]);
  const agent = (state, said = 'Pushed and replied.') => [{ handle: 't-fix', state, said, since: ago(1), name: 'fix-88' }];
  const [done] = only(collect(input({ mrs: [mine()], runs: run, threads, agents: agent('done'), agentsRead: true })), 'fix-done');
  assert.deepEqual([done.tier, done.tab, done.id, done.why], ['interrupt', 'threads', `fix-done:${OWN}:${run[`fix:${OWN}`].startedAt}`, 'fix pushed, 2 replies, 1 resolved']);
  assert.equal(only(collect(input({ mrs: [mine()], runs: run, threads, agents: [], agentsRead: true })), 'fix-done').length, 1, 'its terminal closed');
  assert.deepEqual(only(collect(input({ mrs: [mine()], runs: run, threads, agents: [], agentsRead: false })), 'fix-done'), [], 'not while Orca could not be read');
  assert.deepEqual(only(collect(input({ mrs: [mine()], runs: run, threads, agents: agent('working'), agentsRead: true })), 'fix-done'), [], 'still working');
  assert.deepEqual(only(collect(input({ mrs: [mine({ sha: 'old111' })], runs: run, threads, agents: agent('done'), agentsRead: true })), 'fix-done'), [], 'it pushed nothing');
  assert.deepEqual(only(collect(input({ mrs: [mine()], runs: run, threads, agents: agent('done', 'Push 1 commit? (yes/no)'), agentsRead: true })), 'fix-done'), [], 'still asking');
});

test('36, a rebase you started that failed, keyed on when it started, with fixing the conflicts next', () => {
  const since = NOW - 3 * MIN;
  const [r] = only(collect(input({ mrs: [mine()], rebasesFailed: [{ key: OWN, since, error: 'Rebase failed: conflicts' }] })), 'rebase-failed');
  assert.deepEqual([r.tier, r.id, r.why, r.next, r.tab], ['interrupt', `${OWN}:rebase-failed:${since}`, 'the rebase failed: Rebase failed: conflicts', 'fix-conflicts', 'overview']);
});

test('a card merges every reason for its MR, interrupts first', () => {
  const threads = new Map([[KEY, { threads: [entry('d1')] }]]);
  const out = collect(input({ mrs: [theirs()], queue: [finding('a'), finding('b')], threads }));
  const [card] = out.cards;
  assert.equal(out.cards.length, 1);
  assert.deepEqual(card.reasons.map((i) => i.kind).sort(), ['findings', 'replied']);
  assert.equal(card.top.tier, 'interrupt');
});

test('groups go others, then yours, then agents; within one, interrupts and then the oldest', () => {
  const second = mr('acme/engine', 1130, { author: 'alice', updatedAt: ago(300) });
  const quiet = mr('acme/engine', 1140, { author: 'bob', reviewers: [], updatedAt: ago(900), reviewStates: { frank: 'REQUESTED_CHANGES' } });
  const state = { watches: {}, verdicts: {}, reviewHolds: { 'acme/engine!1140': { at: ago(900), sha: 'aaa111' } } };
  const agents = [{ handle: 't9', state: 'waiting', since: ago(500), name: 'scratch' }];
  const out = collect(input({ mrs: [theirs(), second, quiet, mine({ pipeline: 'FAILED' })], state, agents }));
  assert.deepEqual(out.cards.map((c) => c.key), ['acme/engine!1130', KEY, 'acme/engine!1140', OWN]);
  assert.deepEqual(only(out, 'agent').map((i) => i.group), ['agents']);
});

test('waiting agents never push an MR out of the cards', () => {
  const agents = Array.from({ length: 10 }, (_, n) => ({ handle: `t${n}`, state: 'waiting', since: ago(1000 + n), name: `w${n}` }));
  const out = collect(input({ mrs: [theirs()], agents }));
  assert.deepEqual(out.cards.map((c) => c.key), [KEY]);
  assert.equal(only(out, 'agent').length, 10);
});

test('what sends itself, what was sent without you and what expired never reach the list', () => {
  const queue = [
    finding('a', { auto: { pass: 'p', level: 'comments', sendAt: ago(-2) } }),
    finding('b', { status: 'posted', postedAt: ago(3), auto: { pass: 'p', level: 'comments', sentAuto: true } }),
    finding('c', { status: 'expired', expiredAt: ago(1) }),
  ];
  const out = collect(input({ mrs: [theirs({ reviewers: [] })], queue }));
  assert.deepEqual(kinds(out), []);
});

test('a driver stopped for two turns, with someone in full auto, is said once; GitLab failing for three polls too', () => {
  const rules = { people: [{ username: 'judy', level: 'comments' }], onRequest: null, optedOut: new Set() };
  const driver = { state: 'stopped', why: 'GITLAB_TOKEN is not set' };
  assert.deepEqual(only(collect(input({ rules, driver, driverTurns: 1 })), 'driver'), []);
  assert.deepEqual(only(collect(input({ rules, driver, driverTurns: 2 })), 'driver').map((i) => [i.group, i.tier]), [['system', 'interrupt']]);
  assert.deepEqual(only(collect(input({ fetchError: 'timeout', fetchedAt: ago(3) })), 'gitlab'), []);
  assert.equal(only(collect(input({ fetchError: 'timeout', fetchedAt: ago(5) })), 'gitlab').length, 1);
});

test('only what the engine says waits to post is counted, so an item on an MR off the list is not', () => {
  const out = collect(input({ mrs: [theirs()], queue: [finding('a'), finding('b')], waiting: new Set(['a']) }));
  assert.equal(only(out, 'findings')[0].count, 1);
});

test('three or more people are listed with commas, the last after and', () => {
  const threads = new Map([[OWN, { threads: ['judy', 'alice', 'bob'].map((who, n) => entry('d' + n, { mine: false, openedBy: who, lastAuthor: who })) }]]);
  assert.equal(only(collect(input({ mrs: [mine()], threads })), 'comments')[0].why, 'judy, alice and bob left 3 comments');
});

test('a kickoff agent interrupts while it waits on you, and when its turn ends on a question', () => {
  const runs = { 'ticket:ABC-12': { key: 'ticket:ABC-12', status: 'running', startedAt: ago(20), terminal: 't-kick', kickoff: true } };
  const agent = (state, said = 'Which repo?') => [{ handle: 't-kick', state, said, since: ago(1), name: 'kickoff-ABC-12', title: 'kickoff ABC-12' }];
  const asks = (state, over = {}) => only(collect(input({ runs, agents: agent(state), ...over })), 'kickoff-asks');
  assert.deepEqual(asks('done').map((i) => [i.group, i.key, i.ticket, i.tier, i.why, i.handle]), [['agents', null, 'ABC-12', 'interrupt', 'its kickoff agent asks you', 't-kick']]);
  assert.deepEqual(asks('waiting').map((i) => i.tier), ['interrupt']);
  assert.deepEqual(asks('working'), []);
  assert.deepEqual(asks('done', { agents: agent('done', 'Raised !12 for ABC-12.') }), [], 'a turn that ended on no question');
  assert.deepEqual(only(collect(input({ runs, agents: agent('waiting') })), 'agent'), [], 'and it is not listed again as a plain agent');
  assert.deepEqual(asks('done', { runs: { 'ticket:ABC-12': { ...runs['ticket:ABC-12'], status: 'launch failed' } } }), []);
});

test('a ticket agent the TUI started is no kickoff: its ended turn raises nothing, and its wait is a plain agent', () => {
  const runs = { 'ticket:ABC-12': { key: 'ticket:ABC-12', status: 'running', startedAt: ago(20), terminal: 't-tui', worktreePath: '/work/engine-ABC-12' } };
  const agent = (state) => [{ handle: 't-tui', state, said: 'Shall I raise the MR?', since: ago(1), name: 'engine-cos12', title: 'ABC-12' }];
  assert.deepEqual(collect(input({ runs, agents: agent('done') })).items.filter((i) => i.group === 'agents'), []);
  const waiting = collect(input({ runs, agents: agent('waiting') }));
  assert.deepEqual([only(waiting, 'kickoff-asks'), only(waiting, 'agent').map((i) => [i.tier, i.why])], [[], [['interrupt', 'engine-cos12 asks you']]]);
});

test('a review agent that asks on an MR interrupts, and a permission it waits on is named by its tool', () => {
  const runs = { [KEY]: { key: KEY, status: 'working', startedAt: ago(20), terminal: 'claude:r1' } };
  const agent = (state, ask) => [{ handle: 'claude:r1', state, said: '', since: ago(1), name: 'review-engine-1121', title: 'review !1121', ask }];
  const asking = only(collect(input({ mrs: [theirs()], runs, agents: agent('blocked', { id: 'req-1', tool: 'Bash', summary: 'git push' }) })), 'agent');
  assert.deepEqual(asking.map((i) => [i.tier, i.why, i.tab, i.handle]), [['interrupt', 'its review agent asks to use Bash', 'agent', 'claude:r1']]);
  assert.deepEqual(only(collect(input({ mrs: [theirs()], runs, agents: agent('waiting', { id: 'req-2', tool: 'AskUserQuestion', questions: [] }) })), 'agent').map((i) => i.why), ['its review agent asks you']);
  assert.deepEqual(only(collect(input({ mrs: [theirs()], runs, agents: agent('working', null) })), 'agent'), []);
});

test('each forge that stops answering for three polls gets its own card with its own retry, and the other forge answering says nothing', () => {
  const quiet = { gitlab: ago(5), github: ago(1) };
  const out = collect(input({ forgeErrors: { gitlab: 'timeout' }, answeredAt: quiet, fetchError: null }));
  assert.deepEqual(only(out, 'gitlab').map((i) => [i.title, i.next, i.group]), [['GitLab', 'retry-gitlab', 'system']]);
  assert.deepEqual(only(out, 'github'), []);
  const hub = collect(input({ forgeErrors: { github: 'GitHub refused the token (401)' }, answeredAt: { gitlab: ago(1), github: ago(5) } }));
  assert.deepEqual(only(hub, 'github').map((i) => [i.title, i.next, i.why.startsWith('GitHub has not answered since ')]), [['GitHub', 'retry-github', true]]);
  assert.deepEqual(only(hub, 'gitlab'), []);
  const both = collect(input({ fetchError: 'timeout', forgeErrors: { github: 'down' }, fetchedAt: ago(5), answeredAt: { github: ago(5) } }));
  assert.deepEqual([only(both, 'gitlab').length, only(both, 'github').length], [1, 1]);
});

test('a forge that failed only just, or that answered since, is not yet a card, and each card is told apart by when its forge last answered', () => {
  assert.deepEqual(only(collect(input({ forgeErrors: { github: 'down' }, answeredAt: { github: ago(3) } })), 'github'), []);
  const first = only(collect(input({ forgeErrors: { github: 'down' }, answeredAt: { github: ago(5) } })), 'github')[0];
  const later = only(collect(input({ forgeErrors: { github: 'down' }, answeredAt: { github: ago(9) } })), 'github')[0];
  assert.notEqual(first.id, later.id);
});

test('your name on each forge is its own: a GitHub author called what you are called on GitLab is not you, so his pull request is not yours', () => {
  const accounts = { gitlab: 'frank', github: 'frank-gh' };
  const namesake = mr('octo/web', 3, { author: 'frank', reviewers: ['frank-gh'], provider: 'github', projectId: 503, updatedAt: ago(30) });
  const out = collect(input({ accounts, mrs: [namesake] }));
  assert.deepEqual(only(out, 'asked').map((i) => i.group), ['others'], 'asked of frank-gh, written by someone else');
  const own = mr('octo/web', 4, { author: 'frank-gh', reviewers: ['judy'], provider: 'github', projectId: 503, updatedAt: ago(30), pipeline: 'FAILED' });
  assert.deepEqual(only(collect(input({ accounts, mrs: [own] })), 'red').map((i) => i.group), ['mine']);
  assert.deepEqual(only(collect(input({ accounts, mrs: [mine()] })), 'asked'), [], 'a GitLab MR is still read against the GitLab name');
  const noAccounts = collect(input({ mrs: [mine()] }));
  assert.deepEqual(noAccounts.facts[OWN], { reviewState: null, autoMerge: false, sha: 'aaa111', title: 'MR 88', pipeline: 'SUCCESS', reds: 0 });
});
