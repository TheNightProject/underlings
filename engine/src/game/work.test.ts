import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { promisify } from 'node:util';

process.env['UNDERLINGS_STATE_DIR'] = mkdtempSync(join(tmpdir(), 'work-test-'));
process.env['UNDERLINGS_JIRA_SITE'] = 'example.atlassian.net';
process.env['GITLAB_TOKEN'] = 'not-a-real-token';

const asked: string[] = [];
const jql: string[] = [];
let gitlabDown = false;
let jiraAnswer: (query: string) => Promise<{ stdout: string }> = () => Promise.resolve({ stdout: '[]' });
const realFetch = globalThis.fetch;
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } });

const event = (action: string, iid: number, at: string, author = 'frank', projectId = 7) => ({
  action_name: action, project_id: projectId, target_type: action === 'commented on' ? 'DiffNote' : 'MergeRequest', target_iid: iid, author: { username: author }, created_at: at,
  ...(action === 'commented on' ? { note: { noteable_type: 'MergeRequest', noteable_iid: iid } } : {}),
});
const EVENTS = [
  event('commented on', 12, '2026-11-09T09:00:00Z'),
  event('commented on', 12, '2026-11-09T09:05:00Z'),
  event('approved', 12, '2026-11-09T10:00:00Z'),
  event('commented on', 12, '2026-11-10T08:00:00Z'),
  event('commented on', 30, '2026-11-09T23:30:00Z'),
  event('commented on', 45, '2026-11-09T11:00:00Z'),
  event('commented on', 12, '2026-11-09T12:00:00Z', 'ivan'),
  event('pushed to', 45, '2026-11-09T11:00:00Z'),
];
const MRS: Record<string, unknown> = {
  '7!12': { project_id: 7, iid: 12, title: 'Graph reads', author: { username: 'ivan' }, references: { full: 'acme/engine!12' } },
  '7!30': { project_id: 7, iid: 30, title: 'Late one', author: { username: 'zara' }, references: { full: 'acme/engine!30' } },
  '7!45': { project_id: 7, iid: 45, title: 'My own', author: { username: 'frank' }, references: { full: 'acme/atlas!45' } },
};
const MERGED = [
  { project_id: 7, iid: 45, title: 'My own', author: { username: 'frank' }, merged_at: '2026-11-09T15:00:00Z', references: { full: 'acme/atlas!45' } },
  { project_id: 7, iid: 46, title: 'Too early', author: { username: 'frank' }, merged_at: '2026-11-01T15:00:00Z', references: { full: 'acme/atlas!46' } },
];

globalThis.fetch = (async (input: string | URL | Request) => {
  const url = new URL(String(input));
  const path = url.pathname.replace('/api/v4', '');
  asked.push(path);
  if (gitlabDown) return json({ message: '500' }, 500);
  if (path === '/user') return json({ username: 'frank' });
  if (path === '/events') return json(url.searchParams.get('page') === '1' ? EVENTS : []);
  if (path === '/merge_requests') return json(MERGED);
  const one = /^\/projects\/(\d+)\/merge_requests\/(\d+)$/.exec(path);
  return one && MRS[`${one[1]}!${one[2]}`] ? json(MRS[`${one[1]}!${one[2]}`]) : json({ message: '404' }, 404);
}) as typeof fetch;

const fakeExecFile = Object.assign(() => undefined, {
  [promisify.custom]: (_cmd: string, args: string[]) => {
    const query = args[args.indexOf('--jql') + 1] ?? '';
    jql.push(query);
    return jiraAnswer(query);
  },
});
Object.assign(childProcess, { execFile: fakeExecFile });
syncBuiltinESMExports();
const { daysBetween, readGitlabWork, readTicketMoves } = await import('./work.js');

after(() => {
  globalThis.fetch = realFetch;
});
beforeEach(() => {
  asked.length = 0;
  jql.length = 0;
  gitlabDown = false;
  jiraAnswer = () => Promise.resolve({ stdout: '[]' });
});

test('reviews are other people\'s MRs you commented on or approved, one per MR per London day, and your merges are your own', async () => {
  const work = await readGitlabWork('2026-11-09', '2026-11-10');
  assert.equal(work.me, 'frank');
  assert.deepEqual(work.merged, [{ key: 'acme/atlas!45', title: 'My own', at: '2026-11-09T15:00:00Z', day: '2026-11-09' }]);
  assert.deepEqual(work.reviews.map((r) => [r.key, r.day, r.comments, r.approved]), [
    ['acme/engine!12', '2026-11-09', 2, true],
    ['acme/engine!30', '2026-11-09', 1, false],
    ['acme/engine!12', '2026-11-10', 1, false],
  ]);
});

test('in Tokyo the game counts each review and merge on its Tokyo day', async () => {
  const work = await readGitlabWork('2026-11-09', '2026-11-10', {}, 'Asia/Tokyo');
  assert.deepEqual(work.merged.map((m) => m.day), ['2026-11-10'], '15:00 in London is midnight in Tokyo');
  assert.deepEqual(work.reviews.map((r) => [r.key, r.day, r.comments, r.approved]), [
    ['acme/engine!12', '2026-11-09', 2, true],
    ['acme/engine!30', '2026-11-10', 1, false],
    ['acme/engine!12', '2026-11-10', 1, false],
  ]);
});

test('an MR already known is not asked for again', async () => {
  const known = { '7!12': { projectPath: 'acme/engine', author: 'ivan', title: 'Graph reads' } };
  const work = await readGitlabWork('2026-11-09', '2026-11-09', known);
  assert.deepEqual(asked.filter((p) => p.startsWith('/projects/')).sort(), ['/projects/7/merge_requests/30', '/projects/7/merge_requests/45']);
  assert.equal(work.briefs['7!30']?.author, 'zara');
});

const MOVES = ['QA', 'Done'];

test('Jira is asked once per day and status for tickets you moved, and a status the workflow lacks is no error', async () => {
  jiraAnswer = (query) => (query.includes('"Done"') ? Promise.reject(Object.assign(new Error('acli failed'), { stdout: "The value 'Done' does not exist for the field 'status'." }))
    : Promise.resolve({ stdout: JSON.stringify(query.includes('2026-11-10') ? [{ key: 'ABC-9', fields: { summary: 'Ship it', status: { name: 'QA' } } }] : []) }));
  const moves = await readTicketMoves('2026-11-09', '2026-11-10', MOVES);
  assert.deepEqual(jql.map((q) => /BY currentUser\(\) DURING \("(\d{4}-\d{2}-\d{2})/.exec(q)?.[1] + ':' + /TO "([^"]+)"/.exec(q)?.[1]).sort(), ['2026-11-09:Done', '2026-11-09:QA', '2026-11-10:Done', '2026-11-10:QA']);
  assert.deepEqual(moves, [{ key: 'ABC-9', status: 'QA', day: '2026-11-10', summary: 'Ship it' }]);
});

test('the statuses asked for are the ones the caller names, so another workflow earns for its own', async () => {
  jiraAnswer = () => Promise.resolve({ stdout: '[]' });
  await readTicketMoves('2026-11-09', '2026-11-09', ['Testing', 'Closed', 'Testing']);
  assert.deepEqual(jql.map((q) => /TO "([^"]+)"/.exec(q)?.[1]).sort(), ['Closed', 'Testing']);
});

test('GitLab down, or Jira refusing every day, is an error the caller can say, and one day refused is not', async () => {
  gitlabDown = true;
  await assert.rejects(readGitlabWork('2026-11-09', '2026-11-09'), /500/);
  jiraAnswer = () => Promise.reject(Object.assign(new Error('acli failed'), { stdout: 'not logged in' }));
  await assert.rejects(readTicketMoves('2026-11-09', '2026-11-09', MOVES), { message: 'not logged in' });
  jiraAnswer = (query) => (query.includes('2026-11-09') && query.includes('"QA"') ? Promise.reject(Object.assign(new Error('acli failed'), { stdout: 'timed out' })) : Promise.resolve({ stdout: '[]' }));
  assert.deepEqual(await readTicketMoves('2026-11-09', '2026-11-10', MOVES), []);
});

test('a window is whole London days, and one the wrong way round is refused', async () => {
  assert.deepEqual(daysBetween('2026-10-30', '2026-11-02'), ['2026-10-30', '2026-10-31', '2026-11-01', '2026-11-02']);
  await assert.rejects(readGitlabWork('2026-11-10', '2026-11-09'), /no earlier/);
  await assert.rejects(readTicketMoves('2026-11-10', '2026-11-09', MOVES), /no earlier/);
});
