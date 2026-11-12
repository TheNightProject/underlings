import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { act } from './actions.mjs';
import { loadEngine, refreshInbox } from './engine.mjs';
import { readMatrix } from './matrix.mjs';
import { mr, reset, world } from './testkit.mjs';

const KEY = 'acme/engine!7';
const testkit = new URL('./testkit.mjs', import.meta.url).href;
const SENDS = `
export * from '${testkit}';
import { world } from '${testkit}';
export async function postOne(item) {
  world.calls.push(['postOne', item.id]);
  return world.outcome ?? { id: item.id, ok: true };
}
export async function postAll(mr) {
  world.calls.push(['postAll', mr.iid]);
  return { posted: 1, total: 1, liftedHold: false };
}
export function editQueued(id, body) {
  world.calls.push(['editQueued', id, body]);
  return unsent(id);
}
export function discard(id) {
  world.calls.push(['discard', id]);
  return unsent(id);
}
function unsent(id) {
  const item = world.queue.find((c) => c.id === id);
  if (world.claimedMeanwhile) item.sending = world.claimedMeanwhile;
  return !item.sending;
}
export async function startReview(mr) {
  world.calls.push(['startReview', mr.iid]);
  return { alreadyWatched: false };
}
export async function liftReviewHoldIfDone(mr, me) {
  world.calls.push(['liftReviewHoldIfDone', mr.iid, me]);
  return { liftedHold: !world.queue.some((c) => c.status === 'pending' && c.iid === mr.iid && c.id !== world.goingNow) };
}
export const findingPrint = (c) => 'print:' + c.body;
export const heldByMe = (mr, me) => (mr.reviewStates?.[me] ?? mr.mergeStatus) === 'REQUESTED_CHANGES';
export const changeSince = () => world.change;
export const autoLogRows = (queue) => queue.filter((c) => c.auto?.sentAuto).map((c) => ({ at: c.postedAt, key: 'acme/engine!7', mr: 'engine!7', what: 'MINOR', text: c.body }));
export const autoCounts = () => ({ sent: 1, waiting: 0, shadow: 2 });
`;
const dir = await mkdtemp(join(tmpdir(), 'control-centre-matrix-'));
await writeFile(join(dir, 'engine.mjs'), SENDS);
await loadEngine({ matrixEngine: join(dir, 'engine.mjs') }, () => {});
after(() => rm(dir, { recursive: true }));

const item = (id, extra = {}) => ({ id, status: 'pending', projectPath: 'acme/engine', projectId: 7, iid: 7, body: `finding ${id}`, severity: 'MINOR', createdBy: 'auto:p1', ...extra });
const auto = { pass: 'p1', level: 'comments', sendAt: '2026-11-06T10:02:00Z' };

beforeEach(async () => {
  reset({ mrs: [mr('acme/engine', 7)] });
  await refreshInbox();
  world.calls.length = 0;
});

test('the snapshot says who drives full auto', async () => {
  const m = await readMatrix();
  assert.equal('running' in m, false);
  assert.deepEqual(Object.keys(m.driver).sort(), ['busy', 'fix', 'holder', 'lastPollAt', 'nextPollAt', 'problems', 'recent', 'stateDir', 'state', 'why'].sort());
  assert.equal(m.driver.stateDir, '/state/thematrix');
  assert.deepEqual(m.autoCounts, { sent: 1, waiting: 0, shadow: 2 });
});

test('the snapshot names the Jira site, so the page can link a ticket key it only has as text', async () => {
  assert.equal((await readMatrix()).jiraSite, null);
  world.settings.jiraSite = 'acme.atlassian.net';
  assert.equal((await readMatrix()).jiraSite, 'acme.atlassian.net');
});

test('a queued item keeps its whole auto mark, its send claim and its edit mark, and the auto log comes with it', async () => {
  world.queue = [
    item('a', { auto: { ...auto, superseded: 'the head moved while it was being reviewed' }, sending: { by: 'auto:t1', at: '2026-11-06T10:03:00Z' }, editing: { by: 'thematrix:1', until: '2026-11-06T10:04:30Z' } }),
    item('b', { status: 'posted', postedAt: '2026-11-06T10:05:00Z', auto: { ...auto, sentAuto: true } }),
  ];
  const m = await readMatrix();
  const a = m.queue.find((q) => q.id === 'a');
  assert.deepEqual(a.auto, { ...auto, superseded: 'the head moved while it was being reviewed', held: null });
  assert.deepEqual([a.sending.by, a.editing.until], ['auto:t1', '2026-11-06T10:04:30Z']);
  assert.deepEqual(m.autoLog.map((r) => [r.key, r.text]), [[KEY, 'finding b']]);
});

test('runs come newest first and say whether their terminal is live and its agent working', async () => {
  world.terminals = [{ handle: 'term-live', agent: 'claude', connected: true, orphaned: false }, { handle: 'term-lost', agent: 'claude', connected: true, orphaned: true }];
  await refreshInbox();
  world.runs = {
    'acme/engine!7': { key: 'acme/engine!7', startedAt: '2026-11-06T10:00:00Z', status: 'working', terminal: 'term-live', tail: Array.from({ length: 50 }, (_, i) => `l${i}`) },
    'acme/engine!8': { key: 'acme/engine!8', startedAt: '2026-11-06T11:00:00Z', status: 'working', terminal: 'term-lost' },
    'ABC-12': { key: 'ABC-12', startedAt: '2026-11-06T09:00:00Z', status: 'ended', endedAt: '2026-11-06T09:30:00Z', terminal: 'term-gone', worktreePath: '/work/abc-12' },
  };
  const runs = (await readMatrix()).runs;
  assert.deepEqual(runs.map((r) => [r.key, r.live, r.working]), [['acme/engine!8', false, false], ['acme/engine!7', true, true], ['ABC-12', false, false]]);
  assert.equal(runs[1].tail.length, 30);
  assert.deepEqual([runs[2].endedAt, runs[2].worktreePath], ['2026-11-06T09:30:00Z', '/work/abc-12']);
});

test('a kickoff run says so, so the page can tell its agent from a ticket agent the TUI started', async () => {
  world.runs = {
    'ticket:ABC-12': { key: 'ticket:ABC-12', startedAt: '2026-11-06T10:00:00Z', status: 'running', terminal: 't-kick', kickoff: true },
    'ticket:ABC-13': { key: 'ticket:ABC-13', startedAt: '2026-11-06T09:00:00Z', status: 'running', terminal: 't-tui' },
  };
  assert.deepEqual((await readMatrix()).runs.map((r) => [r.key, r.kickoff]), [['ticket:ABC-12', true], ['ticket:ABC-13', false]]);
});

test('a pass carries its id and head, and reads reviewing, finishing or how it settled, newest first', async () => {
  const pass = (key, at, extra) => ({ key, pass: { id: `p-${key}`, key, author: 'ivan', sha: 'aaa111', trigger: 'new', launchedAt: at, ...extra } });
  world.memory = {
    a: pass('a', '2026-11-06T08:00:00Z', {}),
    b: pass('b', '2026-11-06T09:00:00Z', { doneAt: '2026-11-06T09:30:00Z' }),
    c: pass('c', '2026-11-06T10:00:00Z', { doneAt: '2026-11-06T10:30:00Z', settled: 'closed' }),
  };
  const passes = (await readMatrix()).autoPasses;
  assert.deepEqual(passes.map((p) => [p.key, p.id, p.sha, p.state]), [['c', 'p-c', 'aaa111', 'closed'], ['b', 'p-b', 'aaa111', 'finishing'], ['a', 'p-a', 'aaa111', 'reviewing']]);
});

test('Post on an item full auto is sending is a 409 that says so, and a GitLab failure is not taken for one', async () => {
  world.queue = [item('q1', { auto, sending: { by: 'auto:t1', at: '2026-11-06T10:03:00Z' } })];
  world.outcome = { id: 'q1', ok: false, error: 'already being sent' };
  await assert.rejects(act('post', { id: 'q1' }), { status: 409, message: 'full auto is sending this right now' });
  world.queue[0].sending = { by: 'manual:x', at: '2026-11-06T10:03:00Z' };
  await assert.rejects(act('post', { id: 'q1' }), { status: 409, message: 'this is being posted already' });
  world.outcome = { id: 'q1', ok: false, error: 'it is being edited' };
  await assert.rejects(act('post', { id: 'q1' }), { status: 409, message: 'it is being edited' });
  world.outcome = { id: 'q1', ok: false, error: 'it expired (MR merged)' };
  await assert.rejects(act('post', { id: 'q1' }), { status: 409, message: 'it expired (MR merged)' }, 'expired after the page last read it');
  world.outcome = { id: 'q1', ok: false, error: 'GitLab 500 Internal Server Error on /projects/7/merge_requests/7/discussions' };
  await assert.rejects(act('post', { id: 'q1' }), (err) => err.status === undefined && /GitLab 500/.test(err.message));
  world.queue[0].status = 'posted';
  await assert.rejects(act('post', { id: 'q1' }), { status: 409, message: 'that item is not waiting to be posted any more' });
});

test('Post all refuses while full auto is sending one of that MR\'s items, and posts nothing', async () => {
  world.queue = [item('q1', { sending: { by: 'auto:t1', at: '2026-11-06T10:03:00Z' } }), item('q2')];
  await assert.rejects(act('post-all', { key: KEY }), { status: 409, message: 'full auto is sending one of these right now' });
  assert.deepEqual(world.calls.filter(([name]) => name === 'postAll'), []);
  world.queue[0].sending = undefined;
  await act('post-all', { key: KEY });
  assert.deepEqual(world.calls.filter(([name]) => name === 'postAll'), [['postAll', 7]]);
});

test('saving an edit clears the mark the page set while it was open', async () => {
  world.queue = [item('q1', { editing: { by: `underlings:${process.pid}`, until: '2026-11-06T10:04:30Z' } })];
  await act('edit', { id: 'q1', body: 'better words' });
  assert.deepEqual(world.calls.filter(([name]) => name === 'editQueued' || name === 'setEditing'), [
    ['editQueued', 'q1', 'better words'],
    ['setEditing', 'q1', `underlings:${process.pid}`, null],
  ]);
  assert.equal(world.queue[0].editing, undefined);
});

test('Review is refused while full auto\'s own launch is still launching or newer than the terminal list, and the row says so', async () => {
  const later = (ms) => new Date(Date.now() + ms).toISOString();
  world.runs[KEY] = { key: KEY, status: 'launching', startedAt: later(0) };
  await assert.rejects(act('review', { key: KEY }), { status: 409, message: `an agent is already reading ${KEY}` });
  world.runs[KEY] = { key: KEY, status: 'working', startedAt: later(1000), terminal: 'term-new' };
  await assert.rejects(act('review', { key: KEY }), { status: 409 });
  assert.equal((await readMatrix()).inbox.rows[0].agentStarting, true);
  assert.deepEqual(world.calls.filter(([name]) => name === 'startReview'), []);
  world.runs[KEY] = { key: KEY, status: 'working', startedAt: '2026-11-01T09:00:00Z', terminal: 'term-gone' };
  assert.equal((await readMatrix()).inbox.rows[0].agentStarting, false);
  await act('review', { key: KEY });
  assert.deepEqual(world.calls.filter(([name]) => name === 'startReview'), [['startReview', 7]]);
});

test('Discard and Edit on an item being sent are a 409 that says who is sending it, and nothing is written', async () => {
  world.queue = [item('q1', { auto, sending: { by: 'auto:t1', at: '2026-11-06T10:03:00Z' } })];
  await assert.rejects(act('discard', { id: 'q1' }), { status: 409, message: 'full auto is sending this right now' });
  await assert.rejects(act('edit', { id: 'q1', body: 'rewritten' }), { status: 409, message: 'full auto is sending this right now' });
  assert.deepEqual(world.calls.filter(([name]) => name === 'discard' || name === 'editQueued'), []);
});

test('a send claimed between the first look and the write is still a 409, worded from the queue as it is then', async () => {
  world.claimedMeanwhile = { by: 'auto:t1', at: '2026-11-06T10:03:00Z' };
  for (const [name, payload] of [['discard', { id: 'q1' }], ['edit', { id: 'q1', body: 'rewritten' }]]) {
    world.queue = [item('q1')];
    await assert.rejects(act(name, payload), { status: 409, message: 'full auto is sending this right now' });
  }
  world.claimedMeanwhile = null;
  world.queue = [item('q1')];
  assert.equal((await act('discard', { id: 'q1' })).text, 'Discarded');
});

test('posting or discarding the last pending item asks the engine to lift your review hold, as Post all does', async () => {
  world.outcome = null;
  world.queue = [item('a', { createdBy: 'agent' })];
  world.goingNow = 'a';
  assert.equal((await act('post', { id: 'a' })).text, 'Posted, and your hold is lifted');
  world.queue = [item('a', { createdBy: 'agent' }), item('b', { createdBy: 'agent' })];
  world.goingNow = null;
  assert.equal((await act('discard', { id: 'b' })).text, 'Discarded');
  assert.deepEqual(world.calls.filter(([n]) => n === 'liftReviewHoldIfDone'), [['liftReviewHoldIfDone', 7, 'frank'], ['liftReviewHoldIfDone', 7, 'frank']], 'naming you, so only your own hold counts');
});

test('a held row says whether the hold is yours, going by your own reviewer state', async () => {
  world.rowFlags[KEY] = { held: true };
  world.mrs = [mr('acme/engine', 7, { mergeStatus: 'REQUESTED_CHANGES', reviewStates: { judy: 'REQUESTED_CHANGES', frank: 'REVIEWED' } })];
  await refreshInbox();
  assert.equal((await readMatrix()).inbox.rows[0].flags.heldByMe, false);
  world.mrs = [mr('acme/engine', 7, { mergeStatus: 'REQUESTED_CHANGES', reviewStates: { frank: 'REQUESTED_CHANGES' } })];
  await refreshInbox();
  assert.equal((await readMatrix()).inbox.rows[0].flags.heldByMe, true);
  world.rowFlags[KEY] = {};
  assert.equal((await readMatrix()).inbox.rows[0].flags.heldByMe, false, 'not held at all');
});

test('a row that moved since your review says what moved, with your own writes already left out by the engine', async () => {
  world.rowFlags[KEY] = { changed: true };
  world.watches[KEY] = { key: KEY, seen: { sha: 'old', pipeline: 'RUNNING', notes: 0, approvals: 0, unresolved: 3 } };
  world.change = { headMoved: true, notes: 0, resolved: 2, approvals: 0, pipeline: 'SUCCESS' };
  assert.equal((await readMatrix()).inbox.rows[0].movedWhy, 'new commits, 2 threads resolved, pipeline passed');
  world.rowFlags[KEY] = {};
  assert.equal((await readMatrix()).inbox.rows[0].movedWhy, null);
});

test('a row says when its MR was opened, so a card can show its age', async () => {
  assert.equal((await readMatrix()).inbox.rows[0].createdAt, '2026-11-01T09:00:00Z');
});

test('each queued item says whether it sends itself and carries its print', async () => {
  world.queue = [item('a', { auto }), item('b', { auto: { ...auto, level: 'shadow' } }), item('c', { auto: { ...auto, held: 'over the cap' } }), item('d', { createdBy: 'agent' })];
  const { queue } = await readMatrix();
  assert.deepEqual(queue.map((q) => [q.id, q.sendsItself]), [['a', true], ['b', false], ['c', false], ['d', false]]);
  assert.equal(queue[3].print, 'print:finding d');
});
