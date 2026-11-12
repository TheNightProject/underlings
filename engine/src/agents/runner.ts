import { spawn, type ChildProcess } from 'node:child_process';
import { createInterface } from 'node:readline';
import { STATE_DIR } from '../config.js';
import { REVIEW_SERVER, REVIEW_TOOL_RULES } from '../reviewtools.js';
import { taskOfKind } from '../../../lib/modeltiers.mjs';
import { recordUsage } from '../models.js';
import { appendRecord, childEnv, claudeBinary, clearPartial, extraArgs, launchArgs, launchEnv, markStopped, MASTER_KIND, MESSAGE_KIND, readAgentFile, readRecords, releaseLock, reviewServerCommand, takeLock, unsent, writePartial, type AgentFile } from './claudefiles.js';
import { readLog, turnTokens, type InputRecord } from './claudelog.js';

const BASE_ARGS = ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose', '--permission-prompt-tool', 'stdio'];
const POLL_MS = 200;
const PARTIAL_MS = 150;
const STDERR_KEPT = 2000;

interface Run {
  stopping: boolean;
  child: ChildProcess | null;
}

const REVIEW_KIND = 'review';

/** A review agent queues what it finds through a server that can do nothing else, so no default path posts. */
export function reviewToolArgs(): string[] {
  const server = { type: 'stdio', ...reviewServerCommand(), env: { ELECTRON_RUN_AS_NODE: '1', UNDERLINGS_STATE_DIR: STATE_DIR } };
  return ['--mcp-config', JSON.stringify({ mcpServers: { [REVIEW_SERVER]: server } }), '--allowedTools', ...REVIEW_TOOL_RULES];
}

export function claudeArgs(file: AgentFile, resume: boolean): string[] {
  const mode = file.permissions === 'ask' ? [] : ['--permission-mode', 'auto'];
  const streamed = file.kind === MASTER_KIND ? ['--include-partial-messages'] : [];
  const tools = file.kind === REVIEW_KIND ? reviewToolArgs() : [];
  const budget = file.budgetUsd ? ['--max-budget-usd', file.budgetUsd] : [];
  return [...BASE_ARGS, ...mode, ...streamed, ...budget, ...launchArgs(file), ...tools, ...extraArgs(file), ...(resume ? ['--resume', file.id] : ['--session-id', file.id, '--name', file.name])];
}

// Print mode starts the first turn before MCP servers connect, so the panel's first message would find no Gmail and a review no queue.
export function sessionEnv(file: AgentFile, bin: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const base = { ...childEnv(bin, env), ...launchEnv(file) };
  const waits = file.kind === MASTER_KIND || file.kind === MESSAGE_KIND || file.kind === REVIEW_KIND;
  return waits ? { ...base, MCP_CONNECTION_NONBLOCKING: 'false' } : base;
}

/** One detached process per agent, so the agent outlives whichever front end started it. */
export async function runAgent(dir: string, bin = claudeBinary()): Promise<void> {
  const file = readAgentFile(dir);
  if (!file) return;
  const run: Run = { stopping: false, child: null };
  process.on('SIGTERM', () => stop(dir, run));
  // Input written just as the last owner let go would otherwise wait for the next send.
  while (!run.stopping && takeLock(dir)) {
    try {
      await drain(dir, file, bin, run);
    } finally {
      releaseLock(dir);
    }
    if (run.stopping || waiting(dir).length === 0) return;
  }
}

const waiting = (dir: string): InputRecord[] => unsent(dir, readLog(readRecords(dir)).sent);

// Each process takes at least the input that started it, so this ends however often claude fails.
async function drain(dir: string, file: AgentFile, bin: string, run: Run): Promise<void> {
  while (!run.stopping && waiting(dir).length > 0) await session(dir, file, bin, readLog(readRecords(dir)).started, run);
}

function stop(dir: string, run: Run): void {
  if (run.stopping) return;
  run.stopping = true;
  markStopped(dir);
  run.child?.kill('SIGTERM');
}

// An answer to a question asked by a process that has since gone can only reach the session as a message.
function deliverable(input: InputRecord, asks: Set<string>): Record<string, unknown> {
  if (input.message['type'] !== 'control_response' || (input.answers && asks.has(input.answers))) return input.message;
  return { type: 'user', message: { role: 'user', content: input.fallback ?? 'Carry on.' }, parent_tool_use_id: null, session_id: '' };
}

function parsed(line: string): Record<string, unknown> | null {
  try {
    return JSON.parse(line) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** The reply streamed so far, kept beside the log rather than in it, since every few characters arrive as an event of their own. */
class Partial {
  private text = '';
  private timer: NodeJS.Timeout | null = null;

  constructor(private readonly dir: string) {}

  heard(event: Record<string, unknown>): void {
    if (event['parent_tool_use_id']) return;
    const inner = (event['event'] ?? {}) as { type?: string; delta?: { type?: string; text?: string } };
    if (inner.type === 'content_block_start') this.text = '';
    if (inner.type === 'content_block_delta' && inner.delta?.type === 'text_delta') this.text += inner.delta.text ?? '';
    this.timer ??= setTimeout(() => this.flush(), PARTIAL_MS);
  }

  clear(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.text = '';
    clearPartial(this.dir);
  }

  private flush(): void {
    this.timer = null;
    if (this.text) writePartial(this.dir, this.text);
    else clearPartial(this.dir);
  }
}

// A count that cannot be written never stops the agent.
function noteUsage(task: string, event: Record<string, unknown>): void {
  try {
    recordUsage(task, turnTokens(event));
  } catch {}
}

/** Feeds one claude process its input, and closes it once a turn ends with nothing more to send or answer. */
class Feed {
  readonly partial: Partial;
  private readonly done: Set<string>;
  private readonly asks = new Set<string>();
  private turnOpen = false;
  private closed = false;

  constructor(private readonly dir: string, private readonly child: ChildProcess, private readonly run: Run, private readonly task: string) {
    this.done = new Set(readLog(readRecords(dir)).sent);
    this.partial = new Partial(dir);
  }

  pump(): void {
    if (this.closed || this.run.stopping) return;
    for (const input of unsent(this.dir, this.done)) this.deliver(input);
    if (this.turnOpen || this.asks.size > 0) return;
    this.closed = true;
    this.child.stdin?.end();
  }

  heard(event: Record<string, unknown>): void {
    if (event['type'] === 'stream_event') return this.partial.heard(event);
    appendRecord(this.dir, { event });
    if (event['type'] === 'assistant' || event['type'] === 'result') this.partial.clear();
    if (event['type'] === 'control_request') this.asks.add(String(event['request_id']));
    if (event['type'] === 'control_cancel_request') this.asks.delete(String(event['request_id']));
    if (event['type'] !== 'result') return;
    noteUsage(this.task, event);
    this.turnOpen = Number(event['queued_turn_count'] ?? 0) > 0;
    this.pump();
  }

  private deliver(input: InputRecord): void {
    const message = deliverable(input, this.asks);
    appendRecord(this.dir, { host: { kind: 'sent', id: input.id, message, ...(input.answers ? { answers: input.answers } : {}) } });
    this.done.add(input.id);
    if (message['type'] === 'user') this.turnOpen = true;
    if (input.answers) this.asks.delete(input.answers);
    this.child.stdin?.write(`${JSON.stringify(message)}\n`);
  }
}

function session(dir: string, file: AgentFile, bin: string, resume: boolean, run: Run): Promise<void> {
  return new Promise((resolve) => {
    const child = spawn(bin, claudeArgs(file, resume), { cwd: file.cwd, env: sessionEnv(file, bin), stdio: ['pipe', 'pipe', 'pipe'] });
    run.child = child;
    const feed = new Feed(dir, child, run, taskOfKind(file.kind));
    const timer = setInterval(() => feed.pump(), POLL_MS);
    let stderr = '';
    let finished = false;
    const finish = (code: number | null): void => {
      if (finished) return;
      finished = true;
      clearInterval(timer);
      feed.partial.clear();
      run.child = null;
      appendRecord(dir, { host: { kind: 'exit', code, ...(code ? { stderr: stderr.trim() } : {}) } });
      resolve();
    };
    child.stdin?.on('error', () => {});
    child.stderr?.on('data', (chunk: Buffer) => { stderr = (stderr + chunk.toString()).slice(-STDERR_KEPT); });
    createInterface({ input: child.stdout! }).on('line', (line) => {
      const event = parsed(line);
      if (event) feed.heard(event);
    });
    child.on('error', (err) => {
      stderr = err.message;
      finish(-1);
    });
    child.on('close', finish);
    feed.pump();
  });
}
