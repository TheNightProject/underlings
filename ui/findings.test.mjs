import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openPage } from './testkit.mjs';

const KEY = 'acme/engine!7';
const OTHER = 'acme/engine!8';
const AT = '2026-11-05T12:00:00Z';
const urlOf = (key) => 'https://gitlab.com/' + key.replace('!', '/-/merge_requests/');

function row(key) {
  const iid = Number(key.split('!')[1]);
  return {
    key, iid, repo: 'engine', title: 'MR ' + iid, webUrl: urlOf(key), author: 'ivan', reviewers: ['frank'], approvedBy: [], draft: false, pipeline: 'SUCCESS',
    ticket: 'ABC-1', updatedAt: AT, unresolved: 0, threads: null, mergeStatus: 'MERGEABLE', sourceBranch: 'feat/' + iid, sha: 'aaa111', agentHandle: null,
    watch: null, flags: { waitingOnYou: true }, phase: 'open', count: 0, mood: 'awaitingYou', verdict: null, agent: null, level: null,
  };
}

function snapshot(queue) {
  return {
    generatedAt: AT,
    version: { ui: 1, lib: 1, worker: 1, loaded: 1 },
    agents: [],
    artifacts: [],
    matrix: {
      available: true, running: false, me: 'frank', paused: false, holdSeconds: null, holdWhileReviewing: false,
      inbox: { fetchedAt: AT, loading: false, error: null, repoCount: 1, rows: [row(KEY), row(OTHER)] },
      fullAuto: [], roster: [], watches: [], verdicts: {}, queue, runs: [], autoPasses: [],
    },
  };
}

const note = (author, body) => ({ author, body, createdAt: AT, system: false });

function thread(id, extra = {}) {
  return {
    id, resolved: false, resolvable: true, path: 'src/app.py', line: 12, notes: [note('frank', 'Opened ' + id), note('ivan', 'Answer on ' + id)],
    awaitsYou: false, handedBack: false, queuedReply: null, ...extra,
  };
}

function item(id, extra = {}) {
  return {
    id, key: KEY, webUrl: urlOf(KEY), severity: 'MINOR', kind: 'finding', outcome: null, verdict: null, body: 'Body ' + id, hunk: null, path: 'src/app.py',
    line: 2, side: 'new', anchor: null, stale: false, createdBy: 'review', createdAt: AT, status: 'pending', postedAt: null, auto: null, error: null,
    discussionId: null, replyTo: null, ...extra,
  };
}

const posted = (id, discussionId, extra = {}) => item(id, { status: 'posted', postedAt: AT, discussionId, ...extra });

const THREADS = [
  thread('d-done', { resolved: true }),
  thread('d-quiet', { notes: [note('frank', 'Opened d-quiet')] }),
  thread('d-asked', { awaitsYou: true }),
  thread('d-back', { handedBack: true }),
];

// Listed least urgent first, so the tab's own order shows.
const MIXED = [
  item('gone', { status: 'discarded' }),
  posted('done', 'd-done'),
  item('verdict', { kind: 'verdict', verdict: 'approve', severity: null, status: 'posted', postedAt: AT }),
  posted('quiet', 'd-quiet'),
  item('draft'),
  posted('asked', 'd-asked'),
  posted('again', null, { kind: 'reply', severity: null, replyTo: 'd-asked' }),
  posted('back', 'd-back'),
];

function detail(key, discussions, settled = []) {
  return { key, me: 'frank', fetchedAt: AT, mr: { iid: 7, repo: 'engine', title: 'MR', author: 'ivan', webUrl: urlOf(key) }, discussions, jobs: [], merge: null, detail: null, files: null, missing: {}, settled };
}

async function drawer(queue, { discussions = THREADS, settled = [], fail = false, settle = true } = {}) {
  const calls = [];
  const page = await openPage({
    respond(path, init) {
      calls.push([init.method, path, init.body ? JSON.parse(init.body) : null]);
      if (path.startsWith('/api/matrix/mr?')) return fail ? null : detail(new URLSearchParams(path.split('?')[1]).get('key'), discussions, settled);
      return init.method === 'POST' ? { ok: true, text: 'Done' } : null;
    },
  });
  page.show(snapshot(queue), 'merge-requests');
  page.run(`openMr('${KEY}', 'findings')`);
  if (settle) await page.settle();
  return Object.assign(page, {
    posts: () => calls.filter(([method]) => method === 'POST').map(([, path, body]) => [path, body]),
    reads: () => calls.filter(([, path]) => path.startsWith('/api/matrix/mr?')).length,
  });
}

const chipLabels = (page) => page.$$('#drawer .chips .chip').map((c) => c.textContent);
const chosen = (page) => page.$('#drawer .chip[aria-pressed="true"]').textContent;
const shown = (page) => page.$$('#drawer .item').map((i) => i.querySelector('.md').textContent.replace('Body ', ''));
const pick = (page, label) => page.$$('#drawer .chip').find((c) => c.textContent.startsWith(label + ' (')).click();
const bodyText = (page) => page.$('#drawer .drawer-body').textContent;

test('the Findings tab opens on what needs you: what waits to post and the posted threads waiting on your answer, most urgent first', async () => {
  const page = await drawer(MIXED);
  assert.deepEqual(page.errors, []);
  assert.deepEqual(chipLabels(page), ['Needs you (3)', 'Waiting to post (1)', 'Open (3)', 'Resolved (1)', 'All (8)']);
  assert.equal(chosen(page), 'Needs you (3)');
  assert.deepEqual(shown(page), ['asked', 'back', 'draft']);
  const pills = page.$$('#drawer .item .pill').map((p) => p.textContent);
  assert.ok(pills.includes('waiting on you') && pills.includes('handed back'), pills.join(', '));
});

test('beside Post all, the tab still counts what waits to post, what is posted and what is discarded', async () => {
  const page = await drawer(MIXED);
  assert.equal(page.$('#drawer .foot .meta').textContent, '1 waiting to post, 6 posted, 1 discarded');
  pick(page, 'Resolved');
  assert.equal(page.$('#drawer .foot .meta').textContent, '1 waiting to post, 6 posted, 1 discarded', 'whichever chip is chosen');
});

test('each chip lists only its own, most urgent first, and All adds the discarded at the end', async () => {
  const page = await drawer(MIXED);
  pick(page, 'Waiting to post');
  assert.deepEqual(shown(page), ['draft']);
  pick(page, 'Open');
  assert.deepEqual(shown(page), ['asked', 'back', 'quiet']);
  pick(page, 'Resolved');
  assert.deepEqual(shown(page), ['done']);
  pick(page, 'All');
  assert.deepEqual(shown(page), ['asked', 'back', 'draft', 'quiet', 'done', 'verdict', 'again', 'gone']);
});

test('a handed-back finding leaves Needs you once you answer its thread or it is resolved', async () => {
  const discussions = [
    thread('d-answered', { handedBack: true, notes: [note('frank', 'Opened'), note('ivan', 'Why?'), note('frank', 'Because.')] }),
    thread('d-closed', { handedBack: true, resolved: true }),
    thread('d-back', { handedBack: true }),
  ];
  const page = await drawer([posted('answered', 'd-answered'), posted('closed', 'd-closed'), posted('back', 'd-back')], { discussions });
  assert.deepEqual(chipLabels(page), ['Needs you (1)', 'Waiting to post (0)', 'Open (2)', 'Resolved (1)', 'All (3)']);
  assert.deepEqual(shown(page), ['back']);
});

test('a finding and the reply posted under it are one thread, so only the finding counts toward it', async () => {
  const page = await drawer([posted('asked', 'd-asked'), posted('again', null, { kind: 'reply', severity: null, replyTo: 'd-asked' })]);
  assert.deepEqual(chipLabels(page), ['Needs you (1)', 'Waiting to post (0)', 'Open (1)', 'Resolved (0)', 'All (2)']);
  assert.deepEqual(shown(page), ['asked']);
});

test('a posted finding older than the page holds still counts, from the MR\'s own read', async () => {
  const page = await drawer([item('draft'), posted('done', 'd-done')], { settled: [posted('done', 'd-done'), posted('asked', 'd-asked'), posted('quiet', 'd-quiet')] });
  assert.deepEqual(chipLabels(page), ['Needs you (2)', 'Waiting to post (1)', 'Open (2)', 'Resolved (1)', 'All (4)']);
  assert.deepEqual(shown(page), ['asked', 'draft']);
});

test('a thread is still counted once when its finding comes only from the MR\'s read and its reply from the page', async () => {
  const page = await drawer([posted('again', null, { kind: 'reply', severity: null, replyTo: 'd-asked' })], { settled: [posted('asked', 'd-asked')] });
  assert.deepEqual(chipLabels(page), ['Needs you (1)', 'Waiting to post (0)', 'Open (1)', 'Resolved (0)', 'All (2)']);
  assert.deepEqual(shown(page), ['asked']);
});

test('with nothing waiting on you the tab opens on Open, and with nothing open on All', async () => {
  const quiet = await drawer([posted('quiet', 'd-quiet'), posted('done', 'd-done')]);
  assert.equal(chosen(quiet), 'Open (1)');
  assert.deepEqual(shown(quiet), ['quiet']);
  const settled = await drawer([posted('done', 'd-done'), item('gone', { status: 'discarded' })]);
  assert.equal(chosen(settled), 'All (2)');
  assert.deepEqual(shown(settled), ['done', 'gone']);
});

test('a chip with nothing under it says so in one plain line', async () => {
  const page = await drawer([posted('done', 'd-done')]);
  const lines = () => page.$$('#drawer .empty').map((p) => p.textContent);
  pick(page, 'Needs you');
  assert.deepEqual(lines(), ['Nothing on this MR is waiting on you.']);
  pick(page, 'Waiting to post');
  assert.deepEqual(lines(), ['Nothing is waiting to post.']);
  pick(page, 'Open');
  assert.deepEqual(lines(), ['No thread from these findings is open.']);
  pick(page, 'Resolved');
  assert.deepEqual(lines(), []);
  assert.deepEqual(shown(page), ['done']);
});

test('while the threads are being read, Needs you counts only what waits to post and says the rest is still coming', async () => {
  const page = await drawer(MIXED, { settle: false });
  assert.equal(page.run('ui.mr.loading'), true);
  assert.deepEqual(chipLabels(page), ['Needs you (1)', 'Waiting to post (1)', 'Open (…)', 'Resolved (…)', 'All (8)']);
  assert.equal(chosen(page), 'Needs you (1)');
  assert.deepEqual(shown(page), ['draft']);
  assert.match(bodyText(page), /Reading the threads from GitLab/);
  await page.settle();
  assert.equal(chosen(page), 'Needs you (3)');
  assert.doesNotMatch(bodyText(page), /Reading the threads/);
});

test('with nothing to post and the threads still being read, Needs you waits for them rather than saying nothing waits', async () => {
  const page = await drawer([posted('asked', 'd-asked'), posted('done', 'd-done')], { settle: false });
  assert.equal(chosen(page), 'Needs you (0)');
  assert.deepEqual(shown(page), []);
  assert.match(bodyText(page), /Reading the threads from GitLab/);
  assert.doesNotMatch(bodyText(page), /Nothing on this MR is waiting on you/);
  await page.settle();
  assert.equal(chosen(page), 'Needs you (1)');
  assert.deepEqual(shown(page), ['asked']);
});

test('when the threads cannot be read, a thread chip says so rather than claiming nothing is there', async () => {
  const page = await drawer([item('draft'), posted('asked', 'd-asked')], { fail: true });
  assert.ok(page.run('ui.mr.error'));
  assert.equal(chosen(page), 'Needs you (1)');
  assert.match(bodyText(page), /The threads could not be read/);
  pick(page, 'Open');
  assert.match(bodyText(page), /The threads could not be read/);
  assert.doesNotMatch(bodyText(page), /No thread from these findings is open/);
  pick(page, 'All');
  assert.doesNotMatch(bodyText(page), /The threads could not be read/);
  assert.deepEqual(shown(page), ['draft', 'asked']);
});

test('the chosen chip stays with the MR across its tabs, apart from the Threads tab\'s own, and another MR opens on its default', async () => {
  const page = await drawer([...MIXED, item('elsewhere', { key: OTHER, webUrl: urlOf(OTHER) })]);
  pick(page, 'Resolved');
  page.$('#mr-tab-threads').click();
  assert.equal(chosen(page), 'Awaiting you (2)', 'the Threads tab keeps its own default');
  pick(page, 'All');
  page.$('#mr-tab-findings').click();
  assert.equal(chosen(page), 'Resolved (1)');
  page.run(`openMr('${OTHER}', 'findings')`);
  await page.settle();
  assert.equal(chosen(page), 'Needs you (1)');
  page.run(`openMr('${KEY}', 'findings')`);
  await page.settle();
  assert.equal(chosen(page), 'Needs you (3)');
});

const POSTED_ELSEWHERE = [posted('draft', 'd-new'), posted('quiet', 'd-quiet')];

test('a finding posted elsewhere while the drawer is open reads the MR again, and counts once its thread arrives', async () => {
  const discussions = [...THREADS];
  const page = await drawer([item('draft'), posted('quiet', 'd-quiet')], { discussions });
  assert.equal(chosen(page), 'Needs you (1)');
  const before = page.reads();
  discussions.push(thread('d-new', { notes: [note('frank', 'Opened d-new')] }));
  page.show(snapshot(POSTED_ELSEWHERE), 'merge-requests');
  page.run('refresh()');
  await page.settle();
  assert.equal(page.reads(), before + 1);
  assert.deepEqual(chipLabels(page), ['Needs you (0)', 'Waiting to post (0)', 'Open (2)', 'Resolved (0)', 'All (2)']);
  assert.equal(chosen(page), 'Open (2)');
  assert.deepEqual(shown(page), ['draft', 'quiet']);
  page.run('refresh()');
  await page.settle();
  assert.equal(page.reads(), before + 1, 'an unchanged queue reads nothing more');
});

test('while that read is under way, the new finding counts as still being read, so the tab stays on Needs you', async () => {
  const page = await drawer([item('draft'), posted('quiet', 'd-quiet')]);
  page.show(snapshot(POSTED_ELSEWHERE), 'merge-requests');
  page.run('loadMr()');
  assert.deepEqual(chipLabels(page), ['Needs you (0)', 'Waiting to post (0)', 'Open (…)', 'Resolved (…)', 'All (2)']);
  assert.equal(chosen(page), 'Needs you (0)');
  assert.match(bodyText(page), /Reading the threads from GitLab/);
  assert.doesNotMatch(bodyText(page), /Nothing on this MR is waiting on you/);
});

test('a read that changes nothing on the page keeps its counts while it is under way', async () => {
  const page = await drawer(MIXED);
  page.run('loadMr()');
  assert.equal(page.run('ui.mr.loading'), true);
  assert.deepEqual(chipLabels(page), ['Needs you (3)', 'Waiting to post (1)', 'Open (3)', 'Resolved (1)', 'All (8)']);
  assert.doesNotMatch(bodyText(page), /Reading the threads/);
});

test('a pressed chip keeps the focus, on the Findings tab and on the Threads tab', async () => {
  const page = await drawer(MIXED);
  const press = (label) => {
    const chip = page.$$('#drawer .chip').find((c) => c.textContent.startsWith(label + ' ('));
    chip.focus();
    chip.click();
    return page.document.activeElement;
  };
  const resolved = press('Resolved');
  assert.deepEqual([resolved.textContent, resolved.getAttribute('aria-pressed')], ['Resolved (1)', 'true']);
  page.$('#mr-tab-threads').click();
  const open = press('Open');
  assert.deepEqual([open.textContent, open.getAttribute('aria-pressed')], ['Open (3)', 'true']);
});

test('Post all still posts everything waiting, whichever chip is chosen', async () => {
  const page = await drawer([...MIXED, item('draft2')]);
  pick(page, 'Resolved');
  const postAll = () => page.$(`#drawer [id="g-postall:${KEY}"]`);
  assert.equal(postAll().textContent, 'Post all 2');
  postAll().click();
  assert.equal(postAll().textContent, 'Post 2 to GitLab?');
  postAll().click();
  await page.settle();
  assert.deepEqual(page.posts(), [['/api/matrix/post-all', { key: KEY }]]);
});

test('in the Findings tab a finding and the replies in its thread read as formatted text', async () => {
  const discussions = [thread('d-asked', { awaitsYou: true, notes: [note('frank', 'Opened'), note('ivan', 'Fixed in `abc123`.')] })];
  const page = await drawer([posted('asked', 'd-asked', { body: '**MAJOR**: `cache_get` is stale.' })], { discussions });
  const finding = page.$('#drawer .item');
  assert.equal(finding.querySelector('.md strong').textContent, 'MAJOR');
  assert.equal(finding.querySelector('.thread .say code').textContent, 'abc123');
});
