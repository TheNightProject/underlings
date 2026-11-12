import { accessSync, appendFileSync, constants, existsSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { modelArgs, subagentEnv } from '../../../lib/modeltiers.mjs';
import { parseLines, readLog, type InputRecord, type LogRecord } from './claudelog.js';
import type { AgentKind } from './host.js';

export const AGENT_FILE = 'agent.json';
export const EVENTS_FILE = 'events.jsonl';
export const INPUT_FILE = 'input.jsonl';
const LOCK_FILE = 'runner.lock';

export interface AgentFile {
  id: string;
  name: string;
  title: string;
  cwd: string;
  createdAt: string;
  kind?: AgentKind;
  mr?: string;
  ticket?: string;
  worktree?: string;
  permissions?: 'auto' | 'ask';
  args?: string[];
  budgetUsd?: string;
  model?: string;
  effort?: string;
  subagentModel?: string;
  subagentForce?: boolean;
}

const PARTIAL_FILE = 'partial.json';
export const MASTER_KIND = 'master';
export const MESSAGE_KIND = 'message';

export const takesArgs = (kind: AgentKind | undefined): boolean => kind === MASTER_KIND || kind === MESSAGE_KIND;
export const inBackground = (kind: AgentKind | undefined): boolean => !takesArgs(kind);
export const extraArgs = (file: AgentFile): string[] => (takesArgs(file.kind) ? file.args ?? [] : []);
export const launchArgs = (file: AgentFile): string[] => modelArgs(file);
export const launchEnv = (file: AgentFile): Record<string, string> => subagentEnv({ model: file.subagentModel, force: file.subagentForce });

export function readAgentFile(dir: string): AgentFile | null {
  try {
    return JSON.parse(readFileSync(join(dir, AGENT_FILE), 'utf8')) as AgentFile;
  } catch {
    return null;
  }
}

function readText(path: string): string {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return '';
  }
}

export const readRecords = (dir: string): LogRecord[] => parseLines<LogRecord>(readText(join(dir, EVENTS_FILE)));
export const readInputs = (dir: string): InputRecord[] => parseLines<InputRecord>(readText(join(dir, INPUT_FILE)));

export function appendRecord(dir: string, record: Omit<LogRecord, 'at'>): void {
  appendFileSync(join(dir, EVENTS_FILE), `${JSON.stringify({ at: Date.now(), ...record })}\n`);
}

export function appendInput(dir: string, input: InputRecord): void {
  appendFileSync(join(dir, INPUT_FILE), `${JSON.stringify(input)}\n`);
}

export function writePartial(dir: string, text: string): void {
  writeFileSync(join(dir, PARTIAL_FILE), JSON.stringify({ at: Date.now(), text }));
}

export function clearPartial(dir: string): void {
  rmSync(join(dir, PARTIAL_FILE), { force: true });
}

export function readPartial(dir: string): string | null {
  try {
    const { text } = JSON.parse(readFileSync(join(dir, PARTIAL_FILE), 'utf8')) as { text?: unknown };
    return typeof text === 'string' && text ? text : null;
  } catch {
    return null;
  }
}

export function unsent(dir: string, sent: Set<string>): InputRecord[] {
  return readInputs(dir).filter((input) => !sent.has(input.id));
}

/** Only the runner writes the log while it lives, so this is called by it or once it has gone. */
export function markStopped(dir: string): void {
  for (const input of unsent(dir, readLog(readRecords(dir)).sent)) appendRecord(dir, { host: { kind: 'dropped', id: input.id } });
  appendRecord(dir, { host: { kind: 'stopped' } });
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

export function runnerPid(dir: string): number | null {
  const pid = Number(readText(join(dir, LOCK_FILE)).trim());
  return Number.isInteger(pid) && pid > 0 && alive(pid) ? pid : null;
}

/** One runner owns an agent's process, and a lock left by one that died is taken over. */
export function takeLock(dir: string, pid = process.pid): boolean {
  const path = join(dir, LOCK_FILE);
  const holder = readText(path).trim();
  if (holder === String(pid)) return true;
  if (holder && runnerPid(dir) !== null) return false;
  rmSync(path, { force: true });
  try {
    writeFileSync(path, String(pid), { flag: 'wx' });
    return true;
  } catch {
    return false;
  }
}

export function releaseLock(dir: string): void {
  const path = join(dir, LOCK_FILE);
  if (readText(path).trim() === String(process.pid)) unlinkSync(path);
}

const CLAUDE_CANDIDATES = ['/opt/homebrew/bin/claude', '/usr/local/bin/claude', join(homedir(), '.local/bin/claude'), join(homedir(), '.claude/local/claude')];

export function claudeBinary(): string {
  const set = process.env['UNDERLINGS_CLAUDE_BIN'];
  if (set) return set;
  for (const candidate of CLAUDE_CANDIDATES) {
    try {
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // try the next one
    }
  }
  return 'claude';
}

// Left by an Orca terminal, a parent Claude Code session or the runner's own start, these would report the agent as theirs.
const INHERITED = /^(ORCA_|ELECTRON_RUN_AS_NODE$|CLAUDECODE$|CLAUDE_PID$|CLAUDE_EFFORT$|CLAUDE_CODE_(ENTRYPOINT|SESSION_|CHILD_SESSION|MESSAGING_|EXECPATH|PLUGIN_DIRS))/;
const TOOL_DIRS = ['/opt/homebrew/bin', '/usr/local/bin', join(homedir(), '.local/bin'), '/usr/bin', '/bin', '/usr/sbin', '/sbin'];

/** A plugin worker runs with a scrubbed PATH, so the agent's own tools are put back on it. */
export function childEnv(bin: string, env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const kept = Object.fromEntries(Object.entries(env).filter(([name]) => !INHERITED.test(name)));
  const path = (kept['PATH'] ?? '').split(delimiter).filter(Boolean);
  const extra = [...(bin.includes('/') ? [dirname(bin)] : []), ...TOOL_DIRS].filter((d) => !path.includes(d));
  return { ...kept, PATH: [...path, ...extra].join(delimiter), SHELL: kept['SHELL'] ?? '/bin/zsh' };
}

/** The built runner sits beside the engine; run from source it needs tsx, found from the source folder. */
export function runnerCommand(): { args: string[]; cwd: string } {
  const built = fileURLToPath(new URL('./agentrun.js', import.meta.url));
  if (existsSync(built)) return { args: [built], cwd: dirname(built) };
  const source = fileURLToPath(new URL('../agentrun.ts', import.meta.url));
  return { args: ['--import', 'tsx', source], cwd: dirname(source) };
}

/** Beside the runner in a build; from source it needs tsx, named by its full path as the server starts in the agent's folder. */
export function reviewServerCommand(): { command: string; args: string[] } {
  const built = fileURLToPath(new URL('./reviewserver.js', import.meta.url));
  if (existsSync(built)) return { command: process.execPath, args: [built] };
  const source = fileURLToPath(new URL('../reviewserver.ts', import.meta.url));
  return { command: process.execPath, args: ['--import', import.meta.resolve('tsx'), source] };
}
