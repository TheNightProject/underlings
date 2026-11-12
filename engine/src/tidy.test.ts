import assert from 'node:assert/strict';
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'thematrix-tidy-'));
process.env['UNDERLINGS_STATE_DIR'] = dir;

const store = await import('./data/store.js');
const tidy = await import('./tidy.js');
const { postAllFor, postOne } = await import('./actions/post.js');
const { waitingToPost } = await import('./queue.js');
const kit = await import('./auto/testkit.js');
type QueuedComment = import('./types.js').QueuedComment;
type MrState = import('./data/gitlab.js').MrState;
type AskState = import('./tidy.js').AskState;

after(() => rmSync(dir, { recursive: true, force: true }));

beforeEach(() => {
  kit.resetState();
  tidy.forgetStates();
});

const ENGINE = 'northwind/platform/relay';
const OPEN = 1121;
const MERGED = 1100;
const CLOSED = 1090;
const keyOf = (iid: number, path = ENGINE): string => `${path}!${iid}`;

function finding(iid: number, over: Partial<QueuedComment> = {}): Omit<QueuedComment, 'id' | 'createdAt' | 'status'> {
  return {
    projectPath: ENGINE,
    projectId: 7,
    iid,
    webUrl: `https://gitlab.com/${ENGINE}/-/merge_requests/${iid}`,
    severity: 'MINOR',
    body: `on ${iid}`,
    createdBy: 'review',
    ...over,
  };
}

function seed(...items: { iid: number; status?: QueuedComment['status']; over?: Partial<QueuedComment> }[]): QueuedComment[] {
  const added = store.addToQueue(items.map(({ iid, over }) => finding(iid, over)));
  added.forEach((c, n) => {
    const status = items[n]?.status;
    if (status && status !== 'pending') store.updateQueueItem(c.id, { status });
  });
  return store.loadQueue();
}

const statusOf = (id: string): string | undefined => store.loadQueue().find((c) => c.id === id)?.status;
const openList = [kit.mr({ projectPath: ENGINE, iid: OPEN })];

function askFrom(states: Record<string, MrState | null | Error>, asked: string[] = []): AskState {
  return async (projectPath, iid) => {
    const key = keyOf(iid, projectPath);
    asked.push(key);
    const answer = states[key];
    if (answer instanceof Error) throw answer;
    if (answer === undefined) throw new Error(`nobody asked about ${key}`);
    return answer;
  };
}

test('expireClosed turns every pending item on a merged or closed MR into an expired one with its reason, and nothing else', () => {
  const [onMerged, onClosed, onOpen, posted, discarded] = seed(
    { iid: MERGED },
    { iid: CLOSED },
    { iid: OPEN },
    { iid: MERGED, status: 'posted' },
    { iid: MERGED, status: 'discarded' },
  );
  const reasons = new Map([[keyOf(MERGED), 'MR merged' as const], [keyOf(CLOSED), 'MR closed' as const]]);
  const expired = store.expireClosed(reasons);
  assert.deepEqual(expired.map((c) => c.id).sort(), [onMerged?.id, onClosed?.id].sort());
  const after = new Map(store.loadQueue().map((c) => [c.id, c]));
  assert.equal(after.get(onMerged?.id ?? '')?.expiredReason, 'MR merged');
  assert.equal(after.get(onClosed?.id ?? '')?.expiredReason, 'MR closed');
  assert.ok(Date.parse(after.get(onMerged?.id ?? '')?.expiredAt ?? '') > 0, 'with when');
  assert.equal(after.get(onOpen?.id ?? '')?.status, 'pending');
  assert.equal(after.get(posted?.id ?? '')?.status, 'posted', 'a posted item is GitLab\'s, never expired');
  assert.equal(after.get(discarded?.id ?? '')?.status, 'discarded');
  assert.equal(after.get(posted?.id ?? '')?.expiredAt, undefined);
});

test('an item being sent, or being edited, is left alone and expires on a later round', () => {
  const [sending, editing, idle] = seed({ iid: MERGED }, { iid: MERGED }, { iid: MERGED });
  const reasons = new Map([[keyOf(MERGED), 'MR merged' as const]]);
  assert.ok('item' in store.claimToSend(sending?.id ?? '', 'manual:other', Date.now()));
  assert.ok(store.setEditing(editing?.id ?? '', 'page', Date.now() + 90_000));
  store.expireClosed(reasons);
  assert.equal(statusOf(sending?.id ?? ''), 'pending', 'mid-send');
  assert.equal(statusOf(editing?.id ?? ''), 'pending', 'mid-edit');
  assert.equal(statusOf(idle?.id ?? ''), 'expired');
  store.releaseClaim(sending?.id ?? '', 'manual:other');
  store.setEditing(editing?.id ?? '', 'page', null);
  store.expireClosed(reasons);
  assert.equal(statusOf(sending?.id ?? ''), 'expired');
  assert.equal(statusOf(editing?.id ?? ''), 'expired');
});

async function withGitLab<T>(answer: () => Promise<Response>, run: () => Promise<T>): Promise<T> {
  const fetchWas = globalThis.fetch;
  const tokenWas = process.env['GITLAB_TOKEN'];
  process.env['GITLAB_TOKEN'] = 'test-token';
  globalThis.fetch = answer as typeof fetch;
  try {
    return await run();
  } finally {
    globalThis.fetch = fetchWas;
    if (tokenWas === undefined) delete process.env['GITLAB_TOKEN'];
    else process.env['GITLAB_TOKEN'] = tokenWas;
  }
}

test('a post is claimed until it is recorded, so expiry landing mid-post cannot leave a posted item marked expired', async () => {
  const [item] = seed({ iid: MERGED });
  let release: () => void = () => {};
  const sent = new Promise<void>((resolve) => { release = resolve; });
  const answer = async (): Promise<Response> => {
    await sent;
    return new Response(JSON.stringify({ id: 'disc-1' }), { status: 201, headers: { 'content-type': 'application/json' } });
  };
  await withGitLab(answer, async () => {
    const posting = postOne(item as QueuedComment);
    await new Promise((resolve) => setTimeout(resolve, 5));
    store.expireClosed(new Map([[keyOf(MERGED), 'MR merged' as const]]));
    release();
    assert.equal((await posting).ok, true);
  });
  const after = store.loadQueue().find((c) => c.id === item?.id);
  assert.equal(after?.status, 'posted');
  assert.equal(after?.expiredReason, undefined);
});

test('Post all on an MR that merges and is archived part way through sends only what is still waiting when its turn comes', async () => {
  const [first, second, third] = seed({ iid: MERGED }, { iid: MERGED }, { iid: MERGED });
  let release: () => void = () => {};
  const firstHeld = new Promise<void>((resolve) => { release = resolve; });
  let sent = 0;
  const answer = async (): Promise<Response> => {
    sent += 1;
    if (sent === 1) await firstHeld;
    return new Response(JSON.stringify({ id: `disc-${sent}` }), { status: 201, headers: { 'content-type': 'application/json' } });
  };
  const results = await withGitLab(answer, async () => {
    const posting = postAllFor(ENGINE, MERGED);
    await new Promise((resolve) => setTimeout(resolve, 5));
    await tidy.tidyQueue(openList, { ask: askFrom({ [keyOf(MERGED)]: 'merged' }) });
    const group = tidy.archivable(store.loadQueue(), openList).find((g) => g.key === keyOf(MERGED));
    store.archiveQueue(group?.ids ?? [], 'MR merged');
    release();
    return posting;
  });
  assert.equal(sent, 1, 'GitLab got only the one already on its way');
  assert.deepEqual(results.map((r) => r.ok), [true, false, false]);
  assert.equal(statusOf(first?.id ?? ''), 'posted');
  const archived = new Map(store.loadArchive().items.map((c) => [c.id, c]));
  assert.deepEqual([second?.id, third?.id].map((id) => archived.get(id ?? '')?.status), ['expired', 'expired'], 'recorded as never posted, which is true');
});

test('an item being sent stays in the queue whoever settled it meanwhile, so its post can still be recorded', () => {
  const [item] = seed({ iid: MERGED });
  assert.ok('item' in store.claimToSend(item?.id ?? '', 'manual:other', Date.now()));
  store.updateQueueItem(item?.id ?? '', { status: 'expired', expiredReason: 'MR merged' });
  assert.deepEqual(store.archiveQueue([item?.id ?? ''], 'MR merged'), [], 'not while it is being sent');
  store.updateQueueItem(item?.id ?? '', { status: 'posted', discussionId: 'disc-1', sending: undefined });
  assert.deepEqual(store.archiveQueue([item?.id ?? ''], 'MR merged').map((c) => c.discussionId), ['disc-1']);
});

test('archiveQueue moves settled items out to the archive with when and why, and never a pending one', () => {
  const [pending, posted, discarded, expiredLater, onOpen] = seed(
    { iid: MERGED },
    { iid: MERGED, status: 'posted' },
    { iid: MERGED, status: 'discarded' },
    { iid: MERGED },
    { iid: OPEN, status: 'posted' },
  );
  store.setEditing(pending?.id ?? '', 'page', Date.now() + 90_000);
  store.expireClosed(new Map([[keyOf(MERGED), 'MR merged' as const]]));
  const ids = [pending, posted, discarded, expiredLater].map((c) => c?.id ?? '');
  const archived = store.archiveQueue(ids, 'MR merged');
  assert.deepEqual(archived.map((c) => c.id).sort(), [posted, discarded, expiredLater].map((c) => c?.id).sort());
  assert.deepEqual(store.loadQueue().map((c) => c.id).sort(), [pending?.id, onOpen?.id].sort(), 'pending stays, even when named');
  const lines = readFileSync(join(dir, 'queue-archive.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(lines.length, 3);
  for (const line of lines) {
    assert.equal(line.why, 'MR merged');
    assert.ok(Date.parse(line.archivedAt) > 0);
  }
  assert.deepEqual(store.archiveQueue(() => true, 'anything').map((c) => c.id), [onOpen?.id], 'a predicate cannot reach a pending item either');
  assert.equal(statusOf(pending?.id ?? ''), 'pending');
  assert.deepEqual(readdirSync(dir).filter((n) => n.endsWith('.tmp') || n.endsWith('.lock')), [], 'written through a temp file and unlocked');
});

test('the archive reads back newest first, a page at a time, each item once however often it was written', () => {
  const items = seed(...[1, 2, 3, 4, 5].map((n) => ({ iid: 2000 + n, status: 'posted' as const })));
  for (const c of items) store.archiveQueue([c.id], 'MR merged');
  appendFileSync(join(dir, 'queue-archive.jsonl'), `${JSON.stringify({ ...items[0], archivedAt: '2000-01-01T00:00:00Z', why: 'copy' })}\n`);
  const first = store.loadArchive({ offset: 0, limit: 2 });
  assert.equal(first.total, 5);
  assert.deepEqual(first.items.map((c) => c.iid), [2005, 2004]);
  assert.deepEqual(store.loadArchive({ offset: 4, limit: 2 }).items.map((c) => c.iid), [2001], 'the later copy of 2001 wins, and sorts as written then');
});

test('a line torn by a crash mid-append costs only itself, not the next item archived after it', () => {
  const [a, b] = seed({ iid: 3001, status: 'posted' }, { iid: 3002, status: 'posted' });
  store.archiveQueue([a?.id ?? ''], 'MR merged');
  appendFileSync(join(dir, 'queue-archive.jsonl'), '{"id":"torn","projectPa');
  store.archiveQueue([b?.id ?? ''], 'MR merged');
  assert.deepEqual(store.loadArchive().items.map((c) => c.id).sort(), [a?.id, b?.id].sort());
});

test('tidyQueue asks GitLab about queued MRs missing from the open list and expires what is pending on the merged and closed ones', async () => {
  const [merged, closed, gone, stillOpen, unknown, listed] = seed(
    { iid: MERGED },
    { iid: CLOSED },
    { iid: 1080 },
    { iid: 1070 },
    { iid: 1060 },
    { iid: OPEN },
  );
  const asked: string[] = [];
  const ask = askFrom({ [keyOf(MERGED)]: 'merged', [keyOf(CLOSED)]: 'closed', [keyOf(1080)]: null, [keyOf(1070)]: 'opened', [keyOf(1060)]: new Error('GitLab GraphQL 502') }, asked);
  const report = await tidy.tidyQueue(openList, { ask });
  assert.ok(!asked.includes(keyOf(OPEN)), 'an MR in the open list is never asked about');
  assert.equal(report.asked, 5);
  assert.deepEqual(report.failed, [`${keyOf(1060)}: GitLab GraphQL 502`]);
  const after = new Map(store.loadQueue().map((c) => [c.id, c]));
  assert.equal(after.get(merged?.id ?? '')?.expiredReason, 'MR merged');
  assert.equal(after.get(closed?.id ?? '')?.expiredReason, 'MR closed');
  assert.equal(after.get(gone?.id ?? '')?.expiredReason, 'MR closed', 'one GitLab no longer has is closed for good');
  assert.equal(after.get(stillOpen?.id ?? '')?.status, 'pending', 'open on GitLab, only missing from the list');
  assert.equal(after.get(unknown?.id ?? '')?.status, 'pending', 'an unanswered question expires nothing');
  assert.equal(after.get(listed?.id ?? '')?.status, 'pending');
});

test('an MR closed and then reopened gets back what expired on it, while one that merged stays expired', async () => {
  const onClosed = seed({ iid: CLOSED, over: { severity: 'MAJOR' } }, { iid: CLOSED }, { iid: CLOSED });
  const [onMerged] = seed({ iid: MERGED }).filter((c) => c.iid === MERGED);
  const ask = askFrom({ [keyOf(CLOSED)]: 'closed', [keyOf(MERGED)]: 'merged' });
  const closing = await tidy.tidyQueue(openList, { ask });
  assert.equal(closing.expired.length, 4);
  const reopenedList = [...openList, kit.mr({ projectPath: ENGINE, iid: CLOSED }), kit.mr({ projectPath: ENGINE, iid: MERGED })];
  const reopening = await tidy.tidyQueue(reopenedList, { ask });
  assert.deepEqual(reopening.revived.map((c) => c.id).sort(), onClosed.map((c) => c.id).sort());
  const after = new Map(store.loadQueue().map((c) => [c.id, c]));
  for (const c of onClosed) {
    assert.equal(after.get(c.id)?.status, 'pending');
    assert.equal(after.get(c.id)?.expiredReason, undefined);
    assert.equal(after.get(c.id)?.expiredAt, undefined);
  }
  assert.equal(after.get(onMerged?.id ?? '')?.status, 'expired', 'merged is final');
  assert.equal(waitingToPost(store.loadQueue(), reopenedList).length, 3, 'and they wait to post again');
});

test('a reopened MR missing from the list gets its findings back once GitLab next says it is open', async () => {
  const [item] = seed({ iid: CLOSED });
  const now = Date.parse('2026-11-06T10:00:00Z');
  await tidy.tidyQueue(openList, { ask: askFrom({ [keyOf(CLOSED)]: 'closed' }), now });
  assert.equal(statusOf(item?.id ?? ''), 'expired');
  const reopened = askFrom({ [keyOf(CLOSED)]: 'opened' });
  await tidy.tidyQueue(openList, { ask: reopened, now: now + 30 * 60_000 });
  assert.equal(statusOf(item?.id ?? ''), 'expired', 'closed is asked again only after an hour');
  const report = await tidy.tidyQueue(openList, { ask: reopened, now: now + 61 * 60_000 });
  assert.deepEqual(report.revived.map((c) => c.id), [item?.id]);
  assert.equal(statusOf(item?.id ?? ''), 'pending');
});

test('a merged answer is kept for good, and the others are asked again only once an hour has passed', async () => {
  seed({ iid: MERGED }, { iid: CLOSED }, { iid: 1070 });
  const asked: string[] = [];
  const ask = askFrom({ [keyOf(MERGED)]: 'merged', [keyOf(CLOSED)]: 'closed', [keyOf(1070)]: 'opened' }, asked);
  const now = Date.parse('2026-11-06T10:00:00Z');
  await tidy.tidyQueue(openList, { ask, now });
  assert.equal(asked.length, 3);
  await tidy.tidyQueue(openList, { ask, now: now + 59 * 60_000 });
  assert.equal(asked.length, 3, 'nothing asked twice within the hour');
  await tidy.tidyQueue(openList, { ask, now: now + 61 * 60_000 });
  assert.deepEqual(asked.slice(3).sort(), [keyOf(CLOSED), keyOf(1070)].sort(), 'merged is never asked again');
});

test('a round asks only a few, those with something pending first', async () => {
  seed(...[1, 2, 3, 4, 5, 6].map((n) => ({ iid: 4000 + n, status: 'posted' as const })), { iid: 4100 });
  const asked: string[] = [];
  const states = Object.fromEntries([...[1, 2, 3, 4, 5, 6].map((n) => keyOf(4000 + n)), keyOf(4100)].map((k) => [k, 'merged' as const]));
  await tidy.tidyQueue(openList, { ask: askFrom(states, asked), limit: 3 });
  assert.equal(asked.length, 3);
  assert.equal(asked[0], keyOf(4100));
  await tidy.tidyQueue(openList, { ask: askFrom(states, asked), limit: 3 });
  assert.equal(new Set(asked).size, 6, 'the next round carries on where the last stopped');
});

test('test data is expired as such, and GitLab is never asked about it', async () => {
  const [fixture] = seed({ iid: 621, over: { projectPath: 'acme/engine', webUrl: 'https://gitlab.example/acme/engine/-/merge_requests/621' } });
  const asked: string[] = [];
  await tidy.tidyQueue(openList, { ask: askFrom({}, asked) });
  assert.deepEqual(asked, []);
  assert.equal(store.loadQueue().find((c) => c.id === fixture?.id)?.expiredReason, 'test data');
});

test('archivable groups the settled items on MRs missing from the open list, with a reason only once GitLab has given one', async () => {
  seed(
    { iid: MERGED, status: 'posted' },
    { iid: MERGED, status: 'discarded' },
    { iid: MERGED },
    { iid: 1070, status: 'posted' },
    { iid: OPEN, status: 'posted' },
    { iid: 621, status: 'discarded', over: { projectPath: 'acme/engine' } },
  );
  await tidy.checkStates([{ projectPath: ENGINE, iid: MERGED }], { ask: askFrom({ [keyOf(MERGED)]: 'merged' }) });
  const groups = new Map(tidy.archivable(store.loadQueue(), openList).map((g) => [g.key, g]));
  assert.deepEqual([...groups.keys()].sort(), [keyOf(MERGED), keyOf(1070), 'acme/engine!621'].sort(), 'an open MR is never offered');
  assert.equal(groups.get(keyOf(MERGED))?.ids.length, 2, 'the pending one stays');
  assert.equal(groups.get(keyOf(MERGED))?.why, 'MR merged');
  assert.equal(groups.get(keyOf(1070))?.why, null, 'not asked yet, so not known to be closed');
  assert.equal(groups.get('acme/engine!621')?.why, 'test data');
});

test('an expired item is settled everywhere the engine counts what is waiting, and full auto never sends one', async () => {
  const fake = kit.fakeWorld({ mrs: [kit.mr({ projectPath: ENGINE, iid: MERGED })] });
  const [item] = store.addToQueue([{ ...finding(MERGED), createdBy: 'auto:p1', auto: { pass: 'p1', level: 'comments', sendAt: new Date(kit.START - 1000).toISOString() } }]);
  store.updateAutoMemory(keyOf(MERGED), () => ({ key: keyOf(MERGED), pass: { id: 'p1', key: keyOf(MERGED), author: 'heidi', sha: 'head-1', trigger: 'new', launchedAt: new Date(kit.START).toISOString() } }));
  store.expireClosed(new Map([[keyOf(MERGED), 'MR merged' as const]]));
  const { sendDue } = await import('./auto/send.js');
  const report = await sendDue(kit.context(fake.world, 'heidi:verdict'), fake.ports);
  assert.equal(report.sent, 0);
  assert.deepEqual(fake.calls.posted, []);
  assert.equal(statusOf(item?.id ?? ''), 'expired');
  assert.deepEqual(waitingToPost(store.loadQueue(), fake.world.mrs), [], 'and the TUI queue does not list it');
});

test('every queued-item fixture path the tests use is recognised as test data, and real paths are not', () => {
  const sources = readdirSync(new URL('.', import.meta.url), { recursive: true, withFileTypes: true })
    .filter((f) => f.isFile() && (f.name.endsWith('.test.ts') || f.name === 'testkit.ts'))
    .map((f) => readFileSync(join(f.parentPath, f.name), 'utf8'))
    .join('\n');
  const paths = new Set([...sources.matchAll(/projectPath: '([\w.-]+(?:\/[\w.-]+)*)'/g)].map((m) => m[1] as string));
  const real = new Set([ENGINE]);
  const fixtures = [...paths].filter((p) => !real.has(p));
  assert.ok(fixtures.length >= 5, fixtures.join(', '));
  for (const projectPath of fixtures) assert.ok(tidy.isTestData({ projectPath, webUrl: '' }), `${projectPath} is a fixture`);
  for (const projectPath of ['northwind/platform/relay', 'northwind/platform/services/order-book', 'acmecorp/engine']) {
    assert.equal(tidy.isTestData({ projectPath, webUrl: `https://gitlab.com/${projectPath}/-/merge_requests/1` }), false, projectPath);
  }
  const anyPath = 'group/repo';
  assert.ok(tidy.isTestData({ projectPath: anyPath, webUrl: `https://gitlab.example/${anyPath}/-/merge_requests/1` }), 'the fixture host gives one away too');
});
