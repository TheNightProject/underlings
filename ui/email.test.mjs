import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openPage } from './testkit.mjs';

const AT = '2026-11-10T10:00:00Z';
const LINK = (id) => 'https://mail.google.com/mail/?authuser=frank@example.com#all/' + id;

function snapshot(attention = {}) {
  return {
    generatedAt: AT, version: { ui: 1, lib: 1, worker: 1, loaded: 1 }, agents: [], artifacts: [], claude: { available: true, tools: true, current: null, history: [], titles: {} },
    matrix: {
      available: true, running: false, me: 'frank', paused: false, holdSeconds: null, holdWhileReviewing: false,
      inbox: { fetchedAt: AT, loading: false, error: null, repoCount: 1, rows: [] },
      fullAuto: [], roster: [], watches: [], verdicts: {}, queue: [], runs: [], autoPasses: [],
    },
    attention: { cards: [], agents: [], system: [], email: [], count: 0, prefs: {}, toasts: [], offers: [], ...attention },
  };
}

const thread = (id, extra = {}) => ({
  id, link: LINK(id), from: { name: 'Victor Vale', address: 'victor@example.com' }, subject: 'Budget for the offsite', snippet: 'Could you sign off the budget by Friday?',
  receivedAt: '2026-11-10T09:00:00.000Z', kind: 'asked', reason: 'Victor wants the offsite budget signed off by Friday.', handled: false, ticket: null, ...extra,
});

function emailView(extra = {}) {
  return {
    enabled: true, needsYou: true, window: { from: '08:00', to: '18:00', everyMinutes: 30, lookBackDays: 7 }, fetching: false, error: null, fetchedAt: '2026-11-10T09:55:00Z',
    read: 42, lastRun: { at: '2026-11-10T09:55:00Z', ms: 23400, costUsd: 0.0123, ok: true }, account: { email: 'frank@example.com', org: 'Example Ltd' }, model: 'haiku', lastEpic: 'ABC-3789',
    threads: [
      thread('a1b2c3d4e5f60001'),
      thread('a1b2c3d4e5f60002', { from: { name: 'Wendy West', address: 'wendy@example.org' }, subject: 'Hiring panel', snippet: '', kind: 'waiting', reason: 'Wendy is waiting to hear if you can sit on the panel.', receivedAt: '2026-11-10T08:15:00.000Z' }),
      thread('a1b2c3d4e5f60005', { from: { name: '', address: 'walter@example.com' }, subject: 'Invitation: Roadmap review', kind: 'invite', reason: 'Walter invited you to the roadmap review.', receivedAt: '2026-11-09T16:30:00.000Z', handled: true }),
    ],
    ...extra,
  };
}

const SETTINGS = { enabled: true, needsYou: true, from: '08:00', to: '18:00', skip: ['news@example.com'], defaults: {} };

async function open({ data = emailView(), hash = 'email', attention, settings = SETTINGS } = {}) {
  const posts = [];
  const page = await openPage({
    respond(path, init) {
      const url = new URL(path, 'http://page');
      if (init?.method === 'POST') {
        const body = JSON.parse(init.body);
        posts.push([url.pathname, body]);
        if (url.pathname === '/api/email/ticket-draft') return { summary: 'Offsite: sign off the budget', description: 'Problem\nA.\n\nFix\nB.\n\nAcceptance criteria\n- C.' };
        if (url.pathname === '/api/email/ticket') return { ok: true, text: 'Raised ABC-4500', ticket: { key: 'ABC-4500', url: 'https://example.atlassian.net/browse/ABC-4500', summary: body.summary } };
        if (url.pathname === '/api/email/reply') return { ok: true, handle: 'claude:chat-1', text: 'Claude is reading the thread in a new chat' };
        if (url.pathname === '/api/email/settings') return { ok: true, text: 'Saved', ...settings, ...body };
        return { ok: true, text: 'Done' };
      }
      if (url.pathname === '/api/email') return typeof data === 'function' ? data() : data;
      if (url.pathname === '/api/email/settings') return settings;
      if (url.pathname === '/api/qa/settings') return { jql: 'x', defaultJql: 'x' };
      if (url.pathname === '/api/standup/settings') return { calendarSet: false, excludedRepos: [] };
      if (url.pathname === '/api/matrix/settings') return { rows: [], repos: { filter: '', matching: [], total: 0, perRefresh: 0, perMinute: 0 } };
      if (url.pathname === '/api/agents/conversation') return { handle: 'claude:chat-1', entries: [], state: 'working', alive: true, partial: null, pending: null };
      return null;
    },
  });
  page.show(snapshot(attention), hash);
  await page.settle(60);
  return Object.assign(page, { posts });
}

const text = (node) => node?.textContent.replace(/\s+/g, ' ').trim();
const rows = (page) => page.$$('#main .email-thread');
const buttons = (row) => row.querySelector('.actions').querySelectorAll('button').map((b) => text(b));
const tap = (row, label) => row.querySelectorAll('button').find((b) => text(b) === label).click();

test('Email sits under Work and lists what needs you, newest first, each with why, who and a snippet, handled ones apart', async () => {
  const page = await open();
  assert.deepEqual(page.errors, []);
  assert.equal(text(page.$('#main .head h1')), 'Email');
  assert.deepEqual(rows(page).map((r) => r.dataset.thread), ['a1b2c3d4e5f60001', 'a1b2c3d4e5f60002']);
  const [first, second] = rows(page);
  assert.equal(text(first.querySelector('.pill')), 'asks you');
  assert.equal(text(first.querySelector('.title')), 'Budget for the offsite');
  assert.match(text(first.querySelector('.meta')), /^Victor Vale <victor@example\.com> · \d+ (min|h|d) ago$/);
  assert.equal(text(first.querySelector('.email-reason')), 'Victor wants the offsite budget signed off by Friday.');
  assert.equal(text(first.querySelector('.email-snippet')), 'Could you sign off the budget by Friday?');
  assert.equal(second.querySelector('.email-snippet'), null, 'no empty snippet');
  assert.deepEqual(buttons(first), ['Open in Gmail', 'Action with agent', 'Handled', 'Draft a reply with Claude', 'Make a ticket']);
  assert.deepEqual(page.$$('#main .chips .chip').map(text), ['Needs you (2)', 'Handled (1)']);
  page.$('#email-show-handled').click();
  assert.deepEqual(rows(page).map((r) => r.dataset.thread), ['a1b2c3d4e5f60005']);
  assert.equal(text(rows(page)[0].querySelector('.meta')).split(' · ')[0], 'walter@example.com');
  assert.deepEqual(buttons(rows(page)[0]).slice(0, 3), ['Open in Gmail', 'Action with agent', 'Not handled']);
});

test('it says which Claude account reads it, with what, when, how long the read took and what it cost', async () => {
  const page = await open();
  const about = text(page.$('#email-about'));
  assert.match(about, /^Claude Code reads it with Haiku as frank@example\.com \(Example Ltd\), every 30 minutes on weekdays from 08:00 to 18:00/);
  assert.match(about, /42 threads from the last 7 days, 2 needing you\./);
  assert.match(about, /The last read took 23 s and cost \$0\.0123\./);
});

test('Open in Gmail goes to the browser, Handled marks it here only, with what the page saw, and Refresh reads again', async () => {
  const page = await open();
  tap(rows(page)[0], 'Open in Gmail');
  tap(rows(page)[0], 'Handled');
  page.$('#email-refresh').click();
  await page.settle(60);
  assert.deepEqual(page.posts, [
    ['/api/open', { url: LINK('a1b2c3d4e5f60001') }],
    ['/api/email/handled', { id: 'a1b2c3d4e5f60001', handled: true, receivedAt: '2026-11-10T09:00:00.000Z' }],
    ['/api/email/refresh', {}],
  ]);
});

test('Draft a reply with Claude hands the thread to the panel\'s chat, with what the page saw of it, and opens the panel', async () => {
  const page = await open();
  tap(rows(page)[0], 'Draft a reply with Claude');
  await page.settle(60);
  assert.deepEqual(page.posts[0], ['/api/email/reply', { id: 'a1b2c3d4e5f60001', expect: { handle: null, pending: null } }]);
  assert.equal(page.$('#claude-panel')?.hidden, false, 'the panel is open');
});

test('Make a ticket drafts with Claude, fills the form with the last epic, and creates only on the second click', async () => {
  const page = await open();
  tap(rows(page)[0], 'Make a ticket');
  await page.settle(60);
  assert.equal(page.$('#email-ticket-summary-a1b2c3d4e5f60001').getAttribute('value'), 'Offsite: sign off the budget');
  assert.equal(page.$('#email-ticket-epic-a1b2c3d4e5f60001').getAttribute('value'), 'ABC-3789');
  const create = () => page.document.getElementById('g-email-ticket:a1b2c3d4e5f60001');
  create().click();
  assert.equal(text(create()), 'Create a ticket under ABC-3789?');
  assert.equal(page.posts.filter(([path]) => path === '/api/email/ticket').length, 0, 'one click only arms it');
  create().click();
  await page.settle(60);
  assert.deepEqual(page.posts.at(-1), ['/api/email/ticket', { id: 'a1b2c3d4e5f60001', summary: 'Offsite: sign off the budget', description: 'Problem\nA.\n\nFix\nB.\n\nAcceptance criteria\n- C.', epic: 'ABC-3789' }]);
  assert.match(text(page.$('#toast')), /Raised ABC-4500/);
});

test('a ticket already raised shows as its chip in place of Make a ticket', async () => {
  const page = await open({ data: emailView({ threads: [thread('a1b2c3d4e5f60001', { ticket: { key: 'ABC-4500', url: 'https://example.atlassian.net/browse/ABC-4500', summary: 'S' } })] }) });
  const [row] = rows(page);
  assert.equal(text(row.querySelector('.ticket-chip')), 'ABC-4500');
  assert.ok(!buttons(row).includes('Make a ticket'));
});

test('off, it says so and turns on from here; a failed read keeps the last list and says why', async () => {
  const off = await open({ data: emailView({ enabled: false, threads: [], fetchedAt: null }) });
  assert.match(text(off.$('#main .banner')), /^Email is off\./);
  assert.equal(rows(off).length, 0);
  off.$$('#main .banner button').find((b) => text(b) === 'Turn on').click();
  await off.settle(60);
  assert.deepEqual(off.posts, [['/api/email/settings', { enabled: true }]]);
  const failed = await open({ data: emailView({ error: 'Gmail refused the search' }) });
  assert.match(text(failed.$('#main .banner.warn')), /^The last read failed, so this is from .* ago: Gmail refused the search\.$/);
  assert.equal(rows(failed).length, 2);
});

test('Needs you has an Email group, a card per thread with its subject, who and why, to open or mark handled', async () => {
  const item = { kind: 'email', group: 'email', key: null, tier: 'interrupt', id: 'email:a1:t', title: 'Budget for the offsite', why: 'asks you something', since: '2026-11-10T09:00:00.000Z', thread: 'a1b2c3d4e5f60001', from: 'Victor Vale', reason: 'Victor wants it signed off.', link: LINK('a1b2c3d4e5f60001'), receivedAt: '2026-11-10T09:00:00.000Z' };
  const page = await open({ hash: 'needs-you', attention: { email: [item], count: 1 } });
  const group = page.$('#main .needs-group[data-group="email"]');
  assert.equal(text(group.querySelector('h2')), 'Email');
  const card = group.querySelector('.need-card');
  assert.equal(card.classList.contains('hot'), true);
  assert.equal(text(card.querySelector('.title')), 'Budget for the offsite');
  assert.match(text(card.querySelector('.meta')), /^Victor Vale · Victor wants it signed off\. · /);
  assert.equal(text(page.$('[data-count="email"]')), '1');
  tap(card, 'Handled');
  await page.settle(60);
  assert.deepEqual(page.posts, [['/api/email/handled', { id: 'a1b2c3d4e5f60001', handled: true, receivedAt: '2026-11-10T09:00:00.000Z' }]]);
});

test('Jump to lists each thread that needs you, with Open, Handled and Draft a reply, and g e goes to Email', async () => {
  const page = await open({ hash: 'overview' });
  page.run("ui.email = { data: " + JSON.stringify(emailView()) + ", at: 'x', loading: false, show: 'open', tickets: new Map(), skip: null }");
  const entries = JSON.parse(page.run("JSON.stringify(paletteEntries({ layer: 'main', view: 'overview' }).filter((x) => x.group === 'Email').map((x) => [x.label, x.detail, x.actions().map((a) => a.label)]))"));
  assert.deepEqual(entries[0], ['Budget for the offsite', 'Victor Vale · Victor wants the offsite budget signed off by Friday.', ['Open Budget for the offsite in Gmail', 'Mark Budget for the offsite handled', 'Draft a reply to Budget for the offsite with Claude']]);
  assert.equal(entries.length, 2, 'not the handled one');
  page.fire(page.document.activeElement ?? page.document.body, 'keydown', { key: 'g' });
  page.fire(page.document.activeElement ?? page.document.body, 'keydown', { key: 'e' });
  assert.equal(page.window.location.hash, '#email');
});

test('Settings has an Email group: on and off, in Needs you and the senders left out, and its hours are your working hours', async () => {
  const page = await open({ hash: 'settings' });
  await page.settle(60);
  const group = page.$('#email-settings');
  assert.deepEqual(group.querySelectorAll('.setting').map((row) => text(row.querySelector('label'))), ['Email', 'In Needs you', 'Senders left out', 'Reads every', 'Spend cap a read']);
  assert.equal(page.$('#email-skip').getAttribute('value'), 'news@example.com');
  page.$('#email-needs').click();
  await page.settle(60);
  const from = page.$('#hours-from');
  from.value = '07:30';
  page.fire(from, 'change');
  await page.settle(60);
  const skip = page.$('#email-skip');
  skip.value = 'news@example.com, example.net';
  page.fire(skip, 'input');
  page.fire(page.$('#email-skip'), 'keydown', { key: 'Enter' });
  await page.settle(60);
  assert.deepEqual(page.posts, [['/api/email/settings', { needsYou: false }], ['/api/locale', { from: '07:30' }], ['/api/email/settings', { skip: 'news@example.com, example.net' }]]);
});
