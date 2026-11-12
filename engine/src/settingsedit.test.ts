import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'thematrix-settingsedit-'));
process.env['UNDERLINGS_STATE_DIR'] = dir;
process.env['GITLAB_TOKEN'] = 'not-a-real-token';

const { rediscoverRepos, repoMatch, updateSettings } = await import('./settingsedit.js');
const { loadSettings, saveRepoCache, saveState, loadState } = await import('./data/store.js');

const stored = (): Record<string, unknown> =>
  (JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as { settings: Record<string, unknown> }).settings;

let groups: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input);
  const body = url.includes('/merge_requests') ? groups.map((full) => ({ references: { full } })) : [{ full_path: 'acme' }];
  return new Response(JSON.stringify(url.includes('page=1') || !url.includes('/merge_requests') ? body : []), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}) as typeof fetch;

after(() => {
  globalThis.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  rmSync(join(dir, 'state.json'), { force: true });
  rmSync(join(dir, 'repos.json'), { force: true });
  groups = [];
});

test('a key that is not a settings row is dropped, and so is who is in full auto', () => {
  saveState({ ...loadState(), settings: { animate: true } as never });
  const { applied, dropped } = updateSettings({ jiraSite: 'acme.atlassian.net', bogus: 1, fullAuto: 'mallory:verdict' });
  assert.deepEqual(applied, ['jiraSite']);
  assert.deepEqual(dropped, ['bogus', 'fullAuto']);
  assert.equal(stored()['bogus'], undefined);
  assert.equal(stored()['fullAuto'], '');
  assert.equal(stored()['animate'], true, 'a stored key the rows do not list is kept');
});

test('a patch with nothing it takes writes nothing, so a refusal never rewrites what is stored', () => {
  saveState({ ...loadState(), settings: { pollSeconds: '15' } as never });
  const { applied, dropped } = updateSettings({ bogus: 1, pollSeconds: 'soon' });
  assert.deepEqual([applied, dropped], [[], ['bogus', 'pollSeconds']]);
  assert.deepEqual(stored(), { pollSeconds: '15' });
});

test('a number is clamped to its row\'s bounds and rounded', () => {
  updateSettings({ pollSeconds: 5, leaderboardDays: 9999, autoMaxComments: 2.6 });
  assert.deepEqual([stored()['pollSeconds'], stored()['leaderboardDays'], stored()['autoMaxComments']], [15, 365, 3]);
  updateSettings({ autoHoldSeconds: 'soon', autoMaxDiffLines: '' });
  assert.equal(loadSettings().autoHoldSeconds, 120, 'a number that does not parse leaves the old value');
});

test('a pollSeconds the TUI saved as the string \'15\' is stored as the number 15 by the next save', () => {
  saveState({ ...loadState(), settings: { pollSeconds: '15' } as never });
  updateSettings({ jiraSite: 'acme.atlassian.net' });
  assert.equal(stored()['pollSeconds'], 15);
  updateSettings({ pollSeconds: '30' });
  assert.equal(stored()['pollSeconds'], 30);
});

test('a switch takes true or false only, and text is trimmed', () => {
  const { dropped } = updateSettings({ holdWhileReviewing: 'false', autoFooter: 'maybe', workspaceRoot: '  /work  ' });
  assert.deepEqual(dropped, ['autoFooter']);
  assert.equal(stored()['holdWhileReviewing'], false);
  assert.equal(stored()['autoFooter'], false);
  assert.equal(stored()['workspaceRoot'], '/work');
});

test('a choice takes only the values it offers, and the spend cap only an amount of dollars or blank', () => {
  const { applied, dropped } = updateSettings({ agentPermissions: 'auto', agentHost: 'vm', agentBudgetUsd: '2.50' });
  assert.deepEqual([applied, dropped], [['agentPermissions', 'agentBudgetUsd'], ['agentHost']]);
  assert.deepEqual([stored()['agentPermissions'], stored()['agentHost'], stored()['agentBudgetUsd']], ['auto', 'claude', '2.50']);
  assert.deepEqual(updateSettings({ agentBudgetUsd: 'lots' }).dropped, ['agentBudgetUsd']);
  assert.deepEqual(updateSettings({ agentBudgetUsd: '' }).applied, ['agentBudgetUsd']);
  assert.equal(stored()['agentBudgetUsd'], '');
});

test('looking for repos again saves what GitLab lists, and keeps the known list when it lists nothing', async () => {
  groups = ['acme/engine!1', 'acme/engine!2', 'acme/web!3'];
  const found = await rediscoverRepos();
  assert.deepEqual(found.map((r) => r.path), ['acme/engine', 'acme/web']);
  groups = [];
  assert.deepEqual(await rediscoverRepos(), []);
  const cache = JSON.parse(readFileSync(join(dir, 'repos.json'), 'utf8')) as { repos: { path: string }[] };
  assert.deepEqual(cache.repos.map((r) => r.path), ['acme/engine', 'acme/web']);
});

test('the filter preview counts against the last list found, however old, at the poll it will run at', () => {
  saveRepoCache([{ path: 'acme/engine', label: 'Engine' }, { path: 'acme/web', label: 'Web' }, { path: 'other/x', label: 'X' }]);
  const cache = JSON.parse(readFileSync(join(dir, 'repos.json'), 'utf8')) as { at: string };
  writeFileSync(join(dir, 'repos.json'), JSON.stringify({ ...cache, at: '2020-01-01T00:00:00Z' }));
  const match = repoMatch('acme', '15');
  assert.deepEqual([match.total, match.matching, match.discoveredAt], [3, ['acme/engine', 'acme/web'], '2020-01-01T00:00:00Z']);
  assert.equal(match.perMinute, match.perRefresh * 4);
  assert.equal(repoMatch('acme', 1).perMinute, match.perMinute, 'a poll under the floor is costed at the floor');
});

test('the page-only Jira, ticket and GitLab rows save by their dotted keys, tidied, and never show in the terminal', async () => {
  const { NESTED_ROWS, TERMINAL_ROWS } = await import('./settings.js');
  const { loadSettings } = await import('./data/store.js');
  const { updateSettings } = await import('./settingsedit.js');
  const { applied, dropped } = updateSettings({ 'jira.projects': 'abc, ops', 'jira.defaultProject': 'abc', 'jira.doneStatuses': ' Done ,, Closed ', 'gitlab.host': 'git.acme.test/', 'tickets.noQaPaths': 'acme/tooling', 'jira.ticketTemplate': '# Context\r\n# Change\nShort.' });
  assert.deepEqual([applied.length, dropped], [6, []]);
  const { jira, gitlab, tickets } = loadSettings();
  assert.deepEqual([jira.projects, jira.defaultProject, jira.doneStatuses, gitlab.host, tickets.noQaPaths, jira.ticketTemplate], ['ABC, OPS', 'ABC', 'Done, Closed', 'https://git.acme.test', 'acme/tooling', '# Context\n# Change\nShort.']);
  assert.equal(jira.issueType, 'Task', 'a nested setting not in the patch stays');
  assert.deepEqual(updateSettings({ 'jira.projects': 'ABC-1', 'jira.defaultProject': 'ABC, OPS', 'gitlab.host': 'https://x.test/?a=1' }).dropped, ['jira.projects', 'jira.defaultProject', 'gitlab.host']);
  assert.deepEqual(updateSettings({ 'gitlab.host': 'ftp://git.acme.test' }).dropped, ['gitlab.host']);
  updateSettings({ 'jira.projects': 'ops abc, Ops' });
  assert.equal(loadSettings().jira.projects, 'OPS, ABC', 'spaces separate too, and a key named twice is kept once');
  assert.deepEqual(TERMINAL_ROWS.filter((row) => NESTED_ROWS.some((n) => (n.key as string) === (row.key as string))), []);
});
