import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import * as kit from './testkit.mjs';

const home = mkdtempSync(join(tmpdir(), 'control-centre-board-'));
process.env.HOME = home;
after(() => rmSync(home, { recursive: true, force: true }));

const STAGES = ['reading merge requests', 'paging the busy repos', 'reading reviews', 'counting'];
const KIT = new URL('./testkit.mjs', import.meta.url);
const builds = [];
const events = [];

function standIn(extra = {}) {
  return {
    ...kit,
    BOARD_STAGES: STAGES,
    MOOD_LABELS: { awaitingYou: 'waiting on you' },
    TICKET_LEGEND: [{ phase: 'working', glyph: 'W', width: 2, colour: 'yellow', label: 'agent working' }],
    REVIEW_LEGEND: [{ phase: 'ready', glyph: 'R', width: 2, colour: 'yellow', label: 'waiting for you to post', count: 0 }],
    PIPELINE_LEGEND: [{ glyph: 'P', colour: 'green', label: 'passed' }],
    currentRepos: async () => [{ path: 'acme/engine' }],
    parseWeights: (text) => ({ opened: Number(text.split('/')[0]) || 3, reviewed: 3, comments: 0.5, approved: 1 }),
    buildBoard(repos, days, options) {
      const build = { repos, days, options };
      build.done = new Promise((resolve, reject) => Object.assign(build, { resolve, reject }));
      builds.push(build);
      return build.done;
    },
    ...extra,
  };
}

const mocked = mock.module(KIT.href, { namedExports: standIn() });
const { loadEngine } = await import('./engine.mjs');
await loadEngine({ matrixEngine: fileURLToPath(KIT) }, (event) => events.push(event));
const board = await import('./board.mjs');

const post = (body) => board.ROUTES['POST /api/matrix/board']({ body: async () => body });
const get = () => board.ROUTES['GET /api/matrix/board']();
const flush = () => new Promise((resolve) => setImmediate(resolve));
const boardEvents = () => events.filter((e) => e === 'board').length;

function scores(user) {
  return { scores: [{ user, opened: 1, reviewed: 0, comments: 0, approved: 0, total: 3 }], series: { opened: [1], merged: [0], reviews: [0], days: 1 }, since: '2026-11-04T00:00:00Z', days: 1, repos: 1, builtAt: 1, partial: [] };
}

beforeEach(() => {
  kit.reset({ settings: { leaderboardDays: 14, pointWeights: '5/3/0.5/1' } });
  builds.length = 0;
  events.length = 0;
});

afterEach(() => board.stop());

test('a second ask while the board builds joins the running build instead of starting another', async () => {
  const first = await post({ bots: false });
  const second = await post({ bots: true });
  await flush();
  assert.equal(builds.length, 1);
  assert.equal(second.startedAt, first.startedAt);
  assert.equal(second.bots, false);
  assert.match(second.text, /already building/);
  assert.deepEqual(second.stages, STAGES);
  assert.deepEqual([builds[0].days, builds[0].options.includeAutomated, builds[0].options.weights.opened], [14, false, 5]);
  builds[0].resolve(scores('ivan'));
  await flush();
  assert.equal(get().startedAt, null);
  assert.equal(get().board.scores[0].user, 'ivan');
  await post({ bots: true });
  await flush();
  assert.equal(builds.length, 2);
  assert.equal(builds[1].options.includeAutomated, true);
});

test('with the leaderboard switched off a build is refused and GitLab is not read', async () => {
  mkdirSync(join(home, '.config/underlings'), { recursive: true });
  writeFileSync(join(home, '.config/underlings/features.json'), JSON.stringify({ leaderboard: false }));
  await assert.rejects(post({}), { status: 409, message: /leaderboard is off/ });
  await flush();
  assert.equal(builds.length, 0);
  rmSync(join(home, '.config'), { recursive: true, force: true });
});

test('progress is kept and broadcast, at most every two seconds, and the finished board is cached with its weights', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 });
  await post({});
  await flush();
  assert.equal(boardEvents(), 1);
  const say = builds[0].options.onProgress;
  say({ phase: STAGES[0], step: 0, done: 1, total: 4, found: { mrs: 3, comments: 0 } });
  say({ phase: STAGES[0], step: 0, done: 2, total: 4, found: { mrs: 9, comments: 0 } });
  assert.equal(get().progress.done, 2);
  assert.equal(boardEvents(), 1);
  t.mock.timers.tick(2000);
  assert.equal(boardEvents(), 2);
  say({ phase: STAGES[2], step: 2, done: 1, total: 2, found: { mrs: 9, comments: 40 } });
  t.mock.timers.tick(1999);
  assert.equal(boardEvents(), 2);
  t.mock.timers.tick(1);
  assert.equal(boardEvents(), 3);
  assert.deepEqual(get().progress.found, { mrs: 9, comments: 40 });
  builds[0].resolve(scores('ivan'));
  await flush();
  assert.equal(boardEvents(), 4);
  assert.deepEqual([get().progress, get().board.weights.opened, get().board.bots], [null, 5, false]);
});

test('stop() abandons the build: nothing is broadcast or cached when it lands, and the next ask starts afresh', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 2_000_000 });
  const before = get().board;
  await post({});
  await flush();
  builds[0].options.onProgress({ phase: STAGES[1], step: 1, done: 1, total: 3, found: { mrs: 5, comments: 0 } });
  const heard = boardEvents();
  board.stop();
  assert.deepEqual([get().startedAt, get().progress], [null, null]);
  t.mock.timers.tick(5000);
  builds[0].options.onProgress({ phase: STAGES[2], step: 2, done: 1, total: 3, found: { mrs: 5, comments: 1 } });
  builds[0].resolve(scores('erin'));
  await flush();
  t.mock.timers.tick(5000);
  assert.equal(boardEvents(), heard);
  assert.equal(get().board, before);
  await post({});
  await flush();
  assert.equal(builds.length, 2);
  builds[1].reject(new Error('late'));
  board.stop();
  await flush();
  assert.equal(get().error, null);
});

test('a failed build says why in GitLab\'s words, and the next ask tries again', async () => {
  await post({});
  await flush();
  builds[0].reject(new Error('401 Unauthorized'));
  await flush();
  assert.deepEqual([get().error, get().startedAt], ['401 Unauthorized', null]);
  await post({});
  await flush();
  assert.equal(builds.length, 2);
  assert.equal(get().error, null);
});

test('the key carries each legend the engine has, and a stale build is told what the key and the board lack', async () => {
  const legend = board.ROUTES['GET /api/matrix/legend']();
  assert.deepEqual(legend.moods, [{ mood: 'awaitingYou', label: 'waiting on you' }]);
  assert.deepEqual(legend.review, [{ phase: 'ready', glyph: 'R', colour: 'yellow', label: 'waiting for you to post' }]);
  assert.deepEqual(legend.pipeline, [{ phase: null, glyph: 'P', colour: 'green', label: 'passed' }]);
  assert.deepEqual([legend.missing, get().missing], [[], []]);
  mocked.restore();
  await loadEngine({ matrixEngine: fileURLToPath(KIT) }, () => {}, { engineLoaded: true, enginePath: 'elsewhere' });
  const stale = board.ROUTES['GET /api/matrix/legend']();
  assert.deepEqual(stale.missing, ['REVIEW_LEGEND', 'TICKET_LEGEND', 'PIPELINE_LEGEND']);
  assert.deepEqual(get().missing, ['buildBoard', 'currentRepos', 'parseWeights']);
  await assert.rejects(post({}), { status: 501, message: /needs rebuilding.*buildBoard/ });
});
