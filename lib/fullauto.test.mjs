import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, describe, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { engineFile } from './engine.mjs';

const ENGINE = engineFile({ matrixEngine: process.env.UNDERLINGS_TEST_ENGINE });
const HARNESS = fileURLToPath(new URL('./workerproc.mjs', import.meta.url));
const FAKE_CLAUDE = fileURLToPath(new URL('./fixtures/fake-claude.mjs', import.meta.url));
const ROOT = mkdtempSync(join(tmpdir(), 'cc-fullauto-'));
const KEY = 'acme/engine!621';
const INTERRUPTED = 'sending was interrupted, so check the MR before it goes again';
const workers = [];

const BEAT_MS = 500;
const POLL_SECONDS = 1;
const PACED_ENGINE = join(ROOT, 'paced-engine.mjs');

const tuiDir = join(ROOT, 'tui-state');
mkdirSync(tuiDir, { recursive: true });
process.env.UNDERLINGS_STATE_DIR = tuiDir;
process.env.HOME = join(ROOT, 'home');
// A build that will not load fails the file before any hook can tidy up, so this one does.
const engine = existsSync(ENGINE) ? await import(pathToFileURL(ENGINE).href).catch((err) => { rmSync(ROOT, { recursive: true, force: true }); throw err; }) : null;
const skip = engine ? false : `needs the review engine built at ${ENGINE}: run npm run build, or set UNDERLINGS_SKIP_REAL_ENGINE=1 to skip these on purpose`;
if (skip && !process.env.UNDERLINGS_SKIP_REAL_ENGINE) test('the review engine is built for full auto to run on', () => assert.fail(skip));
// The real build, with the worker's beat and poll floor shortened, so a test waits on what the workers do rather than on their clock.
writeFileSync(PACED_ENGINE, `export * from ${JSON.stringify(pathToFileURL(ENGINE).href)};
import { SETTING_ROWS as rows } from ${JSON.stringify(pathToFileURL(ENGINE).href)};
export const AUTO_BEAT_MS = ${BEAT_MS};
export const SETTING_ROWS = rows.map((row) => (row.key === 'pollSeconds' ? { ...row, bounds: { ...row.bounds, min: ${POLL_SECONDS} } } : row));
`);

after(async () => {
  await Promise.all(workers.map((w) => w.kill()));
  await agentRunnersGone();
  rmSync(ROOT, { recursive: true, force: true });
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const alive = (pid) => {
  try {
    return process.kill(pid, 0);
  } catch {
    return false;
  }
};

const lockedBy = (path) => {
  try {
    return Number(readFileSync(path, 'utf8'));
  } catch {
    return 0;
  }
};

// Agents run detached from the worker that started them, so one still finishing its turn would write into a folder being removed.
async function agentRunnersGone() {
  const locks = readdirSync(ROOT, { recursive: true }).filter((name) => name.endsWith('runner.lock'));
  const pids = locks.map((name) => lockedBy(join(ROOT, name))).filter((pid) => pid > 0);
  for (const end = Date.now() + 10_000; pids.some(alive) && Date.now() < end; await sleep(100));
  for (const pid of pids.filter(alive)) process.kill(pid, 'SIGKILL');
}

async function until(check, ms, what) {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(200)) {
    const value = await check();
    if (value) return value;
  }
  assert.fail(`gave up after ${ms / 1000} s waiting for ${what}`);
}

function stateFolder(name, { settings = {}, due = 0, passSha = 'head-1', watches = {} } = {}) {
  const dir = name === 'tui' ? tuiDir : mkdtempSync(join(ROOT, `${name}-`));
  const now = Date.now();
  const write = (file, value) => writeFileSync(join(dir, file), JSON.stringify(value));
  const workspace = mkdtempSync(join(ROOT, 'ws-'));
  write('state.json', { watches, seen: {}, verdicts: {}, settings: { fullAuto: 'heidi:comments', workspaceRoot: workspace, pollSeconds: POLL_SECONDS, ...settings } });
  write('repos.json', { at: new Date(now).toISOString(), repos: [{ path: 'acme/engine', label: 'Engine' }] });
  if (due) write('auto.json', { [KEY]: { key: KEY, pass: { id: 'p1', key: KEY, author: 'heidi', sha: passSha, trigger: 'new', launchedAt: new Date(now).toISOString() } } });
  write('queue.json', Array.from({ length: due }, (_, n) => ({
    id: `item-${n}`, projectPath: 'acme/engine', projectId: 1001, iid: 621, webUrl: '', severity: 'MINOR', body: `finding ${n}`, createdBy: 'auto:p1',
    createdAt: new Date(now - 120_000).toISOString(), status: 'pending', auto: { pass: 'p1', level: 'comments', sendAt: new Date(now - 60_000).toISOString() },
  })));
  const fake = join(dir, 'fake.json');
  writeFileSync(fake, JSON.stringify({ mrs: [{ iid: 621, author: 'heidi', sha: 'head-1' }], postDelayMs: 0 }));
  return {
    dir,
    workspace,
    writes: join(dir, 'writes.log'),
    steer: (change) => {
      writeFileSync(`${fake}.tmp`, JSON.stringify({ ...JSON.parse(readFileSync(fake, 'utf8')), ...change }));
      renameSync(`${fake}.tmp`, fake);
    },
    queue: () => JSON.parse(readFileSync(join(dir, 'queue.json'), 'utf8')),
    lock: () => (existsSync(join(dir, 'auto.lock')) ? JSON.parse(readFileSync(join(dir, 'auto.lock'), 'utf8')) : null),
    presences: () => (existsSync(join(dir, 'frontends')) ? readdirSync(join(dir, 'frontends')).filter((n) => n.endsWith('.json')) : []),
    wants: (pid) => existsSync(join(dir, 'frontends', `underlings-${pid}.json`)) && JSON.parse(readFileSync(join(dir, 'frontends', `underlings-${pid}.json`), 'utf8')).wants,
    logged: () => (existsSync(join(dir, 'writes.log')) ? readFileSync(join(dir, 'writes.log'), 'utf8').trim().split('\n').filter(Boolean) : []),
  };
}

function posts(folder) {
  return folder.logged().flatMap((line) => {
    const [pid, , method, path, ...body] = line.split(' ');
    return method === 'POST' && path.endsWith('/discussions') ? [{ pid: Number(pid), item: /finding (\d+)/.exec(body.join(' '))?.[1] }] : [];
  });
}

const launches = (folder) => folder.logged().filter((line) => / orca worktree create$/.test(line));
// The plugin still shows its own page in an Orca tab; anything about agents or workspaces is what must not reach Orca.
const askedOrca = (folder) => folder.logged().filter((line) => / orca(?:-read)? (?:worktree|terminal|automations) /.test(line));
const runs = (folder) => (existsSync(join(folder.dir, 'runs.json')) ? JSON.parse(readFileSync(join(folder.dir, 'runs.json'), 'utf8')) : {});
const claudeLaunches = (folder) => (existsSync(join(folder.dir, 'agents')) ? readdirSync(join(folder.dir, 'agents')) : []);

class Worker {
  constructor(folder, extraEnv = {}) {
    const home = mkdtempSync(join(ROOT, 'home-'));
    mkdirSync(join(home, '.config/underlings'), { recursive: true });
    writeFileSync(join(home, '.config/underlings/config.json'), JSON.stringify({ port: 0, orcaUserDataPath: '/orca-profile', matrixEngine: PACED_ENGINE, workspaceRoot: folder.workspace }));
    // Every worker gets the fake, so no test can start a real Claude Code session.
    const env = { ...process.env, HOME: home, UNDERLINGS_STATE_DIR: folder.dir, GITLAB_TOKEN: 'stub', UNDERLINGS_FAKE: join(folder.dir, 'fake.json'), UNDERLINGS_WRITES: folder.writes, UNDERLINGS_CLAUDE_BIN: FAKE_CLAUDE, ...extraEnv };
    delete env.NODE_TEST_CONTEXT;
    delete env.ORCA_WORKSPACE_ROOT;
    this.child = spawn(process.execPath, ['--experimental-test-module-mocks', '--no-warnings', HARNESS], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    this.lines = [];
    this.child.stderr.on('data', (d) => this.lines.push(String(d)));
    createInterface({ input: this.child.stdout }).on('line', (line) => this.lines.push(line));
    this.exited = new Promise((resolve) => this.child.once('exit', resolve));
    workers.push(this);
  }

  get pid() {
    return this.child.pid;
  }

  async ready() {
    const said = await until(() => this.lines.find((l) => l.startsWith('[log] Underlings at ')), 15_000, `worker ${this.pid} to listen: ${this.lines.join(' | ')}`);
    const url = new URL(said.slice('[log] Underlings at '.length));
    Object.assign(this, { origin: url.origin, token: url.searchParams.get('t') });
    // The worker listens before its start has loaded the engine, and only then does the page get a driver to read.
    await until(async () => (await this.matrix())?.driver, 15_000, `worker ${this.pid} to load the engine`);
    return this;
  }

  async matrix() {
    const res = await fetch(`${this.origin}/api/state?t=${this.token}`);
    return (await res.json()).matrix;
  }

  async driver() {
    return (await this.matrix()).driver;
  }

  async act(name, body) {
    const res = await fetch(`${this.origin}/api/matrix/${name}`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-cc-token': this.token, origin: this.origin }, body: JSON.stringify(body) });
    return [res.status, await res.text()];
  }

  async reload() {
    const res = await fetch(`${this.origin}/api/reload`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-cc-token': this.token, origin: this.origin }, body: '{}' });
    assert.equal(res.status, 200, await res.clone().text());
  }

  async deactivate() {
    this.child.stdin.write('deactivate\n');
    await until(() => this.lines.includes('[deactivated]'), 5000, `worker ${this.pid} to deactivate`);
    await this.exited;
  }

  async kill() {
    if (this.child.exitCode !== null || this.child.signalCode) return;
    this.child.kill('SIGKILL');
    await this.exited;
  }
}

// More polls begun since, and no step running, so each but the last has run to its end.
async function polled(worker, count) {
  const seen = new Set([(await worker.driver()).lastPollAt]);
  await until(async () => {
    const { lastPollAt, busy } = await worker.driver();
    seen.add(lastPollAt);
    return seen.size > count && !busy;
  }, 10_000, `worker ${worker.pid} to poll ${count} more times`);
}

async function driving(worker) {
  await worker.ready();
  await until(async () => (await worker.driver()).state === 'here', 20_000, `worker ${worker.pid} to drive`);
  return worker;
}

describe('full auto on the real engine', { skip, concurrency: true }, () => {
  test('a worker drives full auto on its own and sends every item that is due, from its own pid', async () => {
    const folder = stateFolder('alone', { due: 6 });
    const worker = await driving(new Worker(folder));
    await until(() => posts(folder).length === 6, 40_000, 'the worker to send all six');
    assert.deepEqual(posts(folder).map((p) => p.pid), Array(6).fill(worker.pid));
    assert.deepEqual(posts(folder).map((p) => p.item).sort(), ['0', '1', '2', '3', '4', '5']);
    assert.ok(folder.queue().every((c) => c.status === 'posted' && c.auto.sentAuto));
    assert.equal(folder.lock().pid, worker.pid);
    await worker.deactivate();
  });

  test('two workers on one state folder never both post, even when the one driving is killed part way through', async () => {
    const folder = stateFolder('two', { due: 30 });
    folder.steer({ postDelayMs: 150 });
    const a = new Worker(folder);
    const b = new Worker(folder);
    await Promise.all([a.ready(), b.ready()]);
    await until(() => posts(folder).length >= 5, 30_000, 'the first few posts');
    const first = posts(folder)[0].pid;
    const [driver, survivor] = first === a.pid ? [a, b] : [b, a];
    await driver.kill();
    const killedAfter = posts(folder).length;
    const settled = (c) => c.status === 'posted' || c.auto?.held === INTERRUPTED;
    await until(() => folder.queue().every(settled), 60_000, 'every item to be sent or handed back');
    const sent = posts(folder);
    assert.equal(new Set(sent.map((p) => p.item)).size, sent.length, `an item went twice: ${JSON.stringify(sent)}`);
    assert.ok(sent.slice(0, killedAfter).every((p) => p.pid === driver.pid), 'only one of them posted before the kill');
    assert.ok(sent.slice(killedAfter).every((p) => p.pid === survivor.pid), 'and only the other after it');
    const handedBack = folder.queue().filter((c) => c.auto?.held === INTERRUPTED);
    assert.ok(handedBack.length <= 1, 'at most the one cut off mid-send comes back to you');
    for (const c of handedBack) assert.ok(!sent.slice(killedAfter).some((p) => p.item === c.id.slice('item-'.length)), 'and it is never sent again');
    assert.equal(folder.lock().pid, survivor.pid);
    await survivor.deactivate();
  });

  test('a code reload in place keeps one driver on the same seat, and what it sends afterwards goes once', async () => {
    const folder = stateFolder('reload');
    const worker = await driving(new Worker(folder));
    const { token, pid } = folder.lock();
    for (let i = 0; i < 3; i += 1) {
      await worker.reload();
      assert.equal(folder.lock().token, token);
    }
    const reloadedAt = Date.now();
    const beats = new Set();
    await until(() => {
      const { beatAt } = folder.lock();
      if (beatAt > reloadedAt) beats.add(beatAt);
      return beats.size >= 2;
    }, 10_000, 'the lock to beat twice after the reloads');
    assert.deepEqual([folder.lock().token, folder.lock().pid], [token, pid], 'it is still beating, on the same seat');
    assert.deepEqual(folder.presences(), [`underlings-${worker.pid}.json`]);
    assert.equal((await worker.driver()).state, 'here');
    const fresh = stateFolder('reload-seed', { due: 5 });
    for (const file of ['auto.json', 'queue.json']) writeFileSync(join(folder.dir, file), readFileSync(join(fresh.dir, file)));
    await until(() => folder.queue().every((c) => c.status === 'posted'), 20_000, 'the five queued after the reload');
    assert.deepEqual(posts(folder).map((p) => p.item).sort(), ['0', '1', '2', '3', '4']);
    await worker.deactivate();
  });

  test('deactivate gives the turn up at once, so another worker takes it on its next beat', async () => {
    const folder = stateFolder('handover');
    const first = await driving(new Worker(folder));
    const second = await new Worker(folder).ready();
    const waiting = new RegExp(`another worker \\(pid ${first.pid}\\) drives full auto`);
    await until(async () => { const { state, why } = await second.driver(); return state === 'starting' && waiting.test(why); }, 10_000, 'the second worker to wait its turn, saying who drives');
    await first.deactivate();
    assert.notEqual(folder.lock()?.pid, first.pid, 'its lock went with it');
    assert.ok(!folder.presences().includes(`underlings-${first.pid}.json`), 'and so did its presence');
    await until(async () => (await second.driver()).state === 'here', 12_000, 'the second worker to take over');
    await second.deactivate();
    assert.equal(folder.lock(), null);
  });

  test('with agentHost orca in the state file, a failed Orca terminal list launches nothing, and the same MR launches in Orca once it answers', async () => {
    const folder = stateFolder('orca', { settings: { agentHost: 'orca', workspaceRoot: '/ws-root' } });
    folder.steer({ orcaListFails: true });
    const worker = await driving(new Worker(folder));
    await until(async () => (await worker.driver()).recent.some((r) => r.error && /not launching: the agents could not be listed/.test(r.text)), 40_000, 'a poll to refuse to launch');
    assert.deepEqual(launches(folder), []);
    folder.steer({ orcaListFails: false });
    await until(() => launches(folder).length > 0, 40_000, 'the review to launch once Orca lists its terminals');
    await polled(worker, 2);
    assert.equal(launches(folder).length, 1);
    assert.ok((await worker.driver()).recent.some((r) => r.text === `Reviewing ${KEY}`));
    const runs = JSON.parse(readFileSync(join(folder.dir, 'runs.json'), 'utf8'));
    assert.equal(runs[KEY].status, 'working');
    await worker.deactivate();
  });

  test('a Review straight after full auto launched one is refused, and launches nothing more', async () => {
    const folder = stateFolder('retry');
    const worker = await driving(new Worker(folder));
    await until(() => claudeLaunches(folder).length > 0, 40_000, 'full auto to launch a review');
    assert.deepEqual(await worker.act('review', { key: KEY }), [409, `an agent is already reading ${KEY}`]);
    await polled(worker, 2);
    assert.equal(claudeLaunches(folder).length, 1);
    await worker.deactivate();
  });

  test('Discard and Edit on an item full auto is part way through sending are refused, and it goes as it was claimed', async () => {
    const folder = stateFolder('mid-send', { due: 2 });
    folder.steer({ holdPosts: ['finding 0', 'finding 1'] });
    const worker = await driving(new Worker(folder));
    const claimed = (id) => folder.queue().find((c) => c.id === id)?.sending;
    await until(() => claimed('item-0'), 30_000, 'full auto to claim the first item');
    assert.deepEqual(await worker.act('discard', { id: 'item-0' }), [409, 'full auto is sending this right now']);
    folder.steer({ holdPosts: ['finding 1'] });
    await until(() => claimed('item-1'), 30_000, 'full auto to claim the second item');
    assert.deepEqual(await worker.act('edit', { id: 'item-1', body: 'rewritten mid-send' }), [409, 'full auto is sending this right now']);
    folder.steer({ holdPosts: [] });
    await until(() => folder.queue().every((c) => c.status === 'posted'), 30_000, 'both to be posted');
    assert.deepEqual(folder.queue().map((c) => c.body), ['finding 0', 'finding 1']);
    assert.deepEqual(posts(folder).map((p) => p.item), ['0', '1']);
    await worker.deactivate();
  });

  test('by default full auto reviews as Claude Code with nothing asked of Orca at all, captures what it said, and the page lists the agent and reads its conversation', async () => {
    const folder = stateFolder('claude');
    const worker = await driving(new Worker(folder, { UNDERLINGS_FAKE_CLAUDE_SAYS: 'Reviewed !621, nothing to raise.' }));
    const run = await until(() => runs(folder)[KEY]?.terminal?.startsWith('claude:') && runs(folder)[KEY], 40_000, 'full auto to launch a Claude Code review');
    await until(() => runs(folder)[KEY]?.tail?.includes('Reviewed !621, nothing to raise.'), 40_000, 'the run to capture what it said');
    const read = async (path) => (await fetch(`${worker.origin}${path}${path.includes('?') ? '&' : '?'}t=${worker.token}`)).json();
    const listed = (await read('/api/state')).agents.find((a) => a.handle === run.terminal);
    assert.deepEqual([listed?.name, listed?.kind, listed?.mr, listed?.cwd], ['review-Engine-621', 'review', KEY, folder.workspace]);
    const chat = await read(`/api/agents/conversation?handle=${encodeURIComponent(run.terminal)}`);
    assert.deepEqual(chat.entries.map((e) => e.kind), ['you', 'tool', 'said']);
    assert.match(chat.entries[0].text, /^\/underlings:review https:\/\/gitlab\.com\/acme\/engine\/-\/merge_requests\/621 [\s\S]*Unattended full-auto pass/);
    assert.deepEqual(askedOrca(folder), [], 'Orca was neither asked to list nor to launch anything');
    await worker.deactivate();
  });

  test('a daily re-review that is due fires from the worker driving full auto, as Claude Code, and its day moves on', async () => {
    const watch = { key: KEY, projectPath: 'acme/engine', iid: 621, webUrl: 'https://gitlab.com/acme/engine/-/merge_requests/621', auto: false, addedAt: new Date().toISOString(), seen: { sha: 'head-0', pipeline: 'SUCCESS', notes: 0, approvals: 0, unresolved: 0 }, daily: { nextAt: new Date(Date.now() - 60_000).toISOString() } };
    const folder = stateFolder('daily', { settings: { fullAuto: '' }, watches: { [KEY]: watch } });
    const worker = await driving(new Worker(folder));
    const run = await until(() => runs(folder)[KEY]?.terminal?.startsWith('claude:') && runs(folder)[KEY], 40_000, 'the daily re-review to launch');
    const state = JSON.parse(readFileSync(join(folder.dir, 'state.json'), 'utf8'));
    assert.ok(Date.parse(state.watches[KEY].daily.nextAt) > Date.now() + 23 * 3600_000, 'the next look is a day out');
    assert.equal(state.watches[KEY].seen.sha, 'head-1', 'the change it fired on is taken');
    assert.ok((await worker.driver()).recent.some((r) => r.text === `Re-reviewing ${KEY}`));
    const conversation = async () => (await fetch(`${worker.origin}/api/agents/conversation?handle=${encodeURIComponent(run.terminal)}&t=${worker.token}`)).json();
    const [prompt] = await until(async () => { const { entries } = await conversation(); return entries.length && entries; }, 20_000, 'the runner to send the prompt');
    assert.match(prompt.text, /^\/underlings:review https:\/\/gitlab\.com\/acme\/engine\/-\/merge_requests\/621/);
    await polled(worker, 2);
    assert.equal(claudeLaunches(folder).length, 1, 'once');
    assert.deepEqual(askedOrca(folder), []);
    await worker.deactivate();
  });
});
