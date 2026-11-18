import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { test } from 'node:test';
import { createSupervisor } from './supervisor.mjs';

const DEFAULT = { id: 'default', name: 'Default', port: 47321, account: '' };
const SIDE = { id: 'side-project', name: 'Side project', port: 47322, account: '2' };

// Electron's utility process as the supervisor sees it: messages both ways, an exit, and a kill.
class FakeChild extends EventEmitter {
  constructor(options) {
    super();
    this.options = options;
    this.sent = [];
    this.killed = false;
  }
  postMessage(msg) {
    this.sent.push(msg);
  }
  kill() {
    this.killed = true;
    this.emit('exit', null);
  }
  say(msg) {
    this.emit('message', msg);
  }
}

function harness({ env = { PATH: '/usr/bin', GITLAB_TOKEN: 'the-apps', CLAUDE_CONFIG_DIR: '/home/dev/.claude-alt' } } = {}) {
  const children = [];
  const logged = [];
  const timers = { waiting: [], setTimeout: (fn, ms) => (timers.waiting.push({ fn, ms }), timers.waiting.length), clearTimeout: (id) => id && (timers.waiting[id - 1].fn = null) };
  let clock = 0;
  const supervisor = createSupervisor({
    fork: (entry, args, options) => (children.push(new FakeChild({ entry, ...options })), children.at(-1)),
    entry: '/app/workspace.mjs',
    workerDir: '/app/worker',
    desktopFor: () => ({ showPage: () => ({ reused: false }), port: undefined }),
    logFor: (w) => (text) => logged.push(`${w.id}: ${text}`),
    env,
    now: () => clock,
    timers,
  });
  const fire = () => {
    const due = timers.waiting.filter((t) => t.fn).map(({ fn, ms }) => ({ fn, ms }));
    timers.waiting.forEach((t) => { t.fn = null; });
    due.forEach((t) => t.fn());
    return due.map((t) => t.ms);
  };
  return { supervisor, children, logged, fire, later: (ms) => (clock += ms) };
}

test('each workspace starts in a process of its own, with its environment and what it needs to begin', () => {
  const { supervisor, children } = harness();
  supervisor.start(DEFAULT);
  supervisor.start(SIDE);
  assert.equal(children.length, 2);
  assert.deepEqual([children[0].options.entry, children[0].options.serviceName], ['/app/workspace.mjs', 'Underlings: Default']);
  assert.equal(children[0].options.env.GITLAB_TOKEN, 'the-apps', 'Default runs as the app always has');
  assert.deepEqual([children[1].options.env.UNDERLINGS_WORKSPACE, children[1].options.env.GITLAB_TOKEN, children[1].options.env.CLAUDE_CONFIG_DIR, children[1].options.env.PATH], ['side-project', undefined, undefined, '/usr/bin']);
  const [start] = children[1].sent;
  assert.deepEqual([start.t, start.workerDir, start.workspace], ['start', '/app/worker', SIDE]);
  assert.deepEqual(start.init.methods, ['showPage']);
});

test('a worker is ready once it says it started, and says why when it could not', async () => {
  const { supervisor, children } = harness();
  const first = supervisor.start(DEFAULT);
  children[0].say({ t: 'started' });
  assert.deepEqual(await first.ready, { ok: true });
  const taken = supervisor.start(SIDE);
  children[1].say({ t: 'failed', error: { message: 'listen EADDRINUSE', code: 'EADDRINUSE', port: 47322 } });
  assert.deepEqual(await taken.ready, { ok: false, error: { message: 'listen EADDRINUSE', code: 'EADDRINUSE', port: 47322 } });
  children[1].emit('exit', 1);
  assert.equal(supervisor.get('side-project').state, 'failed', 'one that could not start is not started again and again');
});

test('a worker that dies is started again, waiting longer each time, and left stopped after the third', () => {
  const { supervisor, children, logged, fire } = harness();
  supervisor.start(SIDE);
  children[0].say({ t: 'started' });
  const waits = [];
  for (let i = 0; i < 4; i += 1) {
    children.at(-1).emit('exit', 1);
    waits.push(...fire());
    children.at(-1).say({ t: 'started' });
  }
  assert.deepEqual(waits, [2000, 15000, 60000]);
  assert.equal(children.length, 4);
  assert.match(logged.at(-1), /stopped with code 1 again, so it is left stopped until the app restarts/);
});

test('one that ran a good while before it died gets the short wait again', () => {
  const { supervisor, children, fire, later } = harness();
  supervisor.start(SIDE);
  children[0].say({ t: 'started' });
  children[0].emit('exit', 1);
  assert.deepEqual(fire(), [2000]);
  children[1].say({ t: 'started' });
  later(10 * 60_000);
  children[1].emit('exit', 1);
  assert.deepEqual(fire(), [2000]);
});

test('stopping asks every worker to stop, kills one that does not within three seconds, and starts none again', async () => {
  const { supervisor, children, fire } = harness();
  supervisor.start(DEFAULT);
  supervisor.start(SIDE);
  children.forEach((c) => c.say({ t: 'started' }));
  const stopped = supervisor.stop();
  assert.deepEqual(children.map((c) => c.sent.at(-1)), [{ t: 'stop' }, { t: 'stop' }]);
  children[0].emit('exit', 0);
  assert.deepEqual(fire(), [3000]);
  await stopped;
  assert.deepEqual(children.map((c) => c.killed), [false, true]);
  assert.equal(children.length, 2);
});
