import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as kit from './testkit.mjs';

const H = 36e5;
const D = 24 * H;
const NOW = Date.parse('2026-11-06T12:00:00Z');
const iso = (ms) => new Date(ms).toISOString();
const before = (ms) => iso(NOW - ms);

let ids = 0;
function item(extra = {}) {
  ids += 1;
  return { id: 'q' + ids, projectPath: 'acme/engine', iid: 7, severity: 'MINOR', createdBy: 'ws:mr-review', createdAt: before(H), status: 'posted', postedAt: before(H), ...extra };
}

function input(extra = {}) {
  return { now: NOW, timeZone: 'Europe/London', me: 'frank', rows: [], queue: [item({ createdAt: before(20 * D), postedAt: before(20 * D) })], runs: [], memory: {}, history: [], gitlab: { merged: [], reviewed: [] }, ...extra };
}

const row = (key, extra = {}) => ({ key, title: 'MR ' + key, author: 'ivan', draft: false, mergeStatus: 'NOT_APPROVED', unresolved: 0, approvedBy: [], flags: {}, threads: null, ...extra });
const auto = (extra = {}) => ({ pass: 'p1', level: 'comments', sendAt: before(H), ...extra });

const home = await mkdtemp(join(tmpdir(), 'control-centre-stats-'));
process.env.HOME = home;
process.env.GITLAB_TOKEN = 'stub-token';
process.env.UNDERLINGS_STATE_DIR = join(home, 'engine-state');
const built = await import('../engine/dist/engine.js');
const KIT = new URL('./testkit.mjs', import.meta.url);
const flagged = (inbox) => inbox.mrs.map((m) => ({ mr: m, key: `${m.projectPath}!${m.iid}`, flags: { mine: m.author === inbox.me, waitingOnYou: m.author !== inbox.me && m.reviewers.includes(inbox.me) } }));
mock.module(KIT.href, { namedExports: { ...kit, rowsFor: flagged, currentRepos: async () => [{ path: 'acme/engine' }, { path: 'acme/web' }], forgeOf: built.forgeOf } });
const refuse = async (url) => { throw new Error(`no network in tests: ${url}`); };
globalThis.fetch = refuse;
const events = [];
const { loadEngine, refreshInbox } = await import('./engine.mjs');
const stats = await import('./stats.mjs');
const { computeStats, toneOf, weekOf } = stats;
const figure = (out, id) => out.headline.find((h) => h.id === id);
const flush = async () => { for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
async function until(check) {
  for (let i = 0; i < 200; i += 1) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}

after(() => rm(home, { recursive: true, force: true }));

test('each headline figure comes from the records, with its change on the week before', () => {
  const out = computeStats(input({
    rows: [
      row('acme/engine!1', { flags: { waitingOnYou: true } }),
      row('acme/engine!2', { flags: { waitingOnYou: true } }),
      row('acme/engine!3', { author: 'frank', flags: { mine: true }, threads: { mine: 1, unresolved: 1, awaitingYou: 1 } }),
      row('acme/engine!4', { author: 'frank', flags: { mine: true }, draft: true }),
    ],
    history: [{ at: NOW - 7 * D + 2 * H, waiting: 5, open: 1 }, { at: NOW - 3 * D, waiting: 9, open: 9 }],
    queue: [
      item({ createdAt: before(20 * D), postedAt: before(20 * D) }),
      ...[1, 2, 3].map(() => item({ createdAt: before(2 * D) })),
      item({ createdAt: before(2 * D), status: 'discarded', postedAt: null }),
      item({ createdAt: before(2 * D), status: 'discarded', postedAt: null, auto: auto({ superseded: 'a newer pass replaced it' }) }),
      item({ createdAt: before(2 * D), status: 'pending', postedAt: null, auto: auto({ held: 'over the cap' }) }),
      item({ createdAt: before(D), postedAt: before(D), auto: auto({ sentAuto: true }) }),
      item({ kind: 'reply', replyTo: 'd1', createdAt: before(D), postedAt: before(D), auto: auto({ sentAuto: true }) }),
      item({ kind: 'reply', replyTo: 'd2', createdAt: before(D), postedAt: before(D), auto: auto({ sentAuto: true }) }),
      item({ createdAt: before(9 * D), postedAt: before(9 * D) }),
      item({ createdAt: before(9 * D), postedAt: before(9 * D), auto: auto({ sentAuto: true }) }),
    ],
    runs: [
      { key: 'acme/engine!1', startedAt: before(D), status: 'running' },
      { key: 'acme/engine!2', startedAt: before(2 * D), status: 'launch failed' },
      { key: 'acme/engine!5', startedAt: before(9 * D), status: 'running' },
      { key: 'acme/engine!6', startedAt: before(20 * D), status: 'running' },
      { key: 'ticket:ABC-1', startedAt: before(D), status: 'running' },
    ],
  }));
  const shown = (id) => {
    const { value, previous, change, tone, note, alert } = figure(out, id);
    return { value, previous, change, tone, note, alert };
  };
  assert.deepEqual(shown('waiting'), { value: 2, previous: 5, change: -3, tone: 'good', note: null, alert: false });
  assert.deepEqual(shown('findings'), { value: 4, previous: 2, change: 2, tone: 'flat', note: '20% discarded', alert: false });
  assert.deepEqual(shown('open'), { value: 2, previous: 1, change: 1, tone: 'flat', note: '1 wait on you', alert: false });
  assert.deepEqual(shown('fullAuto'), { value: 3, previous: 1, change: 2, tone: 'flat', note: '1 finding, 2 replies', alert: false });
  assert.deepEqual(shown('runs'), { value: 2, previous: 1, change: 1, tone: 'flat', note: '1 of 2 reported a launch error', alert: true });
});

test('a launch error is reported as the engine recorded it, and a run that queued items soon after its start counts as having run anyway', () => {
  const run = (iid, ago, status = 'launch failed') => ({ key: 'acme/engine!' + iid, startedAt: before(ago), status });
  const runs = [run(1, 2 * H), run(2, D), run(3, 3 * D), run(4, 4 * D, 'running')];
  const queue = [
    item({ createdAt: before(20 * D), postedAt: before(20 * D) }),
    item({ iid: 1, createdAt: before(H) }),
    item({ iid: 2, createdAt: before(D + H) }),
    item({ iid: 3, createdAt: before(3 * D - 7 * H) }),
  ];
  const runs7 = figure(computeStats(input({ queue, runs })), 'runs');
  assert.deepEqual([runs7.value, runs7.note, runs7.alert], [4, '3 of 4 reported a launch error, 1 ran anyway', true]);
  const calm = figure(computeStats(input({ queue, runs: [run(4, 4 * D, 'running')] })), 'runs');
  assert.deepEqual([calm.note, calm.alert], ['No launch errors', false]);
  const old = figure(computeStats(input({ queue, runs: [run(5, 9 * D)] })), 'runs');
  assert.deepEqual([old.value, old.note, old.alert], [0, null, false], 'a week with no runs has no note about them');
});

test('time to first review runs from the MR opening to its first run or finding, by you or full auto, never your own MR', () => {
  const opened = (key, ms, author = 'ivan') => ({ key, title: key, author, createdAt: before(ms), mergedAt: null });
  const out = computeStats(input({
    queue: [
      item({ createdAt: before(20 * D), postedAt: before(20 * D) }),
      item({ iid: 1, createdAt: before(3 * D - 2 * H) }),
      item({ iid: 1, createdAt: before(D) }),
      item({ iid: 2, createdAt: before(D) }),
      item({ iid: 3, createdAt: before(10 * D - H) }),
      item({ iid: 4, createdAt: before(D) }),
    ],
    runs: [
      { key: 'acme/engine!2', startedAt: before(2 * D - 6 * H), status: 'running' },
      { key: 'acme/engine!5', startedAt: before(D), status: 'launch failed' },
    ],
    gitlab: {
      merged: [],
      reviewed: [opened('acme/engine!1', 3 * D), opened('acme/engine!2', 2 * D), opened('acme/engine!3', 10 * D), opened('acme/engine!4', 2 * D, 'frank'), opened('acme/engine!5', 2 * D)],
    },
  }));
  const { value, previous, change, tone, note } = figure(out, 'firstReview');
  assert.deepEqual({ value, previous, change, tone, note }, { value: 4 * H, previous: H, change: 3 * H, tone: 'bad', note: 'over 2 MRs' });
});

test('a week is the 7 days ending now: the instant 7 days back belongs to the week before, and 14 days back to neither', () => {
  assert.equal(weekOf(NOW, NOW), 0);
  assert.equal(weekOf(NOW - 7 * D + 1, NOW), 0);
  assert.equal(weekOf(NOW - 7 * D, NOW), 1);
  assert.equal(weekOf(NOW - 14 * D + 1, NOW), 1);
  assert.equal(weekOf(NOW - 14 * D, NOW), null);
  assert.equal(weekOf(NOW + 1, NOW), null);
  const out = computeStats(input({
    queue: [
      item({ createdAt: before(20 * D) }),
      item({ createdAt: before(7 * D - 1) }),
      item({ createdAt: before(7 * D) }),
      item({ createdAt: before(14 * D) }),
    ],
  }));
  assert.deepEqual([figure(out, 'findings').value, figure(out, 'findings').previous], [1, 1]);
});

test('with no records every figure says so in words, and no zero stands in for a missing week', () => {
  const out = computeStats({ now: NOW, timeZone: 'Europe/London', me: null, rows: null, queue: [], runs: [], memory: {}, history: [], gitlab: { waiting: 'the MR list to load' } });
  for (const h of out.headline) {
    assert.equal(h.value, null, h.id);
    assert.equal(h.change, null, h.id);
    assert.ok(h.empty && !/\b0\b/.test(h.empty), `${h.id}: ${h.empty}`);
  }
  for (const [id, chart] of Object.entries(out.charts)) assert.ok(chart.empty, `${id} has no empty state`);
  assert.equal(figure(out, 'firstReview').empty, 'Waiting for the MR list to load');

  const fresh = computeStats(input({ rows: [row('acme/engine!1', { flags: { waitingOnYou: true } })], queue: [item({ createdAt: before(3 * D) })], runs: [{ key: 'acme/engine!1', startedAt: before(D), status: 'running' }] }));
  for (const id of ['waiting', 'findings', 'fullAuto', 'runs']) {
    const h = figure(fresh, id);
    assert.ok(h.value != null && h.previous === null && h.change === null && h.tone === null, id);
    assert.ok(h.before, `${id} says why there is no change`);
  }
  assert.equal(figure(fresh, 'waiting').before, 'No reading from a week ago yet');
  assert.equal(figure(fresh, 'findings').before, 'The records do not reach back to the week before');
  assert.equal(fresh.charts.ages.empty, 'Nothing is waiting for you to post or discard');
});

test('a day is a calendar day in the time zone asked for, so a finding just before midnight lands on the right one', () => {
  const now = Date.parse('2026-11-06T00:20:00Z');
  const queue = [item({ createdAt: '2026-10-01T09:00:00Z' }), item({ createdAt: '2026-11-05T23:30:00Z' })];
  const days = (timeZone) => computeStats(input({ now, timeZone, queue })).charts.perDay.days.filter((d) => d.posted).map((d) => d.day);
  assert.deepEqual(days('Europe/London'), ['2026-11-05']);
  assert.deepEqual(days('Europe/Berlin'), ['2026-11-06']);
  assert.deepEqual(days('America/New_York'), ['2026-11-05']);
  const last = (timeZone) => computeStats(input({ now, timeZone, queue })).charts.perDay.days.at(-1).day;
  assert.deepEqual([last('Europe/London'), last('Europe/Berlin'), last('America/New_York')], ['2026-11-06', '2026-11-06', '2026-11-05']);
  assert.equal(computeStats(input({ now, timeZone: 'Not/AZone', queue })).timeZone, Intl.DateTimeFormat().resolvedOptions().timeZone);
});

test('a change is good or bad by which way the figure should go, flat when either way is fine, and none without a week before', () => {
  assert.equal(toneOf(-3, 'down'), 'good');
  assert.equal(toneOf(3, 'down'), 'bad');
  assert.equal(toneOf(3, 'up'), 'good');
  assert.equal(toneOf(-1, 'up'), 'bad');
  assert.equal(toneOf(0, 'down'), 'flat');
  assert.equal(toneOf(5, null), 'flat');
  assert.equal(toneOf(null, 'down'), null);
  const out = computeStats(input({ rows: [row('acme/engine!1', { flags: { waitingOnYou: true } })], history: [{ at: NOW - 7 * D, waiting: 0, open: 0 }] }));
  assert.deepEqual([figure(out, 'waiting').change, figure(out, 'waiting').tone], [1, 'bad']);
});

test('findings per day split by what became of each, from the first day on record', () => {
  const queue = [
    item({ createdAt: before(5 * D) }),
    item({ createdAt: before(H) }),
    item({ createdAt: before(H), status: 'discarded' }),
    item({ createdAt: before(H), status: 'discarded', auto: auto({ superseded: 'replaced' }) }),
    item({ createdAt: before(H), status: 'discarded', auto: auto({ held: 'sensitive path' }) }),
    item({ createdAt: before(H), status: 'pending' }),
    item({ kind: 'reply', replyTo: 'd1', createdAt: before(H) }),
  ];
  const { days, series } = computeStats(input({ queue })).charts.perDay;
  assert.deepEqual(series.map(([id]) => id), ['posted', 'discarded', 'handedBack', 'waiting', 'withdrawn']);
  assert.equal(days.length, 6, 'days before the first record are left out rather than shown as nothing');
  assert.deepEqual(days.at(-1), { day: '2026-11-06', posted: 1, discarded: 1, handedBack: 1, waiting: 1, withdrawn: 1 });
  assert.deepEqual(days[0], { day: '2026-11-01', posted: 1, discarded: 0, handedBack: 0, waiting: 0, withdrawn: 0 });
});

test('a finding that expired on a closed MR counts as never posted, not as discarded by you', () => {
  const queue = [
    item({ createdAt: before(H) }),
    item({ createdAt: before(H), status: 'discarded' }),
    item({ createdAt: before(H), status: 'expired', postedAt: null, expiredReason: 'MR merged' }),
  ];
  const out = computeStats(input({ queue }));
  assert.deepEqual(out.charts.perDay.days.at(-1), { day: '2026-11-06', posted: 1, discarded: 1, handedBack: 0, waiting: 0, withdrawn: 1 });
  assert.equal(figure(out, 'findings').note, '50% discarded');
});

test('a day of findings nobody has decided yet counts them, so findings per day and by severity agree on what was raised', () => {
  const queue = [
    item({ createdAt: before(20 * D), postedAt: before(20 * D) }),
    item({ severity: 'NIT', createdAt: before(H), status: 'pending', postedAt: null }),
    item({ severity: 'NIT', createdAt: before(H), status: 'pending', postedAt: null }),
    item({ severity: 'NIT', createdAt: before(H), status: 'discarded', postedAt: null, auto: auto({ superseded: 'a newer pass replaced it' }) }),
  ];
  const { perDay, severity } = computeStats(input({ queue })).charts;
  const today = perDay.days.at(-1);
  assert.deepEqual(today, { day: '2026-11-06', posted: 0, discarded: 0, handedBack: 0, waiting: 2, withdrawn: 1 });
  const raised = severity.rows.reduce((n, r) => n + r.total, 0);
  assert.equal(perDay.series.reduce((n, [id]) => n + today[id], 0), raised);
  for (const r of severity.rows) assert.equal(severity.series.reduce((n, [id]) => n + r[id], 0), r.total, r.label + ' is the sum of its parts');
});

test('severity, stage, waiting time and per-person charts count what they say', () => {
  const reply = (extra) => item({ kind: 'reply', replyTo: 'd' + ids, ...extra });
  const out = computeStats(input({
    queue: [
      item({ createdAt: before(20 * D) }),
      item({ severity: 'NIT', createdAt: before(D) }),
      item({ severity: 'NIT', createdAt: before(D), status: 'discarded' }),
      item({ severity: 'CRITICAL', createdAt: before(D) }),
      item({ severity: 'ODD', createdAt: before(D) }),
      item({ severity: 'MAJOR', createdAt: before(8 * D) }),
      reply({ status: 'pending', createdAt: before(30 * 6e4) }),
      reply({ status: 'pending', createdAt: before(H) }),
      reply({ status: 'pending', createdAt: before(5 * H) }),
      reply({ status: 'pending', createdAt: before(4 * D) }),
      reply({ iid: 9, postedAt: before(D), auto: auto({ sentAuto: true }) }),
      reply({ iid: 9, postedAt: before(D), auto: auto({ sentAuto: true }) }),
      reply({ iid: 9, status: 'pending', createdAt: before(20 * H), auto: auto({ held: 'cap' }) }),
      reply({ iid: 8, postedAt: before(D), auto: auto({ sentAuto: true }) }),
      reply({ iid: 8, createdAt: before(9 * D), postedAt: before(9 * D), auto: auto({ sentAuto: true }) }),
    ],
    memory: { 'acme/engine!9': { pass: { author: 'ivan' } } },
    rows: [
      row('acme/engine!8', { author: 'erin' }),
      row('acme/web!1', { flags: { mine: true }, draft: true }),
      row('acme/web!2', { flags: { mine: true }, mergeStatus: 'MERGEABLE', unresolved: 2 }),
      row('acme/web!3', { flags: { mine: true }, mergeStatus: 'REQUESTED_CHANGES', approvedBy: ['ivan'] }),
      row('acme/web!4', { flags: { mine: true }, unresolved: 1 }),
      row('acme/web!5', { flags: { mine: true }, approvedBy: ['ivan'] }),
      row('acme/web!6', { flags: { mine: true } }),
    ],
  }));
  const { severity, stages, ages, people } = out.charts;
  assert.deepEqual(severity.rows.map((r) => [r.label, r.total, r.posted, r.discarded]), [
    ['Critical', 1, 1, 0], ['Major', 0, 0, 0], ['Minor', 0, 0, 0], ['Nit', 2, 1, 1], ['Question', 0, 0, 0], ['Odd', 1, 1, 0],
  ]);
  assert.deepEqual(stages.rows.map((r) => [r.label, r.count]), [['Draft', 1], ['In review', 1], ['Changes requested', 2], ['Approved', 1], ['Mergeable', 1]]);
  assert.deepEqual(stages.rows[2].mrs.map((mr) => mr.key), ['acme/web!3', 'acme/web!4']);
  assert.deepEqual(ages.rows.map((r) => r.count), [1, 1, 2, 0, 1], 'an item exactly an hour old has waited 1 to 4 h');
  assert.equal(ages.oldestAt, before(4 * D));
  assert.deepEqual(people.rows, [{ person: 'ivan', sent: 2, handedBack: 1 }, { person: 'erin', sent: 1, handedBack: 0 }]);
});

test('time to merge keeps the last 30 days of merges, oldest first, with their median', () => {
  const merged = (iid, openedDaysAgo, mergedDaysAgo) => ({ key: 'acme/web!' + iid, title: 'MR ' + iid, author: 'frank', createdAt: before(openedDaysAgo * D), mergedAt: before(mergedDaysAgo * D) });
  const { points, median } = computeStats(input({ gitlab: { reviewed: [], merged: [merged(1, 3, 1), merged(2, 40, 31), merged(3, 10, 2), merged(4, 5, 4)] } })).charts.merge;
  assert.deepEqual(points.map((p) => [p.key, p.ms / D]), [['acme/web!4', 1], ['acme/web!3', 8], ['acme/web!1', 2]]);
  assert.equal(median, 2 * D);
  const failed = computeStats(input({ gitlab: { error: 'GitLab 401 Unauthorized' } })).charts.merge;
  assert.equal(failed.empty, 'GitLab did not answer: GitLab 401 Unauthorized');
});

function gitlabReply(body, next = '') {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json', 'x-next-page': next } });
}

const glMr = (path, iid, extra = {}) => ({ references: { full: `${path}!${iid}` }, title: 'MR ' + iid, author: { username: 'frank' }, created_at: before(3 * D), merged_at: before(D), ...extra });

test('GitLab is read with GETs only, at most every 15 minutes, every page followed, and only for repos the engine watches', async (t) => {
  kit.reset({ me: 'frank' });
  await loadEngine({ matrixEngine: fileURLToPath(KIT) }, (event) => events.push(event));
  await refreshInbox();
  const calls = [];
  t.after(() => { globalThis.fetch = refuse; });
  globalThis.fetch = async (url, init = {}) => {
    calls.push([String(url), init.method ?? 'GET', init.headers?.['PRIVATE-TOKEN']]);
    const query = new URL(url).searchParams;
    if (query.get('state') === 'merged') return query.get('page') === '1' ? gitlabReply([glMr('acme/engine', 1)], '2') : gitlabReply([glMr('elsewhere/repo', 2), glMr('acme/web', 3)]);
    return gitlabReply([glMr('acme/engine', 4, { author: { username: 'ivan' }, merged_at: null })]);
  };
  const first = await stats.readStats('Europe/London', NOW);
  assert.match(first.charts.merge.empty, /^Reading GitLab/);
  await flush();
  assert.ok(events.includes('stats'), 'the page is told once GitLab has answered');
  assert.deepEqual(calls.map(([, method, token]) => [method, token]), Array(3).fill(['GET', 'stub-token']));
  const merged = new URL(calls[0][0]);
  assert.equal(merged.origin + merged.pathname, 'https://gitlab.com/api/v4/merge_requests');
  assert.deepEqual(Object.fromEntries(merged.searchParams), { scope: 'all', per_page: '100', page: '1', state: 'merged', author_username: 'frank', updated_after: before(30 * D) });
  const reviewed = calls.map(([url]) => new URL(url).searchParams).find((q) => q.has('reviewer_username'));
  assert.deepEqual([reviewed.get('reviewer_username'), reviewed.get('updated_after'), reviewed.has('state')], ['frank', before(14 * D), false]);
  assert.deepEqual(calls.map(([url]) => new URL(url).searchParams.get('page')).sort(), ['1', '1', '2']);
  const read = await stats.readStats('Europe/London', NOW + 14 * 6e4);
  await flush();
  assert.deepEqual(read.charts.merge.points.map((p) => p.key), ['acme/engine!1', 'acme/web!3']);
  assert.ok(read.gitlab.fetchedAt);
  assert.equal(calls.length, 3, 'nothing is asked again within 15 minutes');
  await stats.readStats('Europe/London', NOW + 15 * 6e4);
  await flush();
  assert.equal(calls.length, 6);
  built.saveSettings({ ...built.loadSettings(), gitlab: { host: 'https://git.acme.test' } });
  await stats.readStats('Europe/London', NOW + 30 * 6e4);
  await flush();
  assert.ok(calls.length > 6 && calls.slice(6).every(([url]) => url.startsWith('https://git.acme.test/api/v4/merge_requests?')), 'a self-hosted GitLab is read at its own host');
});

test('the counts that exist only as now are kept once an hour and become next week\'s comparison', async (t) => {
  const file = join(home, '.local/state/underlings/stats-history.json');
  await rm(file, { force: true });
  t.mock.timers.enable({ apis: ['Date'], now: NOW - 7 * D });
  kit.reset({ me: 'frank', mrs: [kit.mr('acme/engine', 1), kit.mr('acme/engine', 2, { author: 'frank' })] });
  await loadEngine({ matrixEngine: fileURLToPath(KIT) }, () => {});
  stats.start();
  t.after(() => stats.stop());
  const kept = async () => JSON.parse(await readFile(file, 'utf8').catch(() => '[]'));
  await refreshInbox();
  assert.ok(await until(async () => (await kept()).length === 1));
  await refreshInbox();
  t.mock.timers.tick(H);
  await refreshInbox();
  assert.ok(await until(async () => (await kept()).length === 2), 'an hour on, a second reading is kept, even while the last is still being written');
  assert.deepEqual((await kept()).map((s) => s.at), [NOW - 7 * D, NOW - 7 * D + H], 'and none within the hour');
  await mkdir(join(home, '.local/state/underlings'), { recursive: true });
  await writeFile(file, JSON.stringify([{ at: NOW - 7 * D, waiting: 4, open: 0 }]));
  const out = await stats.readStats('Europe/London', NOW);
  assert.deepEqual([figure(out, 'waiting').previous, figure(out, 'open').previous], [4, 0]);
});

test('findings archived by Clean up still count in the weekly figures', async () => {
  kit.reset({ me: 'frank', queue: [item()], archive: [{ ...item(), archivedAt: before(H / 2), why: 'MR merged' }] });
  await loadEngine({ matrixEngine: fileURLToPath(KIT) }, (event) => events.push(event));
  const out = await stats.readStats('Europe/London', NOW);
  assert.equal(figure(out, 'findings').value, 2);
});
