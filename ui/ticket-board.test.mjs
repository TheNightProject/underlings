import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { openPage } from './testkit.mjs';

const AT = '2026-11-05T12:00:00Z';
const MR_KEY = 'acme/engine!7';
const A = { key: 'ABC-100', summary: 'Native access control' };
const B = { key: 'ABC-200', summary: 'Board work' };
const ABC = ['To Do', 'In Progress', 'Blocked', 'Peer Review', 'Design QA', 'QA', 'Release Ready', 'Mystery', 'Done', 'Not Required'];

function ticket(key, summary, status, epic, extra = {}) {
  return { key, summary, status, epicRead: true, epic, mrs: [], run: null, targets: ABC.filter((s) => s !== status), suggest: null, ...extra };
}

function tickets() {
  return [
    ticket('ABC-11', 'Plan the edge', 'To Do', A, { targets: ['In Progress', 'Peer Review', 'QA'] }),
    ticket('ABC-12', 'Write the edge', 'In Progress', A, { mrs: [{ key: MR_KEY, iid: 7, repo: 'engine', title: 'Write the edge', draft: false, author: 'frank' }], suggest: { status: 'Peer Review', why: '!7 is in review' } }),
    ticket('ABC-13', 'Read the edge', 'Peer Review', B, { run: kickoffRun() }),
    ticket('ABC-14', 'Test the edge', 'QA', null, { suggest: { status: 'Done', why: '!4 merged in tooling' } }),
    ticket('ABC-15', 'Stuck on access', 'Blocked', B),
    ticket('ABC-16', 'Odd one', 'Mystery', null),
    ticket('ABC-17', 'Design check', 'Design QA', A),
    ticket('ABC-18', 'Not viewed yet', 'In Progress', null, { epicRead: false, suggest: { status: 'QA', why: '2 MRs merged' } }),
  ];
}

function kickoffRun() {
  return { status: 'running', terminal: 'term_kick', startedAt: AT, tail: [] };
}

function snapshot() {
  const agent = { handle: 'term_kick', name: 'kickoff-ABC-13', title: 'kickoff ABC-13', kind: 'kickoff', mr: null, ticket: 'ABC-13', worktree: null, cwd: '/work', state: 'working', since: 1009, lastAt: Date.parse(AT), alive: true, said: '', outcome: null, ask: null };
  const row = {
    key: MR_KEY, iid: 7, repo: 'engine', title: 'Write the edge', webUrl: 'https://gitlab.com/acme/engine/-/merge_requests/7', author: 'frank', reviewers: ['ivan'],
    approvedBy: [], draft: false, pipeline: 'SUCCESS', ticket: 'ABC-12', updatedAt: AT, unresolved: 0, threads: null, mergeStatus: 'MERGEABLE', sourceBranch: 'feat/7',
    sha: 'aaa111', agentHandle: null, watch: null, flags: { mine: true }, phase: 'open', count: 0, mood: 'quiet', verdict: null, agent: null, level: null,
  };
  return {
    generatedAt: AT,
    version: { ui: 1, lib: 1, worker: 1, loaded: 1 },
    agents: [agent],
    artifacts: [],
    matrix: {
      available: true, running: false, me: 'frank', paused: false, holdSeconds: null, holdWhileReviewing: false,
      inbox: { fetchedAt: AT, loading: false, error: null, repoCount: 1, rows: [row] },
      fullAuto: [], roster: [], watches: [], verdicts: {}, queue: [], runs: [{ key: 'ticket:ABC-13', kickoff: true, status: 'running', terminal: 'term_kick', startedAt: AT, tail: [] }], autoPasses: [],
    },
  };
}

function memory(initial = {}) {
  const data = { ...initial };
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = String(v); } };
}

const failing = (status, text) => ({ ok: false, status, text: async () => text, json: async () => { throw new Error('not JSON'); } });
const answer = (body) => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) });

// Each POST waits on its own reply, so a test can hold one open and see that nothing else is sent meanwhile.
async function open({ store = memory({ 'cc.ticketLayout': 'board' }), move = () => null, list = tickets() } = {}) {
  const posts = [];
  let inFlight = 0;
  let mostAtOnce = 0;
  const page = await openPage({
    respond(path) {
      const url = new URL(path, 'http://page');
      if (url.pathname === '/api/matrix/tickets') return { read: true, loading: false, error: null, mergedError: null, fetchedAt: AT, tickets: list };
      if (url.pathname === '/api/matrix/ticket') return { ...list.find((x) => x.key === url.searchParams.get('key')), type: 'Task', description: '', url: 'https://example.atlassian.net/browse/x', mine: true };
      if (url.pathname === '/api/matrix/own-mrs') return { mrs: {} };
      return null;
    },
  });
  page.window.localStorage = store;
  const plain = page.window.fetch;
  page.window.fetch = async (path, init) => {
    if (init?.method !== 'POST') return plain(path, init);
    const body = JSON.parse(init.body);
    posts.push([path, body]);
    inFlight += 1;
    mostAtOnce = Math.max(mostAtOnce, inFlight);
    try {
      const reply = await move(body);
      if (reply) return reply;
      const t = list.find((x) => x.key === body.key);
      if (t) t.status = body.status;
      return answer({ ok: true, text: 'Moved ' + body.key + ' to ' + body.status });
    } finally {
      inFlight -= 1;
    }
  };
  page.show(snapshot(), 'tickets');
  await page.settle(60);
  return Object.assign(page, { posts, list, mostAtOnce: () => mostAtOnce });
}

const lanes = (p) => p.$$('#main .ticket-board .lane').map((l) => [l.dataset.lane, l.querySelectorAll('.ticket-card').map((c) => c.dataset.key)]);
const laneOf = (p, key) => card(p, key)?.closest('.lane').dataset.lane;
const card = (p, key) => p.$$('#main .ticket-card').find((c) => c.dataset.key === key) ?? null;
const lane = (p, status) => p.$$('#main .ticket-board .lane').find((l) => l.dataset.lane === status);
const cardKeys = (p) => p.$$('#main .ticket-card').map((c) => c.dataset.key).sort();
const listKeys = (p) => p.$$('#main .ticket-row').map((r) => r.dataset.key).sort();
const byId = (p, id) => p.document.getElementById(id);
const buttonIn = (node, label) => node.querySelectorAll('button').find((b) => b.textContent === label) ?? null;

function transfer() {
  const data = {};
  return { data, types: [], effectAllowed: '', dropEffect: '', setData(type, value) { this.types.push(type); data[type] = value; } };
}

function drag(p, key) {
  const dt = transfer();
  p.fire(card(p, key), 'dragstart', { dataTransfer: dt });
  return dt;
}

// fire() reports whether the default went ahead, so a lane that takes the drop is one that prevented it.
const takes = (p, status, dt) => !p.fire(lane(p, status), 'dragover', { dataTransfer: dt });

function drop(p, key, status) {
  const dt = drag(p, key);
  p.fire(lane(p, status), 'dragover', { dataTransfer: dt });
  p.fire(lane(p, status), 'drop', { dataTransfer: dt });
  p.fire(card(p, key) ?? lane(p, status), 'dragend', { dataTransfer: dt });
}

test('the board has a column per status, the usual four and Blocked first, then any other status in the list, each card in its own', async () => {
  const p = await open();
  assert.deepEqual(lanes(p), [
    ['To Do', ['ABC-11']], ['In Progress', ['ABC-12', 'ABC-18']], ['Peer Review', ['ABC-13']], ['QA', ['ABC-14']], ['Blocked', ['ABC-15']],
    ['Design QA', ['ABC-17']], ['Mystery', ['ABC-16']],
  ]);
  assert.deepEqual(p.$$('#main .ticket-board .lane h2').map((h) => h.textContent), ['To Do1', 'In Progress2', 'Peer Review1', 'QA1', 'Blocked1', 'Design QA1', 'Mystery1']);
  assert.equal(p.$('#main .ticket-board').parentNode.id, 'main', 'the board fills main as the MR board does');
  assert.deepEqual(p.errors, []);
});

test('an empty column stays with a quiet line, and Done never shows', async () => {
  const p = await open({ list: [ticket('ABC-14', 'Test the edge', 'QA', null)] });
  assert.deepEqual(lanes(p).map(([s]) => s), ['To Do', 'In Progress', 'Peer Review', 'QA', 'Blocked']);
  assert.deepEqual(p.$$('#main .lane-empty').map((e) => e.closest('.lane').dataset.lane), ['To Do', 'In Progress', 'Peer Review', 'Blocked']);
  assert.equal(lane(p, 'To Do').querySelector('h2 .pill').textContent, '0');
});

test('List and Board switch the view, the choice is kept apart from the MR board\'s, and a browser that refuses storage still switches', async () => {
  const store = memory({ 'cc.mrLayout': 'board' });
  const p = await open({ store });
  assert.ok(!p.$('#main .ticket-board'), 'the tickets open as a list although the MR board is remembered');
  assert.equal(p.$('#ticket-layout-list').getAttribute('aria-pressed'), 'true');
  p.$('#ticket-layout-board').click();
  assert.ok(p.$('#main .ticket-board') && !p.$('#main .ticket-group'), 'the board takes the list\'s place');
  assert.deepEqual(store.data, { 'cc.mrLayout': 'board', 'cc.ticketLayout': 'board' });
  const again = await open({ store });
  assert.ok(again.$('#main .ticket-board'), 'opens on the board next time');
  again.$('#ticket-layout-list').click();
  assert.deepEqual(store.data, { 'cc.mrLayout': 'board', 'cc.ticketLayout': 'list' });
  const blocked = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };
  const refused = await open({ store: blocked });
  refused.$('#ticket-layout-board').click();
  assert.ok(refused.$('#main .ticket-board'));
  assert.deepEqual(refused.errors, []);
});

test('the status chips, the search and the epic picker leave the same tickets on the board as in the list', async () => {
  const p = await open();
  const filters = [
    "ui.tickets.filter = 'In Progress'", "ui.tickets.search = 'edge'", "ui.tickets.search = 'board work'", "ui.tickets.epic = 'ABC-100'",
    "ui.tickets.epic = '~none'", "ui.tickets.epic = '~reading'", "ui.tickets.epic = 'ABC-100'; ui.tickets.filter = 'In Progress'", "ui.tickets.epic = 'ABC-200'; ui.tickets.search = 'stuck'",
  ];
  for (const set of filters) {
    p.run("Object.assign(ui.tickets, { filter: 'all', search: '', epic: '', layout: 'list' }); " + set + '; render()');
    const listed = listKeys(p);
    assert.ok(listed.length > 0 && listed.length < p.list.length, set + ' narrows the list');
    p.run("ui.tickets.layout = 'board'; render()");
    assert.deepEqual(cardKeys(p), listed, set);
  }
});

test('the epic picker names each epic with its count, in the list\'s order, and narrows the board when picked', async () => {
  const p = await open();
  const picker = p.$('#ticket-epic');
  assert.deepEqual(picker.querySelectorAll('option').map((o) => [o.getAttribute('value'), o.textContent]), [
    ['', 'Every epic'], ['ABC-200', 'Board work (2)'], ['ABC-100', 'Native access control (3)'], ['~none', 'No epic (2)'], ['~reading', 'Epic not read yet (1)'],
  ]);
  picker.value = 'ABC-200';
  p.fire(picker, 'change', { target: picker });
  assert.deepEqual(cardKeys(p), ['ABC-13', 'ABC-15']);
  assert.deepEqual(lanes(p).map(([s]) => s), ['To Do', 'In Progress', 'Peer Review', 'QA', 'Blocked', 'Design QA', 'Mystery'], 'the columns stay while the cards narrow');
});

test('a card has its key, which opens the ticket, the summary, the epic, its open MRs, which open the MR, and its kickoff agent', async () => {
  const p = await open();
  const c = card(p, 'ABC-12');
  assert.equal(c.querySelector('.ticket-ref').textContent, 'ABC-12');
  assert.equal(c.querySelector('.card-summary').textContent, 'Write the edge');
  assert.equal(c.querySelector('.epic-label').textContent, 'Native access control');
  assert.deepEqual(c.querySelectorAll('.ticket-mrs .ref').map((r) => [r.dataset.key, r.textContent]), [[MR_KEY, 'engine !7']]);
  assert.match(card(p, 'ABC-13').querySelector('.card-head').textContent, /agent working/);
  assert.equal(card(p, 'ABC-12').querySelector('.card-head').textContent, 'ABC-12', 'no agent chip without a kickoff agent');
  c.querySelector('.ticket-mrs .ref').click();
  assert.equal(p.run('ui.mr.key'), MR_KEY);
  p.run('closeDrawer()');
  card(p, 'ABC-12').querySelector('.ticket-ref').click();
  await p.settle(60);
  assert.equal(p.$('#drawer .drawer').getAttribute('aria-label'), 'Ticket ABC-12');
  assert.deepEqual(p.posts, []);
});

test('cards take focus, Enter on one opens its ticket, and closing the drawer gives focus back to that card', async () => {
  const p = await open();
  const c = card(p, 'ABC-15');
  assert.equal(c.getAttribute('tabindex'), '0');
  c.focus();
  p.fire(c, 'keydown', { key: 'Enter' });
  await p.settle(60);
  assert.ok(p.$('#drawer').contains(p.document.activeElement), 'the drawer took focus');
  p.fire(p.document.activeElement, 'keydown', { key: 'Escape' });
  assert.equal(p.document.activeElement.dataset.key, 'ABC-15');
  assert.ok(p.document.activeElement.classList.contains('ticket-card'));
  card(p, 'ABC-12').querySelector('.ticket-ref').click();
  await p.settle(60);
  p.run('closeDrawer()');
  assert.equal(p.document.activeElement, card(p, 'ABC-12'), 'opened from the key, focus comes back to its card');
  p.run('render(true)');
  assert.equal(p.document.activeElement, card(p, 'ABC-12'), 'a card keeps focus through the page drawing itself again');
  card(p, 'ABC-12').querySelector('.ticket-ref').focus();
  p.run('render(true)');
  assert.equal(p.document.activeElement, card(p, 'ABC-12').querySelector('.ticket-ref'), 'and so does its key');
});

test('while a card is dragged only the columns Jira offers it take the drop, and a drag from elsewhere is taken by none', async () => {
  const p = await open();
  const dt = drag(p, 'ABC-11');
  assert.deepEqual(dt.types, ['application/x-cc-ticket']);
  assert.deepEqual(lanes(p).map(([s]) => [s, lane(p, s).dataset.drop]), [
    ['To Do', 'no'], ['In Progress', 'yes'], ['Peer Review', 'yes'], ['QA', 'yes'], ['Blocked', 'no'], ['Design QA', 'no'], ['Mystery', 'no'],
  ]);
  assert.deepEqual(lanes(p).map(([s]) => s).filter((s) => takes(p, s, dt)), ['In Progress', 'Peer Review', 'QA']);
  const stray = transfer();
  stray.setData('text/plain', 'ABC-11');
  assert.equal(takes(p, 'QA', stray), false, 'a drag that did not start on a card, even while a card drag has not ended');
  p.fire(card(p, 'ABC-11'), 'dragend', { dataTransfer: dt });
  assert.deepEqual(p.$$('#main .lane').filter((l) => l.hasAttribute('data-drop')), [], 'the marks go when the drag ends');
  assert.equal(takes(p, 'QA', dt), false, 'nor once it has');
  p.fire(lane(p, 'Blocked'), 'drop', { dataTransfer: dt });
  assert.equal(laneOf(p, 'ABC-11'), 'To Do');
  assert.deepEqual(p.posts, []);
});

test('a drop never moves on its own: the card waits in its new column on the same two-click confirm as the drawer', async () => {
  const p = await open();
  drop(p, 'ABC-12', 'QA');
  assert.equal(laneOf(p, 'ABC-12'), 'QA');
  const move = byId(p, 'g-ticket-move:ABC-12');
  assert.equal(move.textContent, 'Move to QA');
  assert.equal(p.document.activeElement, move, 'focus goes to the confirm');
  await p.settle(60);
  assert.deepEqual(p.posts, []);
  move.click();
  assert.equal(byId(p, 'g-ticket-move:ABC-12').textContent, 'Move ABC-12 to QA?');
  assert.deepEqual(p.posts, [], 'one click only arms it');
  byId(p, 'g-ticket-move:ABC-12').click();
  await p.settle(60);
  assert.deepEqual(p.posts, [['/api/matrix/ticket-status', { key: 'ABC-12', status: 'QA', expect: { status: 'In Progress' } }]]);
  assert.equal(laneOf(p, 'ABC-12'), 'QA');
  assert.ok(!byId(p, 'g-ticket-move:ABC-12'), 'nothing left to confirm');
  assert.equal(p.$('#toast').textContent, 'Moved ABC-12 to QA');
});

test('Cancel puts the card back where it was, with focus on it, and sends nothing', async () => {
  const p = await open();
  drop(p, 'ABC-12', 'Blocked');
  byId(p, 'g-ticket-move:ABC-12').click();
  p.$('#ticket-cancel-ABC-12').click();
  assert.equal(laneOf(p, 'ABC-12'), 'In Progress');
  assert.equal(p.document.activeElement, card(p, 'ABC-12'));
  assert.ok(!byId(p, 'g-ticket-move:ABC-12'));
  assert.equal(p.run('ui.armed'), null);
  await p.settle(60);
  assert.deepEqual(p.posts, []);
});

test('a move the worker refuses puts the card back and says why on it', async () => {
  for (const [status, words] of [[409, 'the status of ABC-12 changed since you looked'], [502, 'Transition not valid for ABC-12']]) {
    const p = await open({ move: () => failing(status, words) });
    drop(p, 'ABC-12', 'Peer Review');
    byId(p, 'g-ticket-move:ABC-12').click();
    byId(p, 'g-ticket-move:ABC-12').click();
    await p.settle(60);
    assert.equal(p.posts.length, 1);
    assert.equal(laneOf(p, 'ABC-12'), 'In Progress', status + ' puts it back');
    assert.equal(card(p, 'ABC-12').querySelector('.bad').textContent, 'Not moved: ' + words);
    assert.match(p.$('#toast').textContent, new RegExp(words));
  }
});

test('Move to on a card does the same from the keyboard, offering only the columns that would take it', async () => {
  const p = await open();
  const menu = p.$('#ticket-card-move-ABC-11');
  assert.deepEqual(menu.querySelectorAll('option').map((o) => o.textContent), ['Move to…', 'In Progress', 'Peer Review', 'QA']);
  menu.focus();
  menu.value = 'Peer Review';
  p.fire(menu, 'change', { target: menu });
  assert.equal(laneOf(p, 'ABC-11'), 'Peer Review');
  assert.equal(p.document.activeElement, byId(p, 'g-ticket-move:ABC-11'));
  assert.deepEqual(p.posts, []);
  p.fire(p.document.activeElement, 'click');
  byId(p, 'g-ticket-move:ABC-11').click();
  await p.settle(60);
  assert.deepEqual(p.posts, [['/api/matrix/ticket-status', { key: 'ABC-11', status: 'Peer Review', expect: { status: 'To Do' } }]]);
});

test('a ticket whose status changes under a waiting move takes its real place and drops the confirm', async () => {
  const p = await open();
  drop(p, 'ABC-12', 'QA');
  p.list.find((x) => x.key === 'ABC-12').status = 'Blocked';
  p.run('ui.tickets.at = 0; render()');
  await p.settle(60);
  assert.equal(laneOf(p, 'ABC-12'), 'Blocked');
  assert.ok(!byId(p, 'g-ticket-move:ABC-12'));
});

test('the card offers the move its MRs suggest, naming it and why, on two clicks that send the status the page saw', async () => {
  const p = await open();
  const id = 'g-ticket-suggest:ABC-12';
  assert.equal(byId(p, id).textContent, 'Move to Peer Review: !7 is in review');
  assert.ok(!card(p, 'ABC-11').querySelectorAll('button').some((b) => b.id.startsWith('g-ticket-suggest')), 'no button without a suggestion');
  byId(p, id).click();
  assert.equal(byId(p, id).textContent, 'Move ABC-12 to Peer Review?');
  assert.deepEqual(p.posts, []);
  byId(p, id).click();
  await p.settle(60);
  assert.deepEqual(p.posts, [['/api/matrix/ticket-status', { key: 'ABC-12', status: 'Peer Review', expect: { status: 'In Progress' } }]]);
});

test('the list row and the drawer offer the same suggestion', async () => {
  const p = await open({ store: memory() });
  const row = p.$$('#main .ticket-row').find((r) => r.dataset.key === 'ABC-14');
  assert.equal(buttonIn(row, 'Move to Done: !4 merged in tooling')?.id, 'g-ticket-suggest:ABC-14');
  p.run("openTicket('ABC-14')");
  await p.settle(60);
  const offered = buttonIn(p.$('#drawer'), 'Move to Done: !4 merged in tooling');
  offered.click();
  p.$$('#drawer button').find((b) => b.id === 'g-ticket-suggest:ABC-14').click();
  await p.settle(60);
  assert.deepEqual(p.posts, [['/api/matrix/ticket-status', { key: 'ABC-14', status: 'Done', expect: { status: 'QA' } }]]);
});

test('Sync statuses lists every suggested move, and one line moves on its own two clicks', async () => {
  const p = await open({ store: memory() });
  assert.equal(p.$('#ticket-sync').textContent, 'Sync statuses (3)');
  p.$('#ticket-sync').click();
  const lines = () => p.$$('#main .ticket-sync-line').map((l) => l.textContent);
  assert.deepEqual(lines(), ['ABC-12In Progress to Peer Review: !7 is in reviewMove', 'ABC-14QA to Done: !4 merged in toolingMove', 'ABC-18In Progress to QA: 2 MRs mergedMove']);
  const one = byId(p, 'g-ticket-sync:ABC-14');
  one.click();
  assert.equal(byId(p, 'g-ticket-sync:ABC-14').textContent, 'Move ABC-14 to Done?');
  assert.deepEqual(p.posts, []);
  byId(p, 'g-ticket-sync:ABC-14').click();
  await p.settle(60);
  assert.deepEqual(p.posts, [['/api/matrix/ticket-status', { key: 'ABC-14', status: 'Done', expect: { status: 'QA' } }]]);
  assert.equal(lines()[1], 'ABC-14QA to Done: !4 merged in toolingmoved');
  assert.equal(byId(p, 'g-ticket-sync-all').textContent, 'Apply all 2');
});

test('Sync all names the count, moves one at a time, and a refusal in the middle says why on its line while the rest carry on', async () => {
  const replies = { 'ABC-12': () => failing(409, 'the status of ABC-12 changed since you looked'), 'ABC-14': () => failing(502, 'Transition not valid for ABC-14') };
  const p = await open({ store: memory(), move: async (body) => { await new Promise((r) => setTimeout(r, 60)); return replies[body.key]?.() ?? null; } });
  p.$('#ticket-sync').click();
  byId(p, 'g-ticket-sync-all').click();
  assert.equal(byId(p, 'g-ticket-sync-all').textContent, 'Move 3 tickets?');
  assert.deepEqual(p.posts, []);
  byId(p, 'g-ticket-sync-all').click();
  await p.settle(20);
  assert.deepEqual(p.$$('#main .ticket-sync-line').map((l) => l.textContent.split(': ').pop()), ['!7 is in reviewmoving', '!4 merged in toolingwaiting', '2 MRs mergedwaiting']);
  assert.equal(p.$$('#main .ticket-sync button').filter((b) => b.id.startsWith('g-')).length, 0, 'nothing else can be sent while they go');
  await p.settle(400);
  assert.deepEqual(p.posts.map(([, body]) => body), [
    { key: 'ABC-12', status: 'Peer Review', expect: { status: 'In Progress' } },
    { key: 'ABC-14', status: 'Done', expect: { status: 'QA' } },
    { key: 'ABC-18', status: 'QA', expect: { status: 'In Progress' } },
  ]);
  assert.equal(p.mostAtOnce(), 1, 'one move at a time');
  const results = p.$$('#main .ticket-sync-line').map((l) => [l.dataset.key, l.querySelector('.pill').textContent, l.querySelector('.meta')?.textContent ?? '']);
  assert.deepEqual(results, [
    ['ABC-12', 'skipped', 'the status of ABC-12 changed since you looked'],
    ['ABC-14', 'refused', 'Transition not valid for ABC-14'],
    ['ABC-18', 'moved', ''],
  ]);
  assert.ok(!byId(p, 'g-ticket-sync-all'), 'nothing left to apply');
});

test('Sync statuses waits for the list, and says so when there is nothing to move or GitLab could not be read for merged MRs', async () => {
  const early = await openPage();
  early.show(snapshot(), 'tickets');
  assert.ok(!early.$('#ticket-sync'), 'not offered before the tickets are read');
  const p = await open({ store: memory(), list: [ticket('ABC-11', 'Plan the edge', 'To Do', A)] });
  assert.equal(p.$('#ticket-sync').textContent, 'Sync statuses');
  p.run("ui.tickets.data.mergedError = 'GitLab 500 Server Error'");
  p.$('#ticket-sync').click();
  assert.match(p.$('#main .ticket-sync').textContent, /Every ticket's status already matches its MRs\./);
  assert.match(p.$('#main .ticket-sync').textContent, /no move to QA or Done is suggested: GitLab 500 Server Error/);
  p.$('#ticket-sync').click();
  assert.ok(!p.$('#main .ticket-sync'));
});

test('at phone width the ticket board stacks its columns, as the MR board does', async () => {
  const css = await readFile(new URL('./12-kanban.css', import.meta.url), 'utf8');
  const narrow = css.match(/@media \(max-width: 780px\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  assert.match(narrow, /\.kanban \{ grid-auto-flow: row;/);
  const p = await open();
  assert.ok(p.$('#main .kanban.ticket-board'), 'the ticket board is a kanban, so the rule applies');
});
