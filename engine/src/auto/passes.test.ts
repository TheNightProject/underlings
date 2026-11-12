import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'thematrix-passes-'));
process.env['UNDERLINGS_STATE_DIR'] = dir;

const { launchPasses, settlePasses } = await import('./passes.js');
const { autoPoll } = await import('./engine.js');
const { backgroundPoll, fencedPorts } = await import('./driver.js');
const store = await import('../data/store.js');
const { MINUTE, START, context, fakeWorld, mr, resetState } = await import('./testkit.js');

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => resetState());

const KEY = 'acme/engine!621';

function donePass(over: Record<string, unknown> = {}): void {
  const launchedAt = new Date(START - 10 * MINUTE).toISOString();
  store.updateAutoMemory(KEY, (m) => ({
    ...m,
    pass: { id: 'p1', key: KEY, author: 'heidi', sha: 'head-1', trigger: 'new', launchedAt, doneAt: launchedAt, ...over },
  }));
}

function unsentFinding(): string {
  const [item] = store.addToQueue([
    {
      projectPath: 'acme/engine', projectId: 1001, iid: 621, webUrl: '', severity: 'MINOR', body: 'b',
      createdBy: 'auto:p1', auto: { pass: 'p1', level: 'comments', sendAt: new Date(START + MINUTE).toISOString() },
    },
  ]);
  return item?.id ?? '';
}

const settled = (): string | undefined => store.loadAutoMemory()[KEY]?.pass?.settled;
const verdicts = () => store.loadQueue().filter((c) => c.kind === 'verdict');

test('pause read before each launch: flipping it after the first stops the second', async () => {
  const fake = fakeWorld({ mrs: [mr({ iid: 1 }), mr({ iid: 2 })] });
  const launch = fake.ports.launch;
  fake.ports.launch = async (m, prompt) => {
    await launch(m, prompt);
    fake.world.paused = true;
  };
  const report = await launchPasses(context(fake.world), fake.ports);
  assert.deepEqual(report.launched, ['acme/engine!1']);
  assert.equal(fake.calls.launched.length, 1);
});

test('an agent list that failed launches nothing, captures nothing, and says why', async () => {
  store.saveSettings({ ...store.loadSettings(), fullAuto: 'heidi:verdict' });
  store.recordRun('acme/engine!7', { webUrl: '', status: 'working', terminal: 't1' });
  const fake = fakeWorld();
  const input = { mrs: fake.world.mrs, me: 'frank', terminals: [], claimBy: 'auto:t' };
  const blind = await backgroundPoll({ ...input, terminalsError: 'orca is not running' }, fencedPorts(() => true, fake.ports));
  assert.deepEqual(fake.calls.launched, []);
  assert.ok(blind.errors.includes('not launching: the agents could not be listed (orca is not running)'));
  assert.equal(store.loadRuns()['acme/engine!7']?.status, 'working', 'a failed list is no sign the agent has gone');
  await backgroundPoll(input, fencedPorts(() => true, fake.ports));
  assert.equal(fake.calls.launched.length, 1, 'the same poll with a list launches');
});

test('a finished pass whose MR has merged settles closed and drops what it had not sent', async () => {
  donePass();
  const id = unsentFinding();
  const fake = fakeWorld({ mrs: [mr({ state: 'merged' })] });
  await settlePasses(context(fake.world, 'heidi:verdict', { mrs: [] }), fake.ports);
  assert.equal(settled(), 'closed');
  const item = store.loadQueue().find((c) => c.id === id);
  assert.deepEqual([item?.status, item?.auto?.superseded], ['discarded', 'its MR is no longer open']);
  assert.deepEqual(verdicts(), []);
});

test('a finished pass whose MR GitLab no longer has settles closed too', async () => {
  donePass();
  const fake = fakeWorld({ mrs: [] });
  await settlePasses(context(fake.world, 'heidi:verdict', { mrs: [] }), fake.ports);
  assert.equal(settled(), 'closed');
});

test('a finished pass whose MR is open but off the list settles against a fresh read of it', async () => {
  donePass();
  const fake = fakeWorld({ mrs: [mr({ state: 'opened' })] });
  await settlePasses(context(fake.world, 'heidi:verdict', { mrs: [] }), fake.ports);
  assert.equal(settled(), 'finished');
  assert.equal(verdicts().length, 1, 'and its verdict is queued');
});

test('a read that failed leaves the pass to settle next time', async () => {
  donePass();
  const fake = fakeWorld();
  fake.ports.freshMr = async () => {
    throw new Error('GitLab timed out');
  };
  await settlePasses(context(fake.world, 'heidi:verdict', { mrs: [] }), fake.ports);
  assert.equal(settled(), undefined);
});

test('settling a pass a second time queues no second verdict', async () => {
  donePass();
  const fake = fakeWorld();
  await settlePasses(context(fake.world), fake.ports);
  donePass();
  await settlePasses(context(fake.world), fake.ports);
  assert.equal(settled(), 'finished');
  assert.equal(verdicts().length, 1);
});

const asking = (iid: number, over = {}) => mr({ iid, author: 'judy', ...over });

test('an MR that asks you is reviewed at shadow on request, and its pass says so', async () => {
  const fake = fakeWorld({ mrs: [asking(5)] });
  const report = await launchPasses(context(fake.world, '*:shadow'), fake.ports);
  assert.deepEqual([report.launched, report.asked], [['acme/engine!5'], ['acme/engine!5']]);
  const pass = store.loadAutoMemory()['acme/engine!5']?.pass;
  assert.deepEqual([pass?.level, pass?.asked], ['shadow', true]);
  const own = fakeWorld({ mrs: [mr({ iid: 6 })] });
  assert.deepEqual((await launchPasses(context(own.world, '*:shadow, heidi:comments'), own.ports)).asked, []);
  const ownPass = store.loadAutoMemory()['acme/engine!6']?.pass;
  assert.deepEqual([ownPass?.level, ownPass?.asked], ['comments', undefined], 'a row of their own is not on request');
});

test('with the default row off, or the author opted out, nothing launches', async () => {
  for (const fullAuto of ['', '*:off', '*:shadow, judy:off']) {
    resetState();
    const fake = fakeWorld({ mrs: [asking(5)] });
    assert.deepEqual((await launchPasses(context(fake.world, fullAuto), fake.ports)).launched, [], fullAuto);
  }
});

test('reviewing on request sends nothing, ever: its findings and its verdict wait for you', async () => {
  const fake = fakeWorld({ mrs: [asking(5)] });
  const ctx = context(fake.world, '*:shadow');
  await launchPasses(ctx, fake.ports);
  const pass = store.loadAutoMemory()['acme/engine!5']?.pass;
  store.addToQueue([
    { projectPath: 'acme/engine', projectId: 1001, iid: 5, webUrl: '', severity: 'MAJOR', body: 'null deref', createdBy: `auto:${pass?.id}` },
  ]);
  store.updateAutoMemory('acme/engine!5', (m) => ({ ...m, pass: { ...m.pass!, doneAt: new Date(START).toISOString() } }));
  for (let poll = 0; poll < 4; poll += 1) {
    fake.world.clock += 10 * MINUTE;
    await autoPoll(ctx, fake.ports);
  }
  assert.deepEqual(fake.calls.posted, []);
  const left = store.loadQueue().filter((c) => c.iid === 5);
  assert.deepEqual(left.map((c) => [c.kind ?? 'finding', c.status, c.auto?.level]), [['finding', 'pending', 'shadow'], ['verdict', 'pending', 'shadow']]);
});

test('reviewing on request launches at most two a poll', async () => {
  const fake = fakeWorld({ mrs: [asking(1), asking(2), asking(3)] });
  const report = await launchPasses(context(fake.world, '*:shadow'), fake.ports);
  assert.deepEqual(report.launched, ['acme/engine!1', 'acme/engine!2']);
});
