#!/usr/bin/env node
// Needs --experimental-test-module-mocks, which the demo:serve script passes.
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFile as realExecFile, execFileSync as realExecFileSync, spawn as realSpawn, spawnSync as realSpawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mock } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { fakeGitlab } from '../../lib/fixtures/gitlab-golden/fakegitlab.mjs';
import { seedWorld } from './seed.mjs';
import { CALENDAR_ADDRESS, demoCalendar } from './world-calendar.mjs';
import { answerAgents } from './runner.mjs';
import { gitlabWorld } from './world-gitlab.mjs';

const HERE = fileURLToPath(new URL('./', import.meta.url));
const REPO = fileURLToPath(new URL('../../', import.meta.url));
const GITLAB = 'https://gitlab.com';
const TOKEN = 'demo-token';
const LATER_MS = 3 * 3_600_000;
const STABLE_MS = 400;

const realFetch = globalThis.fetch;
const root = process.env.DEMO_ROOT || mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'underlings-demo-'));
const home = join(root, 'home');
const bin = join(root, 'bin');
const stateDir = join(home, '.local/state/underlings/engine');
const epoch = Date.now();

function wrapper(name, script) {
  const file = join(bin, name);
  writeFileSync(file, `#!/bin/sh\nexec "${process.execPath}" "${join(HERE, script)}" "$@"\n`);
  chmodSync(file, 0o755);
  return file;
}

function environment() {
  for (const name of Object.keys(process.env)) if (/^(?:UNDERLINGS_|ORCA_|CLAUDE_|GITHUB_TOKEN$|GH_TOKEN$|GITLAB_|JIRA_)/.test(name)) delete process.env[name];
  mkdirSync(bin, { recursive: true });
  Object.assign(process.env, {
    HOME: home, TZ: 'Europe/London', GITLAB_TOKEN: TOKEN, UNDERLINGS_STATE_DIR: stateDir, UNDERLINGS_LOCALE_FILE: join(home, '.config/underlings/locale.json'),
    CLAUDE_CONFIG_DIR: join(home, '.claude'), DEMO_EPOCH: String(epoch), DEMO_JIRA_FILE: join(root, 'jira.json'),
    UNDERLINGS_CLAUDE_BIN: wrapper('claude', 'fake-claude.mjs'), UNDERLINGS_ACLI: wrapper('acli', 'fake-acli.mjs'),
  });
}

// The pid every live agent's runner lock names, so the page sees them as running.
function runnerStandIn() {
  const child = realSpawn('/bin/sleep', ['86400'], { stdio: 'ignore', detached: true });
  child.unref();
  return child.pid;
}

// Anything this world does not make is refused: a command other than its own fakes, and any address other than the fake GitLab and calendar.
function guardProcesses() {
  const own = (file) => file === process.execPath || String(file).startsWith(`${bin}/`);
  const idle = () => {
    const child = { pid: undefined, stdout: null, stderr: null, on: () => child, once: () => child, unref() {}, kill: () => false };
    child.stdin = { on: () => child.stdin, end() {}, write() {} };
    return child;
  };
  const refuse = (file) => Object.assign(new Error(`${file} is not run in the demo`), { code: 'ENOENT' });
  function execFile(file, args = [], options, done) {
    const callback = typeof options === 'function' ? options : done;
    if (own(file)) return realExecFile(file, args, typeof options === 'function' ? {} : options, callback);
    const quiet = String(file).endsWith('/git') || file === 'git';
    setImmediate(() => (quiet ? callback?.(null, '', '') : callback?.(Object.assign(refuse(file), { stdout: '', stderr: '' }), '', '')));
    return idle();
  }
  execFile[promisify.custom] = (file, args, options) => new Promise((resolve, reject) => execFile(file, args, options, (err, stdout, stderr) => (err ? reject(err) : resolve({ stdout, stderr }))));
  const spawn = (file, args, options) => (own(file) ? realSpawn(file, args, options) : idle());
  const sync = (real) => (file, ...rest) => {
    if (!own(file)) throw refuse(file);
    return real(file, ...rest);
  };
  const named = { execFile, spawn, execFileSync: sync(realExecFileSync), spawnSync: sync(realSpawnSync), exec: (cmd) => { throw refuse(cmd); }, execSync: (cmd) => { throw refuse(cmd); }, fork: (file) => { throw refuse(file); } };
  mock.module('node:child_process', { namedExports: named, defaultExport: named });
}

function guardNetwork(world) {
  const gitlab = fakeGitlab(world, { host: GITLAB, token: TOKEN });
  const meeting = () => {
    const file = join(root, 'next-meeting.json');
    return existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')).startsAt : Date.now() + LATER_MS;
  };
  globalThis.fetch = async (input, init) => {
    const url = new URL(typeof input === 'string' ? input : input.url ?? String(input));
    if (url.origin === GITLAB) return gitlab.fetch(url.href, init);
    if (url.href === CALENDAR_ADDRESS) return new Response(demoCalendar(Date.now(), (meeting() - Date.now()) / 1000), { headers: { 'content-type': 'text/calendar' } });
    if (['127.0.0.1', 'localhost'].includes(url.hostname)) return realFetch(input, init);
    throw new TypeError(`the demo makes no request to ${url.origin}`);
  };
  return gitlab;
}

function desktopStub() {
  const assets = { 'xterm.js': '@xterm/xterm/lib/xterm.js', 'xterm.css': '@xterm/xterm/css/xterm.css', 'addon-fit.js': '@xterm/addon-fit/lib/addon-fit.js', 'addon-web-links.js': '@xterm/addon-web-links/lib/addon-web-links.js' };
  const found = {};
  for (const [name, id] of Object.entries(assets)) found[name] = join(REPO, 'desktop/node_modules', id);
  const opened = { overlay: 0 };
  return {
    port: Number(process.env.DEMO_PORT) || 0, opened,
    showPage: () => ({ reused: false }), focus() {}, quit() {}, popOut() {}, dockClaude() {}, claudeOnTop() {}, claudeWindow: () => ({ shown: false, onTop: true }),
    notify: () => ({ delivered: true }), openExternal: async () => ({ ok: true }), openTerminal: () => ({ shown: true }), restartTerminal: () => ({ shown: true }), pasteTerminal: async () => true,
    onTerminalTyped: () => () => {}, terminalAssets: found, showOverlay: () => { opened.overlay += 1; return { shown: 1 }; }, closeOverlay() {}, hotkeys: null,
  };
}

async function ready() {
  const engine = await import('../../lib/engine.mjs');
  for (let tries = 0; tries < 300 && !(engine.inbox && !engine.loading()); tries += 1) await new Promise((resolve) => setTimeout(resolve, 100));
}

async function settled() {
  const { MODULES } = await import('../../lib/actions.mjs');
  const quiet = async () => Promise.allSettled([MODULES.slack.settled(), MODULES.email.settled(), MODULES.game.settled(), MODULES.standup.settled(), MODULES.tickets.settled(), MODULES.qa.settled(), MODULES.calendar.settled()]);
  await quiet();
  await new Promise((resolve) => setTimeout(resolve, STABLE_MS));
  await quiet();
}

async function main() {
  environment();
  const runnerPid = runnerStandIn();
  seedWorld({ root, home, stateDir, runnerPid, now: epoch });
  mkdirSync(join(home, '.claude'), { recursive: true });
  const world = gitlabWorld(epoch);
  guardProcesses();
  guardNetwork(world);
  const { default: activate, deactivate } = await import('../../worker.mjs');
  const logged = [];
  await activate({ log: (text) => logged.push(text), commands: { register() {} }, host: { call: async () => undefined }, desktop: desktopStub() });
  const { MODULES } = await import('../../lib/actions.mjs');
  await ready();
  MODULES.selfupdate.stop();
  const stopRunners = answerAgents(join(stateDir, 'agents'));
  const app = await import('../../lib/app.mjs');
  await app.route({ method: 'POST', path: '/api/whatsnew/seen', query: new URLSearchParams(), body: async () => ({}), config: {} });
  const url = logged.find((t) => t.includes(' at http'))?.split(' at ')[1];
  await MODULES.slack.fetchSlack?.();
  await MODULES.email.fetchMail?.();
  await settled();
  process.stdout.write(`DEMO_URL ${url}\nDEMO_ROOT ${root}\n`);
  const stop = async () => {
    stopRunners();
    await deactivate();
    try {
      process.kill(runnerPid);
    } catch {}
    if (!process.env.DEMO_ROOT) rmSync(root, { recursive: true, force: true });
    process.exit(0);
  };
  process.on('SIGTERM', stop);
  process.on('SIGINT', stop);
}

await mkdir(root, { recursive: true });
main().catch((err) => {
  process.stderr.write(`${err.stack ?? err}\n`);
  process.exit(1);
});
