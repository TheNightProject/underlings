import { isHeld, type Discussion } from '../data/forge.js';
import {
  CLAIM_LIFE_MS,
  claimToSend,
  loadAutoMemory,
  loadQueue,
  releaseClaim,
  takeBackClaims,
  updateAutoMemory,
  updateQueueItem,
} from '../data/store.js';
import { isOpen, type AutoPass, type Mr, type QueuedComment } from '../types.js';
import type { AutoConfig } from './config.js';
import { approvalBlockers, fixedInCode, passBlocking, type ApprovalFacts } from './gates.js';
import { ineligible, replyBlocker } from './guards.js';
import { dueItems } from './hold.js';
import { foundBy, handBack, holdItem, keyOf, supersedePass } from './ledger.js';
import { HEAD_MOVED } from './passes.js';
import { atLeast, levelForMr } from './people.js';
import type { AutoContext, AutoPorts } from './ports.js';

interface Ready {
  mr: Mr;
  pass: AutoPass;
}

export interface SendReport {
  sent: number;
  held: number;
}

function levelBlocker(item: QueuedComment, mr: Mr, me: string, config: AutoConfig): string | null {
  const level = levelForMr(mr, me, config);
  if (!level) return 'its author is not in full auto any more';
  return atLeast(level, item.kind === 'verdict' ? 'verdict' : 'comments') ? null : `its author is at ${level} now`;
}

function claimer(ctx: AutoContext): string {
  return ctx.claimBy ?? `auto:${process.pid}`;
}

function readiness(item: QueuedComment, mr: Mr | null, me: string, config: AutoConfig): Ready | string {
  const pass = loadAutoMemory()[keyOf(item)]?.pass;
  if (!mr || !isOpen(mr)) return 'it is no longer open';
  if (!pass || pass.id !== item.auto?.pass) return 'a newer pass has replaced it';
  const blocked = ineligible(mr, me) ?? levelBlocker(item, mr, me, config);
  if (blocked) return blocked;
  return mr.sha === pass.sha ? { mr, pass } : HEAD_MOVED;
}

interface Check {
  why?: string;
  thread?: Discussion;
}

async function replyCheck(item: QueuedComment, mr: Mr, me: string, ports: AutoPorts): Promise<Check> {
  const thread = (await ports.discussions(mr)).find((t) => t.id === item.replyTo);
  const why = replyBlocker(thread, me);
  return why ? { why } : { thread };
}

async function approvalFacts({ mr, pass }: Ready, me: string, ports: AutoPorts): Promise<ApprovalFacts> {
  const [threads, diff] = await Promise.all([
    ports.discussions(mr),
    ports.diffStats(mr),
  ]);
  const queue = loadQueue();
  return {
    mr,
    me,
    passSha: pass.sha,
    blocking: passBlocking(foundBy(queue, pass.id)),
    threads,
    diff,
    heldByHand: isHeld(mr) && !loadAutoMemory()[pass.key]?.autoHeld,
    handedBack: queue.filter((c) => c.auto?.pass === pass.id && c.status === 'pending' && c.auto.held).length,
  };
}

async function verdictCheck(item: QueuedComment, ready: Ready, me: string, ctx: AutoContext, ports: AutoPorts): Promise<Check> {
  if (item.verdict === 'changes') return isHeld(ready.mr) ? { why: 'changes are already requested' } : {};
  const blockers = approvalBlockers(await approvalFacts(ready, me, ports), ctx.config);
  return blockers.length > 0 ? { why: blockers.join('; ') } : {};
}

function kindCheck(item: QueuedComment, ready: Ready, me: string, ctx: AutoContext, ports: AutoPorts): Promise<Check> {
  if (item.kind === 'reply') return replyCheck(item, ready.mr, me, ports);
  if (item.kind === 'verdict') return verdictCheck(item, ready, me, ctx, ports);
  return Promise.resolve({});
}

async function resolveIfFixed(item: QueuedComment, mr: Mr, thread: Discussion, ports: AutoPorts): Promise<void> {
  const from = thread.position?.head_sha;
  const changed = from && mr.sha ? await ports.changedPaths(mr, from, mr.sha).catch(() => []) : [];
  if (!fixedInCode(thread.position, mr.sha, changed) || !item.auto) return;
  await ports.resolve(mr, thread.id);
  updateQueueItem(item.id, { auto: { ...item.auto, sentAuto: true, resolved: true } });
}

async function afterSend(item: QueuedComment, mr: Mr, thread: Discussion | undefined, ports: AutoPorts): Promise<void> {
  if (item.kind === 'reply' && item.outcome === 'fixed' && thread) {
    await resolveIfFixed(item, mr, thread, ports).catch(() => undefined);
  }
  if (item.kind === 'verdict') {
    updateAutoMemory(keyOf(item), (m) => ({ ...m, autoHeld: item.verdict === 'changes' }));
  }
}

function hold(item: QueuedComment, why: string, report: SendReport): void {
  holdItem(item, why);
  report.held += 1;
}

function dropPassOf(item: QueuedComment, ctx: AutoContext): void {
  // Dropping refuses any item a send has claimed, this one's own claim included.
  releaseClaim(item.id, claimer(ctx));
  const pass = loadAutoMemory()[keyOf(item)]?.pass;
  if (pass) supersedePass(pass, HEAD_MOVED);
}

async function sendClaimed(item: QueuedComment, mr: Mr | null, me: string, ctx: AutoContext, ports: AutoPorts, report: SendReport): Promise<void> {
  const ready = readiness(item, mr, me, ctx.config);
  if (ready === HEAD_MOVED) return dropPassOf(item, ctx);
  if (typeof ready === 'string') return hold(item, ready, report);
  const check = await kindCheck(item, ready, me, ctx, ports).catch(() => null);
  if (!check) return;
  if (check.why) return hold(item, check.why, report);
  const outcome = await ports.post(item, { automatic: true, footer: ctx.config.footer, claimedBy: claimer(ctx) });
  if (!outcome.ok) return hold(item, `sending failed: ${outcome.error ?? 'no reason given'}`, report);
  report.sent += 1;
  await afterSend(item, ready.mr, check.thread, ports);
}

async function sendOne(item: QueuedComment, mr: Mr | null, me: string, ctx: AutoContext, ports: AutoPorts, report: SendReport): Promise<void> {
  try {
    await sendClaimed(item, mr, me, ctx, ports, report);
  } finally {
    releaseClaim(item.id, claimer(ctx));
  }
}

/** Taken under the queue lock just before sending, so a cancel, a rewrite, a manual post or another driver is respected. */
function claimDue(id: string, ctx: AutoContext, ports: AutoPorts): QueuedComment | undefined {
  if (ctx.isEditing?.(id)) return undefined;
  const claim = claimToSend(id, claimer(ctx), ports.now());
  return 'item' in claim ? claim.item : undefined;
}

/** Whoever left these cannot finish them, and resending could post twice, so they go back to you. */
function handBackClaims(ctx: AutoContext, ports: AutoPorts, report: SendReport): void {
  for (const item of takeBackClaims(claimer(ctx), ports.now(), CLAIM_LIFE_MS)) {
    report.held += 1;
    if (item.auto && item.kind === 'reply' && item.replyTo) handBack(keyOf(item), item.replyTo);
  }
}

function byMr(items: QueuedComment[]): QueuedComment[][] {
  const groups = new Map<string, QueuedComment[]>();
  for (const item of items) groups.set(keyOf(item), [...(groups.get(keyOf(item)) ?? []), item]);
  return [...groups.values()];
}

async function sendGroup(items: QueuedComment[], me: string, ctx: AutoContext, ports: AutoPorts, report: SendReport): Promise<void> {
  const first = items[0];
  if (!first) return;
  // A read that failed is retried next tick; only a merge request GitLab says is gone is null.
  const mr = await ports.freshMr(first).catch(() => undefined);
  if (mr === undefined) return;
  for (const item of items) {
    if (ports.paused()) return;
    const claimed = claimDue(item.id, ctx, ports);
    if (claimed) await sendOne(claimed, mr, me, ctx, ports, report);
  }
}

export async function sendDue(ctx: AutoContext, ports: AutoPorts): Promise<SendReport> {
  const report: SendReport = { sent: 0, held: 0 };
  const me = ctx.me;
  if (!me) return report;
  handBackClaims(ctx, ports, report);
  for (const group of byMr(dueItems(loadQueue(), ports.now()))) {
    if (ports.paused()) break;
    await sendGroup(group, me, ctx, ports, report);
  }
  return report;
}
