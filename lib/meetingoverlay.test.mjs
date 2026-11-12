import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';

const home = await mkdtemp(join(tmpdir(), 'control-centre-overlay-'));
process.env.HOME = home;
const state = join(home, 'state');
const testkit = new URL('./testkit.mjs', import.meta.url).href;
const enginePath = join(home, 'engine.mjs');
await writeFile(enginePath, `import { world } from '${testkit}';
export * from '${testkit}';
export async function fetchCalendar() {
  return 'BEGIN:VCALENDAR';
}
export async function calendarEvents() {
  return world.events;
}
`);

const { loadEngine } = await import('./engine.mjs');
const calendar = await import('./calendar.mjs');
const notifier = await import('./notifier.mjs');
const { route } = await import('./app.mjs');
const { reset } = await import('./testkit.mjs');
after(() => rm(home, { recursive: true }));

const MIN = 60_000;
const AT = (clock, day = '2026-11-18') => Date.parse(`${day}T${clock}Z`);
const config = { stateDir: state };
const MEET = { url: 'https://meet.google.com/abc-defg-hij', kind: 'meet' };
const ZOOM = { url: 'https://example.zoom.us/j/845', kind: 'zoom' };
const person = (name, response = 'accepted', extra = {}) => ({ name, email: `${name.split(' ')[0].toLowerCase()}@example.com`, response, self: false, organiser: false, optional: false, ...extra });
const FRANK = (response) => person('Frank Foster', response, { self: true });

function meeting(id, title, from, to, extra = {}) {
  const day = extra.day ?? '2026-11-18';
  const response = extra.response === undefined ? 'accepted' : extra.response;
  return {
    id, title, start: AT(`${from}:00`, day), end: AT(`${to}:00`, day), allDay: false, firstDay: day, lastDay: day, location: null, description: null, join: null,
    organiser: null, attendees: response ? [FRANK(response)] : [], response, others: [], ...extra,
  };
}

const standup = (day) => meeting(`standup@${day}`, 'Team standup', '09:30', '09:45', {
  day, join: MEET, attendees: [FRANK('accepted'), person('Judy Marsh'), person('Niaj Lowe'), person('Quinn Doyle'), person('Olivia Park', 'declined'), person('Uma Vega', 'tentative')],
});
const EVENTS = [
  { ...meeting('offsite@1', 'Planning offsite', '00:00', '00:00'), allDay: true, end: AT('00:00:00', '2026-11-19') },
  standup('2026-11-18'),
  standup('2026-11-19'),
  meeting('arch@1', 'Architecture discussion', '10:30', '11:30', { response: 'tentative', join: ZOOM, location: 'Room 3' }),
  meeting('pair-a@1', 'Pairing with Judy', '14:00', '15:00', { join: MEET }),
  meeting('pair-b@1', 'Pairing with Olivia', '14:00', '15:00'),
  meeting('allhands@1', 'All hands', '16:00', '17:00', { response: 'declined', join: MEET }),
  meeting('focus@1', 'Focus', '17:00', '18:00', { response: null }),
];

let desktop;
let banners;
let told;
const shellWith = (extra = {}) => ({ notify: (what) => told.push(what), desktop, ...extra });

beforeEach(async (t) => {
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: AT('08:00:00') });
  await calendar.settled();
  calendar.stop();
  notifier.stop();
  await rm(join(home, '.config'), { recursive: true, force: true });
  await rm(state, { recursive: true, force: true });
  await mkdir(join(home, '.config/underlings'), { recursive: true });
  await writeFile(join(home, '.config/underlings/standup.json'), JSON.stringify({ calendarAddress: 'https://calendar.google.com/calendar/ical/x/private-0123456789abcdef/basic.ics' }));
  reset({ events: EVENTS });
  banners = [];
  told = [];
  desktop = fakeDesktop();
  await loadEngine({ matrixEngine: enginePath }, () => {});
  await notifier.start(config, { alert: async (title) => { banners.push(title); return { delivered: true }; } });
  await calendar.start(config, shellWith());
  await calendar.settled();
});

function fakeDesktop() {
  const calls = [];
  return {
    calls,
    opened: [],
    showOverlay() { calls.push('show'); },
    closeOverlay() { calls.push('close'); },
    focus() { calls.push('focus'); },
    async openExternal(url) { this.opened.push(url); },
  };
}

async function at(t, clock, day) {
  t.mock.timers.setTime(AT(clock, day));
  await calendar.tick(Date.now());
  await calendar.settled();
}

async function later(t, ms) {
  t.mock.timers.tick(ms);
  await calendar.settled();
}

const shown = () => calendar.view().overlay?.meetings.map((m) => m.title) ?? [];
const keyOf = (title) => calendar.view().overlay.meetings.find((m) => m.title === title).key;
const call = (method, path, payload) => route({ method, path, query: new URLSearchParams(), body: async () => payload, config });
const act = (what, key) => call('POST', '/api/calendar/overlay', { act: what, key });
const setOverlay = (patch) => call('POST', '/api/calendar/settings', patch);

test('the screen is covered a minute before a meeting, on time rather than at the next tick', async (t) => {
  await at(t, '09:28:30');
  assert.deepEqual([desktop.calls, shown()], [[], []], 'ninety seconds out is too soon');
  await later(t, 29_000);
  assert.deepEqual(desktop.calls, []);
  await later(t, 1000);
  assert.deepEqual(desktop.calls, ['show'], 'woken at 09:29:00 exactly, not at the next 30 second tick');
  assert.deepEqual(shown(), ['Team standup']);
  assert.ok(told.includes('calendar'), 'the overlay page is told to read it');
  const [card] = calendar.view().overlay.meetings;
  assert.deepEqual([card.start, card.end, card.join, card.response], [AT('09:30:00'), AT('09:45:00'), MEET, 'accepted']);
  assert.deepEqual(card.people, ['Judy Marsh', 'Niaj Lowe', 'Quinn Doyle', 'Uma Vega'], 'everyone else in it who has not declined');
});

test('each occurrence covers the screen once, even after a restart, and the next day is its own', async (t) => {
  await at(t, '09:29:00');
  await at(t, '09:29:30');
  assert.deepEqual(desktop.calls, ['show']);
  calendar.stop();
  assert.deepEqual(desktop.calls, ['show', 'close'], 'a worker that stops takes its reminder with it');
  const again = fakeDesktop();
  desktop = again;
  await calendar.start(config, shellWith());
  await calendar.settled();
  await at(t, '09:29:40');
  assert.deepEqual([again.calls, shown()], [[], []], 'already shown before the restart, so not shown again');
  const saved = JSON.parse(await readFile(join(state, 'meeting-overlay.json'), 'utf8'));
  assert.deepEqual(Object.keys(saved.marks), [`standup@2026-11-18|${AT('09:30:00')}`]);
  await at(t, '09:29:00', '2026-11-19');
  assert.deepEqual([again.calls, shown()], [['show'], ['Team standup']]);
});

test('opened late it still covers the screen a few minutes after the start, and after that it does not', async (t) => {
  await at(t, '09:32:30');
  assert.deepEqual(shown(), ['Team standup'], 'the app woke two and a half minutes after the start');
  await act('dismiss');
  await at(t, '09:33:10', '2026-11-19');
  assert.deepEqual(shown(), [], 'three minutes after the start is too late to start covering the screen');
  assert.deepEqual(desktop.calls, ['show', 'close']);
});

test('left alone it closes itself five minutes after the start', async (t) => {
  await at(t, '09:29:00');
  await later(t, 5 * MIN + 59_000);
  assert.deepEqual(desktop.calls, ['show'], 'still up at 09:34:59');
  await later(t, 1000);
  assert.deepEqual([desktop.calls, shown()], [['show', 'close'], []]);
  await at(t, '09:36:00');
  assert.deepEqual(desktop.calls, ['show', 'close'], 'and it does not come back');
});

test('a declined meeting, an all-day event and one that is not wanted never cover the screen', async (t) => {
  await at(t, '15:59:00');
  await at(t, '23:59:30', '2026-11-17');
  assert.deepEqual(desktop.calls, [], 'declined, and the all-day offsite');
  const pick = async (clock, overlayWhich) => {
    t.mock.timers.setTime(AT(clock));
    await setOverlay({ overlayWhich });
  };
  await pick('08:00:00', 'accepted');
  await at(t, '10:29:00');
  assert.deepEqual(shown(), [], 'a maybe is not an accepted meeting');
  await pick('12:00:00', 'join');
  await at(t, '13:59:00');
  assert.deepEqual(shown(), ['Pairing with Judy'], 'only the one with a join link');
  await act('dismiss');
  await pick('16:00:00', 'accepted');
  await at(t, '16:59:00');
  assert.deepEqual(shown(), [], 'nor is an event of your own with nobody invited');
  await pick('16:59:10', 'all');
  await calendar.settled();
  assert.deepEqual(shown(), ['Focus'], 'every one you have not declined, and a change of mind counts at once');
});

test('two meetings at once share the screen, and joining one opens its own link and closes it for both', async (t) => {
  await at(t, '13:59:00');
  assert.deepEqual(shown(), ['Pairing with Judy', 'Pairing with Olivia']);
  assert.deepEqual(desktop.calls, ['show']);
  const answer = await act('join', keyOf('Pairing with Judy'));
  assert.equal(answer.text, 'Joining Pairing with Judy');
  assert.deepEqual(desktop.opened, [MEET.url]);
  assert.deepEqual([desktop.calls, shown()], [['show', 'close'], []]);
  await at(t, '14:00:30');
  assert.deepEqual(desktop.calls, ['show', 'close'], 'acting on it settles both');
});

test('Join opens only the link of the meeting named, never one the page sends', async (t) => {
  await at(t, '10:29:00');
  await act('join', keyOf('Architecture discussion'));
  assert.deepEqual(desktop.opened, [ZOOM.url]);
  await at(t, '13:59:00');
  await assert.rejects(act('open', keyOf('Pairing with Judy')), { status: 400 });
  await act('join', 'pair-a@1|1');
  assert.deepEqual(desktop.opened, [ZOOM.url], 'a key it is not showing opens nothing');
  assert.deepEqual(shown(), []);
});

test('with no join link, Open in the calendar brings the dashboard forward at the calendar', async (t) => {
  await setOverlay({ overlayWhich: 'all' });
  await at(t, '13:59:00');
  const answer = await act('calendar', keyOf('Pairing with Olivia'));
  assert.equal(answer.text, 'Opened the calendar');
  assert.deepEqual(desktop.opened, []);
  assert.deepEqual(desktop.calls, ['show', 'close', 'focus']);
  assert.equal(told.at(-1), 'goto:calendar');
});

test('Snooze waits until the start, then a minute at a time once it has started', async (t) => {
  await at(t, '09:29:00');
  await later(t, 10_000);
  await act('snooze');
  assert.deepEqual([desktop.calls, shown()], [['show', 'close'], []]);
  await later(t, 49_000);
  assert.deepEqual(desktop.calls, ['show', 'close'], 'still snoozed at 09:29:59');
  await later(t, 1000);
  assert.deepEqual([desktop.calls, shown()], [['show', 'close', 'show'], ['Team standup']], 'back at 09:30:00');
  await later(t, 60_000);
  await act('snooze');
  await later(t, 59_000);
  assert.equal(desktop.calls.length, 4);
  await later(t, 1000);
  assert.deepEqual(desktop.calls, ['show', 'close', 'show', 'close', 'show'], 'a minute after it was snoozed at 09:31');
  await act('dismiss');
  await later(t, 2 * MIN);
  assert.deepEqual(shown(), [], 'dismissed for good');
});

test('a snooze outlives a restart', async (t) => {
  await at(t, '09:29:00');
  await act('snooze');
  calendar.stop();
  desktop = fakeDesktop();
  await calendar.start(config, shellWith());
  await calendar.settled();
  await at(t, '09:30:00');
  assert.deepEqual([desktop.calls, shown()], [['show'], ['Team standup']]);
});

test('the lead time is a setting, Off covers nothing, and the banner keeps its own lead', async (t) => {
  assert.match((await setOverlay({ overlayLead: 300 })).text, /^The screen is covered 5 min before each meeting you have not declined$/);
  await at(t, '09:25:00');
  assert.deepEqual([banners, desktop.calls], [['In 5 min: Team standup'], ['show']], 'a banner at five minutes and the overlay at five too');
  await act('dismiss');
  assert.equal((await setOverlay({ overlayLead: 30 })).text, 'The screen is covered 30 s before each meeting you have not declined');
  await at(t, '10:25:00');
  assert.deepEqual([banners.length, desktop.calls.length], [2, 2], 'the banner at five minutes, the overlay not yet');
  await at(t, '10:29:30');
  assert.deepEqual(shown(), ['Architecture discussion']);
  assert.equal((await setOverlay({ overlay: false })).text, 'No full-screen reminder before meetings');
  await calendar.settled();
  assert.deepEqual([desktop.calls.at(-1), shown()], ['close', []], 'turned off, it closes');
  await at(t, '13:59:30');
  assert.deepEqual(desktop.calls.filter((c) => c === 'show').length, 2);
  for (const wrong of [{ overlayLead: 45 }, { overlayWhich: 'some' }, { overlay: 'yes' }, {}]) await assert.rejects(setOverlay(wrong), { status: 400 }, JSON.stringify(wrong));
});

test('in the Orca plugin there is no app to cover the screen, so the banner still comes and Settings says so', async (t) => {
  calendar.stop();
  await calendar.start(config, { notify: (what) => told.push(what) });
  await calendar.settled();
  const view = await call('GET', '/api/calendar/settings');
  assert.deepEqual([view.overlay, view.overlayHere, view.overlayLeads, view.overlayWhichOptions], [true, false, [30, 60, 120, 300], ['all', 'join', 'accepted']]);
  await at(t, '09:25:00');
  await at(t, '09:29:00');
  assert.deepEqual([banners, shown()], [['In 5 min: Team standup'], []]);
  assert.equal(existsSync(join(state, 'meeting-overlay.json')), false, 'nothing is marked, so the app could still show it');
  calendar.stop();
  await calendar.start(config, shellWith());
  await calendar.settled();
  assert.equal((await call('GET', '/api/calendar/settings')).overlayHere, true);
  await at(t, '09:29:30');
  assert.deepEqual(shown(), ['Team standup'], 'the app opened meanwhile still covers the screen for it');
});
