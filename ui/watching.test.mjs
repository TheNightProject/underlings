import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openPage } from './testkit.mjs';

const AT = '2026-11-05T12:00:00Z';
const PLAIN = 'acme/engine!7';
const WATCHED = 'acme/engine!8';
const CLOSED = 'acme/engine!3';

function row(key, extra = {}) {
  const iid = Number(key.split('!')[1]);
  return {
    key, iid, repo: 'engine', title: 'MR ' + iid, webUrl: 'https://gitlab.com/acme/engine/-/merge_requests/' + iid, author: 'ivan', reviewers: ['frank'],
    approvedBy: [], draft: false, pipeline: 'SUCCESS', ticket: null, updatedAt: AT, unresolved: 0, threads: null, mergeStatus: 'MERGEABLE', sourceBranch: 'b',
    sha: 'aaa', agentHandle: null, watch: null, flags: {}, phase: 'open', count: 0, mood: 'quiet', verdict: null, agent: null, level: null, ...extra,
  };
}

function snapshot() {
  return {
    generatedAt: AT,
    version: { ui: 1, lib: 1, worker: 1, loaded: 1 },
    agents: [],
    artifacts: [],
    matrix: {
      available: true, me: 'frank', paused: false, holdSeconds: null, holdWhileReviewing: false,
      inbox: { fetchedAt: AT, loading: false, error: null, repoCount: 1, rows: [row(PLAIN), row(WATCHED, { watch: { auto: true }, flags: { watched: true, changed: true } })] },
      fullAuto: [], roster: [], watches: [], verdicts: {}, queue: [], runs: [], autoPasses: [],
    },
  };
}

function watchRow(key, extra = {}) {
  return { key, iid: Number(key.split('!')[1]), repo: 'engine', title: null, webUrl: 'https://x', auto: false, automation: null, daily: null, agent: null, stillOpen: true, moved: false, reviewedAt: AT, addedAt: AT, ...extra };
}

const SETTINGS = {
  rows: [
    { key: 'repoFilter', label: 'Repos', hint: 'patterns, comma separated.', kind: 'text', bounds: null, value: 'acme' },
    { key: 'holdWhileReviewing', label: 'Hold while reviewing', hint: 'requests changes while a review runs.', kind: 'toggle', bounds: null, value: true },
    { key: 'pollSeconds', label: 'Refresh every', hint: 'seconds between refreshes.', kind: 'number', bounds: { step: 15, min: 15, max: 3600 }, value: 90 },
    { key: 'rowTint', label: 'Row tint', hint: 'the TUI only.', kind: 'toggle', bounds: null, value: true },
  ],
  repos: { filter: 'acme', total: 40, matching: ['acme/engine', 'acme/web'], perRefresh: 2, perMinute: 1, heavy: false, discoveredAt: AT },
};

async function page({ watching = [watchRow(WATCHED, { auto: true, moved: true, title: 'MR 8' })], settings = SETTINGS } = {}) {
  const posts = [];
  const reads = [];
  const p = await openPage({
    respond: (path, init) => {
      if (init?.method === 'POST') {
        posts.push([path, JSON.parse(init.body)]);
        return { ok: true, text: 'done' };
      }
      reads.push(path);
      if (path === '/api/matrix/watching') return { fetchedAt: AT, rows: watching };
      if (path.startsWith('/api/matrix/settings?')) {
        const filter = new URLSearchParams(path.split('?')[1]).get('filter');
        return { ...settings, repos: { ...settings.repos, filter, matching: ['acme/engine'], perMinute: 90, heavy: true } };
      }
      if (path === '/api/matrix/settings') return settings;
      return null;
    },
  });
  return { ...p, posts, reads };
}

const menuButton = (p, key) => p.document.getElementById('menu-' + key);
const buttons = (p, scope) => p.$$(scope + ' button').map((b) => b.textContent);
const press = (p, scope, label) => p.$$(scope + ' button').find((b) => b.textContent === label).click();

test('an MR row\'s menu offers Watch on an unwatched MR, and the rest on a watched one that moved', async () => {
  const p = await page();
  p.show(snapshot(), 'merge-requests');
  menuButton(p, PLAIN).click();
  assert.deepEqual(buttons(p, '.menu'), ['Watch', 'Re-review daily', 'Auto re-review on', 'Mute for a day', 'Mute until it merges']);
  menuButton(p, WATCHED).click();
  await p.settle();
  assert.deepEqual(buttons(p, '.menu'), ['Unwatch', 'Re-review daily', 'Auto re-review off', 'Mark seen', 'Mute for a day', 'Mute until it merges']);
  assert.equal(p.$$('.menu').length, 1, 'opening one menu closes the other');
  assert.equal(p.document.activeElement.textContent, 'Unwatch', 'the first item takes focus');
});

test('a menu item acts once and closes the menu, and Watch and Mark seen are single clicks', async () => {
  const p = await page();
  p.show(snapshot(), 'merge-requests');
  menuButton(p, PLAIN).click();
  press(p, '.menu', 'Watch');
  await p.settle();
  assert.deepEqual(p.posts, [['/api/matrix/watch', { key: PLAIN }]]);
  assert.equal(p.$$('.menu').length, 0);
  menuButton(p, WATCHED).click();
  press(p, '.menu', 'Mark seen');
  await p.settle();
  assert.deepEqual(p.posts[1], ['/api/matrix/seen', { key: WATCHED }]);
  assert.equal(p.posts.length, 2);
});

const DAILY = '2026-11-07T12:00:00.000Z';

test('Re-review daily takes two clicks and sends what the page saw, and a scheduled one offers its stop, neither naming Orca', async () => {
  const p = await page({ watching: [watchRow(WATCHED, { daily: DAILY })] });
  p.show(snapshot(), 'merge-requests');
  menuButton(p, PLAIN).click();
  press(p, '.menu', 'Re-review daily');
  assert.deepEqual(p.posts, []);
  press(p, '.menu', 'Look once a day, and review on days it moved?');
  await p.settle();
  assert.deepEqual(p.posts, [['/api/matrix/schedule', { key: PLAIN, expect: { daily: null, automation: null } }]]);
  menuButton(p, WATCHED).click();
  await p.settle();
  assert.doesNotMatch(p.$('.menu').textContent, /Orca/);
  press(p, '.menu', 'Stop the daily re-review');
  press(p, '.menu', 'Stop it?');
  await p.settle();
  assert.deepEqual(p.posts[1], ['/api/matrix/unschedule', { key: WATCHED, expect: { daily: DAILY, automation: null } }]);
});

test('daily re-reviews Orca still holds are listed once, each with a two-click move onto the schedule here', async () => {
  const p = await page({ watching: [watchRow(WATCHED, { automation: 're-review engine!8', title: 'MR 8' }), watchRow(CLOSED, { stillOpen: false, automation: 're-review engine!3' }), watchRow(PLAIN, { title: 'MR 7' })] });
  p.show(snapshot(), 'watching');
  await p.settle();
  const listed = p.$$('#main .section').find((s) => s.querySelector('h2')?.textContent === 'Daily re-reviews Orca still runs');
  assert.deepEqual(listed.querySelectorAll('.row').map((r) => r.querySelector('.ref').textContent), ['MR 8'], 'only the open one, as a closed MR has nothing to move');
  press(p, '#main .section', "Move to the schedule here");
  assert.deepEqual(p.posts, []);
  press(p, '#main .section', 'Move re-review engine!8 here?');
  await p.settle();
  assert.deepEqual(p.posts, [['/api/matrix/move-automation', { key: WATCHED, expect: { daily: null, automation: 're-review engine!8' } }]]);
  p.show(snapshot(), 'merge-requests');
  menuButton(p, WATCHED).click();
  await p.settle();
  assert.ok(p.$$('.menu button').some((b) => b.textContent === "Move to the schedule here"), 'and the MR\'s own menu offers the same move');
});

test('Escape or a click elsewhere closes the menu, and Escape hands focus back to its button', async () => {
  const p = await page();
  p.show(snapshot(), 'merge-requests');
  menuButton(p, PLAIN).click();
  p.fire(p.document.activeElement, 'keydown', { key: 'Escape' });
  assert.equal(p.$$('.menu').length, 0);
  assert.equal(p.document.activeElement.id, 'menu-' + PLAIN);
  menuButton(p, PLAIN).click();
  p.fire(p.$('#main h1'), 'click');
  assert.equal(p.$$('.menu').length, 0);
});

test('the arrow keys move through the menu and wrap round', async () => {
  const p = await page();
  p.show(snapshot(), 'merge-requests');
  menuButton(p, PLAIN).click();
  const focused = () => p.document.activeElement.textContent;
  p.fire(p.document.activeElement, 'keydown', { key: 'ArrowDown' });
  assert.equal(focused(), 'Re-review daily');
  p.fire(p.document.activeElement, 'keydown', { key: 'ArrowUp' });
  p.fire(p.document.activeElement, 'keydown', { key: 'ArrowUp' });
  assert.equal(focused(), 'Mute until it merges');
});

test('a click elsewhere leaves a menu that another part of the page opened', async () => {
  const p = await page();
  p.show(snapshot(), 'merge-requests');
  p.run("ui.menu = 'agent:x'");
  p.fire(p.$('#main h1'), 'click');
  assert.equal(p.run('ui.menu'), 'agent:x');
});

test('the Watching view lists each watch with Stop, Auto, Mark seen and Agent, and clears the closed ones in two clicks', async () => {
  const p = await page({
    watching: [
      watchRow(WATCHED, { auto: true, moved: true, agent: 'working', title: 'MR 8', automation: 're-review engine!8' }),
      watchRow(CLOSED, { stillOpen: false }),
      watchRow('acme/engine!4', { stillOpen: false, auto: true }),
      watchRow(PLAIN, { title: 'MR 7' }),
    ],
  });
  p.show(snapshot(), 'watching');
  await p.settle();
  const [open, closed, closedAuto, still] = p.$$('#main .row.watch');
  assert.deepEqual(open.querySelectorAll('button').map((b) => b.textContent), ['MR 8', 'Agent', 'Mark seen', 'Auto', 'Stop']);
  assert.deepEqual(closed.querySelectorAll('button').map((b) => b.textContent), ['Stop'], 'a closed MR has no auto to turn on');
  assert.deepEqual(closedAuto.querySelectorAll('button').map((b) => b.textContent), ['Auto', 'Stop'], 'but one left on can be turned off');
  assert.deepEqual(still.querySelectorAll('button').map((b) => b.textContent), ['MR 7', 'Auto', 'Stop'], 'one that has not moved has nothing to mark seen');
  assert.equal(open.querySelector('.auto-toggle').getAttribute('aria-pressed'), 'true');
  closed.querySelectorAll('button')[0].click();
  press(p, '#main', 'Auto');
  await p.settle();
  assert.deepEqual(p.posts, [['/api/matrix/unwatch', { key: CLOSED, expect: { daily: null, automation: null } }], ['/api/matrix/auto', { key: WATCHED, auto: false }]]);
  press(p, '#main', 'Stop');
  assert.equal(p.posts.length, 2, 'stopping one with a daily re-review only arms the first time');
  press(p, '#main', 'Clear 2 closed');
  press(p, '#main', 'Stop watching 2 closed MRs?');
  await p.settle();
  assert.deepEqual(p.posts.at(-1), ['/api/matrix/unwatch', { closed: true, expect: { keys: [CLOSED, 'acme/engine!4'] } }]);
});

test('Settings groups the engine\'s rows with their hints, and leaves out the ones only the terminal app uses', async () => {
  const p = await page();
  p.show(snapshot(), 'settings');
  await p.settle();
  assert.deepEqual(p.$$('#main .settings-group h2').map((h) => h.textContent), ['You', 'Setup', 'Features', 'Repos', 'Reviewing', 'Refresh every', 'Models', 'Notifications', 'Time and region', 'Working hours', 'Standup', 'Calendar', 'Email', 'Slack', 'QA', 'Claude', 'Intro', 'Game', 'Artifacts']);
  assert.equal(p.$$('#set-rowTint').length, 0);
  assert.equal(p.$('#set-pollSeconds').closest('.setting').querySelector('.hint').textContent, 'Seconds between refreshes.');
  assert.match(p.$('#main .repos .match').textContent, /^2 of 40 repos match/);
});

test('Settings links to Setup, and has the three agent commands, blank for the Underlings skill, each saved on its own', async () => {
  const p = await page({ settings: { ...SETTINGS, agents: { reviewCommand: '/team:review', selfReviewCommand: '', kickoffCommand: '' } } });
  p.show(snapshot(), 'settings');
  await p.settle();
  assert.equal(p.$('#setup-settings a.fix-link').getAttribute('href'), '#setup');
  const group = p.$('#agent-settings');
  assert.deepEqual(group.querySelectorAll('.setting label').map((l) => l.textContent), ['Review', 'Self-review', 'Kickoff']);
  assert.deepEqual(['reviewCommand', 'selfReviewCommand', 'kickoffCommand'].map((k) => p.$('#set-agent-' + k).getAttribute('value')), ['/team:review', '', '']);
  assert.match(group.querySelectorAll('.setting .hint')[0].textContent, /^Your own: \/team:review\./);
  assert.match(group.querySelectorAll('.setting .hint')[1].textContent, /^The Underlings skill \/underlings:pre-mr-review\./);
  const kickoff = p.$('#set-agent-kickoffCommand');
  kickoff.value = '/start';
  p.fire(kickoff, 'input');
  p.fire(kickoff, 'keydown', { key: 'Enter' });
  await p.settle();
  group.querySelectorAll('button').find((b) => b.textContent === 'Use the skill').click();
  await p.settle();
  assert.deepEqual(p.posts, [['/api/matrix/agent-commands', { agents: { kickoffCommand: '/start' } }], ['/api/matrix/agent-commands', { agents: { reviewCommand: '' } }]]);
});

test('Settings has a Running agents group: where they run and whether they ask are choices, with the limit and spend cap beside them', async () => {
  const choice = (key, label, value, choices) => ({ key, label, hint: 'auto lets an agent act without asking.', kind: 'choice', bounds: null, choices, value });
  const p = await page({
    settings: {
      ...SETTINGS,
      rows: [
        ...SETTINGS.rows,
        choice('agentHost', 'Agents run in', 'claude', [['claude', 'Claude Code'], ['orca', 'Orca terminals']]),
        choice('agentPermissions', 'Agent permissions', 'ask', [['ask', 'Ask me'], ['auto', 'Auto']]),
        { key: 'maxAgents', label: 'Agents at once', hint: '0 means no limit.', kind: 'number', bounds: { step: 1, min: 0, max: 20 }, value: 4 },
        { key: 'agentBudgetUsd', label: 'Spend cap a run', hint: 'blank means no cap.', kind: 'text', bounds: null, value: '' },
        { key: 'holdNote', label: 'Hold note', hint: 'posted as you.', kind: 'text', bounds: null, value: 'Holding.' },
      ],
    },
  });
  p.show(snapshot(), 'settings');
  await p.settle();
  const titles = p.$$('#main .settings-group h2').map((h) => h.textContent);
  assert.deepEqual(titles.slice(0, 8), ['You', 'Setup', 'Features', 'Repos', 'Reviewing', 'Refresh every', 'Running agents', 'What reviews post as you']);
  const agents = p.$$('#main .settings-group').find((g) => g.querySelector('h2').textContent === 'Running agents');
  assert.deepEqual(agents.querySelectorAll('.setting label').map((l) => l.textContent), ['Agents run in', 'Agent permissions', 'Agents at once', 'Spend cap a run']);
  assert.equal(p.$('#set-agentPermissions-ask').getAttribute('aria-pressed'), 'true');
  assert.match(p.$('#main .settings-spend').textContent, /spend your Claude usage/);
  p.$('#set-agentPermissions-auto').click();
  await p.settle();
  assert.deepEqual(p.posts, [['/api/matrix/settings', { patch: { agentPermissions: 'auto' } }]]);
});

test('a field saves on Enter, keeps focus as each key re-renders it, and a switch flips in one click', async () => {
  const p = await page();
  p.show(snapshot(), 'settings');
  await p.settle();
  const poll = p.$('#set-pollSeconds');
  assert.deepEqual([poll.getAttribute('type'), poll.getAttribute('inputmode')], ['text', 'numeric']);
  poll.focus();
  poll.value = '15';
  p.fire(poll, 'input');
  assert.equal(p.document.activeElement.id, 'set-pollSeconds');
  assert.deepEqual(p.$('#set-pollSeconds').parentNode.querySelectorAll('button').map((b) => b.textContent), ['Save', 'Undo']);
  assert.deepEqual(p.posts, [], 'typing alone saves nothing');
  p.fire(p.document.activeElement, 'keydown', { key: 'Enter' });
  await p.settle();
  assert.equal(p.document.activeElement.id, 'set-pollSeconds', 'focus comes back to the field once it has saved');
  p.$('#set-holdWhileReviewing').click();
  await p.settle();
  assert.deepEqual(p.posts, [['/api/matrix/settings', { patch: { pollSeconds: '15' } }], ['/api/matrix/settings', { patch: { holdWhileReviewing: false } }]]);
  assert.equal(p.$('#toast').textContent, 'done');
  assert.equal(p.$('#set-pollSeconds').getAttribute('value'), '90', 'the saved value is shown once read back');
});

test('Escape on a field drops what was typed, and Save while it is saving sends nothing more', async () => {
  const p = await page();
  p.show(snapshot(), 'settings');
  await p.settle();
  const site = p.$('#set-repoFilter');
  site.focus();
  site.value = 'other';
  p.fire(site, 'input');
  p.fire(p.document.activeElement, 'keydown', { key: 'Escape' });
  assert.equal(p.$('#set-repoFilter').getAttribute('value'), 'acme');
  assert.deepEqual(buttons(p, '#main .setting .control').filter((b) => b === 'Save'), []);
  p.$('#set-repoFilter').value = 'again';
  p.fire(p.$('#set-repoFilter'), 'input');
  p.fire(p.document.activeElement, 'keydown', { key: 'Enter' });
  press(p, '#main .setting .control', 'Save');
  await p.settle();
  assert.deepEqual(p.posts, [['/api/matrix/settings', { patch: { repoFilter: 'again' } }]]);
});

test('typing a repo filter previews its matches and request rate, and the draft survives a refresh', async () => {
  const p = await page();
  p.show(snapshot(), 'settings');
  await p.settle();
  const filter = p.$('#set-repoFilter');
  filter.value = 'acme/eng';
  p.fire(filter, 'input');
  await p.settle(400);
  assert.ok(p.reads.includes('/api/matrix/settings?filter=acme%2Feng'));
  assert.match(p.$('#main .repos .match').textContent, /^1 of 40 repos match as typed/);
  assert.match(p.$('#main .repos').textContent, /GitLab will start refusing/);
  p.run('render()');
  assert.equal(p.$('#set-repoFilter').getAttribute('value'), 'acme/eng');
  assert.deepEqual(p.$('#set-repoFilter').parentNode.querySelectorAll('button').map((b) => b.textContent), ['Save', 'Undo']);
  press(p, '#main .setting .control', 'Save');
  await p.settle();
  assert.deepEqual(p.posts, [['/api/matrix/settings', { patch: { repoFilter: 'acme/eng' } }]]);
});

test('Look for repos again is one click', async () => {
  const p = await page();
  p.show(snapshot(), 'settings');
  await p.settle();
  press(p, '#main', 'Look for repos again');
  await p.settle();
  assert.deepEqual(p.posts, [['/api/matrix/discover', {}]]);
});
