import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { act } from './actions.mjs';
import { loadEngine, loading, refreshInbox } from './engine.mjs';
import { readMatrix } from './matrix.mjs';
import { mr, reset, world } from './testkit.mjs';
import { ROUTES as AUTO_ROUTES } from './autoloop.mjs';
import { queueCleanup, readArchive, start, stop, tidyAfterFetch } from './tidy.mjs';

// The shared stand-in plus the engine's queue clean-up, over the same world: world.gitlab says what GitLab would.
const TESTKIT = new URL('./testkit.mjs', import.meta.url).href;
const STANDIN = `
import { world } from '${TESTKIT}';
export * from '${TESTKIT}';
const keyOf = (c) => c.projectPath + '!' + c.iid;
const REASON = { merged: 'MR merged', closed: 'MR closed' };
const inUse = (c) => (c.sending && Date.now() - Date.parse(c.sending.at) < 180000) || (c.editing && Date.parse(c.editing.until) > Date.now());
const reasonOf = (c) => (c.projectPath.startsWith('acme/test') ? 'test data' : REASON[world.known[keyOf(c)]] ?? null);
export async function checkStates(refs) {
  world.calls.push(['checkStates', ...refs.map(keyOf)]);
  const failed = [];
  for (const r of refs) {
    const said = world.gitlab[keyOf(r)];
    if (said === 'down') failed.push(keyOf(r) + ': GitLab GraphQL 502');
    else if (said) world.known[keyOf(r)] = said;
  }
  return { asked: refs.length, failed };
}
export async function tidyQueue(mrs, options = {}) {
  world.calls.push(['tidyQueue', mrs.map(keyOf)]);
  if (world.tidyThrows) throw new Error(world.tidyThrows);
  const open = new Set(mrs.map(keyOf));
  const missing = [...new Map(world.queue.filter((c) => !open.has(keyOf(c))).map((c) => [keyOf(c), c])).values()];
  const { asked, failed } = await checkStates(missing);
  const revived = world.queue.filter((c) => c.status === 'expired' && c.expiredReason === 'MR closed' && open.has(keyOf(c)));
  for (const c of revived) Object.assign(c, { status: 'pending', expiredReason: undefined, expiredAt: undefined });
  const expired = [];
  for (const c of world.queue) {
    const why = c.status === 'pending' && !open.has(keyOf(c)) ? reasonOf(c) : null;
    if (!why || inUse(c)) continue;
    Object.assign(c, { status: 'expired', expiredReason: why, expiredAt: '2026-11-06T12:00:00Z' });
    expired.push({ ...c });
  }
  return { asked, failed, expired, revived: revived.map((c) => ({ ...c })) };
}
export function waitingToPost(queue, mrs) {
  const open = new Set(mrs.map(keyOf));
  const listed = new Set(mrs.map((m) => m.projectPath));
  return queue.filter((c) => c.status === 'pending' && (open.has(keyOf(c)) || !listed.has(c.projectPath)));
}
export function archivable(queue, mrs) {
  const open = new Set(mrs.map(keyOf));
  const groups = new Map();
  for (const c of queue) {
    if (c.status === 'pending' || open.has(keyOf(c))) continue;
    const g = groups.get(keyOf(c)) ?? { key: keyOf(c), why: reasonOf(c), ids: [] };
    g.ids.push(c.id);
    groups.set(keyOf(c), g);
  }
  return [...groups.values()];
}
export function archiveQueue(ids, why) {
  world.calls.push(['archiveQueue', [...ids].sort(), why]);
  const going = world.queue.filter((c) => c.status !== 'pending' && ids.includes(c.id));
  world.queue = world.queue.filter((c) => !going.includes(c));
  world.archive.push(...going.map((c) => ({ ...c, archivedAt: '2026-11-06T12:30:00Z', why })));
  return going;
}
export function loadArchive({ offset = 0, limit = 50 } = {}) {
  const all = [...world.archive].reverse();
  return { total: all.length, items: all.slice(offset, offset + limit) };
}
`;

const OPEN = 'acme/engine!1121';
const MERGED = 'acme/engine!1100';
const CLOSED = 'acme/engine!1090';
const UNASKED = 'acme/engine!1080';
const dir = await mkdtemp(join(tmpdir(), 'control-centre-tidy-'));
const standIn = join(dir, 'engine.mjs');
await writeFile(standIn, STANDIN);
await loadEngine({ matrixEngine: standIn }, () => {});
const logged = [];
start({}, { log: (text) => logged.push(text) });

after(async () => {
  stop();
  await rm(dir, { recursive: true });
});

const settle = async () => {
  while (loading()) await new Promise((resolve) => setTimeout(resolve, 5));
  await new Promise((resolve) => setTimeout(resolve, 5));
};
const calls = (name) => world.calls.filter(([n]) => n === name);
let next = 0;
function item(key, status = 'pending', extra = {}) {
  const [projectPath, iid] = key.split('!');
  next += 1;
  return { id: 'q' + next, projectPath, projectId: 7, iid: Number(iid), webUrl: 'https://gitlab.com/x', severity: 'MINOR', body: 'b' + next, createdBy: 'review', createdAt: `2026-11-0${1 + (next % 5)}T09:00:00Z`, status, ...extra };
}
const idsOn = (key) => world.queue.filter((c) => `${c.projectPath}!${c.iid}` === key).map((c) => c.id);

beforeEach(async () => {
  await settle();
  reset({ mrs: [mr('acme/engine', 1121)], gitlab: {}, known: {}, archive: [], tidyThrows: null });
  logged.length = 0;
  await refreshInbox();
  await settle();
  world.calls = [];
  logged.length = 0;
});

test('after each inbox fetch the queued MRs missing from the open list are checked and their pending items expire, said once', async () => {
  world.queue = [item(OPEN), item(MERGED), item(MERGED), item(MERGED, 'posted'), item(CLOSED)];
  world.gitlab = { [MERGED]: 'merged', [CLOSED]: 'closed' };
  await refreshInbox();
  await settle();
  assert.deepEqual(calls('tidyQueue'), [['tidyQueue', [OPEN]]], 'handed the open list it just fetched');
  assert.deepEqual(world.queue.map((c) => c.status), ['pending', 'expired', 'expired', 'posted', 'expired']);
  assert.deepEqual(logged, ['Expired 3 queued items never posted: 2 on engine!1100 (MR merged), 1 on engine!1090 (MR closed)']);
  await refreshInbox();
  await settle();
  assert.equal(calls('tidyQueue').length, 2, 'every poll checks');
  assert.equal(logged.length, 1, 'but a poll that expires nothing says nothing');
});

test('a GitLab failure, or the tidy itself failing, is said once however many polls repeat it', async () => {
  world.queue = [item(UNASKED)];
  world.gitlab = { [UNASKED]: 'down' };
  for (let n = 0; n < 3; n += 1) await tidyAfterFetch({ mrs: world.mrs });
  assert.deepEqual(logged, ['could not ask GitLab whether every queued MR is still open: GitLab GraphQL 502']);
  world.tidyThrows = 'the queue is locked';
  for (let n = 0; n < 2; n += 1) await tidyAfterFetch({ mrs: world.mrs });
  assert.equal(logged.length, 2);
  assert.match(logged[1], /could not tidy the review queue: the queue is locked/);
});

test('an item the page has open for editing is not expired while its edit mark lasts', async () => {
  const editing = item(MERGED);
  world.queue = [editing, item(MERGED)];
  world.gitlab = { [MERGED]: 'merged' };
  await AUTO_ROUTES['POST /api/matrix/editing']({ body: async () => ({ id: editing.id, editing: true }) });
  await tidyAfterFetch({ mrs: world.mrs });
  assert.deepEqual(world.queue.map((c) => c.status), ['pending', 'expired']);
});

test('a reopened MR\'s findings come back to wait for you, and that is said once', async () => {
  world.queue = [item(OPEN, 'expired', { expiredReason: 'MR closed' }), item(OPEN, 'expired', { expiredReason: 'MR closed' }), item(MERGED, 'expired', { expiredReason: 'MR merged' })];
  let told = 0;
  await loadEngine({ matrixEngine: standIn }, () => { told += 1; });
  await settle();
  await tidyAfterFetch({ mrs: world.mrs });
  assert.deepEqual(world.queue.map((c) => c.status), ['pending', 'pending', 'expired']);
  assert.deepEqual(logged, ['Back in the queue, its MR reopened: 2 on engine!1121']);
  assert.ok(told > 0, 'and the page is told');
  await tidyAfterFetch({ mrs: world.mrs });
  assert.equal(logged.length, 1);
});

test('the page is told which pending items wait to post by the engine\'s own rule', async () => {
  const ELSEWHERE = 'acme/elsewhere!9';
  world.queue = [item(OPEN), item(MERGED), item(ELSEWHERE), item(OPEN, 'posted'), item(MERGED, 'expired', { expiredReason: 'MR merged' })];
  const waiting = async () => Object.fromEntries((await readMatrix()).queue.map((q) => [q.id, q.waiting]));
  const [onOpen, onMissing, onUnlisted, posted, expired] = world.queue.map((c) => c.id);
  assert.deepEqual(await waiting(), { [onOpen]: true, [onMissing]: false, [onUnlisted]: true, [posted]: false, [expired]: false },
    'a repo with nothing in the list, not polled or its batch failed, says nothing about its MRs');
  await loadEngine({ matrixEngine: new URL(TESTKIT).pathname }, () => {});
  try {
    await settle();
    assert.deepEqual(await waiting(), { [onOpen]: true, [onMissing]: true, [onUnlisted]: true, [posted]: false, [expired]: false }, 'an engine without the rule counts every pending item, as before');
  } finally {
    await loadEngine({ matrixEngine: standIn }, () => {});
    await settle();
  }
});

test('an engine built before the clean-up is said once, and the page gets no counts from it', async () => {
  await loadEngine({ matrixEngine: new URL(TESTKIT).pathname }, () => {});
  try {
    for (let n = 0; n < 3; n += 1) await tidyAfterFetch({ mrs: world.mrs });
    assert.deepEqual(logged, ['the review engine needs rebuilding before findings on merged MRs can expire']);
    assert.equal(queueCleanup(), null);
  } finally {
    await loadEngine({ matrixEngine: standIn }, () => {});
    await settle();
  }
});

test('the snapshot counts what Clean up closed would move over the whole queue, never an open, closed or unasked MR, or anything pending', async () => {
  world.queue = [
    ...Array.from({ length: 70 }, () => item(MERGED, 'posted')),
    item(MERGED, 'expired', { expiredReason: 'MR merged' }), item(MERGED),
    item(CLOSED, 'discarded'), item(UNASKED, 'posted'), item(OPEN, 'posted'),
    item('acme/test!621', 'discarded'), item('acme/test!621', 'discarded'),
  ];
  world.known = { [MERGED]: 'merged', [CLOSED]: 'closed' };
  const { closed, groups } = queueCleanup();
  assert.deepEqual({ items: closed.items, mrs: closed.mrs, test: closed.test }, { items: 71, mrs: 1, test: 2 }, 'a closed MR can reopen, so it is left to its own Archive');
  assert.deepEqual(groups.map((g) => [g.key, g.items, g.why]), [[MERGED, 71, 'MR merged'], [CLOSED, 1, 'MR closed'], [UNASKED, 1, null], ['acme/test!621', 2, 'test data']]);
  const shown = await readMatrix();
  assert.ok(shown.queue.length < world.queue.length, 'the page holds only the newest settled items');
  assert.deepEqual(shown.cleanup, queueCleanup(), 'so the counts come with it');
});

test('expired items reach the page apart from the newest settled, with their reason', async () => {
  world.queue = [item(MERGED, 'expired', { expiredReason: 'MR merged', expiredAt: '2026-10-01T09:00:00Z', createdAt: '2026-10-01T08:00:00Z' }), ...Array.from({ length: 70 }, () => item(OPEN, 'posted', { postedAt: '2026-11-06T09:00:00Z' }))];
  const shown = (await readMatrix()).queue;
  const expired = shown.find((q) => q.status === 'expired');
  assert.equal(expired?.expiredReason, 'MR merged', 'not pushed off by seventy newer posts');
  assert.equal(expired?.expiredAt, '2026-10-01T09:00:00Z');
});

test('Clean up closed archives exactly what the page was shown, merged and test data only, and refuses once the queue has moved', async () => {
  world.queue = [item(MERGED, 'posted'), item(MERGED, 'expired', { expiredReason: 'MR merged' }), item(MERGED), item(CLOSED, 'discarded'), item(OPEN, 'posted'), item(UNASKED, 'posted'), item('acme/test!1', 'posted')];
  world.known = { [MERGED]: 'merged', [CLOSED]: 'closed' };
  const seen = queueCleanup().closed;
  await assert.rejects(act('archive-closed', {}), { status: 400 });
  world.queue.find((c) => c.status === 'pending' && c.iid === 1100).status = 'expired';
  await assert.rejects(act('archive-closed', { expect: seen }), { status: 409, message: /changed since you looked/ });
  assert.deepEqual(calls('archiveQueue'), [], 'nothing moved on a stale count');
  const now = queueCleanup().closed;
  assert.deepEqual({ items: now.items, mrs: now.mrs, test: now.test }, { items: 3, mrs: 1, test: 1 });
  const { text } = await act('archive-closed', { expect: now });
  assert.equal(text, 'Archived 3 items on 1 merged MR and 1 test item');
  assert.deepEqual(calls('archiveQueue').map(([, ids, why]) => [ids.length, why]), [[3, 'MR merged'], [1, 'test data']]);
  assert.deepEqual(world.queue.map((c) => `${c.projectPath}!${c.iid}`).sort(), [CLOSED, OPEN, UNASKED].sort(), 'an open MR, a closed one and one GitLab has not answered for keep theirs');
});

test('an MR group\'s Archive asks GitLab when its state is not known yet, and refuses an open MR or a moved count', async () => {
  world.queue = [item(UNASKED, 'posted'), item(UNASKED, 'discarded'), item(OPEN, 'posted')];
  const group = () => queueCleanup().groups.find((g) => g.key === UNASKED);
  await assert.rejects(act('archive-mr', { key: OPEN, expect: { items: 1, mark: 'x' } }), { status: 409, message: /engine!1121 is open/ });
  world.gitlab = { [UNASKED]: 'opened' };
  const { items, mark } = group();
  await assert.rejects(act('archive-mr', { key: UNASKED, expect: { items, mark } }), { status: 409, message: /has not said engine!1080 is merged or closed/ });
  world.gitlab = { [UNASKED]: 'down' };
  await assert.rejects(act('archive-mr', { key: UNASKED, expect: { items, mark } }), { status: 502, message: /GitLab GraphQL 502/ });
  await assert.rejects(act('archive-mr', { key: UNASKED, expect: { items: 3, mark } }), { status: 409 });
  world.gitlab = { [UNASKED]: 'merged' };
  const { text } = await act('archive-mr', { key: UNASKED, expect: { items, mark } });
  assert.equal(text, 'Archived 2 items on engine!1080');
  assert.deepEqual(calls('archiveQueue').map(([, ids, why]) => [ids.length, why]), [[2, 'MR merged']]);
  assert.deepEqual(idsOn(UNASKED), []);
});

test('the archive reads back a page at a time, newest first, and says how many there are', () => {
  world.archive = Array.from({ length: 30 }, (_, n) => ({ ...item(MERGED, 'posted'), body: 'archived ' + n, archivedAt: '2026-11-06T12:00:00Z', why: 'MR merged' }));
  const first = readArchive('0');
  assert.deepEqual([first.total, first.pageSize, first.items.length, first.items[0].body], [30, 25, 25, 'archived 29']);
  assert.deepEqual([first.items[0].why, first.items[0].key], ['MR merged', MERGED]);
  assert.equal(readArchive('1').items.length, 5);
  assert.equal(readArchive('not a page').page, 0);
});
