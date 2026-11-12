import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'thematrix-runs-'));
process.env['UNDERLINGS_STATE_DIR'] = dir;

const { captureReviewOutput, MAX_READS_PER_CAPTURE } = await import('./runs.js');
const { startAutoReview } = await import('./auto/live.js');
const { toggleWatch, recordReviewTerminal } = await import('./actions/watch.js');
const store = await import('./data/store.js');
const { START, mr, resetState } = await import('./auto/testkit.js');
type AgentTerminal = import('./agents/host.js').AgentTerminal;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => resetState());

const KEY = 'acme/engine!621';

function agent(handle: string, over: Partial<AgentTerminal> = {}): AgentTerminal {
  return { handle, title: '✳ claude', agent: 'claude', connected: true, orphaned: false, ...over };
}

function reader() {
  const read: string[] = [];
  return {
    read,
    fn: async (handle: string) => {
      read.push(handle);
      return { tail: [`screen of ${handle}`] };
    },
  };
}

test('only the terminal of the current run is read, never the one the watch remembers from before', async () => {
  toggleWatch(mr());
  recordReviewTerminal(KEY, 't-old');
  store.recordRun(KEY, { webUrl: '', status: 'working', terminal: 't-new' });
  toggleWatch(mr({ iid: 7 }));
  recordReviewTerminal('acme/engine!7', 't-watch');
  const r = reader();
  const captured = await captureReviewOutput([agent('t-old'), agent('t-new'), agent('t-watch')], { listed: true, read: r.fn, now: START });
  assert.deepEqual(r.read.sort(), ['t-new', 't-watch'], 'a watch alone still has its terminal read');
  assert.equal(captured, 2);
  assert.deepEqual(store.loadRuns()[KEY]?.tail, ['screen of t-new']);
});

test('a run being launched has nothing read for it, even with an old terminal on its watch', async () => {
  toggleWatch(mr());
  recordReviewTerminal(KEY, 't-old');
  store.recordRun(KEY, { webUrl: '', status: 'launching', tail: [] });
  const r = reader();
  await captureReviewOutput([], { listed: true, read: r.fn, now: START });
  await captureReviewOutput([agent('t-old')], { listed: true, read: r.fn, now: START });
  assert.deepEqual(r.read, []);
  assert.equal(store.loadRuns()[KEY]?.status, 'launching', 'and it is not marked ended either');
});

test('a new run clears the last one\'s terminal and workspace, then records its own', async () => {
  store.recordRun(KEY, {
    webUrl: '', status: 'ended', terminal: 't-old', worktreePath: '/old', capturedAt: 'x', endedAt: 'y', tail: ['old'],
  });
  let finish = (): void => undefined;
  const launched = startAutoReview(mr(), '/team:review x', async () => {
    await new Promise<void>((resolve) => (finish = resolve));
    return { how: 'worktree', handle: 't-new', path: '/new' };
  });
  await new Promise((resolve) => setImmediate(resolve));
  const launching = store.loadRuns()[KEY];
  assert.equal(launching?.status, 'launching');
  for (const field of ['terminal', 'worktreePath', 'capturedAt', 'endedAt'] as const) {
    assert.equal(launching?.[field], undefined, `${field} is cleared`);
  }
  assert.deepEqual(launching?.tail, []);
  finish();
  await launched;
  const run = store.loadRuns()[KEY];
  assert.deepEqual([run?.status, run?.terminal, run?.worktreePath], ['working', 't-new', '/new']);
  assert.equal(store.loadState().watches[KEY]?.terminal, 't-new', 'and the watch knows it too');
});

test('a terminal gone from a list that worked marks its run ended; a list that failed marks nothing', async () => {
  store.recordRun(KEY, { webUrl: '', status: 'working', terminal: 't1' });
  await captureReviewOutput([], { listed: false, now: START });
  assert.equal(store.loadRuns()[KEY]?.status, 'working');
  await captureReviewOutput([], { listed: true, now: START });
  assert.deepEqual([store.loadRuns()[KEY]?.status, store.loadRuns()[KEY]?.endedAt], ['ended', new Date(START).toISOString()]);
});

test('a run started since Orca was listed is not read as gone from that list', async () => {
  const listedAt = Date.now();
  store.recordRun(KEY, { webUrl: '', status: 'working', terminal: 't-new', startedAt: new Date(listedAt + 1).toISOString() });
  await captureReviewOutput([], { listed: true, listedAt, now: START });
  assert.equal(store.loadRuns()[KEY]?.status, 'working');
  store.recordRun(KEY, { startedAt: new Date(listedAt - 1).toISOString() });
  await captureReviewOutput([], { listed: true, listedAt, now: START });
  assert.equal(store.loadRuns()[KEY]?.status, 'ended', 'one started before it is');
});

test('a run its terminal is seen live in again is no longer ended, whatever is on screen', async () => {
  for (const screen of [['back'], []]) {
    store.recordRun(KEY, { webUrl: '', status: 'ended', endedAt: new Date(START).toISOString(), terminal: 't1' });
    await captureReviewOutput([agent('t1', { title: '◐ claude' })], { listed: true, read: async () => ({ tail: screen }), now: START });
    const run = store.loadRuns()[KEY];
    assert.deepEqual([run?.status, run?.endedAt], ['working', undefined], JSON.stringify(screen));
  }
});

test('a live terminal reads as working or idle from its title', async () => {
  store.recordRun(KEY, { webUrl: '', status: 'launching', terminal: 't1' });
  const r = reader();
  await captureReviewOutput([agent('t1', { title: '◐ claude' })], { listed: true, read: r.fn, now: START });
  assert.equal(store.loadRuns()[KEY]?.status, 'working');
  await captureReviewOutput([agent('t1', { title: '✳ claude', lastOutputAt: START - 1 })], { listed: true, read: r.fn, now: START + 1 });
  assert.equal(store.loadRuns()[KEY]?.status, 'idle', 'and nothing new on screen needs no read to say so');
  assert.equal(r.read.length, 1);
});

test('at most twelve terminals are read in one go, newest first', async () => {
  const terminals: AgentTerminal[] = [];
  for (let n = 0; n < 15; n += 1) {
    store.recordRun(`acme/engine!${n}`, { webUrl: '', status: 'working', terminal: `t${n}`, startedAt: new Date(START + n).toISOString() });
    terminals.push(agent(`t${n}`));
  }
  const r = reader();
  await captureReviewOutput(terminals, { listed: true, read: r.fn, now: START });
  assert.equal(r.read.length, MAX_READS_PER_CAPTURE);
  assert.ok(!r.read.includes('t0') && r.read.includes('t14'));
});

test('a Claude Code agent says whether it is working itself, as its title carries no spinner', async () => {
  store.recordRun(KEY, { webUrl: '', startedAt: new Date(START).toISOString(), status: 'launching', terminal: 'claude:a' });
  await captureReviewOutput([agent('claude:a', { title: 'review !621', working: true })], { listed: true, read: reader().fn, now: START });
  assert.equal(store.loadRuns()[KEY]?.status, 'working');
  await captureReviewOutput([agent('claude:a', { title: '◐ review !621', working: false })], { listed: true, read: reader().fn, now: START });
  assert.equal(store.loadRuns()[KEY]?.status, 'idle');
});
