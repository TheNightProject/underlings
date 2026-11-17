import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { promisify } from 'node:util';
import type { QueuedComment } from './types.js';

const dir = mkdtempSync(join(tmpdir(), 'thematrix-inbox-'));
process.env['UNDERLINGS_STATE_DIR'] = dir;
process.env['GITLAB_TOKEN'] = 'not-a-real-token';

// Nothing is run: a call that gets this far is counted and refused.
let terminalList: () => Promise<{ stdout: string }> = () => Promise.reject(new Error('spawn ENOENT'));
Object.assign(childProcess, { execFile: Object.assign(() => undefined, { [promisify.custom]: () => terminalList() }) });
syncBuiltinESMExports();

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
  if (String(input).endsWith('/user')) return Response.json({ username: 'frank' });
  const project = { id: 'gid://gitlab/Project/1001', fullPath: 'acme/engine', name: 'Engine', mergeRequests: { count: 0, nodes: [] } };
  return Response.json({ data: { p0: project } });
}) as typeof fetch;
after(() => {
  globalThis.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
});

const { ME, mr } = await import('./auto/testkit.js');
const { fetchInbox, inboxRows } = await import('./inbox.js');
const { changeSettings } = await import('./data/store.js');
type InboxInput = import('./inbox.js').InboxInput;

function input(over: Partial<InboxInput> = {}): InboxInput {
  return { mrs: [], me: ME, queue: [], watches: {}, agents: new Map(), threads: new Map(), verdicts: {}, ...over };
}

const queued = (iid: number): QueuedComment => ({
  id: `q${iid}`, projectPath: 'acme/engine', projectId: 1001, iid, webUrl: 'https://x', severity: 'MINOR',
  body: 'b', createdAt: '', createdBy: 'agent', status: 'pending',
});

test('a finding waiting to be posted puts its MR first, waiting on you', () => {
  const rows = inboxRows(input({ mrs: [mr({ iid: 1 }), mr({ iid: 2 })], queue: [queued(2)] }));
  assert.deepEqual(rows.map((r) => [r.mr.iid, r.mood, r.phase, r.count]), [
    [2, 'awaitingYou', 'ready', 1],
    [1, 'quiet', 'none', 0],
  ]);
});

test('an agent working on a watched MR reads as a review in flight', () => {
  const watch = { key: 'acme/engine!1', projectPath: 'acme/engine', iid: 1, webUrl: 'https://x', auto: false, terminal: 't1', seen: { sha: 'head-1', pipeline: 'SUCCESS' as const, notes: 3, approvals: 0 }, addedAt: '' };
  const rows = inboxRows(input({
    mrs: [mr({ iid: 1 })],
    watches: { [watch.key]: watch },
    agents: new Map([['t1', { alive: true, working: true }]]),
  }));
  assert.equal(rows[0]?.mood, 'reviewing');
  assert.equal(rows[0]?.agent, 'working');
});

test('your approval is named on the row', () => {
  const rows = inboxRows(input({ mrs: [mr({ approvedBy: [ME] })] }));
  assert.equal(rows[0]?.mood, 'approved');
  assert.equal(rows[0]?.verdict, 'YOU APPROVED');
});

test('the inbox lists its agents from Claude Code, and runs nothing to do it', async () => {
  writeFileSync(join(dir, 'repos.json'), JSON.stringify({ at: new Date().toISOString(), repos: [{ path: 'acme/engine', label: 'Engine' }] }));
  let asked = 0;
  terminalList = () => {
    asked += 1;
    return Promise.reject(new Error('spawn ENOENT'));
  };
  const data = await fetchInbox();
  assert.equal(asked, 0);
  assert.deepEqual([data.terminals, data.terminalsError], [[], undefined]);
});

test('a to-do list GitLab would not give comes back as todosError, never as an empty list', async () => {
  const data = await fetchInbox();
  assert.equal(data.todos, undefined);
  assert.match(data.todosError ?? '', /\S/);
});

test('your own post on a watched MR does not mark it changed, and someone else\'s does', async () => {
  const { toggleWatch } = await import('./actions/watch.js');
  const { noteOwnActivity, loadState } = await import('./data/store.js');
  const watched = mr({ notes: 3 });
  toggleWatch(watched);
  noteOwnActivity(watched.projectId, watched.iid, { notes: 1 });
  const watches = loadState().watches;
  const row = (notes: number) => inboxRows(input({ mrs: [mr({ notes, readAt: Date.now() + 1 })], watches }))[0];
  assert.equal(row(4)?.flags.changed, false, 'only your own post');
  assert.equal(row(5)?.flags.changed, true, 'and one more from someone else');
});

test('a Claude Code agent mid-turn reads as working, though its title has no spinner', async () => {
  const { agentStates } = await import('./inbox.js');
  const states = agentStates([{ handle: 'claude:a', title: 'review !1', agent: 'claude', connected: true, orphaned: false, working: true }]);
  assert.deepEqual(states.get('claude:a'), { alive: true, working: true });
});
