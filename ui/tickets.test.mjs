import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openPage } from './testkit.mjs';

const AT = '2026-11-05T12:00:00Z';
const MR_KEY = 'acme/engine!7';
const EPIC = { key: 'ABC-100', summary: 'Native access control' };

function row(extra = {}) {
  return {
    key: MR_KEY, iid: 7, repo: 'engine', title: 'Write the edge', webUrl: 'https://gitlab.com/acme/engine/-/merge_requests/7', author: 'frank', reviewers: ['ivan'],
    approvedBy: [], draft: false, pipeline: 'SUCCESS', ticket: 'ABC-12', updatedAt: AT, unresolved: 0, threads: null, mergeStatus: 'MERGEABLE', sourceBranch: 'feat/7',
    sha: 'aaa111', agentHandle: null, watch: null, flags: { mine: true }, phase: 'open', count: 0, mood: 'quiet', verdict: null, agent: null, level: null, ...extra,
  };
}

const ticket = (key, summary, status, epic, extra = {}) => ({ key, summary, status, epicRead: true, epic, mrs: [], run: null, ...extra });
const LIST = {
  read: true, loading: false, error: null, fetchedAt: AT,
  tickets: [
    ticket('ABC-12', 'Write the edge', 'In Progress', EPIC, { mrs: [{ key: MR_KEY, iid: 7, repo: 'engine', title: 'Write the edge', draft: false, author: 'frank' }] }),
    ticket('ABC-13', 'Read the edge', 'QA', EPIC),
    ticket('ABC-14', 'Loose end', 'In Progress', null),
    ticket('ABC-15', 'Not viewed yet', 'To Do', null, { epicRead: false }),
  ],
};

function detail(key = 'ABC-12', extra = {}) {
  return {
    key, summary: 'Write the edge', status: 'In Progress', type: 'Task', epic: EPIC, description: 'Problem\n<b>not markup</b>', url: 'https://example.atlassian.net/browse/' + key,
    mine: true, targets: ['To Do', 'Peer Review', 'QA'], mrs: LIST.tickets[0].mrs, run: null, ...extra,
  };
}

const KICK = 'claude:00000012-0000-4000-8000-000000000000';

function agent(state, handle = KICK) {
  return {
    handle, name: 'kickoff-ABC-12', title: 'kickoff ABC-12', kind: 'kickoff', mr: null, ticket: 'ABC-12', worktree: null, cwd: '/work',
    state, since: 1009, lastAt: Date.parse(AT), alive: state !== 'done', said: 'Which repo first?', outcome: null, ask: null,
  };
}

function snapshot({ rows = [row()], runs = [], agents = [] } = {}) {
  return {
    generatedAt: AT,
    version: { ui: 1, lib: 1, worker: 1, loaded: 1 },
    agents,
    artifacts: [],
    matrix: {
      available: true, running: false, me: 'frank', paused: false, holdSeconds: null, holdWhileReviewing: false,
      inbox: { fetchedAt: AT, loading: false, error: null, repoCount: 1, rows },
      fullAuto: [], roster: [], watches: [], verdicts: {}, queue: [], runs, autoPasses: [],
    },
  };
}

const kickoffRun = (extra = {}) => ({ key: 'ticket:ABC-12', webUrl: '', startedAt: AT, status: 'running', worktreePath: null, tail: [], terminal: KICK, live: true, working: false, kickoff: true, ...extra });

async function open({ snap = snapshot(), list = LIST, view = () => detail(), hash = 'tickets', refuse = {}, retried = list } = {}) {
  const posts = [];
  const page = await openPage({
    respond(path, init) {
      if (init?.method === 'POST') {
        posts.push([path, JSON.parse(init.body)]);
        return path === '/api/matrix/tickets/refresh' ? retried : { ok: true, text: 'Done' };
      }
      const url = new URL(path, 'http://page');
      if (url.pathname === '/api/matrix/tickets') return list;
      if (url.pathname === '/api/matrix/ticket') return view(url.searchParams.get('key'));
      if (url.pathname === '/api/matrix/own-mrs') return { mrs: {} };
      if (url.pathname === '/api/agents/conversation') return { ...agent('done'), pending: null, entries: [{ kind: 'said', at: 1, text: 'Which repo first?' }] };
      return null;
    },
  });
  const plain = page.window.fetch;
  page.window.fetch = async (path, init) => (await refuse[path]?.()) ?? plain(path, init);
  page.show(snap, hash);
  await page.settle(60);
  return Object.assign(page, { posts });
}

const failing = (status, text) => ({ ok: false, status, text: async () => text, json: async () => { throw new Error('not JSON'); } });
const groups = (p) => p.$$('#main .ticket-group').map((g) => [g.querySelector('h2').textContent, g.querySelectorAll('.ticket-row').map((r) => r.dataset.key)]);
const chipLabels = (p) => p.$$('#main .filters .chips .chip').map((c) => c.textContent);
const drawerButton = (p, label) => p.$$('#drawer button').find((b) => b.textContent === label) ?? null;

test('the Tickets view groups your tickets by epic, with the epics not read yet and no epic last, and offers each status as a chip', async () => {
  const p = await open();
  assert.deepEqual(groups(p), [
    ['Native access controlABC-1002 tickets', ['ABC-12', 'ABC-13']],
    ['No epic1 ticket', ['ABC-14']],
    ['Epic not read yet1 ticket', ['ABC-15']],
  ]);
  assert.deepEqual(chipLabels(p), ['All (4)', 'In Progress (2)', 'QA (1)', 'To Do (1)']);
  const first = p.$$('#main .ticket-row')[0];
  assert.equal(first.querySelector('.pill').textContent, 'In Progress');
  assert.deepEqual(first.querySelectorAll('.ticket-mrs .ref').map((r) => [r.dataset.key, r.textContent]), [[MR_KEY, 'engine !7']]);
  assert.deepEqual(p.errors, []);
});

test('a status chip and the search narrow the list', async () => {
  const p = await open();
  const chip = (label) => p.$$('#main .chips .chip').find((c) => c.textContent.startsWith(label));
  chip('In Progress').click();
  assert.deepEqual(groups(p).map(([, keys]) => keys), [['ABC-12'], ['ABC-14']]);
  chip('All').click();
  const box = p.$('#ticket-q');
  box.value = 'access';
  p.fire(box, 'input');
  assert.deepEqual(groups(p).map(([, keys]) => keys), [['ABC-12', 'ABC-13']], 'the epic name is searched too');
  box.value = 'nothing like it';
  p.fire(box, 'input');
  assert.match(p.$('#main').textContent, /No ticket matches\./);
});

test('a Jira that cannot be read is said plainly, with the last list kept when there is one', async () => {
  const down = await open({ list: { read: false, loading: false, error: 'Jira did not answer acli within 30 s', fetchedAt: AT, tickets: [] } });
  assert.match(down.$('#main .banner.warn').textContent, /Jira cannot be read right now, so there is no list to show\. acli said: Jira did not answer acli within 30 s/);
  assert.equal(down.$$('#main .ticket-row').length, 0);
  const stale = await open({ list: { ...LIST, error: 'Unauthorized' } });
  assert.match(stale.$('#main .banner.warn').textContent, /Jira cannot be read right now, so this is the list from .*acli said: Unauthorized/);
  assert.equal(stale.$$('#main .ticket-row').length, 4);
});

const DOWN = { read: false, loading: false, error: 'Jira did not answer acli within 90 s', fetchedAt: AT, tickets: [] };

test('Retry now on the Jira banner asks the worker to read Jira again at once, and cannot be pressed again while it reads', async () => {
  const p = await open({ list: DOWN, retried: { ...DOWN, loading: true } });
  const retry = p.$('#main .banner.warn #tickets-retry');
  assert.equal(retry.textContent, 'Retry now');
  retry.click();
  assert.equal(p.$('#tickets-retry').disabled, true, 'pressed, it is busy before the worker answers');
  await p.settle(60);
  assert.deepEqual(p.posts, [['/api/matrix/tickets/refresh', {}]]);
  assert.deepEqual([p.$('#tickets-retry').disabled, p.$('#tickets-retry').textContent], [true, 'Reading…']);
  const stale = await open({ list: { ...LIST, error: 'Unauthorized' } });
  assert.equal(stale.$('#main .banner.warn #tickets-retry').textContent, 'Retry now', 'an old list kept on screen can be retried too');
});

test('with no list yet the page asks the worker again within seconds, so it does not hold back a retry, and with one it waits', async () => {
  const asks = (p) => p.requested.filter((r) => r === '/api/matrix/tickets').length;
  const down = await open({ list: DOWN });
  const before = asks(down);
  down.run('ui.tickets.at -= 4000; render()');
  await down.settle(30);
  assert.equal(asks(down), before + 1);
  const listed = await open();
  const seen = asks(listed);
  listed.run('ui.tickets.at -= 4000; render()');
  await listed.settle(30);
  assert.equal(asks(listed), seen);
});

test('the ticket chip on an MR row is a button with the status, and opens the ticket drawer over the page', async () => {
  const p = await open({ hash: 'merge-requests' });
  await p.settle(60);
  p.run('render()');
  const chip = p.$$('#main .ticket-ref').find((b) => b.dataset.ticket === 'ABC-12');
  assert.equal(chip.tagName, 'BUTTON');
  assert.equal(chip.textContent, 'ABC-12In Progress');
  chip.click();
  await p.settle(60);
  assert.equal(p.$('#drawer').hidden, false);
  assert.equal(p.$('#drawer .drawer').getAttribute('aria-label'), 'Ticket ABC-12');
  assert.ok(p.requested.includes('/api/matrix/ticket?key=ABC-12'));
  assert.equal(p.$('#drawer .ticket-desc').textContent, 'Problem\n<b>not markup</b>', 'the description is text');
  assert.equal(p.$('#drawer .ticket-desc').querySelectorAll('b').length, 0);
  p.run("closeDrawer()");
  assert.equal(p.$('#drawer').hidden, true);
});

test('Move offers only the moves Jira offers, takes two clicks naming the target, and sends the status the page saw', async () => {
  const p = await open();
  p.run("openTicket('ABC-12')");
  await p.settle(60);
  const select = p.$('#drawer #ticket-move-to');
  assert.deepEqual(select.querySelectorAll('option').map((o) => o.textContent), ['Move to…', 'To Do', 'Peer Review', 'QA']);
  assert.ok(!drawerButton(p, 'Move'), 'nothing to move to yet');
  select.value = 'QA';
  p.fire(select, 'change', { target: select });
  drawerButton(p, 'Move').click();
  assert.equal(p.$('#drawer button.armed').textContent, 'Move ABC-12 to QA?');
  assert.deepEqual(p.posts, []);
  p.$('#drawer button.armed').click();
  await p.settle(60);
  assert.deepEqual(p.posts, [['/api/matrix/ticket-status', { key: 'ABC-12', status: 'QA', expect: { status: 'In Progress' } }]]);
});

test('a move refused because the status changed says so, sends nothing more and reads the ticket again', async () => {
  const p = await open({ refuse: { '/api/matrix/ticket-status': () => failing(409, 'the status of ABC-12 changed since you looked') } });
  p.run("openTicket('ABC-12')");
  await p.settle(60);
  const select = p.$('#drawer #ticket-move-to');
  select.value = 'QA';
  p.fire(select, 'change', { target: select });
  const reads = () => p.requested.filter((r) => r === '/api/matrix/ticket?key=ABC-12').length;
  const before = reads();
  drawerButton(p, 'Move').click();
  p.$('#drawer button.armed').click();
  await p.settle(400);
  assert.match(p.$('#toast').textContent, /the status of ABC-12 changed since you looked/);
  assert.equal(p.$$('#drawer button.armed').length, 0);
  assert.ok(reads() > before, 'the drawer reads the ticket again');
});

test('Start with an agent takes two clicks naming the ticket, then the drawer shows its Agent tab', async () => {
  const p = await open();
  p.run("openTicket('ABC-12')");
  await p.settle(60);
  drawerButton(p, 'Start with an agent').click();
  assert.equal(p.$('#drawer button.armed').textContent, 'Start ABC-12 with an agent?');
  assert.deepEqual(p.posts, []);
  p.$('#drawer button.armed').click();
  await p.settle(60);
  assert.deepEqual(p.posts, [['/api/matrix/ticket-start', { key: 'ABC-12' }]]);
  assert.equal(p.$('#drawer #ticket-tab-agent').getAttribute('aria-selected'), 'true');
});

test('a ticket not yours offers no move and no start', async () => {
  const p = await open({ view: (key) => detail(key, { mine: false, targets: [] }) });
  p.run("openTicket('ABC-99')");
  await p.settle(60);
  assert.ok(!p.$('#drawer #ticket-move-to'));
  assert.ok(!drawerButton(p, 'Start with an agent'));
  assert.match(p.$('#drawer').textContent, /ABC-99 is not one of your open tickets/);
});

test('while its kickoff agent is open the ticket offers its Agent tab rather than a second start, where you answer it', async () => {
  const run = kickoffRun();
  const list = { ...LIST, tickets: [{ ...LIST.tickets[0], run }, ...LIST.tickets.slice(1)] };
  const p = await open({ snap: snapshot({ runs: [run], agents: [agent('done')] }), list, view: () => detail('ABC-12', { run }) });
  assert.match(p.$$('#main .ticket-row')[0].textContent, /agent asks you/);
  p.run("openTicket('ABC-12')");
  await p.settle(60);
  assert.ok(!drawerButton(p, 'Start with an agent'));
  p.run("openTicket('ABC-12', 'agent')");
  await p.settle(60);
  assert.ok(p.$('#drawer .agent.s-need'), 'the agent row is there to answer, marked as needing you');
  assert.ok(p.document.getElementById('agent-reply-' + KICK));
});

test('a kickoff agent that ended its turn on a question reads as needing you, and a finished turn or a TUI ticket agent does not', async () => {
  const p = await open({ snap: snapshot({ runs: [kickoffRun()], agents: [agent('done')] }), hash: 'agents' });
  assert.equal(p.run("isNeed(derive().agents[0])"), true);
  p.show(snapshot({ runs: [], agents: [agent('done')] }), 'agents');
  assert.equal(p.run("isNeed(derive().agents[0])"), false, 'on no ticket run');
  p.show(snapshot({ runs: [kickoffRun({ kickoff: false })], agents: [agent('done')] }), 'agents');
  assert.equal(p.run("isNeed(derive().agents[0])"), false, 'a ticket agent the TUI started raises its own MR');
  p.show(snapshot({ runs: [kickoffRun()], agents: [{ ...agent('done'), said: 'Raised !12 for ABC-12.' }] }), 'agents');
  assert.equal(p.run("isNeed(derive().agents[0])"), false, 'a turn that ended on no question');
});

test('a run on the Review runs page opens its ticket in place', async () => {
  const p = await open({ snap: snapshot({ runs: [kickoffRun({ live: false, terminal: null })] }), hash: 'review-runs' });
  const ref = p.$$('#main .ticket-ref').find((b) => b.dataset.ticket === 'ABC-12');
  ref.click();
  await p.settle(60);
  assert.equal(p.$('#drawer .drawer').getAttribute('aria-label'), 'Ticket ABC-12');
});
