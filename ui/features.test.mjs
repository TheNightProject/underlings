import assert from 'node:assert/strict';
import { test } from 'node:test';
import { KEY_PATTERN as LIB_KEY } from '../lib/ticketkeys.mjs';
import { openPage } from './testkit.mjs';

const AT = '2026-11-10T09:00:00Z';
const FEATURES = ['tickets', 'standup', 'qa', 'calendar', 'email', 'slack', 'game', 'leaderboard', 'artifacts'];
const allOn = Object.fromEntries(FEATURES.map((f) => [f, true]));

function snapshot({ features = allOn, matrix = {} } = {}) {
  return {
    generatedAt: AT, version: { ui: 1, lib: 1, worker: 1, loaded: 1 }, agents: [], artifacts: [], features,
    matrix: {
      available: true, me: 'frank', paused: false, holdSeconds: null, holdWhileReviewing: false,
      inbox: { fetchedAt: AT, loading: false, error: null, repoCount: 0, rows: [] },
      fullAuto: [], roster: [], watches: [], verdicts: {}, queue: [], runs: [], autoPasses: [], ...matrix,
    },
  };
}

const ROWS = [
  { key: 'gitlab.host', label: 'GitLab host', hint: 'where your GitLab lives.', kind: 'text', bounds: null, value: 'https://gitlab.com' },
  { key: 'jira.projects', label: 'Your projects', hint: 'project keys.', kind: 'text', bounds: null, value: '' },
  { key: 'jira.ticketTemplate', label: 'Ticket template', hint: 'lines starting #.', kind: 'lines', bounds: null, value: '# Problem\n# Fix' },
  { key: 'leaderboardDays', label: 'Leaderboard window', hint: 'days.', kind: 'number', bounds: { step: 7, min: 1, max: 365 }, value: 30 },
];

async function page() {
  const posts = [];
  const reads = [];
  const p = await openPage({
    respond: (path, init) => {
      if (init?.method === 'POST') {
        posts.push([path, JSON.parse(init.body)]);
        return { ok: true, text: 'done' };
      }
      reads.push(path);
      if (path.startsWith('/api/matrix/settings')) return { rows: ROWS, repos: { filter: '', total: 0, matching: [], perRefresh: 0, perMinute: 0, heavy: false, discoveredAt: null } };
      return null;
    },
  });
  return Object.assign(p, { posts, reads });
}

const rail = (p) => p.$$('.navlink').filter((a) => !a.hidden).map((a) => a.getAttribute('href').slice(1));

test('every feature switched off leaves the rail, and a group left with nothing goes too', async () => {
  const p = await page();
  p.show(snapshot(), 'overview');
  for (const f of FEATURES) assert.ok(rail(p).includes(f), f);
  p.show(snapshot({ features: { ...allOn, tickets: false, standup: false, qa: false, calendar: false, email: false, slack: false, game: false, leaderboard: false, artifacts: false } }), 'overview');
  for (const f of FEATURES) assert.ok(!rail(p).includes(f), f);
  assert.deepEqual(rail(p), ['overview', 'needs-you', 'agents', 'merge-requests', 'review-queue', 'full-auto', 'review-runs', 'watching', 'settings']);
  const shown = p.$$('.navgroup').filter((g) => !g.hidden).map((g) => g.querySelector('h2').textContent);
  assert.deepEqual(shown, ['Now', 'Agents', 'Reviews'], 'You, Work and Team had only switched-off features');
});

test('a view switched off says so and links to the switch, and reads nothing for it', async () => {
  const p = await page();
  p.show(snapshot({ features: { ...allOn, standup: false } }), 'standup');
  await p.settle(40);
  assert.match(p.$('#main').textContent, /Standup is off\. Turn it on in Settings/);
  assert.equal(p.$('#main .fix-link').getAttribute('href'), '#feature-settings');
  assert.deepEqual(p.requested.filter((r) => r.startsWith('/api/standup')), []);
});

test('Settings has one Features group of every switch, each flipping in a click, and the same switch in a feature\'s own group', async () => {
  const p = await page();
  p.show(snapshot({ features: { ...allOn, qa: false } }), 'settings');
  await p.settle(40);
  const group = p.$('#feature-settings');
  assert.deepEqual(group.querySelectorAll('.setting label').map((l) => l.textContent), ['Tickets', 'Standup', 'QA', 'The calendar', 'Email', 'Slack', 'The game', 'The leaderboard', 'Artifacts']);
  assert.equal(p.$('#feature-all-qa').getAttribute('aria-checked'), 'false');
  p.$('#feature-all-qa').click();
  await p.settle(20);
  assert.deepEqual(p.posts.at(-1), ['/api/features', { feature: 'qa', on: true }]);
  for (const [section, feature] of [['#standup-settings', 'standup'], ['#calendar-settings', 'calendar'], ['#qa-settings', 'qa'], ['#artifact-settings', 'artifacts']]) {
    assert.ok(p.$(section + ' #feature-own-' + feature), section);
  }
  const titled = (title) => p.$$('#main .settings-group').find((g) => g.querySelector('h2').textContent === title);
  assert.ok(titled('Leaderboard').querySelector('#feature-own-leaderboard'));
  assert.ok(titled('Tickets').querySelector('#feature-own-tickets'), 'the Tickets group carries its switch over its Jira rows');
  titled('Leaderboard').querySelector('#feature-own-leaderboard').click();
  await p.settle(20);
  assert.deepEqual(p.posts.at(-1), ['/api/features', { feature: 'leaderboard', on: false }]);
});

test('the GitLab host and Jira rows save by their dotted keys, and a template is a box of lines that Enter does not send', async () => {
  const p = await page();
  p.show(snapshot(), 'settings');
  await p.settle(40);
  const byId = (id) => p.document.getElementById(id);
  const host = byId('set-gitlab.host');
  host.value = 'https://git.acme.test';
  p.fire(host, 'input');
  p.fire(byId('set-gitlab.host'), 'keydown', { key: 'Enter' });
  await p.settle(20);
  assert.deepEqual(p.posts.at(-1), ['/api/matrix/settings', { patch: { 'gitlab.host': 'https://git.acme.test' } }]);
  const template = byId('set-jira.ticketTemplate');
  assert.equal(template.tagName.toLowerCase(), 'textarea');
  assert.equal(template.textContent, '# Problem\n# Fix');
  template.value = '# Context\n# Change';
  p.fire(template, 'input');
  const posted = p.posts.length;
  p.fire(byId('set-jira.ticketTemplate'), 'keydown', { key: 'Enter' });
  await p.settle(20);
  assert.equal(p.posts.length, posted, 'Enter is a new line in a template');
  byId('set-jira.ticketTemplate').closest('.setting').querySelectorAll('button').find((b) => b.textContent === 'Save').click();
  await p.settle(20);
  assert.deepEqual(p.posts.at(-1), ['/api/matrix/settings', { patch: { 'jira.ticketTemplate': '# Context\n# Change' } }]);
});

test('the page links MRs on a self-hosted GitLab, and its own projects\' keys, while UTF-8 stays text', async () => {
  const p = await page();
  p.show(snapshot({ matrix: { gitlabHost: 'https://git.acme.test/gitlab', jiraProjects: ['OPS'], jiraSite: 'acme.atlassian.net' } }), 'overview');
  const known = p.window.terminalKnowing({ mrs: ['acme/engine!4'], jiraSite: 'acme.atlassian.net', projects: p.run('ownProjects()') });
  const refs = JSON.parse(JSON.stringify(p.window.terminalRefs(['See https://git.acme.test/gitlab/acme/engine/-/merge_requests/4, OPS-12, UTF-8 and https://gitlab.com/acme/engine/-/merge_requests/4'], known)));
  assert.deepEqual(refs.map((r) => [r.kind, r.key]), [['mr', 'acme/engine!4'], ['ticket', 'OPS-12']]);
  const action = p.window.terminalAction(p.window.terminalRefs(['acme/engine!4'], known)[0], known, { outside: true });
  assert.equal(action.url, 'https://git.acme.test/gitlab/acme/engine/-/merge_requests/4');
  assert.equal(p.run("exampleKey()"), 'OPS-1234', 'examples are built from your own project');
});

test('the page, the worker and the engine share one ticket key pattern', async () => {
  const p = await page();
  const { KEY_PATTERN: ENGINE_KEY } = await import('../engine/dist/engine.js');
  assert.equal(p.run('TICKET_KEY_SOURCE'), LIB_KEY);
  assert.equal(ENGINE_KEY, LIB_KEY);
  const key = new RegExp(`^${LIB_KEY}$`);
  for (const ok of ['ABC-1', 'DEF-9', 'PLATFORM-1234', 'A1-2']) assert.ok(key.test(ok), ok);
  for (const bad of ['abc-1', 'ABC-0', 'ABC-012', 'C-1', '1AB-2', 'ABC-1,ABC-2']) assert.ok(!key.test(bad), bad);
});
