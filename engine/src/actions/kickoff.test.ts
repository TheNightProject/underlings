import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { promisify } from 'node:util';

const state = mkdtempSync(join(tmpdir(), 'kickoff-state-'));
const root = mkdtempSync(join(tmpdir(), 'kickoff-root-'));
process.env['UNDERLINGS_STATE_DIR'] = state;
process.env['ORCA_WORKSPACE_ROOT'] = root;
after(() => {
  rmSync(state, { recursive: true, force: true });
  rmSync(root, { recursive: true, force: true });
});

const FOLDER = { displayName: 'Acme', id: `repo1::${root}`, path: root, isMainWorktree: true };
const WORKSPACE_ID = `repo1::${root}::workspace:k1`;
let calls: string[][] = [];
let created: unknown = {};
let createFails: string | null = null;
let terminals: { handle: string; tabId: string; leafId: string }[] = [];
let agents: { paneKey: string; state: string }[] = [];
let slowCreate: Promise<void> | null = null;

async function reply(args: string[]): Promise<unknown> {
  const verb = args.slice(0, 2).join(' ');
  if (verb === 'worktree list') return { worktrees: [FOLDER] };
  if (verb === 'terminal list') return { terminals };
  if (verb === 'worktree ps') return { worktrees: [{ agents }] };
  if (verb === 'worktree create') {
    await slowCreate;
    return createFails ? null : created;
  }
  if (verb === 'terminal create') return { terminal: { handle: 'term_new' } };
  return {};
}

const fakeExecFile = Object.assign(() => undefined, {
  [promisify.custom]: async (_cmd: string, args: string[]) => {
    const bare = args.filter((a) => a !== '--json');
    calls.push(bare);
    const result = await reply(bare);
    const stdout = JSON.stringify(result === null ? { ok: false, error: { message: createFails } } : { ok: true, result });
    if (result === null) throw Object.assign(new Error('exit 1'), { stdout });
    return { stdout, stderr: '' };
  },
});
Object.assign(childProcess, { execFile: fakeExecFile });
syncBuiltinESMExports();
const { kickoffPrompt, kickoffRunAlive, launchKickoff } = await import('./launch.js');
const { changeSettings, loadRuns, recordRun } = await import('../data/store.js');
// These are the Orca host's launches, the fallback a state file that names agentHost orca keeps, with the kickoff command of your own it ran.
changeSettings((s) => ({ ...s, agentHost: 'orca', agents: { ...s.agents, kickoffCommand: '/team:kickoff' } }));

const KEY = 'ABC-1234';
const URL = 'https://example.atlassian.net/browse/ABC-1234';
const flag = (args: string[] | undefined, name: string) => args?.[args.indexOf(name) + 1];
const find = (verb: string) => calls.find((c) => `${c[0]} ${c[1]}` === verb);
const writes = () => calls.filter((c) => ['worktree create', 'terminal create', 'terminal send'].includes(`${c[0]} ${c[1]}`));

beforeEach(() => {
  calls = [];
  created = { worktree: { id: WORKSPACE_ID, path: root }, launch: { outcome: { kind: 'terminal', handle: 'term_agent' } } };
  createFails = null;
  terminals = [];
  agents = [];
  slowCreate = null;
  writeFileSync(join(state, 'runs.json'), '{}');
});

test('the kickoff prompt runs the kickoff skill on the ticket, then says to ask before anything leaves the machine', () => {
  assert.equal(kickoffPrompt(KEY), [
    '/team:kickoff ABC-1234',
    'Before any git push, merge request, Jira transition or comment, stop and ask me with the AskUserQuestion tool and wait for my answer.',
  ].join('\n'));
});

test('a kickoff starts claude in a workspace of the folder repo named for the ticket, without taking focus', async () => {
  const outcome = await launchKickoff(KEY, URL);
  const create = find('worktree create');
  assert.equal(flag(create, '--repo'), 'id:repo1');
  assert.equal(flag(create, '--name'), 'kickoff-ABC-1234');
  assert.equal(flag(create, '--agent'), 'claude');
  assert.equal(flag(create, '--surface'), 'terminal');
  assert.equal(flag(create, '--prompt'), kickoffPrompt(KEY));
  assert.ok(!create?.includes('--activate') && !create?.includes('--focus'));
  assert.deepEqual(outcome, { how: 'worktree', handle: 'term_agent', name: 'kickoff-ABC-1234' });
  assert.deepEqual(writes().map((c) => `${c[0]} ${c[1]}`), ['worktree create']);
});

test('the run is recorded under the ticket with the agent terminal and marked a kickoff, so the page can find and answer it', async () => {
  await launchKickoff(KEY, URL);
  const run = loadRuns()[`ticket:${KEY}`];
  assert.deepEqual([run?.status, run?.terminal, run?.webUrl, run?.kickoff], ['running', 'term_agent', URL, true]);
});

test('an older Orca that answers with agentTerminalHandle still names the agent', async () => {
  created = { worktree: { id: WORKSPACE_ID }, agentTerminalHandle: 'term_old' };
  assert.equal((await launchKickoff(KEY)).handle, 'term_old');
  assert.equal(loadRuns()[`ticket:${KEY}`]?.terminal, 'term_old');
});

test('with no agent handle the prompt goes to the startup terminal, and no terminal is opened by path', async () => {
  created = { worktree: { id: WORKSPACE_ID }, startupTerminal: { handle: 'term_startup' } };
  const outcome = await launchKickoff(KEY);
  assert.equal(find('terminal create'), undefined);
  const send = find('terminal send');
  assert.deepEqual([flag(send, '--terminal'), flag(send, '--text')], ['term_startup', kickoffPrompt(KEY)]);
  assert.deepEqual([outcome.how, outcome.handle], ['terminal', 'term_startup']);
});

test('with neither, a terminal opens in the new workspace by its id', async () => {
  created = { worktree: { id: WORKSPACE_ID } };
  const outcome = await launchKickoff(KEY);
  assert.equal(flag(find('terminal create'), '--worktree'), `id:${WORKSPACE_ID}`);
  assert.equal(outcome.handle, 'term_new');
});

test('a second start is refused while the last kickoff agent is still on its terminal, even one that ended its turn', async () => {
  recordRun(`ticket:${KEY}`, { webUrl: URL, startedAt: '2026-11-05T09:00:00Z', status: 'running', terminal: 'term_old' });
  terminals = [{ handle: 'term_old', tabId: 'tab1', leafId: 'leaf1' }];
  for (const agentState of ['working', 'waiting', 'done']) {
    agents = [{ paneKey: 'tab1:leaf1', state: agentState }];
    assert.equal(await kickoffRunAlive(KEY), true, agentState);
    await assert.rejects(launchKickoff(KEY), /an agent is still open on ABC-1234/);
  }
  assert.deepEqual(writes(), []);
  agents = [];
  assert.equal(await kickoffRunAlive(KEY), false, 'its terminal has no agent left in it');
  await launchKickoff(KEY);
  assert.equal(writes().length, 1);
});

test('two starts at once launch one agent', async () => {
  let release = () => {};
  slowCreate = new Promise((resolve) => { release = resolve; });
  const both = Promise.allSettled([launchKickoff(KEY), launchKickoff(KEY)]);
  release();
  const [first, second] = await both;
  assert.equal(first.status, 'fulfilled');
  assert.match(String(second.status === 'rejected' && second.reason), /an agent is already starting on ABC-1234/);
  assert.equal(calls.filter((c) => c[1] === 'create').length, 1);
});

test("Orca's refusal is kept on the run, and a key that is not a Jira key starts nothing", async () => {
  createFails = 'no such repo';
  await assert.rejects(launchKickoff(KEY), /no such repo/);
  const run = loadRuns()[`ticket:${KEY}`];
  assert.equal(run?.status, 'launch failed');
  assert.match(String(run?.tail?.[0]), /no such repo/);
  assert.equal(await kickoffRunAlive(KEY), false, 'a failed launch does not block the next one');
  calls = [];
  await assert.rejects(launchKickoff('ABC-1; rm -rf ~'), /not a Jira key/);
  assert.deepEqual(calls, []);
});
