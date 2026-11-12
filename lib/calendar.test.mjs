import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const opened = [];
mock.module('node:child_process', {
  namedExports: {
    execFile(cmd, args, options, done) {
      opened.push([cmd, ...args]);
      setImmediate(() => done(null, '', ''));
    },
    spawn() {
      throw new Error('nothing is spawned here');
    },
  },
});

const BUILT = fileURLToPath(new URL('../engine/dist/engine.js', import.meta.url));
const skip = existsSync(BUILT) ? false : 'the review engine is not built, so run npm run build first';
const home = await mkdtemp(join(tmpdir(), 'control-centre-calendar-'));
process.env.HOME = home;
const state = join(home, 'state');
const testkit = new URL('./testkit.mjs', import.meta.url).href;
const enginePath = join(home, 'engine.mjs');
await writeFile(enginePath, `import { world } from '${testkit}';
export * from '${testkit}';
${skip ? 'export const calendarEvents = async () => [];' : `export { calendarEvents } from '${new URL('../engine/dist/engine.js', import.meta.url).href}';`}
export async function fetchCalendar(address) {
  world.calls.push(['fetchCalendar', address]);
  if (world.calendarFails) throw new Error(world.calendarFails);
  return world.ics;
}
`);

const { loadEngine } = await import('./engine.mjs');
const calendar = await import('./calendar.mjs');
const notifier = await import('./notifier.mjs');
const { openPage, route } = await import('./app.mjs');
const { reset, world } = await import('./testkit.mjs');
const { placeLocale } = await import('./fixtures/locale.mjs');
after(() => rm(home, { recursive: true }));

const ICS = await readFile(new URL('./fixtures/calendar.ics', import.meta.url), 'utf8');
const ADDRESS = 'https://calendar.google.com/calendar/ical/frank.foster%40example.com/private-5ecret0123456789abcdef/basic.ics';
const MIN = 60_000;
const AT = (iso) => Date.parse(iso);
const banners = [];
const config = { stateDir: state };

const call = async (method, path, payload, query = '') => route({ method, path, query: new URLSearchParams(query), body: async () => payload, config });
const read = (from, to = from) => call('GET', '/api/calendar', undefined, `from=${from}&to=${to}`);
const fetches = () => world.calls.filter(([name]) => name === 'fetchCalendar');
const titles = (view) => view.events.map((e) => e.title);
const setAddress = (address) => writeFile(join(home, '.config/underlings/standup.json'), JSON.stringify({ calendarAddress: address }));

beforeEach(async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: AT('2026-11-18T08:00:00Z') });
  await calendar.settled();
  calendar.stop();
  notifier.stop();
  await rm(join(home, '.config'), { recursive: true, force: true });
  await placeLocale(home);
  await rm(state, { recursive: true, force: true });
  reset({ ics: ICS, calendarFails: null });
  await loadEngine({ matrixEngine: enginePath }, () => {});
  await notifier.start(config, { alert: async (title, body, target) => { banners.push({ title, body, target }); return { delivered: true }; } });
  await calendar.start(config, {});
  await calendar.settled();
  banners.length = 0;
  opened.length = 0;
});

async function withAddress(now = Date.now()) {
  await mkdir(join(home, '.config/underlings'), { recursive: true });
  await setAddress(ADDRESS);
  await calendar.tick(now);
  await calendar.settled();
}

test('a fresh install in New York gets its banners in New York time, as its system writes them, and its all-day events from New York midnight', { skip }, async () => {
  await placeLocale(home, { locale: { timeZone: 'America/New_York' } });
  await withAddress(AT('2026-11-18T08:00:00Z'));
  await calendar.tick(AT('2026-11-18T09:26:00Z'));
  assert.equal(banners[0]?.body, '4:30 AM to 4:45 AM with Judy\nJoin on Google Meet from the Calendar view');
  const offsite = (await read('2026-11-19')).events.find((e) => e.title === 'Planning offsite');
  assert.deepEqual([offsite?.start, offsite?.firstDay], [AT('2026-11-19T05:00:00Z'), '2026-11-19']);
});

test('the calendar opens on today where you are, which in Honolulu is still yesterday', async () => {
  assert.equal((await call('GET', '/api/calendar')).today, '2026-11-18');
  await placeLocale(home, { locale: { timeZone: 'Pacific/Honolulu' } });
  assert.equal((await call('GET', '/api/calendar')).today, '2026-11-17');
});

test('with no address the view says so, nothing is fetched, and Refresh is refused', async () => {
  const view = await read('2026-11-18');
  assert.deepEqual([view.set, view.events, view.error, view.fetching], [false, [], null, false]);
  await assert.rejects(call('POST', '/api/calendar/refresh', {}), { status: 409, message: /Settings, under Standup/ });
  await calendar.tick();
  assert.deepEqual(fetches(), []);
  assert.equal(calendar.view().set, false);
});

test('the calendar is fetched once and kept, and fetched again five minutes later', { skip }, async () => {
  const now = Date.now();
  await withAddress(now);
  assert.deepEqual(fetches(), [['fetchCalendar', ADDRESS]]);
  const view = await read('2026-11-18');
  assert.deepEqual(titles(view), ['Team standup', 'Architecture discussion: ABC-4412', 'All hands', 'Focus']);
  await read('2026-11-16', '2026-11-20');
  await calendar.tick(now + 4 * MIN);
  assert.equal(fetches().length, 1, 'reads and ticks inside five minutes come from memory');
  await calendar.tick(now + 5 * MIN);
  await calendar.settled();
  assert.equal(fetches().length, 2);
});

test('a window outside the one kept is worked out from the calendar already fetched', { skip }, async () => {
  await withAddress();
  const later = await read('2027-01-04', '2027-01-08');
  assert.equal(later.events.length, 5, 'the weekday standup, worked out for a week in January');
  assert.equal(fetches().length, 1);
  await assert.rejects(read('2026-11-18', '2027-02-18'), { status: 400, message: /at most 62 days/ });
  await assert.rejects(read('2026-11-20', '2026-11-18'), { status: 400 });
  await assert.rejects(read('18-11-2026'), { status: 400 });
});

test('a meeting comes with its end, join link and your answer, and the declined one is left to the page', { skip }, async () => {
  await withAddress();
  const [standup, arch, allHands] = (await read('2026-11-18')).events;
  assert.deepEqual([standup.end - standup.start, standup.join, standup.response], [15 * MIN, { url: 'https://meet.google.com/abc-defg-hij', kind: 'meet' }, 'accepted']);
  assert.deepEqual([arch.response, arch.join.kind], ['tentative', 'zoom']);
  assert.equal(allHands.response, 'declined');
  assert.ok(!titles(await read('2026-11-18')).includes('Lunch and learn'), 'a cancelled one is gone');
});

test('a changed address is fetched at once, and the old one\'s meetings are not shown meanwhile', { skip }, async () => {
  await withAddress();
  const other = ADDRESS.replace('5ecret', 'n3w');
  await setAddress(other);
  world.ics = ICS.replace('SUMMARY:Focus', 'SUMMARY:Focus on the new calendar');
  const first = await read('2026-11-18');
  assert.deepEqual([first.events, first.fetching], [[], true]);
  await calendar.settled();
  assert.deepEqual(fetches().at(-1), ['fetchCalendar', other]);
  assert.ok(titles(await read('2026-11-18')).includes('Focus on the new calendar'));
});

test('a failure says what happened, never the address, and keeps the last good read', { skip }, async () => {
  const now = Date.now();
  await withAddress(now);
  world.calendarFails = `GET ${ADDRESS} answered 404; tried ${decodeURIComponent(ADDRESS)} and ${new URL(ADDRESS).pathname}`;
  await calendar.tick(now + 5 * MIN);
  await calendar.settled();
  const view = await read('2026-11-18');
  assert.match(view.error, /answered 404/);
  assert.equal(view.events.length, 4, 'what was read before still shows');
  for (const said of [JSON.stringify(view), JSON.stringify(calendar.view()), JSON.stringify(await call('GET', '/api/calendar/settings'))]) {
    assert.ok(!said.includes('5ecret') && !said.includes('frank.foster%40example.com/private'), said);
  }
});

test('Settings and the Overview learn only whether the address is set, and the next meeting you have not declined', { skip }, async () => {
  await withAddress(AT('2026-11-18T10:40:00Z'));
  assert.deepEqual(await call('GET', '/api/calendar/settings'), {
    remindMinutes: 5, leads: [0, 1, 2, 5, 10, 15], calendarSet: true,
    overlay: true, overlayLead: 60, overlayWhich: 'all', overlayLeads: [30, 60, 120, 300], overlayWhichOptions: ['all', 'join', 'accepted'], overlayHere: false,
  });
  const now = calendar.view(AT('2026-11-18T10:40:00Z'));
  assert.deepEqual([now.set, now.current.map((e) => e.title), now.next.title], [true, ['Architecture discussion: ABC-4412'], 'Focus']);
});

test('a banner goes out a few minutes before a meeting, once per occurrence, even after a restart', { skip }, async () => {
  await withAddress(AT('2026-11-18T08:00:00Z'));
  await calendar.tick(AT('2026-11-18T09:24:00Z'));
  assert.deepEqual(banners, [], 'six minutes out is too soon');
  await calendar.tick(AT('2026-11-18T09:26:00Z'));
  assert.equal(banners.length, 1);
  assert.equal(banners[0].title, 'In 4 min: Team standup');
  assert.equal(banners[0].body, '09:30 to 09:45 with Judy\nJoin on Google Meet from the Calendar view');
  assert.match(banners[0].target, /^join:standup-01@google\.com@\d+$/);
  await calendar.tick(AT('2026-11-18T09:28:00Z'));
  calendar.stop();
  await calendar.start(config, {});
  await calendar.settled();
  await calendar.tick(AT('2026-11-18T09:29:00Z'));
  assert.equal(banners.length, 1, 'the same occurrence is never announced twice');
  await calendar.tick(AT('2026-11-19T09:27:00Z'));
  assert.deepEqual(banners.map((b) => b.title), ['In 4 min: Team standup', 'In 3 min: Team standup'], 'the next day is its own occurrence');
});

test('only the worker that sends banners reminds, and one that does not leaves the meeting for it', { skip }, async () => {
  await withAddress(AT('2026-11-18T08:00:00Z'));
  const now = AT('2026-11-18T09:26:00Z');
  world.lock.frontends = { 'control-centre-1': { owner: 'control-centre', pid: 1, startedAt: 0, beatAt: now } };
  await calendar.tick(now);
  assert.deepEqual(banners, []);
  assert.equal(existsSync(join(state, 'calendar.json')), false, 'nothing is marked, so the sender still reminds');
  world.lock.frontends = {};
  await calendar.tick(now + MIN);
  assert.deepEqual(banners.map((b) => b.title), ['In 3 min: Team standup']);
});

test('no banner for a meeting you declined or an all-day event, and a tentative one still gets one', { skip }, async () => {
  await withAddress(AT('2026-11-18T08:00:00Z'));
  await calendar.tick(AT('2026-11-18T13:57:00Z'));
  await calendar.tick(AT('2026-11-18T23:57:00Z'));
  assert.deepEqual(banners, []);
  await calendar.tick(AT('2026-11-18T10:27:00Z'));
  assert.deepEqual(banners.map((b) => b.title), ['In 3 min: Architecture discussion: ABC-4412']);
});

test('the lead time is a setting, and Off sends no banner at all', { skip }, async () => {
  await withAddress(AT('2026-11-18T08:00:00Z'));
  await assert.rejects(call('POST', '/api/calendar/settings', { remindMinutes: 7 }), { status: 400 });
  assert.equal((await call('POST', '/api/calendar/settings', { remindMinutes: 10 })).text, 'A banner comes 10 min before each meeting');
  await calendar.tick(AT('2026-11-18T09:21:00Z'));
  assert.equal(banners.length, 1, 'ten minutes out, with the lead at 10');
  assert.equal((await call('POST', '/api/calendar/settings', { remindMinutes: 0 })).text, 'No banner before meetings');
  await calendar.tick(AT('2026-11-18T10:27:00Z'));
  assert.equal(banners.length, 1);
});

test('with the page in focus the reminder is a toast with Join, and Needs you is left as it was', { skip }, async (t) => {
  await withAddress(AT('2026-11-18T08:00:00Z'));
  t.mock.timers.setTime(AT('2026-11-18T09:26:00Z'));
  await call('POST', '/api/attention/presence', { page: 'page-1', focused: true, visible: true });
  await calendar.tick(Date.now());
  const view = notifier.view();
  assert.deepEqual(banners, []);
  assert.deepEqual(view.toasts.map((t) => [t.title, t.join, t.kind]), [['In 4 min: Team standup', 'https://meet.google.com/abc-defg-hij', 'meeting']]);
  assert.equal(view.count, 0);
});

test('a clicked banner opens the meeting\'s join link in the browser, and a meeting gone since has no link to open', { skip }, async () => {
  await withAddress();
  const [standup] = (await read('2026-11-18')).events;
  assert.equal(calendar.joinLink('join:' + standup.id), 'https://meet.google.com/abc-defg-hij');
  await openPage({}, 'http://127.0.0.1:1/?t=x', 'join:' + standup.id);
  assert.deepEqual(opened, [['/usr/bin/open', 'https://meet.google.com/abc-defg-hij']]);
  assert.equal(calendar.joinLink('join:gone@1'), null);
  assert.equal(calendar.joinLink('calendar'), null);
});

test('with the calendar switched off nothing is read and nothing is reminded, and what was read is let go', async () => {
  await withAddress();
  assert.equal(fetches().length, 1);
  await writeFile(join(home, '.config/underlings/features.json'), JSON.stringify({ calendar: false }));
  world.calls.length = 0;
  await calendar.tick(Date.now() + 60 * MIN);
  await calendar.settled();
  assert.deepEqual([fetches().length, banners.length, calendar.view().fetchedAt], [0, 0, null]);
  await assert.rejects(call('POST', '/api/calendar/refresh', {}), { status: 409, message: /calendar is off/ });
});
