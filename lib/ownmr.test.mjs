import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { act } from './actions.mjs';
import { loadEngine, refreshInbox } from './engine.mjs';
import { readMrDetail } from './mrdetail.mjs';
import { mergeChoice, ROUTES, stop } from './ownmr.mjs';
import { mr, reset, world } from './testkit.mjs';

const OWN = 'acme/engine!88';
const THEIRS = 'acme/engine!1121';
const testkit = new URL('./testkit.mjs', import.meta.url).href;

// A stand-in engine that records every own-MR write it is asked for, and answers the reads the worker makes first.
const OWN_WRITES = `
import { world } from '${testkit}';
export * from '${testkit}';
export function typedUsername(text) {
  const name = text.trim().replace(/^@/, '').toLowerCase();
  return /^[a-z0-9][a-z0-9_.-]*$/.test(name) ? name : null;
}
export async function fetchMrDetail(projectId, iid) {
  world.calls.push(['fetchMrDetail', projectId, iid]);
  return { targetBranch: world.target, description: '', detailedMergeStatus: null, changesCount: '1', userNotesCount: 0 };
}
export async function fetchBranchFacts(projectId, iid) {
  world.calls.push(['fetchBranchFacts', projectId, iid]);
  return { targetBranch: world.target, behind: world.behind };
}
export async function rebaseMr(projectId, iid) { world.calls.push(['rebaseMr', projectId, iid]); world.rebasing = true; }
export async function rebaseState(projectId, iid) { world.calls.push(['rebaseState', projectId, iid]); return { inProgress: world.rebasing, error: world.mergeError ?? null }; }
export async function setDraft(...args) { world.calls.push(['setDraft', ...args]); return { draft: false }; }
export async function mergeMr(projectId, iid, how) { world.calls.push(['mergeMr', projectId, iid, how]); return world.mergeOutcome; }
export async function setReviewers(projectId, iid, names) { world.calls.push(['setReviewers', projectId, iid, names]); return names; }
export async function rerequestReview(...args) { world.calls.push(['rerequestReview', ...args]); }
export async function cancelAutoMerge(projectId, iid) { world.calls.push(['cancelAutoMerge', projectId, iid]); }
export async function fixRunAlive(key) { world.calls.push(['fixRunAlive', key]); await world.aliveGate; return Boolean(world.fixAlive); }
export const isBotThread = (d) => /-bot$/.test(d.notes[0]?.author ?? '');
export const fixableThreads = (ds, me) => ds.filter((d) => d.resolvable !== false && !d.resolved && !isBotThread(d) && !(me && d.notes.at(-1)?.author === me));
export async function launchFix(mr, threads, options) {
  world.calls.push(['launchFix', { projectId: mr.projectId, iid: mr.iid, sha: mr.sha }, threads.map((t) => t.id), options]);
  return { how: 'worktree', handle: 'term_fix', name: 'fix-engine-88' };
}
`;
const dir = await mkdtemp(join(tmpdir(), 'control-centre-ownmr-'));
const enginePath = join(dir, 'engine.mjs');
await writeFile(enginePath, OWN_WRITES);
await loadEngine({ matrixEngine: enginePath }, () => {});
after(() => rm(dir, { recursive: true }));

const WRITES = new Set(['rebaseMr', 'setDraft', 'mergeMr', 'setReviewers', 'rerequestReview', 'launchFix', 'cancelAutoMerge']);
const writes = () => world.calls.filter(([name]) => WRITES.has(name));
const note = (author, body = 'Please change this') => ({ author, body, createdAt: '2026-11-05T10:00:00Z', system: false });

beforeEach(async () => {
  stop();
  reset({
    mrs: [mr('acme/engine', 1121), mr('acme/engine', 88, { author: 'frank', reviewers: ['ivan', 'Ed'], unresolvedThreads: 3 })],
    mergeOutcome: { merged: true, autoMerge: false },
    rebasing: false,
    mergeError: null,
    fixAlive: false,
    target: 'main',
    behind: 0,
  });
  world.discussions[88] = [
    { id: 'd-2', resolved: false, resolvable: true, notes: [note('ivan'), note('frank', 'Why?'), note('ivan', 'It reads as a verb')] },
    { id: 'd-1', resolved: false, resolvable: true, position: { new_path: 'src/app.py', new_line: 3 }, notes: [note('ed')] },
    { id: 'd-bot', resolved: false, resolvable: true, notes: [note('acme-review-bot', 'Summary')] },
    { id: 'd-done', resolved: true, resolvable: true, notes: [note('ivan')] },
  ];
  await refreshInbox();
  world.calls.length = 0;
});
afterEach(() => mock.timers.reset());

const SEEN = { sha: 'aaa111' };
const PAYLOADS = {
  rebase: () => ({ expect: SEEN }),
  ready: () => ({ expect: SEEN }),
  merge: () => ({ expect: { ...SEEN, can: 'now', target: 'main' } }),
  reviewers: () => ({ reviewers: ['ivan', 'ed', 'rupert'], expect: { ...SEEN, reviewers: ['ivan', 'Ed'] } }),
  rerequest: () => ({ reviewers: ['ivan'], expect: SEEN }),
  fix: () => ({ expect: { ...SEEN, threads: { 'd-1': 1, 'd-2': 3 } } }),
};
const own = (name, extra = {}) => act(name, { key: OWN, ...PAYLOADS[name](), ...extra });

test('every own-MR action refuses an MR you did not write, and writes nothing', async () => {
  for (const name of Object.keys(PAYLOADS)) {
    await assert.rejects(act(name, { key: THEIRS, ...PAYLOADS[name]() }), { status: 403, message: `${THEIRS} is ivan's MR, not yours` }, name);
  }
  assert.deepEqual(writes(), []);
});

test('the author is the one GitLab has now, not the one the list saw', async () => {
  world.mrs[1] = { ...world.mrs[1], author: 'ivan' };
  for (const name of Object.keys(PAYLOADS)) await assert.rejects(own(name), { status: 403 }, name);
  assert.deepEqual(writes(), []);
});

test('every own-MR action refuses with 409 once the head has moved, and writes nothing', async () => {
  world.mrs[1] = { ...world.mrs[1], sha: 'bbb222', draft: true };
  for (const name of Object.keys(PAYLOADS)) {
    await assert.rejects(own(name), { status: 409, message: `the head of ${OWN} changed since you looked` }, name);
  }
  assert.deepEqual(writes(), []);
});

test('an action that does not say which head the page saw is refused', async () => {
  for (const name of Object.keys(PAYLOADS)) await assert.rejects(own(name, { expect: undefined }), { status: 400 }, name);
  assert.deepEqual(writes(), []);
});

test('a merge passes the head the page saw through to GitLab, so GitLab refuses a branch that moved after the check', async () => {
  const { text } = await own('merge');
  assert.deepEqual(writes(), [['mergeMr', 7, 88, { sha: 'aaa111', whenGreen: false }]]);
  assert.equal(text, `Merged ${OWN}`);
});

test('merge when green asks GitLab to wait for the pipeline, and says so', async () => {
  world.mrs[1] = { ...world.mrs[1], mergeStatus: 'CI_STILL_RUNNING', pipeline: 'RUNNING' };
  world.mergeOutcome = { merged: false, autoMerge: true };
  const { text } = await own('merge', { expect: { ...SEEN, can: 'green', target: 'main' } });
  assert.deepEqual(writes(), [['mergeMr', 7, 88, { sha: 'aaa111', whenGreen: true }]]);
  assert.equal(text, `${OWN} merges once its pipeline passes`);
});

test('a merge is refused when GitLab no longer allows the merge the page offered', async () => {
  world.mrs[1] = { ...world.mrs[1], mergeStatus: 'DISCUSSIONS_NOT_RESOLVED' };
  await assert.rejects(own('merge'), { status: 409, message: `the merge status of ${OWN} changed since you looked: blocked: unresolved threads` });
  world.mrs[1] = { ...world.mrs[1], mergeStatus: 'MERGEABLE' };
  await assert.rejects(own('merge', { expect: { ...SEEN, can: 'green', target: 'main' } }), { status: 409 });
  await assert.rejects(own('merge', { expect: { ...SEEN, can: 'later', target: 'main' } }), { status: 400 });
  assert.deepEqual(writes(), []);
});

test('merging is offered now when GitLab says mergeable, and when green whenever GitLab would wait', () => {
  const choice = (mergeStatus, pipeline = 'SUCCESS', extra = {}) => mergeChoice({ mergeStatus, pipeline, ...extra });
  assert.deepEqual(choice('MERGEABLE'), { status: 'mergeable', words: 'ready to merge', tone: 'ready', can: 'now', autoMerge: false });
  assert.equal(choice('CI_STILL_RUNNING', 'RUNNING').can, 'green');
  assert.equal(choice('CI_MUST_PASS', 'PENDING').can, 'green');
  assert.equal(choice('CI_MUST_PASS', 'FAILED').can, null, 'a failed pipeline will not pass by waiting');
  for (const status of ['NOT_APPROVED', 'DISCUSSIONS_NOT_RESOLVED', 'APPROVALS_SYNCING']) assert.equal(choice(status).can, 'green', status);
  assert.equal(choice('NOT_APPROVED', 'SUCCESS', { draft: true }).can, null, 'never on a draft');
  assert.equal(choice('NOT_APPROVED', 'SUCCESS', { conflicts: true }).can, null, 'never over a conflict');
  assert.equal(choice('CONFLICT').can, null);
  assert.equal(choice(null).can, null);
  assert.equal(choice('NOT_APPROVED', 'SUCCESS', { autoMerge: true }).autoMerge, true, 'and the page learns it is set');
});

test('the page learns each of your MRs\' merge state, target branch and how far behind it is, read again with each list fetch', async () => {
  world.mrs.push(mr('acme/engine', 89, { author: 'frank', mergeStatus: 'NOT_APPROVED' }));
  world.behind = 54;
  await refreshInbox();
  world.calls.length = 0;
  const first = await ROUTES['GET /api/matrix/own-mrs']();
  assert.deepEqual(Object.keys(first.mrs).sort(), [OWN, 'acme/engine!89']);
  assert.deepEqual(first.mrs[OWN], { merge: { status: 'mergeable', words: 'ready to merge', tone: 'ready', can: 'now', autoMerge: false }, target: 'main', behind: 54, rebase: null });
  assert.deepEqual([first.mrs['acme/engine!89'].target, first.mrs['acme/engine!89'].behind], ['main', 54]);
  await ROUTES['GET /api/matrix/own-mrs']();
  assert.equal(world.calls.filter(([name]) => name === 'fetchBranchFacts').length, 2, 'once per MR until the list is fetched again');
  world.target = 'feat/base';
  world.behind = 0;
  await refreshInbox();
  const after = await ROUTES['GET /api/matrix/own-mrs']();
  assert.deepEqual([after.mrs[OWN].target, after.mrs[OWN].behind], ['feat/base', 0], 'a retarget shows though the head did not move');
});

test('a merge is refused once GitLab targets another branch than the one the page named', async () => {
  world.target = 'feat/base';
  await assert.rejects(own('merge'), { status: 409, message: `the target branch of ${OWN} changed since you looked` });
  await assert.rejects(own('merge', { expect: { ...SEEN, can: 'now' } }), { status: 400 });
  assert.deepEqual(writes(), []);
  await own('merge', { expect: { ...SEEN, can: 'now', target: 'feat/base' } });
  assert.equal(writes().length, 1);
});

test('rebase and merge are refused while a fix agent is open on the MR, and a fix while GitLab is rebasing it', async () => {
  world.fixAlive = true;
  const open = `a fix agent is still open on ${OWN}, so answer it in its Agent tab, or remove it under Agents`;
  await assert.rejects(own('rebase'), { status: 409, message: open });
  await assert.rejects(own('merge'), { status: 409, message: open });
  world.fixAlive = false;
  mock.timers.enable({ apis: ['setTimeout'] });
  await own('rebase');
  await assert.rejects(own('fix'), { status: 409, message: `GitLab is still rebasing ${OWN}` });
  await assert.rejects(own('merge'), { status: 409, message: `GitLab is still rebasing ${OWN}` });
  assert.deepEqual(writes(), [['rebaseMr', 7, 88]]);
});

test('a rebase is refused over conflicts, since GitLab cannot do one', async () => {
  world.mrs[1] = { ...world.mrs[1], conflicts: true };
  await assert.rejects(own('rebase'), { status: 409, message: `GitLab cannot rebase ${OWN} over its conflicts, so fix them with an agent` });
  assert.deepEqual(writes(), []);
});

test('while one fix is still being checked, a second fix, a rebase or a merge of the same MR is refused, and one agent starts', async () => {
  let release = () => {};
  world.aliveGate = new Promise((resolve) => { release = resolve; });
  const first = own('fix');
  await flush();
  const others = ['fix', 'rebase', 'merge'].map((name) => own(name).then(() => `${name} went ahead`, (err) => err.message));
  await flush();
  release();
  await first;
  assert.deepEqual(await Promise.all(others), Array(3).fill(`${OWN} is busy starting a fix agent`));
  assert.deepEqual(writes().map(([name]) => name), ['launchFix']);
  world.aliveGate = null;
  world.fixAlive = false;
  await own('rebase');
  assert.deepEqual(writes().map(([name]) => name), ['launchFix', 'rebaseMr'], 'and the MR is free again once it has started');
});

test('a refused fix frees the MR for the next action', async () => {
  world.fixAlive = true;
  await assert.rejects(own('fix'), { status: 409 });
  world.fixAlive = false;
  await own('fix');
  assert.deepEqual(writes().map(([name]) => name), ['launchFix']);
});

const flush = async () => {
  for (let i = 0; i < 10; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

test('a rebase is started, shows as running until GitLab finishes, and the list is read again once the head has moved', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  const { text } = await own('rebase');
  assert.equal(text, `GitLab is rebasing ${OWN}`);
  assert.deepEqual(writes(), [['rebaseMr', 7, 88]]);
  const shown = async () => (await ROUTES['GET /api/matrix/own-mrs']()).mrs[OWN].rebase;
  assert.equal((await shown()).state, 'running');
  await assert.rejects(own('rebase'), { status: 409, message: `GitLab is still rebasing ${OWN}` });
  mock.timers.tick(2000);
  await flush();
  assert.equal((await shown()).state, 'running', 'still in progress on the first look');
  world.rebasing = false;
  world.mrs[1] = { ...world.mrs[1], sha: 'ccc333' };
  world.mergeError = 'an old merge error GitLab kept';
  world.calls.length = 0;
  mock.timers.tick(2000);
  await flush();
  assert.equal(await shown(), null);
  assert.ok(world.calls.some(([name]) => name === 'fetchInbox'), 'the list is read again');
});

test('a rebase GitLab could not do says why, and another can be started', async () => {
  mock.timers.enable({ apis: ['setTimeout'] });
  await own('rebase');
  world.rebasing = false;
  world.mergeError = 'Rebase failed: Rebase locally, resolve all conflicts, then push the branch.';
  mock.timers.tick(2000);
  await flush();
  const { rebase } = (await ROUTES['GET /api/matrix/own-mrs']()).mrs[OWN];
  assert.deepEqual([rebase.state, rebase.error], ['failed', world.mergeError]);
  await own('rebase');
  assert.equal(writes().length, 2);
});

test('mark ready takes the draft flag off a draft, and refuses an MR that is no longer one', async () => {
  world.mrs[1] = { ...world.mrs[1], draft: true };
  assert.equal((await own('ready')).text, `Marked ${OWN} ready`);
  assert.deepEqual(writes(), [['setDraft', 'acme/engine', 88, false]]);
  world.mrs[1] = { ...world.mrs[1], draft: false };
  await assert.rejects(own('ready'), { status: 409, message: `${OWN} is not a draft any more` });
  assert.equal(writes().length, 1);
});

test('reviewers are replaced with the names picked, and refused when someone else changed them first', async () => {
  const { text } = await own('reviewers');
  assert.deepEqual(writes(), [['setReviewers', 7, 88, ['ivan', 'ed', 'rupert']]]);
  assert.equal(text, `Reviewers on ${OWN}: ivan, ed, rupert`);
  world.mrs[1] = { ...world.mrs[1], reviewers: ['ivan'] };
  await assert.rejects(own('reviewers'), { status: 409, message: `the reviewers of ${OWN} changed since you looked` });
  await assert.rejects(own('reviewers', { reviewers: ['ivan'], expect: { ...SEEN, reviewers: ['ivan'] } }), { status: 400 });
  for (const reviewers of [['not a name'], 'ivan', [42], Array(21).fill('ivan')]) {
    await assert.rejects(own('reviewers', { reviewers, expect: { ...SEEN, reviewers: ['ivan'] } }), { status: 400 }, JSON.stringify(reviewers));
  }
  assert.equal(writes().length, 1);
});

test('a review is asked for again only of current reviewers, under the name GitLab knows them by', async () => {
  const { text } = await own('rerequest', { reviewers: ['ivan', 'ed'] });
  assert.deepEqual(writes(), [['rerequestReview', 'acme/engine', 88, 'ivan'], ['rerequestReview', 'acme/engine', 88, 'Ed']]);
  assert.equal(text, `Asked ivan, Ed to review ${OWN} again`);
  await assert.rejects(own('rerequest', { reviewers: ['rupert'] }), { status: 409, message: `rupert is not a reviewer of ${OWN} any more` });
  await assert.rejects(own('rerequest', { reviewers: [] }), { status: 400 });
  assert.equal(writes().length, 2);
});

test('a fix launches an agent on the MR GitLab has now, with the open threads people started and none from bots', async () => {
  world.mrs[1] = { ...world.mrs[1], projectId: 99 };
  const { text } = await own('fix', { projectId: 1, iid: 5 });
  assert.deepEqual(writes(), [['launchFix', { projectId: 99, iid: 88, sha: 'aaa111' }, ['d-2', 'd-1'], { me: 'frank', head: 'aaa111', targetBranch: 'main', conflicts: false }]]);
  assert.equal(text, `An agent is fixing 2 comments on ${OWN} in fix-engine-88. It asks you before it pushes or replies.`);
});

test('a thread you answered last waits on its reviewer, so a sweep leaves it out and counts without it', async () => {
  world.discussions[88][0].notes.push(note('frank', 'Renamed it'));
  await assert.rejects(own('fix'), { status: 409, message: `the threads on ${OWN} changed since you looked` });
  await own('fix', { expect: { ...SEEN, threads: { 'd-1': 1 } } });
  assert.deepEqual(writes().map(([, , threads]) => threads), [['d-1']]);
});

test('fixing one thread sends only that thread, a bot\'s included', async () => {
  await own('fix', { discussionId: 'd-bot', expect: { ...SEEN, threads: { 'd-bot': 1 } } });
  assert.deepEqual(writes()[0][2], ['d-bot']);
  const { text } = await own('fix', { discussionId: 'd-1', expect: { ...SEEN, threads: { 'd-1': 1 } } });
  assert.match(text, /fixing 1 comment on/);
});

test('a fix is refused while a fix agent for the MR is still open, and nothing launches', async () => {
  world.fixAlive = true;
  await assert.rejects(own('fix'), { status: 409, message: `a fix agent is still open on ${OWN}, so answer it in its Agent tab, or remove it under Agents` });
  assert.deepEqual(writes(), []);
});

test('fixing the conflicts launches an agent with no threads, and only while GitLab still reports conflicts', async () => {
  await assert.rejects(own('fix', { conflicts: true, expect: SEEN }), { status: 409, message: `GitLab reports no conflicts on ${OWN} any more` });
  await assert.rejects(own('fix', { conflicts: 'yes', expect: SEEN }), { status: 400 });
  await assert.rejects(own('fix', { conflicts: true, discussionId: 'd-1', expect: SEEN }), { status: 400 });
  assert.deepEqual(writes(), []);
  world.mrs[1] = { ...world.mrs[1], conflicts: true };
  world.target = 'feat/base';
  const { text } = await own('fix', { conflicts: true, expect: SEEN });
  assert.deepEqual(writes(), [['launchFix', { projectId: 7, iid: 88, sha: 'aaa111' }, [], { me: 'frank', head: 'aaa111', targetBranch: 'feat/base', conflicts: true }]]);
  assert.equal(text, `An agent is fixing the conflicts on ${OWN} in fix-engine-88. It asks you before it pushes.`);
});

test('a fix is refused when the threads moved since the page counted them', async () => {
  world.discussions[88][1].notes.push(note('ed', 'And this'));
  await assert.rejects(own('fix'), { status: 409, message: `the threads on ${OWN} changed since you looked` });
  world.discussions[88][1].notes.pop();
  world.discussions[88].push({ id: 'd-new', resolved: false, resolvable: true, notes: [note('rupert')] });
  await assert.rejects(own('fix'), { status: 409 });
  world.discussions[88].pop();
  world.discussions[88][0].resolved = true;
  await assert.rejects(own('fix'), { status: 409 });
  await assert.rejects(own('fix', { discussionId: 'd-done', expect: { ...SEEN, threads: { 'd-done': 1 } } }), { status: 409 });
  await assert.rejects(own('fix', { expect: SEEN }), { status: 400 });
  assert.deepEqual(writes(), []);
});

test("the drawer's threads say which ones a bot started, as the engine judges it", async () => {
  const { discussions } = await readMrDetail(OWN);
  assert.deepEqual(discussions.map((d) => [d.id, d.bot]), [['d-2', false], ['d-1', false], ['d-bot', true], ['d-done', false]]);
});

test('an engine built before own-MR writes answers 501, so the page can offer a rebuild, and the merge facts still read', async () => {
  await loadEngine({ matrixEngine: fileURLToPath(testkit) }, () => {});
  try {
    await refreshInbox();
    for (const name of Object.keys(PAYLOADS)) await assert.rejects(own(name), { status: 501 }, name);
    const { mrs } = await ROUTES['GET /api/matrix/own-mrs']();
    assert.deepEqual([mrs[OWN].merge.can, mrs[OWN].target, mrs[OWN].behind], ['now', null, null]);
  } finally {
    await loadEngine({ matrixEngine: enginePath }, () => {});
  }
});

test('cancelling merge when green refuses someone else\'s MR, and one GitLab no longer has set to merge', async () => {
  await assert.rejects(act('cancel-merge', { key: THEIRS, expect: SEEN }), { status: 403 });
  await assert.rejects(act('cancel-merge', { key: OWN, expect: SEEN }), { status: 409, message: `${OWN} is not set to merge when green any more` });
  assert.deepEqual(writes(), []);
  world.mrs[1] = { ...world.mrs[1], autoMerge: true };
  await assert.rejects(act('cancel-merge', { key: OWN, expect: { sha: 'moved' } }), { status: 409 });
  const { text } = await act('cancel-merge', { key: OWN, expect: SEEN });
  assert.equal(text, `${OWN} no longer merges when green`);
  assert.deepEqual(writes(), [['cancelAutoMerge', 7, 88]]);
});
