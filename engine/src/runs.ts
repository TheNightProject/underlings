import { agentWorking } from './agents/host.js';
import { readTerminal } from './agents/index.js';
import type { AgentTerminal, TerminalRead } from './agents/host.js';
import { loadRuns, loadState, recordRun } from './data/store.js';
import type { ReviewRun, Watch } from './types.js';

export const MAX_READS_PER_CAPTURE = 12;

export interface CaptureOptions {
  /** False when the agent list failed, which says nothing about whether an agent has gone. */
  listed: boolean;
  /** When the agents were listed, so a run started since is not read as gone from a list that predates it. */
  listedAt?: number;
  read?: (handle: string) => Promise<TerminalRead>;
  now?: number;
}

interface Target {
  key: string;
  terminal: string;
  run: ReviewRun | undefined;
  webUrl: string;
}

/** A run being launched, or that failed to, has no terminal yet, and the watch's is the last run's. */
function currentTerminal(run: ReviewRun | undefined, watch: Watch | undefined): string | undefined {
  if (run?.terminal) return run.terminal;
  if (run?.status === 'launching' || run?.status === 'launch failed') return undefined;
  return watch?.terminal;
}

function targets(runs: Record<string, ReviewRun>, watches: Record<string, Watch>): Target[] {
  const keys = [...new Set([...Object.keys(runs), ...Object.keys(watches)])];
  return keys
    .flatMap((key) => {
      const terminal = currentTerminal(runs[key], watches[key]);
      const webUrl = runs[key]?.webUrl || watches[key]?.webUrl || '';
      return terminal ? [{ key, terminal, run: runs[key], webUrl }] : [];
    })
    .sort((a, b) => (b.run?.startedAt ?? '').localeCompare(a.run?.startedAt ?? ''));
}

function startedSince(run: ReviewRun | undefined, at: number | undefined): boolean {
  return at !== undefined && run !== undefined && Date.parse(run.startedAt) >= at;
}

function markEnded(target: Target, now: number): void {
  if (!target.run || target.run.status === 'ended') return;
  recordRun(target.key, { status: 'ended', endedAt: new Date(now).toISOString() });
}

function markLive(target: Target, status: 'working' | 'idle'): void {
  if (!target.run || (target.run.status === status && target.run.endedAt === undefined)) return;
  recordRun(target.key, { status, endedAt: undefined });
}

function hasNewOutput(t: AgentTerminal, run: ReviewRun | undefined): boolean {
  if (t.lastOutputAt === undefined || !run?.capturedAt) return true;
  return t.lastOutputAt > Date.parse(run.capturedAt);
}

/** An agent's terminal or log goes with its workspace, so the journal keeps what each review agent last showed. */
export async function captureReviewOutput(terminals: AgentTerminal[], options: CaptureOptions): Promise<number> {
  const { listed, listedAt, read = readTerminal, now = Date.now() } = options;
  const byHandle = new Map(terminals.map((t) => [t.handle, t]));
  let reads = 0;
  let captured = 0;
  for (const target of targets(loadRuns(), loadState().watches)) {
    const t = byHandle.get(target.terminal);
    if (!t) {
      if (listed && !startedSince(target.run, listedAt)) markEnded(target, now);
      continue;
    }
    if (!t.agent || t.orphaned || !t.connected) continue;
    const status = agentWorking(t) ? 'working' : 'idle';
    if (!hasNewOutput(t, target.run) || reads >= MAX_READS_PER_CAPTURE) {
      markLive(target, status);
      continue;
    }
    reads += 1;
    const screen = await read(t.handle).catch(() => null);
    if (!screen || screen.tail.length === 0) {
      markLive(target, status);
      continue;
    }
    recordRun(target.key, {
      webUrl: target.webUrl,
      terminal: t.handle,
      ...(t.worktreePath ? { worktreePath: t.worktreePath } : {}),
      status,
      endedAt: undefined,
      tail: screen.tail,
      capturedAt: new Date(now).toISOString(),
    });
    captured += 1;
  }
  return captured;
}
