import assert from 'node:assert/strict';
import { after, test } from 'node:test';

process.env['GITLAB_TOKEN'] = 'not-a-real-token';

const { fetchApprovers, fetchMyEvents, fetchMyMrs } = await import('./data/gitlab.js');

const asked: string[] = [];
let pages: unknown[][] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  asked.push(`${url.pathname.replace('/api/v4', '')}${url.search}`);
  const page = Number(url.searchParams.get('page') ?? '1');
  const body = url.pathname.endsWith('/approvals') ? { approved_by: [{ user: { username: 'judy' } }, { user: {} }] } : pages[page - 1] ?? [];
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;
after(() => {
  globalThis.fetch = realFetch;
});

const event = (n: number) => ({ action_name: 'pushed to', project_id: 1, target_type: null, created_at: `2026-11-09T10:00:${String(n % 60).padStart(2, '0')}Z`, author: { username: 'frank' } });

test('every page of events is read, until GitLab returns a short one', async () => {
  asked.length = 0;
  pages = [Array.from({ length: 100 }, (_, n) => event(n)), Array.from({ length: 100 }, (_, n) => event(n)), [event(1)]];
  assert.equal((await fetchMyEvents('2026-11-08', '2026-11-10')).length, 201);
  assert.deepEqual(asked, [1, 2, 3].map((page) => `/events?after=2026-11-08&before=2026-11-10&per_page=100&page=${page}`));
});

test('a comment is placed on the MR it was left on, never on the note GitLab calls its target', async () => {
  pages = [[
    { action_name: 'commented on', project_id: 7, target_type: 'DiffNote', target_iid: 4177331643, note: { noteable_type: 'MergeRequest', noteable_iid: 1177 }, author: { username: 'frank' }, created_at: 'x' },
    { action_name: 'commented on', project_id: 7, target_type: 'Note', target_iid: 55, note: { noteable_type: 'Issue', noteable_iid: 12 }, author_username: 'frank', created_at: 'x' },
    { action_name: 'approved', project_id: 7, target_type: 'MergeRequest', target_iid: 1180, author: { username: 'frank' }, created_at: 'x' },
  ]];
  assert.deepEqual((await fetchMyEvents('a', 'b')).map((e) => [e.action, e.iid, e.author]), [['commented on', 1177, 'frank'], ['commented on', null, 'frank'], ['approved', 1180, 'frank']]);
});

test('your MRs are listed by state, from when asked, with the path GitLab gives', async () => {
  asked.length = 0;
  pages = [[{ project_id: 7, iid: 3, title: 'T️', references: { full: 'acme/engine!3' }, author: { username: 'frank' }, has_conflicts: true, detailed_merge_status: 'conflict' }]];
  const [mr] = await fetchMyMrs('merged', '2026-11-09T00:00:00.000Z');
  assert.deepEqual([mr?.projectPath, mr?.title, mr?.conflicts, mr?.mergeStatus], ['acme/engine', 'T', true, 'conflict']);
  assert.deepEqual(asked, ['/merge_requests?scope=created_by_me&state=merged&updated_after=2026-11-09T00%3A00%3A00.000Z&per_page=100&page=1']);
  assert.deepEqual(await fetchApprovers(7, 3), ['judy']);
});
