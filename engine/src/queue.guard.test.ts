import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'thematrix-guard-'));
process.env['UNDERLINGS_STATE_DIR'] = dir;
process.env['GITLAB_TOKEN'] = 'not-a-real-token';

const store = await import('./data/store.js');
const { postOne } = await import('./actions/post.js');
const { resetState } = await import('./auto/testkit.js');
const { TestProc } = await import('./auto/testproc.js');
type QueuedComment = import('./types.js').QueuedComment;

const ENGINE = 'northwind/platform/relay';
const MERGED = 1100;
const merged = new Map([[`${ENGINE}!${MERGED}`, 'MR merged' as const]]);

const realFetch = globalThis.fetch;
const fetched: string[] = [];
globalThis.fetch = (async (input: string | URL | Request) => {
  fetched.push(String(input));
  return Response.json({ id: 'd-new' });
}) as typeof fetch;

let other: InstanceType<typeof TestProc>;
beforeEach(() => {
  resetState();
  fetched.length = 0;
  other = new TestProc(dir);
});
after(async () => {
  await other?.close();
  globalThis.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
});

function seed(count: number): QueuedComment[] {
  return store.addToQueue(Array.from({ length: count }, (_, n) => ({
    projectPath: ENGINE,
    projectId: 7,
    iid: MERGED,
    webUrl: `https://gitlab.com/${ENGINE}/-/merge_requests/${MERGED}`,
    severity: 'MINOR' as const,
    body: `finding ${n}`,
    createdBy: 'review',
  })));
}

const itemOf = (id: string): QueuedComment | undefined => store.loadQueue().find((c) => c.id === id);

test('expiry and the archive leave an item alone while another process holds its send claim', async () => {
  const [claimed, idle] = seed(2).map((c) => c.id);
  try {
    assert.ok('item' in (await other.send({ op: 'claim', id: claimed, by: 'manual:terminal-app' })));
    assert.deepEqual(store.expireClosed(merged).map((c) => c.id), [idle]);
    assert.equal(itemOf(claimed ?? '')?.status, 'pending', 'mid-send in the other process');
    store.updateQueueItem(claimed ?? '', { status: 'expired', expiredReason: 'MR merged' });
    assert.deepEqual(store.archiveQueue([claimed ?? '', idle ?? ''], 'MR merged').map((c) => c.id), [idle], 'its post can still be recorded');
    assert.equal(itemOf(claimed ?? '')?.sending?.by, 'manual:terminal-app');
  } finally {
    await other.close();
  }
});

test('expiry leaves an item alone while another process has it marked as being edited, and takes it once the mark lapses', async () => {
  const [edited] = seed(1).map((c) => c.id);
  try {
    assert.deepEqual(await other.send({ op: 'mark', id: edited, by: 'control-centre:1', until: Date.now() + 90_000 }), { marked: true });
    assert.deepEqual(store.expireClosed(merged), []);
    assert.equal(itemOf(edited ?? '')?.status, 'pending');
    await other.send({ op: 'mark', id: edited, by: 'control-centre:1', until: Date.now() - 1 });
    assert.deepEqual(store.expireClosed(merged).map((c) => c.id), [edited], 'a lapsed mark holds nothing');
  } finally {
    await other.close();
  }
});

test('an expired item is never claimed for sending, by hand or by full auto, and a Post on it reaches nothing', async () => {
  const [item] = seed(1);
  await other.close();
  store.expireClosed(merged);
  for (const by of ['manual:page', 'auto:driver']) {
    assert.deepEqual(store.claimToSend(item?.id ?? '', by, Date.now()), { refused: 'it expired (MR merged)' }, by);
  }
  const outcome = await postOne(item as QueuedComment);
  assert.deepEqual([outcome.ok, outcome.error], [false, 'it expired (MR merged)']);
  assert.deepEqual(fetched, [], 'GitLab was never asked');
  assert.equal(itemOf(item?.id ?? '')?.sending, undefined);
});

test('a Post on an item another process is sending is refused, and its claim stays with that process', async () => {
  const [item] = seed(1);
  try {
    assert.ok('item' in (await other.send({ op: 'claim', id: item?.id, by: 'manual:control-centre' })));
    const outcome = await postOne(item as QueuedComment);
    assert.deepEqual([outcome.ok, outcome.error], [false, store.ALREADY_SENDING]);
    assert.deepEqual(fetched, [], 'GitLab was never asked');
    assert.equal(itemOf(item?.id ?? '')?.sending?.by, 'manual:control-centre');
  } finally {
    await other.close();
  }
});
