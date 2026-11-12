import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'thematrix-claim-'));
process.env['UNDERLINGS_STATE_DIR'] = dir;
process.env['GITLAB_TOKEN'] = 'not-a-real-token';

const { sendDue } = await import('./send.js');
const { fencedPorts } = await import('./driver.js');
const { postOne } = await import('../actions/post.js');
const store = await import('../data/store.js');
const { MINUTE, START, context, fakeWorld, mr, resetState } = await import('./testkit.js');
const { TestProc } = await import('./testproc.js');
type QueuedComment = import('../types.js').QueuedComment;
type AutoPorts = import('./ports.js').AutoPorts;

const KEY = 'acme/engine!621';
const QUEUE = join(dir, 'queue.json');

const realFetch = globalThis.fetch;
const fetched: string[] = [];
let gitlab: () => Promise<Response> = async () => Response.json({ id: 'd-new' });
globalThis.fetch = (async (input: string | URL | Request) => {
  fetched.push(String(input));
  return gitlab();
}) as typeof fetch;

after(() => {
  globalThis.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  resetState();
  fetched.length = 0;
  gitlab = async () => Response.json({ id: 'd-new' });
});

function queueDue(count: number, sendAt = START - MINUTE): QueuedComment[] {
  const launchedAt = new Date(sendAt - MINUTE).toISOString();
  store.updateAutoMemory(KEY, (m) => ({ ...m, pass: { id: 'p1', key: KEY, author: 'heidi', sha: 'head-1', trigger: 'new', launchedAt } }));
  return store.addToQueue(
    Array.from({ length: count }, (_, n) => ({
      projectPath: 'acme/engine',
      projectId: 1001,
      iid: 621,
      webUrl: '',
      severity: 'MINOR' as const,
      body: `finding ${n}`,
      createdBy: 'auto:p1',
      auto: { pass: 'p1', level: 'comments' as const, sendAt: new Date(sendAt).toISOString() },
    })),
  );
}

const itemOf = (id: string): QueuedComment | undefined => store.loadQueue().find((c) => c.id === id);
const ctx = (world: ReturnType<typeof fakeWorld>['world'], claimBy: string) =>
  context(world, 'heidi:comments', { claimBy });

interface Gate {
  run: string;
  open: () => void;
}

/** Every call that would go over the network waits here, so the test picks the order the two runs resume in. */
function gated(base: AutoPorts, run: string, waiting: Gate[], posted: string[]): AutoPorts {
  const gate = (): Promise<void> => new Promise((open) => waiting.push({ run, open }));
  return {
    ...base,
    freshMr: async (ref) => {
      await gate();
      return base.freshMr(ref);
    },
    post: async (item, how) => {
      await gate();
      posted.push(item.id);
      return base.post(item, how);
    },
  };
}

async function settle(): Promise<void> {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function orders(length: number): string[][] {
  if (length === 0) return [[]];
  return orders(length - 1).flatMap((rest) => [['A', ...rest], ['B', ...rest]]);
}

async function race(order: string[], bStartsAfter: number, fenced: boolean): Promise<{ posted: string[]; items: string[] }> {
  resetState();
  const items = queueDue(2).map((c) => c.id);
  const fake = fakeWorld();
  const waiting: Gate[] = [];
  const posted: string[] = [];
  const portsFor = (run: string): AutoPorts => {
    const ports = gated(fake.ports, run, waiting, posted);
    return fenced ? fencedPorts(() => true, ports) : ports;
  };
  const runs = [sendDue(ctx(fake.world, 'auto:A'), portsFor('A'))];
  const startB = (): void => void runs.push(sendDue(ctx(fake.world, 'auto:B'), portsFor('B')));
  if (bStartsAfter === 0) startB();
  let opened = 0;
  for (const run of order) {
    await settle();
    const at = waiting.findIndex((g) => g.run === run);
    if (at >= 0) waiting.splice(at, 1)[0]?.open();
    opened += 1;
    if (opened === bStartsAfter) startB();
  }
  if (runs.length === 1) startB();
  for (;;) {
    await settle();
    const next = waiting.shift();
    if (!next) break;
    next.open();
  }
  await Promise.all(runs);
  return { posted, items };
}

test('two drivers never both post an item, whatever order their calls come back in', async () => {
  let scenarios = 0;
  for (const fenced of [false, true]) {
    for (const bStartsAfter of [0, 1, 2, 3]) {
      for (const order of orders(6)) {
        const { posted, items } = await race(order, bStartsAfter, fenced);
        const label = `${order.join('')}, B after ${bStartsAfter}${fenced ? ', both fenced and held' : ''}`;
        assert.equal(new Set(posted).size, posted.length, `posted twice: ${label}`);
        for (const id of items) {
          const item = itemOf(id);
          assert.ok(posted.includes(id) || item?.auto?.held === store.INTERRUPTED, `lost: ${label}`);
        }
        scenarios += 1;
      }
    }
  }
  assert.equal(scenarios, 2 * 4 * 64);
});

test('a driver that loses the lock part way through a batch stops before its next item', async () => {
  const [first, second] = queueDue(2);
  let held = true;
  const fake = fakeWorld({ onPost: () => void (held = false) });
  await sendDue(ctx(fake.world, 'auto:A'), fencedPorts(() => held, fake.ports));
  assert.deepEqual(fake.calls.posted.map((p) => p.item.id), [first?.id]);
  assert.equal(itemOf(second?.id ?? '')?.status, 'pending');
  assert.equal(itemOf(second?.id ?? '')?.sending, undefined, 'and it was never claimed');
});

test('an item the gates hold back is not left claimed', async () => {
  const launchedAt = new Date(START - 2 * MINUTE).toISOString();
  store.updateAutoMemory(KEY, (m) => ({ ...m, pass: { id: 'p1', key: KEY, author: 'heidi', sha: 'head-1', trigger: 'new', launchedAt } }));
  const [reply] = store.addToQueue([
    {
      projectPath: 'acme/engine', projectId: 1001, iid: 621, webUrl: '', severity: 'MINOR', body: 'Fixed.', createdBy: 'auto:p1',
      kind: 'reply', replyTo: 'gone', outcome: 'fixed', auto: { pass: 'p1', level: 'comments', sendAt: new Date(START - MINUTE).toISOString() },
    },
  ]);
  const fake = fakeWorld();
  await sendDue(ctx(fake.world, 'auto:A'), fake.ports);
  const held = itemOf(reply?.id ?? '');
  assert.equal(held?.auto?.held, 'the thread has gone');
  assert.equal(held?.sending, undefined);
  assert.deepEqual(fake.calls.posted, []);
});

test('a claim another driver left is handed back and never sent, and a fresh manual one is left alone', async () => {
  const [abandoned, manual, oldManual] = queueDue(3);
  store.claimToSend(abandoned?.id ?? '', 'auto:gone', START);
  store.claimToSend(manual?.id ?? '', 'manual:in-flight', START);
  store.claimToSend(oldManual?.id ?? '', 'manual:died', START - 4 * MINUTE);
  const fake = fakeWorld();
  const report = await sendDue(ctx(fake.world, 'auto:me'), fake.ports);
  for (const item of [abandoned, oldManual]) {
    const now = itemOf(item?.id ?? '');
    assert.equal(now?.auto?.held, store.INTERRUPTED);
    assert.equal(now?.error, store.INTERRUPTED);
    assert.equal(now?.sending, undefined);
  }
  assert.equal(itemOf(manual?.id ?? '')?.sending?.by, 'manual:in-flight', 'someone is posting it right now');
  assert.equal(report.held, 2);
  assert.deepEqual(fake.calls.posted, []);
  await sendDue(ctx(fake.world, 'auto:me'), fake.ports);
  assert.deepEqual(fake.calls.posted, [], 'and a later tick does not resend them either');
});

test('a manual post of an item being sent writes nothing, and a post clears its claim whatever happens', async () => {
  const [item] = queueDue(1);
  store.claimToSend(item?.id ?? '', 'auto:A', START);
  const before = readFileSync(QUEUE, 'utf8');
  const refused = await postOne(itemOf(item?.id ?? '')!);
  assert.deepEqual(refused, { id: item?.id, ok: false, error: 'already being sent' });
  assert.equal(readFileSync(QUEUE, 'utf8'), before, 'not a byte changed');
  assert.deepEqual(fetched, [], 'and nothing went to GitLab');

  store.releaseClaim(item?.id ?? '', 'auto:A');
  assert.equal((await postOne(itemOf(item?.id ?? '')!)).ok, true);
  assert.deepEqual([itemOf(item?.id ?? '')?.status, itemOf(item?.id ?? '')?.sending], ['posted', undefined]);

  const [failing] = queueDue(1);
  gitlab = async () => new Response('down', { status: 500 });
  const failed = await postOne(failing!);
  assert.equal(failed.ok, false);
  assert.deepEqual([itemOf(failing?.id ?? '')?.status, itemOf(failing?.id ?? '')?.sending], ['pending', undefined]);
});

test('a manual post racing an auto send is told it is already being sent, whichever starts first', async () => {
  const [item] = queueDue(1);
  const fake = fakeWorld();
  let open = (): void => undefined;
  const slow: AutoPorts = {
    ...fake.ports,
    post: async (c, how) => {
      await new Promise<void>((resolve) => (open = resolve));
      return fake.ports.post(c, how);
    },
  };
  const auto = sendDue(ctx(fake.world, 'auto:A'), slow);
  await settle();
  assert.equal((await postOne(itemOf(item?.id ?? '')!)).error, 'already being sent');
  open();
  await auto;
  assert.equal(fake.calls.posted.length, 1);

  const [second] = queueDue(1);
  let reply = (): void => undefined;
  gitlab = () => new Promise((resolve) => (reply = () => resolve(Response.json({ id: 'd-2' }))));
  const manual = postOne(second!);
  await settle();
  await sendDue(ctx(fake.world, 'auto:A'), fake.ports);
  assert.equal(fake.calls.posted.length, 1, 'the auto send left it to the manual one');
  reply();
  assert.equal((await manual).ok, true);
  assert.equal(itemOf(second?.id ?? '')?.status, 'posted');
});

test('an unexpired editing mark blocks the claim, and an expired one does not', async () => {
  const [item] = queueDue(1);
  const id = item?.id ?? '';
  assert.equal(store.setEditing(id, 'cc', START + 60_000), true);
  assert.deepEqual(store.claimToSend(id, 'auto:A', START), { refused: 'it is being edited' });
  assert.deepEqual(store.claimToSend(id, 'manual:x', START), { refused: 'it is being edited' });
  const fake = fakeWorld();
  await sendDue(ctx(fake.world, 'auto:A'), fake.ports);
  assert.deepEqual(fake.calls.posted, []);
  fake.world.clock = START + 61_000;
  await sendDue(ctx(fake.world, 'auto:A'), fake.ports);
  assert.equal(fake.calls.posted.length, 1, 'the mark lapsed, so it goes');
  assert.equal(store.setEditing(id, 'cc', START), false, 'a posted item takes no mark');
});

test('closing an edit clears only your own mark', () => {
  const [item] = queueDue(1);
  const id = item?.id ?? '';
  store.setEditing(id, 'thematrix:1', START + 60_000);
  store.setEditing(id, 'cc', null);
  assert.equal(itemOf(id)?.editing?.by, 'thematrix:1');
  store.setEditing(id, 'thematrix:1', null);
  assert.equal(itemOf(id)?.editing, undefined);
});

const realDue = (count: number): QueuedComment[] => queueDue(count, Date.now() - MINUTE);

test('two real processes sending the same queue post each item once', async () => {
  const items = realDue(40).map((c) => c.id);
  const log = join(dir, 'posted.log');
  const a = new TestProc(dir);
  const b = new TestProc(dir);
  try {
    const send = (p: InstanceType<typeof TestProc>, claimBy: string) =>
      p.send({ op: 'send', mrs: [mr()], people: 'heidi:comments', claimBy, log, delayMs: 2, crashOnPost: false });
    await Promise.all([send(a, 'auto:A'), send(b, 'auto:B')]);
  } finally {
    await Promise.all([a.close(), b.close()]);
  }
  const posted = readFileSync(log, 'utf8').trim().split('\n');
  assert.equal(new Set(posted).size, posted.length, 'nothing went twice');
  for (const id of items) {
    assert.ok(posted.includes(id) || itemOf(id)?.auto?.held === store.INTERRUPTED, `${id} was neither sent nor handed back`);
  }
});

test('a process killed between the GitLab call and the posted mark leaves a claim that is handed back, never resent', async () => {
  const [item] = realDue(1);
  const log = join(dir, 'crash.log');
  const crashing = new TestProc(dir);
  void crashing.send({ op: 'send', mrs: [mr()], people: 'heidi:comments', claimBy: 'auto:crashed', log, delayMs: 0, crashOnPost: true });
  await crashing.exited;
  assert.equal(itemOf(item?.id ?? '')?.sending?.by, 'auto:crashed', 'it died holding the claim');
  const fake = fakeWorld();
  fake.world.clock = Date.now();
  await sendDue(ctx(fake.world, 'auto:next'), fake.ports);
  await sendDue(ctx(fake.world, 'auto:next'), fake.ports);
  assert.deepEqual(fake.calls.posted, [], 'the next driver never resends it');
  assert.equal(itemOf(item?.id ?? '')?.auto?.held, store.INTERRUPTED);
  assert.deepEqual(readFileSync(log, 'utf8').trim().split('\n'), [item?.id], 'GitLab got it the once');
  assert.equal(existsSync(join(dir, 'queue.json.lock')), false, 'and the queue lock was not left behind');
});
