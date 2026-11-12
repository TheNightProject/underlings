import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { STATE_DIR } from '../config.js';
import { assertWritableState, loadSettings, UNDER_TEST_RUNNER } from '../data/store.js';
import { budgetOf } from '../settings.js';
import { agentLaunch } from '../models.js';
import { pluginArgs } from '../plugin.js';
import { AGENT_FILE, appendInput, claudeBinary, EVENTS_FILE, extraArgs, inBackground, launchArgs, launchEnv, markStopped, MASTER_KIND, readAgentFile, readPartial, readRecords, runnerCommand, runnerPid, takeLock, takesArgs, unsent, type AgentFile } from './claudefiles.js';
import { agentState, oneLine, readLog, toolSummary, transcript, type AgentLog, type ClaudeState, type Entry, type Pending } from './claudelog.js';
import { agentPhase } from './claudephase.js';
import type { AgentHost, AgentSpec, AgentTerminal, StartedAgent, TerminalRead, WorkspaceAgents } from './host.js';

export const CLAUDE_HANDLE = 'claude:';
const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const ENTRIES_SHOWN = 200;
const TEXT_SHOWN = 4000;
const MASTER_SHOWN = { entries: 400, text: 60_000 };
const ASK_INPUT_SHOWN = 3000;
const STOP_WAIT_MS = 10_000;

export type AgentReply = { text: string } | { answers: Record<string, string> } | { allow: boolean; message?: string };

interface ClaudeAgent {
  handle: string;
  file: AgentFile;
  log: AgentLog;
  state: ClaudeState;
  since: number;
  alive: boolean;
}

const agentsDir = (): string => join(STATE_DIR, 'agents');
export const isClaudeHandle = (handle: string): boolean => handle.startsWith(CLAUDE_HANDLE);

function knownDir(handle: string): string | null {
  const id = handle.slice(CLAUDE_HANDLE.length);
  return isClaudeHandle(handle) && SESSION_ID.test(id) ? join(agentsDir(), id) : null;
}

function dirOf(handle: string): string {
  const dir = knownDir(handle);
  if (!dir) throw new Error(`${handle} is not a Claude Code agent`);
  return dir;
}

// Every poll lists every agent, so a log is parsed again only once its file has grown.
const logs = new Map<string, { stamp: string; log: AgentLog }>();

function logOf(dir: string): AgentLog {
  const s = statSync(join(dir, EVENTS_FILE), { throwIfNoEntry: false });
  const stamp = s ? `${s.size}:${s.mtimeMs}` : '';
  const hit = logs.get(dir);
  if (hit?.stamp === stamp) return hit.log;
  const log = readLog(readRecords(dir));
  logs.set(dir, { stamp, log });
  return log;
}

function agentAt(dir: string): ClaudeAgent | null {
  const file = readAgentFile(dir);
  if (!file) return null;
  const log = logOf(dir);
  const alive = runnerPid(dir) !== null;
  return { handle: CLAUDE_HANDLE + file.id, file, log, alive, ...agentState(log, unsent(dir, log.sent), alive) };
}

function agentFor(handle: string): ClaudeAgent {
  const agent = agentAt(dirOf(handle));
  if (!agent) throw new Error(`no Claude Code agent ${handle} is recorded`);
  return agent;
}

function allAgents(): ClaudeAgent[] {
  const names = existsSync(agentsDir()) ? readdirSync(agentsDir()) : [];
  return names.filter((n) => SESSION_ID.test(n)).flatMap((n) => agentAt(join(agentsDir(), n)) ?? []);
}

function userMessage(text: string): Record<string, unknown> {
  return { type: 'user', message: { role: 'user', content: text }, parent_tool_use_id: null, session_id: '' };
}

function startRunner(dir: string): void {
  const { args, cwd } = runnerCommand();
  // A plugin worker's node may be Electron's, which runs a script only when told to act as node.
  const child = spawn(process.execPath, [...args, dir], { cwd, detached: true, stdio: 'ignore', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } });
  child.on('error', () => {});
  // Taken for it, so a stop straight after a start finds it.
  if (child.pid) takeLock(dir, child.pid);
  child.unref();
}

function queue(dir: string, message: Record<string, unknown>, extra: { answers?: string; fallback?: string } = {}): void {
  appendInput(dir, { id: randomUUID(), at: Date.now(), message, ...extra });
  if (runnerPid(dir) === null) startRunner(dir);
}

// A test that forgets the fake would start a real Claude Code session on whatever it was given.
function assertFakeClaude(): void {
  if (UNDER_TEST_RUNNER && !process.env['UNDERLINGS_CLAUDE_BIN']) throw new Error('refusing to start the real claude from a test: set UNDERLINGS_CLAUDE_BIN to a fake');
}

// The panel's chat is the one you are typing into, so it neither counts towards the limit nor is held back by it.
function refuseOverLimit(kind: AgentSpec['kind'], max: number): void {
  if (kind === MASTER_KIND || !(max > 0)) return;
  const running = allAgents().filter((a) => a.alive && a.file.kind !== MASTER_KIND).length;
  if (running >= max) throw new Error(`${running} ${running === 1 ? 'agent is' : 'agents are'} running already, the most Settings allows at once: wait for one to finish, or raise Agents at once`);
}

async function start(spec: AgentSpec): Promise<StartedAgent> {
  assertWritableState();
  assertFakeClaude();
  if (spec.args && !takesArgs(spec.kind)) throw new Error(`a ${spec.kind} agent runs with the arguments every agent has, so it takes no more`);
  const settings = loadSettings();
  refuseOverLimit(spec.kind, Number(settings.maxAgents));
  const id = randomUUID();
  const dir = join(agentsDir(), id);
  mkdirSync(dir, { recursive: true });
  const { name, title, cwd, kind, mr, ticket, worktree, args } = spec;
  const budgetUsd = inBackground(kind) ? budgetOf(settings) ?? undefined : undefined;
  const file: AgentFile = { id, name, title, cwd, createdAt: new Date().toISOString(), kind, mr, ticket, worktree, permissions: settings.agentPermissions, args, budgetUsd, ...agentLaunch(kind, settings) };
  writeFileSync(join(dir, AGENT_FILE), `${JSON.stringify(file, null, 2)}\n`);
  queue(dir, userMessage(spec.prompt));
  return { how: 'claude', handle: CLAUDE_HANDLE + id, path: worktree ?? cwd };
}

function listed(a: ClaudeAgent): AgentTerminal {
  return {
    handle: a.handle, title: a.file.title, agent: 'claude', connected: true, orphaned: false,
    lastOutputAt: a.log.lastAt || Date.parse(a.file.createdAt), worktreePath: a.file.worktree ?? a.file.cwd, state: a.state, working: a.state === 'working',
  };
}

function workspace(a: ClaudeAgent): WorkspaceAgents {
  return {
    id: a.handle, displayName: a.file.name, path: a.file.worktree ?? a.file.cwd, branch: '', isMainWorktree: false,
    lastActivityAt: a.log.lastAt || Date.parse(a.file.createdAt), agentStates: [a.state],
  };
}

async function read(handle: string, limit = ENTRIES_SHOWN): Promise<TerminalRead> {
  const agent = agentFor(handle);
  return { status: agent.alive ? 'running' : 'exited', tail: transcript(agent.log.entries).slice(-limit) };
}

function questionAnswer(ask: Pending, reply: AgentReply): { response: Record<string, unknown>; fallback: string } {
  const questions = ask.questions ?? [];
  if ('answers' in reply) {
    for (const [question, label] of Object.entries(reply.answers)) {
      const asked = questions.find((q) => q.question === question);
      if (!asked?.options.some((o) => o.label === label)) throw new Error(`"${label}" is not one of the answers offered to "${oneLine(question, 80)}"`);
    }
    const said = Object.entries(reply.answers).map(([q, a]) => `"${q}" = "${a}"`).join(', ');
    return { response: { behavior: 'allow', updatedInput: { questions, answers: reply.answers } }, fallback: `My answers: ${said}` };
  }
  if (!('text' in reply)) throw new Error('that is a question, so pick an answer or type one');
  const first = questions.length === 1 ? questions[0] : undefined;
  const updatedInput = first ? { questions, answers: { [first.question]: reply.text } } : { questions, answers: {}, response: reply.text };
  return { response: { behavior: 'allow', updatedInput }, fallback: reply.text };
}

function permissionAnswer(ask: Pending, reply: AgentReply): { response: Record<string, unknown>; fallback: string } {
  if ('answers' in reply) throw new Error(`that asks to use ${ask.tool}, so allow or deny it`);
  if ('allow' in reply && reply.allow) {
    return { response: { behavior: 'allow', updatedInput: ask.input }, fallback: `Yes, go ahead with ${ask.tool}: ${toolSummary(ask.tool, ask.input)}` };
  }
  const message = ('text' in reply ? reply.text : reply.message)?.trim() || `No, do not use ${ask.tool} for that.`;
  return { response: { behavior: 'deny', message }, fallback: message };
}

/** A reply to the question or permission it waits on, or else a message of its own. */
export function replyToAgent(handle: string, reply: AgentReply): void {
  const dir = dirOf(handle);
  const ask = agentFor(handle).log.pending.at(-1);
  if (!ask) {
    if (!('text' in reply)) throw new Error('the agent is not waiting on an answer');
    queue(dir, userMessage(reply.text));
    return;
  }
  const { response, fallback } = ask.questions ? questionAnswer(ask, reply) : permissionAnswer(ask, reply);
  queue(dir, { type: 'control_response', response: { subtype: 'success', request_id: ask.id, response } }, { answers: ask.id, fallback });
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function stopAgent(handle: string): Promise<void> {
  const dir = dirOf(handle);
  const pid = runnerPid(dir);
  if (pid !== null) process.kill(pid, 'SIGTERM');
  for (const end = Date.now() + STOP_WAIT_MS; runnerPid(dir) !== null; await sleep(100)) {
    if (Date.now() > end) throw new Error(`the agent ${handle} did not stop within ${STOP_WAIT_MS / 1000} s`);
  }
  // A runner stopped before it was listening leaves its input unsent, which would read as a turn about to run.
  if (unsent(dir, readLog(readRecords(dir)).sent).length > 0) markStopped(dir);
}

/** The agent owns no files of its own, so removing its workspace only stops it and forgets it. */
async function removeWorkspace(id: string): Promise<void> {
  const dir = dirOf(id);
  await stopAgent(id);
  rmSync(dir, { recursive: true, force: true });
  logs.delete(dir);
}

export const claudeHost: AgentHost = {
  start,
  agents: async () => allAgents().map(listed),
  read,
  send: async (handle, text) => replyToAgent(handle, { text }),
  stateOf: async (handle) => {
    const dir = knownDir(handle);
    return dir ? (agentAt(dir)?.state ?? null) : null;
  },
  stop: stopAgent,
  workspaces: async () => allAgents().map(workspace),
  workspaceAgents: async () => allAgents().map(workspace),
  removeWorkspace,
};

function clipped(entry: Entry, max: number): Entry {
  return 'text' in entry && entry.text.length > max ? { ...entry, text: `${entry.text.slice(0, max)}…` } : entry;
}

function askInput(input: Record<string, unknown>): string {
  const text = JSON.stringify(input, null, 2) ?? '';
  return text.length > ASK_INPUT_SHOWN ? `${text.slice(0, ASK_INPUT_SHOWN)}…` : text;
}

function summary(a: ClaudeAgent) {
  const ask = a.log.pending.at(-1) ?? null;
  const { id, name, title, cwd, createdAt, kind, mr, ticket, worktree, model, effort, subagentModel, subagentForce } = a.file;
  return {
    handle: a.handle, sessionId: id, name, title, cwd, createdAt, kind: kind ?? null, mr: mr ?? null, ticket: ticket ?? null, worktree: worktree ?? null,
    model: model ?? null, effort: effort ?? null, subagentModel: subagentModel ?? null, subagentForce: subagentForce === true, runningModel: a.log.model,
    state: a.state, since: a.since, lastAt: a.log.lastAt || null, alive: a.alive, said: a.log.said, outcome: a.log.outcome, background: a.alive ? a.log.background : [], turns: a.log.turns,
    phase: agentPhase(a.log, a.state, a.alive), raisedMr: a.log.raisedMr,
    pending: ask ? { id: ask.id, tool: ask.tool, summary: toolSummary(ask.tool, ask.input), questions: ask.questions ?? null, input: ask.questions ? null : askInput(ask.input) } : null,
  };
}

export type ClaudeAgentSummary = ReturnType<typeof summary>;

export function claudeAgents(): ClaudeAgentSummary[] {
  return allAgents().map(summary);
}

/** The master agent is a conversation you read whole, so it keeps more of it, and the reply it is writing. */
export function agentConversation(handle: string): ClaudeAgentSummary & { entries: Entry[]; partial: string | null } {
  const agent = agentFor(handle);
  const master = agent.file.kind === MASTER_KIND;
  const shown = master ? MASTER_SHOWN : { entries: ENTRIES_SHOWN, text: TEXT_SHOWN };
  const partial = master && agent.alive ? readPartial(dirOf(handle)) : null;
  return { ...summary(agent), entries: agent.log.entries.slice(-shown.entries).map((e) => clipped(e, shown.text)), partial };
}

/** Resumed in a terminal on the model it was started with, as a run already going keeps its model. */
export function resumeCommand(handle: string): { cwd: string; argv: string[]; env: Record<string, string> } {
  const { file } = agentFor(handle);
  return { cwd: file.cwd, argv: [claudeBinary(), '--resume', file.id, ...launchArgs(file), ...extraArgs(file), ...pluginArgs()], env: launchEnv(file) };
}

export const startClaudeAgent = (spec: AgentSpec): Promise<StartedAgent> => start(spec);
