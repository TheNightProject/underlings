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
process.env['UNDERLINGS_CODE_FOLDER'] = root;
process.env['UNDERLINGS_CLAUDE_BIN'] = join(fixtures, 'fake-claude.mjs');
process.env['FAKE_CLAUDE_FIRST'] = join(fixtures, 'question.jsonl');
process.env['FAKE_CLAUDE_RESUME'] = join(fixtures, 'resume.jsonl');

let calls: string[][] = [];
const fakeExecFile = Object.assign(() => undefined, {
  [promisify.custom]: async (file: string, args: string[]) => {
    calls.push([file, ...args]);
    return { stdout: '', stderr: '' };
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

const MR = { projectPath: 'acme/engine', repoLabel: 'Engine', iid: 7, webUrl: 'https://gitlab.com/acme/engine/-/merge_requests/7' } as Mr;

after(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => {
  calls = [];
  saveSettings({ ...DEFAULT_SETTINGS, closeWorkspaceWhenDone: false });
});
afterEach(async () => {
  for (const agent of await claudeHost.agents()) await claudeHost.removeWorkspace(agent.handle);
});

test('a review starts as Claude Code in the code folder, and nothing else is run to start it', async () => {
  const outcome = await launchReview(MR, 'review it');
  assert.deepEqual(calls, []);
  assert.equal(outcome.how, 'claude');
  assert.equal(outcome.path, root);
  const agentFile = join(root, 'state', 'agents', (outcome.handle ?? '').slice('claude:'.length), 'agent.json');
  const recorded = JSON.parse(readFileSync(agentFile, 'utf8')) as { name: string; cwd: string; title: string; kind: string; mr: string };
  assert.deepEqual([recorded.name, recorded.cwd, recorded.title, recorded.kind, recorded.mr], ['review-Engine-7', root, 'review !7', 'review', 'acme/engine!7']);
});

test('the agents and their workspaces listed are Claude Code\'s', async () => {
  const { handle } = await launchReview(MR, 'review it');
  assert.deepEqual((await hosts.listAgentTerminals()).map((t) => t.handle), [handle]);
  assert.deepEqual((await hosts.listWorktrees()).map((w) => w.id), [handle]);
});

test('a Claude Code agent is read, stopped and removed through its host', async () => {
  const { handle = '' } = await launchReview(MR, 'review it');
  await hosts.readTerminal(handle);
  assert.notEqual(await hosts.agentStateOn(handle), null);
  await hosts.removeWorktree(handle);
  assert.equal(await hosts.agentStateOn(handle), null);
  assert.deepEqual(calls, []);
});

test('an agent an older build started in Orca reads as gone, and nothing is asked about it', async () => {
  assert.equal(await hosts.agentStateOn('term_orca'), null, 'no host means no agent, so a launch waiting on it goes ahead');
  await assert.rejects(hosts.readTerminal('term_orca'), /ran in Orca, which is no longer used/);
  await assert.rejects(hosts.removeWorktree('repo-1::/work::workspace:r1'), /ran in Orca/);
  assert.deepEqual(calls, []);
});

test('where agents run is no longer a setting, and an old agentHost is dropped', () => {
  assert.ok(!SETTING_ROWS.some((r) => String(r.key) === 'agentHost'));
  assert.deepEqual(updateSettings({ agentHost: 'orca' }).dropped, ['agentHost']);
});
