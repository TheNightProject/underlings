import assert from 'node:assert/strict';
import { test } from 'node:test';
import { STATE_DIR } from '../config.js';
import type { AgentFile } from './claudefiles.js';
import { claudeArgs, sessionEnv } from './runner.js';

const file = { id: 'a1', name: 'review-Engine-7', title: 'review !7', cwd: '/work', createdAt: '2026-11-10T09:00:00Z' };

test('an agent runs in auto mode unless it was started with permissions set to ask, on a resume too', () => {
  assert.deepEqual(claudeArgs(file, false).slice(8, 10), ['--permission-mode', 'auto']);
  assert.deepEqual(claudeArgs(file, true).slice(8), ['--permission-mode', 'auto', '--resume', 'a1']);
  assert.deepEqual(claudeArgs({ ...file, permissions: 'ask' }, true).slice(8), ['--resume', 'a1']);
});

test('an agent started with a spend cap passes it to every claude it runs, and one without passes none', () => {
  const capped = { ...file, kind: 'review' as const, budgetUsd: '2.50' };
  assert.deepEqual(claudeArgs(capped, false).slice(8, 12), ['--permission-mode', 'auto', '--max-budget-usd', '2.50']);
  const resumed = claudeArgs(capped, true);
  assert.deepEqual([resumed[resumed.indexOf('--max-budget-usd') + 1], resumed.slice(-2)], ['2.50', ['--resume', 'a1']]);
  assert.equal(claudeArgs(file, false).includes('--max-budget-usd'), false);
});

test('the master agent streams its reply and takes its own arguments before the session, and no other kind does either', () => {
  const master = { ...file, kind: 'master' as const, args: ['--settings', '/s.json'] };
  assert.deepEqual(claudeArgs(master, false).slice(8), ['--permission-mode', 'auto', '--include-partial-messages', '--settings', '/s.json', '--session-id', 'a1', '--name', 'review-Engine-7']);
  assert.deepEqual(claudeArgs(master, true).slice(8), ['--permission-mode', 'auto', '--include-partial-messages', '--settings', '/s.json', '--resume', 'a1']);
  assert.deepEqual(claudeArgs({ ...file, kind: 'fix', args: ['--settings', '/s.json'] }, true).slice(8), ['--permission-mode', 'auto', '--resume', 'a1']);
});

test('a review agent, and only a review agent, gets the queue tools, allowed without asking, on a resume too', () => {
  for (const resume of [false, true]) {
    const args = claudeArgs({ ...file, kind: 'review', args: ['--settings', '/s.json'] }, resume);
    const config = JSON.parse(args[args.indexOf('--mcp-config') + 1] ?? '{}') as { mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }> };
    assert.deepEqual(Object.keys(config.mcpServers), ['underlings']);
    const server = config.mcpServers.underlings;
    assert.match(server?.args.at(-1) ?? '', /reviewserver\.(js|ts)$/);
    assert.equal(server?.env['ELECTRON_RUN_AS_NODE'], '1', 'the app\'s own Electron runs it as node');
    assert.equal(server?.env['UNDERLINGS_STATE_DIR'], STATE_DIR, 'it writes the queue this front end reads');
    assert.deepEqual(args.slice(args.indexOf('--allowedTools') + 1, args.indexOf('--allowedTools') + 3), ['mcp__underlings__queue_findings', 'mcp__underlings__finish_review']);
    assert.ok(!args.includes('/s.json'), 'a review agent still takes no arguments of its own');
  }
  for (const kind of ['fix', 'kickoff', 'ticket', 'master', 'message'] as const) assert.ok(!claudeArgs({ ...file, kind }, false).includes('--mcp-config'), kind);
  assert.ok(!claudeArgs(file, false).includes('--mcp-config'));
});

test('a message agent takes its own arguments before the session too, but does not stream its reply', () => {
  const message = { ...file, kind: 'message' as const, args: ['--settings', '/m.json'] };
  assert.deepEqual(claudeArgs(message, false).slice(8), ['--permission-mode', 'auto', '--settings', '/m.json', '--session-id', 'a1', '--name', 'review-Engine-7']);
  assert.deepEqual(claudeArgs(message, true).slice(8), ['--permission-mode', 'auto', '--settings', '/m.json', '--resume', 'a1']);
});

test('an agent runs every claude on the model and effort it was started with, and one started on Claude Code\'s default passes neither', () => {
  const chosen = { ...file, kind: 'fix' as const, model: 'claude-opus-5-5[1m]', effort: 'xhigh' };
  for (const resume of [false, true]) {
    const args = claudeArgs(chosen, resume);
    assert.deepEqual(args.slice(args.indexOf('--model'), args.indexOf('--model') + 4), ['--model', 'claude-opus-5-5[1m]', '--effort', 'xhigh'], resume ? 'on a resume' : 'on the first start');
  }
  const message = claudeArgs({ ...file, kind: 'message', model: 'haiku', args: ['--settings', '/m.json'] }, false);
  assert.ok(message.indexOf('--model') < message.indexOf('--settings'), 'before the agent\'s own arguments');
  for (const resume of [false, true]) assert.ok(!claudeArgs({ ...file, kind: 'fix' }, resume).some((a) => a === '--model' || a === '--effort'));
});

test('an agent\'s subagents start on the builders\' model it was started with, and on Claude Code\'s own choice without one', () => {
  const env = { PATH: '/usr/bin', HOME: '/home/frank' };
  assert.equal(sessionEnv({ ...file, kind: 'kickoff', subagentModel: 'haiku' }, '/bin/claude', env)['CLAUDE_CODE_SUBAGENT_MODEL'], 'haiku');
  assert.equal('CLAUDE_CODE_SUBAGENT_MODEL' in sessionEnv({ ...file, kind: 'kickoff' }, '/bin/claude', env), false);
});

test('an agent forces its subagents onto the builders\' model only when it was started with the switch on and a model, in every kind, and not otherwise', () => {
  const env = { PATH: '/usr/bin', HOME: '/home/frank' };
  const forceOf = (extra: Partial<AgentFile>, kind: AgentFile['kind']) => sessionEnv({ ...file, kind, ...extra }, '/bin/claude', env)['CLAUDE_CODE_SUBAGENT_MODEL_FORCE'];
  for (const kind of ['review', 'fix', 'kickoff', 'ticket', 'master', 'message'] as const) {
    assert.equal(forceOf({ subagentModel: 'haiku', subagentForce: true }, kind), '1', `${kind} on`);
    assert.equal(forceOf({ subagentModel: 'haiku', subagentForce: false }, kind), undefined, `${kind} off`);
    assert.equal(forceOf({ subagentModel: 'haiku' }, kind), undefined, `${kind} from before the switch`);
    assert.equal(forceOf({ subagentForce: true }, kind), undefined, `${kind} with no builders model`);
  }
  assert.equal(sessionEnv({ ...file, subagentModel: 'haiku', subagentForce: true }, '/bin/claude', env)['CLAUDE_CODE_SUBAGENT_MODEL'], 'haiku');
  assert.equal('CLAUDE_CODE_SUBAGENT_MODEL' in sessionEnv({ ...file, subagentForce: true }, '/bin/claude', env), false);
});

test('the master, message and review agents wait for their MCP servers before the first turn, so each has its tools from the start', () => {
  const env = { PATH: '/usr/bin', HOME: '/home/frank' };
  for (const kind of ['master', 'message', 'review'] as const) assert.equal(sessionEnv({ ...file, kind }, '/bin/claude', env)['MCP_CONNECTION_NONBLOCKING'], 'false', kind);
  assert.equal('MCP_CONNECTION_NONBLOCKING' in sessionEnv({ ...file, kind: 'fix' }, '/bin/claude', env), false);
  assert.equal('MCP_CONNECTION_NONBLOCKING' in sessionEnv(file, '/bin/claude', env), false);
});
