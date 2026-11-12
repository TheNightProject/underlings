import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openPage } from './testkit.mjs';

const AT = '2026-11-11T09:00:00Z';
const ENTRY = { matcher: 'Artifact', hooks: [{ type: 'command', command: "ELECTRON_RUN_AS_NODE=1 '/app/node' '/app/lib/record-artifact.mjs'", timeout: 10 }] };
const COMMANDS = { reviewCommand: '', selfReviewCommand: '', kickoffCommand: '' };

function snapshot(extra = {}) {
  return {
    generatedAt: AT, version: { ui: 1, lib: 1, worker: 1, loaded: 1, started: 1 }, agents: [], artifacts: [],
    matrix: { available: true, me: 'sybil', paused: false, holdSeconds: null, inbox: { fetchedAt: AT, loading: false, error: null, repoCount: 1, rows: [] }, fullAuto: [], roster: [], watches: [], verdicts: {}, queue: [], runs: [], autoPasses: [] },
    ...extra,
  };
}

const FAILING = [
  { id: 'claude', state: 'fail', title: 'Claude Code', detail: 'Claude Code is installed but not signed in.', command: 'claude auth login' },
  { id: 'gitlab', state: 'fail', title: 'GitLab token', detail: 'No token yet.', scope: 'api', link: 'https://gitlab.com/-/user_settings/personal_access_tokens?scopes=api', token: true },
  { id: 'jira', state: 'off', optional: true, title: 'Jira', detail: 'Optional. Tickets stay off until you set your Atlassian site here.', site: '', link: 'https://developer.atlassian.com/cloud/acli/guides/install-acli/' },
  { id: 'workspace', state: 'fail', title: 'Workspace root', detail: 'Not set.', root: '' },
  { id: 'agents', state: 'pass', title: 'Agent commands', detail: 'Every agent uses the built-in prompts.', commands: COMMANDS },
  { id: 'hook', state: 'fail', title: 'Artifact hook', detail: 'Not installed.', file: '/home/sybil/.claude/settings.json', entry: ENTRY },
];
const PASSING = [
  { id: 'claude', state: 'pass', title: 'Claude Code', detail: 'Signed in as sybil@example.com.' },
  { id: 'gitlab', state: 'pass', title: 'GitLab token', detail: 'Signed in to GitLab as sybil, with the api scope.', scope: 'api', link: FAILING[1].link, token: true },
  { id: 'jira', state: 'pass', optional: true, title: 'Jira', detail: 'Tickets are read from acme.atlassian.net through acli.', site: 'acme.atlassian.net' },
  { id: 'workspace', state: 'pass', title: 'Workspace root', detail: '3 checkouts found under /code.', root: '/code', checkouts: 3, names: ['api', 'engine', 'web'] },
  { id: 'agents', state: 'pass', title: 'Agent commands', detail: 'Your own review command; the rest use the built-in prompts.', commands: { ...COMMANDS, reviewCommand: '/review' } },
  { id: 'hook', state: 'pass', title: 'Artifact hook', detail: 'Installed in /home/sybil/.claude/settings.json.', file: '/home/sybil/.claude/settings.json' },
];

async function setupPage(checks, { done = false } = {}) {
  const posts = [];
  let reads = 0;
  const page = await openPage({
    respond: (path, init) => {
      if (init?.method === 'POST') {
        posts.push([path, JSON.parse(init.body)]);
        return { ok: true, text: 'done' };
      }
      if (path === '/api/setup') {
        reads += 1;
        return { done, checks };
      }
      return null;
    },
  });
  page.show(snapshot(), 'setup');
  await page.settle(100);
  return { page, posts, reads: () => reads };
}

const card = (page, id) => page.$('#setup-' + id);
const stateOf = (page, id) => [card(page, id).getAttribute('class'), card(page, id).querySelector('.setup-state').textContent];
const buttonIn = (node, label) => node.querySelectorAll('button').find((b) => b.textContent.startsWith(label));

test('every check shows its state, and the summary counts only what the app needs', async () => {
  const { page } = await setupPage(FAILING);
  assert.deepEqual(page.$$('.setup-check').map((c) => c.id), ['setup-claude', 'setup-gitlab', 'setup-jira', 'setup-workspace', 'setup-agents', 'setup-hook']);
  assert.deepEqual(stateOf(page, 'claude'), ['setup-check s-fail', 'Needs you']);
  assert.deepEqual(stateOf(page, 'jira'), ['setup-check s-off', 'Optional']);
  assert.deepEqual(stateOf(page, 'agents'), ['setup-check s-pass', 'Ready']);
  assert.match(page.$('.setup-summary').textContent, /^1 of 5 ready\./);
  const done = await setupPage(PASSING);
  assert.equal(done.page.$$('.setup-check.s-pass').length, 6);
  assert.match(done.page.$('.setup-summary').textContent, /^Everything the app needs is ready\./);
});

test('each failing check offers its fix: a command to copy, a link out, or a field that saves and checks again', async () => {
  const { page, posts, reads } = await setupPage(FAILING);
  assert.equal(card(page, 'claude').querySelector('.setup-command code').textContent, 'claude auth login');
  const gitlab = card(page, 'gitlab');
  assert.ok(buttonIn(gitlab, 'Make a token with the api scope'), 'a link to make one, with the scope named');
  const token = page.$('#setup-token');
  assert.equal(token.getAttribute('type'), 'password');
  token.value = ' gl-fake-0123456789abcdefghij ';
  page.fire(token, 'input');
  buttonIn(gitlab, 'Save').click();
  await page.settle(100);
  const root = page.$('#setup-root');
  root.value = '/code';
  page.fire(root, 'input');
  page.fire(root, 'keydown', { key: 'Enter' });
  await page.settle(100);
  assert.deepEqual(posts, [['/api/gitlab/token', { token: 'gl-fake-0123456789abcdefghij' }], ['/api/matrix/settings', { patch: { workspaceRoot: '/code' } }]]);
  assert.equal(reads(), 3, 'checked again after each');
  assert.ok(page.$('#setup-jira'), 'Jira can be set from here');
  assert.equal(buttonIn(card(page, 'jira'), 'Install acli'), undefined, 'acli is only offered once a site is set');
});

test('the hook shows exactly the entry it will add, and where, before anything is written, and installs that entry', async () => {
  const { page, posts } = await setupPage(FAILING);
  const hook = card(page, 'hook');
  assert.deepEqual(JSON.parse(hook.querySelector('.setup-entry').textContent), ENTRY);
  assert.match(hook.querySelector('.setup-fix .hint').textContent, /\/home\/sybil\/\.claude\/settings\.json\. Every hook already there stays\./);
  assert.deepEqual(posts, []);
  page.$('#setup-hook-install').click();
  await page.settle(100);
  assert.deepEqual(posts, [['/api/setup/hook', { command: ENTRY.hooks[0].command, replaces: null }]]);
  const installed = await setupPage(PASSING);
  assert.equal(installed.page.$('#setup-hook-install'), null);
});

test('an old hook whose script is gone is offered as an update in place, sending the command it replaces', async () => {
  const old = "ELECTRON_RUN_AS_NODE=1 '/Applications/Old.app/Contents/MacOS/Old' '/Applications/Old.app/Contents/Resources/worker/lib/record-artifact.mjs'";
  const stale = FAILING.map((c) => (c.id === 'hook' ? { ...c, detail: 'The hook runs a script that is gone.', replaces: old } : c));
  const { page, posts } = await setupPage(stale);
  const hook = card(page, 'hook');
  assert.match(hook.querySelector('.setup-fix .hint').textContent, /^Changes the command of the old entry .* to this one\. Every other hook stays\./);
  assert.equal(page.$('#setup-hook-install').textContent, 'Update the hook');
  page.$('#setup-hook-install').click();
  await page.settle(100);
  assert.deepEqual(posts, [['/api/setup/hook', { command: ENTRY.hooks[0].command, replaces: old }]]);
});

test('agent commands show built in or your own, and each saves on its own', async () => {
  const { page, posts } = await setupPage(PASSING);
  assert.equal(page.$('#setup-agent-reviewCommand').getAttribute('value'), '/review');
  assert.equal(page.$('#setup-agent-kickoffCommand').getAttribute('placeholder'), 'Built in');
  buttonIn(card(page, 'agents'), 'Use built in').click();
  await page.settle(100);
  assert.deepEqual(posts, [['/api/matrix/agent-commands', { agents: { reviewCommand: '' } }]]);
});

test('Done for now says setup is done and goes to the overview; once done it is not offered again', async () => {
  const { page, posts } = await setupPage(FAILING);
  buttonIn(page.$('.setup-done'), 'Done for now').click();
  await page.settle(100);
  assert.deepEqual(posts, [['/api/setup/done', {}]]);
  assert.equal(page.window.location.hash, '#overview');
  const done = await setupPage(FAILING, { done: true });
  assert.equal(buttonIn(done.page.$('.setup-done'), 'Done for now'), undefined);
});

test('a first run opens Setup by itself, once, and only from a tab that has not gone anywhere yet', async () => {
  const page = await openPage({ respond: (path) => (path === '/api/setup' ? { done: false, checks: FAILING } : null) });
  page.show(snapshot({ setup: { pending: true } }), '');
  page.run('location.hash = ""; refresh()');
  await page.settle(400);
  assert.equal(page.window.location.hash, '#setup');
  page.run('location.hash = "#tickets"; refresh()');
  await page.settle(400);
  assert.equal(page.window.location.hash, '#tickets', 'not a second time');
  const elsewhere = await openPage();
  elsewhere.show(snapshot({ setup: { pending: true } }), 'merge-requests');
  elsewhere.run('refresh()');
  await elsewhere.settle(400);
  assert.equal(elsewhere.window.location.hash, '#merge-requests');
  const settled = await openPage();
  settled.show(snapshot({ setup: { pending: false } }), '');
  settled.run('location.hash = ""; refresh()');
  await settled.settle(400);
  assert.equal(settled.window.location.hash, '');
});

test('Set up is in Jump to', async () => {
  const page = await openPage();
  page.show(snapshot());
  const entry = JSON.parse(page.run("JSON.stringify(goKeys().filter((k) => k.id === 'go:setup').map(({ label, icon, terms }) => ({ label, icon, terms })))"));
  assert.deepEqual(entry.map((e) => e.label), ['Set up']);
  assert.ok(entry[0].terms.includes('token'));
});
