import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';

const state = mkdtempSync(join(tmpdir(), 'forge-'));
process.env['UNDERLINGS_STATE_DIR'] = state;
process.env['GITLAB_TOKEN'] = 'not-a-real-token';

interface Asked {
  method: string;
  url: string;
  headers: Record<string, string>;
  body: string | null;
  timed: boolean;
}

const asked: Asked[] = [];
let answer: (url: URL, body: string | null) => Response = gitlabAnswer;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const body = typeof init?.body === 'string' ? init.body : null;
  asked.push({ method: init?.method ?? 'GET', url: String(input), headers: { ...(init?.headers as Record<string, string>) }, body, timed: init?.signal instanceof AbortSignal });
  return answer(new URL(String(input)), body);
}) as typeof fetch;

const gitlab = await import('./data/gitlab.js');
const { forgeOf, GITLAB, needs } = await import('./data/forge.js');
const { gitlabForge } = await import('./data/gitlab-forge.js');
const { changeSettings } = await import('./data/store.js');

after(() => {
  globalThis.fetch = realFetch;
  rmSync(state, { recursive: true, force: true });
});
beforeEach(() => {
  asked.length = 0;
  answer = gitlabAnswer;
});

const json = (value: unknown, headers: Record<string, string> = {}): Response => Response.json(value, { headers });

const GRAPHQL: [RegExp, unknown][] = [
  [/mergeRequestSetDraft/, { mergeRequestSetDraft: { errors: [], mergeRequest: { draft: false } } }],
  [/mergeRequestReviewerRereview/, { mergeRequestReviewerRereview: { errors: [] } }],
  [/mergeRequestRequestChanges/, { mergeRequestRequestChanges: { errors: [], mergeRequest: { detailedMergeStatus: 'REQUESTED_CHANGES' } } }],
  [/group\(fullPath/, { group: { mergeRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } }],
];

function gitlabAnswer(url: URL, body: string | null): Response {
  const path = url.pathname.replace('/api/v4', '');
  if (path === '/api/graphql') {
    const query = String(JSON.parse(body ?? '{}').query);
    return json({ data: GRAPHQL.find(([pattern]) => pattern.test(query))?.[1] ?? {} });
  }
  if (path === '/user') return json({ username: 'sybil', name: 'Sybil Shaw' });
  if (path === '/users') return json([{ id: 11, username: url.searchParams.get('username') }]);
  if (/\/pipelines$/.test(path)) return json([{ id: 900 }]);
  if (/\/trace$|\/raw$/.test(path)) return new Response('first\nsecond\n');
  if (/\/repository\/compare$/.test(path)) return json({ commits: [{}, {}], diffs: [{ old_path: 'a.ts', new_path: 'b.ts' }] });
  if (/\/approvals$/.test(path)) return json({ approved_by: [{ user: { username: 'ivan' } }] });
  if (url.searchParams.has('per_page') || /^\/(?:todos|events)$/.test(path)) return json([]);
  return json({ id: 41, status: 'pending', iid: 88, project_id: 7, state: 'merged', target_branch: 'main', diverged_commits_count: 2, references: { full: 'acme/engine!88' }, reviewers: [{ username: 'ivan' }] });
}

const REF = { projectPath: 'acme/engine', projectId: 7, iid: 88 };
const REPO = { path: 'acme/engine', label: 'Engine', openCount: 1 };
const ITEM = { ...REF, id: 'q1', webUrl: '', severity: 'MINOR' as const, body: 'A finding', createdAt: '', createdBy: 'agent', status: 'pending' as const, position: { base_sha: 'a', start_sha: 'a', head_sha: 'b', new_path: 'src/a.ts', new_line: 3 } };
const PROJECT = { projectId: 7, path: 'acme/engine', opened: [], createdAt: [], mergedAt: [], authors: new Map([['7!88', 'ivan']]), truncated: false, cursor: null };

const CONTRACT: Record<string, [() => Promise<unknown>, () => Promise<unknown>]> = {
  me: [() => gitlabForge.me(), () => gitlab.fetchMe()],
  myName: [() => gitlabForge.myName(), () => gitlab.fetchMyName()],
  discoverRepos: [() => gitlabForge.discoverRepos(), () => gitlab.discoverRepos()],
  listOpen: [() => gitlabForge.listOpen([REPO]), () => gitlab.fetchMrsDetailed([REPO])],
  todos: [() => gitlabForge.todos(), () => gitlab.fetchTodos()],
  one: [() => gitlabForge.one(REF), () => gitlab.fetchOneMr('acme/engine', 88)],
  state: [() => gitlabForge.state(REF), () => gitlab.fetchMrState('acme/engine', 88)],
  end: [() => gitlabForge.end(REF), () => gitlab.fetchMrEnd('acme/engine', 88)],
  detail: [() => gitlabForge.detail(REF), () => gitlab.fetchMrDetail(7, 88)],
  branchFacts: [() => gitlabForge.branchFacts(REF), () => gitlab.fetchBranchFacts(7, 88)],
  discussions: [() => gitlabForge.discussions(REF), () => gitlab.fetchDiscussions(7, 88)],
  threadState: [() => gitlabForge.threadState(REF, 'sybil', 'b'), () => gitlab.fetchThreadState(7, 88, 'sybil', 'b')],
  files: [() => gitlabForge.files(REF), () => gitlab.fetchMrFiles(7, 88)],
  since: [() => gitlabForge.since(REF, 'a', 'b'), () => gitlab.fetchSince(7, 'a', 'b')],
  file: [() => gitlabForge.file(REF, 'src/a.ts', 'b', 100), () => gitlab.fetchFileWithin(7, 'src/a.ts', 'b', 100)],
  checks: [() => gitlabForge.checks(REF, 'b'), () => gitlab.fetchPipelineJobs(7, 'b')],
  jobLog: [() => gitlabForge.jobLog(REF, 41, 1), () => gitlab.fetchJobTrace(7, 41, 1)],
  retryJob: [() => gitlabForge.retryJob(REF, 41), () => gitlab.retryJob(7, 41)],
  retryChecks: [() => gitlabForge.retryChecks(REF, 900), () => gitlab.retryPipeline(7, 900)],
  postFinding: [() => gitlabForge.postFinding(ITEM, { automatic: true }), () => gitlab.postComment(ITEM, { automatic: true })],
  reply: [() => gitlabForge.reply(REF, 'd1', 'Fixed'), () => gitlab.replyToDiscussion(7, 88, 'd1', 'Fixed')],
  resolve: [() => gitlabForge.resolve(REF, 'd1', false), () => gitlab.setDiscussionResolved(7, 88, 'd1', false)],
  note: [() => gitlabForge.note(REF, 'Held'), () => gitlab.postNote(7, 88, 'Held')],
  approve: [() => gitlabForge.approve(REF, false), () => gitlab.setApproval(7, 88, false)],
  hold: [() => gitlabForge.hold(REF, true), () => gitlab.setMergeHold('acme/engine', 88, true)],
  merge: [() => gitlabForge.merge(REF, { sha: 'b', whenGreen: true }), () => gitlab.mergeMr(7, 88, { sha: 'b', whenGreen: true })],
  cancelAutoMerge: [() => gitlabForge.cancelAutoMerge(REF), () => gitlab.cancelAutoMerge(7, 88)],
  rebase: [() => gitlabForge.rebase(REF), () => gitlab.rebaseMr(7, 88)],
  rebaseState: [() => gitlabForge.rebaseState(REF), () => gitlab.rebaseState(7, 88)],
  ready: [() => gitlabForge.ready(REF), () => gitlab.setDraft('acme/engine', 88, false)],
  setReviewers: [() => gitlabForge.setReviewers(REF, ['ivan', 'ed']), () => gitlab.setReviewers(7, 88, ['ivan', 'ed'])],
  rerequest: [() => gitlabForge.rerequest(REF, 'ivan'), () => gitlab.rerequestReview('acme/engine', 88, 'ivan')],
  brief: [() => gitlabForge.brief({ projectId: 7, iid: 88 }), () => gitlab.fetchMrBrief(7, 88)],
  approvers: [() => gitlabForge.approvers(REF), () => gitlab.fetchApprovers(7, 88)],
  myEvents: [() => gitlabForge.myEvents('2026-11-01', '2026-11-03'), () => gitlab.fetchMyEvents('2026-11-01', '2026-11-03')],
  myMrs: [() => gitlabForge.myMrs('merged', '2026-11-01T00:00:00Z'), () => gitlab.fetchMyMrs('merged', '2026-11-01T00:00:00Z')],
  mergedIn: [() => gitlabForge.mergedIn('acme', '2026-11-01', '2026-11-02'), () => gitlab.fetchMergedMrs('acme', '2026-11-01', '2026-11-02')],
  boardMrs: [() => gitlabForge.boardMrs([REPO], '2026-11-01'), () => gitlab.fetchBoardMrs([REPO], '2026-11-01')],
  boardComments: [() => gitlabForge.boardComments(PROJECT, '2026-11-01', 2), () => gitlab.fetchCommentEvents(7, '2026-11-01', PROJECT.authors, 2)],
};
const OWN_READS = ['mergedMentioning', 'mergedBy', 'reviewedBy'];

async function outcome(call: () => Promise<unknown>): Promise<{ asked: Asked[]; result: unknown }> {
  asked.length = 0;
  const result = await call().then((value) => ({ value }), (err: Error) => ({ error: err.message }));
  return { asked: asked.map((a) => ({ ...a })), result };
}

test('every GitLab forge method asks GitLab exactly what the gitlab.ts call it wraps asks, and answers the same', async () => {
  for (const [method, [viaForge, direct]] of Object.entries(CONTRACT)) {
    const forge = await outcome(viaForge);
    const plain = await outcome(direct);
    assert.ok(plain.asked.length > 0, `${method} reaches GitLab`);
    assert.deepEqual(forge, plain, method);
  }
});

test('the contract covers every method the GitLab forge has, apart from the reads written in it', () => {
  const methods = Object.keys(gitlabForge).filter((key) => typeof gitlabForge[key as keyof typeof gitlabForge] === 'function');
  assert.deepEqual(methods.filter((m) => !OWN_READS.includes(m)).sort(), Object.keys(CONTRACT).sort());
});

test('an MR, queue item or watch with no provider is GitLab, as is naming it, and a forge this build lacks is refused', () => {
  assert.equal(forgeOf(REF), gitlabForge);
  assert.equal(forgeOf(ITEM), gitlabForge);
  assert.equal(forgeOf({ projectPath: 'acme/engine', iid: 88 }), gitlabForge);
  assert.equal(forgeOf(GITLAB), gitlabForge);
  assert.equal(forgeOf({ ...REF, provider: 'gitlab' }), gitlabForge);
  assert.deepEqual([gitlabForge.id, gitlabForge.name], ['gitlab', 'GitLab']);
  assert.throws(() => forgeOf({ ...REF, provider: 'bitbucket' as never }), /cannot reach bitbucket yet/);
});

test('GitLab can hold, take an approval back, rebase, merge when green, show and retry jobs, and list to-dos', () => {
  assert.deepEqual(gitlabForge.caps, { hold: true, withdrawApproval: true, rebase: true, autoMerge: true, jobLogs: true, retry: true, todos: true });
  for (const cap of Object.keys(gitlabForge.caps) as (keyof typeof gitlabForge.caps)[]) assert.doesNotThrow(() => needs(gitlabForge, cap, 'do it'));
  const without = { ...gitlabForge, name: 'GitHub' as const, caps: { ...gitlabForge.caps, hold: false } };
  assert.throws(() => needs(without, 'hold', 'hold a merge'), { message: 'GitHub has no way to hold a merge' });
});

const listed = (iid: number) => ({ iid, title: `MR ${iid}`, author: { username: 'sybil' }, created_at: '2026-11-01T09:00:00Z', merged_at: '2026-11-02T09:00:00Z', references: { full: `acme/engine!${iid}` } });

test("the stats' reads are GETs with only the token, every page followed up to five, at the host in settings", async () => {
  answer = (url) => {
    const page = Number(url.searchParams.get('page'));
    return json([listed(page)], { 'x-next-page': page < 7 ? String(page + 1) : '' });
  };
  const merged = await gitlabForge.mergedBy('sybil', '2026-10-01T00:00:00.000Z');
  assert.deepEqual(merged.map((m) => m.key), ['acme/engine!1', 'acme/engine!2', 'acme/engine!3', 'acme/engine!4', 'acme/engine!5']);
  assert.deepEqual(merged[0], { key: 'acme/engine!1', title: 'MR 1', author: 'sybil', createdAt: '2026-11-01T09:00:00Z', mergedAt: '2026-11-02T09:00:00Z' });
  assert.deepEqual(asked.map((a) => [a.method, a.headers, a.body, a.timed]), Array(5).fill(['GET', { 'PRIVATE-TOKEN': 'not-a-real-token' }, null, false]));
  assert.equal(asked[0]?.url, 'https://gitlab.com/api/v4/merge_requests?scope=all&per_page=100&page=1&state=merged&author_username=sybil&updated_after=2026-10-01T00%3A00%3A00.000Z');
  asked.length = 0;
  changeSettings((s) => ({ ...s, gitlab: { host: 'https://git.acme.test' } }));
  answer = () => json([]);
  await gitlabForge.reviewedBy('sybil', '2026-10-01T00:00:00.000Z');
  assert.deepEqual(asked.map((a) => a.url), ['https://git.acme.test/api/v4/merge_requests?scope=all&per_page=100&page=1&reviewer_username=sybil&updated_after=2026-10-01T00%3A00%3A00.000Z']);
  changeSettings((s) => ({ ...s, gitlab: { host: 'https://gitlab.com' } }));
});

test("the ticket suggestions' read is one timed GET per group, kept only where the ticket is the MR's own", async () => {
  answer = () => json([
    { iid: 871, title: '🐛 (ABC-12) Fix the edge', references: { full: 'acme/web!871' } },
    { iid: 872, title: '✨ (ABC-123) Something else', references: { full: 'acme/web!872' } },
    { iid: 873, title: '✨ (ABC-99) Mentions ABC-12 later', references: { full: 'acme/web!873' } },
  ]);
  assert.deepEqual(await gitlabForge.mergedMentioning('ABC-12', ['acme', 'tools']), [{ path: 'acme/web', iid: 871 }, { path: 'acme/web', iid: 871 }]);
  assert.deepEqual(asked.map((a) => [a.method, a.url, a.headers, a.timed]), ['acme', 'tools'].map((group) => [
    'GET', `https://gitlab.com/api/v4/groups/${group}/merge_requests?state=merged&search=ABC-12&in=title&per_page=100`, { 'PRIVATE-TOKEN': 'not-a-real-token' }, true,
  ]));
});

test('the reads written in the forge refuse without a token, and say what GitLab answered', async () => {
  answer = () => new Response('', { status: 500, statusText: 'Server Error' });
  await assert.rejects(gitlabForge.mergedMentioning('ABC-12', ['acme']), { message: 'GitLab 500 Server Error' });
  await assert.rejects(gitlabForge.mergedBy('sybil', '2026-10-01'), { message: 'GitLab 500 Server Error' });
  const token = process.env['GITLAB_TOKEN'];
  delete process.env['GITLAB_TOKEN'];
  asked.length = 0;
  try {
    await assert.rejects(gitlabForge.mergedMentioning('ABC-12', ['acme']), { message: 'there is no GitLab token' });
    await assert.rejects(gitlabForge.reviewedBy('sybil', '2026-10-01'), { message: 'there is no GitLab token' });
    assert.deepEqual(asked, []);
  } finally {
    process.env['GITLAB_TOKEN'] = token;
  }
});
