import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, mergeTables, MODULES } from './actions.mjs';
import { readArtifacts } from './artifacts.mjs';
import * as autoloop from './autoloop.mjs';
import * as calendar from './calendar.mjs';
import { listAgents } from './claudeagents.mjs';
import * as claudepanel from './claudepanel.mjs';
import * as claudeterm from './claudeterm.mjs';
import * as features from './features.mjs';
import * as game from './game.mjs';
import * as locale from './locale.mjs';
import { carry as engineCarry, engine, failure, loadEngine, retire, workspaceRoot } from './engine.mjs';
import { readMatrix } from './matrix.mjs';
import { callTool } from './mcpcalls.mjs';
import * as messageagent from './messageagent.mjs';
import * as models from './models.mjs';
import { MOOD_MINUTES } from './moods.mjs';
import * as notifier from './notifier.mjs';
import { openInOrca, orca } from './orca.mjs';
import * as profile from './profile.mjs';
import { inHash } from './refs.mjs';
import { run } from './run.mjs';
import { adoptGitHubEnv, adoptSavedToken } from './selfheal.mjs';
import * as selfupdate from './selfupdate.mjs';
import { pending as setupPending } from './setup.mjs';
import { adoptShellEnv, adoptShellPath } from './shell-env.mjs';
import * as whatsnew from './whatsnew.mjs';
import { stateDir } from './home.mjs';

const ROOT = dirname(dirname(fileURLToPath(import.meta.url)));
const pageUrlFile = () => join(stateDir(), 'url');
const OPEN = '/usr/bin/open';
const SLACK_APP_LINK = /^slack:\/\/channel\?team=T[A-Z0-9]{5,19}&id=[CDG][A-Z0-9]{5,19}&message=\d{9,10}\.\d{1,6}$/;
let shell = {};
let loadedLib = null;

export const ROUTES = mergeTables({
  app: {
    'GET /api/state': () => snapshot(),
    'GET /api/badge': () => badge(),
    'POST /api/open': async ({ body }) => open(await body()),
    'POST /api/summon': async ({ config, body }) => summon(config, await body()),
    'POST /api/mcp/call': async ({ body }) => callTool(await body(), { act }),
  },
  ...Object.fromEntries(Object.entries(MODULES).map(([name, mod]) => [name, mod.ROUTES])),
}, 'route');

export function carry() {
  return { ...engineCarry(), autoloop: autoloop.carry(), selfupdate: selfupdate.carry() };
}

// The engine fixes its state folder when it is imported, so everything it reads from the environment is set before that.
export async function start(config, options) {
  shell = options;
  loadedLib = await libStamp();
  if (config.orcaUserDataPath) process.env.ORCA_USER_DATA_PATH ??= config.orcaUserDataPath;
  if (config.workspaceRoot) process.env.ORCA_WORKSPACE_ROOT ??= config.workspaceRoot;
  await adoptShellEnv(['GITLAB_TOKEN', 'UNDERLINGS_STATE_DIR']).catch((err) => shell.log?.(`could not read the shell environment: ${err.message}`));
  await adoptShellPath().catch((err) => shell.log?.(`could not read the shell's PATH: ${err.message}`));
  await adoptSavedToken();
  await loadEngine(config, shell.notify, shell.carried);
  await adoptGitHubEnv().catch((err) => shell.log?.(`could not read the GitHub token from the shell environment: ${err.message}`));
  const names = Object.keys(MODULES);
  const started = await Promise.allSettled(names.map(async (name) => MODULES[name].start?.(config, shell)));
  started.forEach(({ status, reason }, i) => {
    if (status === 'rejected') shell.log?.(`${names[i]} did not start: ${reason?.message ?? reason}`);
  });
  autoloop.adopt();
}

export async function stop() {
  retire();
  await Promise.allSettled(Object.values(MODULES).map(async (mod) => mod.stop?.()));
}

// A route named with a trailing * takes every path under its first segment, such as 'GET /preview/*'.
export async function route({ method, path, query, body, config }) {
  const handler = ROUTES[`${method} ${path}`] ?? ROUTES[`${method} ${path.slice(0, path.indexOf('/', 1) + 1)}*`];
  if (handler) return handler({ query, body, config, path, sign: shell.sign });
  if (method === 'POST' && path.startsWith('/api/matrix/')) return act(path.slice('/api/matrix/'.length), await body());
  throw failure(404, 'not found');
}

export async function snapshot() {
  const switches = features.view();
  const [matrix, artifacts, version, release, messageAgents, featureSwitches] = await Promise.all([readMatrix(), switches.then((on) => (on.artifacts ? readArtifacts(shell.sign) : [])), versions(), whatsnew.summary(), messageagent.view(), switches, locale.refresh()]);
  const hotkeys = shell.desktop?.hotkeys ?? null;
  return { generatedAt: new Date().toISOString(), version, shell: shell.desktop ? 'app' : 'plugin', hotkeys, release, agents: listAgents() ?? [], claude: claudepanel.view(), claudeCode: claudeterm.view(), matrix, artifacts, messageAgents, attention: notifier.view(), calendar: calendar.view(), game: game.view(), locale: locale.view(), moods: MOOD_MINUTES, setup: { pending: setupPending() }, features: featureSwitches };
}


// The menu bar icon asks every few seconds, so this skips the agent and artifact reads a snapshot makes.
function badge() {
  return { count: notifier.view().count, paused: engine ? Boolean(engine.loadSettings().autoPaused) : null };
}

// A new tab loads straight at the target; one already open is told where to go once it is in front.
export async function openPage(config, url, target) {
  if (target === claudeterm.TARGET && claudeterm.available()) return claudeterm.summon();
  if (typeof target === 'string' && target.startsWith(calendar.JOIN_TARGET)) return joinMeeting(config, url, target);
  const link = target ? `${url}#${inHash(target)}` : url;
  const opened = shell.desktop ? await shell.desktop.showPage(link) : await openInOrca(config, link, { root: workspaceRoot(config), focus: true });
  if (target && opened.reused) shell.notify?.(`goto:${target}`);
  return opened;
}

// A meeting banner joins the call; one whose meeting has gone since opens the calendar instead.
function joinMeeting(config, url, target) {
  const link = calendar.joinLink(target);
  return link ? open({ url: link }) : openPage(config, url, 'calendar');
}

export function latestTarget() {
  return notifier.latestTarget();
}

export function openClaude() {
  return claudeterm.available() ? claudeterm.summon() : claudepanel.popOut();
}

// A clicked page banner brings the dashboard forward and opens the drawer tab it named.
async function summon(config, { target } = {}) {
  if (!notifier.validTarget(target)) throw failure(400, 'a target is an MR tab such as mr:group/repo!1:threads, a ticket such as ticket:ABC-1, an agent such as agent:<handle>, or a view');
  if (shell.desktop) shell.desktop.focus();
  else await switchToDashboard(config);
  shell.notify?.(`goto:${target}`);
  return { ok: true };
}

async function switchToDashboard(config) {
  const tabs = await orca(config, ['tab', 'list', '--worktree', 'all']).then((r) => r.tabs ?? []).catch(() => []);
  const ours = await Promise.all(tabs.map((t) => isDashboard(t.url)));
  const page = tabs.find((t, i) => ours[i]);
  if (page) await orca(config, ['tab', 'switch', '--page', page.browserPageId, '--focus']);
}

// Every web link goes to the default browser, from the plugin as from the app; the only other link that goes at all is a Slack app link of exactly this shape.
async function open({ url } = {}) {
  const slackApp = typeof url === 'string' && SLACK_APP_LINK.test(url);
  if (!slackApp && !isWebLink(url)) throw failure(400, 'only http and https links open in the browser, and Slack\'s own links in the Slack app');
  if (shell.desktop && !slackApp) return shell.desktop.openExternal(url);
  await run(OPEN, [url]);
  return { ok: true, text: slackApp ? 'Opened in the Slack app' : 'Opened in your browser' };
}

function isWebLink(url) {
  try {
    return ['http:', 'https:'].includes(new URL(url).protocol);
  } catch {
    return false;
  }
}

async function isDashboard(url) {
  try {
    const page = new URL((await readFile(pageUrlFile(), 'utf8')).trim());
    const tab = new URL(url);
    return tab.origin === page.origin && tab.pathname === '/';
  } catch {
    return false;
  }
}

export async function versions() {
  const [ui, lib, worker] = await Promise.all([shell.uiStamp?.() ?? null, libStamp(), mtime(join(ROOT, 'worker.mjs'))]);
  return { ui, lib, worker, loaded: loadedLib, started: Date.now() - process.uptime() * 1000 };
}

async function libStamp() {
  const names = (await readdir(join(ROOT, 'lib'))).filter((n) => n.endsWith('.mjs') && !n.includes('.test.'));
  return Math.max(0, ...(await Promise.all(names.map((n) => mtime(join(ROOT, 'lib', n))))));
}

async function mtime(path) {
  return (await stat(path)).mtimeMs;
}
