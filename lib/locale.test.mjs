import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';

const home = await mkdtemp(join(tmpdir(), 'control-centre-locale-'));
process.env.HOME = home;

const { route } = await import('./app.mjs');
const locale = await import('./locale.mjs');
const email = await import('./email.mjs');
const slack = await import('./slack.mjs');
const { collect } = await import('./attention.mjs');
const { bannerFor } = await import('./calendar.mjs');
const { inQuietHours } = await import('./notifier.mjs');
const { replay, statsOf, streakOf } = await import('./game-ledger.mjs');
const { reward, tokenRewards } = await import('./game-sources.mjs');
const { placeLocale, LONDON } = await import('./fixtures/locale.mjs');
after(() => rm(home, { recursive: true }));

const file = join(home, '.config/underlings/locale.json');
const call = (method, path, payload) => route({ method, path, query: new URLSearchParams(), body: async () => payload, config: {} });
const post = (payload) => call('POST', '/api/locale', payload);
const AT = (iso) => Date.parse(iso);
const on = { enabled: true };

beforeEach(async () => {
  await rm(join(home, '.config'), { recursive: true, force: true });
  await locale.refresh();
});

test('a fresh install follows the machine: its zone, its system\'s way of writing dates, and 08:00 to 18:00 on weekdays', async () => {
  const view = await call('GET', '/api/locale');
  assert.deepEqual(view, { timeZone: 'Europe/London', zoneSet: '', machineZone: 'Europe/London', region: '', clock: '', hours: { from: '08:00', to: '18:00', workDays: [1, 2, 3, 4, 5] }, days: 'weekdays' });
  assert.equal(locale.timeText(AT('2026-07-03T13:05:00Z')), '2:05 PM', 'an en-US system writes a 12 hour clock');
});

test('each setting is checked, saved in a file only you can read, and said back in words', async () => {
  for (const bad of [{ timeZone: 'Mars/Base' }, { region: 'not a region' }, { clock: 'h23' }, { from: '8am' }, { workDays: [] }, { workDays: [7] }, { from: '18:00' }, { colour: 'red' }]) {
    await assert.rejects(post(bad), { status: 400 }, JSON.stringify(bad));
  }
  const saved = await post({ timeZone: 'america/new_york', region: 'en-US', clock: '12' });
  assert.equal(saved.text, 'Times are shown in America/New_York. Dates and numbers are written as in en-US. Times use the 12 hour clock');
  assert.deepEqual([saved.timeZone, saved.zoneSet, saved.machineZone], ['America/New_York', 'America/New_York', 'Europe/London']);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')).locale, { timeZone: 'America/New_York', region: 'en-US', clock: '12' });
  const back = await post({ timeZone: '', region: '', clock: '' });
  assert.equal(back.text, 'Times follow this Mac, now Europe/London. Dates and numbers are written as your system writes them. Times use your region\'s clock');
  assert.equal((await post({ from: '07:00', workDays: [0, 1, 2, 3, 4] })).text, 'You work 07:00 to 18:00 on Sunday, Monday, Tuesday, Wednesday and Thursday');
});

test('email and Slack read in the same working hours, in your zone, and both move when you change them', async () => {
  const tuesday = AT('2026-11-10T09:00:00Z');
  assert.deepEqual([email.due(tuesday, on, null), slack.due(tuesday, on, null)], [true, true]);
  await post({ timeZone: 'Asia/Kolkata', from: '07:00', to: '15:00', workDays: [0, 1, 2, 3, 4] });
  const kolkata = (iso) => [email.due(AT(iso), on, null), slack.due(AT(iso), on, null)];
  assert.deepEqual(kolkata('2026-11-08T01:30:00Z'), [true, true], '07:00 on a Sunday in Kolkata');
  assert.deepEqual(kolkata('2026-11-08T01:29:00Z'), [false, false]);
  assert.deepEqual(kolkata('2026-11-10T09:30:00Z'), [false, false], '15:00 in Kolkata, still 09:30 in London');
  assert.deepEqual(kolkata('2026-11-13T05:00:00Z'), [false, false], 'Friday is a day off');
  assert.equal(slack.searches({ me: 'U1' }, AT('2026-11-10T20:00:00Z'))[0].args.filters, 'after:2026-11-04', 'a week back from Wednesday in Kolkata');
});

test('with a London locale saved, every time the worker writes is in London formats, on a system that writes US dates', async () => {
  const meeting = { id: 'standup@1', title: 'Team standup', start: AT('2026-11-18T09:30:00Z'), end: AT('2026-11-18T09:45:00Z'), others: ['Judy'], join: null };
  const down = {
    now: AT('2026-07-03T14:00:00Z'), me: 'frank', mrs: [], queue: [], memory: {}, runs: {}, state: { watches: {}, verdicts: {}, reviewHolds: {} }, rules: { people: [], onRequest: null, optedOut: new Set() },
    threads: new Map(), todos: [], agents: [], driver: { state: 'here', why: '' }, fetchError: 'down', fetchedAt: '2026-07-03T13:05:09Z', pollMs: 60_000, waiting: null, driverTurns: 0,
  };
  const written = () => [
    bannerFor(meeting, AT('2026-11-18T09:26:00Z')).body,
    collect(down).items.find((i) => i.kind === 'gitlab')?.why,
    tokenRewards({ '2026-11-10': 2_000_000 }, 40, AT('2026-11-11T12:00:00Z')).map((e) => e.label),
    locale.numberText(1000),
  ];
  const fresh = written();
  await placeLocale(home, LONDON);
  assert.deepEqual(written(), ['09:30 to 09:45 with Judy', 'GitLab has not answered since 14:05:09: down', ['1 million tokens on 10 Nov', '2 million tokens on 10 Nov'], '1,000']);
  assert.deepEqual(fresh.slice(0, 3), ['9:30 AM to 9:45 AM with Judy', 'GitLab has not answered since 2:05:09 PM: down', ['1 million tokens on Nov 10', '2 million tokens on Nov 10']], 'without it the system\'s own formats show');
  assert.deepEqual([locale.today(AT('2026-07-01T23:30:00Z')), locale.workingDay('2026-11-09', -1)], ['2026-07-02', '2026-11-06']);
});

test('in Tokyo the game\'s day, its late night and its streak all follow Tokyo and your working week', async () => {
  await placeLocale(home, { locale: { timeZone: 'Asia/Tokyo' }, hours: { workDays: [0, 1, 2, 3, 4] } });
  const merged = reward('merged', 'merged:x', '2026-11-09T14:30:00Z', 'Merged x');
  assert.equal(merged.day, '2026-11-09', '23:30 in Tokyo');
  assert.equal(reward('merged', 'merged:y', '2026-11-09T15:30:00Z', 'Merged y').day, '2026-11-10', 'after midnight in Tokyo');
  assert.equal(statsOf(replay([merged]), '2026-11-09').nightOwl, 1);
  assert.equal(statsOf(replay([reward('merged', 'merged:z', '2026-11-09T03:00:00Z', 'Merged z')]), '2026-11-09').nightOwl, 0, 'noon in Tokyo');
  const worked = new Set(['2026-11-05', '2026-11-08']);
  assert.equal(streakOf(worked, '2026-11-08'), 2, 'Thursday to Sunday over a Friday and Saturday off');
  await placeLocale(home, LONDON);
  assert.equal(streakOf(worked, '2026-11-08'), 1, 'a Monday to Friday week misses the Friday');
});

test('banners can stay quiet on the days you do not work, in your zone', async () => {
  const prefs = { quiet: false, weekends: true };
  assert.equal(inQuietHours(prefs, AT('2026-11-07T12:00:00Z')), true, 'Saturday');
  assert.equal(inQuietHours(prefs, AT('2026-11-08T12:00:00Z')), true, 'Sunday');
  await placeLocale(home, { locale: { timeZone: 'Asia/Tokyo' }, hours: { workDays: [0, 1, 2, 3, 4] } });
  assert.equal(inQuietHours(prefs, AT('2026-11-08T12:00:00Z')), false, 'Sunday is a working day');
  assert.equal(inQuietHours(prefs, AT('2026-11-05T16:00:00Z')), true, 'already Friday in Tokyo');
  assert.equal(inQuietHours({ quiet: true, quietFrom: '22:00', quietTo: '07:00', weekends: false }, AT('2026-11-10T14:00:00Z')), true, '23:00 in Tokyo');
});
