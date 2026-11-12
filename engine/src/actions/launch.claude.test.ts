import assert from 'node:assert/strict';
import childProcess, { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Discussion } from '../data/gitlab.js';
import type { Mr } from '../types.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'launch-claude-')));
const fixtures = fileURLToPath(new URL('../fixtures/claude/', import.meta.url));
chmodSync(join(fixtures, 'fake-claude.mjs'), 0o755);
process.env['UNDERLINGS_STATE_DIR'] = join(root, 'state');
process.env['ORCA_WORKSPACE_ROOT'] = root;
process.env['UNDERLINGS_CLAUDE_BIN'] = join(fixtures, 'fake-claude.mjs');
process.env['FAKE_CLAUDE_FIRST'] = join(fixtures, 'question.jsonl');
process.env['FAKE_CLAUDE_RESUME'] = join(fixtures, 'resume.jsonl');

const git = (...args: string[]): string => execFileSync('git', args, { cwd: root, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' } });
git('init', '--quiet', '--bare', '-b', 'main', 'origin.git');
git('clone', '--quiet', 'origin.git', 'engine');
for (const args of [['config', 'user.email', 't@example.com'], ['config', 'user.name', 'T'], ['commit', '--quiet', '--allow-empty', '-m', 'one'], ['push', '--quiet', 'origin', 'HEAD:main', 'HEAD:feat/88']]) {
  git('-C', 'engine', ...args);
}

// Orca must never be asked, and a call that reaches it is recorded and refused rather than run.
const orcaCalls: string[][] = [];
const realExecFile = promisify(childProcess.execFile);
Object.assign(childProcess, {
  execFile: Object.assign(() => undefined, {
    [promisify.custom]: (file: string, args: string[], options?: object) => {
      if (/(^|\/)orca$/.test(file)) {
        orcaCalls.push(args);
        return Promise.reject(new Error('Orca was asked'));
      }
      return realExecFile(file, args, options ?? {});
    },
  }),
});
syncBuiltinESMExports();

const { fixRunAlive, kickoffPrompt, kickoffRunAlive, launchFix, launchKickoff, launchTicket } = await import('./launch.js');
const { claudeAgents, claudeHost } = await import('../agents/claude.js');
const { changeSettings, loadRuns } = await import('../data/store.js');
const { fixBrief } = await import('../fix.js');
const { ticketPrompt } = await import('../config.js');

after(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  orcaCalls.length = 0;
});
afterEach(async () => {
  for (const agent of await claudeHost.agents()) await claudeHost.removeWorkspace(agent.handle);
  for (const line of git('-C', 'engine', 'worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).slice(1)) {
    git('-C', 'engine', 'worktree', 'remove', '--force', line.slice('worktree '.length));
  }
  const made = git('-C', 'engine', 'branch', '--format=%(refname:short)').split('\n').filter((b) => b && b !== 'main');
  if (made.length) git('-C', 'engine', 'branch', '-D', ...made);
  writeFileSync(join(root, 'state', 'runs.json'), '{}');
  assert.deepEqual(orcaCalls, [], 'nothing was asked of Orca');
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(check: () => T, what: string, ms = 15_000): Promise<NonNullable<T>> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) {
    const value = check();
    if (value) return value as NonNullable<T>;
  }
  assert.fail(`gave up waiting for ${what}`);
}

const KEY = 'acme/engine!88';
const THREADS: Discussion[] = [{ id: 'd1', resolved: false, resolvable: true, notes: [{ author: 'ivan', body: 'Rename this', createdAt: '2026-11-05T09:00:00Z', system: false }] }];
const mr = (): Mr => ({
  projectPath: 'acme/engine', projectId: 7, repoLabel: 'Engine', iid: 88, title: 'ABC-1234 Faster engine', webUrl: 'https://gitlab.com/acme/engine/-/merge_requests/88',
  draft: false, conflicts: false, notes: 1, author: 'frank', reviewers: [], approvedBy: [], pipeline: 'SUCCESS', mergeStatus: null,
  createdAt: '', updatedAt: '', sha: 'aaa111', sourceBranch: 'feat/88', ticket: 'ABC-1234', unresolvedThreads: 1,
});
const OPTS = { me: 'frank', head: 'aaa111', targetBranch: 'main' };
const agentFor = (handle: string | undefined) => claudeAgents().find((a) => a.handle === handle);
const firstPrompt = (handle: string): string => {
  const log = join(root, 'state', 'agents', handle.slice('claude:'.length), 'events.jsonl');
  const events = existsSync(log) ? readFileSync(log, 'utf8') : '';
  const sent = events.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { host?: { message?: { message?: { content?: string } } } });
  return sent.find((r) => r.host?.message?.message?.content)?.host?.message?.message?.content ?? '';
};

test('a fix starts as Claude Code in the workspace root, briefed to work in a git worktree of its branch cut beside the repos', async () => {
  const launched = await launchFix(mr(), THREADS, OPTS);
  const checkout = join(root, 'fix-Engine-88');
  assert.deepEqual([launched.how, launched.path, launched.name], ['claude', checkout, 'fix-Engine-88']);
  assert.equal(git('-C', checkout, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'fix-Engine-88');
  assert.match(git('-C', join(root, 'engine'), 'worktree', 'list'), new RegExp(`${checkout} `));
  const agent = agentFor(launched.handle);
  assert.deepEqual([agent?.kind, agent?.mr, agent?.worktree, agent?.cwd, agent?.title], ['fix', KEY, checkout, root, 'fix !88']);
  await until(() => agentFor(launched.handle)?.state === 'waiting', 'the agent to ask');
  assert.equal(firstPrompt(launched.handle ?? ''), fixBrief({ mr: mr(), targetBranch: 'main', threads: THREADS, checkout }));
  const run = loadRuns()[`fix:${KEY}`];
  assert.deepEqual([run?.status, run?.terminal, run?.worktreePath], ['running', launched.handle, checkout]);
});

test('a second fix waits while the last fix agent is still recorded, even one whose turn ended, and starts once it is removed', async () => {
  const { handle = '' } = await launchFix(mr(), THREADS, OPTS);
  assert.equal(git('-C', 'engine', 'branch', '--list', 'fix-Engine-88', '--format=%(refname:short)').trim(), 'fix-Engine-88');
  await until(() => agentFor(handle)?.state === 'waiting', 'the agent to ask');
  await claudeHost.stop(handle);
  assert.equal(agentFor(handle)?.state, 'done');
  assert.equal(await fixRunAlive(KEY), true);
  await assert.rejects(launchFix(mr(), THREADS, OPTS), /a fix agent is still open on !88/);
  await claudeHost.removeWorkspace(handle);
  assert.equal(await fixRunAlive(KEY), false);
  const again = await launchFix(mr(), THREADS, OPTS);
  assert.equal(again.name, 'fix-Engine-88-2', 'the first checkout and its branch are still there, so the second gets a name of its own');
});

test('a kickoff starts Claude Code in the workspace root on the kickoff prompt, recorded as the ticket\'s run', async () => {
  const launched = await launchKickoff('ABC-1234', 'https://example.atlassian.net/browse/ABC-1234');
  const agent = agentFor(launched.handle);
  assert.deepEqual([launched.how, launched.name, agent?.kind, agent?.ticket, agent?.cwd, agent?.worktree], ['claude', 'kickoff-ABC-1234', 'kickoff', 'ABC-1234', root, null]);
  await until(() => firstPrompt(launched.handle ?? ''), 'the prompt to be sent');
  assert.equal(firstPrompt(launched.handle ?? ''), kickoffPrompt('ABC-1234'));
  const run = loadRuns()['ticket:ABC-1234'];
  assert.deepEqual([run?.status, run?.terminal, run?.kickoff], ['running', launched.handle, true]);
  assert.equal(await kickoffRunAlive('ABC-1234'), true);
  await assert.rejects(launchKickoff('ABC-1234'), /an agent is still open on ABC-1234/);
});

test('a ticket from the terminal app cuts its checkout beside the repos and starts Claude Code told to work in it', async () => {
  const ticket = { key: 'ABC-12', summary: 'Fix it', status: 'To Do', labels: [], url: '' };
  const launched = await launchTicket(ticket, { path: 'acme/engine', label: 'Engine', dir: 'engine', prefix: 'eng' });
  const checkout = join(root, 'eng-abc-12');
  assert.ok(existsSync(join(checkout, '.git')), 'a git worktree');
  assert.deepEqual([launched.how, launched.path], ['claude', checkout]);
  const agent = agentFor(launched.handle);
  assert.deepEqual([agent?.kind, agent?.ticket, agent?.worktree, agent?.cwd], ['ticket', 'ABC-12', checkout, root]);
  await until(() => firstPrompt(launched.handle ?? ''), 'the prompt to be sent');
  assert.equal(firstPrompt(launched.handle ?? ''), ticketPrompt('ABC-12', 'Fix it', checkout));
});

test('a ticket finds its repo\'s checkout under the workspace root itself, and names the worktree with the ticket\'s own key', async () => {
  const ticket = { key: 'ABC-12', summary: 'Fix it', status: 'To Do', labels: [], url: '' };
  const launched = await launchTicket(ticket, { path: 'acme/engine', label: 'Engine' });
  const checkout = join(root, 'engine-abc-12');
  assert.deepEqual([launched.path, existsSync(join(checkout, '.git'))], [checkout, true]);
  assert.equal(git('-C', checkout, 'rev-parse', '--abbrev-ref', 'HEAD').trim(), 'fix/ABC-12-fix-it');
});

test('a ticket or fix with no checkout to start from says where to clone it and which setting to change', async () => {
  const ticket = { key: 'ABC-13', summary: 'Fix it', status: 'To Do', labels: [], url: '' };
  const said = new RegExp(`^Error: No checkout of acme/missing under ${root}\\. Clone it there as ${join(root, 'missing')}, or set Workspace root in Settings`);
  await assert.rejects(launchTicket(ticket, { path: 'acme/missing', label: 'Missing' }), said);
  await assert.rejects(launchFix({ ...mr(), projectPath: 'acme/missing' }, THREADS, OPTS), said);
});

test('a built-in kickoff with no checkouts under the workspace root starts nothing, and says what to set', async () => {
  const empty = realpathSync(mkdtempSync(join(tmpdir(), 'launch-empty-')));
  changeSettings((s) => ({ ...s, workspaceRoot: empty }));
  try {
    await assert.rejects(launchKickoff('ABC-77'), new RegExp(`^Error: No git checkouts under ${empty} to start a ticket in\\. Set Workspace root in Settings`));
    assert.equal(loadRuns()['ticket:ABC-77'], undefined, 'no run was recorded');
    changeSettings((s) => ({ ...s, agents: { ...s.agents, kickoffCommand: '/start' } }));
    const launched = await launchKickoff('ABC-77');
    await until(() => firstPrompt(launched.handle ?? ''), 'the prompt to be sent');
    assert.ok(firstPrompt(launched.handle ?? '').startsWith('/start ABC-77\n'), 'a command of your own finds its repos itself');
  } finally {
    changeSettings((s) => ({ ...s, workspaceRoot: '', agents: { ...s.agents, kickoffCommand: '' } }));
    rmSync(empty, { recursive: true, force: true });
  }
});

test('a Claude Code fix agent is listed in its worktree, so clean-up and run capture find the checkout', async () => {
  const { handle = '' } = await launchFix(mr(), THREADS, OPTS);
  const listed = (await claudeHost.agents()).find((t) => t.handle === handle);
  assert.equal(listed?.worktreePath, agentFor(handle)?.worktree);
});
