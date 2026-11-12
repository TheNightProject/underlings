import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { calendarUrl, meetingsOn, namesLine } from './standup/calendar.js';

const ICS = readFileSync(new URL('./fixtures/standup/calendar.ics', import.meta.url), 'utf8');

async function on(day: string, ics = ICS) {
  return ((await meetingsOn(ics, [day])).get(day) ?? []).map((m) => `${m.time ?? 'all day'} ${m.summary}${m.others.length ? ` with ${m.others.join(', ')}` : ''}`);
}

const event = (lines: string[]) => ['BEGIN:VCALENDAR', 'VERSION:2.0', 'X-WR-CALNAME:Work', ...lines, 'END:VCALENDAR'].join('\r\n');

test('a weekly meeting is expanded onto the day, in London time, with the names of the others in it', async () => {
  assert.deepEqual(await on('2026-11-09'), [
    'all day Working from home',
    '08:00 Focus: control centre',
    '11:00 Vendor findings walkthrough with Ivan',
    '12:30 Lunch',
    '14:15 GBAC Rundown with Heidi, Niaj',
    '15:00 School Run',
    '16:00 1:1 Frank / Judy (moved) with Judy',
  ]);
});

test('summer time keeps the wall clock the series was set in', async () => {
  assert.ok((await on('2026-09-07')).includes('14:15 GBAC Rundown with Heidi, Niaj'));
  assert.ok((await on('2026-10-26')).includes('14:15 GBAC Rundown with Heidi, Niaj'), 'the Monday after the clocks go back');
});

test('an excluded date drops that week, and nothing else', async () => {
  assert.ok(!(await on('2026-11-02')).some((m) => m.includes('GBAC')));
  assert.ok((await on('2026-11-16')).some((m) => m.includes('GBAC')));
});

test('a moved instance shows on the day it moved to, and not on the day it left', async () => {
  assert.ok(!(await on('2026-11-12')).some((m) => m.includes('1:1')));
  assert.ok((await on('2026-11-19')).includes('10:00 1:1 Frank / Judy with Judy'));
});

test('a cancelled instance, and a meeting you declined, are left out', async () => {
  const day = await on('2026-11-09');
  assert.ok(!day.some((m) => m.includes('Platform sync')));
  assert.ok(!day.some((m) => m.includes('All hands')));
  assert.ok((await on('2026-11-16')).includes('09:00 Platform sync with Olivia'));
});

test('rooms and people who declined are not named, and a name is read from an address when there is no other', async () => {
  const tuesday = await on('2026-11-10');
  assert.ok(tuesday.includes('10:30 Architecture discussion with Niaj, Judy'));
  assert.ok((await on('2026-11-09')).some((m) => m.endsWith('GBAC Rundown with Heidi, Niaj')));
});

test('an all-day event covers each day it spans and only those', async () => {
  const ics = event(['BEGIN:VEVENT', 'UID:offsite', 'DTSTART;VALUE=DATE:20261109', 'DTEND;VALUE=DATE:20261111', 'SUMMARY:Offsite', 'END:VEVENT']);
  const found = await meetingsOn(ics, ['2026-11-08', '2026-11-09', '2026-11-10', '2026-11-11']);
  assert.deepEqual([...found].map(([day, list]) => [day, list.length]), [['2026-11-08', 0], ['2026-11-09', 1], ['2026-11-10', 1], ['2026-11-11', 0]]);
});

test('when the calendar is not named after you, you are whoever is invited most', async () => {
  const invite = (uid: string, partstat: string) => ['BEGIN:VEVENT', `UID:${uid}`, 'DTSTART:20261109T100000Z', 'DTEND:20261109T110000Z', `SUMMARY:${uid}`,
    `ATTENDEE;PARTSTAT=${partstat};CN=Me Myself:mailto:me@example.com`, 'ATTENDEE;PARTSTAT=ACCEPTED;CN=Abe Archer:mailto:abe@example.com', 'END:VEVENT'];
  const ics = event([...invite('kept', 'ACCEPTED'), ...invite('declined', 'DECLINED'), 'BEGIN:VEVENT', 'UID:solo', 'DTSTART:20261109T120000Z', 'SUMMARY:solo',
    'ATTENDEE;PARTSTAT=ACCEPTED:mailto:me@example.com', 'END:VEVENT']);
  assert.deepEqual(await on('2026-11-09', ics), ['10:00 kept with Abe', '12:00 solo']);
});

test('a time with no zone is read as London wall clock', async () => {
  const ics = event(['BEGIN:VEVENT', 'UID:floating', 'DTSTART:20260701T093000', 'DTEND:20260701T100000', 'SUMMARY:Floating', 'END:VEVENT']);
  assert.deepEqual(await on('2026-07-01', ics), ['09:30 Floating']);
});

test('names read as a sentence, and a long list is cut short', () => {
  assert.equal(namesLine(['Abe']), 'Abe');
  assert.equal(namesLine(['Abe', 'Ben']), 'Abe and Ben');
  assert.equal(namesLine(['Abe', 'Ben', 'Cy']), 'Abe, Ben and Cy');
  assert.equal(namesLine(['Abe', 'Ben', 'Cy', 'Di', 'Ed', 'Flo']), 'Abe, Ben, Cy and 3 others');
});

test('only an https or webcal address is taken, and webcal is read over https', () => {
  assert.equal(calendarUrl('webcal://calendar.google.com/calendar/ical/x/basic.ics'), 'https://calendar.google.com/calendar/ical/x/basic.ics');
  assert.throws(() => calendarUrl('http://calendar.google.com/x.ics'), /must start with https/);
  assert.throws(() => calendarUrl('not a link'), /not a link/);
});
