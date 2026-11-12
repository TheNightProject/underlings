import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { openPage } from './testkit.mjs';

const AT = '2026-11-18T10:40:00Z';
const NOW = Date.parse(AT);
const MIN = 60_000;
const at = (clock, day = '2026-11-18') => Date.parse(`${day}T${clock}:00Z`);

// A clock of its own per page, so a test that moves it moves no other.
function fixedDate() {
  return class FixedDate extends Date {
    constructor(...args) {
      super(...(args.length ? args : [FixedDate.now()]));
    }

    static now() {
      return NOW;
    }
  };
}

const person = (name, email, response = 'accepted', extra = {}) => ({ name, email, response, self: false, organiser: false, optional: false, ...extra });
const FRANK = (response) => person('Frank Foster', 'frank.foster@example.com', response, { self: true });

function meeting(id, title, from, to, extra = {}) {
  const day = extra.day ?? '2026-11-18';
  return {
    id, title, start: at(from, day), end: at(to, day), allDay: false, firstDay: day, lastDay: day, location: null, description: null, join: null,
    organiser: null, attendees: [], response: null, others: [], ...extra,
  };
}

const MEET = { url: 'https://meet.google.com/abc-defg-hij', kind: 'meet' };
const EVENTS = [
  { ...meeting('offsite@1', 'Planning offsite', '00:00', '00:00'), allDay: true, start: at('00:00', '2026-11-18'), end: at('00:00', '2026-11-20'), lastDay: '2026-11-19' },
  meeting('standup@1', 'Team standup', '09:30', '09:45', { join: MEET, response: 'accepted', others: ['Judy', 'Niaj'] }),
  meeting('arch@1', 'Architecture discussion: ABC-4412 and acme/tooling/atlas!45', '10:30', '11:30', {
    response: 'tentative', others: ['Niaj'], location: 'Room 3', join: { url: 'https://example.zoom.us/j/845', kind: 'zoom' },
    organiser: { name: 'Niaj Nair', email: 'niaj.nair@example.com' },
    attendees: [person('Niaj Nair', 'niaj.nair@example.com', 'accepted', { organiser: true }), FRANK('tentative'), person('Olivia Owens', 'olivia.owens@example.com', 'declined', { optional: true })],
    description: 'Agenda: <img src=x onerror=alert(1)> the event bus.\nNotes: https://docs.example.com/bus?x=1.',
  }),
  meeting('wiz@1', 'Vendor findings walkthrough', '11:15', '12:00', { response: 'needs-action', join: MEET, others: ['Ivan'] }),
  meeting('pair-a@1', 'Pairing with Judy', '14:00', '15:00', { response: 'accepted' }),
  meeting('pair-b@1', 'Pairing with Olivia', '14:00', '15:00', { response: 'accepted' }),
  meeting('allhands@1', 'All hands', '16:00', '17:00', { response: 'declined', join: MEET }),
  meeting('thu@1', 'Thursday review', '15:00', '15:30', { day: '2026-11-19', response: 'accepted' }),
  meeting('sat@1', 'Saturday climb', '10:00', '12:00', { day: '2026-11-21' }),
  meeting('sat-party@1', 'Saturday party', '19:00', '21:00', { day: '2026-11-21', response: 'declined' }),
];

function calendarData(from, to) {
  const inside = EVENTS.filter((e) => e.lastDay >= from && e.firstDay <= to);
  return { from, to, today: '2026-11-18', now: NOW, set: true, everyMinutes: 5, remindMinutes: 5, fetching: false, fetchedAt: '2026-11-18T10:38:00Z', error: null, events: inside };
}

function snapshot(over = {}) {
  return {
    generatedAt: AT, version: { ui: 1, lib: 1, worker: 1, loaded: 1 }, agents: [], artifacts: [],
    attention: { cards: [], agents: [], system: [], email: [], slack: [], count: 0, prefs: {}, toasts: [], offers: [] },
    calendar: { set: true, error: null, fetchedAt: AT, current: [], next: null },
    matrix: {
      available: true, running: false, me: 'frank', paused: false, holdSeconds: null, holdWhileReviewing: false,
      inbox: { fetchedAt: AT, loading: false, error: null, repoCount: 1, rows: [{ key: 'acme/tooling/atlas!45', repo: 'atlas', iid: 45, title: 'Split the panes', ticket: 'ABC-4262', flags: {}, mood: 'quiet', author: 'olivia' }] },
      fullAuto: [], roster: [], watches: [], verdicts: {}, queue: [], runs: [], autoPasses: [],
    },
    ...over,
  };
}

function memory(initial = {}) {
  const data = { ...initial };
  return { data, getItem: (k) => data[k] ?? null, setItem: (k, v) => { data[k] = String(v); } };
}

async function open({ hash = 'calendar', snap = snapshot(), storage = memory(), narrow = false, data = calendarData } = {}) {
  const posts = [];
  const page = await openPage({
    storage,
    globals: { Date: fixedDate(), ...(narrow ? { matchMedia: () => ({ matches: true, addEventListener() {} }) } : {}) },
    respond(path, init) {
      const url = new URL(path, 'http://page');
      if (init?.method === 'POST') {
        const body = JSON.parse(init.body);
        posts.push([url.pathname, body]);
        return { ok: true, text: 'Done', remindMinutes: body.remindMinutes ?? 5, leads: [0, 1, 2, 5, 10, 15], calendarSet: true };
      }
      if (url.pathname === '/api/calendar') return data(url.searchParams.get('from'), url.searchParams.get('to'));
      if (url.pathname === '/api/calendar/settings') return { remindMinutes: 5, leads: [0, 1, 2, 5, 10, 15], calendarSet: true };
      if (url.pathname === '/api/standup/settings') return { calendarSet: true, excludedRepos: [] };
      if (url.pathname === '/api/matrix/settings') return { rows: [], repos: null };
      return null;
    },
  });
  page.show(snap, hash);
  await page.settle(60);
  return Object.assign(page, { posts, storage });
}

const text = (node) => node?.textContent.replace(/\s+/g, ' ').trim();
const block = (page, id) => page.$$('#main .cal-event').find((n) => n.dataset.id === id) ?? null;
const style = (node, name) => new RegExp(`(?:^|;)${name}:([^;]+)`).exec(node.getAttribute('style') ?? '')?.[1] ?? null;
const heads = (page) => page.$$('.cal-head').map((n) => n.dataset.day);

async function click(page, node) {
  node.click();
  await page.settle(40);
}

test('Calendar sits under Work, after Standup', async () => {
  const html = await readFile(new URL('../dashboard.html', import.meta.url), 'utf8');
  const work = html.slice(html.indexOf('<h2>Work</h2>'), html.indexOf('</div>', html.indexOf('<h2>Work</h2>')));
  assert.deepEqual([...work.matchAll(/href="#([\w-]+)"/g)].map((m) => m[1]), ['tickets', 'standup', 'calendar', 'email', 'slack']);
});

test('the week runs Monday to Friday, and the weekend is a toggle away that is remembered', async () => {
  const page = await open();
  assert.deepEqual(page.errors, []);
  assert.deepEqual(heads(page), ['2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20']);
  assert.equal(text(page.$('.cal-label')), '16 to 20 November 2026');
  assert.equal(page.$('.cal-head.today').dataset.day, '2026-11-18');
  await click(page, page.$('#cal-weekend'));
  assert.equal(heads(page).length, 7);
  assert.ok(block(page, 'sat@1'), 'the weekend shows its meetings');
  assert.equal(JSON.parse(page.storage.data['cc.calendar']).weekend, true);
});

test('the day is a timeline: all-day events in the strip, each meeting at its hour, and the now line at now', async () => {
  const page = await open();
  await click(page, page.$('#cal-layout-day'));
  assert.deepEqual(heads(page), ['2026-11-18']);
  assert.deepEqual(page.$$('.cal-allday .cal-event').map((n) => n.dataset.id), ['offsite@1']);
  assert.equal(style(block(page, 'standup@1'), 'top'), '84.0px', '09:30 is an hour and a half below 08:00');
  assert.equal(style(block(page, 'standup@1'), 'height'), '20.0px', 'a quarter of an hour is drawn at the smallest a block can be read');
  assert.equal(style(page.$('.cal-now'), 'top'), '149.3px', '10:40 is 2 h 40 below 08:00');
  assert.equal(page.$$('.cal-now').length, 1);
  assert.match(text(block(page, 'arch@1')), /10:30 to 11:30 · Niaj/);
});

test('the now line is drawn only on today, and moves with the clock', async () => {
  const page = await open();
  await click(page, page.$('#cal-layout-day'));
  await click(page, page.$('#cal-next'));
  assert.deepEqual([heads(page), page.$$('.cal-now').length], [['2026-11-19'], 0]);
  await click(page, page.$('#cal-today'));
  page.window.Date.now = () => NOW + 30 * MIN;
  page.run('render()');
  assert.equal(style(page.$('.cal-now'), 'top'), '177.3px');
});

test('meetings at the same time sit side by side, and a later one covers only the tail of an earlier', async () => {
  const page = await open();
  await click(page, page.$('#cal-layout-day'));
  const [a, b] = [block(page, 'pair-a@1'), block(page, 'pair-b@1')];
  assert.deepEqual([style(a, 'left'), style(a, 'width')], ['calc(0 * 100% / 2 + 2px)', 'calc(1 * 100% / 2 - 4px)']);
  assert.deepEqual([style(b, 'left'), style(b, 'width')], ['calc(1 * 100% / 2 + 2px)', 'calc(1 * 100% / 2 - 4px)']);
  const [arch, wiz] = [block(page, 'arch@1'), block(page, 'wiz@1')];
  assert.equal(style(arch, 'width'), 'calc(2 * 100% / 2 - 4px)', 'starting 45 minutes later, the walkthrough leaves the discussion its full width');
  assert.equal(style(wiz, 'left'), 'calc(1 * 100% / 2 + 2px)');
  assert.ok(Number(style(wiz, 'z-index')) > Number(style(arch, 'z-index')), 'the later one is drawn on top');
  assert.equal(style(block(page, 'standup@1'), 'width'), 'calc(1 * 100% / 1 - 4px)');
});

test('tentative and unanswered meetings look their own, and a declined one shows only when asked', async () => {
  const page = await open();
  assert.ok(block(page, 'arch@1').classList.contains('r-tentative'));
  assert.ok(block(page, 'wiz@1').classList.contains('r-needs-action'));
  assert.ok(block(page, 'standup@1').classList.contains('r-accepted'));
  assert.ok(!block(page, 'allhands@1'));
  assert.equal(text(page.$('#cal-declined')), 'Declined (1)');
  await click(page, page.$('#cal-declined'));
  assert.ok(block(page, 'allhands@1').classList.contains('r-declined'));
  assert.equal(JSON.parse(page.storage.data['cc.calendar']).declined, true);
});

test('each meeting has its title, time, Join and who else, and a ticket or MR in the title is a link of the page\'s own', async () => {
  const page = await open();
  await click(page, page.$('#cal-layout-day'));
  const arch = block(page, 'arch@1');
  assert.deepEqual(arch.querySelectorAll('.cal-title .ticket-ref').map((n) => n.dataset.ticket), ['ABC-4412']);
  assert.deepEqual(arch.querySelectorAll('.cal-title .ref').map((n) => n.dataset.key), ['acme/tooling/atlas!45']);
  assert.equal(arch.querySelector('.cal-hit').getAttribute('aria-label'), 'Details of Architecture discussion: ABC-4412 and acme/tooling/atlas!45, 10:30 to 11:30, You said maybe, with Niaj');
  await click(page, arch.querySelector('.cal-join'));
  assert.deepEqual(page.posts, [['/api/open', { url: 'https://example.zoom.us/j/845' }]]);
  assert.ok(!block(page, 'pair-a@1').querySelector('.cal-join'), 'no link, no Join');
});

test('the agenda lists the coming days, and it is the only layout at phone width', async () => {
  const page = await open({ narrow: true });
  assert.ok(!page.$('#cal-layout-day'), 'no layout to pick on a phone');
  assert.ok(!page.$('.cal-grid'));
  assert.deepEqual(page.$$('.cal-agenda-day').map((n) => n.dataset.day), ['2026-11-18', '2026-11-19', '2026-11-21'], 'today, and the days after that have something on');
  const first = page.$$('.cal-item')[0];
  assert.equal(first.dataset.id, 'offsite@1');
  const arch = page.$$('.cal-item').find((n) => n.dataset.id === 'arch@1');
  assert.deepEqual(['.cal-item-when', '.pill', '.meta', '.cal-join'].map((sel) => text(arch.querySelector(sel))), ['10:30 to 11:30', 'Maybe', 'with Niaj · Room 3', 'Join on Zoom']);
  assert.equal(text(page.$('.cal-label')), '18 to 24 November 2026');
});

test('the layout picked is remembered for this viewer', async () => {
  const storage = memory();
  const page = await open({ storage });
  await click(page, page.$('#cal-layout-agenda'));
  assert.equal(JSON.parse(storage.data['cc.calendar']).layout, 'agenda');
  const again = await open({ storage });
  assert.ok(again.$('.cal-agenda'));
  assert.equal(again.$('#cal-layout-agenda').getAttribute('aria-pressed'), 'true');
  const refused = await open({ storage: { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } } });
  assert.ok(refused.$('.cal-grid'), 'storage that refuses still opens on the week');
});

test('stepping goes a day or a week at a time, and Today comes back', async () => {
  const page = await open();
  await click(page, page.$('#cal-next'));
  assert.equal(heads(page)[0], '2026-11-23');
  await click(page, page.$('#cal-back'));
  await click(page, page.$('#cal-back'));
  assert.equal(heads(page)[0], '2026-11-09');
  await click(page, page.$('#cal-today'));
  assert.equal(heads(page)[0], '2026-11-16');
  assert.ok(page.$('#cal-today').disabled);
});

test('a meeting opens its details: the description as text with links, who answered what, and Join; Esc closes it', async () => {
  const page = await open();
  await click(page, block(page, 'arch@1').querySelector('.cal-hit'));
  const card = page.$('#cal-event');
  assert.equal(card.hidden, false);
  assert.match(text(card.querySelector('.cal-detail-when')), /^Wednesday 18 November, 10:30 to 11:30 \(1 h\)$/);
  assert.match(text(card), /You said maybe/);
  assert.equal(card.querySelectorAll('img').length, 0, 'markup in a description stays text');
  assert.match(text(card.querySelectorAll('.cal-text').at(-1)), /^Agenda: <img src=x onerror=alert\(1\)> the event bus\. Notes: https:\/\/docs\.example\.com\/bus\?x=1\.$/);
  assert.deepEqual(card.querySelectorAll('.md-link').map((n) => text(n)), ['https://docs.example.com/bus?x=1']);
  assert.deepEqual(card.querySelectorAll('.cal-people li').map((li) => [...li.childNodes].map(text)), [
    ['Niaj Nair organiser', 'niaj.nair@example.com', 'Accepted'],
    ['Frank Foster (you)', 'frank.foster@example.com', 'Maybe'],
    ['Olivia Owens optional', 'olivia.owens@example.com', 'Declined'],
  ]);
  assert.equal(text(card.querySelector('.cal-detail-join .cal-join')), 'Join on Zoom');
  page.fire(page.document.body, 'keydown', { key: 'Escape' });
  await page.settle(20);
  assert.equal(page.$('#cal-event').hidden, true);
  assert.equal(page.document.activeElement.closest('[data-id]')?.dataset.id, 'arch@1', 'focus goes back to the meeting it came from');
});

test('with no address the view says how to find the secret iCal address and where to paste it', async () => {
  const page = await open({ data: (from, to) => ({ ...calendarData(from, to), set: false, events: [], fetchedAt: null }) });
  const setup = text(page.$('#cal-setup'));
  assert.match(setup, /Integrate calendar/);
  assert.match(setup, /Secret address in iCal format/);
  assert.match(setup, /Settings, under Standup, Calendar address/);
  assert.ok(!page.$('.cal-grid'));
  await click(page, page.$$('#cal-setup button').find((b) => text(b) === 'Paste it in Settings'));
  assert.equal(page.window.location.hash, '#settings');
});

test('the rail shows a quiet chip when the next meeting is close, never the red badge', async () => {
  const soon = snapshot({ calendar: { set: true, error: null, current: [], next: { ...EVENTS[2], start: NOW + 8 * MIN, end: NOW + 38 * MIN } } });
  const page = await open({ hash: 'overview', snap: soon });
  const chip = page.$('[data-count="calendar"]');
  assert.deepEqual([text(chip), chip.className, chip.hidden], ['in 8m', 'count', false]);
  page.show(snapshot({ calendar: { set: true, error: null, current: [], next: { ...EVENTS[2], start: NOW + 40 * MIN } } }), 'overview');
  assert.deepEqual([text(page.$('[data-count="calendar"]')), page.$('[data-count="calendar"]').hidden], ['', true]);
  page.show(snapshot({ calendar: { set: true, error: null, current: [{ ...EVENTS[2], start: NOW - 2 * MIN, end: NOW + 30 * MIN }], next: null } }), 'overview');
  assert.equal(text(page.$('[data-count="calendar"]')), 'now');
});

test('the Overview has a Next up card with Join, and none without a calendar', async () => {
  const live = snapshot({ calendar: { set: true, error: null, current: [{ ...EVENTS[2], start: NOW - 10 * MIN, end: NOW + 50 * MIN }], next: { ...EVENTS[1], start: NOW + 25 * MIN, end: NOW + 40 * MIN } } });
  const page = await open({ hash: 'overview', snap: live });
  const card = page.$$('#main .section').find((s) => /^Next up/.test(text(s.querySelector('h2'))));
  assert.deepEqual(card.querySelectorAll('.cal-next-line').map((n) => text(n.querySelector('.pill'))), ['now, until 11:30', 'in 25 min']);
  await click(page, card.querySelectorAll('.cal-join')[1]);
  assert.deepEqual(page.posts.at(-1), ['/api/open', { url: MEET.url }]);
  page.show(snapshot({ calendar: { set: false, error: null, current: [], next: null } }), 'overview');
  assert.equal(page.$$('#main .section').some((s) => /^Next up/.test(text(s.querySelector('h2')))), false);
});

test('Jump to offers Open the calendar, and Join the next meeting when it has a link', async () => {
  const page = await open({ hash: 'overview', snap: snapshot({ calendar: { set: true, error: null, current: [], next: { ...EVENTS[1], start: NOW + 5 * MIN, end: NOW + 20 * MIN } } }) });
  const entries = () => page.run('paletteEntries(keyContext())').filter((x) => x.id.startsWith('act-calendar'));
  assert.deepEqual(JSON.parse(JSON.stringify(entries().map((x) => [x.label, x.detail ?? null]))), [['Open the calendar', null], ['Join the next meeting', 'Team standup · in 5 min']]);
  entries().find((x) => x.id === 'act-calendar-join').run();
  await page.settle(20);
  assert.deepEqual(page.posts.at(-1), ['/api/open', { url: MEET.url }]);
  entries()[0].run();
  assert.equal(page.window.location.hash, '#calendar');
  page.show(snapshot({ calendar: { set: true, error: null, current: [], next: { ...EVENTS[4], start: NOW + 5 * MIN } } }), 'overview');
  assert.deepEqual(JSON.parse(JSON.stringify(entries().map((x) => x.label))), ['Open the calendar'], 'a meeting with no link has nothing to join');
});

test('Settings has a Calendar group: whether the shared address is set, and the banner lead time', async () => {
  const page = await open({ hash: 'settings' });
  const group = page.$('#calendar-settings');
  assert.equal(text(group.querySelector('.pill')), 'Set');
  assert.equal(text(group.querySelector('#cal-address-go')), 'Change it under Standup');
  const select = group.querySelector('#cal-remind');
  assert.deepEqual(select.querySelectorAll('option').map((o) => [o.getAttribute('value'), text(o), Boolean(o.selected)]), [
    ['0', 'Off', false], ['1', '1 min before', false], ['2', '2 min before', false], ['5', '5 min before', true], ['10', '10 min before', false], ['15', '15 min before', false],
  ]);
  select.value = '10';
  page.fire(select, 'change');
  await page.settle(20);
  assert.deepEqual(page.posts.at(-1), ['/api/calendar/settings', { remindMinutes: 10 }]);
});

test('a meeting reminder in focus is a toast with Join, and leaves the Needs you badge alone', async () => {
  const toast = { id: 'meeting:standup@1|1', title: 'In 4 min: Team standup', target: 'join:standup@1', join: MEET.url, kind: 'meeting', at: NOW };
  const page = await open({ hash: 'overview' });
  page.document.hasFocus = () => true;
  page.show(snapshot({ attention: { ...snapshot().attention, toasts: [toast] } }), 'overview');
  assert.deepEqual(page.$$('#toast button').map(text), ['Join']);
  assert.match(text(page.$('#toast')), /^In 4 min: Team standup/);
  assert.equal(page.$('[data-count="needs"]').classList.contains('pulse'), false);
  await click(page, page.$$('#toast button').find((b) => text(b) === 'Join'));
  assert.deepEqual(page.posts.at(-1), ['/api/open', { url: MEET.url }]);
});

const placed = (locale) => ({ zoneSet: locale.timeZone, machineZone: locale.timeZone, region: '', clock: '', hours: { from: '08:00', to: '18:00', workDays: [1, 2, 3, 4, 5] }, days: 'weekdays', ...locale });
const column = (page, day) => page.$$('.cal-col').find((n) => n.dataset.day === day);
const inColumn = (page, day) => column(page, day).querySelectorAll('.cal-event').map((n) => n.dataset.id);

test('a fresh install in New York lays the day out at New York times, written as its region writes them', async () => {
  const page = await open({ snap: snapshot({ locale: placed({ timeZone: 'America/New_York', region: 'en-US' }) }) });
  await click(page, page.$('#cal-layout-day'));
  assert.deepEqual(page.errors, []);
  assert.equal(text(block(page, 'standup@1').querySelector('.cal-when')), '4:30 AM', '09:30 in London');
  assert.equal(text(page.$('.cal-hours .cal-hour')), '4 AM', 'the day opens early enough to show it');
  assert.equal(style(block(page, 'standup@1'), 'top'), '28.0px', 'half an hour below 04:00');
  assert.match(text(block(page, 'pair-a@1').querySelector('.cal-when')), /^9:00 AM to 10:00 AM/);
});

test('in Tokyo a meeting late in the London afternoon moves to the next day\'s column', async () => {
  const page = await open({ snap: snapshot({ locale: placed({ timeZone: 'Asia/Tokyo', region: 'en-GB', clock: '24' }) }) });
  assert.ok(inColumn(page, '2026-11-18').includes('standup@1'));
  assert.equal(text(block(page, 'standup@1').querySelector('.cal-when')), '18:30');
  assert.ok(!inColumn(page, '2026-11-19').includes('thu@1'), '15:00 in London on Thursday');
  assert.ok(inColumn(page, '2026-11-20').includes('thu@1'), 'is midnight on Friday in Tokyo');
});

test('a Sunday to Thursday week starts on Sunday and leaves Friday and Saturday to the toggle', async () => {
  const page = await open({ snap: snapshot({ locale: placed({ timeZone: 'Europe/London', hours: { from: '08:00', to: '18:00', workDays: [0, 1, 2, 3, 4] } }) }) });
  assert.deepEqual(heads(page), ['2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19']);
  await click(page, page.$('#cal-weekend'));
  assert.deepEqual(heads(page), ['2026-11-15', '2026-11-16', '2026-11-17', '2026-11-18', '2026-11-19', '2026-11-20', '2026-11-21']);
});
