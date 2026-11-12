import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openPage } from './testkit.mjs';

const NOW = Date.parse('2026-11-18T09:29:18Z');
const at = (clock) => Date.parse(`2026-11-18T${clock}:00Z`);
const MEET = { url: 'https://meet.google.com/abc-defg-hij', kind: 'meet' };
const ZOOM = { url: 'https://example.zoom.us/j/845', kind: 'zoom' };
const card = (key, title, from, to, extra = {}) => ({ key, title, start: at(from), end: at(to), join: null, location: null, response: 'accepted', people: [], ...extra });
const STANDUP = card('standup@1|1', 'Team standup', '09:30', '09:45', { join: MEET, people: ['Judy Marsh', 'Niaj Lowe', 'Quinn Doyle', 'Uma Vega', 'Olivia Park'] });

function snapshot(meetings) {
  return {
    generatedAt: new Date(NOW).toISOString(), version: { ui: 1, lib: 1, worker: 1, loaded: 1 }, agents: [], artifacts: [],
    attention: { cards: [], agents: [], system: [], email: [], slack: [], count: 0, prefs: {}, toasts: [], offers: [] },
    calendar: { set: true, error: null, fetchedAt: new Date(NOW).toISOString(), current: [], next: null, overlay: meetings ? { meetings } : null },
    matrix: { available: false, running: false, me: 'frank', paused: false, inbox: { rows: [] }, fullAuto: [], roster: [], watches: [], verdicts: {}, queue: [], runs: [], autoPasses: [] },
  };
}

class FixedDate extends Date {
  constructor(...args) {
    super(...(args.length ? args : [FixedDate.now()]));
  }

  static now() {
    return NOW;
  }
}

const SETTINGS = { remindMinutes: 5, leads: [0, 1, 2, 5, 10, 15], calendarSet: true, overlay: true, overlayLead: 60, overlayWhich: 'all', overlayLeads: [30, 60, 120, 300], overlayWhichOptions: ['all', 'join', 'accepted'], overlayHere: true };

async function open({ meetings = [STANDUP], search = '?t=test&window=meeting', hash = 'overview', settings = SETTINGS } = {}) {
  const posts = [];
  const page = await openPage({
    search,
    globals: { Date: class extends FixedDate {} },
    respond(path, init) {
      const url = new URL(path, 'http://page');
      if (init?.method === 'POST') {
        posts.push([url.pathname, JSON.parse(init.body)]);
        return { ok: true, text: 'Done', ...settings, ...JSON.parse(init.body) };
      }
      if (url.pathname === '/api/calendar/settings') return settings;
      if (url.pathname === '/api/calendar') return { from: '2026-11-16', to: '2026-11-20', set: true, events: [], fetchedAt: null };
      return null;
    },
  });
  page.show(snapshot(meetings), hash);
  await page.settle(40);
  return Object.assign(page, { posts });
}

const text = (node) => node?.textContent.replace(/\s+/g, ' ').trim();
const parts = (node) => node.childNodes.map(text).filter(Boolean);
const press = async (page, key) => {
  page.fire(page.document.body, 'keydown', { key });
  await page.settle(20);
};

test('the reminder window draws the meeting and nothing of the dashboard, and never says it has focus', async () => {
  const page = await open();
  assert.deepEqual(page.errors, []);
  assert.ok(page.document.body.classList.contains('meeting-window'));
  assert.equal(page.$('#main').childNodes.length, 0, 'the overview is not built behind it');
  const shown = page.$('.mo-card');
  assert.equal(text(shown.querySelector('.mo-when')), 'Starts in 0:42');
  assert.equal(text(shown.querySelector('.mo-title')), 'Team standup');
  assert.deepEqual(parts(shown.querySelector('.mo-facts')), ['09:30 to 09:45', 'Google Meet']);
  assert.deepEqual(shown.querySelectorAll('.mo-face').map(text), ['JM', 'NL', 'QD', 'UV', 'OP']);
  assert.equal(text(shown.querySelector('.mo-names')), 'with Judy, Niaj and 3 others');
  assert.deepEqual(parts(shown.querySelector('.mo-join')), ['Join on Google Meet', 'return']);
  assert.equal(page.document.activeElement.className, 'mo-join', 'Join has the focus, so Enter joins');
  page.document.hasFocus = () => true;
  page.run('presenceStart()');
  await page.settle(20);
  assert.ok(!page.requested.some((path) => path.startsWith('/api/attention/presence') || path.startsWith('/api/stats')), page.requested.join(' '));
});

test('more people than fit show as a count, and a single name reads plainly', async () => {
  const many = card('k|1', 'All hands', '09:30', '10:30', { people: ['Abe Brooks', 'Ben Ode', 'Cara Lin', 'Dev Rao', 'Eve Moss', 'Finn Ahl', 'Gus Tan'] });
  const page = await open({ meetings: [many] });
  assert.deepEqual(page.$$('.mo-face').map(text), ['AB', 'BO', 'CL', 'DR', '+3']);
  assert.equal(text(page.$('.mo-names')), 'with Abe, Ben and 5 others');
  const one = await open({ meetings: [card('k|2', 'Pairing', '09:30', '10:30', { people: ['Judy Marsh'] })] });
  assert.equal(text(one.$('.mo-names')), 'with Judy');
});

test('Join, Enter, Snooze and Esc each ask the worker to act on the meeting shown', async () => {
  const page = await open();
  page.$('.mo-join').click();
  await page.settle(20);
  assert.deepEqual(page.posts.at(-1), ['/api/calendar/overlay', { act: 'join', key: 'standup@1|1' }]);
  const again = await open();
  await press(again, 'Enter');
  assert.deepEqual(again.posts, [['/api/calendar/overlay', { act: 'join', key: 'standup@1|1' }]]);
  const esc = await open();
  await press(esc, 'Escape');
  assert.deepEqual(esc.posts, [['/api/calendar/overlay', { act: 'dismiss' }]]);
  const later = await open();
  assert.equal(text(later.$('#mo-snooze')), 'Snooze until 09:30');
  later.$('#mo-snooze').click();
  await later.settle(20);
  assert.deepEqual(later.posts, [['/api/calendar/overlay', { act: 'snooze' }]]);
});

test('the keys of the dashboard stay out of the reminder window, and so do a goto from the worker and the Claude panel', async () => {
  const page = await open();
  assert.equal(page.run('claudePanel.open = true; claudePanelShown()'), false);
  await press(page, '?');
  assert.equal(page.run('keyState.overlay'), null, 'no shortcuts sheet');
  await press(page, 'g');
  await press(page, 's');
  page.run('goTo("settings")');
  assert.equal(page.window.location.hash, '#overview');
  assert.deepEqual(page.posts, []);
});

test('two meetings at once share one countdown, each with a Join of its own', async () => {
  const pair = [card('a|1', 'Pairing with Judy', '09:30', '10:30', { join: MEET }), card('b|1', 'Design review', '09:30', '10:15', { join: ZOOM, location: 'Room 3', response: 'tentative' })];
  const page = await open({ meetings: pair });
  assert.deepEqual(page.$$('.mo-card').map((n) => text(n.querySelector('.mo-title'))), ['Pairing with Judy', 'Design review']);
  assert.deepEqual(page.$$('.mo-when').map(text), ['Starts in 0:42'], 'one countdown above both');
  assert.deepEqual(parts(page.$$('.mo-card')[1].querySelector('.mo-facts')), ['09:30 to 10:15', 'Room 3 · Zoom', 'You said maybe']);
  page.$$('.mo-join')[1].click();
  await page.settle(20);
  assert.deepEqual(page.posts, [['/api/calendar/overlay', { act: 'join', key: 'b|1' }]]);
  const apart = await open({ meetings: [pair[0], { ...pair[1], start: at('09:31') }] });
  assert.deepEqual(apart.$$('.mo-card .mo-when').map(text), ['Starts in 0:42', 'Starts in 1:42'], 'starting at different times, each counts down its own');
});

test('with no join link, Join becomes Open in the calendar', async () => {
  const page = await open({ meetings: [card('q|1', 'Quarterly planning', '09:30', '11:00', { location: 'Boardroom' })] });
  assert.deepEqual(parts(page.$('.mo-join')), ['Open in the calendar', 'return']);
  assert.deepEqual(parts(page.$('.mo-facts')), ['09:30 to 11:00', 'Boardroom']);
  await press(page, 'Enter');
  assert.deepEqual(page.posts, [['/api/calendar/overlay', { act: 'calendar', key: 'q|1' }]]);
});

test('the countdown runs on and says when it started, and Snooze then waits a minute', async () => {
  const page = await open();
  page.window.Date.now = () => at('09:30') + 20_000;
  page.run('meetingTick()');
  assert.equal(text(page.$('.mo-when')), 'Starting now');
  page.window.Date.now = () => at('09:31') + 5000;
  page.run('meetingTick()');
  assert.equal(text(page.$('.mo-when')), 'Started 1 min ago');
  assert.ok(page.$('.mo-when').classList.contains('started'));
  assert.equal(text(page.$('#mo-snooze')), 'Snooze 1 min');
});

test('a failed act says so and leaves the buttons working', async () => {
  const page = await open();
  page.window.fetch = async () => ({ ok: false, status: 500, text: async () => 'the worker is busy', json: async () => null });
  await press(page, 'Escape');
  assert.equal(text(page.$('.mo-error')), 'That did not work: the worker is busy');
  assert.ok(!page.$('#meeting-overlay').classList.contains('leaving'));
});

test('the dashboard itself draws no reminder, even when one is showing', async () => {
  const page = await open({ search: '?t=test' });
  assert.equal(page.$('#meeting-overlay') === null, true);
  assert.ok(page.$('#main').childNodes.length > 0);
});

test('Settings has the full-screen reminder in the Calendar group: on or off, how long before and for which meetings', async () => {
  const page = await open({ search: '?t=test', hash: 'settings' });
  const group = page.$('#calendar-settings');
  assert.equal(group.querySelector('#cal-overlay').getAttribute('aria-checked'), 'true');
  const options = (id) => group.querySelector(id).querySelectorAll('option').map((o) => [o.getAttribute('value'), text(o), Boolean(o.selected)]);
  assert.deepEqual(options('#cal-overlay-lead'), [['30', '30 s before', false], ['60', '1 min before', true], ['120', '2 min before', false], ['300', '5 min before', false]]);
  assert.deepEqual(options('#cal-overlay-which'), [['all', 'Every meeting I have not declined', true], ['join', 'Only ones with a join link', false], ['accepted', 'Only ones I accepted', false]]);
  assert.match(text(group), /Covers every display, full-screen apps included/);
  const lead = group.querySelector('#cal-overlay-lead');
  lead.value = '30';
  page.fire(lead, 'change');
  await page.settle(20);
  const which = page.$('#cal-overlay-which');
  which.value = 'join';
  page.fire(which, 'change');
  await page.settle(20);
  page.$('#cal-overlay').click();
  await page.settle(20);
  assert.deepEqual(page.posts, [['/api/calendar/settings', { overlayLead: 30 }], ['/api/calendar/settings', { overlayWhich: 'join' }], ['/api/calendar/settings', { overlay: false }]]);
  assert.equal(page.$('#cal-remind').value ?? page.$('#cal-remind').querySelectorAll('option').find((o) => o.selected).getAttribute('value'), '5', 'the banner keeps its own lead time');
});

test('in the Orca plugin Settings says only the app can cover the screen, and the banner reminds instead', async () => {
  const page = await open({ search: '?t=test', hash: 'settings', settings: { ...SETTINGS, overlayHere: false } });
  assert.match(text(page.$('#calendar-settings')), /Only the Underlings app can cover the screen, so here in Orca the banner above is your reminder/);
});
