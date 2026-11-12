import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { promisify } from 'node:util';
import type { Mr } from '../types.js';

process.env['UNDERLINGS_STATE_DIR'] = mkdtempSync(join(tmpdir(), 'launch-handle-'));
process.env['UNDERLINGS_ORCA_REPO_ID'] = 'repo_1';

let calls: string[][] = [];
let replies: unknown[] = [];
let workspaces: unknown[] = [];
const fakeExecFile = Object.assign(() => undefined, {
  [promisify.custom]: (_binary: string, args: string[]) => {
    if (args[0] === 'worktree' && args[1] === 'ps') return Promise.resolve({ stdout: JSON.stringify({ ok: true, result: { worktrees: workspaces } }) });
    calls.push(args);
    return Promise.resolve({ stdout: JSON.stringify({ ok: true, result: replies.shift() ?? {} }) });
  },
});
Object.assign(childProcess, { execFile: fakeExecFile });
syncBuiltinESMExports();
const { launchReview } = await import('./launch.js');
// These are the Orca host's launches: the fallback a state file that names agentHost orca keeps.
(await import('../data/store.js')).changeSettings((s) => ({ ...s, agentHost: 'orca' }));

const MR = { repoLabel: 'Engine', iid: 7, webUrl: 'https://gitlab.com/g/engine/-/merge_requests/7' } as Mr;
const verbs = (): string[] => calls.map((a) => `${a[0]} ${a[1]}`);

beforeEach(() => {
  calls = [];
  replies = [];
  workspaces = [];
});

test('the agent Orca reports under launch.outcome is the review, and no second terminal opens', async () => {
  replies = [{ worktree: { path: '/work/review-Engine-7' }, launch: { outcome: { kind: 'terminal', handle: 'term_agent' } } }];
  const outcome = await launchReview(MR, 'review it');
  assert.deepEqual(outcome, { how: 'worktree', handle: 'term_agent', path: '/work/review-Engine-7' });
  assert.deepEqual(verbs(), ['worktree create']);
});

test('the review agent is asked for as a terminal, because the verdict is read from its terminal', async () => {
  replies = [{ launch: { outcome: { kind: 'terminal', handle: 'term_agent' } } }];
  await launchReview(MR, 'review it');
  const create = calls[0] ?? [];
  assert.equal(create[create.indexOf('--surface') + 1], 'terminal');
});

test('an older host that answers with agentTerminalHandle still launches', async () => {
  replies = [{ agentTerminalHandle: 'term_old' }];
  assert.equal((await launchReview(MR, 'review it')).handle, 'term_old');
});

test('with no agent handle the prompt goes to the terminal named inside the create reply', async () => {
  replies = [{ worktree: { path: '/work/review-Engine-7' } }, { terminal: { handle: 'term_new', title: 'review !7' } }, {}];
  const outcome = await launchReview(MR, 'review it');
  assert.deepEqual(verbs(), ['worktree create', 'terminal create', 'terminal send']);
  const send = calls[2] ?? [];
  assert.equal(send[send.indexOf('--terminal') + 1], 'term_new');
  assert.equal(outcome.handle, 'term_new');
});

test('a startup terminal without an agent handle gets the prompt and no new terminal', async () => {
  replies = [{ startupTerminal: { handle: 'term_startup' } }, {}];
  const outcome = await launchReview(MR, 'review it');
  assert.deepEqual(verbs(), ['worktree create', 'terminal send']);
  assert.equal(outcome.handle, 'term_startup');
});

const previous = (states: string[]) => ({ worktreeId: 'repo_1::/work/review-Engine-7', displayName: 'review-Engine-7', path: '/work', branch: '', isMainWorktree: false, agents: states.map((state) => ({ state })) });

test('a finished review of the same MR has its workspace removed by id, without force, before the next one starts', async () => {
  workspaces = [previous(['done'])];
  replies = [{}, { agentTerminalHandle: 'term_new' }];
  await launchReview(MR, 'review it');
  assert.deepEqual(calls[0], ['worktree', 'rm', '--worktree', 'id:repo_1::/work/review-Engine-7', '--json']);
  assert.deepEqual(verbs(), ['worktree rm', 'worktree create']);
  assert.ok(!calls.flat().includes('--force'));
});

test('a previous review with an agent still going keeps its workspace', async () => {
  for (const states of [['working'], ['done', 'waiting']]) {
    calls = [];
    workspaces = [previous(states)];
    replies = [{ agentTerminalHandle: 'term_new' }];
    await launchReview(MR, 'review it');
    assert.deepEqual(verbs(), ['worktree create'], states.join());
  }
});
