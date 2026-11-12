import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openPage } from './testkit.mjs';

const OPEN = 'acme/engine!7';
const MERGED = 'acme/engine!1100';
const CLOSED = 'acme/engine!1090';
const AT = '2026-11-05T12:00:00Z';
const urlOf = (key) => 'https://gitlab.com/' + key.replace('!', '/-/merge_requests/');

function row(key) {
  const iid = Number(key.split('!')[1]);
  return {
    key, iid, repo: 'engine', title: 'MR ' + iid, webUrl: urlOf(key), author: 'ivan', reviewers: ['frank'], approvedBy: [], draft: false, pipeline: 'SUCCESS',
    ticket: 'ABC-1', updatedAt: AT, unresolved: 0, threads: null, mergeStatus: 'MERGEABLE', sourceBranch: 'feat/' + iid, sha: 'aaa111', agentHandle: null,
    watch: null, flags: {}, phase: 'open', count: 0, mood: 'quiet', verdict: null, agent: null, level: null,
  };
}

// waiting is the worker's answer from the engine's own rule, so each fixture says it.
function item(id, key, extra = {}) {
  const status = extra.status ?? 'pending';
  return {
    id, key, webUrl: urlOf(key), severity: 'MINOR', kind: 'finding', outcome: null, verdict: null, body: 'Body ' + id, hunk: null, path: null,
    line: null, side: null, anchor: null, stale: false, createdBy: 'review', createdAt: AT, status, waiting: status === 'pending', postedAt: null, auto: null, error: null,
    discussionId: null, replyTo: null, expiredAt: null, expiredReason: null, ...extra,
  };
}

const expired = (id, key, why = 'MR merged') => item(id, key, { status: 'expired', expiredAt: AT, expiredReason: why });

const CLEANUP = {
  groups: [{ key: MERGED, items: 9, why: 'MR merged', mark: 'm-merged' }, { key: CLOSED, items: 2, why: 'MR closed', mark: 'm-closed' }],
  closed: { items: 47, mrs: 10, test: 0, mark: 'm-all' },
};

const QUEUE = [
  item('open-1', OPEN), item('open-2', OPEN),
  item('limbo', CLOSED, { waiting: false }),
  expired('gone-1', MERGED), expired('gone-2', MERGED),
  item('sent', MERGED, { status: 'posted', postedAt: AT, discussionId: 'd1' }),
  item('dropped', CLOSED, { status: 'discarded' }),
];

function snapshot(queue = QUEUE, { cleanup = CLEANUP, fetchedAt = AT } = {}) {
  return {
    generatedAt: AT,
    version: { ui: 1, lib: 1, worker: 1, loaded: 1 },
    agents: [],
    artifacts: [],
    matrix: {
      available: true, running: false, me: 'frank', paused: false, holdSeconds: null, holdWhileReviewing: false,
      inbox: { fetchedAt, loading: false, error: null, repoCount: 1, rows: fetchedAt ? [row(OPEN)] : [] },
      fullAuto: [], roster: [], watches: [], verdicts: {}, queue, runs: [], autoPasses: [], cleanup,
    },
  };
}

const ARCHIVE = (page) => ({
  page, pageSize: 25, total: 30,
  items: Array.from({ length: page ? 5 : 25 }, (_, n) => ({
    id: 'a' + (page * 25 + n), key: MERGED, webUrl: urlOf(MERGED), severity: 'MAJOR', kind: 'finding', verdict: null, outcome: null, body: '**Archived** ' + (page * 25 + n),
    path: null, line: null, status: n % 2 ? 'posted' : 'expired', createdBy: 'review', createdAt: AT, postedAt: null, expiredReason: n % 2 ? null : 'MR merged', archivedAt: AT, why: 'MR merged',
  })),
});

async function queuePage(snap = snapshot()) {
  const calls = [];
  const page = await openPage({
    respond(path, init) {
      calls.push([init?.method ?? 'GET', path, init?.body ? JSON.parse(init.body) : null]);
      if (path.startsWith('/api/matrix/queue-archive')) return ARCHIVE(Number(new URLSearchParams(path.split('?')[1]).get('page')));
      return init?.method === 'POST' ? { ok: true, text: 'Done' } : null;
    },
  });
  page.show(snap, 'review-queue');
  return Object.assign(page, {
    posts: () => calls.filter(([method]) => method === 'POST').map(([, path, body]) => [path, body]),
    gets: () => calls.filter(([method]) => method === 'GET').map(([, path]) => path),
  });
}

const chipNames = (page) => page.$$('#main .head .chip').map((c) => c.textContent);
const pickChip = (page, label) => page.$$('#main .head .chip').find((c) => c.textContent === label).click();
const bodies = (page) => page.$$('#main .item .md').map((p) => p.textContent.replace(/^Body |^Archived /, ''));
const groupKeys = (page) => page.$$('#main .list .row .row-head .ref').map((r) => r.dataset.key);
const buttonsIn = (page) => page.$$('#main button').map((b) => b.textContent);
const buttonById = (page, id) => page.$$('#main button').find((b) => b.id === id);
const count = (page, name) => page.$(`[data-count="${name}"]`).textContent;

test('the queue offers Expired beside Waiting for you, Posted and Discarded, and Archived after All', async () => {
  const page = await queuePage();
  assert.deepEqual(page.errors, []);
  assert.deepEqual(chipNames(page), ['Waiting for you', 'Expired', 'Posted', 'Discarded', 'All', 'Archived']);
});

test('Waiting for you and the rail count only what the worker says waits to post', async () => {
  const page = await queuePage();
  assert.deepEqual(bodies(page), ['open-1', 'open-2'], 'not the pending item on an MR that is no longer open');
  assert.equal(count(page, 'pending'), '2');
});

test('a pending item on a repo with nothing in the list still waits, as the TUI counts it, and its group does not call it closed', async () => {
  const UNLISTED = 'acme/elsewhere!9';
  const page = await queuePage(snapshot([...QUEUE, item('elsewhere', UNLISTED)]));
  assert.equal(count(page, 'pending'), '3');
  assert.deepEqual(bodies(page), ['open-1', 'open-2', 'elsewhere']);
  const group = page.$$('#main .list .row').find((r) => r.textContent.includes('elsewhere!9'));
  assert.match(group.textContent, /not in the MR list/);
  assert.doesNotMatch(group.textContent, /no longer open/);
  assert.equal(buttonById(page, 'g-archive:' + UNLISTED), undefined, 'and offers no Archive while something on it waits');
});

test('Expired lists what was never posted with a plain line saying why, and no way to post it', async () => {
  const page = await queuePage();
  pickChip(page, 'Expired');
  assert.deepEqual(bodies(page), ['gone-1', 'gone-2']);
  const lines = page.$$('#main .item .meta').map((m) => m.textContent).filter((t) => t.startsWith('Not posted'));
  assert.deepEqual(lines, ['Not posted: MR merged', 'Not posted: MR merged']);
  assert.ok(!buttonsIn(page).some((b) => /^(Post|Edit|Discard)$/.test(b)), buttonsIn(page).join(', '));
});

test('each MR group no longer open has an Archive button that takes two clicks and names the whole count', async () => {
  const page = await queuePage();
  pickChip(page, 'All');
  assert.deepEqual(groupKeys(page), [OPEN, CLOSED, MERGED]);
  const archive = () => buttonById(page, 'g-archive:' + MERGED);
  assert.equal(buttonById(page, 'g-archive:' + OPEN), undefined, 'an open MR has none');
  assert.ok(buttonById(page, 'g-archive:' + CLOSED), 'one that closed has one too');
  archive().click();
  assert.deepEqual(page.posts(), [], 'the first click only arms it');
  assert.equal(archive().textContent, 'Archive 9 items on engine!1100?');
  archive().click();
  await page.settle();
  assert.deepEqual(page.posts(), [['/api/matrix/archive-mr', { key: MERGED, expect: { items: 9, mark: 'm-merged' } }]]);
});

test('Clean up closed asks with the exact counts and sends what it showed, so the worker can refuse a queue that moved', async () => {
  const page = await queuePage();
  const button = () => buttonById(page, 'g-archive-closed');
  assert.equal(button().textContent, 'Clean up closed');
  button().click();
  assert.equal(button().textContent, 'Archive 47 items on 10 merged MRs?');
  button().click();
  await page.settle();
  assert.deepEqual(page.posts(), [['/api/matrix/archive-closed', { expect: { items: 47, mrs: 10, test: 0, mark: 'm-all' } }]]);
  page.show(snapshot(QUEUE, { cleanup: { groups: [], closed: { items: 0, mrs: 0, test: 12, mark: 't' } } }), 'review-queue');
  button().click();
  assert.equal(button().textContent, 'Archive 12 test items?');
  page.show(snapshot(QUEUE, { cleanup: { groups: [], closed: { items: 0, mrs: 0, test: 0, mark: 'z' } } }), 'review-queue');
  assert.equal(button(), undefined, 'nothing to clean, no button');
  page.show(snapshot(QUEUE, { cleanup: null }), 'review-queue');
  assert.equal(button(), undefined, 'nor from an engine that cannot count it');
});

test('Archived reads the archive a page at a time, newest first, and offers nothing to act on', async () => {
  const page = await queuePage();
  pickChip(page, 'Archived');
  await page.settle();
  assert.ok(page.gets().includes('/api/matrix/queue-archive?page=0'));
  assert.equal(bodies(page).length, 25);
  assert.equal(page.$('#main .item .md strong').textContent, 'Archived', 'its text is formatted');
  assert.match(page.$('#main').textContent, /1–25 of 30, newest first/);
  assert.match(page.$('#main').textContent, /Not posted: MR merged/);
  const inList = page.$$('#main .list button').filter((b) => !b.classList.contains('ref')).map((b) => b.textContent);
  assert.deepEqual(inList, [], 'read only');
  buttonById(page, 'archive-older').click();
  await page.settle();
  assert.ok(page.gets().includes('/api/matrix/queue-archive?page=1'));
  assert.match(page.$('#main').textContent, /26–30 of 30/);
  assert.equal(buttonById(page, 'archive-older').disabled, true);
});

test('a queued item reads as formatted text, and Edit opens it as written', async () => {
  const page = await queuePage(snapshot([item('open-1', OPEN, { body: '**Rename** `cache_get`, it returns stale data.' })]));
  const body = page.$('#main .item .md');
  assert.equal(body.querySelector('strong').textContent, 'Rename');
  assert.equal(body.querySelector('code').textContent, 'cache_get');
  page.$$('#main button').find((b) => b.textContent === 'Edit').click();
  assert.equal(page.$('#main .item textarea').textContent, '**Rename** `cache_get`, it returns stale data.');
});

test('opening an edit marks the item at once and reads the state again, so the item is not expired from under it', async () => {
  const page = await queuePage();
  await page.settle();
  page.requested.length = 0;
  page.$$('#main button').find((b) => b.textContent === 'Edit').click();
  await page.settle();
  assert.deepEqual(page.posts().filter(([path]) => path === '/api/matrix/editing'), [['/api/matrix/editing', { id: 'open-1', editing: true }]]);
  assert.ok(page.requested.includes('/api/state'), page.requested.join(', '));
});

function detail(key, settled = []) {
  return { key, me: 'frank', fetchedAt: AT, mr: { iid: 1100, repo: 'engine', title: 'MR', author: 'ivan', webUrl: urlOf(key) }, discussions: [], jobs: [], merge: null, detail: null, files: null, missing: {}, settled };
}

async function drawerFor(key, queue, options) {
  const page = await openPage({ respond: (path) => (path.startsWith('/api/matrix/mr?') ? detail(key) : null) });
  page.show(snapshot(queue, options), 'review-queue');
  page.run(`openMr('${key}', 'findings')`);
  await page.settle();
  return page;
}

test('in the drawer of a merged MR nothing waits on you, and All shows what expired with why', async () => {
  const page = await drawerFor(MERGED, [item('late', MERGED, { waiting: false }), expired('gone', MERGED), item('sent', MERGED, { status: 'posted', postedAt: AT })]);
  const chipsNow = page.$$('#drawer .chips .chip').map((c) => c.textContent);
  assert.deepEqual(chipsNow.slice(0, 2), ['Needs you (0)', 'Waiting to post (0)']);
  assert.equal(page.$('#drawer .chip[aria-pressed="true"]').textContent, 'All (3)');
  assert.match(page.$('#drawer .drawer-body').textContent, /Not posted: MR merged/);
  assert.match(page.$('#drawer .foot .meta').textContent, /1 expired/);
});

test('in the drawer of an open MR what waits to post still counts', async () => {
  const page = await drawerFor(OPEN, [item('draft', OPEN)]);
  assert.deepEqual(page.$$('#drawer .chips .chip').map((c) => c.textContent).slice(0, 2), ['Needs you (1)', 'Waiting to post (1)']);
});

test('the drawer counts what waits to post as the rail does, on an MR missing from the list or before the list has loaded', async () => {
  const UNLISTED = 'acme/elsewhere!9';
  const unlisted = await drawerFor(UNLISTED, [item('elsewhere', UNLISTED)]);
  assert.deepEqual(unlisted.$$('#drawer .chips .chip').map((c) => c.textContent).slice(0, 2), ['Needs you (1)', 'Waiting to post (1)']);
  const early = await drawerFor(OPEN, [item('draft', OPEN)], { fetchedAt: null });
  assert.equal(count(early, 'pending'), '1');
  assert.deepEqual(early.$$('#drawer .chips .chip').map((c) => c.textContent).slice(0, 2), ['Needs you (1)', 'Waiting to post (1)']);
});
