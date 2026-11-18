import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { githubHarness } from './fixtures/github/harness.mjs';
import { githubWorld } from './fixtures/github/world.mjs';

const h = githubHarness();
process.env['GITHUB_TOKEN'] = 'ghp_0123456789abcdefghijklmnopqrstuv';

const { changeSettings } = await import('./data/store.js');
const { forgeOf } = await import('./data/forge.js');
const { resetGithubLimits, forgetGithubToken } = await import('./data/github.js');
const { DEFAULT_GITHUB } = await import('./settings.js');

type World = ReturnType<typeof githubWorld>;
type Pr = World['prs'][number];

const ref = (projectPath: string, iid: number) => ({ provider: 'github' as const, projectPath, projectId: 501, iid });
const MINE = ref('acme-co/web', 15);
const forge = () => forgeOf(MINE);
const pr = (number: number): Pr => h.world.prs.find((p: Pr) => p.number === number)!;
const repo = (name: string) => h.world.repos.find((r: { name: string; owner: string }) => `${r.owner}/${r.name}` === name)!;
const writes = () => h.fake.requests.filter((r) => r.method !== 'GET' && (r.path !== '/graphql' || /^\s*mutation/.test(r.body?.query ?? '')));
const sent = () => writes().map((r) => r.op ?? `${r.method} ${r.path}`);
const live = async (r = MINE) => (await forgeOf(r).one(r))!;

after(() => h.done());
beforeEach(() => {
  Object.assign(h.world, githubWorld());
  h.fake.requests.length = 0;
  resetGithubLimits();
  forgetGithubToken();
  changeSettings((s) => ({ ...s, github: { ...DEFAULT_GITHUB, on: true } }));
});

test('merging sends the head and merges the way GitHub\'s own button would, among the ways the repo allows', async () => {
  Object.assign(pr(15), { mergeStateStatus: 'CLEAN' });
  Object.assign(repo('acme-co/web'), { methods: ['SQUASH', 'REBASE'], defaultMethod: 'REBASE' });
  const head = (await live()).sha!;
  assert.deepEqual(await forge().merge(MINE, { sha: head, whenGreen: false }), { merged: true, autoMerge: false });
  assert.deepEqual(writes()[0]!.body, { sha: head, merge_method: 'rebase' });
  assert.deepEqual([pr(15).state, pr(15).mergedWith], ['MERGED', 'REBASE']);
});

test('a default the repo no longer allows gives way to one it does, and a head that moved is refused by GitHub itself', async () => {
  Object.assign(pr(15), { mergeStateStatus: 'CLEAN' });
  Object.assign(repo('acme-co/web'), { methods: ['SQUASH'], defaultMethod: 'MERGE' });
  await assert.rejects(forge().merge(MINE, { sha: 'f'.repeat(40), whenGreen: false }), /^Error: GitHub 409 .*Head branch was modified/);
  assert.equal(writes()[0]!.body.merge_method, 'squash');
  assert.equal(pr(15).state, 'OPEN');
});

test('merge when green turns on GitHub\'s auto-merge for the head you saw, and cancelling turns it off', async () => {
  const head = (await live()).sha!;
  assert.deepEqual(await forge().merge(MINE, { sha: head, whenGreen: true }), { merged: false, autoMerge: true });
  assert.deepEqual(writes()[0]!.body.variables, { pr: 'PR_fake_acme-co/web_15', method: 'MERGE', head });
  assert.equal((await live()).autoMerge, true);
  await forge().cancelAutoMerge(MINE);
  assert.equal((await live()).autoMerge, false);
  assert.deepEqual(sent(), ['PrAutoMerge', 'PrCancelAutoMerge']);
});

test('a repo that does not allow auto-merge says so in GitHub\'s words', async () => {
  Object.assign(repo('acme-co/web'), { autoMergeAllowed: false });
  await assert.rejects(forge().merge(MINE, { sha: (await live()).sha!, whenGreen: true }), { message: 'GitHub GraphQL: Auto merge is not allowed for this repository' });
});

test('marking a draft ready is GitHub\'s ready for review', async () => {
  const draft = ref('acme-co/engine', 7);
  assert.deepEqual(await forgeOf(draft).ready(draft), { draft: false });
  assert.equal((await live(draft)).draft, false);
});

test('a branch behind its target is updated by GitHub, which is under way until the head moves', async () => {
  Object.assign(pr(15), { mergeStateStatus: 'BEHIND' });
  const before = await live();
  assert.equal(before.mergeStatus, 'NEED_REBASE');
  assert.deepEqual(await forge().rebaseState(before), { inProgress: true, error: null });
  await forge().rebase(before);
  assert.deepEqual(writes()[0]!.body, { expected_head_sha: before.sha });
  assert.deepEqual(await forge().rebaseState(before), { inProgress: false, error: null });
  assert.notEqual((await live()).sha, before.sha);
});

test('choosing reviewers asks the new ones and stops asking those left out, and never asks again of one who has reviewed', async () => {
  assert.deepEqual(await forge().setReviewers(MINE, ['ivan', 'trent']), ['trent', 'ivan']);
  assert.deepEqual(writes().map((r) => [r.method, r.body]), [['POST', { reviewers: ['trent'] }]]);
  h.fake.requests.length = 0;
  assert.deepEqual(await forge().setReviewers(MINE, ['ivan']), ['ivan']);
  assert.deepEqual(writes().map((r) => [r.method, r.body]), [['DELETE', { reviewers: ['trent'] }]]);
  assert.deepEqual(pr(15).requested, []);
});

test('asking again of someone who has reviewed requests their review once more', async () => {
  await forge().rerequest(MINE, 'ivan');
  assert.deepEqual(pr(15).requested, ['ivan']);
  assert.ok((await live()).reviewers.includes('ivan'));
});

test('a failed Actions job runs again, and retrying the checks runs again the failed jobs of each run on the head', async () => {
  assert.deepEqual(await forge().retryJob(MINE, 7101), { id: 7101, status: 'pending' });
  assert.equal((await forge().checks(MINE, pr(15).headRefOid)).find((j) => j.id === 7101)?.status, 'pending');
  Object.assign(pr(15).checks[0]!, { status: 'COMPLETED', conclusion: 'FAILURE' });
  pr(15).checks.push({ id: 7102, name: 'lint', status: 'COMPLETED', conclusion: 'CANCELLED', runId: 9003, workflow: 'Lint' }, { id: 7103, name: 'docs', status: 'COMPLETED', conclusion: 'SUCCESS', runId: 9004, workflow: 'Docs' });
  h.fake.requests.length = 0;
  assert.deepEqual(await forge().retryChecks(await live(), 9003), { id: 9003, status: 'pending' });
  assert.deepEqual(sent().sort(), ['POST /repos/acme-co/web/actions/runs/9002/rerun-failed-jobs', 'POST /repos/acme-co/web/actions/runs/9003/rerun-failed-jobs']);
  await assert.rejects(forge().retryChecks(await live(), 9003), { message: 'no GitHub Actions job on the head of acme-co/web#15 has failed or been cancelled' });
});
