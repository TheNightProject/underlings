import assert from 'node:assert/strict';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const home = await mkdtemp(join(tmpdir(), 'control-centre-setup-'));
const bin = join(home, 'bin');
const root = join(home, 'work');
process.env.HOME = home;
process.env.PATH = `${bin}:/usr/bin:/bin`;
delete process.env.CLAUDE_CONFIG_DIR;
delete process.env.UNDERLINGS_CLAUDE_BIN;
delete process.env.UNDERLINGS_ACLI;
after(() => rm(home, { recursive: true, force: true }));

const testkit = new URL('./testkit.mjs', import.meta.url).href;
const ENGINE = `
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { world } from '${testkit}';
export * from '${testkit}';
export const loadState = () => ({ watches: {}, settings: world.settings });
export const agentCommands = () => ({ reviewCommand: '', selfReviewCommand: '', kickoffCommand: '', ...world.settings.agents });
export function updateSettings(patch) {
  world.calls.push(['updateSettings', patch]);
  const ok = patch.agents && typeof patch.agents === 'object';
  if (ok) world.settings.agents = { ...world.settings.agents, ...patch.agents };
  return { settings: world.settings, applied: ok ? ['agents'] : [], dropped: ok ? [] : Object.keys(patch) };
}
export function discoverCheckouts(dir) {
  return readdirSync(dir).filter((n) => statSync(join(dir, n, '.git'), { throwIfNoEntry: false })?.isDirectory()).map((n) => ({ dir: n, path: null }));
}
`;
const enginePath = join(home, 'engine.mjs');
await writeFile(enginePath, ENGINE);
const { loadEngine } = await import('./engine.mjs');
const { reset, world } = await import('./testkit.mjs');
await loadEngine({ matrixEngine: enginePath }, () => {});
const setup = await import('./setup.mjs');
const { act } = await import('./actions.mjs');

const settingsFile = join(home, '.claude', 'settings.json');
const SCRIPT = fileURLToPath(new URL('./record-artifact.mjs', import.meta.url));
let gitlab = {};
const asked = [];
const origins = [];
const GITLAB_HOST = 'https://gitlab.com';
globalThis.fetch = async (url, init = {}) => {
  asked.push([new URL(url).pathname, init.headers?.['PRIVATE-TOKEN']]);
  origins.push(new URL(url).origin);
  const answer = gitlab[new URL(url).pathname];
  if (answer instanceof Error) throw answer;
  const [status, body] = answer ?? [404, null];
  return { ok: status === 200, status, json: async () => body };
};

async function tool(name, script) {
  await mkdir(bin, { recursive: true });
  const path = join(bin, name);
  await writeFile(path, `#!/bin/sh\n${script}\n`);
  await chmod(path, 0o755);
}

const check = async (id) => (await setup.readSetup()).checks.find((c) => c.id === id);
const states = async (id) => {
  const c = await check(id);
  return [c.state, c.detail];
};

beforeEach(async () => {
  await rm(bin, { recursive: true, force: true });
  await rm(root, { recursive: true, force: true });
  await rm(join(home, '.claude'), { recursive: true, force: true });
  await rm(join(home, '.config'), { recursive: true, force: true });
  reset({ settings: { workspaceRoot: root, jiraSite: '' } });
  process.env.GITLAB_TOKEN = 'gl-fake-test-token-000000';
  gitlab = { '/api/v4/user': [200, { username: 'sybil' }], '/api/v4/personal_access_tokens/self': [200, { scopes: ['api', 'read_user'] }] };
  asked.length = 0;
  await setup.start({});
});

test('Claude Code fails when it is not installed, and when it is installed but signed out, and passes signed in', async () => {
  const missing = await check('claude');
  assert.deepEqual([missing.state, missing.link], ['fail', setup.LINKS.claude]);
  assert.match(missing.detail, /not installed/);
  await tool('claude', `echo '{"loggedIn": false, "authMethod": "none"}'; exit 1`);
  const out = await check('claude');
  assert.deepEqual([out.state, out.command], ['fail', 'claude auth login']);
  assert.match(out.detail, /not signed in/);
  await tool('claude', `[ "$*" = "auth status --json" ] && echo '{"loggedIn": true, "email": "sybil@example.com", "subscriptionType": "max"}'`);
  assert.deepEqual(await states('claude'), ['pass', 'Signed in as sybil@example.com, max.']);
});

test('the GitLab token fails with none, a refused one or one without the api scope, and passes with api, asking GitLab with that token', async () => {
  delete process.env.GITLAB_TOKEN;
  const none = await check('gitlab');
  assert.deepEqual([none.state, none.scope, none.link, none.token], ['fail', 'api', setup.tokenLink(GITLAB_HOST), true]);
  assert.match(setup.tokenLink(GITLAB_HOST), /^https:\/\/gitlab\.com\/-\/user_settings\/personal_access_tokens\?scopes=api$/);
  assert.deepEqual(asked, [], 'no token, no call');
  process.env.GITLAB_TOKEN = 'gl-fake-test-token-000000';
  gitlab['/api/v4/user'] = [401, null];
  assert.match((await states('gitlab'))[1], /GitLab refused this token/);
  gitlab['/api/v4/user'] = [200, { username: 'sybil' }];
  gitlab['/api/v4/personal_access_tokens/self'] = [200, { scopes: ['read_api'] }];
  assert.deepEqual(await states('gitlab'), ['fail', 'Signed in to GitLab as sybil, but the token has read_api. Posting what you approve needs api.']);
  gitlab['/api/v4/personal_access_tokens/self'] = [200, { scopes: ['api'] }];
  assert.deepEqual(await states('gitlab'), ['pass', 'Signed in to GitLab as sybil, with the api scope.']);
  assert.ok(asked.every(([, token]) => token === 'gl-fake-test-token-000000'));
  gitlab['/api/v4/user'] = new Error('getaddrinfo ENOTFOUND gitlab.test');
  assert.deepEqual(await states('gitlab'), ['fail', 'GitLab did not answer: getaddrinfo ENOTFOUND gitlab.test']);
});

test('a GitLab of your own is asked at its host, says so, and links to its own token page', async () => {
  process.env.GITLAB_TOKEN = 'gl-fake-test-token-000000';
  world.settings.gitlab = { host: 'https://git.acme.test' };
  gitlab['/api/v4/user'] = [200, { username: 'sybil' }];
  gitlab['/api/v4/personal_access_tokens/self'] = [200, { scopes: ['api'] }];
  origins.length = 0;
  const own = await check('gitlab');
  assert.deepEqual([own.state, own.detail, own.host, own.link], ['pass', 'Signed in to GitLab at git.acme.test as sybil, with the api scope.', 'https://git.acme.test', 'https://git.acme.test/-/user_settings/personal_access_tokens?scopes=api']);
  assert.deepEqual([...new Set(origins)], ['https://git.acme.test']);
  delete world.settings.gitlab;
});

test('Jira is off until a site is set, then fails without acli or signed out, and passes signed in', async () => {
  const off = await check('jira');
  assert.deepEqual([off.state, off.optional], ['off', true]);
  world.settings.jiraSite = 'acme.atlassian.net';
  assert.match((await states('jira'))[1], /acli, the Atlassian command line it is read through, is not installed/);
  await tool('acli', 'echo "x Not logged in"');
  const out = await check('jira');
  assert.deepEqual([out.state, out.command], ['fail', 'acli jira auth login --web']);
  await tool('acli', '[ "$*" = "jira auth status" ] && echo "✓ Authenticated"');
  assert.deepEqual(await states('jira'), ['pass', 'Tickets are read from acme.atlassian.net through acli.']);
});

test('the workspace root fails unset, missing or with no checkouts, and passes saying how many it found', async () => {
  world.settings.workspaceRoot = '';
  const was = process.env.ORCA_WORKSPACE_ROOT;
  delete process.env.ORCA_WORKSPACE_ROOT;
  try {
    assert.deepEqual(await states('workspace'), ['fail', 'Not set. Agents start in this folder, and find your clones in it.']);
  } finally {
    if (was !== undefined) process.env.ORCA_WORKSPACE_ROOT = was;
  }
  world.settings.workspaceRoot = root;
  assert.match((await states('workspace'))[1], /is not a folder on this Mac/);
  await mkdir(join(root, 'notes'), { recursive: true });
  assert.match((await states('workspace'))[1], /^No git checkouts found under /);
  for (const name of ['engine', 'web']) await mkdir(join(root, name, '.git'), { recursive: true });
  const found = await check('workspace');
  assert.deepEqual([found.state, found.detail, found.checkouts, found.names], ['pass', `2 checkouts found under ${root}.`, 2, ['engine', 'web']]);
});

test('agent commands pass either way, saying which are your own, and are saved through the engine\'s settings', async () => {
  assert.deepEqual(await states('agents'), ['pass', 'Every agent uses the built-in prompts.']);
  const saved = await act('agent-commands', { agents: { reviewCommand: '/review' } });
  assert.equal(saved.text, 'Saved: review /review');
  assert.deepEqual(await states('agents'), ['pass', 'Your own review command; the rest use the built-in prompts.']);
  await assert.rejects(act('agent-commands', { agents: 'x' }), /agents takes reviewCommand/);
});

test('the artifact hook fails until installed, shows what it will write first, and the install adds exactly one entry and keeps every other hook', async () => {
  const before = { model: 'opus', hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard.sh' }] }], PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'fmt.sh' }] }] } };
  await mkdir(join(home, '.claude'), { recursive: true });
  await writeFile(settingsFile, JSON.stringify(before), { mode: 0o644 });
  const missing = await check('hook');
  assert.equal(missing.state, 'fail');
  const plan = await setup.hookPlan();
  assert.deepEqual(plan.entry, { matcher: 'Artifact', hooks: [{ type: 'command', command: `ELECTRON_RUN_AS_NODE=1 '${process.execPath}' '${SCRIPT}'`, timeout: 10 }] });
  assert.equal(JSON.parse(await readFile(settingsFile, 'utf8')).hooks.PostToolUse.length, 1, 'looking writes nothing');
  await assert.rejects(setup.installHook({ command: 'something else' }), /changed since you looked/);
  await setup.installHook({ command: plan.entry.hooks[0].command });
  const after = JSON.parse(await readFile(settingsFile, 'utf8'));
  assert.deepEqual(after, { ...before, hooks: { ...before.hooks, PostToolUse: [...before.hooks.PostToolUse, plan.entry] } });
  assert.equal((await stat(settingsFile)).mode & 0o777, 0o644, 'the file keeps its mode');
  assert.equal((await check('hook')).state, 'pass');
  assert.match((await setup.installHook({ command: plan.entry.hooks[0].command })).text, /already in/);
  assert.equal(JSON.parse(await readFile(settingsFile, 'utf8')).hooks.PostToolUse.length, 2, 'a second install adds nothing');
  assert.ok((await stat(SCRIPT)).isFile(), 'the script it names ships under lib/');
});

test('a hook whose script has gone, left by the app before it moved, is updated in place, and one that still runs passes as it is', async () => {
  const gone = "ELECTRON_RUN_AS_NODE=1 '/Applications/Old Name.app/Contents/MacOS/Old Name' '/Applications/Old Name.app/Contents/Resources/worker/lib/record-artifact.mjs'";
  const before = { hooks: { PostToolUse: [{ matcher: 'Edit', hooks: [{ type: 'command', command: 'fmt.sh' }] }, { matcher: 'Artifact', hooks: [{ type: 'command', command: gone, timeout: 10 }] }] } };
  await mkdir(join(home, '.claude'), { recursive: true });
  await writeFile(settingsFile, JSON.stringify(before));
  const stale = await check('hook');
  assert.deepEqual([stale.state, stale.replaces], ['fail', gone]);
  assert.match(stale.detail, /runs \/Applications\/Old Name\.app\/.*record-artifact\.mjs, which is no longer there.*Update it in place\./);
  const plan = await setup.hookPlan();
  assert.equal(plan.replaces, gone);
  await assert.rejects(setup.installHook({ command: plan.entry.hooks[0].command }), /changed since you looked/, 'an add where the page showed an update');
  assert.match((await setup.installHook({ command: plan.entry.hooks[0].command, replaces: gone })).text, /^Updated the artifact hook/);
  const after = JSON.parse(await readFile(settingsFile, 'utf8')).hooks.PostToolUse;
  assert.deepEqual(after, [before.hooks.PostToolUse[0], { matcher: 'Artifact', hooks: [plan.entry.hooks[0]] }], 'in the same place, with nothing added');
  assert.equal((await check('hook')).state, 'pass');
  const checkout = { hooks: { PostToolUse: [{ matcher: 'Artifact', hooks: [{ type: 'command', command: `/opt/homebrew/bin/node ${SCRIPT}` }] }] } };
  await writeFile(settingsFile, JSON.stringify(checkout));
  assert.equal((await check('hook')).state, 'pass', 'a hook run by a node of your own from a checkout that is still there');
});

test('the hook installer makes the file when there is none, and never writes over one that is not JSON', async () => {
  const { entry } = await setup.hookPlan();
  await setup.installHook({ command: entry.hooks[0].command });
  assert.deepEqual(JSON.parse(await readFile(settingsFile, 'utf8')), { hooks: { PostToolUse: [entry] } });
  await writeFile(settingsFile, '{ "hooks": ');
  await assert.rejects(setup.installHook({ command: entry.hooks[0].command }), /is not valid JSON, so nothing is written/);
  assert.equal(await readFile(settingsFile, 'utf8'), '{ "hooks": ');
  assert.match((await states('hook'))[1], /is not valid JSON/);
});

test('Setup opens on its own until it is done, and stays done after a restart', async () => {
  assert.equal(setup.pending(), true);
  await setup.ROUTES['POST /api/setup/done']();
  assert.equal(setup.pending(), false);
  await setup.start({});
  assert.equal(setup.pending(), false, 'and it stays done after a restart');
});
