import * as child from 'node:child_process';
import { existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { startHelper } from './apphelper.mjs';
import { buildInfo, ROOT, statePath, writePrivate } from './build.mjs';
import { compareVersions, draft, groupLines, isVersion, linesSince, LOG_FORMAT, parseChangelog, parseLog, parseRemote } from './changelog.mjs';
import { failure } from './engine.mjs';
import { readJson, run } from './run.mjs';
import { APP_NAME } from './product.mjs';
import { configDir } from './home.mjs';

export const CHANNELS = ['main', 'releases'];
export const CHECK_MS = 3 * 3600_000;
const FIRST_CHECK_MS = 5 * 60_000;
const FETCH_MS = 60_000;
const BRANCH = 'main';
const OFFLINE = /Could not resolve host(?:name)?:?\s*([\w.-]+)?/i;
const SIGN_IN = /could not read (?:Username|Password)|unable to get password from user|terminal prompts disabled|Authentication failed|Permission denied \(|HTTP Basic: Access denied|Invalid username or|returned error: 40[13]|Repository not found|you don't have permission/i;
const CLOBBER = /\[rejected\]\s+(\S+)\s+->.*would clobber existing tag/;
const STEP_MS = 15 * 60_000;
const QUIT_DELAY_MS = 500;
const LOG_LINES = 400;
const BUILT_APP = `desktop/dist.noindex/mac-arm64/${APP_NAME}.app`;
const IN_BUNDLE = /^(.+\.app)\/Contents\/Resources\/worker$/;
const RELEASES = 'https://api.github.com/repos/TheNightProject/underlings/releases?per_page=20';
export const BREW_UPGRADE = 'brew upgrade --cask underlings';

let config = {};
let shell = {};
let channel = 'main';
let timer = null;
let checking = null;
let checked = null;
let job = null;
let stamped = null;
let released = false;

export const ACTIONS = {};

export const ROUTES = {
  'POST /api/updates/check': () => checkNow(),
  'POST /api/updates/channel': async ({ body }) => setChannel(await body()),
  'POST /api/updates/apply': () => apply(),
};

export async function start(cfg, sh) {
  config = cfg ?? {};
  shell = sh ?? {};
  ({ checked = null, job = null } = shell.carried?.selfupdate ?? {});
  const stamp = await readJson(join(runningFrom(), 'build.json'));
  stamped = stamp?.repo ?? null;
  released = Boolean(stamp?.release);
  channel = fromRelease() ? 'releases' : await savedChannel();
  schedule(checked ? CHECK_MS : FIRST_CHECK_MS);
}

export function stop() {
  clearTimeout(timer);
  timer = null;
}

export function carry() {
  return { checked, job };
}

export async function settled() {
  while (checking || job?.running) await (checking ?? job.running);
}

function schedule(ms) {
  clearTimeout(timer);
  timer = setTimeout(() => check().finally(() => schedule(CHECK_MS)), ms);
  timer.unref?.();
}

const settingsFile = () => join(configDir(), 'updates.json');
const configPath = () => join(configDir(), 'config.json').replace(homedir(), '~');

async function savedChannel() {
  const saved = await readJson(settingsFile(), {});
  return CHANNELS.includes(saved?.channel) ? saved.channel : 'main';
}

const runningFrom = () => config.buildRoot ?? ROOT;

// A build from a GitHub release has no checkout behind it, so it reads the releases and Homebrew installs the next one.
const fromRelease = () => released && !config.repoPath;

const isCheckout = (dir) => Boolean(dir) && existsSync(join(dir, '.git'));

export function repoPath() {
  if (config.repoPath) return config.repoPath;
  if (isCheckout(runningFrom())) return runningFrom();
  return isCheckout(stamped) ? stamped : join(homedir(), 'Projects/underlings');
}

function appBundle() {
  return config.appPath ?? IN_BUNDLE.exec(runningFrom())?.[1] ?? null;
}

function mode() {
  if (!shell.desktop) return 'plugin';
  if (fromRelease()) return 'release';
  return appBundle() ? 'app' : 'dev';
}

export function brief() {
  return {
    channel, count: checked?.count ?? 0, checkedAt: checked?.at ?? null, checking: Boolean(checking), error: checked?.error ?? null,
    running: Boolean(job?.running), outcome: job?.outcome ? job.outcome.ok : null,
  };
}

export function status() {
  return {
    ...brief(), target: checked?.target ?? null, lines: checked?.lines ?? null, leftOut: checked?.leftOut ?? 0, repo: repoPath(), mode: mode(),
    upgrade: fromRelease() ? BREW_UPGRADE : null,
    job: job && { startedAt: job.startedAt, step: job.step, log: job.log, outcome: job.outcome },
  };
}

async function setChannel({ channel: next } = {}) {
  if (!CHANNELS.includes(next)) throw failure(400, 'the channel is main or releases');
  if (fromRelease()) throw failure(409, 'this copy came from a release, so it follows releases only');
  await writePrivate(settingsFile(), { channel: next });
  channel = next;
  checked = null;
  check();
  return { ok: true, text: next === 'main' ? 'Updates now follow every merge to main' : 'Updates now wait for a tagged release' };
}

function checkNow() {
  const busy = Boolean(checking);
  check();
  return { ok: true, text: busy ? 'Already checking origin for updates' : 'Checking origin for updates' };
}

export function check() {
  checking ??= look()
    .then((result) => { checked = result; }, (err) => { checked = { channel, at: new Date().toISOString(), count: 0, error: err.message }; })
    .finally(() => {
      checking = null;
      shell.notify?.('updates');
    });
  return checking;
}

async function look() {
  const wanted = channel;
  const info = await buildInfo(config);
  const at = new Date().toISOString();
  if (fromRelease()) return newerReleases(info, at);
  if (!info.commit) return { channel: wanted, at, count: 0, error: 'this build does not know its commit: run npm run build in the checkout once' };
  const repo = repoPath();
  const origin = await originOf(repo);
  const target = wanted === 'releases' ? await newestRelease(repo, origin, info.version) : await branchTip(repo, origin);
  if (!target) return { channel: wanted, at, count: 0, target: null, lines: null, leftOut: 0 };
  if (!(await hasCommit(repo, info.commit))) throw new Error(`this build came from a commit that is not in your checkout: ${info.commit.slice(0, 8)} is not in ${repo}`);
  const commits = parseLog(await git(repo, 'log', '--first-parent', `--format=${LOG_FORMAT}`, `${info.commit}..${target.sha}`));
  const drafted = draft(commits, origin.remote);
  return { channel: wanted, at, target, count: commits.length, lines: groupLines(drafted), leftOut: drafted.leftOut.length };
}

// The release notes are the version's CHANGELOG.md section, so they read into the same lines a checkout drafts.
async function newerReleases(info, at) {
  const res = await fetch(RELEASES, { headers: { accept: 'application/vnd.github+json' }, signal: AbortSignal.timeout(FETCH_MS) })
    .catch((err) => { throw new Error(`GitHub did not answer, so nothing was checked: ${err.message}`); });
  if (!res.ok) throw new Error(`GitHub answered ${res.status} when asked for the releases, so nothing was checked`);
  const newer = (await res.json())
    .filter((r) => !r.draft && !r.prerelease && /^v/.test(r.tag_name ?? '') && isVersion(r.tag_name.slice(1)) && compareVersions(r.tag_name.slice(1), info.version) > 0)
    .map((r) => ({ ref: r.tag_name, version: r.tag_name.slice(1), url: r.html_url, body: r.body ?? '' }))
    .sort((a, b) => compareVersions(b.version, a.version));
  if (!newer.length) return { channel: 'releases', at, count: 0, target: null, lines: null, leftOut: 0 };
  const { sections } = parseChangelog(newer.map((r) => `## ${r.version}\n\n${r.body}`).join('\n\n'));
  const lines = linesSince(sections, info.version, newer[0].version);
  const { ref, version, url } = newer[0];
  return { channel: 'releases', at, target: { ref, version, url }, count: Object.values(lines).flat().length || newer.length, lines, leftOut: 0 };
}

const git = (repo, ...args) => run('git', ['-C', repo, ...args]);

const isRepo = async (repo) => Boolean((await git(repo, 'rev-parse', '--show-toplevel').catch(() => '')).trim());

const originUrl = async (repo) => (await git(repo, 'config', '--get', 'remote.origin.url').catch(() => '')).trim();

async function originOf(repo) {
  if (!(await isRepo(repo))) throw new Error(`${repo} is not a git checkout, so there is nothing to check. Set repoPath in ${configPath()} to your checkout.`);
  const url = await originUrl(repo);
  if (!url) throw new Error(`${repo} has no origin remote, so there is nowhere to check for updates`);
  return { url, remote: parseRemote(url) };
}

async function branchTip(repo, origin) {
  const branch = await upstreamBranch(repo);
  await fetchOrigin(repo, origin, `+refs/heads/${branch}:refs/remotes/origin/${branch}`);
  return { ref: branch, sha: await commitOf(repo, `refs/remotes/origin/${branch}`) };
}

async function upstreamBranch(repo) {
  const tracked = (await git(repo, 'rev-parse', '--abbrev-ref', '--symbolic-full-name', `${BRANCH}@{upstream}`).catch(() => '')).trim();
  return tracked.startsWith('origin/') ? tracked.slice('origin/'.length) : BRANCH;
}

async function newestRelease(repo, origin, version) {
  await fetchOrigin(repo, origin, 'refs/tags/v*:refs/tags/v*');
  const newest = (await git(repo, 'tag', '--list', 'v*')).split('\n').filter(Boolean)
    .map((ref) => ({ ref, version: ref.slice(1) }))
    .filter((tag) => isVersion(tag.version) && compareVersions(tag.version, version) > 0)
    .sort((a, b) => compareVersions(b.version, a.version))[0];
  return newest ? { ...newest, sha: await commitOf(repo, `refs/tags/${newest.ref}`) } : null;
}

const commitOf = async (repo, ref) => (await git(repo, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`)).trim();

const hasCommit = (repo, sha) => git(repo, 'cat-file', '-e', `${sha}^{commit}`).then(() => true, () => false);

async function fetchOrigin(repo, origin, refspec) {
  await run('git', ['-C', repo, 'fetch', '--no-tags', 'origin', refspec], await quietGit(repo), { timeout: FETCH_MS })
    .catch((err) => { throw new Error(fetchFailure(err, origin)); });
}

// A remote that wants a password or a passphrase must fail at once, not wait for one nobody can type.
async function quietGit(repo) {
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'never' };
  const own = env.GIT_SSH_COMMAND || env.GIT_SSH || (await git(repo, 'config', '--get', 'core.sshCommand').catch(() => '')).trim();
  return own ? env : { ...env, GIT_SSH_COMMAND: 'ssh -o BatchMode=yes' };
}

function fetchFailure(err, { url, remote }) {
  const said = String(err.stderr ?? '');
  const lookup = OFFLINE.exec(said);
  const clash = CLOBBER.exec(said);
  if (err.killed) return `origin did not answer within ${FETCH_MS / 1000} seconds, so nothing was checked`;
  if (lookup) return `git could not look up ${lookup[1] ?? remote?.host ?? url}, so you seem to be offline`;
  if (SIGN_IN.test(said)) return `git could not sign in to origin. While the repo is private, sign git in (${remote?.github ? 'gh auth setup-git' : 'a credential helper'} or an SSH key).`;
  if (clash) return `your tag ${clash[1]} is not the one origin has, so the releases could not be read. Delete yours with git tag -d ${clash[1]} and check again.`;
  const first = said.split('\n').map((line) => line.trim()).find((line) => line && !/^(From |hint:)/.test(line));
  return `git could not fetch from origin: ${(first ?? err.message).replace(/^(fatal|error):\s*/, '')}`;
}

async function apply() {
  if (job?.running) throw failure(409, 'an update is already running');
  const repo = repoPath();
  const info = await buildInfo(config);
  const reason = await refusal(repo);
  if (reason) {
    job = { startedAt: Date.now(), repo, step: null, log: [], outcome: { ok: false, refused: true, error: reason } };
    throw failure(409, reason);
  }
  job = { startedAt: Date.now(), repo, step: null, log: [], outcome: null, running: null };
  const current = job;
  current.running = update(current, info)
    .then((outcome) => { current.outcome = { ok: true, ...outcome }; }, (err) => {
      current.outcome = { ok: false, step: current.step, error: err.message };
      note(current, `Stopped: ${err.message}. This version keeps running.`);
    })
    .finally(() => {
      current.running = null;
      shell.notify?.('updates');
      if (current.outcome.ok && mode() !== 'app') check();
    });
  return { ok: true, text: `Updating from ${repo}` };
}

async function refusal(repo) {
  if (fromRelease()) return `This copy came from a release, so Homebrew updates it: run ${BREW_UPGRADE}.`;
  if (!(await isRepo(repo))) return `${repo} is not a git checkout, so there is nothing to update from. Set repoPath in ${configPath()} to your checkout.`;
  const branch = (await git(repo, 'symbolic-ref', '--short', '-q', 'HEAD').catch(() => '')).trim();
  if (branch !== BRANCH) return `${repo} is ${branch ? `on ${branch}` : 'not on a branch'}, not main, so nothing was changed. Switch it to main first.`;
  const changes = (await git(repo, 'status', '--porcelain')).split('\n').filter(Boolean);
  if (changes.length) return `${repo} has uncommitted changes (${changes.slice(0, 3).map((line) => line.slice(3)).join(', ')}${changes.length > 3 ? ' and more' : ''}), so nothing was changed. Commit them or put them aside first.`;
  if (channel === 'releases' && !checked?.target?.ref?.startsWith('v')) return 'There is no newer release to update to. Check for updates first.';
  return null;
}

async function update(current, info) {
  const env = await quietGit(current.repo);
  if (channel === 'releases') {
    await step(current, 'git', ['fetch', '--tags', 'origin'], env);
    await step(current, 'git', ['merge', '--ff-only', `refs/tags/${checked.target.ref}`], env);
  } else {
    await step(current, 'git', ['pull', '--ff-only'], env);
  }
  const to = (await git(current.repo, 'rev-parse', 'HEAD')).trim();
  if (to === info.commit) return { to, text: `Already up to date at ${to.slice(0, 8)}` };
  const pending = { v: 1, from: info.commit, to, lines: await incoming(current.repo, info.commit, to), at: new Date().toISOString() };
  await step(current, 'npm', ['run', 'setup']);
  await step(current, 'npm', ['run', 'build']);
  if (mode() === 'app') return finishInApp(current, pending);
  await writePrivate(statePath(config, 'update.json'), { ...pending, phase: 'done' });
  return { to, text: await doneText(current.repo, info.commit, to) };
}

async function incoming(repo, from, to) {
  if (!from) return checked?.lines ?? {};
  const log = await git(repo, 'log', '--first-parent', `--format=${LOG_FORMAT}`, `${from}..${to}`).catch(() => null);
  return log === null ? checked?.lines ?? {} : groupLines(draft(parseLog(log), parseRemote(await originUrl(repo))));
}

async function doneText(repo, from, to) {
  const updated = `Updated ${repo} to ${to.slice(0, 8)}.`;
  if (repo !== runningFrom()) return `${updated} This copy of ${APP_NAME} runs from ${runningFrom()}, so it is unchanged.`;
  const changed = await git(repo, 'diff', '--name-only', from ?? to, to, '--', 'worker.mjs').then((out) => Boolean(out.trim()), () => true);
  if (!changed) return `${updated} Press Reload to load the new code.`;
  return mode() === 'dev'
    ? `${updated} The worker has changed, so quit the app and run npm start in desktop/ again.`
    : `${updated} The worker has changed, so in Orca, Settings, Plugins, turn ${APP_NAME} off and on.`;
}

// The running app cannot overwrite itself, so a helper outside it waits for it to quit, swaps the new build in and opens it.
async function finishInApp(current, pending) {
  await step(current, 'npm', ['--prefix', 'desktop', 'run', 'pack']);
  const bundle = appBundle();
  const result = statePath(config, 'update-install.json');
  await writePrivate(statePath(config, 'update.json'), { ...pending, phase: 'installing' });
  await rm(result, { force: true });
  note(current, `Handing over to the install helper, which waits for the app to quit, puts the new build at ${bundle} and opens it again`);
  await startHelper({ pid: process.pid, built: join(current.repo, BUILT_APP), bundle, result, relaunch: ['/usr/bin/open', bundle] }, statePath(config, 'update-install.log'))
    .catch(async (err) => {
      await rm(statePath(config, 'update.json'), { force: true });
      throw err;
    });
  setTimeout(() => shell.desktop.quit?.(), QUIT_DELAY_MS);
  return { to: pending.to, text: 'Built. The app quits now, puts the new build in place and opens again.' };
}

function step(current, cmd, args, env = process.env) {
  current.step = [cmd, ...args].join(' ');
  note(current, `$ ${current.step}`);
  return new Promise((resolve, reject) => {
    const proc = child.spawn(cmd, args, { cwd: current.repo, env: { ...env, FORCE_COLOR: '0', NO_COLOR: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    const timeout = setTimeout(() => proc.kill('SIGTERM'), STEP_MS);
    for (const stream of [proc.stdout, proc.stderr]) streamLines(stream, (line) => note(current, line));
    proc.on('error', (err) => {
      clearTimeout(timeout);
      reject(new Error(`${current.step} could not start: ${err.message}`));
    });
    proc.on('close', (code, signal) => {
      clearTimeout(timeout);
      if (code === 0) resolve();
      else reject(new Error(`${current.step} ${signal ? `was stopped by ${signal}` : `failed with exit code ${code}`}`));
    });
  });
}

function streamLines(stream, onLine) {
  let rest = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    const parts = (rest + chunk).split(/\r\n|\r|\n/);
    rest = parts.pop();
    parts.filter((line) => line.trim()).forEach(onLine);
  });
  stream.on('end', () => {
    if (rest.trim()) onLine(rest);
  });
}

function note(current, line) {
  current.log.push(line);
  if (current.log.length > LOG_LINES) current.log.splice(0, current.log.length - LOG_LINES);
}
