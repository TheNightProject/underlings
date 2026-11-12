import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'thematrix-lock-'));
process.env['UNDERLINGS_STATE_DIR'] = dir;

const { AUTO_HOLD_MS, autoTurnHeld, newAutoSeat, readAutoDriver, releaseAutoTurn, takeAutoTurn } = await import('./lock.js');
const { TestProc } = await import('./testproc.js');
type Seat = import('./lock.js').AutoSeat;
type Owner = import('./lock.js').AutoOwner;

const LOCK = join(dir, 'auto.lock');
const T0 = Date.parse('2026-11-03T10:00:00Z');
const S = 1_000;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => {
  rmSync(LOCK, { force: true });
  rmSync(join(dir, 'frontends'), { recursive: true, force: true });
});

const intent = (owner: Owner, over: { wants?: boolean; busy?: boolean } = {}) => ({
  owner,
  wants: over.wants ?? true,
  why: 'test',
  busy: over.busy ?? false,
});

function deadPid(): number {
  const pid = spawnSync(process.execPath, ['-e', '0']).pid;
  assert.ok(pid, 'a process that has exited');
  return pid;
}

/** One front end's seat, turned by hand on a fake clock. */
function front(owner: Owner, pid = process.pid) {
  let seat: Seat = newAutoSeat(owner, T0, pid);
  return {
    get seat(): Seat {
      return seat;
    },
    turn(now: number, over: { wants?: boolean; busy?: boolean } = {}) {
      const result = takeAutoTurn(seat, intent(owner, over), now);
      seat = result.seat;
      return result;
    },
    release() {
      seat = releaseAutoTurn(seat);
    },
  };
}

const lockToken = (): string | undefined =>
  existsSync(LOCK) ? (JSON.parse(readFileSync(LOCK, 'utf8')) as { token: string }).token : undefined;

test('two seats wanting the lock at once: exactly one holds, and the other takes it after a release', () => {
  const a = front('app');
  const b = front('plugin');
  assert.equal(a.turn(T0).held, true);
  assert.equal(b.turn(T0).held, false);
  for (let t = T0 + 5 * S; t < T0 + 60 * S; t += 5 * S) {
    assert.equal(a.turn(t).held, true, 'the holder keeps it while it beats');
    assert.equal(b.turn(t).held, false, 'and the other never gets it');
  }
  a.release();
  assert.equal(lockToken(), undefined);
  assert.equal(b.turn(T0 + 61 * S).held, true, 'its first turn after the release takes it');
});

test('a stale lock is stolen only on a second sighting 5 s later, and the thief waits a turn', () => {
  const holder = front('app');
  const thief = front('plugin');
  holder.turn(T0);
  assert.equal(thief.turn(T0 + 31 * S).held, false, 'first sighting');
  assert.equal(thief.turn(T0 + 35 * S).held, false, 'four seconds is not enough');
  assert.equal(lockToken(), holder.seat.token);
  const steal = thief.turn(T0 + 36 * S);
  assert.equal(steal.held, false, 'renamed over, but not held yet');
  assert.match(steal.event ?? '', /took over full auto from app pid/);
  assert.equal(lockToken(), thief.seat.token);
  assert.equal(autoTurnHeld(thief.seat, T0 + 36 * S), false, 'on probation');
  assert.equal(thief.turn(T0 + 41 * S).held, true, 'its next turn finds its own token');
  const lost = holder.turn(T0 + 42 * S);
  assert.equal(lost.held, false);
  assert.equal(lost.event, `plugin pid ${process.pid} took over`);
});

test('a beat between the two sightings cancels the steal', () => {
  const holder = front('app');
  const thief = front('plugin');
  holder.turn(T0);
  thief.turn(T0 + 31 * S);
  holder.turn(T0 + 33 * S);
  assert.equal(thief.turn(T0 + 36 * S).held, false);
  assert.equal(lockToken(), holder.seat.token, 'nothing was stolen');
  assert.equal(thief.seat.staleSeen, null, 'and the sighting is forgotten');
  assert.equal(thief.turn(T0 + 64 * S).held, false, 'stale again: a new first sighting');
  assert.equal(thief.turn(T0 + 69 * S).event?.startsWith('took over'), true);
});

test('when two thieves both rename, the one whose token is gone backs off and was never held', () => {
  const holder = front('app');
  const a = front('plugin');
  const b = front('plugin');
  holder.turn(T0);
  a.turn(T0 + 31 * S);
  b.turn(T0 + 31 * S);
  const stale = readFileSync(LOCK, 'utf8');
  a.turn(T0 + 36 * S);
  // As if b read the lock before a's rename landed.
  writeFileSync(LOCK, stale);
  b.turn(T0 + 36 * S);
  const second = [a.turn(T0 + 41 * S), b.turn(T0 + 41 * S)];
  assert.deepEqual(second.map((r) => r.held), [false, true]);
  assert.equal(second[0]?.event, `plugin pid ${process.pid} took over`);
  assert.equal(autoTurnHeld(a.seat, T0 + 41 * S), false, 'a was never held');
});

test('a dead holder is taken at once, whichever worker held it', () => {
  for (const owner of ['plugin', 'control-centre', 'thematrix']) {
    rmSync(LOCK, { force: true });
    front(owner, deadPid()).turn(T0);
    const app = front('app');
    assert.equal(app.turn(T0 + S).held, false, `taken from ${owner}, on probation`);
    assert.equal(lockToken(), app.seat.token);
    assert.equal(app.turn(T0 + 6 * S).held, true);
    app.release();
  }
});

test('a worker that stops wanting while busy keeps beating, and releases once its step is done', () => {
  const plugin = front('plugin');
  assert.equal(plugin.turn(T0).held, true);
  const app = front('app');
  assert.equal(app.turn(T0 + S).held, false);
  const busy = plugin.turn(T0 + 5 * S, { wants: false, busy: true });
  assert.equal(busy.held, false, 'it stops driving');
  assert.equal(lockToken(), plugin.seat.token, 'but keeps the lock');
  assert.equal((JSON.parse(readFileSync(LOCK, 'utf8')) as { beatAt: number }).beatAt, T0 + 5 * S, 'beating it');
  assert.equal(app.turn(T0 + 6 * S).held, false);
  const idle = plugin.turn(T0 + 10 * S, { wants: false });
  assert.equal(idle.event, 'handed full auto over');
  assert.equal(lockToken(), undefined);
  assert.equal(app.turn(T0 + 11 * S).held, true, 'handed over within one step');
  assert.equal(plugin.turn(T0 + 15 * S, { wants: false }).held, false, 'and it does not take it back');
});

test('held turns false 15 s after the last good beat', () => {
  const a = front('app');
  a.turn(T0);
  assert.equal(autoTurnHeld(a.seat, T0 + AUTO_HOLD_MS - 1), true);
  assert.equal(autoTurnHeld(a.seat, T0 + AUTO_HOLD_MS), false);
});

test('release removes only its own lock, and its own presence', () => {
  const a = front('app');
  const b = front('plugin');
  a.turn(T0);
  b.turn(T0);
  b.release();
  assert.equal(lockToken(), a.seat.token, 'b held nothing, so nothing was removed');
  assert.equal(existsSync(join(dir, 'frontends', `plugin-${process.pid}.json`)), false);
  a.release();
  assert.equal(lockToken(), undefined);
  assert.deepEqual(readAutoDriver(T0).frontends, []);
});

test('an unreadable lock counts as stale only once its mtime is 30 s old', () => {
  writeFileSync(LOCK, 'not a lock');
  utimesSync(LOCK, T0 / S, T0 / S);
  const a = front('app');
  assert.equal(a.turn(T0 + 10 * S).held, false);
  assert.equal(a.seat.staleSeen, null, 'fresh, so not even a sighting');
  a.turn(T0 + 31 * S);
  assert.match(a.turn(T0 + 36 * S).event ?? '', /from an unreadable lock/);
  assert.equal(a.turn(T0 + 41 * S).held, true);
});

test('the driver view names the holder and every worker, live or not', () => {
  const app = front('app');
  app.turn(T0);
  front('plugin', deadPid()).turn(T0);
  const view = readAutoDriver(T0 + S);
  assert.equal(view.holder?.owner, 'app');
  assert.equal(view.holder?.live, true);
  assert.equal(view.stateDir, dir);
  assert.deepEqual(view.frontends.map((f) => [f.owner, f.live, f.wants]).sort(), [
    ['app', true, true],
    ['plugin', false, true],
  ]);
  assert.equal(readAutoDriver(T0 + 31 * S).holder?.live, false, 'a lock 31 s old is not live');
});

async function closeAll(...all: InstanceType<typeof TestProc>[]): Promise<void> {
  await Promise.all(all.map((p) => p.close()));
}

test('two real processes racing for the lock: exactly one holds, every time', async () => {
  const both = [new TestProc(dir), new TestProc(dir)];
  try {
    for (let trial = 0; trial < 12; trial += 1) {
      rmSync(LOCK, { force: true });
      await Promise.all(both.map((p) => p.send({ op: 'forget' })));
      const now = T0 + trial * 60 * S;
      for (let beat = 0; beat < 4; beat += 1) {
        const results = await Promise.all(both.map((p) => p.turn(intent('app'), now + beat * 5 * S)));
        assert.equal(results.filter((r) => r.held).length, 1, `trial ${trial}, beat ${beat}`);
      }
    }
  } finally {
    await closeAll(...both);
  }
});

test('two real processes stealing a stale lock at once: one ends up holding, and the other was never held', async () => {
  const holder = new TestProc(dir);
  const thieves = [new TestProc(dir), new TestProc(dir)];
  try {
    for (let trial = 0; trial < 6; trial += 1) {
      rmSync(LOCK, { force: true });
      await Promise.all([holder, ...thieves].map((p) => p.send({ op: 'forget' })));
      const now = T0 + trial * 120 * S;
      await holder.turn(intent('app'), now);
      await holder.send({ op: 'release', keepLock: true });
      await Promise.all(thieves.map((p) => p.turn(intent('plugin'), now + 31 * S)));
      const stolen = await Promise.all(thieves.map((p) => p.turn(intent('plugin'), now + 36 * S)));
      assert.deepEqual(stolen.map((r) => r.held), [false, false], 'nobody is held straight off a steal');
      const next = await Promise.all(thieves.map((p) => p.turn(intent('plugin'), now + 41 * S)));
      assert.equal(next.filter((r) => r.held).length, 1, `trial ${trial}`);
    }
  } finally {
    await closeAll(holder, ...thieves);
  }
});

test('a real process killed with -9 is taken over at once', async () => {
  const victim = new TestProc(dir);
  const app = new TestProc(dir);
  try {
    assert.equal((await victim.turn(intent('plugin'), T0)).held, true);
    await victim.kill();
    const steal = await app.turn(intent('app'), T0 + S);
    assert.equal(steal.event, `took over full auto from plugin pid ${victim.pid}`);
    assert.equal((await app.turn(intent('app'), T0 + 6 * S)).held, true);
  } finally {
    await app.close();
  }
});

test('a re-imported engine carrying the same seat keeps the turn', async () => {
  const app = new TestProc(dir);
  try {
    const first = await app.turn(intent('app'), T0);
    assert.equal(first.held, true);
    await app.send({ op: 'reimport' });
    const after = await app.turn(intent('app'), T0 + 5 * S);
    assert.deepEqual([after.held, after.token, after.event], [true, first.token, null]);
    assert.equal(lockToken(), first.token, 'the lock never looked free');
  } finally {
    await app.close();
  }
});
