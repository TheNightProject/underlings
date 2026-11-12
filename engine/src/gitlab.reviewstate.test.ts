import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';

process.env['GITLAB_TOKEN'] = 'not-a-real-token';

const { cancelAutoMerge, changesRequestedBy, fetchMrEnd, fetchOneMr, fetchSince, fetchTodos, heldByMe } = await import('./data/gitlab.js');
const { mr } = await import('./auto/testkit.js');

const calls: { url: string; method: string }[] = [];
let reply: (url: string) => unknown = () => ({});
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input).replace('https://gitlab.com', '');
  calls.push({ url, method: init?.method ?? 'GET' });
  return Response.json(reply(url));
}) as typeof fetch;
after(() => {
  globalThis.fetch = realFetch;
});
beforeEach(() => {
  calls.length = 0;
});

const node = {
  iid: '88', title: 'Scope it', webUrl: 'https://x', draft: false, conflicts: false, userNotesCount: 0, state: 'opened',
  resolvableDiscussionsCount: 0, resolvedDiscussionsCount: 0, createdAt: '', updatedAt: '', diffHeadSha: 'h1', sourceBranch: 'b',
  detailedMergeStatus: 'REQUESTED_CHANGES', autoMergeEnabled: true, author: { username: 'frank' }, approvedBy: { nodes: [] }, headPipeline: null,
  reviewers: { nodes: [{ username: 'judy', mergeRequestInteraction: { reviewState: 'REQUESTED_CHANGES' } }, { username: 'alice', mergeRequestInteraction: { reviewState: 'REVIEWED' } }] },
};

test('each reviewer\'s own state and merge when green are read with the MR', async () => {
  reply = () => ({ data: { p0: { id: 'gid://gitlab/Project/7', fullPath: 'acme/engine', name: 'engine', mergeRequests: { count: 1, nodes: [node] } } } });
  const read = await fetchOneMr('acme/engine', 88);
  assert.deepEqual(read?.reviewStates, { judy: 'REQUESTED_CHANGES', alice: 'REVIEWED' });
  assert.equal(read?.autoMerge, true);
  assert.deepEqual(changesRequestedBy(read!), ['judy']);
});

test('the head pipeline\'s id is read with the MR, and left out when there is none', async () => {
  const withPipeline = { ...node, headPipeline: { id: 'gid://gitlab/Ci::Pipeline/4521', status: 'FAILED' } };
  reply = () => ({ data: { p0: { id: 'gid://gitlab/Project/7', fullPath: 'acme/engine', name: 'engine', mergeRequests: { count: 1, nodes: [withPipeline] } } } });
  assert.deepEqual([(await fetchOneMr('acme/engine', 88))?.pipelineId, (await fetchOneMr('acme/engine', 88))?.pipeline], [4521, 'FAILED']);
  reply = () => ({ data: { p0: { id: 'gid://gitlab/Project/7', fullPath: 'acme/engine', name: 'engine', mergeRequests: { count: 1, nodes: [node] } } } });
  assert.equal((await fetchOneMr('acme/engine', 88))?.pipelineId, undefined);
});

test('how an MR ended names who merged it, and an MR GitLab no longer has reads as no state', async () => {
  reply = () => ({ data: { project: { mergeRequest: { state: 'merged', mergeUser: { username: 'frank' } } } } });
  assert.deepEqual(await fetchMrEnd('acme/engine', 88), { state: 'merged', mergedBy: 'frank' });
  reply = () => ({ data: { project: null } });
  assert.deepEqual(await fetchMrEnd('acme/engine', 88), { state: null, mergedBy: null });
});

test('a colleague\'s change request is not your hold, and a build with no reviewer states falls back to the MR', () => {
  const held = mr({ mergeStatus: 'REQUESTED_CHANGES', reviewStates: { judy: 'REQUESTED_CHANGES', frank: 'REVIEWED' } });
  assert.equal(heldByMe(held, 'frank'), false);
  assert.equal(heldByMe(held, 'judy'), true);
  assert.equal(heldByMe(mr({ mergeStatus: 'REQUESTED_CHANGES' }), 'frank'), true);
  assert.equal(heldByMe(mr({ mergeStatus: 'REQUESTED_CHANGES', reviewStates: { judy: 'REQUESTED_CHANGES' } }), 'frank'), false, 'not a reviewer at all is not holding it');
});

test('cancelling merge when green posts to GitLab\'s cancel route', async () => {
  await cancelAutoMerge(7, 88);
  assert.deepEqual(calls, [{ url: '/api/v4/projects/7/merge_requests/88/cancel_merge_when_pipeline_succeeds', method: 'POST' }]);
});

test('what changed since a head is one compare call, counting its commits and paths', async () => {
  reply = () => ({ commits: [{}, {}], diffs: [{ old_path: 'a.ts', new_path: 'a.ts' }, { old_path: 'b.ts', new_path: 'c.ts' }] });
  assert.deepEqual(await fetchSince(7, 'h1', 'h2'), { commits: 2, paths: ['a.ts', 'b.ts', 'c.ts'] });
  assert.equal(calls.length, 1);
});

test('to-dos are read as pending merge request to-dos, keyed by their MR', async () => {
  reply = () => [
    { id: 5, action_name: 'mentioned', author: { username: 'judy' }, project: { path_with_namespace: 'acme/engine' }, target: { iid: 88 }, created_at: '2026-11-06T10:00:00Z', body: '@frank look' },
    { id: 6, action_name: 'mentioned', project: {}, target: {}, created_at: '' },
  ];
  assert.deepEqual(await fetchTodos(), [{ id: 5, action: 'mentioned', key: 'acme/engine!88', author: 'judy', createdAt: '2026-11-06T10:00:00Z', text: '@frank look' }]);
  assert.deepEqual(calls.map((c) => c.url), ['/api/v4/todos?state=pending&type=MergeRequest&per_page=100']);
});
