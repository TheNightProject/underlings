import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { act } from './actions.mjs';
import { loading, loadEngine, mrFor, refreshInbox } from './engine.mjs';
import { ROUTES } from './decide.mjs';
import { mr, reset, world } from './testkit.mjs';

const KEY = 'acme/engine!1121';
const OWN = 'acme/engine!1200';
const testkit = new URL('./testkit.mjs', import.meta.url).href;

// Stand-in engines that record what a verdict and a self-review were given: one current, with a GitLab that takes a moment to list, and one built before decide existed.
const START_REVIEW = `
export async function startReview(mr, launch, options) {
  world.calls.push(['startReview', mr.iid, launch, options]);
  return { alreadyWatched: false };
}`;
const STATE = `
import { fetchInbox as plainInbox, loadState as plainState } from '${testkit}';
export const peopleRules = () => ({ people: Object.entries(world.levels ?? {}).map(([username, level]) => ({ username, level })), onRequest: null, optedOut: new Set() });
export const levelForMr = (mr, me, rules) => rules.people.find((p) => p.username === mr.author)?.level ?? null;
export const loadState = () => ({ ...plainState(), verdicts: world.verdicts ?? {} });
export async function fetchInbox() {
  await new Promise((resolve) => setTimeout(resolve, 5));
  return plainInbox();
}`;
const DECIDE = `
export async function decide(mr, verdict, options) {
  world.calls.push(['decide', { projectId: mr.projectId, iid: mr.iid, repoLabel: mr.repoLabel, sha: mr.sha }, verdict, options]);
  return world.decision;
}`;
const dir = await mkdtemp(join(tmpdir(), 'control-centre-decide-'));
const enginePath = join(dir, 'engine.mjs');
const oldEnginePath = join(dir, 'old-engine.mjs');
const stub = (...calls) => `export * from '${testkit}';\nimport { world } from '${testkit}';\n${calls.join('\n')}\n`;
await writeFile(enginePath, stub(STATE, START_REVIEW, DECIDE));
await writeFile(oldEnginePath, stub(START_REVIEW));
await loadEngine({ matrixEngine: enginePath }, () => {});
after(() => rm(dir, { recursive: true }));

const writes = () => world.calls.filter(([name]) => name === 'decide' || name === 'startReview');

beforeEach(async () => {
  reset({
    mrs: [mr('acme/engine', 1121, { repoLabel: 'Engine' }), mr('acme/engine', 1200, { author: 'frank', reviewers: [] })],
    queue: [{ id: 'q1', status: 'posted', kind: 'finding', projectPath: 'acme/engine', iid: 1121 }],
    decision: { liftedHold: false, workspace: { closed: true } },
    verdicts: {},
  });
  await refreshInbox();
});

test('a verdict goes to the engine with the MR GitLab has now, not what the page sent', async () => {
  world.mrs[0] = { ...world.mrs[0], projectId: 99, repoLabel: 'engine' };
  const { text } = await act('decide', { key: KEY, verdict: 'approve', expect: { sha: 'aaa111' }, projectId: 1 });
  assert.deepEqual(writes(), [['decide', { projectId: 99, iid: 1121, repoLabel: 'Engine', sha: 'aaa111' }, 'approve', { me: 'frank' }]]);
  assert.equal(text, 'Approved acme/engine!1121, review workspace closed');
});

test('a head that moved since the page looked is refused, and nothing is written', async () => {
  world.mrs[0].sha = 'bbb222';
  await assert.rejects(act('decide', { key: KEY, verdict: 'approve', expect: { sha: 'aaa111' } }), { status: 409, message: `the head of ${KEY} changed since you looked` });
  assert.deepEqual(writes(), []);
});

test('findings queued since the page looked are refused, and nothing is written', async () => {
  world.queue.push({ id: 'q2', status: 'pending', kind: 'finding', projectPath: 'acme/engine', iid: 1121 });
  await assert.rejects(act('decide', { key: KEY, verdict: 'changes', expect: { sha: 'aaa111' } }), { status: 409, message: `1 more item was queued for ${KEY} since you looked` });
  assert.deepEqual(writes(), []);
});

test('a verdict sent without what the page saw, or of an unknown kind, is refused', async () => {
  await assert.rejects(act('decide', { key: KEY, verdict: 'approve' }), { status: 400 });
  await assert.rejects(act('decide', { key: KEY, verdict: 'merge', expect: { sha: 'aaa111' } }), { status: 400 });
  assert.deepEqual(writes(), []);
});

test('your own MR takes no verdict from you', async () => {
  await assert.rejects(act('decide', { key: OWN, verdict: 'approve', expect: { sha: 'aaa111' } }), { status: 403 });
  assert.deepEqual(writes(), []);
});

test('a workspace kept open, and a hold GitLab warned about, are both said', async () => {
  world.decision = { liftedHold: true, warning: 'Reviewer not found', workspace: { closed: false, kept: 'its agent is still working' } };
  const { text } = await act('decide', { key: KEY, verdict: 'changes', expect: { sha: 'aaa111' } });
  assert.equal(text, `Changes requested on ${KEY}, hold lifted. The review workspace stays open: its agent is still working. GitLab said: Reviewer not found`);
});

test('a self-review launches without a hold, and only on your own MR', async () => {
  const { text } = await act('review-own', { key: OWN });
  assert.deepEqual(writes(), [['startReview', 1200, undefined, { hold: false }]]);
  assert.match(text, /with no hold/);
  await assert.rejects(act('review-own', { key: KEY }), { status: 403 });
  assert.equal(writes().length, 1);
});

test('a self-review is refused while the last one is still launching, before Orca lists its terminal', async () => {
  world.runs[OWN] = { key: OWN, status: 'launching', startedAt: new Date().toISOString() };
  await assert.rejects(act('review-own', { key: OWN }), { status: 409, message: `an agent is already reading ${OWN}` });
  assert.deepEqual(writes(), []);
});

test('a refused moved head brings the new one into the list, so the next try with it goes through', async () => {
  while (loading()) await new Promise((resolve) => setTimeout(resolve, 1));
  world.mrs[0].sha = 'bbb222';
  await assert.rejects(act('decide', { key: KEY, verdict: 'approve', expect: { sha: 'aaa111' } }), { status: 409 });
  assert.equal(mrFor(KEY).sha, 'bbb222');
  await act('decide', { key: KEY, verdict: 'approve', expect: { sha: mrFor(KEY).sha } });
  assert.deepEqual(writes().map(([, mr]) => mr.sha), ['bbb222']);
});

test('the page learns whether a verdict closes the review workspace', () => {
  world.settings = { closeWorkspaceWhenDone: true };
  assert.equal(ROUTES['GET /api/matrix/decide']().tidies, true);
  world.settings = {};
  assert.equal(ROUTES['GET /api/matrix/decide']().tidies, false);
});

const settled = (id, status, postedAt, extra = {}) => ({ id, status, kind: 'finding', severity: 'MINOR', projectPath: 'acme/engine', iid: 1121, createdAt: '2026-11-05T08:00:00Z', postedAt, ...extra });

test('what went up since the last verdict is counted from the whole queue, however much other MRs have settled since', () => {
  world.verdicts = { [KEY]: { verdict: 'changes', at: '2026-11-05T10:00:00Z' } };
  world.queue = [
    settled('old', 'posted', '2026-11-05T09:00:00Z', { severity: 'MAJOR' }),
    settled('major', 'posted', '2026-11-05T10:05:00Z', { severity: 'MAJOR' }),
    settled('nit', 'posted', '2026-11-05T10:06:00Z', { severity: 'NIT' }),
    settled('reply', 'posted', '2026-11-05T10:07:00Z', { kind: 'reply', severity: undefined }),
    settled('legacy-reply', 'posted', '2026-11-05T10:08:00Z', { kind: undefined, replyTo: 'd1' }),
    settled('dropped', 'discarded', undefined, { createdAt: '2026-11-05T10:09:00Z' }),
    settled('verdict', 'posted', '2026-11-05T10:10:00Z', { kind: 'verdict' }),
    settled('waiting', 'pending', undefined, { createdAt: '2026-11-05T10:11:00Z' }),
    settled('merged', 'posted', '2026-11-05T10:12:00Z', { iid: 900 }),
    ...Array.from({ length: 80 }, (_, i) => settled('other' + i, 'posted', '2026-11-05T11:' + String(i % 60).padStart(2, '0') + ':00Z', { iid: 1200 })),
  ];
  const { mrs } = ROUTES['GET /api/matrix/decide']();
  assert.deepEqual(mrs[KEY], { posted: 4, dropped: 1, kinds: { MAJOR: 1, NIT: 1, reply: 2 }, lastPost: '2026-11-05T10:08:00Z' });
  assert.equal(mrs[OWN].posted, 80);
  assert.equal(mrs['acme/engine!900'], undefined, 'an MR no longer open is left out');
});

test('an MR with nothing posted since its verdict is left out', () => {
  world.verdicts = { [KEY]: { verdict: 'approved', at: '2026-11-05T12:00:00Z' } };
  world.queue = [settled('before', 'posted', '2026-11-05T11:00:00Z'), settled('dropped', 'discarded', undefined, { createdAt: '2026-11-05T12:30:00Z' })];
  assert.deepEqual(ROUTES['GET /api/matrix/decide']().mrs, {});
});

test('a shadow or held finding you posted yourself counts toward the card', () => {
  world.queue = [settled('shadow', 'posted', '2026-11-05T11:00:00Z', { auto: { pass: 'p1', level: 'shadow' } }), settled('held', 'posted', '2026-11-05T11:01:00Z', { auto: { pass: 'p1', level: 'comments', held: 'over the cap' } })];
  assert.equal(ROUTES['GET /api/matrix/decide']().mrs[KEY]?.posted, 2);
});

test('what full auto sent counts only where the author is at Comments, since at Comments + verdict it decides itself', () => {
  const auto = { pass: 'p1', level: 'comments', sentAuto: true };
  world.queue = [settled('sent', 'posted', '2026-11-05T11:00:00Z', { auto })];
  world.levels = { ivan: 'comments' };
  assert.equal(ROUTES['GET /api/matrix/decide']().mrs[KEY]?.posted, 1);
  world.levels = { ivan: 'verdict' };
  assert.equal(ROUTES['GET /api/matrix/decide']().mrs[KEY], undefined);
  world.levels = {};
});

test('what full auto sent or dropped on its own is not counted, so emptying a queue without you asks nothing', () => {
  const auto = { pass: 'p1', level: 'comments', sendAt: '2026-11-05T10:00:00Z', sentAuto: true };
  world.queue = [settled('sent', 'posted', '2026-11-05T11:00:00Z', { auto }), settled('dropped', 'discarded', undefined, { createdAt: '2026-11-05T11:30:00Z', auto })];
  assert.deepEqual(ROUTES['GET /api/matrix/decide']().mrs, {});
  world.queue.push(settled('yours', 'posted', '2026-11-05T11:40:00Z'));
  assert.deepEqual(ROUTES['GET /api/matrix/decide']().mrs[KEY], { posted: 1, dropped: 0, kinds: { MINOR: 1 }, lastPost: '2026-11-05T11:40:00Z' });
});

test('an engine built before verdicts answers 501, and a self-review, which it would hold, is never sent to it', async () => {
  await loadEngine({ matrixEngine: oldEnginePath }, () => {});
  try {
    await refreshInbox();
    await assert.rejects(act('decide', { key: KEY, verdict: 'approve', expect: { sha: 'aaa111' } }), { status: 501 });
    await assert.rejects(act('review-own', { key: OWN }), { status: 501 });
    assert.deepEqual(writes(), []);
  } finally {
    await loadEngine({ matrixEngine: enginePath }, () => {});
  }
});
