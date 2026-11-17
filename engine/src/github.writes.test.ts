import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { githubHarness } from './fixtures/github/harness.mjs';
import { githubWorld } from './fixtures/github/world.mjs';

const h = githubHarness();
process.env['GITHUB_TOKEN'] = 'ghp_0123456789abcdefghijklmnopqrstuv';

const { addToQueue, changeSettings, loadQueue, loadState, mutateState, noteOwnActivity, saveQueue } = await import('./data/store.js');
const { forgeOf } = await import('./data/forge.js');
const { resetGithubLimits, forgetGithubToken } = await import('./data/github.js');
const { postAllFor, postOne } = await import('./actions/post.js');
const { toggleWatch } = await import('./actions/watch.js');
const { setApproved, setHeld } = await import('./commands.js');
const { decide, CHANGES_NOTE } = await import('./verdict.js');
const { queueInput } = await import('./queueinput.js');
const { mr: gitlabMr } = await import('./auto/testkit.js');
const { DEFAULT_GITHUB } = await import('./settings.js');
const { HOLD_NOTE } = await import('./wording.js');
const { RELEASE_NOTE_BARE } = await import('./config.js');

type World = ReturnType<typeof githubWorld>;
type Pr = World['prs'][number];

const HEAD = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0';
const PATH = 'acme-co/web';
const WEB12 = { provider: 'github' as const, projectPath: PATH, projectId: 501, iid: 12 };
const forge = () => forgeOf(WEB12);
const pr12 = (): Pr => h.world.prs.find((p: Pr) => p.number === 12)!;
const writes = () => h.fake.requests.filter((r) => r.method !== 'GET' && !(r.path === '/graphql' && !/^\s*mutation/.test(r.body?.query ?? '')));
const sent = () => writes().map((r) => (r.op ? `${r.op}` : `${r.method} ${r.path}`));
const live = async () => (await forge().one(WEB12))!;

after(() => h.done());
beforeEach(() => {
  Object.assign(h.world, githubWorld());
  h.fake.requests.length = 0;
  resetGithubLimits();
  forgetGithubToken();
  changeSettings((s) => ({ ...s, github: { ...DEFAULT_GITHUB, on: true } }));
  saveQueue([]);
  mutateState((s) => {
    s.watches = {};
    delete s.verdicts;
  });
});

const finding = (over: Record<string, unknown> = {}) => addToQueue([queueInput({ provider: 'github', projectPath: PATH, iid: 12, webUrl: 'https://github.com/acme-co/web/pull/12', severity: 'MAJOR', body: 'MAJOR: the cache never expires.', ...over }, 0)])[0]!;

test('a finding on a line opens a thread on that line of the head, and the queue keeps the thread it opened', async () => {
  const item = finding({ position: { new_path: 'src/token.ts', new_line: 12, base_sha: 'x', start_sha: 'x', head_sha: 'old' } });
  assert.deepEqual(await postOne(item), { id: item.id, ok: true });
  const [posted] = writes();
  assert.deepEqual([posted!.method, posted!.path], ['POST', '/repos/acme-co/web/pulls/12/comments']);
  assert.deepEqual({ ...posted!.body, body: undefined }, { body: undefined, commit_id: HEAD, path: 'src/token.ts', line: 12, side: 'RIGHT' });
  assert.match(posted!.body.body, /^\*\*MAJOR\*\* the cache never expires\.\n\n_Found with Claude's assistance/);
  const thread = pr12().threads.at(-1)!;
  assert.equal(loadQueue()[0]!.discussionId, thread.id);
  assert.equal(loadQueue()[0]!.status, 'posted');
  assert.ok((await forge().discussions(WEB12)).some((d) => d.id === thread.id && d.resolvable && !d.resolved));
});

test('a line only the old side has goes on the left, and a line the diff no longer shows goes on the conversation with where it was', async () => {
  await postOne(finding({ position: { old_path: 'src/token.ts', old_line: 11, base_sha: 'x', start_sha: 'x', head_sha: 'x' } }));
  assert.deepEqual([writes()[0]!.body.line, writes()[0]!.body.side], [11, 'LEFT']);
  h.fake.requests.length = 0;
  const gone = finding({ position: { new_path: 'src/token.ts', new_line: 40, base_sha: 'x', start_sha: 'x', head_sha: 'x' } });
  await postOne(gone);
  assert.deepEqual(sent(), ['POST /repos/acme-co/web/issues/12/comments']);
  assert.match(writes()[0]!.body.body, /^`src\/token\.ts:40`\n\n\*\*MAJOR\*\* /);
  assert.match(loadQueue().find((c) => c.id === gone.id)!.discussionId!, /^comment-\d+$/);
});

test('a finding on the change as a whole is a comment on the conversation, and a file too big to show has no line to go on', async () => {
  await postOne(finding());
  await postOne(finding({ position: { new_path: 'dist/bundle.js', new_line: 1, base_sha: 'x', start_sha: 'x', head_sha: 'x' } }));
  assert.deepEqual(sent(), ['POST /repos/acme-co/web/issues/12/comments', 'POST /repos/acme-co/web/issues/12/comments']);
  assert.equal(pr12().comments.length, 3);
});

test('posting everything on a pull request leaves a GitLab merge request of the same path and number alone', async () => {
  finding();
  addToQueue([queueInput({ projectPath: PATH, projectId: 77, iid: 12, webUrl: 'https://gitlab.example/acme-co/web/-/merge_requests/12', severity: 'MINOR', body: 'MINOR: gitlab' }, 0)]);
  const results = await postAllFor(WEB12);
  assert.equal(results.length, 1);
  assert.deepEqual(loadQueue().map((c) => [c.provider ?? 'gitlab', c.status]), [['github', 'posted'], ['gitlab', 'pending']]);
});

test('a reply goes on its thread, a reply to a plain comment is a comment of its own, and resolving is GitHub\'s own on threads only', async () => {
  await forge().reply(WEB12, 'PRRT_kwDOAA', 'Fixed in abc123.');
  await forge().reply(WEB12, 'comment-501', 'Thanks.');
  await forge().resolve(WEB12, 'PRRT_kwDOAA', true);
  assert.deepEqual(sent(), ['PrReply', 'POST /repos/acme-co/web/issues/12/comments', 'PrResolve']);
  assert.deepEqual(writes()[0]!.body.variables, { thread: 'PRRT_kwDOAA', body: 'Fixed in abc123.' });
  const thread = pr12().threads[0]!;
  assert.deepEqual([thread.isResolved, thread.comments.at(-1)!.body], [true, 'Fixed in abc123.']);
  await forge().resolve(WEB12, 'PRRT_kwDOAA', false);
  assert.equal(pr12().threads[0]!.isResolved, false);
  const before = h.fake.count();
  await assert.rejects(forge().resolve(WEB12, 'review-301', true), { message: 'GitHub resolves only a thread on a line, not a plain comment' });
  assert.equal(h.fake.count(), before);
});

test('a mutation GitHub refuses fails, though GitHub answers it with data', async () => {
  await assert.rejects(forge().reply(WEB12, 'PRRT_gone', 'hello'), /^Error: GitHub GraphQL: Could not resolve to a node with the global id of 'PRRT_gone'$/);
});

test('approving is an approving review, and taking it back dismisses that review with the reason', async () => {
  const { liftedHold } = await setApproved(await live(), true);
  assert.equal(liftedHold, false);
  assert.deepEqual(writes()[0]!.body, { event: 'APPROVE' });
  assert.deepEqual((await live()).approvedBy, ['frank-gh']);
  await setApproved(await live(), false);
  const review = pr12().reviews.at(-1)!;
  assert.deepEqual([review.state, review.dismissal], ['DISMISSED', 'Approval withdrawn.']);
  assert.deepEqual((await live()).approvedBy, []);
  await assert.rejects(setApproved(await live(), false), { message: 'you have no approval on acme-co/web#12 to take back' });
});

test('a hold is a review that requests changes with the reason in it, so nothing else is posted, and lifting it dismisses that review', async () => {
  await setHeld(await live(), true);
  assert.deepEqual(sent(), ['POST /repos/acme-co/web/pulls/12/reviews']);
  assert.deepEqual(writes()[0]!.body, { event: 'REQUEST_CHANGES', body: HOLD_NOTE });
  const held = await live();
  assert.deepEqual([held.mergeStatus, held.reviewStates?.['frank-gh']], ['REQUESTED_CHANGES', 'REQUESTED_CHANGES']);
  h.fake.requests.length = 0;
  await setHeld(held, false);
  assert.deepEqual(sent(), [`PUT /repos/acme-co/web/pulls/12/reviews/${pr12().reviews.at(-1)!.id}/dismissals`]);
  assert.deepEqual([pr12().reviews.at(-1)!.state, pr12().reviews.at(-1)!.dismissal], ['DISMISSED', RELEASE_NOTE_BARE]);
  assert.equal((await live()).mergeStatus, 'NOT_APPROVED');
});

test('approving over your own hold lifts it as GitHub does, without dismissing anything or saying it twice', async () => {
  await setHeld(await live(), true);
  h.fake.requests.length = 0;
  assert.deepEqual(await setApproved(await live(), true), { liftedHold: true });
  assert.deepEqual(sent(), ['POST /repos/acme-co/web/pulls/12/reviews']);
  assert.equal((await live()).reviewStates?.['frank-gh'], 'APPROVED');
});

test('a pull request you have reviewed stays in the list once GitHub takes the request for your review away', async () => {
  await forge().approve(WEB12, true);
  assert.deepEqual(pr12().requested, []);
  const listed = (await forge().listOpen([])).mrs.find((m) => m.iid === 12 && m.projectPath === 'acme-co/web');
  assert.ok(listed?.reviewers.includes('frank-gh'));
});

test('requesting changes as a verdict is one review that says why', async () => {
  await decide(await live(), 'changes');
  assert.deepEqual(writes().map((r) => r.body), [{ event: 'REQUEST_CHANGES', body: CHANGES_NOTE }]);
});

test('GitHub\'s refusal of a review on your own pull request is said in its words', async () => {
  const mine = { ...WEB12, iid: 15 };
  await assert.rejects(forgeOf(mine).approve(mine, true), /^Error: GitHub 422 .*Unprocessable Entity/);
});

test('the engine\'s own writes are noted on the watched pull request, never on a GitLab merge request with the same numbers', async () => {
  toggleWatch(await live());
  toggleWatch(gitlabMr({ projectPath: 'acme/web', projectId: 501, iid: 12 }));
  await postOne(finding({ position: { new_path: 'src/token.ts', new_line: 12, base_sha: 'x', start_sha: 'x', head_sha: 'x' } }));
  await forge().approve(WEB12, true);
  noteOwnActivity(501, 12, { notes: 1 });
  const { watches } = loadState();
  assert.deepEqual(watches['acme-co/web#12']!.own!.map(({ notes, unresolved, approvals }) => ({ notes, unresolved, approvals })), [{ notes: 2, unresolved: 1, approvals: 0 }, { notes: 1, unresolved: 0, approvals: 1 }]);
  assert.equal(watches['acme/web!12']!.own?.length, 1, 'a GitLab write lands on the GitLab merge request alone');
  const now = await live();
  assert.equal(now.notes - watches['acme-co/web#12']!.seen.notes, 3, 'what was noted is what the pull request now counts');
});

test('an agent\'s finding on a pull request link needs no project number and is GitHub\'s; a merge request still needs its project', () => {
  const pr = queueInput({ projectPath: PATH, iid: 12, webUrl: 'https://github.com/acme-co/web/pull/12', severity: 'MINOR', body: 'x' }, 0);
  assert.deepEqual([pr.provider, pr.projectId], ['github', 0]);
  assert.equal(queueInput({ provider: 'github', projectPath: PATH, iid: 12, severity: 'MINOR', body: 'x' }, 0).provider, 'github');
  assert.throws(() => queueInput({ projectPath: 'acme/web', iid: 12, webUrl: 'https://gitlab.example/acme/web/-/merge_requests/12', severity: 'MINOR', body: 'x' }, 0), { message: 'queue item 0: missing projectId' });
  assert.equal('provider' in queueInput({ projectPath: 'acme/web', projectId: 3, iid: 12, severity: 'MINOR', body: 'x' }, 0), false);
});
