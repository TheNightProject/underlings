import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';

const home = await mkdtemp(join(tmpdir(), 'control-centre-standup-'));
process.env.HOME = home;
const testkit = new URL('./testkit.mjs', import.meta.url).href;
const enginePath = join(home, 'engine.mjs');
await writeFile(enginePath, `import { world } from '${testkit}';
export * from '${testkit}';
export async function buildStandup(request) {
  world.calls.push(['buildStandup', request]);
  await world.standupHold;
  if (world.standupFails) throw new Error(world.standupFails);
  return world.standup(request);
}
`);
const bareEngine = join(home, 'bare.mjs');
await writeFile(bareEngine, `export * from '${testkit}';\n`);

const { route } = await import('./app.mjs');
const { loadEngine } = await import('./engine.mjs');
const standup = await import('./standup.mjs');
const locale = await import('./locale.mjs');
const { reset, world } = await import('./testkit.mjs');
after(() => rm(home, { recursive: true }));

const ADDRESS = 'https://calendar.google.com/calendar/ical/frank%40example.com/private-5ecret/basic.ics';
const notified = [];
const stateFile = join(home, '.local/state/underlings/standup.json');
const settingsFile = join(home, '.config/underlings/standup.json');

const line = (id, tag, text, extra = {}) => ({ id, tag, text, ticked: true, ...extra });
function built({ day, today }) {
  return {
    day, today, generatedAt: '2026-11-10T08:00:00.000Z',
    sections: [
      { id: 'yesterday', title: 'Yesterday', day, groups: [
        { id: 'merged', title: 'Merged', error: null, note: null, lines: [line('merged:g/order-book!895', 'ABC-1234', 'Merged order-book !895: require billing:write'), line('merged:g/atlas!9', '?', 'Merged atlas !9: tidy', { unknown: true })] },
        { id: 'meetings', title: 'Meetings', error: null, note: null, lines: [line('meetings:gbac@1', 'Meeting: GBAC Rundown', '14:15 with Heidi and Niaj'), line('meetings:lunch@1', 'Meeting: Lunch', '12:30', { ticked: false })] },
      ] },
      { id: 'today', title: 'Today', day: today, groups: [{ id: 'open', title: 'Open MRs', error: null, note: null, lines: [line('open:g/atlas!45', 'ABC-4262', 'Address the review on atlas !45 (changes requested)')] }] },
    ],
  };
}

const call = async (method, path, payload, query = '') => route({ method, path, query: new URLSearchParams(query), body: async () => payload, config: {} });
const get = (day) => call('GET', '/api/standup', undefined, day ? `day=${day}` : '');
const builds = () => world.calls.filter(([name]) => name === 'buildStandup').map(([, request]) => request);
const lines = (view) => view.standup.sections.flatMap((s) => s.groups).flatMap((g) => g.lines);
const ticks = (view) => Object.fromEntries(lines(view).map((l) => [l.id, l.ticked]));

async function ready(day) {
  await get(day);
  await standup.settled();
  return get(day);
}

beforeEach(async () => {
  await standup.settled();
  standup.stop();
  await rm(join(home, '.local'), { recursive: true, force: true });
  await rm(join(home, '.config'), { recursive: true, force: true });
  await locale.refresh();
  reset({ standup: built, standupHold: null, standupFails: null });
  await loadEngine({ matrixEngine: enginePath }, () => {});
  standup.start({}, { notify: (event) => notified.push(event) });
  notified.length = 0;
});

test('opening the view works out the previous working day on its own, once, and says when it is ready', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-09T08:30:00Z') });
  let release;
  world.standupHold = new Promise((resolve) => { release = resolve; });
  const first = await get();
  assert.equal(first.day, '2026-11-06', 'Monday looks back to Friday');
  assert.equal(first.defaultDay, '2026-11-06');
  assert.equal(first.generating, true);
  assert.equal(first.standup, null);
  await get();
  assert.equal(builds().length, 1, 'a read while it works does not start another');
  release();
  await standup.settled();
  assert.deepEqual(notified, ['standup']);
  const done = await get();
  assert.equal(done.generating, false);
  assert.equal(done.standup.sections[0].day, '2026-11-06');
  assert.deepEqual(builds(), [{ day: '2026-11-06', today: '2026-11-09', excludedRepos: [], calendarAddress: null, timeZone: 'Europe/London', region: '', clock: '', workDays: [1, 2, 3, 4, 5] }]);
});

async function placeIn(saved) {
  await mkdir(join(home, '.config/underlings'), { recursive: true });
  await writeFile(join(home, '.config/underlings/locale.json'), JSON.stringify(saved));
  await locale.refresh();
}

test('a fresh install in Tokyo opens on the Tokyo day, and the standup is worked out in Tokyo time', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-09T20:00:00Z') });
  await placeIn({ locale: { timeZone: 'Asia/Tokyo' } });
  const view = await get();
  assert.deepEqual([view.latest, view.day], ['2026-11-10', '2026-11-09'], '05:00 on Tuesday in Tokyo, still Monday evening in London');
  assert.deepEqual(builds().map((b) => [b.day, b.today, b.timeZone]), [['2026-11-09', '2026-11-10', 'Asia/Tokyo']]);
  await assert.rejects(get('2026-11-11'), { status: 400 }, 'Wednesday has not come in Tokyo either');
});

test('the working week says which day the standup looks back to', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: Date.parse('2026-11-08T09:00:00Z') });
  await placeIn({ hours: { workDays: [0, 1, 2, 3, 4] } });
  const view = await get();
  assert.equal(view.day, '2026-11-05', 'Sunday looks back to Thursday in a Sunday to Thursday week');
  assert.deepEqual(builds().map((b) => [b.day, b.today, b.workDays]), [['2026-11-05', '2026-11-08', [0, 1, 2, 3, 4]]]);
});

test('a day already worked out opens from what was kept, without asking again, even after a restart', async () => {
  await ready('2026-11-09');
  standup.stop();
  const again = await get('2026-11-09');
  assert.equal(again.standup.generatedAt, '2026-11-10T08:00:00.000Z');
  assert.equal(builds().length, 1);
});

test('a day that is not a date, or has not come yet, is refused', async () => {
  await assert.rejects(get('9-11-2026'), { status: 400 });
  await assert.rejects(get('2026-02-30'), { status: 400 });
  await assert.rejects(get('2999-01-01'), { status: 400, message: /not happened yet/ });
  assert.deepEqual(builds(), []);
});

test('what you untick is kept per day in the state folder, readable only by you, and survives generating again', async () => {
  await ready('2026-11-09');
  await ready('2026-11-06');
  const view = await call('POST', '/api/standup/tick', { day: '2026-11-09', ids: ['merged:g/order-book!895'], ticked: false });
  assert.equal(ticks(view)['merged:g/order-book!895'], false);
  await call('POST', '/api/standup/tick', { day: '2026-11-09', ids: ['meetings:lunch@1'], ticked: true });
  assert.equal(((await stat(stateFile)).mode & 0o777).toString(8), '600');
  await call('POST', '/api/standup/generate', { day: '2026-11-09' });
  await standup.settled();
  assert.deepEqual(ticks(await get('2026-11-09')), {
    'merged:g/order-book!895': false, 'merged:g/atlas!9': true, 'meetings:gbac@1': true, 'meetings:lunch@1': true, 'open:g/atlas!45': true,
  });
  assert.equal(ticks(await get('2026-11-06'))['merged:g/order-book!895'], true, 'another day is its own');
});

test('a whole group is ticked or unticked in one call', async () => {
  await ready('2026-11-09');
  const view = await call('POST', '/api/standup/tick', { day: '2026-11-09', ids: ['meetings:gbac@1', 'meetings:lunch@1'], ticked: true });
  assert.deepEqual([ticks(view)['meetings:gbac@1'], ticks(view)['meetings:lunch@1']], [true, true]);
  await assert.rejects(call('POST', '/api/standup/tick', { day: '2026-11-09', ids: [], ticked: false }), { status: 400 });
  await assert.rejects(call('POST', '/api/standup/tick', { day: '2026-11-09', ids: ['x'], ticked: 'no' }), { status: 400 });
});

test('a line with no ticket takes one, kept for the day, and a line with one is refused', async () => {
  await ready('2026-11-09');
  const view = await call('POST', '/api/standup/tag', { day: '2026-11-09', id: 'merged:g/atlas!9', ticket: ' abc-4225 ' });
  const fixed = lines(view).find((l) => l.id === 'merged:g/atlas!9');
  assert.deepEqual([fixed.tag, fixed.unknown], ['ABC-4225', false]);
  await assert.rejects(call('POST', '/api/standup/tag', { day: '2026-11-09', id: 'merged:g/order-book!895', ticket: 'ABC-1' }), { status: 400 });
  await assert.rejects(call('POST', '/api/standup/tag', { day: '2026-11-09', id: 'merged:g/atlas!9', ticket: 'not a key' }), { status: 400 });
  const cleared = await call('POST', '/api/standup/tag', { day: '2026-11-09', id: 'merged:g/atlas!9', ticket: '' });
  assert.equal(lines(cleared).find((l) => l.id === 'merged:g/atlas!9').tag, '?');
});

test('the calendar address is kept in a file only you can read, and the page only learns that it is set', async () => {
  const saved = await call('POST', '/api/standup/settings', { calendarAddress: ADDRESS });
  assert.deepEqual([saved.calendarSet, saved.text], [true, 'Saved the calendar address']);
  assert.equal(((await stat(settingsFile)).mode & 0o777).toString(8), '600');
  assert.equal(JSON.parse(await readFile(settingsFile, 'utf8')).calendarAddress, ADDRESS);
  const shown = [await call('GET', '/api/standup/settings'), saved, await ready('2026-11-09')];
  for (const view of shown) assert.ok(!JSON.stringify(view).includes('5ecret'), 'the address never reaches the page');
  assert.equal(builds()[0].calendarAddress, ADDRESS, 'only the engine is given it');
  assert.deepEqual(await call('POST', '/api/standup/settings', { calendarAddress: null }), { ok: true, text: 'Removed the calendar address', calendarSet: false, excludedRepos: [] });
});

test('an address that is not a calendar link is refused, and saved settings are not lost', async () => {
  await call('POST', '/api/standup/settings', { calendarAddress: ADDRESS });
  for (const bad of ['http://calendar.google.com/x.ics', 'javascript:alert(1)', 'not a link', 42]) {
    await assert.rejects(call('POST', '/api/standup/settings', { calendarAddress: bad }), { status: 400 });
  }
  assert.equal((await call('GET', '/api/standup/settings')).calendarSet, true);
  await assert.rejects(call('POST', '/api/standup/settings', {}), { status: 400 });
});

test('no repo is left out to begin with, and the ones you name are kept and reach the next standup', async () => {
  assert.deepEqual((await call('GET', '/api/standup/settings')).excludedRepos, []);
  const saved = await call('POST', '/api/standup/settings', { excludedRepos: 'tooling/dashboard, internal/desk-booking,,tooling/dashboard' });
  assert.deepEqual(saved.excludedRepos, ['tooling/dashboard', 'internal/desk-booking']);
  await ready('2026-11-09');
  assert.deepEqual(builds()[0].excludedRepos, ['tooling/dashboard', 'internal/desk-booking']);
  assert.deepEqual((await call('POST', '/api/standup/settings', { excludedRepos: [] })).excludedRepos, []);
  await assert.rejects(call('POST', '/api/standup/settings', { excludedRepos: ['ok/repo', 'no spaces allowed'] }), { status: 400 });
});

test('a standup that cannot be worked out says why, and is tried again only when asked', async () => {
  world.standupFails = 'GitLab 401 Unauthorized on /user';
  await get('2026-11-09');
  await standup.settled();
  const failed = await get('2026-11-09');
  assert.deepEqual([failed.error, failed.standup, builds().length], ['GitLab 401 Unauthorized on /user', null, 1]);
  world.standupFails = null;
  await call('POST', '/api/standup/generate', { day: '2026-11-09' });
  await standup.settled();
  const fixed = await get('2026-11-09');
  assert.deepEqual([fixed.error, Boolean(fixed.standup), builds().length], [null, true, 2]);
});

test('an engine built before the standup asks for a rebuild instead', async () => {
  await loadEngine({ matrixEngine: bareEngine }, () => {});
  await assert.rejects(get('2026-11-09'), { status: 501, message: /needs rebuilding: this build has no buildStandup/ });
});

test('only the last 60 days are kept', async () => {
  const days = Array.from({ length: 62 }, (_, n) => new Date(Date.UTC(2026, 7, 1 + n)).toISOString().slice(0, 10));
  for (const day of days) await call('POST', '/api/standup/tick', { day, ids: ['x'], ticked: false });
  const kept = Object.keys(JSON.parse(await readFile(stateFile, 'utf8')).days);
  assert.deepEqual([kept.length, kept[0], kept.at(-1)], [60, days[2], days.at(-1)]);
});

test('with Standup switched off nothing is worked out, and opening it says it is off', async () => {
  await mkdir(join(home, '.config/underlings'), { recursive: true });
  await writeFile(join(home, '.config/underlings/features.json'), JSON.stringify({ standup: false }));
  await assert.rejects(get('2026-11-09'), { status: 409, message: /Standup is off/ });
  await assert.rejects(call('POST', '/api/standup/generate', { day: '2026-11-09' }), { status: 409 });
  await standup.settled();
  assert.equal(builds().length, 0);
  await rm(join(home, '.config/underlings/features.json'));
});
