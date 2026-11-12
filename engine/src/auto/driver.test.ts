import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'thematrix-driver-'));
process.env['UNDERLINGS_STATE_DIR'] = dir;

const { agentOnFor, backgroundPoll, backgroundTick, fencedPorts, reportLine } = await import('./driver.js');
const { setAuto, toggleWatch } = await import('../actions/watch.js');
const { startAutoReview } = await import('./live.js');
const store = await import('../data/store.js');
const { MINUTE, START, fakeWorld, mr, note, resetState, thread } = await import('./testkit.js');
type AgentTerminal = import('../agents/host.js').AgentTerminal;
type Mr = import('../types.js').Mr;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => resetState());

const agent = (handle: string): AgentTerminal => ({ handle, title: '◐ claude', agent: 'claude', connected: true, orphaned: false });

/** A head seen on an earlier poll with its pipeline done, so auto re-review takes it now. */
function settledHead(key: string, sha: string): void {
  store.mutateState((state) => {
    const watch = state.watches[key];
    if (watch) watch.moving = { sha, since: Date.now() };
  });
}

function snapshot(): Record<string, string> {
  return Object.fromEntries(
    readdirSync(dir)
      .filter((name) => name.endsWith('.json'))
      .map((name) => [name, readFileSync(join(dir, name), 'utf8')]),
  );
}

/** Something for every step to do: adopt, settle, launch, send, re-review and capture. */
function busyWorld() {
  store.saveSettings({ ...store.loadSettings(), fullAuto: 'heidi:verdict' });
  const launchedAt = new Date(START - 10 * MINUTE).toISOString();
  store.updateAutoMemory('acme/engine!621', (m) => ({
    ...m,
    pass: { id: 'p1', key: 'acme/engine!621', author: 'heidi', sha: 'head-1', trigger: 'new', launchedAt },
  }));
  const base = { projectPath: 'acme/engine', projectId: 1001, iid: 621, webUrl: '', severity: 'MINOR' as const, createdBy: 'auto:p1' };
  store.addToQueue([
    { ...base, body: 'landed, not yet adopted' },
    { ...base, body: 'due', auto: { pass: 'p1', level: 'comments', sendAt: new Date(START - MINUTE).toISOString() } },
  ]);
  toggleWatch(mr({ iid: 9, author: 'alice' }));
  setAuto('acme/engine!9', true);
  settledHead('acme/engine!9', 'moved');
  store.recordRun('acme/engine!11', { webUrl: '', status: 'working', terminal: 't11' });
  const fake = fakeWorld({ mrs: [mr(), mr({ iid: 9, author: 'alice', sha: 'moved' }), mr({ iid: 10 })], screens: { t11: ['hello'] } });
  let fresh = 0;
  const freshMr = fake.ports.freshMr;
  fake.ports.freshMr = async (ref) => {
    fresh += 1;
    return freshMr(ref);
  };
  const input = { mrs: fake.world.mrs, me: 'frank', terminals: [agent('t11')], claimBy: 'auto:t' };
  return { fake, input, freshReads: () => fresh };
}

test('a front end that is not driving writes nothing and calls nothing', async () => {
  const { fake, input, freshReads } = busyWorld();
  const before = snapshot();
  const following = fencedPorts(() => false, fake.ports);
  const polled = await backgroundPoll(input, following);
  const ticked = await backgroundTick(input, following);
  assert.deepEqual(snapshot(), before, 'not a byte of state changed');
  assert.deepEqual([fake.calls.launched, fake.calls.posted, fake.calls.read, freshReads()], [[], [], [], 0]);
  assert.equal(reportLine(polled) ?? reportLine(ticked), null);

  const driving = await backgroundPoll(input, fencedPorts(() => true, fake.ports));
  assert.deepEqual(driving.launched, ['acme/engine!10'], 'the same poll, held, launches');
  assert.deepEqual(driving.reReviewed, ['acme/engine!9'], 're-reviews');
  assert.equal(driving.captured, 1, 'and captures');
  assert.equal(driving.sent, 1, 'and sends');
});

test('losing the turn part way through a poll stops it before the next step', async () => {
  const { fake, input } = busyWorld();
  let held = true;
  fake.ports.launch = async (m, prompt) => {
    fake.calls.launched.push({ mr: m, prompt });
    held = false;
  };
  const report = await backgroundPoll(input, fencedPorts(() => held, fake.ports));
  assert.deepEqual([report.reReviewed, report.captured, report.sent], [[], 0, 0]);
});

test('a review a poll launches is not marked ended by the list that same poll was given', async () => {
  toggleWatch(mr({ iid: 9, author: 'alice' }));
  setAuto('acme/engine!9', true);
  settledHead('acme/engine!9', 'moved');
  const fake = fakeWorld({ mrs: [mr({ iid: 9, author: 'alice', sha: 'moved' })] });
  fake.ports.launch = (m, prompt) => startAutoReview(m, prompt, async () => ({ how: 'worktree', handle: 't-new', path: '/w' }));
  const input = { mrs: fake.world.mrs, me: 'frank', terminals: [], listedAt: Date.now() - MINUTE, claimBy: 'auto:t' };
  const report = await backgroundPoll(input, fencedPorts(() => true, fake.ports));
  assert.deepEqual(report.reReviewed, ['acme/engine!9']);
  const run = store.loadRuns()['acme/engine!9'];
  assert.deepEqual([run?.status, run?.terminal, run?.endedAt], ['working', 't-new', undefined]);
  const { listedAt: _, ...unstamped } = input;
  fake.world.mrs = [mr({ iid: 9, author: 'alice', sha: 'moved again' })];
  settledHead('acme/engine!9', 'moved again');
  await backgroundPoll({ ...unstamped, mrs: fake.world.mrs }, fencedPorts(() => true, fake.ports));
  assert.equal(store.loadRuns()['acme/engine!9']?.status, 'working', 'nor by a list given no time, which predates the poll');
});

test('the report reads as one line', () => {
  assert.equal(
    reportLine({ launched: ['a!1'], reReviewed: ['b!2'], sent: 2, held: 1, captured: 3, errors: [] }),
    'auto: reviewing a!1, re-reviewing b!2, sent 2, 1 handed back to you',
  );
  assert.equal(reportLine({ launched: ['a!1', 'c!3'], asked: ['a!1'] }), 'auto: reviewing a!1, it asks for you, reviewing c!3');
  assert.equal(reportLine({ captured: 3 }), null, 'capture alone is not news');
});

test('an agent is on an MR when its watch or its run names a live terminal', () => {
  const watch = { key: 'acme/engine!1', projectPath: 'acme/engine', iid: 1, webUrl: '', auto: false, terminal: 'w1', seen: { sha: null, pipeline: null, notes: 0, approvals: 0 }, addedAt: '' };
  const on = agentOnFor({ [watch.key]: watch }, { 'acme/engine!2': { key: 'acme/engine!2', webUrl: '', startedAt: '', terminal: 'r2' } }, [agent('w1'), agent('r2')]);
  assert.deepEqual([on(mr({ iid: 1 })), on(mr({ iid: 2 })), on(mr({ iid: 3 }))], [true, true, false]);
  const gone = agentOnFor({ [watch.key]: watch }, {}, [{ ...agent('w1'), orphaned: true }]);
  assert.equal(gone(mr({ iid: 1 })), false);
});

test('a finished agent Orca calls done stops blocking its MR; working, waiting, blocked or no state at all still blocks', () => {
  const watch = { key: 'acme/engine!1', projectPath: 'acme/engine', iid: 1, webUrl: '', auto: false, terminal: 'w1', seen: { sha: null, pipeline: null, notes: 0, approvals: 0 }, addedAt: '' };
  const onWith = (state?: string): boolean => agentOnFor({ [watch.key]: watch }, {}, [{ ...agent('w1'), ...(state ? { state } : {}) }])(mr({ iid: 1 }));
  assert.equal(onWith('done'), false);
  for (const state of ['working', 'waiting', 'blocked', undefined]) assert.equal(onWith(state), true, String(state));
  const launching = { 'acme/engine!1': { key: 'acme/engine!1', webUrl: '', startedAt: new Date().toISOString(), status: 'launching' as const, terminal: 'w1' } };
  assert.equal(agentOnFor({}, launching, [{ ...agent('w1'), state: 'done' }], { listedAt: Date.now() - MINUTE })(mr({ iid: 1 })), true, 'a launch in flight still counts');
});

test('a launch in flight from either front end counts as an agent on the MR', () => {
  const now = Date.now();
  const listedAt = now - MINUTE;
  const run = (status: string, startedAt: number) => ({ key: 'acme/engine!1', webUrl: '', startedAt: new Date(startedAt).toISOString(), status, terminal: 't-unlisted' });
  const on = (r: ReturnType<typeof run>): boolean => agentOnFor({}, { [r.key]: r }, [], { listedAt, now })(mr({ iid: 1 }));
  assert.equal(on(run('launching', now - MINUTE)), true, 'not back from Orca yet');
  assert.equal(on(run('launching', now - 10 * MINUTE)), false, 'unless it has been longer than any launch takes');
  assert.equal(on(run('working', listedAt + 1)), true, 'back, but started since the list was taken');
  assert.equal(on(run('working', listedAt - 1)), false, 'started before it, and missing from it');
  assert.equal(on(run('launch failed', listedAt + 1)), false);
});

test('a review the other front end is still launching is not re-reviewed beside it', async () => {
  toggleWatch(mr({ iid: 9, author: 'alice', pipeline: 'RUNNING' }));
  setAuto('acme/engine!9', true);
  store.recordRun('acme/engine!9', { webUrl: '', status: 'launching', tail: [] });
  const fake = fakeWorld({ mrs: [mr({ iid: 9, author: 'alice', pipeline: 'SUCCESS' })] });
  const input = { mrs: fake.world.mrs, me: 'frank', terminals: [], listedAt: Date.now(), claimBy: 'auto:t' };
  const report = await backgroundPoll(input, fencedPorts(() => true, fake.ports));
  assert.deepEqual([report.reReviewed, fake.calls.launched], [[], []]);
});

test('a launch the other front end starts while this poll is sending is seen before it re-reviews', async () => {
  const { fake, input } = busyWorld();
  fake.world.onPost = () => store.recordRun('acme/engine!9', { webUrl: '', status: 'launching', tail: [] });
  const report = await backgroundPoll(input, fencedPorts(() => true, fake.ports));
  assert.deepEqual([report.sent, report.reReviewed], [1, []]);
});

test('a Review pressed on one MR while full auto is launching on another is seen before full auto launches there', async () => {
  store.saveSettings({ ...store.loadSettings(), fullAuto: 'heidi:verdict' });
  const [a, b] = [mr({ iid: 1 }), mr({ iid: 2 })];
  const fake = fakeWorld({ mrs: [a, b] });
  const agents: number[] = [];
  const orca = async (m: Mr) => {
    agents.push(m.iid);
    return { how: 'worktree' as const, handle: `t${agents.length}` };
  };
  fake.ports.launch = async (m, prompt) => {
    if (m.iid === 1) await startAutoReview(b, 'by hand', orca);
    return startAutoReview(m, prompt, orca);
  };
  const input = { mrs: fake.world.mrs, me: 'frank', terminals: [], listedAt: Date.now(), claimBy: 'auto:t' };
  const report = await backgroundPoll(input, fencedPorts(() => true, fake.ports));
  assert.deepEqual([report.launched, agents], [['acme/engine!1'], [2, 1]]);
  assert.equal(store.loadRuns()['acme/engine!2']?.terminal, 't1', 'and the first agent keeps its terminal');
});

test('a Review pressed while full auto reads the threads for a reply is seen before full auto launches', async () => {
  store.saveSettings({ ...store.loadSettings(), fullAuto: 'heidi:verdict' });
  const fake = fakeWorld();
  const input = { mrs: fake.world.mrs, me: 'frank', terminals: [], listedAt: Date.now(), claimBy: 'auto:t' };
  await backgroundPoll(input, fencedPorts(() => true, fake.ports));
  store.markPassDone(store.loadAutoMemory()['acme/engine!621']?.pass?.id ?? '');
  const later = new Date(fake.world.clock + MINUTE).toISOString();
  fake.world.threads = [thread('t1', [note('frank', 'MAJOR: off by one', '2026-11-01T00:00:00Z'), note('heidi', 'Done', later)])];
  fake.world.mrs = [mr({ notes: 4 })];
  const discussions = fake.ports.discussions;
  fake.ports.discussions = async (mr) => {
    store.recordRun('acme/engine!621', { webUrl: '', startedAt: new Date().toISOString(), status: 'launching', tail: [] });
    return discussions(mr);
  };
  const report = await backgroundPoll({ ...input, mrs: fake.world.mrs }, fencedPorts(() => true, fake.ports));
  assert.deepEqual([report.launched, fake.calls.launched.length], [[], 1]);
});

test('a review launched while re-review reads the MR afresh is not doubled', async () => {
  toggleWatch(mr({ iid: 9, author: 'alice' }));
  setAuto('acme/engine!9', true);
  settledHead('acme/engine!9', 'moved');
  const fake = fakeWorld({ mrs: [mr({ iid: 9, author: 'alice', sha: 'moved' })] });
  const freshMr = fake.ports.freshMr;
  fake.ports.freshMr = async (ref) => {
    store.recordRun('acme/engine!9', { webUrl: '', startedAt: new Date().toISOString(), status: 'launching', tail: [] });
    return freshMr(ref);
  };
  const input = { mrs: fake.world.mrs, me: 'frank', terminals: [], listedAt: Date.now(), claimBy: 'auto:t' };
  const report = await backgroundPoll(input, fencedPorts(() => true, fake.ports));
  assert.deepEqual([report.reReviewed, fake.calls.launched], [[], []]);
});

test('the engine hands a front end every call it needs to drive full auto itself', async () => {
  const engine = (await import('../engine.js')) as unknown as Record<string, unknown>;
  const calls = ['takeAutoTurn', 'releaseAutoTurn', 'autoTurnHeld', 'readAutoDriver', 'backgroundPoll', 'backgroundTick', 'fencedPorts', 'reportLine', 'autoReReview', 'captureReviewOutput', 'setEditing'];
  for (const name of calls) assert.equal(typeof engine[name], 'function', name);
  assert.equal(engine['AUTO_BEAT_MS'], 5_000);
});
