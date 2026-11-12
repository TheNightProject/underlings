import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';

const home = await mkdtemp(join(tmpdir(), 'control-centre-qa-'));
process.env.HOME = home;
const testkit = new URL('./testkit.mjs', import.meta.url).href;
const enginePath = join(home, 'engine.mjs');
await writeFile(enginePath, `import { world } from '${testkit}';
export * from '${testkit}';
export async function buildQaBoard(request) {
  world.calls.push(['buildQaBoard', request]);
  await world.qaHold;
  if (world.qaFails) throw new Error(world.qaFails);
  return world.qaBoard(request);
}
`);
const bareEngine = join(home, 'bare.mjs');
await writeFile(bareEngine, `export * from '${testkit}';\n`);

const { route } = await import('./app.mjs');
const { freshInbox, loadEngine, refreshInbox } = await import('./engine.mjs');
const qa = await import('./qa.mjs');
const { mr: inboxMr, reset, world } = await import('./testkit.mjs');
after(() => rm(home, { recursive: true }));

const notified = [];
const stateFile = join(home, '.local/state/underlings/qa.json');
const settingsFile = join(home, '.config/underlings/qa.json');
const featuresFile = join(home, '.config/underlings/features.json');
// The QA settings the board is read with.
const QA_SETTINGS = { jql: 'project = ABC AND status = QA', status: 'QA', group: 'acme' };

async function configure(qaSettings, features) {
  await mkdir(join(home, '.config/underlings'), { recursive: true });
  if (qaSettings) await writeFile(settingsFile, JSON.stringify(qaSettings));
  if (features) await writeFile(featuresFile, JSON.stringify(features));
}
const MINUTE = 60_000;

const mr = (project, iid, keys) => ({
  project, iid, url: `https://gitlab.com/${project}/-/merge_requests/${iid}`, title: `${keys[0]} change`, mergedAt: '2026-11-09T16:00:00Z', author: 'Ivan Irving', additions: 40, deletions: 5, keys,
});
const BUCKETS = [{ id: 'today', label: 'Today', upTo: 1 }, { id: 'weeks-2-plus', label: 'Over 2 weeks', upTo: null }];

function built({ jql, merged }) {
  const mrs = [mr('acme/platform/relay', 1201, ['ABC-4142']), mr('acme/platform/frontend', 1720, ['ABC-4142'])];
  return {
    generatedAt: new Date().toISOString(), jql, group: 'acme', windowDays: 60, buckets: BUCKETS,
    tickets: [
      { key: 'ABC-3990', summary: 'Invite emails show the code placeholder', assignee: null, url: 'https://example.atlassian.net/browse/ABC-3990', days: { from: 22, to: 28 }, bucket: 'weeks-2-plus', mrs: [] },
      { key: 'ABC-4142', summary: 'A button can act on stale state', assignee: 'Ivan Irving', url: 'https://example.atlassian.net/browse/ABC-4142', days: { from: 1, to: 1 }, bucket: 'today', mrs },
    ],
    merged: { group: 'acme', windowDays: 60, fullAt: merged?.fullAt ?? new Date().toISOString(), through: new Date().toISOString(), mrs: [...mrs, mr('acme/desk-booking', 2, ['ABC-4402'])] },
  };
}

const call = async (method, path, payload) => route({ method, path, query: new URLSearchParams(), body: async () => payload, config: {} });
const get = () => call('GET', '/api/qa');
const builds = () => world.calls.filter(([name]) => name === 'buildQaBoard').map(([, request]) => request);
const pause = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

async function ready() {
  await get();
  await qa.settled();
  return get();
}

async function poll() {
  await refreshInbox();
  await pause();
  await qa.settled();
}

beforeEach(async () => {
  await qa.settled();
  qa.stop();
  await rm(join(home, '.local'), { recursive: true, force: true });
  await rm(join(home, '.config'), { recursive: true, force: true });
  reset({ qaBoard: built, qaHold: null, qaFails: null, mrs: [inboxMr('acme/engine', 7), inboxMr('acme/portal/web', 9)] });
  await configure(QA_SETTINGS, { qa: true });
  await loadEngine({ matrixEngine: enginePath }, () => {});
  await freshInbox(Infinity);
  qa.start({}, { notify: (event) => notified.push(event) });
  notified.length = 0;
});

test('opening the view reads QA in the background, once, then opens from what was kept', async () => {
  let release;
  world.qaHold = new Promise((resolve) => { release = resolve; });
  const first = await get();
  assert.deepEqual([first.refreshing, first.board, first.jql], [true, null, 'project = ABC AND status = QA']);
  await get();
  await pause();
  assert.equal(builds().length, 1, 'a read while it works does not start another');
  release();
  await qa.settled();
  assert.deepEqual(notified, ['qa']);
  const done = await get();
  assert.equal(done.refreshing, false);
  assert.deepEqual(done.board.tickets.map((t) => [t.key, t.mrs.length]), [['ABC-3990', 0], ['ABC-4142', 2]]);
  assert.deepEqual(builds(), [{ jql: 'project = ABC AND status = QA', status: 'QA', group: 'acme', merged: null, full: false, priority: 'background' }], 'the request the saved settings make, with its Jira reads behind any you are waiting on');
  qa.stop();
  await get();
  await qa.settled();
  assert.equal(builds().length, 1, 'a restarted worker opens from the kept board too');
});

test('the board is kept in the state folder, readable only by you, and the MR window stays in the worker', async () => {
  const view = await ready();
  assert.equal(((await stat(stateFile)).mode & 0o777).toString(8), '600');
  const kept = JSON.parse(await readFile(stateFile, 'utf8'));
  assert.equal(kept.board.merged.mrs.length, 3);
  assert.equal(view.board.merged, undefined, 'the page is never sent the MR window');
  assert.ok(!JSON.stringify(view).includes('desk-booking'));
});

test('the normal poll reads again at most every 15 minutes, handing the engine what it read last time', async (t) => {
  const start = Date.parse('2026-11-10T09:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: start });
  await ready();
  t.mock.timers.setTime(start + 10 * MINUTE);
  await poll();
  assert.equal(builds().length, 1);
  t.mock.timers.setTime(start + 16 * MINUTE);
  await poll();
  await poll();
  assert.equal(builds().length, 2, 'two polls after the quarter hour read once');
  assert.equal(builds()[1].full, false);
  assert.deepEqual(builds()[1].merged.mrs.map((m) => m.iid), [1201, 1720, 2]);
});

test('Refresh reads the whole window again now, and one asked for mid-read runs once it ends', async () => {
  await ready();
  let release;
  world.qaHold = new Promise((resolve) => { release = resolve; });
  assert.equal((await call('POST', '/api/qa/refresh', {})).text, 'Reading QA from Jira and GitLab');
  assert.equal((await call('POST', '/api/qa/refresh', {})).text, 'Reading QA again once the read in progress ends');
  await call('POST', '/api/qa/refresh', {});
  release();
  await qa.settled();
  assert.deepEqual(builds().map((b) => b.full), [false, true, true]);
});

test('settled waits for the read a fetch asks for, not only one already running', async () => {
  await refreshInbox();
  await qa.settled();
  assert.deepEqual(builds().map((b) => b.full), [false]);
});

test('a fetch just before stop starts no read once stopped, so stopped code never asks Jira or writes the board', async () => {
  await refreshInbox();
  qa.stop();
  await qa.settled();
  assert.deepEqual(builds(), []);
  assert.equal(await stat(stateFile).catch(() => null), null);
});

test('a read that fails says why, keeps the last board, and waits for the next quarter hour or a Refresh', async (t) => {
  const start = Date.parse('2026-11-10T09:00:00Z');
  t.mock.timers.enable({ apis: ['Date'], now: start });
  await ready();
  world.qaFails = 'Jira did not answer acli within 30 s';
  t.mock.timers.setTime(start + 16 * MINUTE);
  await poll();
  const failed = await get();
  assert.deepEqual([failed.error, failed.board.generatedAt], ['Jira did not answer acli within 30 s', new Date(start).toISOString()]);
  t.mock.timers.setTime(start + 20 * MINUTE);
  await poll();
  await get();
  assert.equal(builds().length, 2);
  world.qaFails = null;
  await call('POST', '/api/qa/refresh', {});
  await qa.settled();
  assert.equal((await get()).error, null);
});

test('the JQL is a setting kept for you alone, refused unless it is one line, and the next read uses it', async () => {
  await ready();
  assert.deepEqual(await call('GET', '/api/qa/settings'), { ...QA_SETTINGS, ownGroups: 'acme', example: 'project = ABC AND status = QA', defaultStatus: 'QA', on: true });
  const saved = await call('POST', '/api/qa/settings', { jql: '  project in (ABC, XYZ) AND status = QA ' });
  assert.deepEqual([saved.jql, saved.text], ['project in (ABC, XYZ) AND status = QA', 'QA lists project in (ABC, XYZ) AND status = QA']);
  assert.equal(((await stat(settingsFile)).mode & 0o777).toString(8), '600');
  await qa.settled();
  assert.equal(builds().at(-1).jql, 'project in (ABC, XYZ) AND status = QA');
  assert.equal((await get()).board.jql, 'project in (ABC, XYZ) AND status = QA');
  for (const bad of ['project = ABC\nAND status = QA', 'x'.repeat(1001), 42]) {
    await assert.rejects(call('POST', '/api/qa/settings', { jql: bad }), { status: 400 });
  }
  await assert.rejects(call('POST', '/api/qa/settings', {}), { status: 400 });
  const cleared = await call('POST', '/api/qa/settings', { jql: null });
  assert.deepEqual([cleared.jql, cleared.text], ['', 'QA has no search, so the board stays empty']);
});

test('a fresh install has QA off, reads nothing, and once on still waits calmly for a search', async () => {
  await rm(join(home, '.config'), { recursive: true, force: true });
  const off = await get();
  await qa.settled();
  assert.deepEqual([off.on, off.configured, off.board, off.error, off.example], [false, false, null, null, 'project = ABC AND status = QA']);
  await poll();
  await assert.rejects(call('POST', '/api/qa/refresh', {}), { status: 409, message: /QA is off/ });
  await configure(null, { qa: true });
  const unset = await get();
  await poll();
  assert.deepEqual([unset.on, unset.configured, unset.status, unset.group], [true, false, 'QA', 'acme']);
  await assert.rejects(call('POST', '/api/qa/refresh', {}), { status: 409, message: /no search yet/ });
  assert.deepEqual(builds(), [], 'nothing is read until there is a search');
  await call('POST', '/api/qa/settings', { jql: 'project = OPS AND status = Testing' });
  await qa.settled();
  assert.deepEqual(builds().map(({ jql, status, group }) => ({ jql, status, group })), [{ jql: 'project = OPS AND status = Testing', status: 'QA', group: 'acme' }], 'the group is the one your open MRs are in');
});

test('the QA status and groups are settings too, checked, and reach the next read', async () => {
  await ready();
  const saved = await call('POST', '/api/qa/settings', { status: 'Ready for test', group: 'acme, acme/platform' });
  assert.deepEqual([saved.status, saved.group, saved.text], ['Ready for test', 'acme, acme/platform', 'Days in QA count from the last move to Ready for test. QA joins MRs merged in acme, acme/platform']);
  await qa.settled();
  assert.deepEqual([builds().at(-1).status, builds().at(-1).group], ['Ready for test', 'acme, acme/platform']);
  await assert.rejects(call('POST', '/api/qa/settings', { status: 'Say "hi"' }), { status: 400 });
  await assert.rejects(call('POST', '/api/qa/settings', { group: 'acme; drop' }), { status: 400 });
  assert.equal((await call('POST', '/api/qa/settings', { status: null })).status, 'QA');
});

test('with QA switched off the poll reads nothing, and the board kept is not shown', async () => {
  await ready();
  await configure(null, { qa: false });
  const off = await get();
  await poll();
  assert.deepEqual([off.on, off.board, builds().length], [false, null, 1]);
});

test('a board from a newer or broken state file is read again rather than shown', async () => {
  await mkdir(join(home, '.local/state/underlings'), { recursive: true });
  await writeFile(stateFile, JSON.stringify({ v: 2, board: { tickets: [] } }));
  assert.equal((await get()).board, null);
  await qa.settled();
  assert.equal(builds().length, 1);
});

test('an engine built before the QA board asks for a rebuild, and the poll leaves it alone', async () => {
  await loadEngine({ matrixEngine: bareEngine }, () => {});
  await assert.rejects(get(), { status: 501, message: /needs rebuilding: this build has no buildQaBoard/ });
  await assert.rejects(call('POST', '/api/qa/refresh', {}), { status: 501 });
  notified.length = 0;
  await poll();
  assert.deepEqual([builds(), notified], [[], []]);
  await loadEngine({ matrixEngine: enginePath }, () => {});
  await freshInbox(Infinity);
  assert.equal((await get()).error, null, 'no failed read was recorded against the old engine');
  await qa.settled();
});

test('with no group named the board waits for the open MRs, so its first read joins their groups', async () => {
  await configure({ jql: 'project = OPS AND status = QA' }, { qa: true });
  const unlisted = join(home, 'unlisted.mjs');
  await writeFile(unlisted, `import { fetchInbox as listed } from '${testkit}';\nexport * from '${enginePath}';\nexport const fetchInbox = () => new Promise((resolve) => { globalThis.listInbox = () => resolve(listed()); });\n`);
  await loadEngine({ matrixEngine: unlisted }, () => {});
  const waiting = await get();
  await pause();
  await qa.settled();
  assert.deepEqual([waiting.configured, waiting.group, builds()], [true, '', []], 'nothing is read before the open MRs are');
  globalThis.listInbox();
  for (let tries = 0; tries < 100 && !builds().length; tries += 1) await pause(10);
  await qa.settled();
  assert.deepEqual(builds().map((b) => b.group), ['acme']);
  await loadEngine({ matrixEngine: enginePath }, () => {});
});
