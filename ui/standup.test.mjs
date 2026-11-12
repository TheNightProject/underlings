import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { openPage } from './testkit.mjs';

const AT = '2026-11-10T08:00:00Z';

function snapshot() {
  return {
    generatedAt: AT, version: { ui: 1, lib: 1, worker: 1, loaded: 1 }, agents: [], artifacts: [],
    matrix: {
      available: true, running: false, me: 'frank', paused: false, holdSeconds: null, holdWhileReviewing: false,
      inbox: { fetchedAt: AT, loading: false, error: null, repoCount: 1, rows: [] },
      fullAuto: [], roster: [], watches: [], verdicts: {}, queue: [], runs: [], autoPasses: [],
    },
  };
}

const line = (id, tag, text, extra = {}) => ({ id, tag, text, ticked: true, ...extra });
const group = (id, title, lines, extra = {}) => ({ id, title, lines, error: null, note: null, ...extra });

function standup({ calendarSet = true, day = '2026-11-09' } = {}) {
  return {
    day, defaultDay: '2026-11-09', latest: '2026-11-10', generating: false, error: null, calendarSet, excludedRepos: ['tooling/dashboard', 'tooling/sandbox'],
    standup: {
      day, today: '2026-11-10', generatedAt: AT,
      sections: [
        { id: 'yesterday', title: 'Yesterday', day, groups: [
          group('merged', 'Merged', [line('merged:g/order-book!895', 'ABC-1234', "Merged order-book !895: require the billing:write scope on the invoice routes"), line('merged:g/atlas!9', '?', 'Merged atlas !9: tidy the panes', { unknown: true })]),
          group('moved', 'Tickets moved', [], { error: 'Jira did not answer acli within 30 s' }),
          calendarSet
            ? group('meetings', 'Meetings', [line('meetings:gbac@1', 'Meeting: GBAC Rundown', '14:15 with Heidi and Niaj'), line('meetings:lunch@1', 'Meeting: Lunch', '12:30', { ticked: false })])
            : group('meetings', 'Meetings', [], { note: "Add your calendar's secret iCal address in Settings, under Standup, to list your meetings." }),
          group('reviews', 'Reviews', [
            line('review:g/relay!1177', 'Review - ABC-4389', 'relay !1177, 6 comments, approved: narrow relay subscriptions'),
            line('review:g/desk-booking!2', 'Review - NoTicket', 'desk-booking !2, 5 comments, approved: use shared CI components'),
          ]),
        ] },
        { id: 'today', title: 'Today', day: '2026-11-10', groups: [
          group('open', 'Open MRs', [line('open:g/atlas!45', 'ABC-4262', 'Address the review on atlas !45 (changes requested)')]),
          group('today-meetings', 'Meetings', [line('today-meetings:arch@1', 'Meeting: Architecture discussion', '10:30 with Niaj and Judy')]),
        ] },
      ],
    },
  };
}

async function open({ data = standup(), settings = { calendarSet: true, excludedRepos: ['tooling/dashboard', 'tooling/sandbox'] }, hash = 'standup', answer = null } = {}) {
  const posts = [];
  const gets = [];
  const page = await openPage({
    respond(path, init) {
      const url = new URL(path, 'http://page');
      if (init?.method === 'POST') {
        const body = JSON.parse(init.body);
        posts.push([url.pathname, body]);
        return answer?.(url.pathname, body) ?? { ok: true, text: 'Done', ...settings };
      }
      if (url.pathname === '/api/standup') {
        gets.push(url.searchParams.get('day'));
        return typeof data === 'function' ? data(url.searchParams.get('day')) : data;
      }
      if (url.pathname === '/api/standup/settings') return settings;
      if (url.pathname === '/api/matrix/settings') return { rows: [], repos: { filter: '', matching: [], total: 0, perRefresh: 0, perMinute: 0 } };
      return null;
    },
  });
  page.show(snapshot(), hash);
  await page.settle(60);
  return Object.assign(page, { posts, gets });
}

const text = (node) => node?.textContent.replace(/\s+/g, ' ').trim();
const byId = (page, id) => page.document.getElementById(id);
const lineNode = (page, id) => page.$$('.standup-line').find((n) => n.dataset.line === id);

test('Standup sits under Work, after Tickets and before the Calendar, Email and Slack', async () => {
  const html = await readFile(new URL('../dashboard.html', import.meta.url), 'utf8');
  const work = html.slice(html.indexOf('<h2>Work</h2>'), html.indexOf('</div>', html.indexOf('<h2>Work</h2>')));
  assert.deepEqual([...work.matchAll(/href="#([\w-]+)"/g)].map((m) => m[1]), ['tickets', 'standup', 'calendar', 'email', 'slack']);
});

test('each section lists its groups, a box per line ticked as the worker says, and a line with no ticket stands out', async () => {
  const page = await open();
  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.$$('.standup-section').map((s) => s.dataset.section), ['yesterday', 'today']);
  assert.match(text(page.$('.standup-section h2')), /^Yesterday\s*Monday 9 November$/);
  assert.equal(byId(page, 'sl-merged:g/order-book!895').hasAttribute('checked'), true);
  assert.equal(byId(page, 'sl-meetings:lunch@1').hasAttribute('checked'), false);
  assert.equal(lineNode(page, 'merged:g/atlas!9').classList.contains('unknown'), true);
  assert.equal(lineNode(page, 'meetings:lunch@1').classList.contains('off'), true);
  assert.match(text(page.$('[data-group="moved"]')), /Jira did not answer acli within 30 s/);
  const meetings = byId(page, 'sg-meetings');
  assert.deepEqual([meetings.hasAttribute('checked'), meetings.getAttribute('aria-checked'), meetings.indeterminate], [false, 'mixed', true]);
});

test('Copy for Slack copies the ticked lines in the shape of the post', async () => {
  const page = await open();
  const copied = [];
  page.window.navigator.clipboard = { writeText: async (value) => { copied.push(value); } };
  page.$$('.head button').find((b) => text(b) === 'Copy for Slack').click();
  await page.settle(20);
  assert.equal(copied[0], [
    'Morning',
    'Yesterday:',
    "- [ABC-1234] Merged order-book !895: require the billing:write scope on the invoice routes",
    '- [?] Merged atlas !9: tidy the panes',
    '- [Meeting: GBAC Rundown] 14:15 with Heidi and Niaj',
    '- [Review - ABC-4389] relay !1177, 6 comments, approved: narrow relay subscriptions',
    '- [Review - NoTicket] desk-booking !2, 5 comments, approved: use shared CI components',
    'Today:',
    '- [ABC-4262] Address the review on atlas !45 (changes requested)',
    '- [Meeting: Architecture discussion] 10:30 with Niaj and Judy',
  ].join('\n'));
  assert.match(text(page.$('#toast')), /Copied 7 lines for Slack/);
  assert.equal(text(page.$('.standup-preview pre')), text({ textContent: copied[0] }));
});

test('unticking a line, or a whole group, tells the worker and leaves it out of the copy', async () => {
  const kept = {};
  const view = () => {
    const data = standup();
    for (const l of data.standup.sections.flatMap((x) => x.groups).flatMap((g) => g.lines)) l.ticked = kept[l.id] ?? l.ticked;
    return data;
  };
  const page = await open({ data: view, answer: (path, body) => {
    for (const id of body.ids) kept[id] = body.ticked;
    return view();
  } });
  page.fire(byId(page, 'sl-merged:g/order-book!895'), 'change');
  await page.settle(20);
  page.fire(byId(page, 'sg-reviews'), 'change');
  await page.settle(20);
  assert.deepEqual(page.posts, [
    ['/api/standup/tick', { day: '2026-11-09', ids: ['merged:g/order-book!895'], ticked: false }],
    ['/api/standup/tick', { day: '2026-11-09', ids: ['review:g/relay!1177', 'review:g/desk-booking!2'], ticked: false }],
  ]);
  const preview = page.$('.standup-preview pre').textContent;
  assert.doesNotMatch(preview, /order-book !895|Review -/);
  assert.match(preview, /tidy the panes/);
});

test('a part-ticked group ticks every line when its box is clicked', async () => {
  const page = await open();
  page.fire(byId(page, 'sg-meetings'), 'change');
  await page.settle(20);
  assert.deepEqual(page.posts.at(-1), ['/api/standup/tick', { day: '2026-11-09', ids: ['meetings:gbac@1', 'meetings:lunch@1'], ticked: true }]);
});

test('the day picker reads the day picked, steps over weekends, and offers the way back', async () => {
  const page = await open({ data: (day) => standup({ day: day ?? '2026-11-09' }) });
  assert.deepEqual(page.gets, [null]);
  page.$('#standup-before').click();
  await page.settle(40);
  assert.equal(page.gets.at(-1), '2026-11-06', 'Monday steps back to Friday');
  assert.match(text(page.$('.standup-day')), /Back to Monday 9 November/);
  page.$('#standup-after').click();
  await page.settle(40);
  assert.equal(page.gets.at(-1), '2026-11-09');
  page.$('#standup-after').click();
  await page.settle(40);
  assert.equal(page.gets.at(-1), '2026-11-10', 'today so far');
  assert.equal(page.$('#standup-after').disabled, true, 'nothing after today');
  page.$('#standup-day').value = '2026-11-03';
  page.fire(page.$('#standup-day'), 'change');
  await page.settle(40);
  assert.equal(page.gets.at(-1), '2026-11-03');
});

test('Generate asks the worker again for the day shown, and says while it works', async () => {
  const page = await open({ data: { ...standup(), generating: true } });
  assert.equal(page.$('#standup-generate').disabled, true);
  assert.match(text(page.$('#main')), /Working out Monday 9 November from GitLab, Jira and your calendar/);
  const idle = await open();
  idle.$('#standup-generate').click();
  await idle.settle(40);
  assert.deepEqual(idle.posts, [['/api/standup/generate', { day: '2026-11-09' }]]);
});

test('with no calendar address, the meetings say how to add one and link to Settings', async () => {
  const page = await open({ data: standup({ calendarSet: false }) });
  const meetings = page.$('[data-group="meetings"]');
  assert.match(text(meetings), /secret iCal address in Settings/);
  assert.equal(meetings.querySelector('a.fix-link').getAttribute('href'), '#settings');
});

test('a line with no ticket can be given one', async () => {
  const page = await open();
  const input = byId(page, 'sf-merged:g/atlas!9');
  input.value = 'ABC-4225';
  page.fire(input, 'input', { target: input });
  page.fire(input, 'keydown', { key: 'Enter' });
  await page.settle(20);
  assert.deepEqual(page.posts, [['/api/standup/tag', { day: '2026-11-09', id: 'merged:g/atlas!9', ticket: 'ABC-4225' }]]);
});

test('Settings takes the calendar address as hidden text, and shows only whether it is set', async () => {
  const page = await open({ hash: 'settings', settings: { calendarSet: true, excludedRepos: ['tooling/dashboard', 'tooling/sandbox'] } });
  const group = page.$('#standup-settings');
  assert.match(text(group), /Calendar address\s*Set/);
  const address = page.$('#standup-address');
  assert.equal(address.getAttribute('type'), 'password');
  assert.equal(address.getAttribute('value'), '');
  assert.equal(page.$('#standup-repos').getAttribute('value'), 'tooling/dashboard, tooling/sandbox');
  address.value = 'https://calendar.google.com/calendar/ical/x/private-y/basic.ics';
  page.fire(address, 'input', { target: address });
  await page.settle(20);
  page.$$('#standup-settings button').find((b) => text(b) === 'Save').click();
  await page.settle(40);
  assert.deepEqual(page.posts, [['/api/standup/settings', { calendarAddress: 'https://calendar.google.com/calendar/ical/x/private-y/basic.ics' }]]);
  assert.equal(page.$('#standup-address').getAttribute('value'), '', 'the field empties once it is saved');
  const repos = page.$('#standup-repos');
  repos.value = 'tooling/dashboard';
  page.fire(repos, 'input', { target: repos });
  page.fire(page.$('#standup-repos'), 'keydown', { key: 'Enter' });
  await page.settle(40);
  assert.deepEqual(page.posts.at(-1), ['/api/standup/settings', { excludedRepos: 'tooling/dashboard' }]);
});

test('a settings read that fails is not tried again until the page state moves', async () => {
  const page = await open({ hash: 'settings', settings: null });
  await page.settle(80);
  assert.equal(page.requested.filter((path) => path === '/api/standup/settings').length, 1);
  assert.match(text(page.$('#standup-settings')), /Could not read the standup settings/);
});
