import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';

const ORCA = '/Applications/Orca.app/Contents/Resources/bin/orca';
const commands = [];
let tabs = [];
let shellToken = '';
let build = async () => {};

mock.module('node:child_process', {
  namedExports: {
    execFile(cmd, args, options, done) {
      commands.push({ cmd, args, options });
      const answer = (err, out = '') => setImmediate(() => done(err, out, ''));
      if (cmd === ORCA) return answer(null, JSON.stringify({ ok: true, result: orcaReply(args) }));
      if (cmd === '/usr/bin/pgrep') return answer(Object.assign(new Error('no match'), { code: 1 }));
      if (cmd === '/bin/zsh' && args[1] === 'npm run build') return build().then(() => answer(null, 'built'), (err) => answer(err, err.stdout));
      if (cmd === '/bin/zsh') return answer(null, `__CONTROL_CENTRE__${shellToken}\0`);
      return answer(Object.assign(new Error(`${cmd} is stubbed`), { code: 1 }));
    },
  },
});

function orcaReply([noun, verb]) {
  if (noun === 'tab' && verb === 'list') return { tabs };
  if (noun === 'tab' && verb === 'create') return { browserPageId: 'page-new' };
  if (verb === 'ps') return { worktrees: [] };
  if (verb === 'list') return { terminals: [] };
  return {};
}

// An engine folder in miniature: its build writes dist/engine.js, which is what the worker loads.
const home = await mkdtemp(join(tmpdir(), 'control-centre-selfheal-'));
const engineDir = join(home, 'engine');
const entry = join(engineDir, 'dist/engine.js');
const tokenFile = join(home, '.config/underlings/gitlab-token');
const testkit = new URL('./testkit.mjs', import.meta.url).href;
const engineSource = (n) => `export * from '${testkit}';
import { world } from '${testkit}';
export const build = ${n};
export async function createTerminal(opts) {
  world.calls.push(['createTerminal', opts]);
  return { handle: 'term-1' };
}
`;
process.env.HOME = home;
process.env.GITLAB_TOKEN = 'stub-token-for-the-tests';
await mkdir(join(engineDir, 'dist'), { recursive: true });
await writeFile(join(engineDir, 'package.json'), JSON.stringify({ name: 'the-matrix', type: 'module', scripts: { build: 'tsup' } }));
await writeFile(entry, engineSource(1));
await mkdir(join(home, '.config/underlings'), { recursive: true });
const config = { port: 0, orcaUserDataPath: '/orca-profile', matrixEngine: entry };
await writeFile(join(home, '.config/underlings/config.json'), JSON.stringify(config));
const { world } = await import('./testkit.mjs');
world.settings = { workspaceRoot: '/ws-root' };

const until = async (check) => {
  for (let i = 0; i < 200 && !check(); i += 1) await new Promise((r) => setTimeout(r, 10));
};
const orcaCalls = () => commands.filter(({ cmd }) => cmd === ORCA).map(({ args }) => args);

const worker = await import('../worker.mjs');
const logged = [];
await worker.default({ log: (t) => logged.push(t), commands: { register() {} }, events: { on() {} }, host: { call: async () => {} } });
const pageUrl = new URL(logged.find((t) => t.startsWith('Underlings at ')).slice('Underlings at '.length));
const origin = pageUrl.origin;
const token = pageUrl.searchParams.get('t');
await until(() => logged.some((t) => /opened itself|already open/.test(t)));
const activation = orcaCalls();
const live = await import('./engine.mjs');
const { start } = await import('./selfheal.mjs');

after(async () => {
  await worker.deactivate();
  await rm(home, { recursive: true });
});

beforeEach(() => {
  commands.length = 0;
  tabs = [];
});

function post(path, body) {
  return fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-cc-token': token, origin }, body: JSON.stringify(body) });
}

test('on activation the dashboard opens itself in the workspace root when no tab holds it, without taking focus', () => {
  assert.deepEqual(activation, [
    ['tab', 'list', '--worktree', 'all', '--json'],
    ['tab', 'list', '--json'],
    ['tab', 'create', '--url', pageUrl.href, '--worktree', 'path:/ws-root', '--json'],
  ]);
});

test('activation repoints only this port\'s dashboard tabs that carry another token, keeping their view, and opens nothing more', async () => {
  tabs = [
    { browserPageId: 'stale', url: `${origin}/?t=old#merge-requests` },
    { browserPageId: 'current', url: pageUrl.href },
    { browserPageId: 'other-port', url: 'http://127.0.0.1:47321/?t=old' },
    { browserPageId: 'localhost', url: `http://localhost:${pageUrl.port}/?t=old` },
    { browserPageId: 'api', url: `${origin}/api/state?t=old` },
    { browserPageId: 'gitlab', url: 'https://gitlab.com/acme/engine/-/merge_requests/1' },
  ];
  const said = [];
  await start(config, { log: (t) => said.push(t), carried: null });
  assert.deepEqual(orcaCalls(), [
    ['tab', 'list', '--worktree', 'all', '--json'],
    ['goto', '--page', 'stale', '--url', `${origin}/?t=${token}#merge-requests`, '--json'],
  ]);
  assert.match(said.join(), /already open in Orca, and 1 tab\(s\) now carry the current link/);
  commands.length = 0;
  await start(config, { log() {}, carried: {} });
  assert.deepEqual(orcaCalls(), []);
});

test('Rebuild runs npm run build where the engine is loaded from, then imports the new build under a new URL', async () => {
  const before = live.carry().engineUrl;
  assert.equal(live.engine.build, 1);
  build = () => writeFile(entry, engineSource(2));
  const res = await post('/api/rebuild', {});
  assert.equal(res.status, 200, await res.clone().text());
  assert.match((await res.json()).text, /Rebuilt the review engine in \d+ s and loaded it/);
  const [shell] = commands.filter(({ cmd }) => cmd === '/bin/zsh');
  assert.deepEqual(shell.args, ['-ilc', 'npm run build']);
  assert.deepEqual([shell.options.cwd, shell.options.timeout], [engineDir, 180_000]);
  assert.equal(live.engine.build, 2);
  assert.notEqual(live.carry().engineUrl, before);
  assert.match(live.carry().engineUrl, /engine\.js\?cc=/);
});

test('a build that fails, or one that will not import, leaves the working engine in place', async () => {
  build = async () => {
    throw Object.assign(new Error('Command failed'), { stdout: 'src/engine.ts: Unexpected "}"' });
  };
  const failed = await post('/api/rebuild', {});
  assert.equal(failed.status, 500);
  assert.match(await failed.text(), /npm run build failed in .*engine: [\s\S]*Unexpected "}"/);
  build = () => writeFile(entry, engineSource(3) + 'export const ;\n');
  const broken = await post('/api/rebuild', {});
  assert.equal(broken.status, 500);
  assert.match(await broken.text(), /could not load the review engine .* so the running code stays/);
  assert.equal(live.engine.build, 2);
  build = () => writeFile(entry, engineSource(4));
  assert.equal((await post('/api/rebuild', {})).status, 200);
  assert.equal(live.engine.build, 4);
});

test('Rebuild refuses a folder with no build script and runs nothing', async () => {
  await writeFile(join(engineDir, 'package.json'), JSON.stringify({ name: 'the-matrix', type: 'module' }));
  const res = await post('/api/rebuild', {});
  await writeFile(join(engineDir, 'package.json'), JSON.stringify({ name: 'the-matrix', type: 'module', scripts: { build: 'tsup' } }));
  assert.equal(res.status, 400);
  assert.deepEqual(commands.filter(({ cmd }) => cmd === '/bin/zsh'), []);
});

test('there is no route that starts the terminal app, so asking for one starts nothing', async () => {
  const res = await post('/api/start-matrix', { expect: { running: false } });
  assert.equal(res.status, 404);
  assert.deepEqual(world.calls.filter(([name]) => name === 'createTerminal'), []);
  assert.deepEqual(orcaCalls().filter(([noun, verb]) => noun === 'terminal' && verb === 'create'), []);
});

test('a pasted GitLab token is kept readable only by you and used at once, and anything else is refused', async () => {
  delete process.env.GITLAB_TOKEN;
  assert.equal((await post('/api/gitlab/token', { token: 'nope' })).status, 400);
  await assert.rejects(stat(tokenFile));
  const res = await post('/api/gitlab/token', { token: '  gl-fake-abcdefghijklmnopqrst  ' });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal((await readFile(tokenFile, 'utf8')).trim(), 'gl-fake-abcdefghijklmnopqrst');
  assert.equal((await stat(tokenFile)).mode & 0o777, 0o600);
  assert.equal(process.env.GITLAB_TOKEN, 'gl-fake-abcdefghijklmnopqrst');
});

test('Retry reads the shell profile afresh and drops a token it no longer has, but a pasted token wins over the shell', async () => {
  await rm(tokenFile, { force: true });
  process.env.GITLAB_TOKEN = 'revoked-token-from-before';
  shellToken = 'gl-fake-from-the-shell-profile';
  assert.equal((await post('/api/gitlab/retry', {})).status, 200);
  assert.equal(process.env.GITLAB_TOKEN, 'gl-fake-from-the-shell-profile');
  shellToken = '';
  const missing = await post('/api/gitlab/retry', {});
  assert.equal(missing.status, 400);
  assert.match(await missing.text(), /still no GITLAB_TOKEN/);
  assert.equal(process.env.GITLAB_TOKEN, undefined);
  shellToken = 'gl-fake-from-the-shell-profile';
  await writeFile(tokenFile, 'gl-fake-pasted-on-the-page-1234\n');
  assert.equal((await post('/api/gitlab/retry', {})).status, 200);
  assert.equal(process.env.GITLAB_TOKEN, 'gl-fake-pasted-on-the-page-1234');
  shellToken = '';
  process.env.GITLAB_TOKEN = 'stub-token-for-the-tests';
});

test('a reload stops the code it replaces, so the old module graph hears nothing more', async () => {
  const heard = [];
  live.afterFetch(() => heard.push('fetched'));
  await live.refreshInbox();
  await new Promise(setImmediate);
  assert.deepEqual(heard, ['fetched']);
  assert.equal((await post('/api/reload', {})).status, 200);
  await live.refreshInbox();
  await new Promise(setImmediate);
  assert.deepEqual(heard, ['fetched']);
});

test('a token pasted earlier is read when the code starts, ahead of the one from the shell', async () => {
  await writeFile(tokenFile, 'gl-fake-pasted-on-the-page-1234\n');
  process.env.GITLAB_TOKEN = 'gl-fake-from-the-shell-profile';
  assert.equal((await post('/api/reload', {})).status, 200);
  assert.equal(process.env.GITLAB_TOKEN, 'gl-fake-pasted-on-the-page-1234');
});
