import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { openPage } from './testkit.mjs';

const KEY = 'acme/engine!7';
const OTHER = 'acme/engine!8';
const AT = '2026-11-05T12:00:00Z';

function row(extra = {}) {
  return {
    key: KEY, iid: 7, repo: 'engine', title: 'Make the engine faster', webUrl: 'https://gitlab.com/acme/engine/-/merge_requests/7', author: 'ivan', reviewers: ['frank'],
    approvedBy: [], draft: false, pipeline: 'SUCCESS', ticket: 'ABC-1', updatedAt: AT, unresolved: 0, threads: null, mergeStatus: 'MERGEABLE', sourceBranch: 'feat/7',
    sha: 'aaa111', agentHandle: null, watch: null, flags: { waitingOnYou: true }, phase: 'open', count: 0, mood: 'awaitingYou', verdict: null, agent: null, level: null,
    ...extra,
  };
}

// A card as the worker's list gives it, so Needs you renders from that and nothing else.
function needsCard(key, title, reasons) {
  const full = reasons.map(([kind, why]) => ({ kind, why, tier: 'interrupt', tab: 'threads', next: 'reply' }));
  return { key, group: 'others', title, iid: Number(key.split('!')[1]), repo: 'engine', reasons: full, top: full[0], since: AT, interrupt: true, muted: null };
}

function snapshot({ rows = [row()], queue = [], autoPasses = [], cards = [needsCard(KEY, 'Make the engine faster', [['replied', 'ivan replied on 1 thread']])] } = {}) {
  return {
    generatedAt: AT,
    attention: { cards, agents: [], system: [], count: cards.length, prefs: {}, toasts: [], offers: [] },
    version: { ui: 1, lib: 1, worker: 1, loaded: 1 },
    agents: [],
    artifacts: [],
    matrix: {
      available: true, me: 'frank', paused: false, holdSeconds: null, holdWhileReviewing: false,
      inbox: { fetchedAt: AT, loading: false, error: null, repoCount: 1, rows },
      fullAuto: [], roster: [], watches: [], verdicts: {}, queue, runs: [], autoPasses,
    },
  };
}

const note = (author, body) => ({ author, body, createdAt: AT, system: false });

function thread(id, extra = {}) {
  return {
    id, resolved: false, resolvable: true, path: 'src/app.py', line: 12, notes: [note('frank', 'Why?'), note('ivan', 'Because.')],
    awaitsYou: false, handedBack: false, queuedReply: null, ...extra,
  };
}

const THREADS = [
  thread('d-open', { notes: [note('ivan', 'Rename this?')] }),
  thread('d-done', { resolved: true, path: null, line: null }),
  thread('d-wait', { awaitsYou: true }),
  thread('d-back', { handedBack: true, notes: [note('frank', '<b>bold</b> claim'), note('ivan', 'Not so.')] }),
];

function detail(discussions = THREADS) {
  return { key: KEY, me: 'frank', fetchedAt: AT, mr: { iid: 7, repo: 'engine', title: 'Make the engine faster', author: 'ivan' }, discussions, jobs: [] };
}

function finding(extra = {}) {
  return {
    id: 'f1', key: KEY, webUrl: row().webUrl, severity: 'MINOR', kind: 'finding', outcome: null, verdict: null, body: 'This authorises every caller.',
    hunk: null, path: 'src/app.py', line: 2, side: 'new', anchor: null, stale: false, createdBy: 'review', createdAt: AT, status: 'pending', postedAt: null,
    auto: null, error: null, discussionId: null, replyTo: null, ...extra,
  };
}

async function open({ snap = snapshot(), hash = 'merge-requests', discussions, file, refuse = false } = {}) {
  const calls = [];
  const respond = (path, init) => {
    calls.push([init.method, path, init.body ? JSON.parse(init.body) : null]);
    if (path.startsWith('/api/matrix/mr?')) return detail(typeof discussions === 'function' ? discussions() : discussions);
    if (path.startsWith('/api/matrix/file?')) return file ?? null;
    if (init.method === 'POST') return refuse ? null : { ok: true, text: 'Done' };
    return null;
  };
  const page = await openPage({ respond });
  page.show(snap, hash);
  const json = (code) => JSON.parse(page.run('JSON.stringify(' + code + ')'));
  return { ...page, calls, json, posts: () => calls.filter(([method]) => method === 'POST').map(([, path, body]) => [path, body]) };
}

const buttonIn = (page, where, label) => page.$$(where + ' button').find((b) => b.textContent === label);
const cardOf = (page, text) => page.$$('#drawer .thread').find((c) => c.textContent.includes(text));
const cardButton = (card, label) => card.querySelectorAll('button').find((b) => b.textContent === label);

async function drawerOnThreads(options) {
  const page = await open(options);
  page.run(`openMr('${KEY}', 'threads')`);
  await page.settle();
  return page;
}

async function twoClicks(page, find) {
  const before = page.posts().length;
  find().click();
  const armed = find().textContent;
  assert.equal(page.posts().length, before, 'the first click only arms it');
  find().click();
  await page.settle();
  return armed;
}

test('"N unresolved" on an MR row is a chip that opens the MR\'s threads in the drawer', async () => {
  const page = await open({ snap: snapshot({ rows: [row({ unresolved: 3 })] }) });
  const chip = buttonIn(page, '#main .mr', '3 unresolved');
  assert.ok(chip, 'the count is a button');
  chip.click();
  await page.settle();
  assert.deepEqual(page.json('[ui.mr.key, ui.mr.tab]'), [KEY, 'threads']);
  assert.ok(page.$('#drawer .thread'));
});

test('the Threads tab opens on what waits on you, and filters to Open or All', async () => {
  const page = await drawerOnThreads();
  const chipLabels = page.$$('#drawer .chips .chip').map((c) => c.textContent);
  assert.deepEqual(chipLabels, ['Awaiting you (2)', 'Open (3)', 'All (4)']);
  const shown = () => page.$$('#drawer .thread').map((c) => c.querySelector('.say').textContent);
  assert.deepEqual(shown(), ['Why?', '<b>bold</b> claim']);
  buttonIn(page, '#drawer .chips', 'Open (3)').click();
  assert.deepEqual(shown(), ['Why?', '<b>bold</b> claim', 'Rename this?']);
  buttonIn(page, '#drawer .chips', 'All (4)').click();
  assert.equal(shown().length, 4);
  assert.equal(shown().at(-1), 'Why?', 'resolved threads come last');
});

test('a thread you never wrote in is not waiting on you, however it ends', async () => {
  const others = thread('d-others', { awaitsYou: true, notes: [note('ivan', 'Rename this?'), note('bob', 'Agreed.')] });
  const page = await drawerOnThreads({ discussions: [others, THREADS[2]] });
  assert.equal(page.$('#drawer .chip[aria-pressed="true"]').textContent, 'Awaiting you (1)');
  assert.deepEqual(page.$$('#drawer .thread').map((c) => c.querySelector('.say').textContent), ['Why?']);
  buttonIn(page, '#drawer .chips', 'All (2)').click();
  const pills = cardOf(page, 'Agreed.').querySelectorAll('.pill').map((p) => p.textContent);
  assert.ok(!pills.includes('waiting on you'), pills.join(', '));
});

test('a handed-back thread stops waiting on you once you answer it or it is resolved', async () => {
  const answered = thread('d-answered', { handedBack: true, notes: [note('frank', 'Why?'), note('ivan', 'Because.'), note('frank', 'Fair.')] });
  const closed = thread('d-closed', { handedBack: true, resolved: true, notes: [note('frank', 'Closed?'), note('ivan', 'Yes.')] });
  const page = await drawerOnThreads({ discussions: [answered, closed, THREADS[3]] });
  assert.deepEqual(page.$$('#drawer .chips .chip').map((c) => c.textContent), ['Awaiting you (1)', 'Open (2)', 'All (3)']);
  assert.deepEqual(page.$$('#drawer .thread').map((c) => c.querySelector('.say').textContent), ['<b>bold</b> claim']);
});

test('with nothing waiting on you, the tab opens on the open threads', async () => {
  const page = await drawerOnThreads({ discussions: THREADS.slice(0, 2) });
  assert.equal(page.$('#drawer .chip[aria-pressed="true"]').textContent, 'Open (1)');
});

test('a thread card shows its place, which opens the file there, and every note with author and age', async () => {
  const page = await drawerOnThreads();
  const card = cardOf(page, 'Because.');
  assert.deepEqual(card.querySelectorAll('.note .meta').map((m) => m.textContent.split(' · ')[0]), ['frank', 'ivan']);
  assert.match(card.querySelector('.note .meta').textContent, / · \d+ (?:min|h|d) ago$/);
  cardButton(card, 'src/app.py:12').click();
  assert.deepEqual(page.json('[ui.file.key, ui.file.path, ui.file.focus.line]'), [KEY, 'src/app.py', 12]);
});

test('a reply takes two clicks, names the MR, and sends the text with the note count the page saw', async () => {
  const page = await drawerOnThreads();
  cardButton(cardOf(page, 'Because.'), 'Reply').click();
  const box = page.document.activeElement;
  assert.equal(box.id, 'reply-d-wait', 'the reply box takes focus');
  const send = () => cardButton(cardOf(page, 'Because.'), 'Send reply') ?? page.$('#drawer [id="g-reply:d-wait"]');
  assert.equal(send().disabled, true, 'nothing to send yet');
  box.value = 'Fair, I will leave it.';
  page.fire(box, 'input');
  assert.equal(send().disabled, false);
  assert.equal(await twoClicks(page, send), 'Reply on !7?');
  assert.deepEqual(page.posts(), [['/api/matrix/reply', { key: KEY, discussionId: 'd-wait', body: 'Fair, I will leave it.', expect: { notes: 2 } }]]);
  assert.equal(page.run(`ui.drafts.has('thread:d-wait')`), false, 'the box closes once it is sent');
});

test('a refused reply keeps its text and reads the thread again', async () => {
  const page = await drawerOnThreads({ refuse: true });
  cardButton(cardOf(page, 'Because.'), 'Reply').click();
  page.run(`ui.drafts.set('thread:d-wait', 'Keep me')`);
  page.run('render(true)');
  const reads = () => page.calls.filter(([, path]) => path.startsWith('/api/matrix/mr?')).length;
  const before = reads();
  await twoClicks(page, () => page.$('#drawer [id="g-reply:d-wait"]'));
  assert.equal(page.run(`ui.drafts.get('thread:d-wait')`), 'Keep me');
  assert.ok(reads() > before, 'the drawer read the MR again');
});

test('resolve and reopen take two clicks and ask for the opposite of what the page saw', async () => {
  const page = await drawerOnThreads();
  buttonIn(page, '#drawer .chips', 'All (4)').click();
  assert.equal(await twoClicks(page, () => cardButton(cardOf(page, 'Rename this?'), 'Resolve') ?? page.$('#drawer [id="g-resolve:d-open"]')), 'Resolve this thread?');
  assert.equal(await twoClicks(page, () => page.$('#drawer [id="g-resolve:d-done"]')), 'Reopen this thread?');
  assert.deepEqual(page.posts(), [
    ['/api/matrix/resolve', { key: KEY, discussionId: 'd-open', resolved: true }],
    ['/api/matrix/resolve', { key: KEY, discussionId: 'd-done', resolved: false }],
  ]);
});

test('an MR that is no longer open shows its threads with nothing to send', async () => {
  const page = await drawerOnThreads({ snap: snapshot({ rows: [], queue: [finding()] }) });
  assert.ok(page.$('#drawer .thread'));
  assert.equal(page.$$('#drawer .thread button').length, 0);
});

test('Needs you has one card per MR from the worker\'s list, with a pill for each reason, and the rail counts the cards', async () => {
  const cards = [
    needsCard(KEY, 'Make the engine faster', [['replied', 'ivan replied on 2 threads'], ['handed', 'full auto handed 1 thread back to you']]),
    needsCard('acme/engine!9', 'Third', [['replied', 'judy replied on 1 thread']]),
    needsCard(OTHER, 'Other', [['handed', 'full auto handed 2 threads back to you']]),
  ];
  const snap = snapshot({ rows: [row(), row({ key: OTHER, iid: 8, title: 'Other' }), row({ key: 'acme/engine!9', iid: 9, title: 'Third' })], cards });
  const page = await open({ snap, hash: 'needs-you' });
  const entries = page.$$('#main .need-card');
  assert.deepEqual(entries.map((e) => [e.querySelector('.ref').textContent, e.querySelectorAll('.row-head .pill').map((p) => p.textContent)]), [
    ['Make the engine faster', ['replied', 'handed back']],
    ['Third', ['replied']],
    ['Other', ['handed back']],
  ]);
  assert.match(entries[0].textContent, /ivan replied on 2 threads · full auto handed 1 thread back to you/);
  assert.equal(page.$('[data-count="needs"]').textContent, '3', 'one per MR, however many reasons it has');
});

test('Needs you shows nothing the worker did not list, whatever the rows and passes say', async () => {
  const snap = snapshot({ rows: [row({ threads: { mine: 3, unresolved: 3, awaitingYou: 2 } })], autoPasses: [{ key: KEY, handedBack: ['d-back'] }], cards: [] });
  const page = await open({ snap, hash: 'needs-you' });
  assert.equal(page.$$('#main .need-card').length, 0);
  assert.match(page.$('#main').textContent, /Nothing is waiting on you/);
  assert.equal(page.$('[data-count="needs"]').hidden, true);
});

test('an entry in Needs you expands to its threads in place, each with Reply and Resolve', async () => {
  const snap = snapshot({ rows: [row({ threads: { mine: 1, unresolved: 1, awaitingYou: 1 } })], autoPasses: [{ key: KEY, handedBack: ['d-back'] }] });
  const page = await open({ snap, hash: 'needs-you' });
  buttonIn(page, '#main', 'Show here').click();
  await page.settle();
  const cards = page.$$('#main .thread');
  assert.deepEqual(cards.map((c) => c.querySelector('.say').textContent), ['Why?', '<b>bold</b> claim']);
  for (const card of cards) assert.ok(cardButton(card, 'Reply') && cardButton(card, 'Resolve'));
  assert.equal(page.run('ui.mr'), null, 'it stays on the page');
  cardButton(cards[0], 'Reply').click();
  assert.equal(page.document.activeElement.id, 'needs-reply-d-wait');
});

test('a reply or resolve from Needs you reads that MR\'s threads again, so the entry shows what changed', async () => {
  const snap = snapshot({ rows: [row({ threads: { mine: 1, unresolved: 1, awaitingYou: 1 } })] });
  const page = await open({ snap, hash: 'needs-you' });
  buttonIn(page, '#main', 'Show here').click();
  await page.settle();
  const reads = () => page.calls.filter(([, path]) => path.startsWith('/api/matrix/mr?')).length;
  const card = () => page.$$('#main .thread').find((c) => c.textContent.includes('Because.'));
  cardButton(card(), 'Reply').click();
  page.document.activeElement.value = 'Done.';
  page.fire(page.document.activeElement, 'input');
  const before = reads();
  await twoClicks(page, () => page.$('#main [id="g-reply:d-wait"]'));
  assert.equal(reads(), before + 1, 'read again after the reply');
  await twoClicks(page, () => cardButton(card(), 'Resolve') ?? page.$('#main [id="g-resolve:d-wait"]'));
  assert.equal(reads(), before + 2, 'read again after the resolve');
  assert.deepEqual(page.posts().map(([path]) => path), ['/api/matrix/reply', '/api/matrix/resolve']);
});

function fileView() {
  const code = (line, text) => ({ kind: 'code', text, line, change: ' ' });
  const posted = { thread: 0, discussionId: 'd-wait', resolved: false };
  const pending = { thread: 1, pending: true, queueId: 'f1' };
  return {
    key: KEY, path: 'src/app.py', sha: 'aaa111', source: 'file', fileTooBig: false, inDiff: true, tooLarge: false, diffComplete: true, threads: 2, placed: 2, unplaced: 0, pending: 1,
    commentedPaths: ['src/app.py'], starts: [],
    rows: [
      { kind: 'file', text: 'src/app.py' }, code(1, 'one'),
      { kind: 'author', text: 'frank', ...posted }, { kind: 'note', text: 'Why?', ...posted },
      { kind: 'author', text: 'ivan', ...posted }, { kind: 'note', text: 'Because.', ...posted },
      code(2, 'two'),
      { kind: 'author', text: 'frank · MINOR, not posted yet', ...pending }, { kind: 'note', text: 'This authorises every caller.', ...pending },
    ],
  };
}

test('in the file sheet a posted thread gets Reply and Resolve, and a pending finding keeps its own actions', async () => {
  const page = await drawerOnThreads({ snap: snapshot({ queue: [finding()] }), file: fileView() });
  cardButton(cardOf(page, 'Because.'), 'src/app.py:12').click();
  await page.settle();
  const [posted, pending] = page.$$('#sheet .fthread');
  const labels = (block) => block.querySelectorAll('button').map((b) => b.textContent);
  assert.deepEqual(labels(posted), ['Reply', 'Resolve', 'Make a ticket'], 'the thread read for the drawer, so one you wrote in');
  assert.deepEqual(labels(pending), ['Post', 'Edit', 'Discard']);
  cardButton(posted, 'Reply').click();
  const box = page.document.activeElement;
  assert.equal(box.id, 'sheet-reply-d-wait');
  box.value = 'Answered.';
  page.fire(box, 'input');
  assert.equal(await twoClicks(page, () => page.$('#sheet [id="g-reply:d-wait"]')), 'Reply on !7?');
  assert.deepEqual(page.posts(), [['/api/matrix/reply', { key: KEY, discussionId: 'd-wait', body: 'Answered.', expect: { notes: 2 } }]]);
});

test('in the queue a reply waiting to post shows the comment it answers, styled to sit above it', async () => {
  const reply = finding({ id: 'r1', kind: 'reply', severity: null, body: 'Agreed, fixed in the next push.', path: null, replyTo: 'd-wait' });
  const page = await open({ snap: snapshot({ queue: [reply] }), hash: 'review-queue' });
  await page.settle();
  const answers = page.$('#main .item .answers');
  assert.ok(answers, 'the answered comment is shown');
  assert.match(answers.textContent, /In answer to.*ivan · .*Because\./);
  const css = await readFile(new URL('./30-threads.css', import.meta.url), 'utf8');
  assert.match(css, /\.item > \.answers \{ order: -1; \}/);
  assert.match(css, /\.item > \.row-head:first-child \{ order: -2; \}/, 'the reply\'s own heading stays on top');
});

test('the comment a queued reply answers is the last one not yours, even when you wrote after it', async () => {
  const reply = finding({ id: 'r1', kind: 'reply', severity: null, body: 'Agreed.', path: null, replyTo: 'd-wait' });
  const asked = thread('d-wait', { notes: [note('ivan', 'Rename this?'), note('frank', 'Looking now')] });
  const page = await open({ snap: snapshot({ queue: [reply] }), hash: 'review-queue', discussions: [asked] });
  await page.settle();
  assert.deepEqual(page.$$('#main .item .answers .say').map((s) => s.textContent), ['Rename this?']);
});

test('in the queue a posted finding shows its live thread on request, with Reply and Resolve', async () => {
  const posted = finding({ status: 'posted', postedAt: AT, discussionId: 'd-wait' });
  const page = await open({ snap: snapshot({ queue: [posted] }), hash: 'review-queue' });
  page.run(`ui.queueFilter = 'posted'; render()`);
  assert.equal(page.calls.filter(([, path]) => path.startsWith('/api/matrix/mr?')).length, 0, 'nothing is read until asked');
  buttonIn(page, '#main .item', 'Show the thread').click();
  await page.settle();
  const shown = page.$('#main .item .thread');
  assert.deepEqual(shown.querySelectorAll('.say').map((s) => s.textContent), ['Because.'], 'the replies under the finding');
  assert.match(shown.textContent, /1 reply/);
  assert.ok(cardButton(shown, 'Reply') && cardButton(shown, 'Resolve'));
});

const answered = () => thread('d-wait', { notes: [note('frank', 'Rename this?'), note('ivan', 'Why?'), note('frank', 'Clearer.')] });
const postedReply = (id, postedAt) => finding({ id, kind: 'reply', severity: null, body: 'Reply ' + id, path: null, status: 'posted', postedAt, replyTo: 'd-wait' });
const itemOf = (page, where, text) => page.$$(where + ' .item').find((i) => i.querySelector('.md').textContent === text);

test('a thread with posted replies is drawn once, with its finding, so its reply box is the only one', async () => {
  const items = [finding({ status: 'posted', postedAt: AT, discussionId: 'd-wait' }), postedReply('r1', AT), postedReply('r2', AT)];
  const page = await open({ snap: snapshot({ queue: items }), discussions: [answered()] });
  page.run(`openMr('${KEY}', 'findings')`);
  await page.settle();
  buttonIn(page, '#drawer .chips', 'All (3)').click();
  const threads = page.$$('#drawer .item .thread');
  assert.equal(threads.length, 1);
  assert.ok(itemOf(page, '#drawer', 'This authorises every caller.').contains(threads[0]), 'it sits with the finding');
  assert.match(threads[0].textContent, /2 replies/);
  assert.deepEqual(threads[0].querySelectorAll('.say').map((s) => s.textContent), ['Why?', 'Clearer.']);
  for (const id of ['r1', 'r2']) assert.match(itemOf(page, '#drawer', 'Reply ' + id).textContent, /Its thread is shown with the finding\./);
  cardButton(threads[0], 'Reply').click();
  const boxes = page.$$('#drawer textarea').filter((b) => b.id === 'item-reply-d-wait');
  assert.equal(boxes.length, 1);
  assert.equal(page.document.activeElement, boxes[0]);
  assert.equal(page.$$('#drawer [id="g-reply:d-wait"]').length, 1);
  page.run('closeMr(); ui.queueFilter = \'posted\'; ui.drafts.clear()');
  page.show(snapshot({ queue: items }), 'review-queue');
  assert.equal(page.$$('#main button').filter((b) => b.textContent === 'Show the thread').length, 1, 'one toggle for the thread');
});

test('with no finding queued, a thread is drawn whole with its newest posted reply', async () => {
  const items = [postedReply('r1', '2026-11-05T11:00:00Z'), postedReply('r2', AT)];
  const page = await open({ snap: snapshot({ queue: items }), discussions: [answered()] });
  page.run(`openMr('${KEY}', 'findings')`);
  await page.settle();
  buttonIn(page, '#drawer .chips', 'All (2)').click();
  const threads = page.$$('#drawer .item .thread');
  assert.equal(threads.length, 1);
  assert.ok(itemOf(page, '#drawer', 'Reply r2').contains(threads[0]));
  assert.match(threads[0].textContent, /3 comments/);
  assert.equal(threads[0].querySelectorAll('.say').length, 3);
  assert.match(itemOf(page, '#drawer', 'Reply r1').textContent, /Its thread is shown with the latest reply\./);
});

test('a post moves the queue, so threads read before it are read again rather than called gone', async () => {
  let discussions = [THREADS[2]];
  const reply = finding({ id: 'r1', kind: 'reply', severity: null, body: 'Agreed.', path: null, replyTo: 'd-wait' });
  const page = await open({ snap: snapshot({ queue: [reply, finding()] }), hash: 'review-queue', discussions: () => discussions });
  await page.settle();
  const reads = () => page.calls.filter(([, path]) => path.startsWith('/api/matrix/mr?')).length;
  assert.equal(reads(), 1, 'the queued reply read the comment it answers');
  await twoClicks(page, () => page.$('#main [id="g-post:f1"]'));
  assert.deepEqual(page.posts(), [['/api/matrix/post', { id: 'f1' }]]);
  discussions = [THREADS[2], thread('d-new', { notes: [note('frank', 'This authorises every caller.')] })];
  page.run(`ui.queueFilter = 'posted'`);
  page.show(snapshot({ queue: [reply, finding({ status: 'posted', postedAt: AT, discussionId: 'd-new' })] }), 'review-queue');
  buttonIn(page, '#main .item', 'Show the thread').click();
  assert.match(page.$('#main .item .thread').textContent, /Reading the thread from GitLab/);
  await page.settle();
  assert.equal(reads(), 2);
  const shown = page.$('#main .item .thread').textContent;
  assert.doesNotMatch(shown, /no longer has/);
  assert.match(shown, /No reply yet/);
});

test('an expanded entry reads GitLab again only while Needs you or Overview is on screen', async () => {
  const snap = snapshot({ rows: [row({ threads: { mine: 1, unresolved: 1, awaitingYou: 1 } })] });
  const page = await open({ snap, hash: 'needs-you' });
  const reads = () => page.calls.filter(([, path]) => path.startsWith('/api/matrix/mr?')).length;
  buttonIn(page, '#main', 'Show here').click();
  await page.settle();
  assert.equal(reads(), 1);
  const stale = `threadReads.get('${KEY}').at = 0; render()`;
  page.show(snap, 'agents');
  page.run(stale);
  await page.settle();
  assert.equal(reads(), 1, 'nothing on screen shows it');
  page.show(snap, 'needs-you');
  page.run(stale);
  await page.settle();
  assert.equal(reads(), 2);
});

test('a thread note reads as formatted text, and its links open a known MR here or are offered in Orca', async () => {
  const body = '**Rename** `cache_get`, as [!8](https://gitlab.com/acme/engine/-/merge_requests/8) did, see https://example.com/why.';
  const snap = snapshot({ rows: [row(), row({ key: OTHER, iid: 8, title: 'Other' })] });
  const page = await drawerOnThreads({ snap, discussions: [thread('d-md', { awaitsYou: true, notes: [note('frank', 'Why?'), note('ivan', body)] })] });
  const say = cardOf(page, 'Rename').querySelectorAll('.say')[1];
  assert.equal(say.querySelector('strong').textContent, 'Rename');
  assert.equal(say.querySelector('code').textContent, 'cache_get');
  const [mrLink, offsite] = say.querySelectorAll('.md-link');
  offsite.click();
  assert.match(page.$('#toast').textContent, /That link leads out of Underlings\./);
  assert.ok(!page.requested.includes('/api/open'));
  mrLink.click();
  assert.equal(page.run('ui.mr.key'), OTHER);
});

test('the file sheet reads each note as formatted text', async () => {
  const file = fileView();
  file.rows = file.rows.flatMap((r) => (r.text === 'Because.' ? [{ ...r, text: '**Because** `x`' }, { ...r, text: 'is stale.' }] : [r]));
  const page = await drawerOnThreads({ snap: snapshot({ queue: [finding()] }), file });
  cardButton(cardOf(page, 'Because.'), 'src/app.py:12').click();
  await page.settle();
  const say = page.$$('#sheet .fthread .say').find((s) => s.textContent.startsWith('Because'));
  assert.equal(say.querySelector('strong').textContent, 'Because');
  assert.equal(say.querySelector('code').textContent, 'x');
  assert.equal(say.querySelector('p').textContent, 'Because x\nis stale.', 'the note\'s rows are one paragraph again');
});

test('Needs you shows a waiting finding and the threads behind a card as formatted text', async () => {
  const card = needsCard(KEY, 'Make the engine faster', [['replied', 'ivan replied on 1 thread'], ['findings', '1 to post']]);
  const discussions = [thread('d-wait', { awaitsYou: true, notes: [note('frank', 'Why?'), note('ivan', 'Because it is **slow**.')] })];
  const page = await open({ snap: snapshot({ queue: [finding({ body: '_Consider_ caching it.' })], cards: [card] }), hash: 'needs-you', discussions });
  buttonIn(page, '#main', 'Show here').click();
  await page.settle();
  assert.equal(page.$('#main .need-behind .item .md em').textContent, 'Consider');
  assert.equal(page.$('#main .need-behind .thread .say strong').textContent, 'slow');
});
