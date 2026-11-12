import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openPage } from './testkit.mjs';

const KEY = 'acme/engine!7';
const AT = '2026-11-05T12:00:00Z';

function row() {
  return {
    key: KEY, iid: 7, repo: 'engine', title: 'Make the engine faster', webUrl: 'https://gitlab.com/acme/engine/-/merge_requests/7', author: 'ivan', reviewers: ['frank'],
    approvedBy: [], draft: false, pipeline: 'FAILED', ticket: 'ABC-1', updatedAt: AT, unresolved: 0, threads: null, mergeStatus: 'MERGEABLE', sourceBranch: 'feat/7',
    sha: 'aaa111', agentHandle: null, watch: null, flags: { waitingOnYou: true }, phase: 'open', count: 0, mood: 'awaitingYou', verdict: null, agent: null, level: null,
  };
}

function snapshot() {
  return {
    generatedAt: AT,
    version: { ui: 1, lib: 1, worker: 1, loaded: 1 },
    agents: [],
    artifacts: [],
    matrix: {
      available: true, me: 'frank', paused: false, holdSeconds: null, holdWhileReviewing: false,
      inbox: { fetchedAt: AT, loading: false, error: null, repoCount: 1, rows: [row()] },
      fullAuto: [], roster: [], watches: [], verdicts: {}, queue: [], runs: [], autoPasses: [],
    },
  };
}

const job = (id, name, stage, status, extra = {}) => ({ id, name, stage, status, duration: 64.3, allowFailure: false, ...extra });

function pipeline(jobs) {
  return { key: KEY, sha: 'aaa111', status: 'FAILED', pipelineId: 900, fetchedAt: AT, jobs };
}

const JOBS = [
  job(14, 'deploy', 'deploy', 'manual', { duration: null }),
  job(13, 'pytest', 'test', 'success', { duration: 352 }),
  job(12, 'lint', 'test', 'failed'),
  job(11, 'audit', 'test', 'failed', { allowFailure: true }),
  job(10, 'build', 'build', 'success', { duration: 5 }),
];

// GitLab as the worker relays it: each read answers from here, and every request is kept to look at.
async function pipelinePage({ jobs = JOBS, log = (id) => ({ jobId: id, lines: ['<b>not markup</b>', 'FAILED test_engine.py'], total: 3343 }) } = {}) {
  const seen = [];
  const reads = { jobs };
  const page = await openPage({
    respond(path, init) {
      seen.push([init?.method ?? 'GET', path, init?.body ? JSON.parse(init.body) : null]);
      if (path === '/api/matrix/failed-jobs') return { counts: { [KEY]: 1 } };
      if (path.startsWith('/api/matrix/mr?')) return { key: KEY, me: 'frank', fetchedAt: AT, mr: { ...row(), unresolved: 0 }, discussions: [], jobs: [] };
      if (path.startsWith('/api/matrix/pipeline?')) return pipeline(reads.jobs);
      if (path.startsWith('/api/matrix/job-log?')) return log(Number(new URLSearchParams(path.split('?')[1]).get('job')));
      if (path.startsWith('/api/matrix/retry-')) return { ok: true, text: 'Retrying' };
      return null;
    },
  });
  const timers = [];
  const realTimeout = page.window.setTimeout;
  page.window.setTimeout = (fn, ms) => (ms === 5000 ? timers.push(fn) : realTimeout(fn, ms));
  const selection = selectionOf(page);
  page.show(snapshot(), 'merge-requests');
  await page.settle();
  return { page, seen, reads, timers, selection, requests: (prefix) => seen.filter(([, path]) => path.startsWith(prefix)) };
}

// Like the browser's: a selection in a node that has left the page selects nothing.
function selectionOf(page) {
  const s = {
    rangeCount: 0, anchorNode: null, anchorOffset: 0, focusNode: null, focusOffset: 0,
    setBaseAndExtent(anchorNode, anchorOffset, focusNode, focusOffset) {
      Object.assign(s, { rangeCount: 1, anchorNode, anchorOffset, focusNode, focusOffset });
    },
    toString: () => (s.anchorNode?.isConnected && s.anchorNode === s.focusNode ? s.anchorNode.data.slice(s.anchorOffset, s.focusOffset) : ''),
  };
  page.document.getSelection = () => s;
  return s;
}

const LINE_PX = 18;
const BOX_PX = 300;

// Lays a log out as Chromium does: 18 px lines in a 300 px box, with scrollTop counting up from the end since pre.console is column-reverse.
function layOutLogs(page) {
  const proto = Object.getPrototypeOf(page.document.createElement('pre'));
  const flat = proto.getBoundingClientRect;
  const rowsOf = (pre) => pre.childNodes[0].childNodes;
  proto.getBoundingClientRect = function () {
    if (this.matches('pre.console')) return { top: 100, bottom: 100 + BOX_PX };
    const pre = this.closest('pre.console');
    if (!pre || !this.matches('span.line')) return flat.call(this);
    const fromTop = rowsOf(pre).length * LINE_PX - BOX_PX + pre.scrollTop;
    const top = 100 + rowsOf(pre).indexOf(this) * LINE_PX - fromTop;
    return { top, bottom: top + LINE_PX };
  };
  Object.defineProperty(proto, 'scrollHeight', { configurable: true, get() { return this.matches('pre.console') ? rowsOf(this).length * LINE_PX : 0; } });
  return () => {
    proto.getBoundingClientRect = flat;
    delete proto.scrollHeight;
  };
}

function topLine(page, id) {
  const pre = page.$('#log-' + id);
  const top = pre.getBoundingClientRect().top;
  return pre.childNodes[0].childNodes.find((row) => row.getBoundingClientRect().bottom > top).textContent.trim();
}

function scrollLog(page, id, to) {
  const log = page.$('#log-' + id);
  log.scrollTop = to;
  page.fire(log, 'scroll', { bubbles: false });
}

const numbered = (from, count) => Array.from({ length: count }, (_, i) => 'line ' + (from + i));

async function openPipeline(found) {
  found.page.$('#main .mr button.pipe').click();
  await found.page.settle();
  return found;
}

const drawerText = (page, selector) => page.$$('#drawer ' + selector).map((n) => n.textContent);
const buttonCalled = (page, label) => page.$$('#drawer button').find((b) => b.textContent === label);
// Strict assert ignores a fake node's custom inspect and walks the whole page, so assertions compare labels, never nodes.
const retryLabels = (page) => page.$$('#drawer button').map((b) => b.textContent).filter((label) => label.startsWith('Retry'));

test('the pipeline chip says how many jobs failed and opens the drawer on the Pipeline tab', async () => {
  const { page } = await pipelinePage();
  const chip = page.$('#main .mr button.pipe');
  assert.equal(chip.getAttribute('title'), 'Pipeline failed, 1 job failed. Show its jobs here');
  chip.click();
  await page.settle();
  assert.equal(page.run('ui.mr.key'), KEY);
  assert.equal(page.run('ui.mr.tab'), 'pipeline');
  assert.equal(page.$('#mr-tab-pipeline').getAttribute('aria-selected'), 'true');
});

test('jobs are grouped by stage with the failing stage first, failures first within it, each with its status and run time', async () => {
  const { page } = await openPipeline(await pipelinePage());
  assert.deepEqual(drawerText(page, '.stage h3'), ['test', 'build', 'deploy']);
  const rows = page.$$('#drawer .job').map((r) => [r.querySelector('.job-toggle').textContent, r.querySelector('.pill').textContent, r.querySelector('.meta')?.textContent ?? null]);
  assert.deepEqual(rows, [
    ['lint', 'failed', '1 min 4 s'],
    ['audit', 'failed, allowed', '1 min 4 s'],
    ['pytest', 'passed', '5 min 52 s'],
    ['build', 'passed', '5 s'],
    ['deploy', 'manual', null],
  ]);
  assert.match(page.$('#drawer .drawer-body .foot .meta').textContent, /^1 failed, 1 allowed to fail, 1 manual, 2 passed · at aaa111 · read /);
});

test('a job opens on the end of its log, as text, with how much of the log that is', async () => {
  const { page, requests } = await openPipeline(await pipelinePage());
  page.$('#job-12').focus();
  page.$('#job-12').click();
  await page.settle();
  assert.equal(page.$('#job-12').getAttribute('aria-expanded'), 'true');
  assert.deepEqual(requests('/api/matrix/job-log').map(([, path]) => path), ['/api/matrix/job-log?key=acme%2Fengine%217&job=12']);
  const log = page.$('#drawer .job pre.console');
  assert.equal(log.textContent, '<b>not markup</b>\nFAILED test_engine.py');
  assert.deepEqual(log.querySelectorAll('*').map((n) => n.tagName), ['SPAN', 'SPAN', 'SPAN']);
  assert.equal(page.$$('#drawer pre.console .line').every((row) => row.childNodes.length === 1 && row.childNodes[0].nodeType === 3), true);
  assert.equal(page.document.activeElement.id, 'job-12');
  assert.match(drawerText(page, '.job .meta').join(' '), /The last 2 of 3,343 lines\./);
});

test('retrying a job takes two clicks, names the job, and sends the head and status the page saw', async () => {
  const { page, requests } = await openPipeline(await pipelinePage());
  const before = requests('/api/matrix/pipeline').length;
  buttonCalled(page, 'Retry job').click();
  assert.equal(requests('/api/matrix/retry-job').length, 0);
  buttonCalled(page, 'Retry lint?').click();
  await page.settle();
  assert.deepEqual(requests('/api/matrix/retry-job').map(([method, , body]) => [method, body]), [
    ['POST', { key: KEY, jobId: 12, expect: { sha: 'aaa111', status: 'failed' } }],
  ]);
  assert.equal(requests('/api/matrix/pipeline').length, before + 1);
  assert.deepEqual(retryLabels(page), ['Retry failed jobs', 'Retry job', 'Retry job']);
});

test('Retry failed jobs retries the whole head pipeline once confirmed, and is offered only when something failed', async () => {
  const found = await openPipeline(await pipelinePage());
  buttonCalled(found.page, 'Retry failed jobs').click();
  buttonCalled(found.page, 'Retry 2 jobs on !7?').click();
  await found.page.settle();
  assert.deepEqual(found.requests('/api/matrix/retry-pipeline').map(([, , body]) => body), [{ key: KEY, pipelineId: 900, expect: { sha: 'aaa111' } }]);
  const passing = await openPipeline(await pipelinePage({ jobs: [job(10, 'build', 'build', 'success')] }));
  assert.deepEqual(retryLabels(passing.page), []);
});

test('while a job runs, the jobs and its open log are read again every 5 s, and the polling stops once nothing moves', async () => {
  const found = await openPipeline(await pipelinePage({ jobs: [job(20, 'pytest', 'test', 'running')] }));
  found.page.$('#job-20').click();
  await found.page.settle();
  assert.equal(found.timers.length, 1);
  found.reads.jobs = [job(20, 'pytest', 'test', 'failed')];
  found.timers.shift()();
  await found.page.settle();
  assert.equal(found.requests('/api/matrix/pipeline').length, 2);
  assert.equal(found.requests('/api/matrix/job-log').length, 2);
  assert.equal(found.timers.length, 0);
  assert.equal(buttonCalled(found.page, 'Retry job')?.textContent, 'Retry job');
});

test('a retried job comes back under a new id with its log still open', async () => {
  const found = await openPipeline(await pipelinePage());
  found.page.$('#job-12').click();
  await found.page.settle();
  found.reads.jobs = JOBS.map((j) => (j.id === 12 ? job(15, 'lint', 'test', 'pending', { duration: null }) : j));
  buttonCalled(found.page, 'Retry job').click();
  buttonCalled(found.page, 'Retry lint?').click();
  await found.page.settle();
  assert.equal(found.page.run("ui.open.has('job:15') && !ui.open.has('job:12')"), true);
  assert.equal(found.page.$('#job-15').getAttribute('aria-expanded'), 'true');
});

test('a merged MR still shows its pipeline, without retry buttons', async () => {
  const found = await pipelinePage();
  found.page.run(`openMr('acme/engine!99', 'pipeline')`);
  await found.page.settle();
  assert.ok(found.page.$$('#drawer .job').length > 0);
  assert.deepEqual(retryLabels(found.page), []);
});

test('a chip with no MR behind it, as in a legend, is a plain label that asks GitLab nothing', async () => {
  const { page, requests } = await pipelinePage();
  const before = requests('/api/matrix/failed-jobs').length;
  page.run(`window.legendChip = slot('pipelineChip', { pipeline: 'FAILED' })`);
  assert.equal(page.run('legendChip.tagName'), 'SPAN');
  assert.equal(page.run('legendChip.textContent'), 'failed');
  await page.settle();
  assert.equal(requests('/api/matrix/failed-jobs').length, before);
});

test('an engine built before job logs says it needs rebuilding, whatever the engine banner reads, and Try again reads the pipeline afresh', async () => {
  const found = await pipelinePage();
  found.page.run(`engineBanner = () => banner('The review engine is not loaded: ' + (state.matrix.error || 'unknown error'), true)`);
  const answer = found.page.window.fetch;
  let stale = true;
  found.page.window.fetch = async (path, init) => (stale && path.startsWith('/api/matrix/pipeline?')
    ? { ok: false, status: 501, json: async () => null, text: async () => 'The review engine needs rebuilding: this build has no fetchJobTrace' }
    : answer(path, init));
  await openPipeline(found);
  assert.deepEqual(drawerText(found.page, '.banner'), ['Could not read the pipeline: The review engine needs rebuilding: this build has no fetchJobTrace']);
  stale = false;
  buttonCalled(found.page, 'Try again').click();
  await found.page.settle();
  assert.deepEqual(drawerText(found.page, '.banner'), []);
  assert.ok(found.page.$$('#drawer .job').length > 0);
});

test('a log scrolled up to read keeps the same line at the top through a redraw, and while it runs, as lines come in and older ones drop off', async (t) => {
  let lines = numbered(1, 150);
  const found = await openPipeline(await pipelinePage({ jobs: [job(20, 'pytest', 'test', 'running')], log: (id) => ({ jobId: id, lines, total: null }) }));
  t.after(layOutLogs(found.page));
  found.page.$('#job-20').click();
  await found.page.settle();
  scrollLog(found.page, 20, -1200);
  const reading = topLine(found.page, 20);
  assert.equal(reading, 'line 67');

  found.page.run('render(true)');
  await found.page.settle(0);
  assert.equal(topLine(found.page, 20), reading);

  lines = numbered(1, 190);
  found.timers.shift()();
  await found.page.settle();
  assert.equal(found.requests('/api/matrix/job-log').length, 2);
  assert.equal(topLine(found.page, 20), reading);

  lines = numbered(31, 200);
  found.timers.shift()();
  await found.page.settle();
  assert.equal(found.requests('/api/matrix/job-log').length, 3);
  assert.equal(topLine(found.page, 20), reading);
});

test('a log read to its end stays at its end as lines come in', async (t) => {
  let lines = numbered(1, 200);
  const found = await openPipeline(await pipelinePage({ jobs: [job(20, 'pytest', 'test', 'running')], log: (id) => ({ jobId: id, lines, total: lines.length }) }));
  t.after(layOutLogs(found.page));
  found.page.$('#job-20').click();
  await found.page.settle();
  lines = numbered(41, 200);
  found.timers.shift()();
  await found.page.settle();
  assert.equal(found.page.$('#log-20').scrollTop, 0);
  assert.equal(found.page.$('#log-20').textContent.split('\n').at(-1), 'line 240');
});

test('text selected in a log stays selected when a poll or a refresh redraws the drawer', async () => {
  const lines = numbered(1, 60).map((line, i) => (i === 40 ? 'FAILED tests/unit/migrations/test_20260915090000_add_index.py' : line));
  const found = await openPipeline(await pipelinePage({ jobs: [job(30, 'test', 'test', 'failed'), job(31, 'deploy', 'deploy', 'created')], log: (id) => ({ jobId: id, lines, total: 60 }) }));
  found.page.$('#job-30').click();
  await found.page.settle();
  const text = found.page.$$('#log-30 .line')[40].childNodes[0];
  found.selection.setBaseAndExtent(text, 7, text, 47);
  assert.equal(found.selection.toString(), 'tests/unit/migrations/test_2026091509000');

  found.timers.shift()();
  await found.page.settle();
  assert.equal(found.requests('/api/matrix/pipeline').length, 2);
  assert.equal(found.selection.toString(), 'tests/unit/migrations/test_2026091509000');

  found.page.run('refresh()');
  await found.page.settle(400);
  assert.equal(found.selection.toString(), 'tests/unit/migrations/test_2026091509000');
  assert.equal(found.page.$('#log-30').contains(found.selection.anchorNode), true);
});

test('a stage keeps its place in the pipeline after its only job is retried under a new id, and after the drawer reopens', async () => {
  const found = await openPipeline(await pipelinePage({
    jobs: [job(10, 'compile', 'build', 'success'), job(11, 'lint', 'lint', 'failed'), job(12, 'pytest', 'test', 'skipped'), job(13, 'ship', 'deploy', 'skipped')],
  }));
  assert.deepEqual(drawerText(found.page, '.stage h3'), ['lint', 'build', 'test', 'deploy']);
  found.reads.jobs = [job(10, 'compile', 'build', 'success'), job(14, 'lint', 'lint', 'running'), job(12, 'pytest', 'test', 'created'), job(13, 'ship', 'deploy', 'created')];
  buttonCalled(found.page, 'Retry job').click();
  buttonCalled(found.page, 'Retry lint?').click();
  await found.page.settle();
  assert.deepEqual(drawerText(found.page, '.stage h3'), ['build', 'lint', 'test', 'deploy']);
  found.page.run('closeMr()');
  await openPipeline(found);
  assert.deepEqual(drawerText(found.page, '.stage h3'), ['build', 'lint', 'test', 'deploy']);
});
