import { setBaseline } from '../actions/watch.js';
import { reReviewPrompt } from '../config.js';
import { mutateState } from '../data/store.js';
import {
  fingerprint,
  fingerprintDiffers,
  isOpen,
  mrKey,
  ownWrites,
  type Fingerprint,
  type Mr,
  type OwnActivity,
  type OwnWrite,
  type Watch,
} from '../types.js';
import { MAX_LAUNCHES_PER_POLL } from './config.js';
import { levelForMr } from './people.js';
import { hasNewReply } from './triggers.js';
import type { AutoContext, AutoPorts } from './ports.js';

export interface ReReviewReport {
  reReviewed: string[];
  errors: string[];
}

function without(current: Fingerprint, writes: OwnWrite[]): Fingerprint {
  const total = (field: keyof OwnActivity): number => writes.reduce((sum, w) => sum + w[field], 0);
  return {
    ...current,
    notes: current.notes - total('notes'),
    approvals: current.approvals - total('approvals'),
    ...(current.unresolved === undefined ? {} : { unresolved: current.unresolved - total('unresolved') }),
  };
}

/** Any move counts except the engine's own writes, and one that landed while either copy was read may or may not show in it. */
export function movedSince(watch: Watch, mr: Mr): boolean {
  const readAt = mr.readAt ?? Date.now();
  if (watch.seenAt !== undefined && readAt < watch.seenAt) return false;
  const writes = ownWrites(watch);
  const current = fingerprint(mr);
  const maybeInBaseline = writes.filter((w) => w.maybeSeen).length;
  const surelyInCopy = writes.filter((w) => w.at < readAt).length;
  for (let from = 0; from <= maybeInBaseline; from += 1) {
    for (let to = Math.max(from, surelyInCopy); to <= writes.length; to += 1) {
      if (!fingerprintDiffers(watch.seen, without(current, writes.slice(from, to)))) return false;
    }
  }
  return true;
}

export interface ChangeSince {
  headMoved: boolean;
  notes: number;
  resolved: number;
  approvals: number;
  pipeline: string | null;
}

/** What moved since your review, with the engine's own writes taken out, for the page to say in words. */
export function changeSince(watch: Watch, mr: Mr): ChangeSince {
  const current = without(fingerprint(mr), ownWrites(watch));
  const seen = watch.seen;
  return {
    headMoved: current.sha !== seen.sha,
    notes: Math.max(0, current.notes - seen.notes),
    resolved: seen.unresolved === undefined || current.unresolved === undefined ? 0 : Math.max(0, seen.unresolved - current.unresolved),
    approvals: current.approvals - seen.approvals,
    pipeline: current.pipeline !== seen.pipeline ? current.pipeline : null,
  };
}

function wanted(watch: Watch | undefined, mr: Mr, ctx: AutoContext): watch is Watch {
  if (!watch?.auto || levelForMr(mr, ctx.me, ctx.config)) return false;
  return !ctx.agentOn?.(mr) && movedSince(watch, mr);
}

export interface Baseline {
  seen: Fingerprint;
  seenAt?: number;
  own?: OwnWrite[];
  relaunch?: Watch['relaunch'];
}

/** Checked and moved on together under the state lock, so one change fires once, whichever front end sees it. */
export function takeChange(mr: Mr, { autoOnly = true } = {}): Baseline | null {
  return mutateState((state) => {
    const watch = state.watches[mrKey(mr)];
    if (!watch || (autoOnly && !watch.auto) || !movedSince(watch, mr)) return null;
    const { seen, seenAt, own, relaunch } = watch;
    const before: Baseline = { seen, ...(seenAt === undefined ? {} : { seenAt }), ...(own ? { own } : {}), ...(relaunch ? { relaunch } : {}) };
    setBaseline(watch, mr);
    delete watch.notesChecked;
    delete watch.relaunch;
    return before;
  });
}

/** A launch that threw leaves the change where it was, so the next poll tries it again. */
export function giveBack(mr: Mr, before: Baseline, error: string): void {
  mutateState((state) => {
    const watch = state.watches[mrKey(mr)];
    if (!watch) return;
    watch.seen = before.seen;
    if (before.seenAt === undefined) delete watch.seenAt;
    else watch.seenAt = before.seenAt;
    if (before.own) watch.own = before.own;
    else delete watch.own;
    const tries = before.relaunch?.sha === mr.sha ? before.relaunch.tries + 1 : 1;
    watch.relaunch = { sha: mr.sha, tries, error };
  });
}

const PIPELINE_GOING = new Set(['CREATED', 'WAITING_FOR_RESOURCE', 'PREPARING', 'PENDING', 'RUNNING', 'SCHEDULED']);
export const SETTLE_MS = 30 * 60_000;
export const MAX_RELAUNCHES = 3;

function patchWatch(key: string, patch: (watch: Watch) => void): void {
  mutateState((state) => {
    const watch = state.watches[key];
    if (watch) patch(watch);
  });
}

/** A push and the pipeline it starts are one change: a new head waits a poll, then until its pipeline ends or half an hour. */
function headSettled(watch: Watch, mr: Mr, now: number): boolean {
  if (watch.moving?.sha !== mr.sha) {
    patchWatch(mrKey(mr), (w) => { w.moving = { sha: mr.sha, since: now }; });
    return false;
  }
  return !PIPELINE_GOING.has(mr.pipeline ?? '') || now - watch.moving.since >= SETTLE_MS;
}

/** On the same head only a person's new word on a thread you opened launches; the rest folds into the next pass. */
async function personReplied(watch: Watch, mr: Mr, me: string, ports: AutoPorts): Promise<boolean> {
  if (mr.notes <= watch.seen.notes || watch.notesChecked === mr.notes) return false;
  const threads = await ports.discussions(mr).catch(() => null);
  if (!threads) return false;
  patchWatch(mrKey(mr), (w) => { w.notesChecked = mr.notes; });
  const since = new Date(watch.seenAt ?? Date.parse(watch.reviewedAt ?? watch.addedAt)).toISOString();
  return hasNewReply(threads, me, since, []);
}

async function worthLaunching(watch: Watch, mr: Mr, me: string, ports: AutoPorts): Promise<boolean> {
  if (watch.relaunch?.sha === mr.sha && watch.relaunch.tries >= MAX_RELAUNCHES) return false;
  if (mr.sha !== watch.seen.sha) return headSettled(watch, mr, ports.now());
  return personReplied(watch, mr, me, ports);
}

async function launch(mr: Mr, before: Baseline, me: string, ports: AutoPorts, report: ReReviewReport): Promise<void> {
  try {
    await ports.launch(mr, reReviewPrompt({ webUrl: mr.webUrl, me, since: before.seen.sha, head: mr.sha }));
    report.reReviewed.push(mrKey(mr));
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    giveBack(mr, before, error);
    report.errors.push(`re-review of ${mrKey(mr)}: ${error}`);
  }
}

/** The baseline on disk is the only guard, so a restart, a reload or the other front end never fires twice. */
export async function autoReReview(ctx: AutoContext, ports: AutoPorts, watches: Record<string, Watch>): Promise<ReReviewReport> {
  const report: ReReviewReport = { reReviewed: [], errors: [] };
  const me = ctx.me;
  if (!me) return report;
  for (const mr of ctx.mrs) {
    if (report.reReviewed.length + report.errors.length >= MAX_LAUNCHES_PER_POLL || ports.paused()) break;
    const watch = watches[mrKey(mr)];
    if (!wanted(watch, mr, ctx)) continue;
    // Fetched again, so an engine write that landed since the list was read is counted on both sides.
    const fresh = await ports.freshMr(mr).catch(() => null);
    if (!fresh || !isOpen(fresh) || ports.paused() || ctx.agentOn?.(mr)) continue;
    if (!(await worthLaunching(watch, fresh, me, ports))) continue;
    const before = takeChange(fresh);
    // A fresh read labels the repo with GitLab's project name, but gc and clean-up find workspaces by the list's label.
    if (before) await launch({ ...fresh, repoLabel: mr.repoLabel }, before, me, ports, report);
  }
  return report;
}
