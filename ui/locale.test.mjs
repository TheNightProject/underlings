import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openPage, LONDON_LOCALE } from './testkit.mjs';

const AT = '2026-11-11T13:05:09Z';

function snapshot(locale = LONDON_LOCALE) {
  return {
    generatedAt: AT, version: { ui: 1, lib: 1, worker: 1, loaded: 1 }, agents: [], artifacts: [], locale,
    attention: { cards: [], agents: [], system: [], email: [], slack: [], count: 0, prefs: {}, toasts: [], offers: [] },
    calendar: { set: false, error: null, fetchedAt: null, current: [], next: null },
    matrix: { available: false, error: 'starting' },
  };
}

async function open(locale, hash = 'overview') {
  const posts = [];
  const page = await openPage({
    respond(path, init) {
      const url = new URL(path, 'http://page');
      if (init?.method !== 'POST') return url.pathname === '/api/matrix/settings' ? { rows: [], repos: null } : null;
      const body = JSON.parse(init.body);
      posts.push([url.pathname, body]);
      return { ok: true, text: 'Saved', ...locale, ...body };
    },
  });
  page.show(snapshot(locale), hash);
  await page.settle(40);
  return Object.assign(page, { posts });
}

// Each instant is a clock change in London, a summer evening or a winter one, so a day either side would show.
const INSTANTS = ['2026-03-29T00:59:00Z', '2026-03-29T01:00:00Z', '2026-10-25T00:30:00Z', '2026-10-25T01:30:00Z', '2026-07-01T23:30:00Z', '2026-12-31T23:59:59Z', AT];

test('with a London locale saved, every date, time and number the page writes is what the hard-coded London formats wrote', async () => {
  const page = await open(LONDON_LOCALE);
  const both = (now, before) => page.run(`JSON.stringify(${JSON.stringify(INSTANTS)}.map((t) => [${now}, ${before}]))`);
  const same = (now, before) => JSON.parse(both(now, before)).forEach(([a, b], i) => assert.equal(a, b, `${now} at ${INSTANTS[i]}`));
  same('whenText(t)', "new Date(t).toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', timeZone: 'Europe/London' })");
  same('timeText(t)', "new Date(t).toLocaleTimeString('en-GB', { timeZone: 'Europe/London', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })");
  same('timeText(t, true)', "new Date(t).toLocaleTimeString('en-GB')");
  same('dateText(t)', "new Date(t).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', timeZone: 'Europe/London' })");
  same('fullText(t)', "new Date(t).toLocaleString('en-GB')");
  same('wallOf(t).day', "new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/London' }).format(new Date(t))");
  same("dayName(t.slice(0, 10))", "new Date(t.slice(0, 10) + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'UTC' })");
  same("releaseDate(t.slice(0, 10))", "new Date(t.slice(0, 10) + 'T12:00:00Z').toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' })");
  same("calDayName(t.slice(0, 10), true)", "new Date(t.slice(0, 10) + 'T12:00:00Z').toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric' })");
  same('numberText(Date.parse(t))', "Date.parse(t).toLocaleString('en-GB')");
  assert.deepEqual(JSON.parse(page.run('JSON.stringify([0, 8, 13, 23].map(hourText))')), ['00:00', '08:00', '13:00', '23:00']);
  assert.equal(page.$('#health').textContent.includes('Updated 13:05:09'), true);
});

test('a fresh install writes in its own zone, region and clock, and a day of the year stays that day', async () => {
  const page = await open({ ...LONDON_LOCALE, timeZone: 'America/New_York', region: 'en-US', clock: '' });
  assert.deepEqual(JSON.parse(page.run(`JSON.stringify([whenText('${AT}'), timeText('${AT}'), dateText('2026-07-01T02:00:00Z'), dayName('2026-11-11'), numberText(1234.5), hourText(13), wallOf('2026-07-01T02:00:00Z').day])`)),
    ['Wed, Nov 11, 8:05 AM', '8:05 AM', 'Jun 30', 'Wednesday, November 11', '1,234.5', '1 PM', '2026-06-30']);
  const tokyo = await open({ ...LONDON_LOCALE, timeZone: 'Asia/Tokyo', clock: '12' });
  assert.deepEqual(JSON.parse(tokyo.run(`JSON.stringify([timeText('${AT}'), wallOf('${AT}').day, dayName('2026-11-11')])`)), ['10:05 pm', '2026-11-11', 'Wednesday 11 November']);
});

test('the Standup steps over the days you do not work', async () => {
  const page = await open({ ...LONDON_LOCALE, hours: { ...LONDON_LOCALE.hours, workDays: [0, 1, 2, 3, 4] } });
  assert.deepEqual(JSON.parse(page.run("JSON.stringify([workingDayFrom('2026-11-05', 1), workingDayFrom('2026-11-08', -1)])")), ['2026-11-08', '2026-11-05']);
  const frank = await open(LONDON_LOCALE);
  assert.deepEqual(JSON.parse(frank.run("JSON.stringify([workingDayFrom('2026-11-06', 1), workingDayFrom('2026-11-09', -1)])")), ['2026-11-09', '2026-11-06']);
});

test('Settings shows the zone in use and where it came from, and each choice saves on its own', async () => {
  const page = await open(LONDON_LOCALE, 'settings');
  assert.deepEqual(page.$$('#main .settings-group h2').map((h) => h.textContent).filter((t) => ['Time and region', 'Working hours'].includes(t)), ['Time and region', 'Working hours']);
  const hints = page.$$('#locale-settings .hint').map((h) => h.textContent);
  assert.match(hints[0], /Blank follows this Mac, now in Europe\/London\./);
  const today = new Intl.DateTimeFormat('en-GB', { weekday: 'short', day: 'numeric', month: 'short', timeZone: 'Europe/London' }).format(new Date());
  assert.match(hints[1], new RegExp(`Now written as ${today}, \\d\\d:\\d\\d and 1,234\\.5\\.`));
  assert.equal(page.$('#locale-region').getAttribute('value'), 'en-GB');
  assert.equal(page.$('#locale-clock-24').getAttribute('aria-pressed'), 'true');
  const zone = page.$('#locale-timeZone');
  zone.value = 'Asia/Kolkata';
  page.fire(zone, 'input');
  page.fire(page.$('#locale-timeZone'), 'keydown', { key: 'Enter' });
  await page.settle(40);
  page.$('#locale-clock-12').click();
  await page.settle(40);
  page.$('#hours-day-0').click();
  await page.settle(40);
  const to = page.$('#hours-to');
  to.value = '17:30';
  page.fire(to, 'change');
  await page.settle(40);
  assert.deepEqual(page.posts, [['/api/locale', { timeZone: 'Asia/Kolkata' }], ['/api/locale', { clock: '12' }], ['/api/locale', { workDays: [1, 2, 3, 4, 5, 0] }], ['/api/locale', { to: '17:30' }]]);
  assert.equal(page.$('#hours-day-1').getAttribute('aria-pressed'), 'true');
});

test('a chosen zone says so beside this Mac\'s, and the last working day cannot be turned off', async () => {
  const page = await open({ ...LONDON_LOCALE, timeZone: 'America/New_York', zoneSet: 'America/New_York', hours: { ...LONDON_LOCALE.hours, workDays: [3] } }, 'settings');
  assert.match(page.$$('#locale-settings .hint')[0].textContent, /Times are shown in America\/New_York\. This Mac is in Europe\/London\./);
  assert.equal(page.$('#hours-day-3').hasAttribute('disabled'), true);
});
