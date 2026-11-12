import type { AgentTerminal } from '../agents/host.js';
import { loadRuns, loadSettings, loadState } from '../data/store.js';
import { captureReviewOutput } from '../runs.js';
import { mrKey, type Mr, type ReviewRun, type Watch } from '../types.js';
import { autoConfig } from './config.js';
import { dailyReReviews } from './daily.js';
import { autoPoll, autoTick } from './engine.js';
import { livePorts } from './live.js';
import type { AutoContext, AutoPorts } from './ports.js';
import { autoReReview } from './rereview.js';

export interface BackgroundInput {
  mrs: Mr[];
  me: string | undefined;
  terminals: AgentTerminal[];
  terminalsError?: string | undefined;
  /** When the hosts were asked for their agents; the poll's own start if not given. */
  listedAt?: number | undefined;
  claimBy: string;
  isEditing?: (id: string) => boolean;
}

export interface BackgroundReport {
  launched: string[];
  asked: string[];
  reReviewed: string[];
  sent: number;
  held: number;
  captured: number;
  errors: string[];
}

function emptyReport(): BackgroundReport {
  return { launched: [], asked: [], reReviewed: [], sent: 0, held: 0, captured: 0, errors: [] };
}

/** Longer than a launch can take: an Orca one's calls, each at its timeout, add up to under five minutes. */
const LAUNCH_IN_FLIGHT_MS = 5 * 60_000;

/** Launched by either front end, and either not back from its host yet or started since the agents were listed. */
function launchedUnlisted(run: ReviewRun | undefined, listedAt: number | undefined, now: number): boolean {
  if (!run) return false;
  const started = Date.parse(run.startedAt);
  if (run.status === 'launching') return now - started < LAUNCH_IN_FLIGHT_MS;
  const live = run.status === 'working' || run.status === 'idle';
  return live && listedAt !== undefined && started >= listedAt;
}

/** One agent per MR: a second would hold it again and queue the same findings twice. Claude stays open after a review, so one Orca calls done no longer counts. */
export function agentOnFor(
  watches: Record<string, Watch>,
  runs: Record<string, ReviewRun>,
  terminals: AgentTerminal[],
  { listedAt, now = Date.now() }: { listedAt?: number | undefined; now?: number } = {},
): (mr: Mr) => boolean {
  const alive = new Set(terminals.filter((t) => t.agent && t.connected && !t.orphaned && t.state !== 'done').map((t) => t.handle));
  return (mr) => {
    const key = mrKey(mr);
    if (launchedUnlisted(runs[key], listedAt, now)) return true;
    return [watches[key]?.terminal, runs[key]?.terminal].some((t) => t !== undefined && alive.has(t));
  };
}

/** Read from disk each time it is asked, so a launch either front end started since is seen before the next one. */
export function agentOnNow(terminals: AgentTerminal[], listedAt: number | undefined): (mr: Mr) => boolean {
  return (mr) => agentOnFor(loadState().watches, loadRuns(), terminals, { listedAt })(mr);
}

function contextFor(input: BackgroundInput, listedAt: number | undefined): AutoContext {
  return {
    mrs: input.mrs,
    me: input.me,
    config: autoConfig(loadSettings()),
    agentOn: agentOnNow(input.terminals, listedAt),
    claimBy: input.claimBy,
    ...(input.isEditing ? { isEditing: input.isEditing } : {}),
    ...(input.terminalsError
      ? { noLaunch: `not launching: the agents could not be listed (${input.terminalsError})` }
      : {}),
  };
}

const holding = (ports: AutoPorts): boolean => ports.held?.() ?? true;

/** Pause stops launches, sends and auto re-review; run output is still captured. */
export async function backgroundPoll(input: BackgroundInput, ports: AutoPorts): Promise<BackgroundReport> {
  const report = emptyReport();
  if (!holding(ports)) return report;
  const listedAt = input.listedAt ?? Date.now();
  const ctx = contextFor(input, listedAt);
  const auto = await autoPoll(ctx, ports);
  Object.assign(report, { launched: auto.launched, asked: auto.asked, sent: auto.sent, held: auto.held, errors: [...auto.errors] });
  if (ctx.noLaunch) return { ...report, errors: [...report.errors, ctx.noLaunch] };
  if (!holding(ports)) return report;
  for (const pass of [autoReReview, dailyReReviews]) {
    const again = await pass(ctx, ports, loadState().watches);
    report.reReviewed.push(...again.reReviewed);
    report.errors.push(...again.errors);
    if (!holding(ports)) return report;
  }
  report.captured = await captureReviewOutput(input.terminals, { listed: true, listedAt, read: ports.readTerminal, now: ports.now() });
  return report;
}

export async function backgroundTick(input: BackgroundInput, ports: AutoPorts): Promise<BackgroundReport> {
  const report = emptyReport();
  if (!holding(ports)) return report;
  const { sent, held } = await autoTick(contextFor(input, input.listedAt), ports);
  return { ...report, sent, held };
}

/** Losing the turn reads as a pause, so a step part way through stops before its next launch or send. */
export function fencedPorts(held: () => boolean, base: AutoPorts = livePorts): AutoPorts {
  return { ...base, held, paused: () => base.paused() || !held() };
}

export function reportLine(report: Partial<BackgroundReport>): string | null {
  const parts = [
    ...(report.launched ?? []).map((key) => (report.asked?.includes(key) ? `reviewing ${key}, it asks for you` : `reviewing ${key}`)),
    ...(report.reReviewed ?? []).map((key) => `re-reviewing ${key}`),
    ...(report.sent ? [`sent ${report.sent}`] : []),
    ...(report.held ? [`${report.held} handed back to you`] : []),
  ];
  return parts.length > 0 ? `auto: ${parts.join(', ')}` : null;
}
