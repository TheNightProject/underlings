import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { calendarEvents, meetingsOn, type CalendarEvent } from './standup/calendar.js';

const WEEK = readFileSync(new URL('./fixtures/calendar/week.ics', import.meta.url), 'utf8');
const STANDUP = readFileSync(new URL('./fixtures/standup/calendar.ics', import.meta.url), 'utf8');

const at = (iso: string) => Date.parse(iso);
const week = () => calendarEvents(WEEK, '2026-11-16', '2026-11-20');

async function one(title: string, from = '2026-11-16', to = '2026-11-20'): Promise<CalendarEvent> {
  const found = (await calendarEvents(WEEK, from, to)).find((e) => e.title === title);
  assert.ok(found, `${title} is in the window`);
  return found;
}

const brief = (e: CalendarEvent) => `${new Date(e.start).toISOString().slice(5, 16)} ${e.title}`;

test('every occurrence in the window is listed in order, the cancelled and excluded ones left out and the declined one kept', async () => {
  assert.deepEqual((await week()).map(brief), [
    '11-13T00:00 Abe on leave',
    '11-16T09:30 Daily standup',
    '11-17T09:30 Daily standup',
    '11-17T14:00 Architecture review ABC-4389',
    '11-17T14:30 Vendor findings walkthrough',
    '11-18T11:00 Planning: Q1 roadmap',
    '11-18T16:00 All hands',
    '11-19T00:00 Team offsite',
    '11-19T10:00 Daily standup (later, longer)',
    '11-19T15:00 Dentist',
    '11-20T17:00 Team social',
    '11-20T23:30 Release window',
  ]);
});

test('a series keeps its own length, and a moved instance its new time and length, at its old id', async () => {
  const standups = (await week()).filter((e) => e.title.startsWith('Daily standup'));
  assert.deepEqual(standups.map((e) => [e.start, e.end]), [
    [at('2026-11-16T09:30:00Z'), at('2026-11-16T09:45:00Z')],
    [at('2026-11-17T09:30:00Z'), at('2026-11-17T09:45:00Z')],
    [at('2026-11-19T10:00:00Z'), at('2026-11-19T10:30:00Z')],
  ]);
  assert.equal(standups[2]?.id, `standup-01@google.com@${at('2026-11-19T09:30:00Z') / 1000}`, 'the id names the occurrence it moved from');
  assert.equal(standups[2]?.title, 'Daily standup (later, longer)');
  assert.ok(!(await calendarEvents(WEEK, '2026-11-19', '2026-11-19')).some((e) => e.start === at('2026-11-19T09:30:00Z')), 'nothing is left at the old time');
});

test('an event that runs past midnight ends the next day, and a time with no zone is London wall clock', async () => {
  const release = await one('Release window');
  assert.deepEqual([release.end, release.firstDay, release.lastDay, release.allDay], [at('2026-11-21T00:30:00Z'), '2026-11-20', '2026-11-21', false]);
  assert.ok((await calendarEvents(WEEK, '2026-11-21', '2026-11-21')).some((e) => e.title === 'Release window'), 'it shows on the day it ends too');
  const summer = await one('Summer barbecue', '2026-07-01', '2026-07-01');
  assert.deepEqual([summer.start, summer.end, summer.firstDay], [at('2026-07-01T17:00:00Z'), at('2026-07-01T18:30:00Z'), '2026-07-01']);
});

test('an all-day event covers London midnight to midnight on each day it spans, and shows from either edge of the window', async () => {
  const offsite = await one('Team offsite');
  assert.deepEqual([offsite.allDay, offsite.firstDay, offsite.lastDay, offsite.start, offsite.end], [true, '2026-11-19', '2026-11-21', at('2026-11-19T00:00:00Z'), at('2026-11-22T00:00:00Z')]);
  const leave = await one('Abe on leave', '2026-11-16', '2026-11-16');
  assert.deepEqual([leave.firstDay, leave.lastDay], ['2026-11-13', '2026-11-16']);
  assert.ok(!(await calendarEvents(WEEK, '2026-11-17', '2026-11-18')).some((e) => e.allDay), 'neither covers Tuesday or Wednesday');
  assert.equal((await calendarEvents(WEEK, '2026-11-21', '2026-11-21')).filter((e) => e.allDay).length, 1);
});

test('the join link is found in the conference property, the location, a link in the description and the description text, and Meet\'s notes are dropped', async () => {
  assert.deepEqual((await one('Daily standup')).join, { url: 'https://meet.google.com/abc-defg-hij', kind: 'meet' });
  assert.deepEqual((await one('Daily standup (later, longer)')).join, { url: 'https://meet.google.com/abc-defg-hij', kind: 'meet' }, 'a moved instance with no description still has its conference');
  assert.deepEqual((await one('Architecture review ABC-4389')).join, { url: 'https://us02web.zoom.us/j/81234567890?pwd=abcDEF123', kind: 'zoom' });
  assert.deepEqual((await one('Vendor findings walkthrough')).join, {
    url: 'https://teams.microsoft.com/l/meetup-join/19%3ameeting_NjA2%40thread.v2/0?context=%7b%22Tid%22%3a%22t1%22%7d&btype=a', kind: 'teams',
  });
  assert.deepEqual((await one('Planning: Q1 roadmap')).join, { url: 'https://meet.google.com/xyz-abcd-efg', kind: 'meet' }, 'the full stop after it is not part of it');
  assert.equal((await one('All hands')).join, null);
  assert.equal((await one('Daily standup')).description, 'Daily check-in.');
});

test('a description is plain text: tags gone, list items and paragraphs kept as lines, and a link kept as its words and address', async () => {
  assert.equal((await one('Vendor findings walkthrough')).description, [
    'Agenda:',
    '',
    '- Findings',
    '- Next steps',
    '',
    'Join on Microsoft Teams (https://teams.microsoft.com/l/meetup-join/19%3ameeting_NjA2%40thread.v2/0?context=%7b%22Tid%22%3a%22t1%22%7d&btype=a) & bring notes.',
  ].join('\n'));
  assert.equal((await one('Dentist')).location, '12 High Street, Lewes');
  assert.equal((await one('Dentist')).description, null);
});

test('your response is read from your own invite, and is null when you are not on it', async () => {
  const yours = Object.fromEntries((await week()).map((e) => [e.title, e.response]));
  assert.deepEqual(yours, {
    'Abe on leave': null,
    'Daily standup': 'accepted',
    'Architecture review ABC-4389': 'accepted',
    'Vendor findings walkthrough': 'tentative',
    'Planning: Q1 roadmap': 'needs-action',
    'All hands': 'declined',
    'Team offsite': 'accepted',
    'Daily standup (later, longer)': 'accepted',
    Dentist: null,
    'Team social': null,
    'Release window': 'accepted',
  });
});

test('the organiser comes first, rooms are not people, and each person has a full name, a response and whether they are optional', async () => {
  const arch = await one('Architecture review ABC-4389');
  assert.deepEqual(arch.organiser, { name: 'Niaj Nair', email: 'niaj.nair@example.com' });
  assert.deepEqual(arch.attendees.map((a) => [a.name, a.response, a.self, a.organiser]), [
    ['Niaj Nair', 'accepted', false, true],
    ['Frank Foster', 'accepted', true, false],
    ['Olivia Owens', 'declined', false, false],
  ]);
  assert.deepEqual(arch.others, ['Niaj'], 'the others the Standup would name, in invite order');
  const release = await one('Release window');
  assert.deepEqual(release.attendees.map((a) => [a.name, a.optional]), [['Olivia Owens', false], ['Frank Foster', false], ['Hugo Hale', true]]);
  assert.equal((await one('Dentist')).organiser, null);
});

test('the ids are the Standup\'s, and what the Standup lists is what is here less what you declined', async () => {
  const days = ['2026-11-09', '2026-11-10'];
  const meetings = [...(await meetingsOn(STANDUP, days)).values()].flat();
  const events = await calendarEvents(STANDUP, '2026-11-09', '2026-11-10');
  assert.deepEqual(events.filter((e) => e.response !== 'declined').map((e) => e.id).sort(), meetings.map((m) => m.id).sort());
  assert.deepEqual(events.filter((e) => e.response === 'declined').map((e) => e.title), ['All hands']);
});

test('a window is two London days in order', async () => {
  for (const [from, to] of [['2026-11-20', '2026-11-16'], ['2026-02-30', '2026-03-01'], ['16/11/2026', '2026-11-20']]) {
    await assert.rejects(calendarEvents(WEEK, from as string, to as string), { message: 'a calendar window looks like 2026-11-09 to 2026-11-13' });
  }
});

test('the Standup\'s meetings are exactly as they were', async () => {
  const found = await meetingsOn(STANDUP, ['2026-11-09', '2026-11-10']);
  assert.deepEqual([...found], [
    ['2026-11-09', [
      { id: 'wfh-10@google.com@1794182400', summary: 'Working from home', day: '2026-11-09', time: null, at: 1794182400000, others: [] },
      { id: 'focus-08@google.com@1794211200', summary: 'Focus: control centre', day: '2026-11-09', time: '08:00', at: 1794211200000, others: [] },
      { id: 'vendor-09@vendor.example@1794222000', summary: 'Vendor findings walkthrough', day: '2026-11-09', time: '11:00', at: 1794222000000, others: ['Ivan'] },
      { id: 'lunch-04@google.com@1794227400', summary: 'Lunch', day: '2026-11-09', time: '12:30', at: 1794227400000, others: [] },
      { id: 'gbac-rundown-01@google.com@1794233700', summary: 'GBAC Rundown', day: '2026-11-09', time: '14:15', at: 1794233700000, others: ['Heidi', 'Niaj'] },
      { id: 'school-run-05@google.com@1794236400', summary: 'School Run', day: '2026-11-09', time: '15:00', at: 1794236400000, others: [] },
      { id: 'one-to-one-03@google.com@1794477600', summary: '1:1 Frank / Judy (moved)', day: '2026-11-09', time: '16:00', at: 1794240000000, others: ['Judy'] },
    ]],
    ['2026-11-10', [
      { id: 'arch-discussion-02@google.com@1794306600', summary: 'Architecture discussion', day: '2026-11-10', time: '10:30', at: 1794306600000, others: ['Niaj', 'Judy'] },
      { id: 'lunch-04@google.com@1794313800', summary: 'Lunch', day: '2026-11-10', time: '12:30', at: 1794313800000, others: [] },
    ]],
  ]);
});

test('a fresh install in New York sees each meeting at its New York time, with its days cut at New York midnight', async () => {
  const events = await calendarEvents(WEEK, '2026-11-16', '2026-11-20', 'America/New_York');
  const release = events.find((e) => e.title === 'Release window');
  assert.deepEqual([release?.start, release?.firstDay, release?.lastDay], [at('2026-11-20T23:30:00Z'), '2026-11-20', '2026-11-20'], '18:30 to 19:30 in New York, all on the Friday');
  const offsite = events.find((e) => e.title === 'Team offsite');
  assert.deepEqual([offsite?.start, offsite?.end], [at('2026-11-19T05:00:00Z'), at('2026-11-22T05:00:00Z')]);
  const summer = (await calendarEvents(WEEK, '2026-07-01', '2026-07-01', 'America/New_York')).find((e) => e.title === 'Summer barbecue');
  assert.equal(summer?.start, at('2026-07-01T22:00:00Z'), 'a time with no zone is New York wall clock');
});

test('in Tokyo a late London meeting falls on the next day, and the standup lists it there', async () => {
  const friday = await calendarEvents(WEEK, '2026-11-20', '2026-11-20', 'Asia/Tokyo');
  assert.ok(!friday.some((e) => e.title === 'Release window'), '23:30 in London is 08:30 on Saturday in Tokyo');
  const saturday = (await calendarEvents(WEEK, '2026-11-21', '2026-11-21', 'Asia/Tokyo')).find((e) => e.title === 'Release window');
  assert.deepEqual([saturday?.firstDay, saturday?.lastDay], ['2026-11-21', '2026-11-21']);
  const found = await meetingsOn(STANDUP, ['2026-11-09', '2026-11-10'], 'Asia/Tokyo');
  const lunch = found.get('2026-11-09')?.find((m) => m.summary === 'Lunch');
  assert.equal(lunch?.time, '21:30', '12:30 in London');
});

const SANTIAGO_SPRING = [
  'BEGIN:VCALENDAR', 'VERSION:2.0', 'X-WR-CALNAME:frank.foster@example.com',
  'BEGIN:VEVENT', 'DTSTART;VALUE=DATE:20260906', 'DTEND;VALUE=DATE:20260907', 'DTSTAMP:20260901T000000Z', 'UID:holiday@test', 'SUMMARY:Day off', 'END:VEVENT',
  'BEGIN:VEVENT', 'DTSTART:20260906T003000', 'DTEND:20260906T020000', 'DTSTAMP:20260901T000000Z', 'UID:early@test', 'SUMMARY:Early call', 'END:VEVENT',
  'END:VCALENDAR',
].join('\r\n');

test('where the clocks skip midnight, an all-day event starts when the day does and a time in the gap is read on the offset before it', async () => {
  const events = await calendarEvents(SANTIAGO_SPRING, '2026-09-06', '2026-09-06', 'America/Santiago');
  const off = events.find((e) => e.title === 'Day off');
  assert.deepEqual([off?.start, off?.end], [at('2026-09-06T04:00:00Z'), at('2026-09-07T03:00:00Z')], 'the Sunday runs from 01:00, when the clocks jump, and is 23 hours long');
  assert.equal(events.find((e) => e.title === 'Early call')?.start, at('2026-09-06T04:30:00Z'), '00:30 never happens, so it is 01:30');
});
