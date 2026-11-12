import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openPage } from './testkit.mjs';

const AT = '2026-11-09T12:00:00Z';
const KEY = 'acme/engine!7';
const HANDLE = 'claude:5f0c3b8e-9a6d-4c1e-8f2a-1b3c4d5e6f70';
const QUESTION = 'Should I reply with the word "ready" or the word "steady"?';
const ASKS = { id: 'req-1', tool: 'AskUserQuestion', summary: 'AskUserQuestion', questions: [{ question: QUESTION, header: 'Reply word', options: [{ label: 'ready' }, { label: 'steady' }], multiSelect: false }] };
const PERMISSION = { id: 'req-2', tool: 'Bash', summary: 'touch smoke.txt', questions: null };

function chat(extra = {}) {
  return {
    handle: HANDLE, sessionId: HANDLE.slice(7), name: 'review-engine-7', title: 'review !7', cwd: '/work', state: 'waiting', since: 1000, lastAt: 1500, alive: true, said: '',
    pending: ASKS,
    entries: [
      { kind: 'you', at: 1, text: '/team:review https://gitlab.com/acme/engine/-/merge_requests/7' },
      { kind: 'tool', at: 2, name: 'Bash', summary: 'git diff origin/main' },
      { kind: 'said', at: 3, text: 'Two findings so far.\nOne more question first.' },
      { kind: 'asked', at: 4, id: 'req-1', tool: 'AskUserQuestion', summary: 'AskUserQuestion', questions: ASKS.questions },
    ],
    ...extra,
  };
}

function listed(c) {
  return {
    handle: HANDLE, name: c.name, title: c.title, kind: 'review', mr: KEY, ticket: null, worktree: c.worktree ?? null, cwd: c.cwd,
    state: c.state, since: c.since, lastAt: c.lastAt, alive: c.alive, said: c.said, outcome: null, ask: c.pending,
  };
}

function mrRow(extra = {}) {
  return {
    key: KEY, iid: 7, repo: 'engine', title: 'Make the engine faster', webUrl: 'https://gitlab.com/acme/engine/-/merge_requests/7', author: 'ivan', reviewers: ['frank'],
    approvedBy: [], draft: false, pipeline: 'SUCCESS', ticket: 'ABC-1', updatedAt: AT, unresolved: 0, threads: null, mergeStatus: 'MERGEABLE', sourceBranch: 'feat/7',
    sha: 'aaa111', agentHandle: null, watch: null, flags: { waitingOnYou: true }, phase: 'open', count: 0, mood: 'awaitingYou', verdict: null, agent: null, level: null,
    ...extra,
  };
}

function snapshot(c = chat(), { rows = [], cards = [] } = {}) {
  const waiting = ['waiting', 'blocked'].includes(c.state) && !cards.length ? [{ kind: 'agent', group: 'agents', id: 'agent:' + HANDLE, handle: HANDLE, tier: 'interrupt', why: c.state }] : [];
  return {
    generatedAt: AT,
    attention: { cards, agents: waiting, system: [], count: 0, prefs: {}, toasts: [], offers: [] },
    version: { ui: 1, lib: 1, worker: 1, loaded: 1 },
    agents: [listed(c)],
    artifacts: [],
    matrix: {
      available: true, me: 'frank', paused: false, holdSeconds: null, holdWhileReviewing: false,
      inbox: { fetchedAt: AT, loading: false, error: null, repoCount: 1, rows },
      fullAuto: [], roster: [], watches: [], verdicts: {}, queue: [], runs: [], autoPasses: [],
    },
  };
}

async function pageWith(c, hash, extra) {
  const calls = [];
  let shown = c;
  const respond = (path, init) => {
    calls.push({ path, method: init?.method, body: init?.body ? JSON.parse(init.body) : null });
    if (path.startsWith('/api/agents/conversation')) return shown;
    return init?.method === 'POST' ? { ok: true, text: 'Sent' } : null;
  };
  const page = await openPage({ respond });
  page.show(snapshot(c, extra), hash);
  return { page, calls, posts: () => calls.filter((x) => x.method === 'POST').map(({ path, body }) => ({ path, body })), showNext: (next) => { shown = next; } };
}

const logLines = (page, scope) => page.$(scope + ' .chat .log').childNodes.map((d) => [d.className, d.textContent]);

const buttonIn = (page, scope, label) => page.$$(scope + ' button').find((b) => (label instanceof RegExp ? label.test(b.textContent) : b.textContent === label));

async function openChat(page) {
  buttonIn(page, '#main', 'Conversation').click();
  await page.settle();
}

const EXPECT = { state: 'waiting', since: 1000, pending: 'req-1' };

test('a Claude Code agent shows its conversation, not a terminal: your words, its words as markdown and one line per tool call', async () => {
  const { page, calls } = await pageWith(chat(), 'needs-you');
  assert.match(page.$('#main .agent .row-head').textContent, /needs an answer/);
  assert.equal(buttonIn(page, '#main', 'Screen'), undefined);
  await openChat(page);
  assert.ok(calls.some((c) => c.path === '/api/agents/conversation?handle=' + encodeURIComponent(HANDLE)));
  assert.ok(calls.every((c) => !c.path.startsWith('/api/agents/screen')), 'nothing asks Orca for its screen');
  assert.deepEqual(logLines(page, '#main'), [
    ['you', 'You/team:review https://gitlab.com/acme/engine/-/merge_requests/7'],
    ['call', 'Bash: git diff origin/main'],
    ['said', 'Two findings so far.\nOne more question first.'],
    ['asked', QUESTION],
  ]);
  assert.equal(page.$('#main .chat .said .md p').textContent, 'Two findings so far.\nOne more question first.');
  assert.equal(buttonIn(page, '#main', 'Show in Orca'), undefined);
  assert.deepEqual(page.errors, []);
});

test('the question it asks has its options as buttons on its row, each two clicks that name the answer, and the answer goes with what the page saw', async () => {
  const { page, posts } = await pageWith(chat(), 'needs-you');
  assert.equal(page.$('#main .agent .ask .asked').textContent, QUESTION, 'answered without opening the conversation');
  assert.deepEqual(page.$$('#main .options button').map((b) => b.textContent), ['ready', 'steady']);
  const ready = () => page.$$('#main .options button')[0];
  ready().click();
  assert.equal(ready().textContent, 'Answer “ready” to review-engine-7?');
  assert.deepEqual(posts(), []);
  ready().click();
  await page.settle();
  assert.deepEqual(posts(), [{ path: '/api/matrix/agent-reply', body: { handle: HANDLE, answer: { question: QUESTION, label: 'ready' }, expect: EXPECT } }]);
});

test('a permission it asks for is Allow or Deny, each two clicks naming the tool', async () => {
  const c = chat({ state: 'blocked', pending: PERMISSION, entries: [{ kind: 'asked', at: 4, id: 'req-2', tool: 'Bash', summary: 'touch smoke.txt' }] });
  const { page, posts } = await pageWith(c, 'needs-you');
  assert.match(page.$('#main .agent .row-head').textContent, /needs approval/);
  assert.equal(page.$('#main .agent .ask .asked').textContent, 'Asks to use Bash: touch smoke.txt');
  await openChat(page);
  assert.equal(page.$('#main .chat .asked').textContent, 'Asks to use Bash: touch smoke.txt');
  buttonIn(page, '#main .options', 'Deny').click();
  buttonIn(page, '#main .options', 'Deny Bash for review-engine-7?').click();
  await page.settle();
  buttonIn(page, '#main .options', 'Allow Bash').click();
  buttonIn(page, '#main .options', 'Allow Bash for review-engine-7?').click();
  await page.settle();
  const expect = { state: 'blocked', since: 1000, pending: 'req-2' };
  assert.deepEqual(posts(), [
    { path: '/api/matrix/agent-reply', body: { handle: HANDLE, allow: false, expect } },
    { path: '/api/matrix/agent-reply', body: { handle: HANDLE, allow: true, expect } },
  ]);
});

test('a typed reply is sent to the agent with what the page saw, after a second click', async () => {
  const { page, posts } = await pageWith(chat(), 'needs-you');
  await openChat(page);
  const box = page.document.getElementById('agent-reply-' + HANDLE);
  assert.equal(box.getAttribute('placeholder'), 'Or type your own answer');
  box.value = 'neither, say go';
  page.fire(box, 'input');
  const send = () => buttonIn(page, '#main .reply', /Send/);
  send().click();
  assert.equal(send().textContent, 'Send “neither, say go” to review-engine-7?');
  send().click();
  await page.settle();
  assert.deepEqual(posts(), [{ path: '/api/matrix/agent-reply', body: { handle: HANDLE, text: 'neither, say go', expect: EXPECT } }]);
  assert.equal(page.run('ui.drafts.size'), 0);
});

test('Stop takes two clicks, and Open in Terminal two while the agent runs here, as it stops it first, and neither needs the conversation open', async () => {
  const { page, posts } = await pageWith(chat(), 'needs-you');
  assert.equal(buttonIn(page, '#main .agent', 'Remove'), undefined, 'nothing is removed while it runs');
  buttonIn(page, '#main .agent', 'Stop').click();
  buttonIn(page, '#main .agent', 'Stop review-engine-7?').click();
  await page.settle();
  buttonIn(page, '#main .agent', 'Open in Terminal').click();
  assert.deepEqual(posts().map((p) => p.path), ['/api/matrix/agent-stop']);
  buttonIn(page, '#main .agent', 'Stop it here and open it in Terminal?').click();
  await page.settle();
  assert.deepEqual(posts(), [{ path: '/api/matrix/agent-stop', body: { handle: HANDLE } }, { path: '/api/matrix/agent-terminal', body: { handle: HANDLE } }]);
});

test('a finished agent offers a follow-up, no Stop, and Open in Terminal in one click', async () => {
  const c = chat({ state: 'done', alive: false, pending: null, said: 'ready' });
  const { page, posts } = await pageWith(c, 'merge-requests', { rows: [mrRow({ agent: 'idle', agentHandle: HANDLE })] });
  buttonIn(page, '#main .mr', 'Agent').click();
  await page.settle();
  assert.equal(page.document.getElementById('agent-reply-' + HANDLE).getAttribute('placeholder'), 'Follow up, which picks its session up again');
  assert.equal(buttonIn(page, '#drawer .agent', 'Stop'), undefined);
  buttonIn(page, '#drawer .agent', 'Open in Terminal').click();
  await page.settle();
  assert.deepEqual(posts(), [{ path: '/api/matrix/agent-terminal', body: { handle: HANDLE } }]);
});

test('a finished agent is removed in two clicks naming it, with the state the page saw, and one with a worktree says that goes too', async () => {
  const c = chat({ state: 'done', alive: false, pending: null, said: 'ready', since: 2000 });
  const { page, posts } = await pageWith(c, 'agents');
  page.run("ui.agentFilter = 'all'; render()");
  buttonIn(page, '#main .agent', 'Remove').click();
  buttonIn(page, '#main .agent', 'Remove review-engine-7?').click();
  await page.settle();
  assert.deepEqual(posts(), [{ path: '/api/matrix/agent-remove', body: { handle: HANDLE, expect: { state: 'done', since: 2000 } } }]);
  page.show(snapshot({ ...c, worktree: '/work/fix-engine-7' }), 'agents');
  buttonIn(page, '#main .agent', 'Remove').click();
  assert.ok(buttonIn(page, '#main .agent', 'Remove review-engine-7 and its worktree?'));
});

test('an answer armed on one question is disarmed when the agent moves on to the next', async () => {
  const { page, posts, showNext } = await pageWith(chat(), 'needs-you');
  await openChat(page);
  page.$$('#main .options button')[0].click();
  assert.equal(page.$$('#main button.armed').length, 1);
  showNext(chat({ pending: { ...ASKS, id: 'req-3' } }));
  page.run('agentPollScreens()');
  await page.settle();
  assert.equal(page.$$('#main button.armed').length, 0);
  assert.deepEqual(posts(), []);
});

test('on an MR row, Agent opens the drawer\'s Agent tab on its Claude Code review agent\'s conversation', async () => {
  const c = chat({ state: 'working', pending: null });
  const { page, calls } = await pageWith(c, 'merge-requests', { rows: [mrRow({ agent: 'working', agentHandle: HANDLE })] });
  buttonIn(page, '#main .mr', 'Agent').click();
  await page.settle();
  assert.equal(page.run('ui.mr.tab'), 'agent');
  assert.equal(page.$('#drawer .chat').dataset.handle, HANDLE);
  assert.deepEqual(page.errors, []);
  assert.equal(logLines(page, '#drawer').length, 4);
  assert.equal(buttonIn(page, '#drawer', 'Conversation'), undefined, 'the drawer shows it at once');
  assert.ok(calls.some((x) => x.path.startsWith('/api/agents/conversation')));
  assert.equal(buttonIn(page, '#drawer', 'Show in Orca'), undefined);
});

test('a Needs you card whose agent asks carries the question and its options, and Show here opens its whole conversation in place', async () => {
  const card = { key: KEY, group: 'others', title: 'Make the engine faster', iid: 7, repo: 'engine', sha: 'aaa111', since: AT, interrupt: true, reasons: [{ kind: 'agent', key: KEY, tier: 'interrupt', why: 'its review agent asks you', tab: 'agent', next: 'answer', handle: HANDLE }] };
  card.top = card.reasons[0];
  const { page, posts } = await pageWith(chat(), 'needs-you', { rows: [mrRow({ agent: 'waiting', agentHandle: HANDLE })], cards: [card] });
  const shown = page.$('#main .need-card');
  assert.equal(shown.querySelector('.ask .asked').textContent, QUESTION);
  assert.deepEqual(page.$$('#main .need-card .options button').map((b) => b.textContent), ['ready', 'steady']);
  page.$$('#main .need-card .options button')[1].click();
  page.$$('#main .need-card .options button')[1].click();
  await page.settle();
  assert.deepEqual(posts(), [{ path: '/api/matrix/agent-reply', body: { handle: HANDLE, answer: { question: QUESTION, label: 'steady' }, expect: EXPECT } }]);
  buttonIn(page, '#main .need-card', 'Show here').click();
  await page.settle();
  assert.equal(logLines(page, '#main .need-card').length, 4);
  assert.equal(page.$$('#main .need-card .options').length, 1, 'the question shows once');
});

test('nothing about an agent says Orca, and where agents run is a choice in the Running agents group of Settings', async () => {
  const { page } = await pageWith(chat(), 'agents');
  assert.doesNotMatch(page.$('#main').textContent, /Orca/);
  assert.equal(page.run('typeof inOrcaIfSplit'), 'undefined');
  assert.equal(page.run("JSON.stringify(SETTING_GROUPS.find(([title]) => title === 'Running agents'))"), JSON.stringify(['Running agents', ['agentHost', 'agentPermissions', 'maxAgents', 'agentBudgetUsd']]));
});
