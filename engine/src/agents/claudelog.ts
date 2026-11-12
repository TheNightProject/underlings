import { mrKeys, toolWork, type WorkCall } from './claudephase.js';

export type ClaudeState = 'working' | 'waiting' | 'blocked' | 'done';
/** How the last turn ended: null while one runs, or before the first ends. */
export type TurnOutcome = 'success' | 'error' | 'stopped' | null;

export interface Question {
  question: string;
  header?: string;
  options: { label: string; description?: string }[];
  multiSelect?: boolean;
}

export interface Pending {
  id: string;
  at: number;
  tool: string;
  input: Record<string, unknown>;
  /** Set for AskUserQuestion, the only ask that is a question rather than a permission. */
  questions?: Question[];
}

export type Entry =
  | { kind: 'you'; at: number; text: string }
  | { kind: 'said'; at: number; text: string }
  | { kind: 'tool'; at: number; name: string; summary: string }
  | { kind: 'asked'; at: number; id: string; tool: string; summary: string; questions?: Question[] }
  | { kind: 'note'; at: number; text: string };

export interface HostRecord {
  kind: 'sent' | 'dropped' | 'exit' | 'stopped';
  id?: string;
  message?: Record<string, unknown>;
  /** The request a sent control_response, or the text standing in for it, answers. */
  answers?: string;
  code?: number | null;
  stderr?: string;
}

export interface LogRecord {
  at: number;
  event?: Record<string, unknown>;
  host?: HostRecord;
}

export interface InputRecord {
  id: string;
  at: number;
  message: Record<string, unknown>;
  /** Sent as a plain message instead when the process that asked has gone. */
  fallback?: string;
  answers?: string;
}

export interface AgentLog {
  pending: Pending[];
  turnOpen: boolean;
  turnAt: number;
  sent: Set<string>;
  started: boolean;
  entries: Entry[];
  said: string;
  lastAt: number;
  outcome: TurnOutcome;
  background: string[];
  backgroundAt: number;
  turns: TurnRecord[];
  calls: WorkCall[];
  raising: Set<string>;
  raisedMr: string | null;
  /** What Claude Code said it started on, the only word on what its default resolved to. */
  model: string | null;
}

export interface TurnRecord {
  at: number;
  ok: boolean;
  tokens: number;
}

const SUMMARY_KEYS = ['command', 'file_path', 'path', 'pattern', 'url', 'query', 'description', 'prompt', 'skill', 'mr', 'ticket', 'handle', 'id'];
const SUMMARY_MAX = 160;

export function oneLine(text: string, max = SUMMARY_MAX): string {
  const line = text.replace(/\s+/g, ' ').trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

export function toolSummary(name: string, input: Record<string, unknown> | undefined): string {
  const key = SUMMARY_KEYS.find((k) => typeof input?.[k] === 'string' && input[k]);
  return oneLine(key ? String(input?.[key]) : name);
}

export function messageText(message: Record<string, unknown> | undefined): string {
  const content = (message?.['message'] as { content?: unknown } | undefined)?.content;
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.flatMap((b: { type?: string; text?: string }) => (b.type === 'text' && b.text ? [b.text] : [])).join('\n');
}

function answerWords(message: Record<string, unknown>): string {
  const response = (message['response'] as { response?: Record<string, unknown> } | undefined)?.response ?? {};
  if (response['behavior'] === 'deny') return `No: ${String(response['message'] ?? '')}`.trim();
  const input = (response['updatedInput'] ?? {}) as { answers?: Record<string, unknown>; response?: string };
  if (input.response) return input.response;
  const answers = Object.values(input.answers ?? {}).map((a) => (Array.isArray(a) ? a.join(', ') : String(a)));
  return answers.length > 0 ? answers.join('; ') : 'Yes';
}

function sentEntry(at: number, host: HostRecord): Entry | null {
  const message = host.message ?? {};
  if (message['type'] === 'control_response') return { kind: 'you', at, text: answerWords(message) };
  const text = messageText(message);
  return text ? { kind: 'you', at, text } : null;
}

function asked(at: number, id: string, request: Record<string, unknown>): Pending {
  const tool = String(request['tool_name'] ?? 'a tool');
  const input = (request['input'] ?? {}) as Record<string, unknown>;
  const questions = tool === 'AskUserQuestion' && Array.isArray(input['questions']) ? (input['questions'] as Question[]) : undefined;
  return { id, at, tool, input, ...(questions ? { questions } : {}) };
}

type Block = { type?: string; id?: string; text?: string; name?: string; input?: Record<string, unknown>; tool_use_id?: string; content?: unknown };

function blocksOf(event: Record<string, unknown>): Block[] {
  const content = (event['message'] as { content?: unknown } | undefined)?.content;
  return event['parent_tool_use_id'] || !Array.isArray(content) ? [] : (content as Block[]);
}

function assistantEntries(at: number, event: Record<string, unknown>): Entry[] {
  return blocksOf(event).flatMap((b): Entry[] => {
    if (b.type === 'text' && b.text?.trim()) return [{ kind: 'said', at, text: b.text.trim() }];
    if (b.type === 'tool_use' && b.name && b.name !== 'AskUserQuestion') return [{ kind: 'tool', at, name: b.name, summary: toolSummary(b.name, b.input) }];
    return [];
  });
}

function emptyLog(): AgentLog {
  return { pending: [], turnOpen: false, turnAt: 0, sent: new Set(), started: false, entries: [], said: '', lastAt: 0, outcome: null, background: [], backgroundAt: 0, turns: [], calls: [], raising: new Set(), raisedMr: null, model: null };
}

function noteCalls(log: AgentLog, at: number, event: Record<string, unknown>): void {
  for (const b of blocksOf(event)) {
    const work = b.type === 'tool_use' && b.name ? toolWork(b.name, b.input) : null;
    if (work) log.calls.push({ at, work });
    if (work === 'mr' && b.id) log.raising.add(b.id);
  }
}

function resultText(content: unknown): string {
  if (typeof content === 'string') return content;
  return Array.isArray(content) ? content.map((c: { type?: string; text?: string }) => (c.type === 'text' ? c.text ?? '' : '')).join('\n') : '';
}

function noteRaised(log: AgentLog, text: string): void {
  log.raisedMr = mrKeys(text).at(-1) ?? log.raisedMr;
}

// Links in what other calls returned, such as the MR under review, are not the MR it raised.
function noteResults(log: AgentLog, event: Record<string, unknown>): void {
  for (const b of blocksOf(event)) {
    if (b.type === 'tool_result' && b.tool_use_id && log.raising.has(b.tool_use_id)) noteRaised(log, resultText(b.content));
  }
}

function readEvent(log: AgentLog, at: number, event: Record<string, unknown>): void {
  const type = event['type'];
  if (type === 'system' && event['subtype'] === 'init') {
    log.started = true;
    if (typeof event['model'] === 'string') log.model = event['model'];
  }
  if (type === 'system' && event['subtype'] === 'background_tasks_changed') {
    const tasks = Array.isArray(event['tasks']) ? (event['tasks'] as Record<string, unknown>[]) : [];
    log.background = tasks.map((t) => oneLine(String(t['description'] ?? t['task_type'] ?? 'a task'), 80));
    log.backgroundAt = at;
  }
  if (type === 'assistant') {
    const entries = assistantEntries(at, event);
    log.entries.push(...entries);
    const said = entries.filter((e): e is Extract<Entry, { kind: 'said' }> => e.kind === 'said').at(-1);
    if (said) log.said = said.text;
    if (said && log.raising.size) noteRaised(log, said.text);
    noteCalls(log, at, event);
  }
  if (type === 'user') noteResults(log, event);
  if (type === 'control_request' && (event['request'] as { subtype?: string } | undefined)?.subtype === 'can_use_tool') {
    const pending = asked(at, String(event['request_id']), event['request'] as Record<string, unknown>);
    log.pending.push(pending);
    log.entries.push({ kind: 'asked', at, id: pending.id, tool: pending.tool, summary: toolSummary(pending.tool, pending.input), ...(pending.questions ? { questions: pending.questions } : {}) });
  }
  if (type === 'control_cancel_request') log.pending = log.pending.filter((p) => p.id !== event['request_id']);
  if (type === 'result') {
    log.turns.push({ at, ok: !event['is_error'], tokens: turnTokens(event) });
    log.turnOpen = Number(event['queued_turn_count'] ?? 0) > 0;
    log.turnAt = at;
    log.outcome = event['is_error'] ? 'error' : 'success';
    if (event['is_error']) log.entries.push({ kind: 'note', at, text: `The turn ended in an error: ${oneLine(String(event['result'] ?? event['subtype'] ?? ''))}` });
  }
}

interface UsageCounts {
  input_tokens?: number;
  cache_creation_input_tokens?: number;
  output_tokens?: number;
}

interface ModelCounts {
  inputTokens?: number;
  cacheCreationInputTokens?: number;
  outputTokens?: number;
}

const count = (n: unknown): number => (typeof n === 'number' && Number.isFinite(n) && n > 0 ? n : 0);

// Each result says what its own turn spent since the one before; an older Claude Code only gives that turn's usage.
export function turnTokens(event: Record<string, unknown>): number {
  const since = event['model_usage_since_last_result'] as Record<string, ModelCounts> | undefined;
  if (since && typeof since === 'object') {
    return Object.values(since).reduce((sum, m) => sum + count(m?.inputTokens) + count(m?.cacheCreationInputTokens) + count(m?.outputTokens), 0);
  }
  const usage = (event['usage'] ?? {}) as UsageCounts;
  return count(usage.input_tokens) + count(usage.cache_creation_input_tokens) + count(usage.output_tokens);
}

function readHost(log: AgentLog, at: number, host: HostRecord): void {
  if (host.kind === 'sent' && host.id) {
    log.sent.add(host.id);
    const entry = sentEntry(at, host);
    if (entry) log.entries.push(entry);
    if (host.answers) log.pending = log.pending.filter((p) => p.id !== host.answers);
    if (host.message?.['type'] === 'user') {
      log.turnOpen = true;
      log.turnAt = at;
      log.outcome = null;
    }
  }
  if (host.kind === 'dropped' && host.id) log.sent.add(host.id);
  if (host.kind === 'exit') {
    log.turnOpen = false;
    log.turnAt = at;
    if (host.code) {
      // A process stopped on purpose may still exit non-zero.
      if (log.outcome !== 'stopped') log.outcome = 'error';
      log.entries.push({ kind: 'note', at, text: `Claude Code exited with code ${host.code}${host.stderr ? `: ${oneLine(host.stderr)}` : ''}` });
    }
  }
  if (host.kind === 'stopped') {
    log.pending = [];
    log.turnOpen = false;
    log.turnAt = at;
    log.outcome = 'stopped';
    log.entries.push({ kind: 'note', at, text: 'Stopped.' });
  }
}

export function readLog(records: LogRecord[]): AgentLog {
  const log = emptyLog();
  for (const { at, event, host } of records) {
    if (event) readEvent(log, at, event);
    if (host) readHost(log, at, host);
    log.lastAt = Math.max(log.lastAt, at);
  }
  return log;
}

/** A start writes its prompt before the runner exists, so input queued that recently is a turn about to run. */
const STARTING_MS = 15_000;

export function agentState(log: AgentLog, queued: InputRecord[], runnerAlive: boolean, now = Date.now()): { state: ClaudeState; since: number } {
  const ask = log.pending.at(-1);
  if (ask) return { state: ask.questions ? 'waiting' : 'blocked', since: ask.at };
  if (runnerAlive && log.turnOpen) return { state: 'working', since: log.turnAt };
  // A turn can end with builders still running in the background, and the agent is busy until they report back.
  if (runnerAlive && log.background.length) return { state: 'working', since: log.backgroundAt };
  const next = queued.at(-1);
  if (next && (runnerAlive || now - next.at < STARTING_MS)) return { state: 'working', since: next.at };
  return { state: 'done', since: log.turnAt || log.lastAt };
}

export function parseLines<T>(text: string): T[] {
  return text.split('\n').flatMap((line) => {
    if (!line.trim()) return [];
    try {
      return [JSON.parse(line) as T];
    } catch {
      return [];
    }
  });
}

export function transcript(entries: Entry[]): string[] {
  return entries.flatMap((e) => {
    if (e.kind === 'said') return e.text.split('\n');
    if (e.kind === 'you') return [`> ${oneLine(e.text)}`];
    if (e.kind === 'tool') return [`· ${e.name}: ${e.summary}`];
    if (e.kind === 'asked') return [e.questions ? `? ${e.questions.map((q) => q.question).join(' ')}` : `? Allow ${e.tool}: ${e.summary}`];
    return [`! ${e.text}`];
  });
}
