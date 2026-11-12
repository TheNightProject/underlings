import { mkdirSync, watch } from 'node:fs';
import { join } from 'node:path';
import { engine, failure, requireEngine, still, supports } from './engine.mjs';
import { run, shellQuoted } from './run.mjs';

const HANDLE = /^claude:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MAX_TEXT = 8000;
const MAX_ANSWER = 500;
const OSASCRIPT = '/usr/bin/osascript';
const SETTLE_MS = 300;

const moved = new Set();
let watcher = null;
let settling = null;
let lastSignature = '';

export const ROUTES = {
  'GET /api/agents/conversation': ({ query }) => liveAgent(query.get('handle')),
};

export const ACTIONS = {
  'agent-reply': { verify: verifyReply, run: sendReply },
  'agent-stop': { verify: verifyRunning, run: stopRunning },
  'agent-terminal': { verify: verifyAgent, run: openInTerminal },
};

export const MASTER = 'master';

const everyAgent = () => (supports('claudeAgents') ? engine.claudeAgents().map(asAgent) : null);

// Null from an engine too old to say, which is not the same as none running; the panel's chats are its own.
export function listAgents() {
  return everyAgent()?.filter((a) => a.kind !== MASTER) ?? null;
}

export function masterAgents() {
  return everyAgent()?.filter((a) => a.kind === MASTER) ?? [];
}

function asAgent(a) {
  return {
    handle: a.handle, name: a.name, title: a.title, kind: a.kind ?? null, mr: a.mr ?? null, ticket: a.ticket ?? null, worktree: a.worktree ?? null, cwd: a.cwd,
    state: a.state, since: a.since, lastAt: a.lastAt ?? Date.parse(a.createdAt), alive: a.alive, said: a.said, outcome: a.outcome ?? null, ask: a.pending ?? null, background: a.background ?? [],
    phase: a.phase ?? null, raisedMr: a.raisedMr ?? null, model: a.model ?? null, effort: a.effort ?? null, subagentModel: a.subagentModel ?? null, subagentForce: a.subagentForce === true, runningModel: a.runningModel ?? null,
  };
}

const signature = () => (everyAgent() ?? []).map((a) => [a.handle, a.state, a.since, a.alive, a.ask?.id, a.phase, a.raisedMr, a.runningModel].join(':')).join('|');

// Each runner writes everything its agent does to the agent's own log, so a change under agents/ is the only event there is.
export function start(config, shell) {
  if (!supports('claudeAgents') || !engine.STATE_DIR) return;
  const dir = join(engine.STATE_DIR, 'agents');
  lastSignature = signature();
  try {
    mkdirSync(dir, { recursive: true });
    watcher = watch(dir, { recursive: true }, () => settle(shell));
    watcher.on('error', (err) => shell.log?.(`stopped watching the agents: ${err.message}`));
  } catch (err) {
    shell.log?.(`could not watch the agents: ${err.message}`);
  }
}

export function stop() {
  watcher?.close();
  watcher = null;
  clearTimeout(settling);
}

export function afterAgentsMove(fn) {
  moved.add(fn);
  return () => moved.delete(fn);
}

function settle(shell) {
  clearTimeout(settling);
  settling = setTimeout(() => {
    const now = signature();
    if (now === lastSignature) return;
    lastSignature = now;
    shell.notify?.('agents');
    for (const fn of moved) Promise.resolve().then(fn).catch(() => {});
  }, SETTLE_MS);
  settling.unref?.();
}

function handleOf(handle) {
  if (typeof handle !== 'string' || !HANDLE.test(handle)) throw failure(400, 'handle must name a Claude Code agent');
  return handle;
}

function liveAgent(handle) {
  const { agentConversation } = requireEngine('agentConversation');
  try {
    return agentConversation(handleOf(handle));
  } catch (err) {
    if (err.status) throw err;
    throw failure(404, `no Claude Code agent ${handle} is recorded any more`);
  }
}

const seen = (agent) => ({ state: agent.state, since: agent.since, pending: agent.pending?.id ?? null });

function replyOf({ text, answer, allow }) {
  if (typeof text === 'string') {
    if (!text.trim()) throw failure(400, 'type a reply first');
    if (text.length > MAX_TEXT) throw failure(400, `a reply is at most ${MAX_TEXT} characters`);
    return { text };
  }
  if (answer && typeof answer.question === 'string' && typeof answer.label === 'string' && answer.label.length <= MAX_ANSWER) {
    return { answers: { [answer.question]: answer.label } };
  }
  if (typeof allow === 'boolean') return { allow };
  throw failure(400, 'a reply is text, an answer to the question asked, or allow true or false');
}

// The agent may have moved on to another question since the page drew this one, so what it saw is checked first.
function verifyReply(payload) {
  requireEngine('agentConversation', 'replyToAgent');
  const reply = replyOf(payload);
  const agent = liveAgent(payload.handle);
  still(payload.expect, seen(agent), `the agent in ${agent.name}`);
  if (!('text' in reply) && !agent.pending) throw failure(409, `${agent.name} is not waiting on an answer any more`);
  return { agent, reply };
}

function sendReply({ handle }, { agent, reply }) {
  try {
    engine.replyToAgent(handle, reply);
  } catch (err) {
    throw failure(409, err.message);
  }
  if ('allow' in reply) return `${reply.allow ? 'Allowed' : 'Denied'} ${agent.pending.tool} for ${agent.name}`;
  return 'answers' in reply ? `Answered ${agent.name}` : `Sent your reply to ${agent.name}`;
}

function verifyAgent({ handle }) {
  requireEngine('agentConversation', 'resumeCommand', 'stopAgent');
  return liveAgent(handle);
}

function verifyRunning(payload) {
  const agent = verifyAgent(payload);
  if (!agent.alive) throw failure(409, `${agent.name} is not running`);
  return agent;
}

async function stopRunning({ handle }, agent) {
  await engine.stopAgent(handle);
  return `Stopped ${agent.name}`;
}

// Two processes on one session would each write to it, so the one in the background stops first.
async function openInTerminal({ handle }, agent) {
  if (agent.alive) await engine.stopAgent(handle);
  const { cwd, argv, env = {} } = engine.resumeCommand(handle);
  const vars = Object.entries(env).map(([name, value]) => `${name}=${shellQuoted(value)}`);
  const command = `cd ${shellQuoted(cwd)} && ${[...vars, ...argv.map(shellQuoted)].join(' ')}`;
  await run(OSASCRIPT, ['-e', 'on run argv', '-e', 'tell application "Terminal"', '-e', 'activate', '-e', 'do script (item 1 of argv)', '-e', 'end tell', '-e', 'end run', command]);
  return `Opened ${agent.name} in Terminal${agent.alive ? ', after stopping it here' : ''}`;
}
