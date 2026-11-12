import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, mock } from 'node:test';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { fakeGithub } from '../../engine/src/fixtures/github/fakegithub.mjs';
import { githubWorld } from '../../engine/src/fixtures/github/world.mjs';
import { fakeGitlab } from './gitlab-golden/fakegitlab.mjs';
import { fakeChildProcess } from './gitlab-golden/fakeprocs.mjs';
import { seed } from './gitlab-golden/session.mjs';
import { goldenWorld, HOST } from './gitlab-golden/world.mjs';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const MARK = '__CONTROL_CENTRE__';

// The login shell answers the names asked of it from `shell`, gh answers shell.gh as its token, and every other command is the baseline's.
function withLoginShell(procs, shell, calls) {
  const execFile = (cmd, args = [], options, done) => {
    const callback = typeof options === 'function' ? options : done;
    const idle = { pid: undefined, on() { return this; }, once() { return this; }, unref() {}, kill: () => false };
    if (cmd === 'gh') {
      calls.push(['gh', ...args]);
      setImmediate(() => (shell.gh ? callback(null, `${shell.gh}\n`, '') : callback(Object.assign(new Error('not logged in'), { code: 1, stdout: '', stderr: '' }), '', '')));
      return idle;
    }
    if (cmd !== '/bin/zsh') return procs.execFile(cmd, args, options, done);
    const names = [...String(args[1]).matchAll(/"\$(\w+)"/g)].map((m) => m[1]);
    calls.push(['zsh', ...names]);
    setImmediate(() => callback(null, MARK + names.map((n) => `${shell[n] ?? ''}\0`).join(''), ''));
    return idle;
  };
  execFile[promisify.custom] = (cmd, args, options) => new Promise((resolve, reject) => {
    execFile(cmd, args, options, (err, stdout, stderr) => (err ? reject(err) : resolve({ stdout, stderr })));
  });
  return { ...procs, execFile };
}

/**
 * The worker over the built engine, with GitLab and GitHub both faked and nothing else reachable: no gh, no shell, no Orca, no Claude.
 * Call it at the top of a test file, before anything else imports the worker.
 */
export async function githubWorker({ github = true, token = 'ghp_workerworkerworkerworkerworkerwo' } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'underlings-github-worker-'));
  const home = join(root, 'home');
  after(() => rmSync(root, { recursive: true, force: true }));
  for (const name of Object.keys(process.env)) if (/^(?:UNDERLINGS_|ORCA_|CLAUDE_CONFIG_DIR$|GITHUB_TOKEN$|GH_TOKEN$)/.test(name)) delete process.env[name];
  Object.assign(process.env, {
    HOME: home,
    TZ: 'Europe/London',
    GITLAB_TOKEN: 'golden-token',
    ...(token ? { GITHUB_TOKEN: token } : {}),
    UNDERLINGS_STATE_DIR: join(home, '.local/state/underlings/engine'),
    UNDERLINGS_LOCALE_FILE: join(home, '.config/underlings/locale.json'),
    UNDERLINGS_CLAUDE_BIN: fileURLToPath(new URL('./fake-claude.mjs', import.meta.url)),
    UNDERLINGS_ACLI: 'acli',
  });
  mkdirSync(home, { recursive: true });

  const gitlabWorld = goldenWorld();
  const gitlab = fakeGitlab(gitlabWorld, { host: HOST, token: 'golden-token' });
  const hub = fakeGithub(githubWorld());
  const calls = [];
  const shell = {};
  const down = { gitlab: false };
  mock.module('node:child_process', { namedExports: withLoginShell(fakeChildProcess(gitlabWorld, calls), shell, calls) });
  globalThis.fetch = async (input, init) => {
    if (new URL(String(input)).origin !== HOST) return hub.fetch(input, init);
    return down.gitlab ? Response.json({ message: '401 Unauthorized' }, { status: 401 }) : gitlab.fetch(input, init);
  };

  const { config } = seed(root, home, github ? { github: { on: true, scope: 'involved', repos: '', host: '' } } : {});
  const app = await import('../app.mjs');
  const worker = await import('../engine.mjs');
  const { MODULES: mods, act } = await import('../actions.mjs');
  const route = (method, path, { query = {}, body = {} } = {}) => app.route({ method, path, query: new URLSearchParams(query), body: async () => body, config });

  const until = async (check, ms = 15_000) => {
    for (const end = performance.now() + ms; performance.now() < end; await sleep(20)) if (await check()) return;
    throw new Error('the worker gave up waiting');
  };
  const settled = () => until(() => worker.inbox && !worker.loading());

  return {
    root, home, config, gitlab, hub, calls, down, shell, worker, mods, act, route, settled, until,
    get: (path, query) => route('GET', path, { query }),
    post: (path, body) => route('POST', path, { body }),
    start: async () => {
      await worker.loadEngine(config, () => {});
      await settled();
    },
    refresh: async () => {
      await worker.refreshInbox();
      await settled();
    },
    stop: () => {
      mods.ownmr.stop();
      worker.retire();
    },
  };
}
