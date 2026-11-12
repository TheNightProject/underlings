import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { engine, engineFile, failure, fetchError, githubOn, inbox, loading, refreshInbox, reloadEngine, requireEngine, supports, workspaceRoot } from './engine.mjs';
import { openInOrca, orca } from './orca.mjs';
import { readJson } from './run.mjs';
import { adoptShellEnv, inLoginShell } from './shell-env.mjs';
import { APP_NAME } from './product.mjs';
import { configDir, stateDir } from './home.mjs';

const BUILD_MS = 180_000;
const pageUrlFile = () => join(stateDir(), 'url');
const gitlabTokenFile = () => join(configDir(), 'gitlab-token');
const GITLAB_TOKEN = /^[\w.~-]{20,255}$/;
const GITHUB_TOKEN = /^(?:gh[pousr]_[A-Za-z0-9]{30,251}|github_pat_\w{40,251}|[0-9a-f]{40})$/;
export const GITHUB_ENV = ['GITHUB_TOKEN', 'GH_TOKEN'];

let building = null;

export const ACTIONS = {};

export const ROUTES = {
  'POST /api/rebuild': ({ config }) => (building ??= rebuild(config).finally(() => { building = null; })),
  'POST /api/gitlab/retry': () => retryGitLab(),
  'POST /api/gitlab/token': async ({ body }) => saveGitLabToken(await body()),
  'POST /api/github/retry': () => retryGitHub(),
  'POST /api/github/token': async ({ body }) => saveGitHubToken(await body()),
};

// Only a fresh activation in Orca opens the page; a reload hands over the tabs already showing it, and the app shows its own window.
export function start(config, shell) {
  if (shell.carried || shell.desktop) return Promise.resolve();
  return openSelf(config).then(shell.log, (err) => shell.log?.(`could not open ${APP_NAME} in Orca: ${err.message}`));
}

async function openSelf(config) {
  const page = new URL((await readFile(pageUrlFile(), 'utf8')).trim());
  const tabs = await orca(config, ['tab', 'list', '--worktree', 'all']).then((r) => r.tabs ?? []);
  const ours = tabs.filter((tab) => onDashboard(tab.url, page));
  const stale = ours.filter((tab) => new URL(tab.url).searchParams.get('t') !== page.searchParams.get('t'));
  for (const tab of stale) await orca(config, ['goto', '--page', tab.browserPageId, '--url', repointed(tab.url, page)]);
  if (ours.length) return `${APP_NAME} is already open in Orca${stale.length ? `, and ${stale.length} tab(s) now carry the current link` : ''}`;
  await openInOrca(config, page.href, { root: workspaceRoot(config) });
  return `${APP_NAME} opened itself in Orca`;
}

function onDashboard(url, page) {
  try {
    const tab = new URL(url);
    return tab.origin === page.origin && tab.pathname === '/';
  } catch {
    return false;
  }
}

function repointed(url, page) {
  const fresh = new URL(page);
  fresh.hash = new URL(url).hash;
  return fresh.href;
}

async function rebuild(config) {
  const folder = dirname(dirname(engineFile(config)));
  const pkg = await readJson(join(folder, 'package.json'));
  if (!pkg?.scripts?.build) throw failure(400, `${folder} has no build script, so the review engine cannot be rebuilt from here`);
  const began = Date.now();
  await inLoginShell('npm run build', { cwd: folder, timeout: BUILD_MS }).catch((err) => {
    throw failure(500, `npm run build failed in ${folder}: ${lastLines(err)}`);
  });
  await reloadEngine(config);
  return { ok: true, text: `Rebuilt the review engine in ${Math.round((Date.now() - began) / 1000)} s and loaded it` };
}

function lastLines(err) {
  const said = [err.stdout, err.killed ? `it was still going after ${BUILD_MS / 1000} s` : err.message].filter(Boolean).join('\n');
  return said.trim().split('\n').slice(-6).join('\n');
}

// A token pasted on the page is the one you chose, so it wins over whatever the shell profile still holds.
export async function adoptSavedToken() {
  const saved = (await readFile(gitlabTokenFile(), 'utf8').catch(() => '')).trim();
  if (saved) process.env.GITLAB_TOKEN = saved;
}

async function retryGitLab() {
  await adoptShellEnv(['GITLAB_TOKEN'], { force: true }).catch((err) => {
    throw failure(500, `could not read your shell profile: ${err.message}`);
  });
  await adoptSavedToken();
  return askGitLab();
}

async function saveGitLabToken({ token } = {}) {
  const value = typeof token === 'string' ? token.trim() : '';
  if (!GITLAB_TOKEN.test(value)) throw failure(400, 'that does not look like a GitLab token');
  await mkdir(dirname(gitlabTokenFile()), { recursive: true });
  await writeFile(gitlabTokenFile(), value + '\n', { mode: 0o600 });
  await chmod(gitlabTokenFile(), 0o600);
  process.env.GITLAB_TOKEN = value;
  return askGitLab();
}

async function askGitLab() {
  if (!process.env.GITLAB_TOKEN) throw failure(400, 'there is still no GITLAB_TOKEN in your shell profile. Add it there and Retry, or paste a token here.');
  requireEngine();
  await refreshInbox();
  if (loading()) return { ok: true, text: 'Asked GitLab again' };
  if (fetchError) throw failure(502, `GitLab: ${fetchError}`);
  return { ok: true, text: 'GitLab answered' };
}

// Only once GitHub is on is the shell asked for its tokens, so an install without GitHub starts as it always did.
export async function adoptGitHubEnv({ force = false } = {}) {
  if (!githubOn() || (!force && GITHUB_ENV.some((name) => process.env[name]))) return;
  await adoptShellEnv(GITHUB_ENV, { force });
  if (!force && GITHUB_ENV.some((name) => process.env[name])) refreshInbox();
}

async function retryGitHub() {
  if (!githubOn()) throw failure(409, 'GitHub is off. Switch it on in Setup or Settings first.');
  await adoptGitHubEnv({ force: true }).catch((err) => {
    throw failure(500, `could not read your shell profile: ${err.message}`);
  });
  engine.forgetGithubToken?.();
  return askGitHub();
}

// Kept beside the GitLab token, readable only by you, and read before any other source.
async function saveGitHubToken({ token } = {}) {
  const value = typeof token === 'string' ? token.trim() : '';
  if (!GITHUB_TOKEN.test(value)) throw failure(400, 'that does not look like a GitHub token');
  if (!supports('githubTokenFile')) throw failure(501, 'The review engine needs rebuilding before it can use a GitHub token');
  const file = engine.githubTokenFile();
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, value + '\n', { mode: 0o600 });
  await chmod(file, 0o600);
  engine.forgetGithubToken?.();
  return githubOn() ? askGitHub() : { ok: true, text: 'Saved. Switch GitHub on to use it' };
}

async function askGitHub() {
  requireEngine();
  await refreshInbox();
  if (loading()) return { ok: true, text: 'Asked GitHub again' };
  const error = inbox?.errors?.github ?? null;
  if (error) throw failure(502, `GitHub: ${error}`);
  return { ok: true, text: 'GitHub answered' };
}
