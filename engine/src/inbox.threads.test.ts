import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'thematrix-inbox-threads-'));
process.env['UNDERLINGS_STATE_DIR'] = dir;
process.env['GITLAB_TOKEN'] = 'not-a-real-token';

const reads: string[] = [];
const realFetch = globalThis.fetch;
const note = (id: number, username: string, body: string, created_at: string) => ({ id, author: { username }, body, created_at, system: false, resolvable: true, resolved: false });
globalThis.fetch = (async (input: string | URL | Request) => {
  const url = String(input);
  reads.push(url.replace(/^.*\/merge_requests\//, '').replace(/\/discussions.*$/, ''));
  return Response.json([{ id: 'd-1', notes: [note(1, 'judy', 'Rename this', '2026-11-06T09:00:00Z'), note(2, 'judy', 'Please', '2026-11-06T09:05:00Z')] }]);
}) as typeof fetch;
after(() => {
  globalThis.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  reads.length = 0;
});

const { ME, mr } = await import('./auto/testkit.js');
const { threadsFor } = await import('./inbox.js');
type Watch = import('./types.js').Watch;
const watch = (iid: number): Watch => ({ key: `acme/engine!${iid}`, projectPath: 'acme/engine', iid, webUrl: '', auto: true, seen: { sha: 'head-1', pipeline: null, notes: 0, approvals: 0 }, addedAt: '' });

test('a reviewer\'s thread on your own MR is kept, with who said it last', async () => {
  const found = await threadsFor([mr({ iid: 1, author: ME, unresolvedThreads: 1 })], ME, {});
  const [thread] = found.get('acme/engine!1')?.threads ?? [];
  assert.deepEqual([thread?.openedBy, thread?.mine, thread?.lastAuthor, thread?.lastNoteId, thread?.fromPerson], ['judy', false, 'judy', 2, true]);
});

test('a watched MR with no unresolved threads is read', async () => {
  await threadsFor([mr({ iid: 2, unresolvedThreads: 0 })], ME, { 'acme/engine!2': watch(2) });
  assert.deepEqual(reads, ['2']);
});

test('an MR whose notes, threads and head have not moved is not read again', async () => {
  const mrs = [mr({ iid: 3, author: ME, unresolvedThreads: 1 })];
  await threadsFor(mrs, ME, {});
  await threadsFor(mrs, ME, {});
  assert.deepEqual(reads, ['3']);
  await threadsFor([mr({ iid: 3, author: ME, unresolvedThreads: 1, notes: 4 })], ME, {});
  assert.deepEqual(reads, ['3', '3'], 'a new note reads it again');
});
