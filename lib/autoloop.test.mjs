import assert from 'node:assert/strict';
import { mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// Only the process boundary is stubbed: every command fails as a missing one would.
mock.module('node:child_process', {
  namedExports: {
    execFile(cmd, args, options, done) {
      setImmediate(() => done(Object.assign(new Error(`${cmd} is stubbed`), { code: 127 }), '', ''));
    },
  },
});

const START = Date.parse('2026-11-06T10:00:00Z');
const kit = await import('./testkit.mjs');
const { world } = kit;
const live = await import('./engine.mjs');
const TESTKIT = fileURLToPath(new URL('./testkit.mjs', import.meta.url));
const dir = await mkdtemp(join(tmpdir(), 'control-centre-autoloop-'));
const loops = [];
let generation = 0;

after(() => rm(dir, { recursive: true, force: true }));

beforeEach(async () => {
  mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: START });
  kit.reset({ settings: { workspaceRoot: '/ws-root' } });
  process.env.GITLAB_TOKEN = 'stub';
  delete process.env.ORCA_WORKSPACE_ROOT;
  await live.loadEngine({ matrixEngine: TESTKIT }, () => {});
  await live.refreshInbox();
  world.calls.length = 0;
});

afterEach(async () => {
  const stopping = Promise.all(loops.splice(0).map((loop) => loop.stop()));
  mock.timers.tick(2000);
  await stopping;
  mock.timers.reset();
});

// Each generation is a fresh copy of the module, as a code reload makes one, sharing the engine module with the others.
async function loopFrom(carried = null) {
  generation += 1;
  const loop = await import(`./autoloop.mjs?generation=${generation}`);
  loop.start({}, { carried: carried ? { autoloop: carried } : null, notify() {} });
  loops.push(loop);
  return loop;
}

async function flush() {
  for (let i = 0; i < 6; i += 1) await new Promise(setImmediate);
}

async function advance(ms, each = () => {}) {
  for (let done = 0; done < ms; done += 1000) {
    each();
    mock.timers.tick(Math.min(1000, ms - done));
    await flush();
  }
}

const steps = (name) => world.calls.filter(([call]) => call === name);
const releases = () => world.calls.filter(([call]) => call === 'releaseAutoTurn');
const beatingHolder = (holder) => () => { holder.beatAt = Date.now(); };

async function driving() {
  const loop = await loopFrom();
  loop.adopt();
  await advance(1000);
  assert.equal(loop.driverView().state, 'here');
  return loop;
}

test('without the lock neither step runs, though the worker still says it wants to drive', async () => {
  const holder = { v: 1, owner: 'control-centre', pid: 4242, token: 'theirs', startedAt: START, beatAt: START };
  world.lock.holder = holder;
  const loop = await loopFrom();
  loop.adopt();
  await advance(60_000, beatingHolder(holder));
  assert.deepEqual([steps('backgroundPoll').length, steps('backgroundTick').length], [0, 0]);
  assert.equal(world.lock.frontends[`underlings-${process.pid}`].wants, true);
  assert.equal(loop.driverView().state, 'starting');
  assert.match(loop.driverView().why, /another worker \(pid 4242\) drives full auto/);
});

test('a stale lock is taken over on the confirming turn, and steps start only once the next turn finds its own token', async () => {
  world.lock.holder = { v: 1, owner: 'thematrix', pid: 4242, token: 'gone', startedAt: START - 90_000, beatAt: START - 60_000 };
  const loop = await loopFrom();
  loop.adopt();
  const seen = [];
  for (let s = 0; s < 16; s += 1) {
    await advance(1000);
    seen.push([loop.driverView().state, steps('backgroundTick').length > 0]);
  }
  const firstHere = seen.findIndex(([state]) => state === 'here');
  assert.ok(firstHere > 5, `held only after the confirming sighting and probation: ${JSON.stringify(seen)}`);
  assert.ok(seen.slice(0, firstHere).every(([state, ticked]) => state === 'starting' && !ticked), JSON.stringify(seen));
  assert.ok(seen.at(-1)[1], 'it ticks once it holds');
  assert.equal(world.lock.holder.owner, 'underlings');
});

test('a reload keeps one driver: one turn and one tick per beat across both generations, one token, and no release until the last stop', async () => {
  const a = await driving();
  await advance(12_000);
  const token = world.lock.holder.token;
  const b = await loopFrom(a.carry());
  b.adopt();
  const from = Date.now();
  const turnsBefore = world.turns.length;
  const ticksBefore = steps('backgroundTick').length;
  await advance(3000);
  await a.stop();
  await advance(57_000);
  const turns = world.turns.slice(turnsBefore - 1);
  assert.equal(turns.length - 1, 12, JSON.stringify(turns.map((t) => t.now - from)));
  assert.ok(turns.slice(1).every((t, i) => t.now - turns[i].now === 5000), `one turn a beat, the last before the reload included: ${JSON.stringify(turns.map((t) => t.now - from))}`);
  assert.equal(steps('backgroundTick').length - ticksBefore, 12);
  assert.ok(turns.every((t) => t.token === token));
  assert.equal(world.lock.holder.token, token);
  assert.deepEqual(releases(), []);
  await b.stop();
  assert.deepEqual(releases(), [['releaseAutoTurn', token, false]]);
  assert.equal(world.lock.holder, null);
});

test('a reload never brings the next poll forward, however often the code is reloaded', async () => {
  let loop = await driving();
  const at = [];
  world.step = (name) => { if (name === 'backgroundPoll') at.push(Date.now()); };
  for (let s = 0; s < 200; s += 10) {
    await advance(10_000);
    const next = await loopFrom(loop.carry());
    next.adopt();
    await loop.stop();
    loop = next;
  }
  assert.ok(at.length >= 2, `${at.length} polls`);
  assert.ok(at.slice(1).every((t, i) => t - at[i] >= 60_000), JSON.stringify(at.map((t) => t - START)));
});

test('a reload whose start fails before adopt leaves the old code driving, and the new one starts no timers', async () => {
  const a = await driving();
  const b = await loopFrom(a.carry());
  const turnsBefore = world.turns.length;
  const ticksBefore = steps('backgroundTick').length;
  await advance(30_000);
  assert.equal(world.turns.length - turnsBefore, 6);
  assert.equal(steps('backgroundTick').length - ticksBefore, 6);
  assert.equal(a.driverView().state, 'here');
  assert.equal(b.driverView().state, 'starting', 'the one that never adopted does not drive');
});

test('an engine rebuilt mid-run keeps the seat, and the next step calls the new build', async () => {
  const entry = join(dir, 'engine.js');
  const build = (n) => `import * as kit from ${JSON.stringify(new URL('./testkit.mjs', import.meta.url).href)};
export * from ${JSON.stringify(new URL('./testkit.mjs', import.meta.url).href)};
export async function backgroundTick(input, ports) {
  kit.world.calls.push(['build', ${n}]);
  return kit.backgroundTick(input, ports);
}
`;
  await writeFile(join(dir, 'package.json'), '{"type":"module"}');
  await writeFile(entry, build(1));
  await live.loadEngine({ matrixEngine: entry }, () => {});
  await live.refreshInbox();
  const loop = await driving();
  await advance(10_000);
  const token = world.lock.holder.token;
  await writeFile(entry, build(2));
  await utimes(entry, new Date(START + 60_000), new Date(START + 60_000));
  await live.reloadEngine({ matrixEngine: entry });
  const before = world.calls.length;
  await advance(10_000);
  const builds = world.calls.slice(before).filter(([call]) => call === 'build').map(([, n]) => n);
  assert.ok(builds.length >= 1 && builds.every((n) => n === 2), JSON.stringify(builds));
  assert.equal(world.lock.holder.token, token);
  assert.equal(loop.driverView().state, 'here');
  assert.deepEqual(releases(), []);
});

test('ten actions refetching the inbox inside one poll interval still give one poll step', async () => {
  const loop = await driving();
  const polls = () => steps('backgroundPoll').length;
  for (let i = 0; i < 10; i += 1) {
    await live.refreshInbox();
    await advance(5000);
  }
  assert.equal(polls(), 1, 'the first poll ran as it took the lock, and the refetches asked for no more');
  await advance(15_000);
  assert.equal(polls(), 2, 'the next comes a poll interval after the first');
  assert.equal(loop.driverView().state, 'here');
});

test('a poll arriving while a tick is running is queued once, not dropped or doubled', async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  world.step = (name) => (name === 'backgroundTick' && steps('backgroundTick').length === 1 ? gate : undefined);
  await driving();
  await advance(5000);
  assert.equal(steps('backgroundTick').length, 1);
  await advance(125_000);
  assert.equal(steps('backgroundPoll').length, 0, 'nothing runs past the tick that is still going');
  release();
  await flush();
  assert.equal(steps('backgroundPoll').length, 1);
  assert.equal(steps('backgroundTick').length, 2, 'and the tick that waited behind it runs once');
});

test('stop waits up to 1.5 s for a running step, keeps the lock if it is still going, and withdraws the presence either way', async () => {
  world.step = () => new Promise(() => {});
  const stuck = await driving();
  await advance(5000);
  const token = world.lock.holder.token;
  let stopped = false;
  const stopping = stuck.stop().then(() => { stopped = true; });
  mock.timers.tick(1400);
  await flush();
  assert.equal(stopped, false);
  mock.timers.tick(200);
  await stopping;
  assert.deepEqual(releases(), [['releaseAutoTurn', token, true]]);
  assert.equal(world.lock.holder.token, token, 'a step that may still be writing keeps the lock until it goes stale');
  assert.equal(world.lock.frontends[`underlings-${process.pid}`], undefined);
});

test('stop releases the lock at once when no step is running', async () => {
  const loop = await driving();
  const token = world.lock.holder.token;
  await loop.stop();
  assert.deepEqual(releases(), [['releaseAutoTurn', token, false]]);
  assert.equal(world.lock.holder, null);
  assert.equal(world.lock.frontends[`underlings-${process.pid}`], undefined);
});

test('a throwing step, a rejecting step and a throwing turn end up in the activity list, never as an unhandled rejection', async () => {
  const unhandled = [];
  const listen = (err) => unhandled.push(err);
  process.on('unhandledRejection', listen);
  try {
    world.step = (name) => {
      if (name === 'backgroundTick') throw new Error('the tick blew up');
      return Promise.reject(new Error('the poll was refused'));
    };
    const loop = await driving();
    await advance(61_000);
    world.failTurn = 'the state folder is read only';
    await advance(6000);
    await flush();
    const said = loop.driverView().recent.map((r) => [r.text, r.error]);
    for (const text of ['the tick blew up', 'the poll was refused', 'the state folder is read only']) {
      assert.ok(said.some(([t, error]) => t === text && error), `${text} is not in ${JSON.stringify(said)}`);
    }
    assert.ok(loop.driverView().problems >= 3);
  } finally {
    process.off('unhandledRejection', listen);
  }
  assert.deepEqual(unhandled, []);
});

test('a step gets the inbox\'s own terminal list, its error and when it was taken, and claims as auto plus the seat\'s token', async () => {
  world.terminals = [{ handle: 'term-1', agent: 'claude', connected: true, orphaned: false }];
  world.terminalsError = 'orca terminal list gave no answer in 60 s';
  await live.refreshInbox();
  await driving();
  await advance(5000);
  const [, input, held] = steps('backgroundTick')[0];
  assert.deepEqual(input.terminals, world.terminals);
  assert.equal(input.terminalsError, 'orca terminal list gave no answer in 60 s');
  assert.equal(input.listedAt, live.inbox.listedAt);
  assert.equal(input.claimBy, `auto:${world.lock.holder.token}`);
  assert.equal(held, true);
});

test('each thing that stops it driving says so in its own words', async () => {
  const reason = async (setup) => {
    kit.reset({ settings: { workspaceRoot: '/ws-root' } });
    process.env.GITLAB_TOKEN = 'stub';
    await setup();
    const loop = await loopFrom();
    loop.adopt();
    await advance(6000);
    const { state, why } = loop.driverView();
    await loop.stop();
    return [state, why];
  };
  const entry = join(dir, 'stale.js');
  await writeFile(join(dir, 'package.json'), '{"type":"module"}');
  await writeFile(entry, `export * from ${JSON.stringify(new URL('./testkit.mjs', import.meta.url).href)};\nexport const fencedPorts = null;\n`);
  assert.deepEqual(await reason(() => live.loadEngine({ matrixEngine: entry }, () => {})), ['stopped', 'the review engine needs rebuilding: this build has no fencedPorts']);
  await live.loadEngine({ matrixEngine: TESTKIT }, () => {});
  assert.deepEqual(await reason(() => { world.settings.workspaceRoot = ' '; }), ['stopped', 'there is no workspace root to launch reviews in']);
  assert.deepEqual(await reason(() => { delete process.env.GITLAB_TOKEN; }), ['stopped', 'GITLAB_TOKEN is not set']);
  assert.deepEqual(await reason(() => {}), ['here', 'Underlings drives full auto']);
});

test('the edit mark takes only a pending item, and is always 90 s from now whatever the page asks for', async () => {
  const loop = await loopFrom();
  const mark = (body) => loop.ROUTES['POST /api/matrix/editing']({ body: async () => body });
  world.queue = [{ id: 'q1', status: 'pending' }, { id: 'q2', status: 'posted' }];
  await assert.rejects(mark({ id: 'nope', editing: true }), { status: 404 });
  await assert.rejects(mark({ id: 'q2', editing: true }), { status: 409 });
  await assert.rejects(mark({ editing: true }), { status: 400 });
  await mark({ id: 'q1', editing: true, until: START + 86_400_000 });
  await mark({ id: 'q1', editing: false });
  const marks = world.calls.filter(([call]) => call === 'setEditing').map(([, id, by, until]) => [id, by, until]);
  assert.deepEqual(marks, [['q1', `underlings:${process.pid}`, START + 90_000], ['q1', `underlings:${process.pid}`, null]]);
});

test('an item full auto is sending cannot be marked as being edited, though a mark can still be cleared', async () => {
  const loop = await loopFrom();
  const mark = (body) => loop.ROUTES['POST /api/matrix/editing']({ body: async () => body });
  world.queue = [{ id: 'q1', status: 'pending', sending: { by: 'auto:t1', at: '2026-11-06T10:00:00Z' } }];
  await assert.rejects(mark({ id: 'q1', editing: true }), { status: 409, message: 'full auto is sending this right now' });
  await mark({ id: 'q1', editing: false });
  assert.deepEqual(world.calls.filter(([call]) => call === 'setEditing').map(([, , , until]) => until), [null]);
});

test('a run is read whole by its key, and an unknown or malformed key is refused', async () => {
  const loop = await loopFrom();
  const tail = Array.from({ length: 80 }, (_, i) => `line ${i}`);
  world.runs = { 'acme/engine!7': { key: 'acme/engine!7', status: 'ended', startedAt: '2026-11-06T09:00:00Z', endedAt: '2026-11-06T09:20:00Z', terminal: 'term-1', worktreePath: '/work/review-engine-7', tail } };
  const read = (key) => loop.ROUTES['GET /api/matrix/run']({ query: new URLSearchParams({ key }) });
  const run = read('acme/engine!7');
  assert.equal(run.tail.length, 80);
  assert.deepEqual([run.status, run.terminal, run.worktreePath, run.endedAt], ['ended', 'term-1', '/work/review-engine-7', '2026-11-06T09:20:00Z']);
  assert.throws(() => read('acme/engine!8'), { status: 404 });
  assert.throws(() => read('../../etc'), { status: 400 });
  assert.throws(() => read('ticket:../etc'), { status: 400 });
});

test('a fix run is read by the key the engine records it under', async () => {
  const loop = await loopFrom();
  world.runs = { 'fix:acme/engine!7': { key: 'fix:acme/engine!7', status: 'idle', startedAt: '2026-11-06T09:00:00Z', tail: ['fix line'] } };
  const read = (key) => loop.ROUTES['GET /api/matrix/run']({ query: new URLSearchParams({ key }) });
  assert.deepEqual(read('fix:acme/engine!7').tail, ['fix line']);
  assert.throws(() => read('fix:../etc'), { status: 400 });
});

test('a ticket run is read by the key the engine records it under', async () => {
  const loop = await loopFrom();
  world.runs = { 'ticket:ABC-4242': { key: 'ticket:ABC-4242', status: 'ended', startedAt: '2026-11-06T09:00:00Z', tail: Array.from({ length: 60 }, (_, i) => `ticket line ${i}`) } };
  const run = loop.ROUTES['GET /api/matrix/run']({ query: new URLSearchParams({ key: 'ticket:ABC-4242' }) });
  assert.deepEqual([run.key, run.tail.length], ['ticket:ABC-4242', 60]);
});
