import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { act } from './actions.mjs';
import { loadEngine, loading, refreshInbox, refreshIfStale } from './engine.mjs';
import { mr, reset, world } from './testkit.mjs';
import { readSettings, readWatching } from './watching.mjs';

// The shared stand-in plus the watch, schedule and settings calls, steered through the same world.
const TESTKIT = new URL('./testkit.mjs', import.meta.url).href;
const STANDIN = `
import * as base from '${TESTKIT}';
import { world } from '${TESTKIT}';
export * from '${TESTKIT}';
const keyOf = (m) => m.projectPath + '!' + m.iid;
const note = (...call) => world.calls.push(call);
export const SETTING_ROWS = [
  { key: 'pollSeconds', label: 'Refresh every', hint: 'seconds between refreshes.', kind: 'number', bounds: { step: 15, min: 15, max: 3600 } },
  { key: 'jiraSite', label: 'Jira site', hint: 'host for the ticket pane.', kind: 'text' },
  { key: 'fullAuto', label: 'Full auto', hint: 'enter picks who.', kind: 'people' },
];
export async function fetchInbox() {
  const data = await base.fetchInbox();
  return world.fetchedAt ? { ...data, fetchedAt: world.fetchedAt } : data;
}
export const isWatched = (key) => Boolean(world.watches[key]);
export function toggleWatch(m) {
  note('toggleWatch', keyOf(m));
  if (world.watches[keyOf(m)]) delete world.watches[keyOf(m)];
  else world.watches[keyOf(m)] = { key: keyOf(m), projectPath: m.projectPath, iid: m.iid, webUrl: m.webUrl, auto: false };
}
export function stopWatching(key) {
  note('stopWatching', key);
  delete world.watches[key];
}
export function setAuto(key, auto) {
  note('setAuto', key, auto);
  world.watches[key].auto = auto;
}
export const markSeen = (mrs) => note('markSeen', ...mrs.map(keyOf));
export async function hasClosed(w) {
  const key = w.projectPath + '!' + w.iid;
  note('hasClosed', key);
  if (world.gitlab[key] === 'down') throw new Error('GitLab GraphQL 502 Bad Gateway');
  return world.gitlab[key] !== 'opened';
}
export function scheduleReReview(m) {
  note('scheduleReReview', keyOf(m));
  world.watches[keyOf(m)].daily = { nextAt: '2026-11-07T12:00:00.000Z' };
}
export function unscheduleReReview(key) {
  note('unscheduleReReview', key);
  delete world.watches[key].daily;
}
export function moveAutomation(key) {
  note('moveAutomation', key);
  const name = world.watches[key].automation;
  world.watches[key].daily ??= { nextAt: '2026-11-07T12:00:00.000Z' };
  delete world.watches[key].automation;
  return name;
}
export function watchRows(watches, mrs) {
  return Object.values(watches).map((watch) => ({ watch, repoLabel: watch.key.split('/').pop().split('!')[0], stillOpen: mrs.some((m) => keyOf(m) === watch.key), moved: Boolean(watch.moved) }));
}
export const changeSince = () => world.change;
export function updateSettings(patch) {
  note('updateSettings', patch);
  const rows = SETTING_ROWS.filter((r) => r.kind !== 'people');
  const applied = Object.keys(patch).filter((k) => rows.some((r) => r.key === k));
  const settings = { ...world.settings, ...Object.fromEntries(applied.map((k) => [k, k === 'pollSeconds' ? Math.max(15, Number(patch[k])) : patch[k]])) };
  world.settings = settings;
  return { settings, applied, dropped: Object.keys(patch).filter((k) => !applied.includes(k)) };
}
export async function rediscoverRepos() {
  note('rediscoverRepos');
  return world.found;
}
export function repoMatch(filter, poll) {
  note('repoMatch', filter, poll);
  return { total: 3, matching: ['acme/engine'], perRefresh: 2, perMinute: 8, heavy: false, discoveredAt: null };
}
`;

const OPEN = 'acme/engine!1121';
const CLOSED = 'acme/engine!900';
const dir = await mkdtemp(join(tmpdir(), 'control-centre-watching-'));
const standIn = join(dir, 'engine.mjs');
await writeFile(standIn, STANDIN);
await loadEngine({ matrixEngine: standIn }, () => {});

after(() => rm(dir, { recursive: true }));

const settle = async () => {
  while (loading()) await new Promise((resolve) => setTimeout(resolve, 5));
};
const calls = (name) => world.calls.filter(([n]) => n === name);
const watchOn = (key, extra = {}) => ({ key, projectPath: 'acme/engine', iid: Number(key.split('!')[1]), webUrl: 'https://gitlab.com/x', auto: false, ...extra });

beforeEach(async () => {
  await settle();
  reset({ mrs: [mr('acme/engine', 1121), mr('acme/engine', 1122)], gitlab: {}, fetchedAt: null, found: [] });
  await refreshInbox();
  world.calls = [];
});

const NONE = { daily: null, automation: null };
const DAILY = '2026-11-07T12:00:00.000Z';
const notTheEngine = () => world.calls.filter(([n]) => n !== 'fetchInbox').map(([n]) => n);

test('a page that saw nothing scheduled gets the MR watched first, then a daily re-review in the engine\'s own schedule', async () => {
  const done = await act('schedule', { key: OPEN, expect: NONE });
  assert.equal(done.text, 'Daily re-review scheduled for engine!1121. It looks once a day, and reviews only on days the MR has moved');
  assert.deepEqual(notTheEngine(), ['toggleWatch', 'scheduleReReview']);
  assert.deepEqual(world.watches[OPEN].daily, { nextAt: DAILY });
});

test('schedule refuses a second one, one the page did not see, and one with no expectation, and writes nothing then', async () => {
  world.watches[OPEN] = watchOn(OPEN, { daily: { nextAt: DAILY } });
  await assert.rejects(act('schedule', { key: OPEN, expect: NONE }), { status: 409, message: /changed since you looked/ });
  await assert.rejects(act('schedule', { key: OPEN, expect: { daily: DAILY, automation: null } }), { status: 409, message: /already has a daily re-review/ });
  world.watches[OPEN] = watchOn(OPEN, { automation: 're-review engine!1121' });
  await assert.rejects(act('schedule', { key: OPEN, expect: { daily: null, automation: 're-review engine!1121' } }), { status: 409, message: /already has a daily re-review/ });
  await assert.rejects(act('schedule', { key: OPEN }), { status: 400 });
  await assert.rejects(act('schedule', { key: CLOSED, expect: NONE }), { status: 404 });
  assert.deepEqual([calls('scheduleReReview'), calls('toggleWatch')], [[], []]);
});

test('unschedule stops the engine\'s own daily re-review, and one only in Orca is not its to stop', async () => {
  world.watches[OPEN] = watchOn(OPEN, { daily: { nextAt: DAILY } });
  assert.equal((await act('unschedule', { key: OPEN, expect: { daily: DAILY, automation: null } })).text, 'Stopped the daily re-review on engine!1121');
  assert.equal(world.watches[OPEN].daily, undefined);
  world.watches[OPEN] = watchOn(OPEN, { automation: 're-review engine!1121' });
  await assert.rejects(act('unschedule', { key: OPEN, expect: { daily: null, automation: 're-review engine!1121' } }), { status: 404, message: /no daily re-review here/ });
});

test('an Orca automation moves to the schedule in one action the page saw, and the answer says it is still Orca\'s to delete', async () => {
  world.watches[OPEN] = watchOn(OPEN, { automation: 're-review engine!1121' });
  await assert.rejects(act('move-automation', { key: OPEN, expect: NONE }), { status: 409 });
  const done = await act('move-automation', { key: OPEN, expect: { daily: null, automation: 're-review engine!1121' } });
  assert.equal(done.text, 'Moved the daily re-review on engine!1121 to the schedule here. Orca still has its automation re-review engine!1121: delete it from Orca\'s automations, or it runs there too');
  assert.deepEqual([world.watches[OPEN].automation, world.watches[OPEN].daily], [undefined, { nextAt: DAILY }]);
  await assert.rejects(act('move-automation', { key: OPEN, expect: { daily: DAILY, automation: null } }), { status: 404, message: /no Orca automation to move/ });
  assert.deepEqual(calls('moveAutomation').length, 1);
});

test('unwatch works for a closed MR\'s key, which has left the list', async () => {
  world.watches[CLOSED] = watchOn(CLOSED);
  const done = await act('unwatch', { key: CLOSED, expect: NONE });
  assert.equal(done.text, 'Stopped watching engine!900');
  assert.equal(world.watches[CLOSED], undefined);
  await assert.rejects(act('unwatch', { key: CLOSED }), { status: 404 });
});

test('unwatching one with a daily re-review takes it along, only when the page knew of it, and names an Orca one left behind', async () => {
  world.watches[CLOSED] = watchOn(CLOSED, { daily: { nextAt: DAILY } });
  await assert.rejects(act('unwatch', { key: CLOSED }), { status: 409 });
  assert.deepEqual(calls('stopWatching'), []);
  assert.equal((await act('unwatch', { key: CLOSED, expect: { daily: DAILY, automation: null } })).text, 'Stopped watching engine!900, and its daily re-review');
  world.watches[OPEN] = watchOn(OPEN, { automation: 're-review engine!1121' });
  assert.match((await act('unwatch', { key: OPEN, expect: { daily: null, automation: 're-review engine!1121' } })).text, /Orca still has its automation re-review engine!1121/);
  assert.deepEqual(notTheEngine(), ['stopWatching', 'stopWatching']);
});

test('clearing the closed ones checks the page saw the same set, takes daily re-reviews along, and names any Orca still has', async () => {
  world.watches = { [OPEN]: watchOn(OPEN), [CLOSED]: watchOn(CLOSED, { daily: { nextAt: DAILY } }), 'acme/engine!901': watchOn('acme/engine!901', { automation: 're-review engine!901' }) };
  await assert.rejects(act('unwatch', { closed: true, expect: { keys: [CLOSED] } }), { status: 409 });
  const done = await act('unwatch', { closed: true, expect: { keys: [CLOSED, 'acme/engine!901'] } });
  assert.equal(done.text, 'Stopped watching 2 closed MRs. Orca still has automations for engine!901: delete them from Orca\'s automations');
  assert.deepEqual(Object.keys(world.watches), [OPEN]);
});

test('clearing the closed ones asks GitLab about each, so a watch missing only because its repo did not load is kept', async () => {
  const missing = ['acme/engine!900', 'acme/engine!901', 'acme/engine!902', 'acme/engine!903'];
  world.watches = Object.fromEntries([OPEN, ...missing].map((key) => [key, watchOn(key)]));
  world.gitlab = { 'acme/engine!901': 'opened', 'acme/engine!902': 'down' };
  const done = await act('unwatch', { closed: true, expect: { keys: missing } });
  assert.equal(done.text, 'Stopped watching 2 closed MRs. engine!901 kept, as GitLab still has it open. engine!902 kept, as GitLab could not be asked about it');
  assert.deepEqual(Object.keys(world.watches).sort(), [OPEN, 'acme/engine!901', 'acme/engine!902']);
  assert.deepEqual(calls('hasClosed').map(([, key]) => key), missing);
});

test('clearing the closed ones is refused while the MR list is empty, since every watch would look closed', async () => {
  world.watches = { [OPEN]: watchOn(OPEN) };
  world.mrs = [];
  await refreshInbox();
  await assert.rejects(act('unwatch', { closed: true, expect: { keys: [OPEN] } }), { status: 503 });
  assert.ok(world.watches[OPEN]);
});

test('watch, auto and mark seen are single clicks on local state, checked against the list', async () => {
  assert.match((await act('watch', { key: OPEN })).text, /^Watching engine!1121/);
  assert.match((await act('watch', { key: OPEN })).text, /^Already watching/);
  assert.equal(calls('toggleWatch').length, 1);
  await act('auto', { key: 'acme/engine!1122', auto: true });
  assert.deepEqual(world.watches['acme/engine!1122'].auto, true, 'auto on an unwatched MR watches it first');
  assert.match((await act('auto', { key: CLOSED, auto: false })).text, /is not being watched/);
  await act('seen', { key: OPEN });
  assert.deepEqual(calls('markSeen'), [['markSeen', OPEN]]);
  await assert.rejects(act('seen', { key: CLOSED }), { status: 404 });
  await assert.rejects(act('watch', { key: 'not a key' }), { status: 400 });
  await assert.rejects(act('watch', { key: CLOSED }), { status: 404 });
  assert.equal(world.watches[CLOSED], undefined, 'a key outside the list is never watched');
});

test('settings pass the patch through, and say what was clamped and what was ignored', async () => {
  const done = await act('settings', { patch: { pollSeconds: 5, bogus: 1 } });
  assert.equal(done.text, 'Saved Refresh every: 15s, the nearest it goes to 5. Ignored bogus');
  await assert.rejects(act('settings', { patch: { fullAuto: 'mallory:verdict' } }), { status: 400, message: /nothing saved: fullAuto/ });
  await assert.rejects(act('settings', { patch: ['pollSeconds'] }), { status: 400 });
});

test('looking for repos again reports what GitLab found, and says so when it found nothing', async () => {
  world.found = [{ path: 'acme/engine' }, { path: 'acme/web' }];
  assert.match((await act('discover', {})).text, /^Found 2 repos with open MRs/);
  world.found = [];
  await assert.rejects(act('discover', {}), /listed no repos/);
});

test('the watching list marks which MRs are still open, carries their titles, and says which are scheduled where', () => {
  world.watches = { [OPEN]: watchOn(OPEN, { auto: true, automation: 're-review engine!1121' }), [CLOSED]: watchOn(CLOSED, { daily: { nextAt: DAILY } }) };
  const { rows } = readWatching();
  assert.deepEqual(rows.map((r) => [r.key, r.stillOpen, r.title, r.auto, r.automation, r.daily]), [
    [OPEN, true, 'MR 1121', true, 're-review engine!1121', null],
    [CLOSED, false, null, false, null, DAILY],
  ]);
});

test('a watched MR that moved says what moved, for the pill\'s tooltip', () => {
  world.watches = { [OPEN]: watchOn(OPEN, { moved: true, seen: { sha: 'old', pipeline: null, notes: 1, approvals: 0, unresolved: 1 } }), [CLOSED]: watchOn(CLOSED) };
  world.change = { headMoved: false, notes: 2, resolved: 0, approvals: 1, pipeline: 'FAILED' };
  assert.deepEqual(readWatching().rows.map((r) => r.movedWhy), ['2 new comments, 1 new approval, pipeline failed', null]);
});

test('the settings read leaves out who is in full auto, and previews a filter as typed', () => {
  world.settings = { pollSeconds: '15', jiraSite: 'acme.atlassian.net', repoFilter: 'acme' };
  const read = readSettings('acme/eng', null);
  assert.deepEqual(read.rows.map((r) => [r.key, r.value]), [['pollSeconds', '15'], ['jiraSite', 'acme.atlassian.net']]);
  assert.equal(read.repos.filter, 'acme/eng');
  assert.deepEqual(calls('repoMatch').at(-1), ['repoMatch', 'acme/eng', '15']);
  assert.throws(() => readSettings('x'.repeat(501), null), { status: 400 });
});

test('the saved poll is honoured down to the lowest the engine allows, not a fixed minute', async () => {
  const fetches = () => calls('fetchInbox').length;
  world.fetchedAt = new Date(Date.now() - 20_000).toISOString();
  await refreshInbox();
  const before = fetches();
  refreshIfStale({ pollSeconds: '15' });
  assert.equal(fetches(), before + 1, 'a 20 s old list is stale at a saved 15 s poll');
  await settle();
  world.fetchedAt = new Date(Date.now() - 10_000).toISOString();
  await refreshInbox();
  refreshIfStale({ pollSeconds: 5 });
  assert.equal(fetches(), before + 2, 'a 10 s old list is fresh, as nothing polls faster than 15 s');
});

test('a page that reads once gets the next refresh at the saved poll, though it asks only every 30 s', async () => {
  world.fetchedAt = new Date(Date.now() - 14_700).toISOString();
  await refreshInbox();
  const before = calls('fetchInbox').length;
  refreshIfStale({ pollSeconds: 15 });
  assert.equal(calls('fetchInbox').length, before, 'a list 14.7 s old is not due yet');
  await new Promise((resolve) => setTimeout(resolve, 600));
  await settle();
  assert.equal(calls('fetchInbox').length, before + 1, 'the worker wakes itself when it falls due');
});
