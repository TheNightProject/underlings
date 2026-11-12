import assert from 'node:assert/strict';
import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';
import { pathToFileURL } from 'node:url';

const HANDLE = 'claude:5f0c3b8e-9a6d-4c1e-8f2a-1b3c4d5e6f70';
const QUESTION = 'Should I reply with the word "ready" or the word "steady"?';
let world;

function agent(extra = {}) {
  return {
    handle: HANDLE, sessionId: HANDLE.slice(7), name: 'review-engine-7', title: 'review !7', cwd: "/Users/frank/Projects/Acme/it's here", createdAt: '2026-11-09T10:00:00Z',
    kind: 'review', mr: 'acme/engine!7', ticket: null, worktree: null, outcome: null,
    state: 'waiting', since: 1000, lastAt: 1500, alive: true, said: 'Which word?', phase: 'waiting', raisedMr: null,
    pending: { id: 'req-1', tool: 'AskUserQuestion', summary: 'AskUserQuestion', questions: [{ question: QUESTION, options: [{ label: 'ready' }, { label: 'steady' }] }] },
    entries: [{ kind: 'you', at: 1, text: 'Ask me' }], ...extra,
  };
}

function freshWorld() {
  return { agents: [agent()], replies: [], stops: [], ran: [], refuse: null, resumeEnv: {} };
}

mock.module('node:child_process', {
  namedExports: {
    execFile(cmd, args, options, done) {
      world.ran.push([cmd, ...args]);
      setImmediate(() => done(null, '', ''));
    },
  },
});

const engine = {
  fetchInbox: async () => ({ me: 'frank', repoCount: 0, mrs: [], fetchedAt: new Date().toISOString() }),
  claudeAgents: () => world.agents.map(({ entries, ...summary }) => summary),
  agentConversation(handle) {
    const found = world.agents.find((a) => a.handle === handle);
    if (!found) throw new Error(`no Claude Code agent ${handle} is recorded`);
    return found;
  },
  replyToAgent(handle, reply) {
    if (world.refuse) throw new Error(world.refuse);
    world.replies.push([handle, reply]);
  },
  async stopAgent(handle) {
    world.stops.push(handle);
    world.agents = world.agents.map((a) => ({ ...a, alive: false }));
  },
  resumeCommand: () => ({ cwd: agent().cwd, argv: ['/opt/homebrew/bin/claude', '--resume', HANDLE.slice(7)], env: world.resumeEnv }),
};

const engineDir = await mkdtemp(join(tmpdir(), 'control-centre-claude-'));
const engineFile = join(engineDir, 'engine.mjs');
engine.STATE_DIR = join(engineDir, 'state');
await writeFile(engineFile, '');
mock.module(pathToFileURL(engineFile).href, { namedExports: engine });
after(() => rm(engineDir, { recursive: true }));

const { afterAgentsMove, listAgents, ROUTES, start, stop } = await import('./claudeagents.mjs');
const { act } = await import('./actions.mjs');
const { loadEngine } = await import('./engine.mjs');
await loadEngine({ matrixEngine: engineFile }, () => {});

beforeEach(() => {
  world = freshWorld();
});

const EXPECT = { state: 'waiting', since: 1000, pending: 'req-1' };
const refused = async (promise, status, pattern) => {
  const err = await promise.then(() => assert.fail('it went through'), (e) => e);
  assert.equal(err.status, status, err.message);
  assert.match(err.message, pattern);
};

test('every Claude Code agent is listed with what it works for, its state, what it is doing and the question it asks, and nothing is asked of Orca', () => {
  assert.deepEqual(listAgents(), [{
    handle: HANDLE, name: 'review-engine-7', title: 'review !7', kind: 'review', mr: 'acme/engine!7', ticket: null, worktree: null, cwd: agent().cwd,
    state: 'waiting', since: 1000, lastAt: 1500, alive: true, said: 'Which word?', outcome: null, ask: agent().pending, background: [], phase: 'waiting', raisedMr: null,
    model: null, effort: null, subagentModel: null, subagentForce: false, runningModel: null,
  }]);
  world.agents = [agent({ phase: undefined, raisedMr: undefined })];
  assert.deepEqual([listAgents()[0].phase, listAgents()[0].raisedMr], [null, null], 'an engine from before phases says none');
  world.agents = [agent({ subagentModel: 'haiku', subagentForce: true })];
  assert.deepEqual([listAgents()[0].subagentModel, listAgents()[0].subagentForce], ['haiku', true], 'its builders\' model, and that it was forced');
  world.agents = [agent({ subagentModel: 'haiku' })];
  assert.equal(listAgents()[0].subagentForce, false, 'an engine from before the switch says not forced');
  assert.deepEqual(world.ran, []);
});

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('a runner writing to an agent\'s log tells the page and the notifier once its state moves, and only then', async () => {
  const told = [];
  const moved = [];
  start({}, { notify: (event) => told.push(event), log: () => {} });
  const unhook = afterAgentsMove(() => moved.push(Date.now()));
  try {
    const dir = join(engine.STATE_DIR, 'agents', HANDLE.slice(7));
    await mkdir(dir, { recursive: true });
    await appendFile(join(dir, 'events.jsonl'), '{"at":1}\n');
    await sleep(700);
    assert.deepEqual(told, [], 'output that leaves the state as it was is no event');
    world.agents = [agent({ state: 'working', since: 2000, pending: null })];
    await appendFile(join(dir, 'events.jsonl'), '{"at":2}\n');
    for (let i = 0; i < 40 && !told.length; i += 1) await sleep(50);
    assert.deepEqual(told, ['agents']);
    assert.equal(moved.length, 1);
  } finally {
    unhook();
    stop();
  }
});

test('a phase or a raised MR that moves while the state holds still tells the page too', async () => {
  const told = [];
  world.agents = [agent({ state: 'working', pending: null, phase: 'building' })];
  start({}, { notify: (event) => told.push(event), log: () => {} });
  const dir = join(engine.STATE_DIR, 'agents', HANDLE.slice(7));
  const wrote = async (n) => {
    await appendFile(join(dir, 'events.jsonl'), `{"at":${n}}\n`);
    for (let i = 0; i < 40 && told.length < n; i += 1) await sleep(50);
  };
  try {
    await mkdir(dir, { recursive: true });
    world.agents = [agent({ state: 'working', pending: null, phase: 'testing' })];
    await wrote(1);
    world.agents = [agent({ state: 'working', pending: null, phase: 'testing', raisedMr: 'acme/engine!58' })];
    await wrote(2);
    assert.deepEqual(told, ['agents', 'agents']);
  } finally {
    stop();
  }
});

test('the conversation is read by handle, and a handle that is not one is refused', async () => {
  const read = (handle) => ROUTES['GET /api/agents/conversation']({ query: new URLSearchParams({ handle }) });
  assert.equal((await read(HANDLE)).entries[0].text, 'Ask me');
  await refused(Promise.resolve().then(() => read('term_1')), 400, /handle must name a Claude Code agent/);
  await refused(Promise.resolve().then(() => read('claude:00000000-0000-4000-8000-000000000000')), 404, /no Claude Code agent/);
});

test('an answer, a permission and a typed reply each reach the engine as what they are', async () => {
  await act('agent-reply', { handle: HANDLE, answer: { question: QUESTION, label: 'ready' }, expect: EXPECT });
  await act('agent-reply', { handle: HANDLE, allow: false, expect: EXPECT });
  await act('agent-reply', { handle: HANDLE, text: 'say go', expect: EXPECT });
  assert.deepEqual(world.replies, [
    [HANDLE, { answers: { [QUESTION]: 'ready' } }],
    [HANDLE, { allow: false }],
    [HANDLE, { text: 'say go' }],
  ]);
});

test('a reply is refused once the agent has moved on from what the page saw, and without what it saw', async () => {
  await refused(act('agent-reply', { handle: HANDLE, text: 'hi', expect: { ...EXPECT, pending: 'req-0' } }), 409, /changed since you looked/);
  await refused(act('agent-reply', { handle: HANDLE, text: 'hi' }), 400, /did not send what it saw/);
  world.agents = [agent({ pending: null, state: 'done' })];
  await refused(act('agent-reply', { handle: HANDLE, allow: true, expect: { state: 'done', since: 1000, pending: null } }), 409, /not waiting on an answer/);
  assert.deepEqual(world.replies, []);
});

test('the engine refusing an answer comes back as a conflict in its words', async () => {
  world.refuse = '"go" is not one of the answers offered';
  await refused(act('agent-reply', { handle: HANDLE, answer: { question: QUESTION, label: 'go' }, expect: EXPECT }), 409, /"go" is not one of the answers offered/);
});

test('Stop stops a running agent and is refused on one that has finished', async () => {
  await act('agent-stop', { handle: HANDLE });
  assert.deepEqual(world.stops, [HANDLE]);
  await refused(act('agent-stop', { handle: HANDLE }), 409, /is not running/);
});

test('Open in Terminal stops the agent here first, then resumes its session in Terminal where it ran, quoted for the shell', async () => {
  const { text } = await act('agent-terminal', { handle: HANDLE });
  assert.equal(text, 'Opened review-engine-7 in Terminal, after stopping it here');
  assert.deepEqual(world.stops, [HANDLE]);
  const [cmd, ...args] = world.ran[0];
  assert.equal(cmd, '/usr/bin/osascript');
  assert.equal(args.at(-1), `cd '/Users/frank/Projects/Acme/it'\\''s here' && '/opt/homebrew/bin/claude' '--resume' '${HANDLE.slice(7)}'`);
  assert.ok(args.includes('do script (item 1 of argv)'), 'the command goes in as an argument, never inside the script');
});

test('Open in Terminal puts the builders\' model and its force ahead of claude when the agent had them, and nothing when it had neither', async () => {
  const claude = `'/opt/homebrew/bin/claude' '--resume' '${HANDLE.slice(7)}'`;
  const cases = [
    [{ CLAUDE_CODE_SUBAGENT_MODEL: 'haiku', CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' }, `CLAUDE_CODE_SUBAGENT_MODEL='haiku' CLAUDE_CODE_SUBAGENT_MODEL_FORCE='1' ${claude}`],
    [{ CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' }, `CLAUDE_CODE_SUBAGENT_MODEL='haiku' ${claude}`],
    [{}, claude],
  ];
  for (const [env, command] of cases) {
    world = freshWorld();
    world.resumeEnv = env;
    await act('agent-terminal', { handle: HANDLE });
    assert.ok(world.ran[0].at(-1).endsWith(` && ${command}`), JSON.stringify(env));
  }
});

test('Open in Terminal on a finished agent stops nothing', async () => {
  world.agents = [agent({ alive: false, state: 'done', pending: null })];
  const { text } = await act('agent-terminal', { handle: HANDLE });
  assert.equal(text, 'Opened review-engine-7 in Terminal');
  assert.deepEqual(world.stops, []);
});
