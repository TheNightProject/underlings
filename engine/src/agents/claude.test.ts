import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { AgentSpec } from './host.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'claude-host-')));
const fixtures = fileURLToPath(new URL('../fixtures/claude/', import.meta.url));
const fixture = (name: string): string => join(fixtures, `${name}.jsonl`);
chmodSync(join(fixtures, 'fake-claude.mjs'), 0o755);
process.env['UNDERLINGS_STATE_DIR'] = join(root, 'state');
process.env['UNDERLINGS_CLAUDE_BIN'] = join(fixtures, 'fake-claude.mjs');
process.env['FAKE_CLAUDE_RESUME'] = fixture('resume');
process.env['ORCA_PANE_KEY'] = 'tab-1:leaf-1';
const { agentConversation, claudeAgents, claudeHost, replyToAgent, resumeCommand, stopAgent } = await import('./claude.js');
const { modelUsage } = await import('../models.js');
const { pluginDir } = await import('../plugin.js');

const PLUGIN = ['--plugin-dir', pluginDir()];

const workdir = join(root, 'work');
mkdirSync(workdir, { recursive: true });
const started: string[] = [];
let runs = 0;

after(() => rmSync(root, { recursive: true, force: true }));
afterEach(async () => {
  await Promise.all(started.splice(0).map((handle) => claudeHost.removeWorkspace(handle)));
  delete process.env['FAKE_CLAUDE_HOLD_MS'];
  delete process.env['FAKE_CLAUDE_HOLD_AT'];
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function until<T>(check: () => T | Promise<T>, what: string, ms = 15_000): Promise<NonNullable<T>> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) {
    const value = await check();
    if (value) return value as NonNullable<T>;
  }
  assert.fail(`gave up waiting for ${what}`);
}

interface FakeLine {
  argv?: string[];
  cwd?: string;
  orcaVars?: string[];
  subagentModel?: string | null;
  subagentForce?: string | null;
  stdin?: { type: string; message?: { content?: unknown }; response?: { request_id?: string; response?: Record<string, unknown> } };
}

// The fake appends a line at a time, so a read can land mid-line.
const completeLines = (text: string): string[] => text.slice(0, text.lastIndexOf('\n') + 1).split('\n').filter(Boolean);

async function launch(first: string, prompt = 'Ask me whether to say ready or steady', spec: Partial<AgentSpec> = {}): Promise<{ handle: string; fake: () => FakeLine[] }> {
  runs += 1;
  const log = join(root, `fake-${runs}.log`);
  process.env['FAKE_CLAUDE_FIRST'] = fixture(first);
  process.env['FAKE_CLAUDE_LOG'] = log;
  const { handle } = await claudeHost.start({ name: 'review-Engine-7', prompt, title: 'review !7', cwd: workdir, kind: 'review', ...spec });
  started.push(handle);
  const fake = (): FakeLine[] => (existsSync(log) ? completeLines(readFileSync(log, 'utf8')).map((l) => JSON.parse(l) as FakeLine) : []);
  return { handle, fake };
}

const stateOf = (handle: string): Promise<string | null> => claudeHost.stateOf(handle);
const sent = (fake: () => FakeLine[], type: string) => fake().flatMap((l) => (l.stdin?.type === type ? [l.stdin] : []));

test('an agent starts as claude run headless with stream-json both ways, on a session of its own, in the workspace it was given', async () => {
  const { handle, fake } = await launch('question');
  assert.match(handle, /^claude:[0-9a-f-]{36}$/);
  await until(() => fake()[0], 'the fake claude to start');
  const { argv, cwd } = fake()[0] ?? {};
  const tools = argv?.indexOf('--mcp-config') ?? -1;
  assert.deepEqual(argv?.filter((_, i) => i !== tools + 1), [
    '-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-prompt-tool', 'stdio',
    '--mcp-config', '--allowedTools', 'mcp__underlings__queue_findings', 'mcp__underlings__finish_review',
    ...PLUGIN, '--session-id', handle.slice('claude:'.length), '--name', 'review-Engine-7',
  ], 'a fresh install runs no agent in auto mode, so every unlisted action asks you, and every one has the plugin\'s skills');
  assert.equal(realpathSync(cwd ?? ''), workdir);
  await until(() => sent(fake, 'user')[0], 'the prompt');
  assert.equal(sent(fake, 'user')[0]?.message?.content, 'Ask me whether to say ready or steady');
});

test('with agentPermissions set to auto, an agent starts in Claude Code\'s auto mode', async () => {
  const { loadSettings, saveSettings } = await import('../data/store.js');
  saveSettings({ ...loadSettings(), agentPermissions: 'auto' });
  try {
    const { fake } = await launch('question');
    await until(() => fake()[0], 'the fake claude to start');
    assert.ok(fake()[0]?.argv?.join(' ').includes('--permission-mode auto'));
  } finally {
    saveSettings({ ...loadSettings(), agentPermissions: 'ask' });
  }
});

test('the spend cap in Settings reaches a review agent\'s claude, and never the chat or a message agent', async () => {
  const { loadSettings, saveSettings } = await import('../data/store.js');
  saveSettings({ ...loadSettings(), agentBudgetUsd: '3.25' });
  try {
    const review = await launch('question');
    await until(() => review.fake()[0], 'the fake claude to start');
    assert.ok(review.fake()[0]?.argv?.join(' ').includes('--max-budget-usd 3.25'));
    const chat = await launch('question', 'hello', { kind: 'message', args: [] });
    await until(() => chat.fake()[0], 'the message agent to start');
    assert.equal(chat.fake()[0]?.argv?.includes('--max-budget-usd'), false);
  } finally {
    saveSettings({ ...loadSettings(), agentBudgetUsd: '' });
  }
});

test('an agent past the most Settings allows at once is refused, and the panel\'s chat is never held back', async () => {
  const { loadSettings, saveSettings } = await import('../data/store.js');
  saveSettings({ ...loadSettings(), maxAgents: 1 });
  try {
    const first = await launch('question');
    await until(() => first.fake()[0], 'the first agent to start');
    await assert.rejects(launch('question'), /1 agent is running already, the most Settings allows at once/);
    const chat = await launch('question', 'hello', { kind: 'master', args: [] });
    assert.match(chat.handle, /^claude:/);
  } finally {
    saveSettings({ ...loadSettings(), maxAgents: 4 });
  }
});

test('nothing Orca put in the environment reaches the agent, so its hooks never report it as an Orca pane', async () => {
  const { fake } = await launch('question');
  await until(() => fake()[0], 'the fake claude to start');
  assert.deepEqual(fake()[0]?.orcaVars, []);
});

test('an agent that asks a question waits on you with the question and its options, and the answer goes back over stdin', async () => {
  const { handle, fake } = await launch('question');
  await until(async () => (await stateOf(handle)) === 'waiting', 'the question');
  const { pending, phase } = agentConversation(handle);
  assert.equal(phase, 'waiting');
  const question = pending?.questions?.[0];
  assert.equal(question?.question, 'Should I reply with the word "ready" or the word "steady"?');
  assert.deepEqual(question?.options.map((o) => o.label), ['ready', 'steady']);
  replyToAgent(handle, { answers: { [question?.question ?? '']: 'ready' } });
  const reply = await until(() => sent(fake, 'control_response')[0], 'the answer');
  assert.equal(reply.response?.request_id, pending?.id);
  assert.deepEqual(reply.response?.response, {
    behavior: 'allow',
    updatedInput: { questions: pending?.questions, answers: { [question?.question ?? '']: 'ready' } },
  });
  await until(async () => (await stateOf(handle)) === 'done', 'the turn to end');
  assert.deepEqual([agentConversation(handle).said, claudeAgents().find((a) => a.handle === handle)?.phase], ['ready', 'done']);
});

test('an answer that is not one of the options offered is refused before anything is sent', async () => {
  const { handle, fake } = await launch('question');
  await until(async () => (await stateOf(handle)) === 'waiting', 'the question');
  const question = agentConversation(handle).pending?.questions?.[0]?.question ?? '';
  assert.throws(() => replyToAgent(handle, { answers: { [question]: 'go' } }), /"go" is not one of the answers offered/);
  await sleep(400);
  assert.deepEqual(sent(fake, 'control_response'), []);
});

test('a typed reply to a question is the answer to it', async () => {
  const { handle, fake } = await launch('question');
  await until(async () => (await stateOf(handle)) === 'waiting', 'the question');
  const question = agentConversation(handle).pending?.questions?.[0]?.question ?? '';
  replyToAgent(handle, { text: 'neither, say go' });
  const reply = await until(() => sent(fake, 'control_response')[0], 'the answer');
  assert.deepEqual((reply.response?.response?.['updatedInput'] as { answers?: unknown }).answers, { [question]: 'neither, say go' });
});

test('a tool that needs permission waits on you as blocked, and a denial goes back with your reason', async () => {
  const { handle, fake } = await launch('permission', 'Run touch smoke.txt');
  await until(async () => (await stateOf(handle)) === 'blocked', 'the permission ask');
  const { pending } = agentConversation(handle);
  assert.deepEqual([pending?.tool, pending?.summary, pending?.questions], ['Bash', 'touch smoke.txt', null]);
  replyToAgent(handle, { allow: false, message: 'Not now, thanks.' });
  const reply = await until(() => sent(fake, 'control_response')[0], 'the denial');
  assert.deepEqual(reply.response?.response, { behavior: 'deny', message: 'Not now, thanks.' });
  await until(async () => (await stateOf(handle)) === 'done', 'the turn to end');
  assert.match(agentConversation(handle).said, /declined/);
});

test('allowing a permission ask runs the tool as it was asked for', async () => {
  const { handle, fake } = await launch('permission', 'Run touch smoke.txt');
  await until(async () => (await stateOf(handle)) === 'blocked', 'the permission ask');
  replyToAgent(handle, { allow: true });
  const reply = await until(() => sent(fake, 'control_response')[0], 'the approval');
  assert.deepEqual(reply.response?.response, { behavior: 'allow', updatedInput: { command: 'touch smoke.txt', description: 'Create smoke.txt in the current folder' } });
});

test('an agent is working while its turn runs, and done once it ends, when its process has gone', async () => {
  process.env['FAKE_CLAUDE_HOLD_MS'] = '1500';
  const { handle, fake } = await launch('resume', 'Reply with the word again');
  await until(() => sent(fake, 'user')[0], 'the prompt to reach claude');
  assert.equal(await stateOf(handle), 'working');
  const [listed] = await claudeHost.agents();
  assert.deepEqual([listed?.handle, listed?.agent, listed?.working, listed?.state], [handle, 'claude', true, 'working']);
  await until(async () => (await stateOf(handle)) === 'done', 'the turn to end');
  await until(() => !claudeAgents()[0]?.alive, 'the process to exit');
});

test('a follow-up once the turn has ended resumes the same session', async () => {
  const { handle, fake } = await launch('question');
  await until(async () => (await stateOf(handle)) === 'waiting', 'the question');
  const question = agentConversation(handle).pending?.questions?.[0]?.question ?? '';
  replyToAgent(handle, { answers: { [question]: 'ready' } });
  await until(() => !claudeAgents().find((a) => a.handle === handle)?.alive && agentConversation(handle).state === 'done', 'the first process to exit');
  await claudeHost.send(handle, 'Reply with only the word again.');
  await until(() => agentConversation(handle).said === 'again', 'the resumed turn');
  const resumed = fake().find((l) => l.argv?.includes('--resume'));
  assert.deepEqual(resumed?.argv?.slice(-2), ['--resume', handle.slice('claude:'.length)]);
  const you = agentConversation(handle).entries.filter((e) => e.kind === 'you').map((e) => ('text' in e ? e.text : ''));
  assert.deepEqual(you, ['Ask me whether to say ready or steady', 'ready', 'Reply with only the word again.']);
});

test('an answer to a question whose process has gone reaches the resumed session as a message', async () => {
  const { handle, fake } = await launch('question');
  await until(async () => (await stateOf(handle)) === 'waiting', 'the question');
  const question = agentConversation(handle).pending?.questions?.[0]?.question ?? '';
  const dir = join(root, 'state', 'agents', handle.slice('claude:'.length));
  const pid = Number(readFileSync(join(dir, 'runner.lock'), 'utf8'));
  process.kill(pid, 'SIGKILL');
  await until(() => !claudeAgents().find((a) => a.handle === handle)?.alive, 'the runner to die');
  assert.equal(await stateOf(handle), 'waiting', 'the question is still yours to answer');
  replyToAgent(handle, { answers: { [question]: 'steady' } });
  const resumedPrompt = await until(() => {
    const at = fake().findIndex((l) => l.argv?.includes('--resume'));
    return at >= 0 ? fake().slice(at).find((l) => l.stdin?.type === 'user')?.stdin : undefined;
  }, 'the resumed session to get the answer');
  assert.equal(resumedPrompt.message?.content, `My answers: "${question}" = "steady"`);
  await until(async () => (await stateOf(handle)) === 'done', 'the resumed turn to end');
});

test('stopping an agent ends its process, and it reads as done', async () => {
  process.env['FAKE_CLAUDE_HOLD_MS'] = '30000';
  const { handle, fake } = await launch('resume', 'Reply with the word again');
  await until(() => sent(fake, 'user')[0], 'the prompt to reach claude');
  await stopAgent(handle);
  assert.equal(claudeAgents()[0]?.alive, false);
  assert.equal(await stateOf(handle), 'done');
  assert.equal(agentConversation(handle).entries.at(-1)?.kind, 'note');
});

test('reading an agent gives its conversation as lines, and removing its workspace forgets it', async () => {
  const { handle } = await launch('permission', 'Run touch smoke.txt');
  await until(async () => (await stateOf(handle)) === 'blocked', 'the permission ask');
  const { tail, status } = await claudeHost.read(handle);
  assert.equal(status, 'running');
  assert.deepEqual(tail, ['> Run touch smoke.txt', '· Bash: touch smoke.txt', '? Allow Bash: touch smoke.txt']);
  const [workspace] = await claudeHost.workspaces();
  assert.deepEqual([workspace?.id, workspace?.displayName, workspace?.path, workspace?.branch], [handle, 'review-Engine-7', workdir, '']);
  await claudeHost.removeWorkspace(handle);
  assert.deepEqual(await claudeHost.agents(), []);
  assert.equal(await stateOf(handle), null);
});

test('opening an agent in a terminal resumes its session where it ran', async () => {
  const { handle } = await launch('question');
  assert.deepEqual(resumeCommand(handle), { cwd: workdir, argv: [process.env['UNDERLINGS_CLAUDE_BIN'], '--resume', handle.slice('claude:'.length), ...PLUGIN], env: {} });
});

const flagOf = (argv: string[] | undefined, name: string): string | undefined => (argv?.includes(name) ? argv[argv.indexOf(name) + 1] : undefined);

test('an agent starts on the model and effort Models names for its task, its subagents on the builders\' model, and keeps them on every resume and in Terminal though Models changes', async () => {
  const { loadSettings, saveSettings } = await import('../data/store.js');
  const before = loadSettings().models;
  saveSettings({ ...loadSettings(), models: { ...before, kickoff: { model: 'opus', effort: 'high' }, builders: { model: 'haiku', effort: 'default', force: true } } });
  try {
    const { handle, fake } = await launch('resume', 'Reply with the word again', { kind: 'kickoff' });
    const id = handle.slice('claude:'.length);
    const first = await until(() => fake()[0], 'the fake claude to start');
    assert.deepEqual([flagOf(first.argv, '--model'), flagOf(first.argv, '--effort'), first.subagentModel, first.subagentForce], ['opus', 'high', 'haiku', '1']);
    saveSettings({ ...loadSettings(), models: { ...before, kickoff: { model: 'sonnet', effort: 'low' } } });
    await until(() => !claudeAgents().find((a) => a.handle === handle)?.alive && agentConversation(handle).state === 'done', 'the first turn to end');
    await claudeHost.send(handle, 'Once more.');
    const resumed = await until(() => fake().find((l) => l.argv?.includes('--resume')), 'the resume');
    assert.deepEqual([flagOf(resumed.argv, '--model'), flagOf(resumed.argv, '--effort'), resumed.subagentModel, resumed.subagentForce], ['opus', 'high', 'haiku', '1'], 'a run already going keeps its model, and its builders forced');
    assert.deepEqual(resumeCommand(handle), { cwd: workdir, argv: [process.env['UNDERLINGS_CLAUDE_BIN'], '--resume', id, '--model', 'opus', '--effort', 'high', ...PLUGIN], env: { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku', CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' } });
    const listed = claudeAgents().find((a) => a.handle === handle);
    assert.deepEqual([listed?.model, listed?.effort, listed?.subagentModel, listed?.subagentForce, listed?.runningModel], ['opus', 'high', 'haiku', true, 'claude-haiku-5-5'], 'listed with what it was started on, forced or not, and what Claude Code says it runs');
    await until(() => agentConversation(handle).turns.length === 2, 'the resumed turn to end');
    await until(() => modelUsage().tokens['kickoff'] === 2 * 7291, 'each turn it ended to be counted under its task, the cache it wrote included');
  } finally {
    saveSettings({ ...loadSettings(), models: before });
  }
});

test('an agent\'s builders are forced only with the switch on and a builders model, on the first start, every resume and in Terminal, and the list says which', async () => {
  const { loadSettings, saveSettings } = await import('../data/store.js');
  const before = loadSettings().models;
  const cases = [
    { name: 'on', builders: { model: 'haiku', effort: 'default', force: true }, vars: { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku', CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' }, forced: true },
    { name: 'off', builders: { model: 'haiku', effort: 'default' }, vars: { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' }, forced: false },
    { name: 'no builders model', builders: { model: 'default', effort: 'default', force: true }, vars: {}, forced: false },
  ];
  try {
    for (const { name, builders, vars, forced } of cases) {
      saveSettings({ ...loadSettings(), models: { ...before, builders } });
      const { handle, fake } = await launch('resume', 'Reply with the word again', { kind: 'kickoff' });
      const first = await until(() => fake()[0], 'the fake claude to start');
      assert.deepEqual([first.subagentModel, first.subagentForce], [vars.CLAUDE_CODE_SUBAGENT_MODEL ?? null, vars.CLAUDE_CODE_SUBAGENT_MODEL_FORCE ?? null], `${name}: first start`);
      saveSettings({ ...loadSettings(), models: { ...before, builders: { model: 'sonnet', effort: 'default', force: !forced } } });
      await until(() => !claudeAgents().find((a) => a.handle === handle)?.alive && agentConversation(handle).state === 'done', 'the first turn to end');
      await claudeHost.send(handle, 'Once more.');
      const resumed = await until(() => fake().find((l) => l.argv?.includes('--resume')), 'the resume');
      assert.deepEqual([resumed.subagentModel, resumed.subagentForce], [first.subagentModel, first.subagentForce], `${name}: resume keeps what it started with`);
      assert.deepEqual(resumeCommand(handle).env, vars, `${name}: Terminal`);
      assert.equal(claudeAgents().find((a) => a.handle === handle)?.subagentForce, forced, `${name}: listed`);
      assert.equal(agentConversation(handle).subagentForce, forced, `${name}: in the agent window`);
    }
  } finally {
    saveSettings({ ...loadSettings(), models: before });
  }
});

test('an agent whose task follows the effort for every task starts claude with that effort, and keeps it once the effort for every task changes', async () => {
  const { loadSettings, saveSettings } = await import('../data/store.js');
  const before = loadSettings();
  saveSettings({ ...before, everyEffort: 'xhigh', models: { ...before.models, review: { model: 'sonnet', effort: 'same' } } });
  try {
    const { handle, fake } = await launch('question');
    const first = await until(() => fake()[0], 'the fake claude to start');
    assert.deepEqual([flagOf(first.argv, '--model'), flagOf(first.argv, '--effort')], ['sonnet', 'xhigh']);
    saveSettings({ ...loadSettings(), everyEffort: 'low' });
    assert.equal(flagOf(resumeCommand(handle).argv, '--effort'), 'xhigh');
    assert.equal(claudeAgents().find((a) => a.handle === handle)?.effort, 'xhigh', 'listed with the effort it got, not the setting that chose it');
  } finally {
    saveSettings(before);
  }
});

test('a handle that is not a Claude Code agent is refused rather than read as a path', async () => {
  assert.equal(await stateOf('claude:../../etc'), null);
  assert.throws(() => replyToAgent('claude:../x', { text: 'hi' }), /is not a Claude Code agent/);
});

test('a test that forgets the fake claude is refused before anything is recorded or started, rather than running the real one', async () => {
  const fake = process.env['UNDERLINGS_CLAUDE_BIN'];
  delete process.env['UNDERLINGS_CLAUDE_BIN'];
  try {
    await assert.rejects(claudeHost.start({ name: 'review-Engine-7', prompt: 'hi', title: 'review !7', cwd: workdir, kind: 'review' }), /refusing to start the real claude from a test/);
    assert.deepEqual(claudeAgents(), []);
  } finally {
    process.env['UNDERLINGS_CLAUDE_BIN'] = fake;
  }
});

const MASTER_ARGS = ['--mcp-config', '/cc/claude/mcp.json', '--settings', '/cc/claude/settings.json'];

test('the master agent runs with the arguments it was given and streams its reply, on its first start, on every resume and in Terminal', async () => {
  const { handle, fake } = await launch('resume', 'Reply with the word again', { kind: 'master', args: MASTER_ARGS });
  const id = handle.slice('claude:'.length);
  await until(() => fake()[0], 'the fake claude to start');
  assert.deepEqual(fake()[0]?.argv?.slice(8), ['--include-partial-messages', ...MASTER_ARGS, ...PLUGIN, '--session-id', id, '--name', 'review-Engine-7']);
  await until(() => !claudeAgents().find((a) => a.handle === handle)?.alive && agentConversation(handle).state === 'done', 'the first turn to end');
  await claudeHost.send(handle, 'Once more.');
  const resumed = await until(() => fake().find((l) => l.argv?.includes('--resume')), 'the resume');
  assert.deepEqual(resumed.argv?.slice(8), ['--include-partial-messages', ...MASTER_ARGS, ...PLUGIN, '--resume', id]);
  assert.deepEqual(resumeCommand(handle).argv, [process.env['UNDERLINGS_CLAUDE_BIN'], '--resume', id, ...MASTER_ARGS, ...PLUGIN]);
});

test('a message agent runs with the arguments it was given, without the master\'s streaming, on its first start, on every resume and in Terminal', async () => {
  const args = ['--mcp-config', '/cc/claude/mcp.json', '--settings', '/cc/claude/message-settings.json'];
  const { handle, fake } = await launch('resume', 'Reply with the word again', { kind: 'message', args });
  const id = handle.slice('claude:'.length);
  await until(() => fake()[0], 'the fake claude to start');
  assert.deepEqual(fake()[0]?.argv?.slice(8), [...args, ...PLUGIN, '--session-id', id, '--name', 'review-Engine-7']);
  await until(() => !claudeAgents().find((a) => a.handle === handle)?.alive && agentConversation(handle).state === 'done', 'the first turn to end');
  assert.equal(claudeAgents().find((a) => a.handle === handle)?.kind, 'message');
  await claudeHost.send(handle, 'Once more.');
  const resumed = await until(() => fake().find((l) => l.argv?.includes('--resume')), 'the resume');
  assert.deepEqual(resumed.argv?.slice(8), [...args, ...PLUGIN, '--resume', id]);
  assert.deepEqual(resumeCommand(handle).argv, [process.env['UNDERLINGS_CLAUDE_BIN'], '--resume', id, ...args, ...PLUGIN]);
});

test('an agent of any other kind is refused more arguments before anything is recorded or started', async () => {
  await assert.rejects(claudeHost.start({ name: 'review-Engine-7', prompt: 'hi', title: 'review !7', cwd: workdir, kind: 'review', args: MASTER_ARGS }), /takes no more/);
  assert.deepEqual(claudeAgents(), []);
});

test('the master agent shows its reply as it streams, keeps the stream out of its log, and drops it once the whole reply lands', async () => {
  process.env['FAKE_CLAUDE_HOLD_MS'] = '1500';
  process.env['FAKE_CLAUDE_HOLD_AT'] = 'assistant';
  const { handle } = await launch('stream', 'Say you are ready', { kind: 'master' });
  await until(() => agentConversation(handle).partial === 'Ready when you are.', 'the streamed reply');
  assert.equal(agentConversation(handle).said, '');
  const log = readFileSync(join(root, 'state', 'agents', handle.slice('claude:'.length), 'events.jsonl'), 'utf8');
  assert.doesNotMatch(log, /stream_event/);
  await until(() => !agentConversation(handle).alive && agentConversation(handle).state === 'done', 'the turn to end');
  assert.deepEqual([agentConversation(handle).said, agentConversation(handle).partial], ['Ready when you are.', null]);
});

test('a permission ask shows everything the tool was asked to do, and a question has no input to show', async () => {
  const { handle } = await launch('permission', 'Run touch smoke.txt');
  await until(async () => (await stateOf(handle)) === 'blocked', 'the permission ask');
  assert.equal(agentConversation(handle).pending?.input, JSON.stringify({ command: 'touch smoke.txt', description: 'Create smoke.txt in the current folder' }, null, 2));
});
