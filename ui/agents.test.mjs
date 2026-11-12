import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { openPage } from './testkit.mjs';

const AT = '2026-11-09T12:00:00Z';
const handle = (n) => `claude:0000000${n}-0000-4000-8000-000000000000`;

function agent(n, extra = {}) {
  return {
    handle: handle(n), name: 'agent-' + n, title: 'task ' + n, kind: 'review', mr: null, ticket: null, worktree: null, cwd: '/work',
    state: 'working', since: 1000 + n, lastAt: Date.parse(AT), alive: true, said: '', outcome: null, ask: null, ...extra,
  };
}

const REVIEW = agent(1, { name: 'review-Engine-7', mr: 'acme/engine!7', state: 'waiting', ask: { id: 'q1', tool: 'AskUserQuestion', summary: 'AskUserQuestion', questions: [{ question: 'Post them?', options: [{ label: 'Yes' }, { label: 'No' }] }] } });
const FIX = agent(2, { name: 'fix-Engine-88', kind: 'fix', mr: 'acme/engine!88', worktree: '/work/fix-Engine-88' });
const KICKOFF = agent(3, { name: 'kickoff-ABC-12', kind: 'kickoff', ticket: 'ABC-12', state: 'done', alive: false, said: 'Raised !90.' });

function snapshot(agents = [REVIEW, FIX, KICKOFF]) {
  return {
    generatedAt: AT,
    attention: { cards: [], agents: [], system: [], count: 0, prefs: {}, toasts: [], offers: [] },
    version: { ui: 1, lib: 1, worker: 1, loaded: 1 },
    agents,
    artifacts: [],
    matrix: {
      available: true, me: 'frank', paused: false, holdSeconds: null, holdWhileReviewing: false,
      inbox: { fetchedAt: AT, loading: false, error: null, repoCount: 1, rows: [] },
      fullAuto: [], roster: [], watches: [], verdicts: {}, queue: [], runs: [], autoPasses: [],
    },
  };
}

async function pageWith(snap, hash = 'agents') {
  const calls = [];
  const respond = (path, init) => {
    calls.push({ path, method: init?.method });
    if (path.startsWith('/api/agents/conversation')) return { ...agent(1), entries: [], pending: null };
    return init?.method === 'POST' ? { ok: true, text: 'Done' } : null;
  };
  const page = await openPage({ respond });
  page.show(snap, hash);
  return { page, calls };
}

const rows = (page) => page.$$('#main .agent').map((a) => [a.querySelector('.title').textContent, a.querySelector('.pill').textContent]);
const buttonIn = (page, scope, label) => page.$$(scope + ' button').find((b) => b.textContent === label);

test('the Agents view lists every Claude agent, review, fix and kickoff, with its state and what it works for, the one asking first', async () => {
  const { page } = await pageWith(snapshot());
  page.run("ui.agentFilter = 'all'; render()");
  assert.deepEqual(rows(page), [['review-Engine-7', 'needs an answer'], ['fix-Engine-88', 'working'], ['kickoff-ABC-12', 'done']]);
  const works = page.$$('#main .agent').map((a) => (a.querySelector('.ref') ?? a.querySelector('.ticket-ref'))?.textContent);
  assert.deepEqual(works, ['engine!7', 'engine!88', 'ABC-12']);
  assert.match(page.$('#main .head p').textContent, /^3 Claude Code agents/);
  assert.deepEqual(page.errors, []);
});

test('focusing an agent is opening the drawer of what it works for, on its Agent tab', async () => {
  const { page } = await pageWith(snapshot());
  page.run("ui.agentFilter = 'all'; render()");
  page.$$('#main .agent .ref')[1].click();
  await page.settle();
  assert.deepEqual([page.run('ui.mr.key'), page.run('ui.mr.tab')], ['acme/engine!88', 'agent']);
  page.run('closeDrawer()');
  page.$('#main .agent .ticket-ref').click();
  await page.settle();
  assert.deepEqual([page.run('ui.ticket.key'), page.run('ui.ticket.tab')], ['ABC-12', 'agent']);
});

test('Active leaves finished agents out, Needs you keeps the one asking, and the search reads names, work and words', async () => {
  const { page } = await pageWith(snapshot());
  assert.deepEqual(rows(page).map(([name]) => name), ['review-Engine-7', 'fix-Engine-88']);
  page.run("ui.agentFilter = 'needs'; render()");
  assert.deepEqual(rows(page).map(([name]) => name), ['review-Engine-7']);
  page.run("ui.agentFilter = 'all'; ui.agentSearch = 'raised'; render()");
  assert.deepEqual(rows(page).map(([name]) => name), ['kickoff-ABC-12']);
  page.run("ui.agentSearch = 'abc-12'; render()");
  assert.deepEqual(rows(page).map(([name]) => name), ['kickoff-ABC-12']);
});

test('the rail calls the section Agents, and the health line has no Orca in it', async () => {
  const { page } = await pageWith(snapshot());
  const groups = page.$$('.navgroup h2').map((h) => h.textContent);
  assert.ok(groups.includes('Agents') && !groups.includes('Orca'), groups.join());
  assert.doesNotMatch(page.$('#health').textContent, /Orca/);
  assert.doesNotMatch(page.$('.brand').textContent, /Orca/);
});

test('no more than three conversations are open or read at once', async () => {
  const { page, calls } = await pageWith(snapshot([1, 2, 3, 4].map((n) => agent(n))));
  const toggles = () => page.$$('#main button').filter((b) => b.textContent === 'Conversation');
  for (let i = 0; i < 4; i++) {
    toggles()[i].click();
    await page.settle(20);
  }
  assert.deepEqual([...page.run('agentShownScreens()')], [handle(2), handle(3), handle(4)]);
  calls.length = 0;
  page.run('agentPollScreens()');
  await page.settle(20);
  assert.deepEqual(calls.map((c) => c.path).sort(), [2, 3, 4].map((n) => '/api/agents/conversation?handle=' + encodeURIComponent(handle(n))));
});

test('every top-level name the agents view declares is its own, so it cannot replace another file\'s', async () => {
  const text = await readFile(new URL('./31-agents.js', import.meta.url), 'utf8');
  const declared = [...text.matchAll(/^(?:async\s+)?function\s*\*?\s*(\w+)|^(?:const|let|var|class)\s+(\w+)/gm)].map((m) => m[1] ?? m[2]);
  const slots = new Set(['viewAgents', 'drawerAgent']);
  assert.deepEqual(declared.filter((name) => !slots.has(name) && !/^(?:agent|AGENT_)/.test(name)), []);
});

test('an agent whose builder runs on in the background reads as working and says what is running', async () => {
  const busy = agent(4, { name: 'kickoff-ABC-2871', kind: 'kickoff', ticket: 'ABC-2871', state: 'working', background: ['Build ABC-2871 in gateway'] });
  const { page } = await pageWith(snapshot([busy]));
  const row = page.$$('#main .agent').find((a) => a.querySelector('.title').textContent === 'kickoff-ABC-2871');
  assert.equal(row.querySelector('.agent-background').textContent, 'In the background: Build ABC-2871 in gateway');
});

test('beside its state each agent says what it is doing, unless the state already says it, and a kickoff shows the MR it raised', async () => {
  const agents = [
    agent(1, { kind: 'fix', mr: 'acme/engine!88', phase: 'testing' }),
    agent(2, { kind: 'kickoff', ticket: 'ABC-2753', phase: 'mr', raisedMr: 'acme/engine!58' }),
    agent(3, { kind: 'kickoff', ticket: 'ABC-2871', phase: 'builders', background: ['Build it in engine', 'Build it in ui'] }),
    agent(4, { state: 'waiting', phase: 'waiting', ask: REVIEW.ask }),
    agent(5, { state: 'done', alive: false, outcome: 'success', phase: 'done' }),
    agent(6, { state: 'done', alive: false, outcome: 'stopped', phase: 'stopped' }),
    agent(7),
    agent(8, { kind: 'kickoff', ticket: 'ABC-12', phase: 'mr', raisedMr: 'acme/engine#12' }),
  ];
  const { page } = await pageWith(snapshot(agents));
  page.run("ui.agentFilter = 'all'; render()");
  const beside = (n) => page.$('#main .agent[data-handle="' + handle(n) + '"] .row-head .agent-phase')?.textContent ?? null;
  assert.deepEqual([1, 2, 3, 4, 5, 6, 7].map(beside), ['Testing', 'Raising MR', '2 builders running', null, null, 'Stopped', null]);
  const pulled = page.$('#main .agent[data-handle="' + handle(8) + '"] .row-head');
  assert.deepEqual([pulled.querySelector('.ref')?.textContent ?? null, pulled.querySelectorAll('.meta')[0].textContent], [null, 'engine#12'], 'a GitHub pull request is named, with no drawer to open');
  const kickoff = page.$('#main .agent[data-handle="' + handle(2) + '"]');
  assert.deepEqual([kickoff.querySelector('.ticket-ref').textContent, kickoff.querySelector('.ref').textContent], ['ABC-2753', 'engine!58']);
  const css = await readFile(new URL('./31-agents.css', import.meta.url), 'utf8');
  assert.match(css, /\.agent > \.agent-background[^{]*\{ grid-column: 2;/, 'the builders line stays in the row\'s text column rather than widening the avatar\'s');
  assert.deepEqual(page.errors, []);
});
