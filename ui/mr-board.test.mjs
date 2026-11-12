import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { openPage } from './testkit.mjs';

const AT = new Date().toISOString();
const DAYS_AGO = (n) => new Date(Date.now() - n * 864e5).toISOString();

function row(iid, extra = {}) {
  const repo = extra.repo ?? 'engine';
  return {
    key: 'acme/' + repo + '!' + iid, iid, repo, title: 'Change ' + iid, webUrl: 'https://gitlab.com/acme/' + repo + '/-/merge_requests/' + iid, author: 'ivan', reviewers: ['frank'],
    approvedBy: [], draft: false, pipeline: 'SUCCESS', ticket: null, createdAt: DAYS_AGO(3), updatedAt: AT, unresolved: 0, threads: null, mergeStatus: 'NOT_APPROVED',
    sourceBranch: 'feat/' + iid, sha: 'aaa' + iid, agentHandle: null, watch: null, flags: {}, phase: 'open', count: 0, mood: 'quiet', verdict: null, agent: null, level: null, reviewStates: null,
    ...extra,
  };
}

const ROWS = [
  row(1, { draft: true, flags: { mine: true }, author: 'frank', mood: 'unreviewed' }),
  row(2, { pipeline: 'FAILED', flags: { waitingOnYou: true }, mood: 'awaitingYou', repo: 'web' }),
  row(3, { unresolved: 2, author: 'judy', reviewers: ['frank', 'rupert'], pipeline: 'RUNNING', flags: { waitingOnYou: true }, mood: 'awaitingYou' }),
  row(4, { approvedBy: ['rupert'], mergeStatus: 'MERGEABLE', author: 'judy', mood: 'approved', repo: 'web' }),
  row(5, { approvedBy: ['rupert'], mergeStatus: 'CI_STILL_RUNNING', pipeline: 'RUNNING', flags: { watched: true }, mood: 'approved' }),
  row(6, { title: 'Tidy the docs', author: 'rupert', mood: 'quiet', repo: 'web' }),
];

function snapshot(rows = ROWS) {
  return {
    generatedAt: AT,
    version: { ui: 1, lib: 1, worker: 1, loaded: 1 },
    agents: [],
    artifacts: [],
    matrix: {
      available: true, me: 'frank', paused: false, holdSeconds: null, holdWhileReviewing: false,
      inbox: { fetchedAt: AT, loading: false, error: null, repoCount: 2, rows },
      fullAuto: [], roster: [], watches: [], verdicts: {}, queue: [], runs: [], autoPasses: [],
    },
  };
}

function memory(initial = {}) {
  const data = { ...initial };
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = String(v); } };
}

const BROKEN_STORE = { getItem() { throw new Error('blocked'); }, setItem() { throw new Error('blocked'); } };

async function mrPage({ store = null, rows = ROWS } = {}) {
  const posts = [];
  const page = await openPage({
    respond(path, init) {
      if (init?.method === 'POST') posts.push(path);
      return init?.method === 'POST' ? { ok: true, text: 'Done' } : null;
    },
  });
  if (store) page.window.localStorage = store;
  page.show(snapshot(rows), 'merge-requests');
  return Object.assign(page, { posts });
}

const cardKeys = (page) => page.$$('#main .mr-card').map((c) => c.dataset.key);
const listKeys = (page) => page.$$('#main .list .mr .main .ref').map((r) => r.dataset.key);
const cardFor = (page, key) => page.$(`#main .mr-card[data-key="${key}"]`);
const laneOf = (page, key) => cardFor(page, key).closest('.lane').dataset.lane;

function laneFor(page, extra) {
  return page.run('mrLane(' + JSON.stringify(row(9, extra)) + ')');
}

const APPROVED_GREEN = { approvedBy: ['rupert'], mergeStatus: 'MERGEABLE', pipeline: 'SUCCESS' };

test('each column takes the MRs its rule names', async () => {
  const page = await mrPage();
  const cases = [
    ['draft', { draft: true }],
    ['blocked', { flags: { conflict: true } }],
    ['blocked', { mergeStatus: 'CONFLICT' }],
    ['blocked', { pipeline: 'FAILED' }],
    ['changes', { reviewStates: { rupert: 'REQUESTED_CHANGES', frank: 'REVIEWED' } }],
    ['changes', { mergeStatus: 'REQUESTED_CHANGES' }],
    ['changes', { unresolved: 1 }],
    ['ready', APPROVED_GREEN],
    ['ready', { ...APPROVED_GREEN, pipeline: null }],
    ['approved', { approvedBy: ['rupert'], mergeStatus: 'CI_STILL_RUNNING', pipeline: 'RUNNING' }],
    ['approved', { approvedBy: ['rupert'], mergeStatus: 'NOT_APPROVED' }],
    ['approved', { ...APPROVED_GREEN, pipeline: 'RUNNING' }],
    ['review', {}],
    ['review', { reviewers: [], mergeStatus: 'MERGEABLE' }],
  ];
  for (const [lane, extra] of cases) assert.equal(laneFor(page, extra), lane, JSON.stringify(extra));
});

test('where an MR fits two columns, the earlier one wins', async () => {
  const page = await mrPage();
  const cases = [
    ['draft', { draft: true, flags: { conflict: true }, pipeline: 'FAILED', unresolved: 3, ...APPROVED_GREEN }],
    ['blocked', { flags: { conflict: true }, reviewStates: { rupert: 'REQUESTED_CHANGES' }, unresolved: 2 }],
    ['blocked', { ...APPROVED_GREEN, pipeline: 'FAILED' }],
    ['changes', { ...APPROVED_GREEN, unresolved: 1 }],
    ['changes', { ...APPROVED_GREEN, reviewStates: { rupert: 'APPROVED', judy: 'REQUESTED_CHANGES' } }],
    ['ready', { ...APPROVED_GREEN, reviewStates: { rupert: 'APPROVED' } }],
    ['approved', { ...APPROVED_GREEN, mergeStatus: 'NEED_REBASE' }],
  ];
  for (const [lane, extra] of cases) assert.equal(laneFor(page, extra), lane, JSON.stringify(extra));
});

test('the view opens as a list, Board shows every column with its count, and each MR sits in exactly one', async () => {
  const page = await mrPage();
  assert.ok(!page.$('#main .mr-board'), 'no board until asked for');
  assert.equal(page.$('#mr-layout-list').getAttribute('aria-pressed'), 'true');
  page.$('#mr-layout-board').click();
  assert.ok(!page.$('#main .list'), 'the list gives way to the board');
  assert.deepEqual(page.$$('#main .lane h2').map((h) => h.textContent), ['Draft1', 'Blocked1', 'Changes requested1', 'Ready to merge1', 'Approved1', 'Needs review1']);
  assert.deepEqual([...cardKeys(page)].sort(), ROWS.map((r) => r.key).sort());
  assert.deepEqual(ROWS.map((r) => laneOf(page, r.key)), ['draft', 'blocked', 'changes', 'ready', 'approved', 'review']);
});

test('an empty column stays on the board with a quiet line', async () => {
  const page = await mrPage({ store: memory({ 'cc.mrLayout': 'board' }), rows: [ROWS[3]] });
  assert.equal(page.$$('#main .lane').length, 6);
  assert.deepEqual(page.$$('#main .lane-empty').map((p) => p.closest('.lane').dataset.lane), ['draft', 'blocked', 'changes', 'approved', 'review']);
  assert.equal(page.$('#main .lane[data-lane="draft"] h2 .pill').textContent, '0');
});

test('the choice is remembered for the next visit, and a browser that refuses storage still switches', async () => {
  const store = memory();
  const page = await mrPage({ store });
  page.$('#mr-layout-board').click();
  assert.equal(store.data['cc.mrLayout'], 'board');
  const again = await mrPage({ store });
  assert.ok(again.$('#main .mr-board'), 'opens on the board');
  again.$('#mr-layout-list').click();
  assert.equal(store.data['cc.mrLayout'], 'list');
  const refused = await mrPage({ store: BROKEN_STORE });
  assert.ok(refused.$('#main .list'));
  refused.$('#mr-layout-board').click();
  assert.ok(refused.$('#main .mr-board'));
  assert.deepEqual(refused.errors, []);
});

test('the board shows exactly the rows the list shows under every filter', async () => {
  const page = await mrPage();
  const filters = [
    "ui.mrScope = 'asking'", "ui.mrScope = 'mine'", "ui.mrScope = 'watched'", "ui.mrMood = 'approved'",
    "ui.mrRepo = 'web'", "ui.mrPerson = 'judy'", "ui.mrSearch = 'docs'", "ui.mrSearch = 'rupert'", "ui.mrRepo = 'web'; ui.mrPerson = 'judy'",
  ];
  for (const set of filters) {
    page.run("scopeMrs('all'); ui.mrLayout = 'list'; " + set + '; render()');
    const listed = listKeys(page);
    assert.ok(listed.length > 0 && listed.length < ROWS.length, set + ' narrows the list');
    page.run("ui.mrLayout = 'board'; render()");
    assert.deepEqual(cardKeys(page).sort(), listed.sort(), set);
  }
});

test('a card carries the title that opens the drawer, repo and iid, the people, the chips and its age', async () => {
  const page = await mrPage({ store: memory({ 'cc.mrLayout': 'board' }) });
  const card = cardFor(page, 'acme/engine!3');
  const ref = card.querySelector('.card-head .ref');
  assert.equal(ref.textContent, 'Change 3');
  assert.match(card.textContent, /engine !3/);
  assert.match(card.textContent, /judy → frank, rupert/);
  assert.match(card.textContent, /opened 3 d ago/);
  assert.equal(card.querySelector('.pipe').textContent, 'running');
  assert.ok(card.querySelectorAll('.chip-btn').some((b) => b.textContent === '2 unresolved'));
  ref.click();
  assert.deepEqual(JSON.parse(page.run('JSON.stringify([ui.mr.key, ui.mr.tab])')), ['acme/engine!3', 'overview']);
});

test('closing the drawer returns focus to the card it was opened from', async () => {
  const page = await mrPage({ store: memory({ 'cc.mrLayout': 'board' }) });
  const ref = cardFor(page, 'acme/web!4').querySelector('.ref');
  ref.focus();
  ref.click();
  await page.settle();
  assert.ok(page.$('#drawer').contains(page.document.activeElement), 'the drawer took focus');
  page.fire(page.document.activeElement, 'keydown', { key: 'Escape' });
  const back = page.document.activeElement;
  assert.ok(back.closest('.mr-card'), `focus went to ${back.tagName}#${back.id}`);
  assert.equal(back.closest('.mr-card').dataset.key, 'acme/web!4');
});

test('a card has no write of its own: only its title, chips and menu, and one click on any of them sends nothing', async () => {
  const page = await mrPage({ store: memory({ 'cc.mrLayout': 'board' }) });
  const buttons = () => cardFor(page, 'acme/engine!3').querySelectorAll('button');
  assert.deepEqual(buttons().map((b) => b.className), ['ref', 'icon-only', 'pipe s-working', 'chip-btn']);
  for (let i = 0; i < buttons().length; i += 1) {
    buttons()[i].click();
    page.run('ui.mr = null; ui.menu = null; render()');
  }
  assert.deepEqual(page.posts, []);
  page.run("ui.mrLayout = 'list'; render()");
  assert.ok(page.$$('#main .mr button').some((b) => b.textContent === 'Approve'), 'the row still offers Approve');
});

test('on a wide window the board takes the height left under the filters, so the page itself never scrolls past it', async () => {
  const css = await readFile(new URL('./12-kanban.css', import.meta.url), 'utf8');
  const wide = css.match(/@media \(min-width: 781px\) \{([\s\S]*?)\n\}/)?.[1] ?? '';
  const rule = (text, selector) => [...text.matchAll(/([^{}]+)\{([^{}]*)\}/g)].filter(([, s]) => s.trim() === selector).map(([, , body]) => body).join(';');
  assert.match(rule(wide, 'main:has(> .kanban)'), /display: flex; flex-direction: column; height: 100vh/);
  assert.match(rule(wide, '.kanban'), /flex: 0 1 auto/);
  assert.doesNotMatch(rule(css, '.kanban'), /vh/, 'a height from the window ignores the header and filters above the board');
  const page = await mrPage({ store: memory({ 'cc.mrLayout': 'board' }) });
  assert.equal(page.$('#main .kanban.mr-board').parentNode.id, 'main', 'the rule above needs the board as a child of main');
});
