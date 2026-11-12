import { execFile } from 'node:child_process';
import type { AgentTerminal, TerminalRead, Workspace, WorkspaceAgents } from '../agents/host.js';
import { ORCA_WORKSPACE_REPO_ID } from '../config.js';
import { accessSync, constants } from 'node:fs';
import { promisify } from 'node:util';

const run = promisify(execFile);

const CANDIDATES = [
  '/Applications/Orca.app/Contents/Resources/bin/orca',
  process.env['ORCA_CODEX_LAUNCH_PREFLIGHT'],
  '/usr/local/bin/orca',
];

let cached: string | null = null;

/**
 * /usr/local/bin/orca is a root-owned symlink that is not always stat-able, and the
 * binary it points at reports "Unable to determine Orca.app path" when invoked through
 * it, so the bundle path is tried first.
 */
export function orcaBinary(): string {
  if (cached) return cached;
  for (const candidate of CANDIDATES) {
    if (!candidate) continue;
    try {
      accessSync(candidate, constants.X_OK);
      cached = candidate;
      return cached;
    } catch {
      // try the next one
    }
  }
  cached = 'orca';
  return cached;
}

export interface OrcaResult<T> {
  id: string;
  ok: boolean;
  result?: T;
  error?: { code?: string; message?: string } | string;
}

export class OrcaError extends Error {
  constructor(
    message: string,
    readonly code?: string,
  ) {
    super(message);
  }
}

/** Long enough for Orca's own slowest step: a worktree create clones, and a send waits for the prompt to submit. */
export function orcaTimeoutMs(args: string[]): number {
  const [noun, verb] = args;
  if (noun === 'worktree' && verb === 'create') return 120_000;
  if (noun === 'terminal' && verb === 'send' && args.includes('--wait-submit')) return 45_000;
  return 60_000;
}

function timedOut(err: unknown, args: string[], ms: number): unknown {
  if ((err as { killed?: unknown } | null)?.killed !== true) return err;
  return new OrcaError(`orca ${args.slice(0, 2).join(' ')} gave no answer in ${ms / 1000} s`);
}

async function orca<T>(args: string[]): Promise<T> {
  const timeout = orcaTimeoutMs(args);
  const stdout = await run(orcaBinary(), [...args, '--json'], {
    maxBuffer: 32 * 1024 * 1024,
    timeout,
  }).then((r) => r.stdout, (err: unknown) => refusalOutput(timedOut(err, args, timeout)));
  return orcaReply<T>(args, stdout);
}

/** A refused call exits 1 with its reason as JSON on stdout, so the reason is kept rather than the bare exit status. */
export function refusalOutput(err: unknown): string {
  const stdout = (err as { stdout?: unknown } | null)?.stdout;
  if (typeof stdout === 'string' && parsesAsRefusal(stdout)) return stdout;
  throw err;
}

function parsesAsRefusal(stdout: string): boolean {
  try {
    return (JSON.parse(stdout) as { ok?: unknown })?.ok === false;
  } catch {
    return false;
  }
}

export function orcaReply<T>(args: string[], stdout: string): T {
  let parsed: OrcaResult<T>;
  try {
    parsed = JSON.parse(stdout) as OrcaResult<T>;
  } catch {
    throw new OrcaError(`orca ${args.join(' ')} returned unparseable output: ${stdout.slice(0, 300)}`);
  }
  if (!parsed.ok) {
    const error = parsed.error;
    const message = typeof error === 'string' ? error : error?.message ?? error?.code ?? 'unknown error';
    throw new OrcaError(`orca ${args.join(' ')} failed: ${message}`, typeof error === 'string' ? undefined : error?.code);
  }
  return parsed.result as T;
}

export interface Worktree {
  id: string;
  path: string;
  branch: string | null;
  repoId: string;
}

/** Orca spins the title glyph while an agent is mid-turn, and shows a star when idle. */
const WORKING_GLYPHS = new Set(['◐', '◑', '◒', '◓', '◴', '◵', '◶', '◷', '⠋', '⠙', '⠹', '⠸']);

export function terminalIsWorking(title: string): boolean {
  return WORKING_GLYPHS.has((title || ' ')[0] ?? ' ');
}

/**
 * `--screen` reads what the terminal renders. The default returns accumulated output
 * with the repaints left in, so an agent's redrawn status line comes back as stacked
 * fragments rather than the line you can actually see.
 */
export async function readTerminal(handle: string, limit = 200): Promise<TerminalRead> {
  const r = await orca<{ terminal?: { status?: string; tail?: unknown } }>([
    'terminal',
    'read',
    '--terminal',
    handle,
    '--screen',
    '--limit',
    String(limit),
  ]);
  const t = r.terminal ?? {};
  return {
    ...(t.status ? { status: String(t.status) } : {}),
    tail: Array.isArray(t.tail) ? t.tail.map((l) => String(l)) : [],
  };
}

let cachedRepoId: string | null = null;

/**
 * Orca ids are `<repoId>::<path>`, sometimes with a `::workspace:<uuid>` tail. The repo
 * that holds the workspace is the main worktree at or above it; a review workspace on the
 * same repo would do, but the main one is the unambiguous answer.
 */
export function pickRepoId(worktrees: Workspace[], workspaceRoot: string): string | null {
  const holds = (path: string): boolean =>
    path !== '' && (workspaceRoot === path || workspaceRoot.startsWith(`${path}/`));
  const main =
    worktrees.find((w) => w.isMainWorktree && holds(w.path)) ?? worktrees.find((w) => holds(w.path));
  return main?.id.split('::')[0] ?? null;
}

/**
 * The Orca repo that holds the workspace. Orca ids are `<repoId>::<path>`, so the main
 * worktree containing the workspace root carries the id its subfolders need. Discovered
 * rather than configured, because hard-coding it ties the tool to one machine.
 */
export async function workspaceRepoId(workspaceRoot: string): Promise<string> {
  if (ORCA_WORKSPACE_REPO_ID) return ORCA_WORKSPACE_REPO_ID;
  if (cachedRepoId) return cachedRepoId;

  const worktrees = await listWorktrees();
  const id = pickRepoId(worktrees, workspaceRoot);
  if (!id) {
    // Naming the registered roots turns a dead end into a thing you can copy.
    const known = worktrees
      .filter((w) => w.isMainWorktree && w.path)
      .map((w) => w.path)
      .slice(0, 4);
    const suggestion = known.length > 0 ? ` Try one of: ${known.join(', ')}` : '';
    throw new OrcaError(
      `No Orca workspace covers ${workspaceRoot}. Set Workspace in settings.${suggestion}`,
    );
  }
  cachedRepoId = id;
  return id;
}

export async function listWorkspaceAgents(): Promise<WorkspaceAgents[]> {
  const r = await orca<{ worktrees?: Record<string, unknown>[] }>(['worktree', 'ps']);
  return (r.worktrees ?? []).map((w) => ({
    id: String(w['worktreeId'] ?? ''),
    displayName: String(w['displayName'] ?? ''),
    path: String(w['path'] ?? ''),
    branch: String(w['branch'] ?? ''),
    isMainWorktree: Boolean(w['isMainWorktree']),
    agentStates: ((w['agents'] as { state?: string }[] | undefined) ?? []).map((a) => String(a.state ?? '')),
  }));
}

export async function listWorktrees(): Promise<Workspace[]> {
  const r = await orca<{ worktrees: Record<string, unknown>[] }>(['worktree', 'list']);
  return (r.worktrees ?? []).map((w) => ({
    id: String(w['id'] ?? ''),
    displayName: String(w['displayName'] ?? ''),
    path: String(w['path'] ?? ''),
    branch: String(w['branch'] ?? ''),
    isMainWorktree: Boolean(w['isMainWorktree']),
    ...(typeof w['lastActivityAt'] === 'number' ? { lastActivityAt: w['lastActivityAt'] } : {}),
  }));
}

/**
 * Addressed by id, never by path: every workspace on a folder-kind repo reports the same
 * path, so a path selector could match the checkout itself. No --force and no --run-hooks
 * either, so git refuses rather than discards anything it cannot prove is merged.
 */
export async function removeWorktree(id: string): Promise<void> {
  await orca(['worktree', 'rm', '--worktree', `id:${id}`]);
}

/** A failed read gives no states, and a terminal with none still counts as an agent at work. */
async function agentStatesByPane(): Promise<Map<string, string>> {
  const read = await orca<{ worktrees?: { agents?: { paneKey?: string; state?: string }[] }[] }>(['worktree', 'ps']).catch(() => null);
  const agents = (read?.worktrees ?? []).flatMap((w) => w.agents ?? []);
  return new Map(agents.flatMap((a) => (a.paneKey && a.state ? [[a.paneKey, a.state] as const] : [])));
}

export async function listAgentTerminals(): Promise<AgentTerminal[]> {
  const [r, states] = await Promise.all([orca<{ terminals: Record<string, unknown>[] }>(['terminal', 'list']), agentStatesByPane()]);
  return (r.terminals ?? []).map((t) => {
    const state = states.get(`${String(t['tabId'])}:${String(t['leafId'])}`);
    return {
      handle: String(t['handle'] ?? ''),
      title: String(t['title'] ?? ''),
      agent: t['agentIdentity'] ? String(t['agentIdentity']) : undefined,
      connected: Boolean(t['connected']),
      orphaned: Boolean(t['orphaned']),
      lastOutputAt: typeof t['lastOutputAt'] === 'number' ? t['lastOutputAt'] : undefined,
      worktreePath: t['worktreePath'] ? String(t['worktreePath']) : undefined,
      ...(state ? { state } : {}),
    };
  });
}

export interface CreatedWorktree {
  agentTerminalHandle?: string;
  startupTerminal?: { handle?: string };
  worktree?: Worktree;
  launch?: { outcome?: { kind?: string; handle?: string } };
}

export async function createWorktree(opts: {
  repo: string;
  name: string;
  agent?: string;
  prompt?: string;
  baseBranch?: string;
  surface?: 'chat' | 'terminal';
  activate?: boolean;
  model?: string;
  effort?: string;
}): Promise<CreatedWorktree> {
  const args = ['worktree', 'create', '--repo', opts.repo, '--name', opts.name];
  if (opts.agent) args.push('--agent', opts.agent);
  if (opts.prompt) args.push('--prompt', opts.prompt);
  if (opts.model) args.push('--model', opts.model);
  if (opts.effort) args.push('--effort', opts.effort);
  if (opts.baseBranch) args.push('--base-branch', opts.baseBranch);
  if (opts.surface) args.push('--surface', opts.surface);
  if (opts.activate) args.push('--activate');
  return orca<CreatedWorktree>(args);
}

export async function linkWorktreeMr(worktree: string, webUrl: string): Promise<unknown> {
  return orca<unknown>(['worktree', 'set', '--worktree', worktree, '--gitlab-mr', webUrl]);
}

export async function agentStateOn(handle: string): Promise<string | null> {
  const [{ terminals }, { worktrees }] = await Promise.all([
    orca<{ terminals?: { handle?: string; tabId?: string; leafId?: string }[] }>(['terminal', 'list']),
    orca<{ worktrees?: { agents?: { paneKey?: string; state?: string }[] }[] }>(['worktree', 'ps']),
  ]);
  const terminal = (terminals ?? []).find((t) => t.handle === handle);
  if (!terminal) return null;
  const pane = `${terminal.tabId}:${terminal.leafId}`;
  const agent = (worktrees ?? []).flatMap((w) => w.agents ?? []).find((a) => a.paneKey === pane);
  return agent?.state ?? null;
}

export async function createTerminal(opts: {
  worktree: string;
  title?: string;
  command?: string;
  focus?: boolean;
}): Promise<{ handle: string }> {
  const args = ['terminal', 'create', '--worktree', opts.worktree];
  if (opts.title) args.push('--title', opts.title);
  if (opts.command) args.push('--command', opts.command);
  if (opts.focus) args.push('--focus');
  const { terminal } = await orca<{ terminal?: { handle?: string } }>(args);
  if (!terminal?.handle) throw new OrcaError('orca terminal create returned no terminal handle');
  return { handle: terminal.handle };
}

export async function sendToTerminal(opts: {
  terminal: string;
  text: string;
  waitSubmitSeconds?: number;
}): Promise<unknown> {
  const args = ['terminal', 'send', '--terminal', opts.terminal, '--text', opts.text, '--enter'];
  if (opts.waitSubmitSeconds) args.push('--wait-submit', String(opts.waitSubmitSeconds));
  return orca<unknown>(args);
}

export async function closeTerminal(handle: string): Promise<void> {
  await orca(['terminal', 'close', '--terminal', handle]);
}

/** Bring an agent terminal to the front in the Orca UI. */
export async function focusTerminal(handle: string): Promise<unknown> {
  return orca<unknown>(['terminal', 'switch', '--terminal', handle]);
}
