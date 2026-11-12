import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openPage } from './testkit.mjs';

const KEY = 'acme/engine!7';
const AT = '2026-11-05T12:00:00Z';

function row(extra = {}) {
  return {
    key: KEY, iid: 7, repo: 'engine', title: 'Make the engine faster', webUrl: 'https://gitlab.com/acme/engine/-/merge_requests/7', author: 'ivan', reviewers: ['frank'],
    approvedBy: [], draft: false, pipeline: 'SUCCESS', ticket: 'ABC-1', updatedAt: AT, unresolved: 0, threads: null, mergeStatus: 'MERGEABLE', sourceBranch: 'feat/7',
    sha: 'aaa111', agentHandle: null, watch: null, flags: {}, phase: 'posted', count: 3, mood: 'reviewed', verdict: null, agent: null, level: null, ...extra,
  };
}

function item(id, status, extra = {}) {
  return {
    id, key: KEY, webUrl: row().webUrl, severity: 'MINOR', kind: 'finding', outcome: null, verdict: null, body: 'Finding ' + id, hunk: null, path: null, line: null, side: null,
    anchor: null, stale: false, createdBy: 'review', createdAt: '2026-11-05T11:00:00Z', status, postedAt: status === 'posted' ? '2026-11-05T11:30:00Z' : null, auto: null, error: null,
    discussionId: null, replyTo: null, ...extra,
  };
}

function snapshot({ rows = [row()], queue = posted(), verdicts = {}, attention } = {}) {
  return {
    generatedAt: AT,
    ...(attention ? { attention: { cards: [], agents: [], system: [], count: 0, prefs: {}, toasts: [], offers: [], ...attention } } : {}),
    version: { ui: 1, lib: 1, worker: 1, loaded: 1 },
    agents: [],
    artifacts: [],
    matrix: {
      available: true, me: 'frank', paused: false, holdSeconds: null, holdWhileReviewing: true,
      inbox: { fetchedAt: AT, loading: false, error: null, repoCount: 1, rows },
      fullAuto: [], roster: [], watches: [], verdicts, queue, runs: [], autoPasses: [],
    },
  };
}

function posted() {
  return [item('a', 'posted', { severity: 'MAJOR' }), item('b', 'posted'), item('c', 'posted'), item('d', 'discarded')];
}

const LAST_POST = '2026-11-05T11:30:00Z';
const tally = (extra = {}) => ({ [KEY]: { posted: 3, dropped: 1, kinds: { MAJOR: 1, MINOR: 2 }, lastPost: LAST_POST, ...extra } });

async function page(snap = snapshot(), hash = 'merge-requests', tidies = true, mrs = tally()) {
  const sent = [];
  const p = await openPage({
    respond(path, init) {
      if (init?.method === 'POST') {
        sent.push([path, JSON.parse(init.body)]);
        return { ok: true, text: 'Approved ' + KEY };
      }
      return path === '/api/matrix/decide' ? { tidies, mrs: p.mrs } : null;
    },
  });
  p.mrs = mrs;
  p.show(snap, hash);
  await p.settle(50);
  return Object.assign(p, { sent, async reshow(next, view = hash) { p.show(next, view); await p.settle(50); } });
}

const cards = (p, where = '#main') => p.$$(where + ' .decide');
const cardButton = (p, label, where = '#main') => p.$$(where + ' .decide button').find((b) => b.textContent === label);

test('once every comment is up and nothing is decided, the MR row asks for a verdict with what was posted and dropped', async () => {
  const p = await page();
  const [card] = cards(p);
  assert.ok(card, 'the card should show');
  assert.match(card.textContent, /Comments are up/);
  assert.match(card.textContent, /3 posted, 1 dropped/);
  assert.match(card.textContent, /1 major/);
  assert.match(card.textContent, /2 minor/);
  assert.ok(cardButton(p, 'Approve') && cardButton(p, 'Request changes') && cardButton(p, 'Later'));
  assert.match(card.textContent, /Either one closes the review workspace/);
  assert.deepEqual(p.errors, []);
});

test('no card while anything is still pending, once a verdict follows the posts, on your own MR, or with nothing posted', async () => {
  for (const [snap, mrs] of [
    [snapshot({ queue: [...posted(), item('e', 'pending')] })],
    [snapshot({ verdicts: { [KEY]: { verdict: 'approved', at: '2026-11-05T11:45:00Z' } } })],
    [snapshot({ rows: [row({ author: 'frank', reviewers: [], flags: { mine: true } })] })],
    [snapshot({ queue: [item('d', 'discarded')] }), {}],
  ]) {
    const p = await page(snap, 'merge-requests', true, mrs);
    assert.equal(cards(p).length, 0);
  }
});

test('full auto still sending its own items leaves the question up, as the terminal app does', async () => {
  const auto = { pass: 'p1', level: 'comments', sendAt: '2026-11-05T12:02:00Z', held: null };
  const p = await page(snapshot({ queue: [...posted(), item('e', 'pending', { auto })] }));
  assert.equal(cards(p).length, 1);
});

test('the counts are the worker\'s, so posts trimmed from the snapshot by other MRs\' activity still show', async () => {
  const p = await page(snapshot({ queue: [] }), 'merge-requests', true, tally({ posted: 18, dropped: 16, kinds: { MINOR: 1, NIT: 2, reply: 15 } }));
  const [card] = cards(p);
  assert.ok(card, 'the card should show');
  assert.match(card.textContent, /18 posted, 16 dropped/);
  assert.match(card.textContent, /15 replies/);
});

test('a new snapshot asks the worker again, so a post made since moves the counts', async () => {
  const p = await page();
  p.mrs = tally({ posted: 4, kinds: { MAJOR: 1, MINOR: 2, NIT: 1 }, lastPost: '2026-11-05T12:10:00Z' });
  await p.reshow(snapshot());
  assert.match(cards(p)[0].textContent, /4 posted, 1 dropped/);
  assert.match(cards(p)[0].textContent, /1 nit/);
});

test('a verdict older than the latest post asks again', async () => {
  const p = await page(snapshot({ verdicts: { [KEY]: { verdict: 'approved', at: '2026-11-05T09:00:00Z' } } }));
  assert.equal(cards(p).length, 1);
});

test('approving takes two clicks, names the MR and the workspace it closes, and sends the head it saw', async () => {
  const p = await page();
  cardButton(p, 'Approve').click();
  const armed = p.$$('#main .decide button.armed')[0];
  assert.equal(armed.textContent, 'Approve !7 and close the review workspace?');
  assert.deepEqual(p.sent, []);
  armed.click();
  await p.settle(20);
  assert.deepEqual(p.sent, [['/api/matrix/decide', { key: KEY, verdict: 'approve', expect: { sha: 'aaa111' } }]]);
});

test('requesting changes is armed the same way, and says nothing of closing while the agent still works', async () => {
  const p = await page(snapshot({ rows: [row({ agent: 'working' })] }));
  cardButton(p, 'Request changes').click();
  assert.equal(p.$$('#main .decide button.armed')[0].textContent, 'Request changes on !7?');
  assert.match(cards(p)[0].textContent, /still working, so the workspace stays open/);
});

test('with tidying off the verdict closes nothing and the card does not claim it will', async () => {
  const p = await page(snapshot(), 'merge-requests', false);
  cardButton(p, 'Approve').click();
  assert.equal(p.$$('#main .decide button.armed')[0].textContent, 'Approve !7?');
  assert.doesNotMatch(cards(p)[0].textContent, /closes the review workspace/);
});

test('Later is kept by the worker, so the question stays away after a reload and in a second tab until something new is posted', async () => {
  const p = await page();
  cardButton(p, 'Later').click();
  await p.settle(50);
  assert.deepEqual(p.sent.filter(([path]) => path === '/api/attention/later'), [['/api/attention/later', { key: KEY, mark: 'up:' + LAST_POST }]]);
  const away = snapshot({ attention: { later: { [KEY]: 'up:' + LAST_POST } } });
  const reloaded = await page(away);
  assert.equal(cards(reloaded).length, 0, 'a fresh page reads it from the worker');
  p.mrs = tally({ posted: 4, lastPost: '2026-11-05T12:30:00Z' });
  await p.reshow(away);
  assert.equal(cards(p).length, 1, 'a new post brings it back');
});

test('the decide card and the Needs you card share the worker\'s mark, so Later on either puts both away', async () => {
  const mark = 'aaa111||' + LAST_POST;
  const p = await page(snapshot({ attention: { verdictMarks: { [KEY]: mark }, later: { [KEY]: 'up:' + LAST_POST } } }));
  assert.equal(cards(p).length, 1, 'a mark the worker no longer gives does not hide it');
  cardButton(p, 'Later').click();
  await p.settle(50);
  assert.deepEqual(p.sent.at(-1), ['/api/attention/later', { key: KEY, mark }]);
  await p.reshow(snapshot({ attention: { verdictMarks: { [KEY]: mark }, later: { [KEY]: mark } } }));
  assert.equal(cards(p).length, 0);
});

test('the review queue keeps the question when the MR has nothing left waiting, under every filter', async () => {
  const p = await page(snapshot(), 'review-queue');
  assert.equal(cards(p).length, 1, 'waiting for you');
  p.run("ui.queueFilter = 'all'; render();");
  assert.equal(cards(p).length, 1, 'all');
  p.run("ui.queueFilter = 'posted'; render();");
  assert.equal(cards(p).length, 1, 'posted');
});

test('the verdict pill says a push reset your approval once GitLab no longer has it', async () => {
  const p = await page(snapshot({ queue: [], verdicts: { [KEY]: { verdict: 'approved', at: '2026-11-05T11:45:00Z', sha: 'old000' } } }));
  p.run(`openMr('${KEY}', 'findings')`);
  await p.settle(20);
  assert.match(p.$('#drawer .drawer-body').textContent, /Your approval was reset by a push/);
  p.show(snapshot({ queue: [], rows: [row({ approvedBy: ['frank'] })], verdicts: { [KEY]: { verdict: 'approved', at: '2026-11-05T11:45:00Z', sha: 'old000' } } }), 'merge-requests');
  assert.match(p.$('#drawer .drawer-body').textContent, /You approved/, 'GitLab still has it');
});

test('the drawer\'s Findings tab asks it too, and shows the verdict once one is recorded', async () => {
  const p = await page();
  p.run(`openMr('${KEY}', 'findings')`);
  await p.settle(20);
  assert.equal(cards(p, '#drawer').length, 1);
  p.show(snapshot({ verdicts: { [KEY]: { verdict: 'changes', at: '2026-11-05T11:45:00Z' } } }), 'merge-requests');
  assert.equal(cards(p, '#drawer').length, 0);
  assert.match(p.$('#drawer .drawer-body').textContent, /You requested changes/);
});

test('the drawer asks even when the snapshot holds none of the MR\'s queue, and only on the Findings tab', async () => {
  const p = await page(snapshot({ queue: [] }));
  p.run(`openMr('${KEY}', 'findings')`);
  await p.settle(20);
  assert.equal(cards(p, '#drawer').length, 1);
  assert.match(cards(p, '#drawer')[0].textContent, /3 posted, 1 dropped/);
  p.run(`openMr('${KEY}', 'overview')`);
  assert.equal(cards(p, '#drawer').length, 0);
});

test('your own MR offers a self-review, which holds nothing', async () => {
  const p = await page(snapshot({ rows: [row({ author: 'frank', reviewers: [], flags: { mine: true } })], queue: [] }));
  const review = p.$$('#main button').find((b) => b.textContent === 'Review my MR');
  assert.ok(review);
  review.click();
  const armed = p.$$('#main button.armed')[0];
  assert.equal(armed.textContent, 'Self-review !7?');
  armed.click();
  await p.settle(20);
  assert.deepEqual(p.sent, [['/api/matrix/review-own', { key: KEY }]]);
});

test('someone else\'s MR still offers the review that holds it, naming the MR', async () => {
  const p = await page(snapshot({ queue: [] }));
  p.$$('#main button').find((b) => b.textContent === 'Review').click();
  assert.equal(p.$$('#main button.armed')[0].textContent, 'Review !7 and hold it?');
});
