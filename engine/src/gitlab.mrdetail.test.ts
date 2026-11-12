import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';

process.env['GITLAB_TOKEN'] = 'not-a-real-token';

const { fetchMrDetail, fetchMrs, fetchOneMr } = await import('./data/gitlab.js');
const { restUrl } = await import('./config.js');

const requests: { url: string; method: string }[] = [];
const sentAt: number[] = [];
let reply: unknown = {};
const realFetch = globalThis.fetch;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  requests.push({ url: String(input), method: init?.method ?? 'GET' });
  sentAt.push(Date.now());
  await new Promise((resolve) => setTimeout(resolve, 5));
  return new Response(JSON.stringify(reply), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

after(() => {
  globalThis.fetch = realFetch;
});
beforeEach(() => {
  requests.length = 0;
  sentAt.length = 0;
});

test('the REST fields the GraphQL list leaves out are read and renamed', async () => {
  reply = {
    iid: 621,
    title: 'Scope it',
    description: 'Fixes !620.\n\nSee ABC-12.',
    detailed_merge_status: 'discussions_not_resolved',
    target_branch: 'main',
    changes_count: '1000+',
    user_notes_count: 4,
  };
  const detail = await fetchMrDetail(1001, 621);
  assert.deepEqual(detail, {
    description: 'Fixes !620.\n\nSee ABC-12.',
    detailedMergeStatus: 'discussions_not_resolved',
    targetBranch: 'main',
    changesCount: '1000+',
    userNotesCount: 4,
  });
  assert.deepEqual(requests, [{ url: `${restUrl()}/projects/1001/merge_requests/621`, method: 'GET' }]);
});

test('an MR with no description or counts reads as empty rather than undefined', async () => {
  reply = { description: null, target_branch: 'main' };
  assert.deepEqual(await fetchMrDetail(1001, 622), {
    description: '',
    detailedMergeStatus: null,
    targetBranch: 'main',
    changesCount: null,
    userNotesCount: 0,
  });
});

test('an MR fetched from GitLab says when it was asked for, so the engine can tell its own writes from what it shows', async () => {
  const node = {
    iid: '621', title: 'Scope it', webUrl: 'https://x', draft: false, conflicts: false, userNotesCount: 0,
    resolvableDiscussionsCount: 0, resolvedDiscussionsCount: 0, createdAt: '', updatedAt: '',
    diffHeadSha: 'head-1', sourceBranch: 'b', detailedMergeStatus: null,
    author: { username: 'heidi' }, reviewers: { nodes: [] }, approvedBy: { nodes: [] }, headPipeline: null,
  };
  reply = { data: { p0: { id: 'gid://gitlab/Project/1001', fullPath: 'acme/engine', name: 'Engine', mergeRequests: { count: 1, nodes: [node] } } } };
  const asked = Date.now();
  const one = await fetchOneMr('acme/engine', 621);
  const [listed] = await fetchMrs([{ path: 'acme/engine', label: 'Engine' }]);
  const [oneSent = 0, listSent = 0] = sentAt;
  for (const [copy, sent] of [[one, oneSent], [listed, listSent]] as const) {
    assert.ok(copy?.readAt !== undefined && copy.readAt >= asked && copy.readAt <= sent, 'stamped before the request went out');
  }
});
