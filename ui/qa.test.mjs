import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openPage } from './testkit.mjs';

const AT = '2026-11-10T09:00:00Z';
const BUCKETS = [
  { id: 'today', label: 'Today', upTo: 1 },
  { id: 'days-2-3', label: '2 to 3 days', upTo: 3 },
  { id: 'days-4-7', label: '4 to 7 days', upTo: 7 },
  { id: 'weeks-1-2', label: '1 to 2 weeks', upTo: 14 },
  { id: 'weeks-2-plus', label: 'Over 2 weeks', upTo: null },
];

function snapshot(features) {
  return {
    features,
    generatedAt: AT, version: { ui: 1, lib: 1, worker: 1, loaded: 1 }, agents: [], artifacts: [],
    matrix: {
      available: true, running: false, me: 'frank', paused: false, holdSeconds: null, holdWhileReviewing: false,
      inbox: { fetchedAt: AT, loading: false, error: null, repoCount: 1, rows: [] },
      fullAuto: [], roster: [], watches: [], verdicts: {}, queue: [], runs: [], autoPasses: [],
    },
  };
}

const mr = (project, iid, mergedAt, author, additions, deletions) => ({
  project: 'acme/platform/' + project, iid, url: `https://gitlab.com/acme/platform/${project}/-/merge_requests/${iid}`, title: 'Change ' + iid, mergedAt, author, additions, deletions, keys: [],
});
const ticket = (key, summary, assignee, days, bucket, mrs = []) => ({ key, summary, assignee, url: 'https://example.atlassian.net/browse/' + key, days, bucket, mrs });

function tickets() {
  return [
    ticket('ABC-4142', 'A button can act on stale state', 'Ivan Irving', { from: 1, to: 1 }, 'today',
      [mr('relay', 1201, '2026-11-09T16:00:00Z', 'Trent Tyler', 40, 5), mr('frontend', 1720, '2026-11-10T08:30:00Z', 'Ivan Irving', 120, 30)]),
    ticket('ABC-4150', 'Board columns jump on drag', 'Trent Tyler', { from: 2, to: 2 }, 'days-2-3', [mr('frontend', 1730, '2026-11-08T10:00:00Z', 'Trent Tyler', 8, 1)]),
    ticket('ABC-4101', 'Team menu forgets the team on refresh', 'Sybil Shaw', { from: 3, to: 3 }, 'days-2-3', [mr('frontend', 1702, '2026-11-07T11:00:00Z', 'Sybil Shaw', 12, 3)]),
    ticket('ABC-3990', 'Invite emails show the code placeholder', null, { from: 9, to: 9 }, 'weeks-1-2'),
    ticket('ABC-3801', 'Audit log export times out on large teams', 'Ivan Irving', { from: 22, to: 28 }, 'weeks-2-plus',
      [mr('gateway', 212, '2026-10-13T10:00:00Z', 'Ivan Irving', 75, 10), mr('relay', 1188, '2026-10-14T09:00:00Z', 'Ivan Irving', 300, 80)]),
    ticket('ABC-3500', 'Backups list the wrong size', 'Sybil Shaw', { from: 91, to: null }, 'weeks-2-plus'),
  ];
}

function qaView({ board = {}, ...rest } = {}) {
  return {
    jql: 'project = ABC AND status = QA', on: true, configured: true, status: 'QA', group: 'acme', refreshing: false, error: null,
    board: board && { generatedAt: AT, jql: 'project = ABC AND status = QA', group: 'acme', windowDays: 60, buckets: BUCKETS, tickets: tickets(), ...board },
    ...rest,
  };
}

const SETTINGS = { jql: 'project = ABC AND status = QA', status: 'QA', group: 'acme', ownGroups: 'acme', example: 'project = ABC AND status = QA', defaultStatus: 'QA', on: true };

async function open({ data = qaView(), hash = 'qa', settings = SETTINGS, features } = {}) {
  const posts = [];
  const reads = [];
  const page = await openPage({
    respond(path, init) {
      const url = new URL(path, 'http://page');
      if (init?.method === 'POST') {
        const body = JSON.parse(init.body);
        posts.push([url.pathname, body]);
        return { ok: true, text: 'Done', ...settings, ...(url.pathname === '/api/qa/settings' ? body : {}) };
      }
      reads.push(url.pathname);
      if (url.pathname === '/api/qa') return typeof data === 'function' ? data() : data;
      if (url.pathname === '/api/qa/settings') return settings;
      if (url.pathname === '/api/standup/settings') return { calendarSet: false, excludedRepos: [] };
      if (url.pathname === '/api/matrix/settings') return { rows: [], repos: { filter: '', matching: [], total: 0, perRefresh: 0, perMinute: 0 } };
      return null;
    },
  });
  page.show(snapshot(features), hash);
  await page.settle(60);
  return Object.assign(page, { posts, reads });
}

const text = (node) => node?.textContent.replace(/\s+/g, ' ').trim();
const rows = (page) => page.$$('.qa-heat tbody tr').map((r) => [text(r.querySelector('th')), ...r.querySelectorAll('td').map((td) => text(td))]);
const cell = (page, repo, bucket) => page.document.getElementById('qa-cell:acme/platform/' + repo + ':' + bucket);
const listed = (page) => page.$$('.qa-ticket').map((r) => r.dataset.ticket);

test('the heatmap has a row per repo, busiest first, a column per wait, and a row of its own for tickets with no merged MR', async () => {
  const page = await open();
  assert.deepEqual(page.errors, []);
  assert.deepEqual(page.$$('.qa-heat thead th').map(text), ['Repo', 'Today', '2 to 3 days', '4 to 7 days', '1 to 2 weeks', 'Over 2 weeks', 'All']);
  assert.deepEqual(rows(page), [
    ['frontend', '1', '2', '', '', '', '3'],
    ['relay', '1', '', '', '', '1', '2'],
    ['gateway', '', '', '', '', '1', '1'],
    ['No merged MR', '', '', '', '1', '1', '2'],
  ]);
  assert.equal(page.$$('.qa-heat tbody').length, 2, 'the no merged MR row sits apart');
});

test('each cell is shaded by its count and says what it holds, and an empty cell says so too', async () => {
  const page = await open();
  const two = cell(page, 'frontend', 'days-2-3');
  assert.equal(two.classList.contains('qa-q2'), true);
  assert.equal(cell(page, 'relay', 'today').classList.contains('qa-q1'), true);
  assert.equal(two.getAttribute('aria-label'), 'frontend, 2 to 3 days: 2 tickets, oldest ABC-4101 at 3d');
  const none = page.$$('.qa-heat .qa-none');
  assert.equal(none.length, 13);
  assert.ok(none.every((n) => /: no tickets$/.test(n.getAttribute('aria-label'))));
  assert.deepEqual(page.$$('.qa-legend .qa-key').map(text), ['none', '1', '2', '3 to 4', '5 to 7', '8 or more']);
});

test('a cell shows its count in a tooltip on hover or focus, kept inside the window', async () => {
  const page = await open();
  page.window.innerWidth = 390;
  const two = cell(page, 'frontend', 'days-2-3');
  page.fire(two, 'pointerenter', { bubbles: false });
  const tip = page.document.getElementById('qa-tip');
  assert.equal(tip.hidden, false);
  assert.equal(tip.textContent, 'frontend, 2 to 3 days: 2 tickets, oldest ABC-4101 at 3d');
  assert.ok(parseFloat(tip.style.left) >= 8 && parseFloat(tip.style.left) + parseFloat(tip.style.maxWidth) <= 390 - 8);
  page.fire(two, 'pointerleave', { bubbles: false });
  assert.equal(tip.hidden, true);
});

test('the strip counts the tickets, names the oldest with its wait, and counts those with no merged MR', async () => {
  const page = await open();
  assert.equal(text(page.$('#qa-count')), '6 tickets in QA');
  assert.equal(text(page.$('#qa-oldest')), 'over 90d oldest, ABC-3500');
  assert.equal(text(page.$('#qa-orphans')), '2 with no merged MR');
});

test('clicking a cell lists its tickets oldest first with their MRs, assignee, days in QA and lines changed, and clicking again lists all', async () => {
  const page = await open();
  assert.deepEqual(listed(page), ['ABC-3500', 'ABC-3801', 'ABC-3990', 'ABC-4101', 'ABC-4150', 'ABC-4142']);
  cell(page, 'frontend', 'days-2-3').click();
  await page.settle(20);
  assert.deepEqual(listed(page), ['ABC-4101', 'ABC-4150']);
  assert.match(text(page.$('#qa-list h2')), /^frontend, 2 to 3 days\s*2 tickets, oldest first$/);
  assert.equal(cell(page, 'frontend', 'days-2-3').getAttribute('aria-pressed'), 'true');
  const row = page.$$('.qa-ticket')[0];
  assert.equal(text(row.querySelector('.meta')), 'Sybil Shaw · 3d in QA · 15 lines changed');
  assert.equal(text(row.querySelector('.qa-mrs li')), 'frontend !1702 merged 7 Nov by Sybil Shaw · +12 −3');
  row.querySelector('.qa-mrs .ref').click();
  await page.settle(20);
  assert.deepEqual(page.posts.at(-1), ['/api/open', { url: 'https://gitlab.com/acme/platform/frontend/-/merge_requests/1702' }]);
  cell(page, 'frontend', 'days-2-3').click();
  await page.settle(20);
  assert.equal(listed(page).length, 6);
});

test('a ticket with MRs in two repos is listed under either, and one with none says why it might be missing', async () => {
  const page = await open();
  cell(page, 'relay', 'weeks-2-plus').click();
  await page.settle(20);
  assert.deepEqual(listed(page), ['ABC-3801']);
  assert.deepEqual(page.$$('.qa-ticket .qa-mrs .ref').map(text), ['gateway !212', 'relay !1188']);
  assert.match(text(page.$('.qa-ticket .meta')), /465 lines changed/);
  page.document.getElementById('qa-cell:(none):weeks-1-2').click();
  await page.settle(20);
  assert.deepEqual(listed(page), ['ABC-3990']);
  assert.equal(text(page.$('.qa-ticket .meta')), 'Unassigned · 9d in QA');
  assert.equal(text(page.$('.qa-ticket .hint')), 'No merged MR names ABC-3990 in its title or branch.');
});

test('the repo and assignee filters narrow the strip, the heatmap and the list together', async () => {
  const page = await open();
  page.$('#qa-repo').value = 'acme/platform/relay';
  page.fire(page.$('#qa-repo'), 'change');
  await page.settle(20);
  assert.deepEqual(rows(page).map((r) => r[0]), ['relay', 'frontend', 'gateway']);
  assert.deepEqual(listed(page), ['ABC-3801', 'ABC-4142']);
  assert.equal(text(page.$('#qa-count')), '2 tickets in QA');
  page.$('#qa-person').value = 'Ivan Irving';
  page.fire(page.$('#qa-person'), 'change');
  await page.settle(20);
  assert.deepEqual(listed(page), ['ABC-3801', 'ABC-4142']);
  page.$('#qa-repo').value = '(none)';
  page.fire(page.$('#qa-repo'), 'change');
  await page.settle(20);
  assert.equal(text(page.$('.qa-heat-section .empty')), 'Nothing in QA matches these filters.');
  page.$('#qa-person').value = '(nobody)';
  page.fire(page.$('#qa-person'), 'change');
  await page.settle(20);
  assert.deepEqual(listed(page), ['ABC-3990']);
  assert.equal(text(page.$('#qa-orphans')), '1 with no merged MR');
  page.$$('.qa-filters button').find((b) => text(b) === 'Clear filters').click();
  await page.settle(20);
  assert.equal(listed(page).length, 6);
});

test('the filters list each repo and person with how many tickets they have', async () => {
  const page = await open();
  assert.deepEqual(page.$$('#qa-repo option').map(text), ['Every repo', 'frontend (3)', 'gateway (1)', 'relay (2)', 'No merged MR (2)']);
  assert.deepEqual(page.$$('#qa-person option').map(text), ['Everyone', 'Ivan Irving (2)', 'Sybil Shaw (2)', 'Trent Tyler (1)', 'Unassigned (1)']);
});

test('Copy for Slack copies the list as shown, a line per ticket', async () => {
  const page = await open();
  const copied = [];
  page.window.navigator.clipboard = { writeText: async (value) => { copied.push(value); } };
  const copy = () => page.$$('.head button').find((b) => text(b) === 'Copy for Slack').click();
  copy();
  await page.settle(20);
  assert.equal(copied[0], [
    '- [ABC-3500] Backups list the wrong size (over 90d in QA, no merged MR)',
    '- [ABC-3801] Audit log export times out on large teams (22-28d in QA, gateway !212, relay !1188)',
    '- [ABC-3990] Invite emails show the code placeholder (9d in QA, no merged MR)',
    '- [ABC-4101] Team menu forgets the team on refresh (3d in QA, frontend !1702)',
    '- [ABC-4150] Board columns jump on drag (2d in QA, frontend !1730)',
    '- [ABC-4142] A button can act on stale state (1d in QA, relay !1201, frontend !1720)',
  ].join('\n'));
  assert.match(text(page.$('#toast')), /Copied 6 tickets for Slack/);
  cell(page, 'relay', 'today').click();
  await page.settle(20);
  copy();
  await page.settle(20);
  assert.equal(copied[1], '- [ABC-4142] A button can act on stale state (1d in QA, relay !1201, frontend !1720)');
});

test('two repos that end in the same name keep their group in the rows, the list and the copy', async () => {
  const data = qaView();
  data.board.tickets.push(ticket('ABC-4160', 'Orbit login button is grey', 'Trent Tyler', { from: 5, to: 5 }, 'days-4-7', [mr('agent-studio/orbit/frontend', 55, '2026-11-05T10:00:00Z', 'Trent Tyler', 3, 3)]));
  const page = await open({ data });
  assert.deepEqual(rows(page).map((r) => r[0]).filter((name) => name.endsWith('frontend')), ['platform/frontend', 'orbit/frontend']);
  assert.ok(page.$$('.qa-mrs .ref').map(text).includes('orbit/frontend !55'));
  const copied = [];
  page.window.navigator.clipboard = { writeText: async (value) => { copied.push(value); } };
  page.$$('.head button').find((b) => text(b) === 'Copy for Slack').click();
  await page.settle(20);
  assert.match(copied[0], /- \[ABC-4160\] Orbit login button is grey \(5d in QA, orbit\/frontend !55\)/);
});

test('Refresh asks the worker to read again, and says so while it reads', async () => {
  const page = await open();
  page.$('#qa-refresh').click();
  await page.settle(20);
  assert.deepEqual(page.posts[0], ['/api/qa/refresh', {}]);
  const busy = await open({ data: qaView({ refreshing: true }) });
  assert.equal(text(busy.$('#qa-refresh')), 'Reading…');
  assert.equal(busy.$('#qa-refresh').disabled, true);
});

test('before the first read it says it is reading, and a failed read says why while the last board stays', async () => {
  const first = await open({ data: qaView({ board: null, refreshing: true }) });
  assert.match(text(first.$('#main .empty')), /Reading every ticket in QA from Jira/);
  assert.equal(first.$('.qa-heat'), null);
  const failed = await open({ data: qaView({ error: 'Jira did not answer acli within 30 s' }) });
  assert.match(text(failed.$('#main .banner.warn')), /The last read failed, so this is from .*: Jira did not answer acli within 30 s/);
  assert.ok(failed.$('.qa-heat'));
  const moved = await open({ data: qaView({ jql: 'project in (ABC, XYZ) AND status = QA' }) });
  assert.match(text(moved.$('#main .banner')), /This was read for project = ABC AND status = QA\. Reading project in \(ABC, XYZ\) AND status = QA now\./);
});

test('Settings takes the JQL, the QA status and the groups, each saving on Enter or Save, with the switch on top', async () => {
  const page = await open({ hash: 'settings', settings: { ...SETTINGS, jql: 'project in (ABC, XYZ) AND status = QA', group: '' } });
  assert.ok(page.$('#qa-settings #feature-own-qa'), 'the group has its own on switch');
  const field = page.$('#qa-jql');
  assert.equal(field.getAttribute('value'), 'project in (ABC, XYZ) AND status = QA');
  assert.deepEqual([page.$('#qa-status').getAttribute('value'), page.$('#qa-status').getAttribute('placeholder')], ['', 'QA']);
  assert.deepEqual([page.$('#qa-group').getAttribute('value'), page.$('#qa-group').getAttribute('placeholder')], ['', 'acme'], 'a blank group shows the groups your MRs are in');
  field.value = 'project = XYZ AND status = QA';
  page.fire(field, 'input');
  page.fire(page.$('#qa-jql'), 'keydown', { key: 'Enter' });
  await page.settle(20);
  assert.deepEqual(page.posts.at(-1), ['/api/qa/settings', { jql: 'project = XYZ AND status = QA' }]);
  page.$('#qa-group').value = 'acme, acme/labs';
  page.fire(page.$('#qa-group'), 'input');
  page.$$('#qa-settings button').find((b) => text(b) === 'Save').click();
  await page.settle(20);
  assert.deepEqual(page.posts.at(-1), ['/api/qa/settings', { group: 'acme, acme/labs' }]);
});

test('with no search set, QA says calmly what to set and links to it, and draws no board', async () => {
  const page = await open({ data: { on: true, configured: false, jql: '', status: 'QA', group: 'acme', example: 'project = ABC AND status = QA', refreshing: false, error: null, board: null } });
  const unset = page.$('#main .qa-unset');
  assert.match(text(unset), /once it knows where to look/);
  assert.match(text(unset), /such as project = ABC AND status = QA\. Days in QA count from each ticket's last move to the status named QA, and the merged MRs are joined from acme\./);
  assert.equal(unset.querySelector('a').getAttribute('href'), '#qa-settings');
  assert.equal(page.$('#main .banner.warn'), null, 'not an error');
  assert.equal(page.$$('.qa-heat').length, 0);
});

test('with QA switched off the rail has no QA, the view says it is off, and QA is never read', async () => {
  const page = await open({ features: { qa: false }, hash: 'qa' });
  const link = page.$$('.navlink').find((a) => a.getAttribute('href') === '#qa');
  assert.equal(link.hidden, true);
  assert.equal(link.closest('.navgroup').hidden, true, 'its group goes too when nothing else is in it');
  assert.match(text(page.$('#main')), /QA is off\. Turn it on in Settings/);
  assert.deepEqual(page.reads.filter((p) => p === '/api/qa'), []);
  page.show(snapshot({ qa: false }), 'overview');
  await page.settle(60);
  assert.equal(page.$$('#main .section').find((s) => text(s.querySelector('h2')) === 'QA'), undefined);
  assert.deepEqual(page.reads.filter((p) => p === '/api/qa'), [], 'nor by the Overview');
});

test('the Overview shows QA at a glance and where it piles up, and a repo there opens QA filtered to it', async () => {
  const page = await open({ hash: 'overview' });
  const qa = page.$$('#main .section').find((s) => text(s.querySelector('h2')) === 'QA');
  assert.ok(qa, 'the Overview has a QA section');
  assert.equal(text(qa.querySelector('#qa-count b')), '6');
  assert.deepEqual(qa.querySelectorAll('.line').map((l) => [text(l.querySelector('.line-title')), text(l.querySelector('.pill')), text(l.querySelector('.meta'))]), [
    ['frontend', '3', 'oldest 3d'], ['relay', '2', 'oldest 22-28d'], ['gateway', '1', 'oldest 22-28d'], ['No merged MR', '2', 'oldest over 90d'],
  ]);
  const link = qa.querySelectorAll('.line').find((l) => text(l.querySelector('.line-title')) === 'gateway');
  assert.equal(link.getAttribute('href'), '#qa');
  link.click();
  assert.equal(page.run('ui.qa.repo'), 'acme/platform/gateway');
  page.show(snapshot(), 'qa');
  await page.settle(60);
  assert.deepEqual(listed(page), ['ABC-3801']);
});
