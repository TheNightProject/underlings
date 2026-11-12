import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
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
const MARKET = fileURLToPath(new URL('../plugin', import.meta.url));
const ENGINE = `
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { world } from '${testkit}';
export * from '${testkit}';
export const skillsPlugin = () => ({ id: 'underlings@underlings', marketplaceName: 'underlings', marketplace: '${MARKET}', dir: '${MARKET}/underlings' });
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
  assert.deepEqual(await states('agents'), ['pass', 'Every agent uses the Underlings skills.']);
  const saved = await act('agent-commands', { agents: { reviewCommand: '/review' } });
  assert.equal(saved.text, 'Saved: review /review');
  assert.deepEqual(await states('agents'), ['pass', 'Your own review command; the rest use the Underlings skills.']);
  await assert.rejects(act('agent-commands', { agents: 'x' }), /agents takes reviewCommand/);
});

const PLUGIN_ID = 'underlings@underlings';
const BUNDLED = JSON.parse(await readFile(join(MARKET, 'underlings/.claude-plugin/plugin.json'), 'utf8')).version;
const claudeLog = join(home, 'claude.log');
const readLog = async () => (await readFile(claudeLog, 'utf8').catch(() => '')).split('\n').filter(Boolean);

// Stands in for claude: answers the plugin list from a file, fails any call named in another, and writes down every call and whether a forge token came with it.
async function fakeClaude({ list = [], fails = '' } = {}) {
  await writeFile(join(home, 'plugins.json'), JSON.stringify(list));
  await writeFile(join(home, 'claude.fails'), fails);
  await tool('claude', [
    `echo "$* token=\${GITLAB_TOKEN:-none}" >> '${claudeLog}'`,
    `[ "$*" = "auth status --json" ] && { echo '{"loggedIn": true}'; exit 0; }`,
    `[ "$*" = "plugin list --json" ] && { cat '${join(home, 'plugins.json')}'; exit 0; }`,
    `[ -s '${join(home, 'claude.fails')}' ] && echo "$*" | grep -q -f '${join(home, 'claude.fails')}' && { echo "Error: $(cat '${join(home, 'claude.fails')}')" >&2; exit 1; }`,
    'exit 0',
  ].join('\n'));
}
const installed = (extra = {}) => ({ id: PLUGIN_ID, version: BUNDLED, scope: 'user', enabled: true, ...extra });
const skills = () => check('skills');

test('the skills check is optional: off until installed, then ready at the version the app ships, and a different version or a switched-off plugin say so', async () => {
  assert.deepEqual(await states('skills'), ['off', 'Needs Claude Code first. Your agents load the skills on their own either way.'], 'nothing to run without Claude Code');
  await fakeClaude();
  const off = await skills();
  assert.deepEqual([off.state, off.optional, off.installed, off.plan.action], ['off', true, false, 'install']);
  assert.match(off.detail, /^Optional\. Your agents load the skills on their own\./);
  assert.equal(off.remove, undefined, 'nothing to remove yet');
  await fakeClaude({ list: [installed()] });
  const ready = await skills();
  assert.deepEqual([ready.state, ready.detail, ready.plan], ['pass', `Installed in your Claude Code, version ${BUNDLED}. Type /underlings: there to see them.`, undefined]);
  assert.deepEqual(ready.remove.commands, [`claude plugin uninstall ${PLUGIN_ID} --scope user`, 'claude plugin marketplace remove underlings --scope user']);
  await fakeClaude({ list: [installed({ version: '0.9.0' })] });
  const old = await skills();
  assert.deepEqual([old.state, old.detail, old.plan.action], ['fail', `Your Claude Code has version 0.9.0; this app has ${BUNDLED}.`, 'update']);
  await fakeClaude({ list: [installed({ enabled: false })] });
  assert.deepEqual([(await skills()).state, (await skills()).plan.action], ['off', 'enable']);
  await fakeClaude({ list: [installed({ scope: 'project' }), { id: 'other@elsewhere', version: BUNDLED }] });
  assert.equal((await skills()).installed, false, 'one installed for a project, or someone else\'s, is not yours');
  await tool('claude', `[ "$*" = "auth status --json" ] && echo '{"loggedIn": true}'\n[ "$*" = "plugin list --json" ] && { echo "boom" >&2; exit 1; }`);
  assert.match((await states('skills'))[1], /^Claude Code did not say which plugins you have: boom/);
});

test('installing shows its two commands first, runs exactly those, and runs nothing else of your Claude Code, with no forge token in its hands', async () => {
  await fakeClaude();
  const { plan } = await skills();
  assert.deepEqual(plan.commands, [`claude plugin marketplace add ${MARKET} --scope user`, `claude plugin install ${PLUGIN_ID} --scope user`]);
  assert.ok((await readLog()).every((line) => /^(auth status|plugin list)/.test(line)), 'looking changed nothing');
  await assert.rejects(setup.changeSkills({ action: 'install', commands: ['claude plugin install something-else'] }), /changed since you looked/);
  await assert.rejects(setup.changeSkills({ action: 'rm -rf', commands: [] }), /action is install, update, enable or remove/);
  const before = (await readLog()).length;
  assert.equal((await setup.ROUTES['POST /api/setup/skills']({ body: async () => ({ action: 'install', commands: plan.commands }) })).text, 'Added the Underlings skills to your Claude Code. Start a new session and type /underlings: to see them');
  assert.deepEqual((await readLog()).slice(before), [`plugin marketplace add ${MARKET} --scope user token=none`, `plugin install ${PLUGIN_ID} --scope user token=none`]);
  assert.ok(!existsSync(join(home, '.claude')), 'the stub wrote nothing, and the app wrote nothing to Claude Code\'s own folder either');
});

test('update, turning on and removing each run their own commands in order, and a step that fails stops there and says what claude said', async () => {
  const run = async (action) => {
    await fakeClaude();
    await setup.changeSkills({ action, commands: setup.skillsPlan(action).commands });
    return (await readLog()).filter((line) => !/^(auth status|plugin list)/.test(line)).map((line) => line.replace(/ token=none$/, ''));
  };
  await rm(claudeLog, { force: true });
  assert.deepEqual(await run('update'), ['plugin marketplace update underlings', `plugin update ${PLUGIN_ID} --scope user`]);
  await rm(claudeLog, { force: true });
  assert.deepEqual(await run('enable'), [`plugin enable ${PLUGIN_ID} --scope user`]);
  await rm(claudeLog, { force: true });
  assert.deepEqual(await run('remove'), [`plugin uninstall ${PLUGIN_ID} --scope user`, 'plugin marketplace remove underlings --scope user']);
  await rm(claudeLog, { force: true });
  await fakeClaude({ fails: 'marketplace update' });
  await assert.rejects(setup.changeSkills({ action: 'update', commands: setup.skillsPlan('update').commands }), (err) => err.status === 502 && /claude plugin marketplace update did not finish: Error: marketplace update\. If the app has moved, remove the skills and install them again\./.test(err.message));
  assert.ok(!(await readLog()).some((line) => line.startsWith('plugin update')), 'the second step never ran');
});

test('installing again is no failure when claude says it is already there, and any other refusal is', async () => {
  const commands = setup.skillsPlan('install').commands;
  await tool('claude', `[ "$*" = "auth status --json" ] && { echo '{"loggedIn": true}'; exit 0; }\necho "already added" >&2; exit 1`);
  assert.match((await setup.changeSkills({ action: 'install', commands })).text, /^Added the Underlings skills/);
  await tool('claude', `echo "no space left" >&2; exit 1`);
  await assert.rejects(setup.changeSkills({ action: 'install', commands }), /claude plugin marketplace add did not finish: no space left/);
  await rm(bin, { recursive: true, force: true });
  await assert.rejects(setup.changeSkills({ action: 'install', commands }), /Claude Code is not installed/);
});

test('Setup lists the skills between the agent commands and the hook, so the summary counts only what the app needs', async () => {
  await fakeClaude();
  const { checks } = await setup.readSetup();
  assert.deepEqual(checks.map((c) => c.id), ['claude', 'gitlab', 'github', 'jira', 'workspace', 'agents', 'skills', 'hook']);
  assert.equal(checks.find((c) => c.id === 'skills').optional, true);
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
