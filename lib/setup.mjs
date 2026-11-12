import { existsSync } from 'node:fs';
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { onPath } from './claudeterm.mjs';
import { DEFAULT_GITLAB_HOST, engine, failure, githubOn, gitlabHost, requireEngine, supports, workspaceRoot } from './engine.mjs';
import { readJson, run, shellQuoted, withoutForgeTokens } from './run.mjs';
import { configDir } from './home.mjs';

const HOOK_SCRIPT = fileURLToPath(new URL('./record-artifact.mjs', import.meta.url));
const HOOK_MARK = 'record-artifact.mjs';
const HOOK_TIMEOUT_S = 10;
const CHECK_MS = 15_000;
const SKILLS_MS = 120_000;
const SKILLS_SCOPE = 'user';
const SCOPE = 'api';
const GITHUB_SCOPES = ['repo', 'read:org'];
const GITHUB_SOURCES = { saved: 'the token pasted here', GITHUB_TOKEN: 'GITHUB_TOKEN in your shell profile', GH_TOKEN: 'GH_TOKEN in your shell profile', gh: 'gh auth token' };
export const LINKS = {
  claude: 'https://docs.claude.com/en/docs/claude-code/setup',
  acli: 'https://developer.atlassian.com/cloud/acli/guides/install-acli/',
};
export const tokenLink = (host = gitlabHost()) => `${host}/-/user_settings/personal_access_tokens?scopes=api`;
export const githubTokenLink = (web = 'https://github.com') => `${web}/settings/tokens/new?scopes=${GITHUB_SCOPES.join(',')}&description=Underlings`;
const COMMAND_NAMES = { reviewCommand: 'review', selfReviewCommand: 'self-review', kickoffCommand: 'kickoff' };

let config = {};
let done = false;

const doneFile = () => join(configDir(), 'setup.json');
const claudeSettingsFile = () => join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude'), 'settings.json');

export const ROUTES = {
  'GET /api/setup': () => readSetup(),
  'POST /api/setup/done': () => finish(),
  'GET /api/setup/hook': () => hookPlan(),
  'POST /api/setup/hook': async ({ body }) => installHook(await body()),
  'POST /api/setup/skills': async ({ body }) => changeSkills(await body()),
};

export const ACTIONS = { 'agent-commands': saveAgentCommands };

export async function start(cfg) {
  config = cfg ?? {};
  done = Boolean((await readJson(doneFile()))?.doneAt);
}

export function pending() {
  return !done;
}

async function finish() {
  await mkdir(dirname(doneFile()), { recursive: true });
  await writeFile(doneFile(), `${JSON.stringify({ doneAt: new Date().toISOString() })}\n`, { mode: 0o600 });
  done = true;
  return { ok: true, text: 'Setup is done. It stays under Settings and Jump to' };
}

export async function readSetup() {
  const checks = await Promise.all([claudeCheck(), gitlabCheck(), githubCheck(), jiraCheck(), workspaceCheck(), agentsCheck(), skillsCheck(), hookCheck()]);
  return { done, checks };
}

const result = (id, state, title, detail, extra = {}) => ({ id, state, title, detail, ...extra });

const firstLine = (text) => String(text ?? '').trim().split('\n')[0].slice(0, 200);

function said(err) {
  return firstLine(err?.stdout) || firstLine(err?.stderr) || firstLine(err?.message) || 'no answer';
}

async function claudeBinaryPath() {
  const named = supports('claudeBinary') ? engine.claudeBinary() : 'claude';
  return named.includes('/') ? named : onPath(named, process.env.PATH);
}

// Signed out may exit non-zero with its JSON still printed, so the output is read either way.
function authStatus(bin) {
  const parsed = (text) => {
    try {
      return JSON.parse(text ?? '');
    } catch {
      return null;
    }
  };
  return run(bin, ['auth', 'status', '--json'], process.env, { timeout: CHECK_MS }).then(parsed, (err) => parsed(err.stdout) ?? { error: said(err) });
}

async function claudeCheck() {
  const bin = await claudeBinaryPath();
  if (!bin) return result('claude', 'fail', 'Claude Code', 'Claude Code is not installed, or not on your login shell\'s PATH. Every agent runs as Claude Code.', { link: LINKS.claude });
  const status = (await authStatus(bin)) ?? { error: 'its answer was not JSON' };
  if (status.error) return result('claude', 'fail', 'Claude Code', `Claude Code did not say whether you are signed in: ${status.error}`, { command: 'claude auth login', link: LINKS.claude });
  if (!status.loggedIn) return result('claude', 'fail', 'Claude Code', 'Claude Code is installed but not signed in. Sign in once in a terminal, then check again.', { command: 'claude auth login' });
  return result('claude', 'pass', 'Claude Code', `Signed in${status.email ? ` as ${status.email}` : ''}${status.subscriptionType ? `, ${status.subscriptionType}` : ''}.`);
}

async function gitlab(host, path, token) {
  const res = await fetch(`${host}/api/v4${path}`, { headers: { 'PRIVATE-TOKEN': token }, signal: AbortSignal.timeout(CHECK_MS) });
  return { status: res.status, body: res.ok ? await res.json() : null };
}

async function gitlabCheck() {
  const token = process.env.GITLAB_TOKEN;
  const host = gitlabHost();
  const base = { scope: SCOPE, link: tokenLink(host), token: true, host, defaultHost: DEFAULT_GITLAB_HOST };
  if (!token) return result('gitlab', 'fail', 'GitLab token', `No token yet. Make a personal access token with the ${SCOPE} scope${atHost(host)} and paste it here.`, base);
  try {
    const [user, self] = await Promise.all([gitlab(host, '/user', token), gitlab(host, '/personal_access_tokens/self', token)]);
    return tokenResult(user, self, base);
  } catch (err) {
    return result('gitlab', 'fail', 'GitLab token', `GitLab${atHost(host)} did not answer: ${said(err)}`, base);
  }
}

const atHost = (host) => (host === DEFAULT_GITLAB_HOST ? '' : ` at ${new URL(host).host}`);

function tokenResult(user, self, base) {
  if (user.status === 401) return result('gitlab', 'fail', 'GitLab token', 'GitLab refused this token: it is wrong, revoked or expired. Paste a new one.', base);
  if (!user.body) return result('gitlab', 'fail', 'GitLab token', `GitLab answered ${user.status} when asked who the token belongs to.`, base);
  const scopes = Array.isArray(self.body?.scopes) ? self.body.scopes : null;
  const who = `Signed in to GitLab${atHost(base.host)} as ${user.body.username}`;
  const known = { ...base, user: user.body.username, scopes };
  if (scopes && !scopes.includes(SCOPE)) return result('gitlab', 'fail', 'GitLab token', `${who}, but the token has ${scopes.join(', ') || 'no scopes'}. Posting what you approve needs ${SCOPE}.`, known);
  return result('gitlab', 'pass', 'GitLab token', scopes ? `${who}, with the ${SCOPE} scope.` : `${who}. GitLab did not say the token's scopes; posting needs ${SCOPE}.`, known);
}

// Off asks nothing at all, so a signed-in gh is never read, let alone taken as a yes.
async function githubCheck() {
  const base = { optional: true, on: false, token: true };
  if (!supports('githubTokenCheck')) return result('github', 'off', 'GitHub', 'This build of the review engine cannot read GitHub, so rebuild it to switch GitHub on.', base);
  if (!githubOn()) return result('github', 'off', 'GitHub', 'Optional. Off until you switch it on here; being signed in to gh does not turn it on.', base);
  const web = engine.githubWeb();
  const on = { ...base, on: true, link: githubTokenLink(web), scopes: null, needs: GITHUB_SCOPES };
  try {
    const check = await engine.githubTokenCheck();
    if (!check) return result('github', 'fail', 'GitHub', 'No token found. Paste one here, set GITHUB_TOKEN or GH_TOKEN in your shell profile, or sign in with gh.', { ...on, command: 'gh auth login' });
    return githubResult(check, on);
  } catch (err) {
    return result('github', 'fail', 'GitHub', `GitHub did not answer: ${said(err)}`, on);
  }
}

function githubResult(check, on) {
  const from = GITHUB_SOURCES[check.source] ?? check.source;
  const known = { ...on, source: check.source, user: check.login, scopes: check.scopes };
  if (check.status === 401) return result('github', 'fail', 'GitHub', `GitHub refused ${from}: it is wrong, revoked or expired.`, { ...known, ...(check.source === 'gh' ? { command: 'gh auth login' } : {}) });
  if (check.sso) return result('github', 'fail', 'GitHub', `Signed in as ${check.login ?? 'someone'} with ${from}, but ${check.sso}.`, known);
  if (!check.login) return result('github', 'fail', 'GitHub', `GitHub answered ${check.status} when asked who ${from} belongs to.`, known);
  const who = `Signed in to GitHub as ${check.login}, with ${from}`;
  if (!check.scopes) return result('github', 'pass', 'GitHub', `${who}, a fine-grained token, so GitHub lists no scopes. It needs read access to pull requests, contents, checks, commit statuses and Actions, and covers one owner only: if you are in several organisations, use gh or a classic token.`, known);
  const missing = GITHUB_SCOPES.filter((scope) => !check.scopes.includes(scope));
  if (missing.length) return result('github', 'fail', 'GitHub', `${who}, but it lacks ${missing.join(' and ')}. It has ${check.scopes.join(', ') || 'no scopes'}.`, { ...known, missing, ...(check.source === 'gh' ? { command: `gh auth refresh -s ${missing.join(',')}` } : {}) });
  return result('github', 'pass', 'GitHub', `${who} (${check.scopes.join(', ')}).`, known);
}

async function acliPath() {
  return process.env.UNDERLINGS_ACLI || onPath('acli', process.env.PATH);
}

async function jiraCheck() {
  const site = supports('loadSettings') ? String(engine.loadSettings().jiraSite ?? '').trim() : '';
  const base = { optional: true, site, link: LINKS.acli };
  if (!site) return result('jira', 'off', 'Jira', 'Optional. Tickets stay off until you set your Atlassian site here.', base);
  const acli = await acliPath();
  if (!acli) return result('jira', 'fail', 'Jira', `Your site is ${site}, but acli, the Atlassian command line it is read through, is not installed.`, base);
  const signedIn = await run(acli, ['jira', 'auth', 'status'], process.env, { timeout: CHECK_MS }).then((out) => out.includes('Authenticated'), () => false);
  if (!signedIn) return result('jira', 'fail', 'Jira', `acli is installed but not signed in to ${site}.`, { ...base, command: 'acli jira auth login --web' });
  return result('jira', 'pass', 'Jira', `Tickets are read from ${site} through acli.`, base);
}

async function workspaceCheck() {
  const root = workspaceRoot(config);
  if (!root) return result('workspace', 'fail', 'Workspace root', 'Not set. Agents start in this folder, and find your clones in it.', { root: '' });
  const there = await stat(root).then((s) => s.isDirectory(), () => false);
  if (!there) return result('workspace', 'fail', 'Workspace root', `${root} is not a folder on this Mac.`, { root });
  const found = supports('discoverCheckouts') ? engine.discoverCheckouts(root) : [];
  if (!found.length) return result('workspace', 'fail', 'Workspace root', `No git checkouts found under ${root}. Clone your repos there, or pick the folder they are in.`, { root, checkouts: 0 });
  return result('workspace', 'pass', 'Workspace root', `${found.length} ${found.length === 1 ? 'checkout' : 'checkouts'} found under ${root}.`, { root, checkouts: found.length, names: found.slice(0, 12).map((c) => c.dir) });
}

function agentsCheck() {
  const commands = supports('agentCommands') ? engine.agentCommands() : null;
  if (!commands) return result('agents', 'fail', 'Agent commands', 'This build of the review engine has no agent settings, so rebuild it.');
  const own = Object.entries(COMMAND_NAMES).filter(([key]) => commands[key]).map(([, name]) => name);
  const detail = own.length ? `Your own ${own.join(', ')} ${own.length === 1 ? 'command' : 'commands'}; the rest use the Underlings skills.` : 'Every agent uses the Underlings skills.';
  return result('agents', 'pass', 'Agent commands', detail, { commands });
}

async function saveAgentCommands({ agents } = {}) {
  const { updateSettings } = requireEngine('updateSettings', 'agentCommands');
  const { applied } = updateSettings({ agents });
  if (!applied.includes('agents')) throw failure(400, 'agents takes reviewCommand, selfReviewCommand and kickoffCommand, each a line of text, blank for the Underlings skill');
  const now = engine.agentCommands();
  return `Saved: ${Object.keys(agents).map((key) => `${COMMAND_NAMES[key]} ${now[key] || 'the Underlings skill'}`).join(', ')}`;
}

const SKILLS_STEPS = {
  install: ({ id, marketplace }) => [['marketplace', 'add', marketplace, '--scope', SKILLS_SCOPE], ['install', id, '--scope', SKILLS_SCOPE]],
  update: ({ id, marketplaceName }) => [['marketplace', 'update', marketplaceName], ['update', id, '--scope', SKILLS_SCOPE]],
  enable: ({ id }) => [['enable', id, '--scope', SKILLS_SCOPE]],
  remove: ({ id, marketplaceName }) => [['uninstall', id, '--scope', SKILLS_SCOPE], ['marketplace', 'remove', marketplaceName, '--scope', SKILLS_SCOPE]],
};
const SKILLS_DONE = {
  install: 'Added the Underlings skills to your Claude Code. Start a new session and type /underlings: to see them',
  update: 'Updated the Underlings skills in your Claude Code. A session already open keeps the old ones until it restarts',
  enable: 'Turned the Underlings skills back on in your Claude Code',
  remove: 'Took the Underlings skills out of your Claude Code',
};
const shown = (word) => (/^[\w.:/@=-]+$/.test(word) ? word : shellQuoted(word));

// What runs is built here from the action alone, so the page can only ask for one of these, never send a command of its own.
export function skillsPlan(action, plugin = engine.skillsPlugin()) {
  const steps = SKILLS_STEPS[action](plugin).map((step) => ['plugin', ...step]);
  return { action, steps, commands: steps.map((step) => ['claude', ...step].map(shown).join(' ')) };
}

const listedPlugins = (text) => {
  const data = JSON.parse(text);
  return Array.isArray(data) ? data : data?.plugins ?? [];
};

async function installedSkills(bin, { id }) {
  const out = await run(bin, ['plugin', 'list', '--json'], withoutForgeTokens(process.env), { timeout: CHECK_MS });
  const mine = listedPlugins(out).find((p) => p?.id === id && (!p.scope || p.scope === SKILLS_SCOPE));
  return mine ? { version: String(mine.version ?? ''), enabled: mine.enabled !== false } : null;
}

const skillsResult = (state, detail, extra = {}) => result('skills', state, 'Underlings skills', detail, { optional: true, ...extra });

async function skillsCheck() {
  if (!supports('skillsPlugin')) return skillsResult('fail', 'This build of the review engine does not know where its skills are, so rebuild it.');
  const plugin = engine.skillsPlugin();
  const bin = await claudeBinaryPath();
  if (!bin) return skillsResult('off', 'Needs Claude Code first. Your agents load the skills on their own either way.');
  const bundled = (await readJson(join(plugin.dir, '.claude-plugin', 'plugin.json')))?.version;
  if (!bundled) return skillsResult('fail', `The skills are missing from this app: there is no plugin at ${plugin.dir}. Reinstall the app.`);
  try {
    return skillsState(await installedSkills(bin, plugin), bundled);
  } catch (err) {
    return skillsResult('fail', `Claude Code did not say which plugins you have: ${said(err)}`);
  }
}

function skillsState(installed, bundled) {
  const base = { bundled, version: installed?.version ?? null, installed: Boolean(installed) };
  if (!installed) return skillsResult('off', `Optional. Your agents load the skills on their own. Install them into your own Claude Code to use /underlings:review, /underlings:standup and the rest in your terminal too.${orcaNote()}`, { ...base, plan: skillsPlan('install') });
  const remove = skillsPlan('remove');
  if (!installed.enabled) return skillsResult('off', `Installed (${installed.version}) but turned off in your Claude Code.`, { ...base, plan: skillsPlan('enable'), remove });
  if (installed.version !== bundled) return skillsResult('fail', `Your Claude Code has version ${installed.version || 'unknown'}; this app has ${bundled}.`, { ...base, plan: skillsPlan('update'), remove });
  return skillsResult('pass', `Installed in your Claude Code, version ${bundled}. Type /underlings: there to see them.`, { ...base, remove });
}

const orcaNote = () => (supports('loadSettings') && engine.loadSettings().agentHost === 'orca' ? ' Orca starts its own Claude Code, so its agents only have the skills once they are installed here.' : '');

// A repeat of a step that already happened is no failure, so installing twice is harmless.
const mayRepeat = (step) => step[1] === 'install' || (step[1] === 'marketplace' && step[2] === 'add');

async function runSkillsStep(bin, step) {
  try {
    await run(bin, step, withoutForgeTokens(process.env), { timeout: SKILLS_MS });
  } catch (err) {
    if (mayRepeat(step) && /already/i.test(`${err.stdout ?? ''}${err.stderr ?? ''}`)) return;
    const hint = step[1] === 'marketplace' && step[2] === 'update' ? ' If the app has moved, remove the skills and install them again.' : '';
    throw failure(502, `claude ${step.slice(0, 3).join(' ')} did not finish: ${said(err)}.${hint}`);
  }
}

// The page sends the commands it showed, so what runs is what you read; the plan is rebuilt here and a page that disagrees is refused.
export async function changeSkills({ action, commands } = {}) {
  requireEngine('skillsPlugin');
  if (!Object.hasOwn(SKILLS_STEPS, action)) throw failure(400, 'action is install, update, enable or remove');
  const plan = skillsPlan(action);
  if (JSON.stringify(commands) !== JSON.stringify(plan.commands)) throw failure(409, 'the commands changed since you looked, so check again before running them');
  const bin = await claudeBinaryPath();
  if (!bin) throw failure(409, 'Claude Code is not installed, or not on your login shell\'s PATH');
  for (const step of plan.steps) await runSkillsStep(bin, step);
  return { ok: true, text: SKILLS_DONE[action] };
}

// The app's own Electron runs the script as node, so a Mac with no node of its own still records artifacts.
export function hookEntry(node = process.execPath, script = HOOK_SCRIPT) {
  const command = ['ELECTRON_RUN_AS_NODE=1', shellQuoted(node), shellQuoted(script)].join(' ');
  return { matcher: 'Artifact', hooks: [{ type: 'command', command, timeout: HOOK_TIMEOUT_S }] };
}

async function readClaudeSettings() {
  const file = claudeSettingsFile();
  const text = await readFile(file, 'utf8').catch((err) => (err.code === 'ENOENT' ? null : Promise.reject(err)));
  if (text === null) return { file, settings: {}, exists: false };
  try {
    const settings = JSON.parse(text);
    if (!settings || typeof settings !== 'object' || Array.isArray(settings)) throw new Error('not an object');
    return { file, settings, exists: true };
  } catch {
    throw failure(409, `${file} is not valid JSON, so nothing is written to it. Fix it by hand, then check again.`);
  }
}

const artifactHooks = (settings) => (settings.hooks?.PostToolUse ?? []).flatMap((entry) => entry?.hooks ?? []).filter((h) => String(h?.command ?? '').includes(HOOK_MARK));

// The script a hook command runs, quoted or not; one that is gone was left by an install that moved, the app's old bundle say.
export function hookScript(command) {
  const found = String(command).match(/'([^']*record-artifact\.mjs)'|(\S*record-artifact\.mjs)/);
  return found?.[1] ?? found?.[2] ?? null;
}

const runs = (hook) => existsSync(hookScript(hook.command) ?? '');
const hasHook = (settings) => artifactHooks(settings).some(runs);
const staleHook = (settings) => (hasHook(settings) ? null : artifactHooks(settings)[0] ?? null);

async function hookCheck() {
  try {
    const { file, settings } = await readClaudeSettings();
    if (hasHook(settings)) return result('hook', 'pass', 'Artifact hook', `Installed in ${file}, so each artifact you publish shows under Artifacts.`, { file });
    const stale = staleHook(settings);
    if (stale) return result('hook', 'fail', 'Artifact hook', `The hook in ${file} runs ${hookScript(stale.command)}, which is no longer there, so nothing you publish shows under Artifacts. Update it in place.`, { file, entry: hookEntry(), replaces: stale.command });
    return result('hook', 'fail', 'Artifact hook', `Not installed. Without it, artifacts you publish from Claude Code do not show under Artifacts.`, { file, entry: hookEntry() });
  } catch (err) {
    return result('hook', 'fail', 'Artifact hook', err.message, { file: claudeSettingsFile() });
  }
}

export async function hookPlan() {
  const { file, settings, exists } = await readClaudeSettings();
  return { file, exists, installed: hasHook(settings), entry: hookEntry(), replaces: staleHook(settings)?.command ?? null };
}

// The page sends the command it showed, and the one it replaces, so what is written is exactly what you read; every other hook stays as it was.
export async function installHook({ command, replaces } = {}) {
  const { file, settings, exists } = await readClaudeSettings();
  if (hasHook(settings)) return { ok: true, text: `The artifact hook is already in ${file}` };
  const entry = hookEntry();
  if (command !== entry.hooks[0].command || (replaces ?? null) !== (staleHook(settings)?.command ?? null)) throw failure(409, 'the hook changed since you looked, so check it again before installing');
  const hooks = settings.hooks && typeof settings.hooks === 'object' ? settings.hooks : {};
  const before = Array.isArray(hooks.PostToolUse) ? hooks.PostToolUse : [];
  const updated = (e) => ({ ...e, hooks: e.hooks.map((h) => (h?.command === replaces ? { ...h, ...entry.hooks[0] } : h)) });
  const PostToolUse = replaces ? before.map((e) => (Array.isArray(e?.hooks) ? updated(e) : e)) : [...before, entry];
  const next = { ...settings, hooks: { ...hooks, PostToolUse } };
  const mode = exists ? (await stat(file)).mode & 0o777 : 0o600;
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await writeFile(temp, `${JSON.stringify(next, null, 2)}\n`, { mode });
  await rename(temp, file);
  return { ok: true, text: `${replaces ? 'Updated' : 'Added'} the artifact hook in ${file}. It records what you publish from the next Claude Code session` };
}
