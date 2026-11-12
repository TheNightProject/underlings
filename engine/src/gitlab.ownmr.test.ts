import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';

process.env['GITLAB_TOKEN'] = 'not-a-real-token';

const { fetchBranchFacts, mergeMr, rebaseMr, rebaseState, rerequestReview, setDraft, setReviewers } = await import('./data/gitlab.js');

interface Call {
  url: string;
  method: string;
  body: unknown;
}

const calls: Call[] = [];
let reply: (call: Call) => Response = () => json({});
const realFetch = globalThis.fetch;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const call = { url: String(input).replace('https://gitlab.com', ''), method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : null };
  calls.push(call);
  return reply(call);
}) as typeof fetch;

after(() => {
  globalThis.fetch = realFetch;
});
beforeEach(() => {
  calls.length = 0;
  reply = () => json({});
});

const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });
const users: Record<string, number> = { ivan: 11, ed: 12 };
const userReply = (call: Call): Response | null => {
  const name = /\/users\?username=(.*)$/.exec(call.url)?.[1];
  return name === undefined ? null : json(users[name] ? [{ id: users[name], username: name }] : []);
};

test('a rebase is only started, with a PUT, and its progress is read with the flag GitLab hides by default', async () => {
  await rebaseMr(7, 88);
  reply = () => json({ rebase_in_progress: false, merge_error: 'Rebase failed: conflicts' });
  assert.deepEqual(await rebaseState(7, 88), { inProgress: false, error: 'Rebase failed: conflicts' });
  assert.deepEqual(calls.map(({ url, method }) => [method, url]), [
    ['PUT', '/api/v4/projects/7/merge_requests/88/rebase'],
    ['GET', '/api/v4/projects/7/merge_requests/88?include_rebase_in_progress=true'],
  ]);
});

test('how far behind a branch is, and the branch it targets, are read with the count GitLab leaves out by default', async () => {
  reply = () => json({ target_branch: 'feat/base', diverged_commits_count: 54, has_conflicts: false });
  assert.deepEqual(await fetchBranchFacts(7, 88), { targetBranch: 'feat/base', behind: 54 });
  assert.deepEqual(calls.map(({ url, method }) => [method, url]), [['GET', '/api/v4/projects/7/merge_requests/88?include_diverged_commits_count=true']]);
  reply = () => json({ target_branch: 'main' });
  assert.deepEqual(await fetchBranchFacts(7, 88), { targetBranch: 'main', behind: null });
});

test('marking ready sends the draft flag off through GraphQL, and an error GitLab returns is thrown', async () => {
  reply = () => json({ data: { mergeRequestSetDraft: { errors: [], mergeRequest: { draft: false } } } });
  assert.deepEqual(await setDraft('acme/engine', 88, false), { draft: false });
  const [call] = calls;
  assert.equal(call?.url, '/api/graphql');
  assert.match(String((call?.body as { query: string }).query), /mergeRequestSetDraft\(input: \{ projectPath: \$path, iid: \$iid, draft: \$draft \}\)/);
  assert.deepEqual((call?.body as { variables: unknown }).variables, { path: 'acme/engine', iid: '88', draft: false });
  reply = () => json({ data: { mergeRequestSetDraft: { errors: ['You cannot do that'], mergeRequest: null } } });
  await assert.rejects(setDraft('acme/engine', 88, false), /GitLab: You cannot do that/);
});

test('a merge sends the head it was given, and only merge when green asks GitLab to wait for the pipeline', async () => {
  reply = () => json({ state: 'merged' });
  assert.deepEqual(await mergeMr(7, 88, { sha: 'aaa111', whenGreen: false }), { merged: true, autoMerge: false });
  reply = () => json({ state: 'opened', merge_when_pipeline_succeeds: true });
  assert.deepEqual(await mergeMr(7, 88, { sha: 'aaa111', whenGreen: true }), { merged: false, autoMerge: true });
  assert.deepEqual(calls.map(({ url, method, body }) => [method, url, body]), [
    ['PUT', '/api/v4/projects/7/merge_requests/88/merge', { sha: 'aaa111' }],
    ['PUT', '/api/v4/projects/7/merge_requests/88/merge', { sha: 'aaa111', auto_merge: true, merge_when_pipeline_succeeds: true }],
  ]);
});

test("GitLab's refusal of a moved head reaches the caller as it said it", async () => {
  reply = () => json({ message: 'SHA does not match HEAD of source branch: bbb222' }, 409);
  await assert.rejects(mergeMr(7, 88, { sha: 'aaa111', whenGreen: false }), /GitLab 409 .*SHA does not match HEAD of source branch/);
});

test('reviewers are looked up by name and replace the list, and none at all is sent as GitLab spells it', async () => {
  reply = (call) => userReply(call) ?? json({ reviewers: [{ username: 'ivan' }, { username: 'ed' }] });
  assert.deepEqual(await setReviewers(7, 88, ['ivan', 'ed']), ['ivan', 'ed']);
  const put = calls.find((c) => c.method === 'PUT');
  assert.deepEqual([put?.url, put?.body], ['/api/v4/projects/7/merge_requests/88', { reviewer_ids: [11, 12] }]);
  calls.length = 0;
  reply = (call) => userReply(call) ?? json({ reviewers: [] });
  assert.deepEqual(await setReviewers(7, 88, []), []);
  assert.deepEqual(calls.map((c) => c.body), [{ reviewer_ids: [0] }]);
});

test('an unknown reviewer stops the change before anything is written', async () => {
  reply = (call) => userReply(call) ?? json({});
  await assert.rejects(setReviewers(7, 88, ['ivan', 'nobody']), /GitLab has no user nobody/);
  assert.deepEqual(calls.filter((c) => c.method !== 'GET'), []);
});

test('a re-request names the reviewer by their GitLab id', async () => {
  reply = (call) => userReply(call) ?? json({ data: { mergeRequestReviewerRereview: { errors: [] } } });
  await rerequestReview('acme/engine', 88, 'ivan');
  const mutation = calls.find((c) => c.url === '/api/graphql')?.body as { query: string; variables: unknown };
  assert.match(mutation.query, /mergeRequestReviewerRereview/);
  assert.deepEqual(mutation.variables, { path: 'acme/engine', iid: '88', user: 'gid://gitlab/User/11' });
  reply = (call) => userReply(call) ?? json({ data: { mergeRequestReviewerRereview: { errors: ['Reviewer not found'] } } });
  await assert.rejects(rerequestReview('acme/engine', 88, 'ivan'), /GitLab: Reviewer not found/);
});
