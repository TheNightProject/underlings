import assert from 'node:assert/strict';
import { test } from 'node:test';
import { addDays, dateFormat, dayIn, dayText, inHours, localeOf, numberText, startOfDay, wallClock, workingDay, zonedTime } from './clock.mjs';

const iso = (ms) => new Date(ms).toISOString();
const HOUR = 3_600_000;
const length = (day, zone) => (startOfDay(workingDay(day, 1, [0, 1, 2, 3, 4, 5, 6]), zone) - startOfDay(day, zone)) / HOUR;

test('a day starts at midnight in London on both days the clocks change, and those days are 23 and 25 hours long', () => {
  assert.equal(iso(startOfDay('2026-11-09', 'Europe/London')), '2026-11-09T00:00:00.000Z');
  assert.equal(iso(startOfDay('2026-07-01', 'Europe/London')), '2026-06-30T23:00:00.000Z');
  assert.equal(iso(startOfDay('2026-03-29', 'Europe/London')), '2026-03-29T00:00:00.000Z');
  assert.equal(iso(startOfDay('2026-10-25', 'Europe/London')), '2026-10-24T23:00:00.000Z');
  assert.deepEqual([length('2026-03-29', 'Europe/London'), length('2026-10-25', 'Europe/London'), length('2026-11-09', 'Europe/London')], [23, 25, 24]);
});

test('New York, Tokyo and Kolkata start their days at their own midnights, whatever London is doing', () => {
  assert.equal(iso(startOfDay('2026-03-08', 'America/New_York')), '2026-03-08T05:00:00.000Z');
  assert.equal(iso(startOfDay('2026-03-09', 'America/New_York')), '2026-03-09T04:00:00.000Z', 'EDT from 02:00 on the 8th');
  assert.equal(iso(startOfDay('2026-11-01', 'America/New_York')), '2026-11-01T04:00:00.000Z');
  assert.deepEqual([length('2026-03-08', 'America/New_York'), length('2026-11-01', 'America/New_York')], [23, 25]);
  assert.equal(iso(startOfDay('2026-03-29', 'Asia/Tokyo')), '2026-03-28T15:00:00.000Z');
  assert.equal(iso(startOfDay('2026-10-25', 'Asia/Kolkata')), '2026-10-24T18:30:00.000Z');
  assert.deepEqual([length('2026-03-29', 'Asia/Tokyo'), length('2026-10-25', 'Asia/Kolkata')], [24, 24]);
});

test('where the clocks skip midnight the day starts when they jump, and where they repeat it the day starts at the first one', () => {
  assert.equal(iso(startOfDay('2026-09-06', 'America/Santiago')), '2026-09-06T04:00:00.000Z', '00:00 becomes 01:00 in Santiago');
  assert.equal(wallClock(startOfDay('2026-09-06', 'America/Santiago'), 'America/Santiago').time, '01:00');
  assert.equal(dayIn(startOfDay('2026-09-06', 'America/Santiago') - 1, 'America/Santiago'), '2026-09-05');
  assert.equal(iso(startOfDay('2026-04-05', 'America/Santiago')), '2026-04-05T04:00:00.000Z', 'Saturday runs on to 23:59 twice');
  assert.equal(iso(startOfDay('2026-03-08', 'America/Havana')), '2026-03-08T05:00:00.000Z');
  assert.equal(iso(startOfDay('2026-11-01', 'America/Havana')), '2026-11-01T04:00:00.000Z', 'the first of the two midnights');
  assert.deepEqual([length('2026-09-06', 'America/Santiago'), length('2026-03-08', 'America/Havana'), length('2026-11-01', 'America/Havana')], [23, 23, 25]);
});

test('in every zone, on each day around a change of its clocks in 2026, the day starts at its first instant', () => {
  const noon = (day) => Date.parse(`${day}T12:00:00Z`);
  const offset = (day, zone) => {
    const wall = wallClock(noon(day), zone);
    return Date.parse(`${wall.date}T${wall.time}:00Z`) - noon(day);
  };
  const checked = new Set();
  for (const zone of Intl.supportedValuesOf('timeZone')) {
    for (let day = '2026-01-01', was = offset('2025-12-31', zone); day <= '2026-12-31'; day = addDays(day, 1)) {
      const now = offset(day, zone);
      if (now === was) continue;
      was = now;
      for (const near of [addDays(day, -1), day, addDays(day, 1)]) {
        const start = startOfDay(near, zone);
        assert.deepEqual([dayIn(start - 1, zone) < near, dayIn(start, zone)], [true, near], `${zone} ${near}`);
        checked.add(zone);
      }
    }
  }
  assert.ok(checked.size > 100, `${checked.size} zones change their clocks`);
});

test('the wall clock steps over the change, so an instant is read on the day and at the time it showed', () => {
  assert.deepEqual(wallClock(Date.parse('2026-03-29T00:59:00Z'), 'Europe/London'), { date: '2026-03-29', time: '00:59', minutes: 59 });
  assert.deepEqual(wallClock(Date.parse('2026-03-29T01:00:00Z'), 'Europe/London'), { date: '2026-03-29', time: '02:00', minutes: 120 });
  assert.equal(dayIn(Date.parse('2026-11-09T23:30:00Z'), 'Asia/Kolkata'), '2026-11-10');
  assert.equal(dayIn(Date.parse('2026-11-09T23:30:00Z'), 'America/New_York'), '2026-11-09');
  assert.equal(dayIn(Date.parse('2026-11-09T15:00:00Z'), 'Asia/Tokyo'), '2026-11-10');
});

test('a local time is read as a calendar reads it: the earlier of two, and on the earlier offset when skipped', () => {
  assert.equal(iso(zonedTime('2026-11-01', '01:30', 'America/New_York')), '2026-11-01T05:30:00.000Z', '01:30 EDT, not EST');
  assert.equal(iso(zonedTime('2026-03-08', '02:30', 'America/New_York')), '2026-03-08T07:30:00.000Z', 'which is 03:30 EDT');
  assert.equal(iso(zonedTime('2026-07-01', '18:00', 'Europe/London')), '2026-07-01T17:00:00.000Z');
  assert.equal(iso(zonedTime('2026-07-01', '18:00', 'Asia/Kolkata')), '2026-07-01T12:30:00.000Z');
});

test('working days step over the days you do not work, either way', () => {
  assert.equal(workingDay('2026-11-09', -1), '2026-11-06', 'Monday looks back to Friday');
  assert.equal(workingDay('2026-11-08', -1), '2026-11-06', 'and so does Sunday');
  assert.equal(workingDay('2026-11-06', 1), '2026-11-09');
  assert.equal(workingDay('2026-11-08', -1, [0, 1, 2, 3, 4]), '2026-11-05', 'Sunday to Thursday');
  assert.equal(workingDay('2026-11-05', 1, [0, 1, 2, 3, 4]), '2026-11-08');
  assert.equal(workingDay('2026-11-05', 1, []), '2026-11-06', 'no days at all is read as the default week');
});

test('working hours are wall clock where you are, on your working days, and may run past midnight', () => {
  const hours = { from: '08:00', to: '18:00', workDays: [0, 1, 2, 3, 4] };
  assert.equal(inHours(Date.parse('2026-11-08T02:30:00Z'), hours, 'Asia/Kolkata'), true, '08:00 on a Sunday in Kolkata');
  assert.equal(inHours(Date.parse('2026-11-08T02:29:00Z'), hours, 'Asia/Kolkata'), false);
  assert.equal(inHours(Date.parse('2026-11-13T06:00:00Z'), hours, 'Asia/Kolkata'), false, 'a Friday off');
  assert.equal(inHours(Date.parse('2026-07-01T07:30:00Z'), { ...hours, workDays: [3] }, 'Europe/London'), true, '08:30 in a London summer');
  assert.equal(inHours(Date.parse('2026-11-10T23:00:00Z'), { from: '22:00', to: '06:00', workDays: [2] }, 'Europe/London'), true);
});

test('formats follow the region and the clock, and a 12 hour clock drops the leading nought', () => {
  const at = Date.parse('2026-07-03T13:05:09Z');
  const frank = { timeZone: 'Europe/London', region: 'en-GB', clock: '24' };
  const hm = { hour: '2-digit', minute: '2-digit' };
  assert.equal(dateFormat(frank, { weekday: 'short', day: 'numeric', month: 'short', ...hm }).format(at), 'Fri 3 Jul, 14:05');
  assert.equal(dateFormat({ ...frank, clock: '12' }, hm).format(at), '2:05 pm');
  assert.equal(dateFormat({ timeZone: 'America/New_York', region: 'en-US', clock: '' }, hm).format(at), '9:05 AM');
  assert.equal(dateFormat({ timeZone: 'America/New_York', region: 'en-US', clock: '24' }, hm).format(at), '09:05');
  assert.equal(dateFormat({ timeZone: 'Asia/Tokyo', region: 'ja-JP', clock: '' }, { day: 'numeric', month: 'short' }).format(at), '7月3日');
  assert.equal(dayText(frank, '2026-11-11', { weekday: 'long', day: 'numeric', month: 'long' }), 'Wednesday 11 November');
  assert.equal(dayText({ timeZone: 'Pacific/Kiritimati', region: 'en-GB' }, '2026-11-11', { day: 'numeric', month: 'short' }), '11 Nov', 'a day is never moved by the zone');
  assert.deepEqual([numberText(frank, 12345.6), numberText({ region: 'de-DE' }, 12345.6)], ['12,345.6', '12.345,6']);
});

test('saved settings are read back only when they make sense', () => {
  assert.deepEqual(localeOf({}), { timeZone: '', region: '', clock: '', hours: { from: '08:00', to: '18:00', workDays: [1, 2, 3, 4, 5] } });
  assert.deepEqual(localeOf({ locale: { timeZone: 'europe/london', region: 'en-gb', clock: '12' }, hours: { from: '07:30', to: '19:00', workDays: [4, 0, 1, 2, 3, 3] } }),
    { timeZone: 'Europe/London', region: 'en-GB', clock: '12', hours: { from: '07:30', to: '19:00', workDays: [0, 1, 2, 3, 4] } });
  assert.deepEqual(localeOf({ locale: { timeZone: 'Mars/Base', region: 'not a region', clock: 'h23' }, hours: { from: '8am', workDays: [] } }), localeOf({}));
  assert.deepEqual(localeOf({ hours: { workDays: [1, 9] } }).hours.workDays, [1, 2, 3, 4, 5]);
});
