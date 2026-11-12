import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { chmodSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import type { Mr } from '../types.js';

const root = mkdtempSync(join(tmpdir(), 'agent-hosts-'));
const fixtures = fileURLToPath(new URL('../fixtures/claude/', import.meta.url));
chmodSync(join(fixtures, 'fake-claude.mjs'), 0o755);
process.env['UNDERLINGS_STATE_DIR'] = join(root, 'state');
process.env['ORCA_WORKSPACE_ROOT'] = root;
process.env['UNDERLINGS_ORCA_REPO_ID'] = 'repo-1';
process.env['UNDERLINGS_CLAUDE_BIN'] = join(fixtures, 'fake-claude.mjs');
process.env['FAKE_CLAUDE_FIRST'] = join(fixtures, 'question.jsonl');
process.env['FAKE_CLAUDE_RESUME'] = join(fixtures, 'resume.jsonl');

let calls: string[][] = [];
let terminalListFails = false;
const ORCA: Record<string, unknown> = {
  'worktree create': { worktree: { id: 'repo-1::/work::workspace:r1', path: root }, launch: { outcome: { handle: 'term_agent' } } },
  'terminal list': { terminals: [{ handle: 'term_orca', title: '✳ claude', agentIdentity: 'claude', connected: true, orphaned: false, tabId: 't', leafId: 'l' }] },
  'worktree ps': { worktrees: [] },
  'worktree list': { worktrees: [] },
};
const fakeExecFile = Object.assign(() => undefined, {
  [promisify.custom]: async (_file: string, args: string[]) => {
    const bare = args.filter((a) => a !== '--json');
    calls.push(bare);
    const verb = bare.slice(0, 2).join(' ');
    if (verb === 'terminal list' && terminalListFails) throw Object.assign(new Error('spawn orca ENOENT'), { code: 'ENOENT' });
    return { stdout: JSON.stringify({ id: 'x', ok: true, result: ORCA[verb] ?? {} }), stderr: '' };
  },
});
Object.assign(childProcess, { execFile: fakeExecFile });
syncBuiltinESMExports();

const { launchReview } = await import('../actions/launch.js');
const { DEFAULT_SETTINGS, SETTING_ROWS } = await import('../settings.js');
const { saveSettings } = await import('../data/store.js');
const { updateSettings } = await import('../settingsedit.js');
const hosts = await import('./index.js');
const { claudeHost } = await import('./claude.js');
const { orcaHost } = await import('./orca.js');

const MR = { projectPath: 'acme/engine', repoLabel: 'Engine', iid: 7, webUrl: 'https://gitlab.com/acme/engine/-/merge_requests/7' } as Mr;
const verbs = (): string[] => calls.map((c) => `${c[0]} ${c[1]}`);
const orcaWrites = (): string[] => verbs().filter((v) => !['terminal list', 'worktree ps', 'worktree list'].includes(v));

after(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  calls = [];
  terminalListFails = false;
  saveSettings({ ...DEFAULT_SETTINGS, closeWorkspaceWhenDone: false });
});
afterEach(async () => {
  for (const agent of await claudeHost.agents()) await claudeHost.removeWorkspace(agent.handle);
});

const useOrca = (): void => saveSettings({ ...DEFAULT_SETTINGS, closeWorkspaceWhenDone: false, agentHost: 'orca' });

test('a review starts as Claude Code in the workspace root by default, named as Orca would name it, and Orca is asked nothing', async () => {
  const outcome = await launchReview(MR, 'review it');
  assert.deepEqual(calls, []);
  assert.equal(outcome.how, 'claude');
  assert.equal(outcome.path, root);
  const agentFile = join(root, 'state', 'agents', (outcome.handle ?? '').slice('claude:'.length), 'agent.json');
  const recorded = JSON.parse(readFileSync(agentFile, 'utf8')) as { name: string; cwd: string; title: string; kind: string; mr: string };
  assert.deepEqual([recorded.name, recorded.cwd, recorded.title, recorded.kind, recorded.mr], ['review-Engine-7', root, 'review !7', 'review', 'acme/engine!7']);
});

test('a state file that names agentHost orca launches the review in Orca again', async () => {
  useOrca();
  const outcome = await launchReview(MR, 'review it');
  assert.deepEqual(orcaWrites(), ['worktree create']);
  assert.deepEqual(outcome, { how: 'worktree', handle: 'term_agent', path: root });
});

test('by default the agents listed are Claude Code\'s alone, and an Orca that cannot list is never asked', async () => {
  terminalListFails = true;
  const { handle } = await launchReview(MR, 'review it');
  assert.deepEqual((await hosts.listAgentTerminals()).map((t) => t.handle), [handle]);
  assert.deepEqual((await hosts.listWorktrees()).map((w) => w.id), [handle]);
  assert.deepEqual(calls, []);
});

test('with agentHost orca both hosts are listed together, and an Orca that cannot list still fails the list', async () => {
  const { handle } = await launchReview(MR, 'review it');
  useOrca();
  assert.deepEqual((await hosts.listAgentTerminals()).map((t) => t.handle), ['term_orca', handle]);
  terminalListFails = true;
  await assert.rejects(hosts.listAgentTerminals(), /ENOENT/);
});

test('a Claude Code agent is read, stopped and removed through its own host, never through Orca', async () => {
  const { handle = '' } = await launchReview(MR, 'review it');
  calls = [];
  await hosts.readTerminal(handle);
  assert.notEqual(await hosts.agentStateOn(handle), null);
  await hosts.removeWorktree(handle);
  assert.deepEqual(calls, []);
  assert.equal(await hosts.agentStateOn(handle), null);
  await assert.rejects(hosts.focusTerminal(handle), /runs as Claude Code in the background/);
});

test('an Orca agent is read and removed through Orca while agentHost names it, and otherwise Orca is not asked about it', async () => {
  assert.equal(await hosts.agentStateOn('term_orca'), null, 'no host means no agent, so a launch waiting on it goes ahead');
  await assert.rejects(hosts.readTerminal('term_orca'), /ran in Orca, which agentHost no longer names/);
  await assert.rejects(hosts.removeWorktree('repo-1::/work::workspace:r1'), /ran in Orca/);
  await assert.rejects(hosts.focusTerminal('term_orca'), /ran in Orca/);
  assert.deepEqual(calls, []);
  useOrca();
  await hosts.readTerminal('term_orca');
  await hosts.removeWorktree('repo-1::/work::workspace:r1');
  assert.deepEqual(orcaWrites(), ['terminal read', 'worktree rm']);
});

test('stopping an Orca agent closes its terminal', async () => {
  await orcaHost.stop('term_orca');
  assert.deepEqual(calls, [['terminal', 'close', '--terminal', 'term_orca']]);
});

test('agentHost is claude unless it is set to orca, a choice of the two in either front end', () => {
  assert.equal(DEFAULT_SETTINGS.agentHost, 'claude');
  assert.deepEqual(SETTING_ROWS.find((r) => r.key === 'agentHost')?.choices?.map(([value]) => value), ['claude', 'orca']);
  assert.deepEqual(updateSettings({ agentHost: 'vm' }).dropped, ['agentHost']);
  assert.equal(hosts.launchHost(), claudeHost);
  assert.deepEqual(updateSettings({ agentHost: 'orca' }).applied, ['agentHost']);
  assert.equal(hosts.launchHost(), orcaHost);
  updateSettings({ agentHost: 'claude' });
  assert.equal(hosts.launchHost(), claudeHost);
  useOrca();
  assert.equal(hosts.launchHost(), orcaHost);
});
