import { randomUUID } from 'node:crypto';
import { autoReviewPrompt } from '../config.js';
import { isHeld } from '../data/forge.js';
import { addToQueue, loadAutoMemory, loadQueue, updateAutoMemory } from '../data/store.js';
import { keyParts } from '../refs.js';
import { isOpen, mrKey, type AutoMemory, type AutoPass, type AutoTrigger, type Mr, type QueuedComment } from '../types.js';
import { MAX_LAUNCHES_PER_POLL } from './config.js';
import { passBlocking } from './gates.js';
import { ineligible } from './guards.js';
import { sendAt } from './hold.js';
import { closePass, foundBy, passIdOf, retireShadows, settle, supersedePass } from './ledger.js';
import { askedOnly, levelForMr } from './people.js';
import type { AutoContext, AutoPorts } from './ports.js';
import { cheapTrigger, hasNewReply, passActive, passExpired } from './triggers.js';

export const HEAD_MOVED = 'the head moved while it was being reviewed';

const VERDICT_TEXT = {
  approve: 'Approve: the pass found nothing blocking. Every gate is checked again before it goes.',
  changes: 'Request changes: the pass found something blocking.',
};

/** Decided from what the pass queued and from GitLab, never from anything the agent said. */
export function verdictFor(pass: AutoPass, mr: Mr, queue: QueuedComment[], me: string): 'approve' | 'changes' | null {
  if (passBlocking(foundBy(queue, pass.id))) return isHeld(mr) ? null : 'changes';
  return mr.approvedBy.includes(me) ? null : 'approve';
}

function hasVerdict(queue: QueuedComment[], pass: AutoPass): boolean {
  return queue.some((c) => c.kind === 'verdict' && (c.auto?.pass === pass.id || passIdOf(c) === pass.id));
}

function queueVerdict(pass: AutoPass, mr: Mr, ctx: AutoContext, now: number): void {
  const level = levelForMr(mr, ctx.me, ctx.config);
  if (level !== 'verdict' && level !== 'shadow') return;
  const queue = loadQueue();
  if (hasVerdict(queue, pass)) return;
  const verdict = verdictFor(pass, mr, queue, ctx.me ?? '');
  if (!verdict) return;
  addToQueue([
    {
      projectPath: mr.projectPath,
      projectId: mr.projectId,
      iid: mr.iid,
      webUrl: mr.webUrl,
      severity: verdict === 'changes' ? 'MAJOR' : 'MINOR',
      body: VERDICT_TEXT[verdict],
      createdBy: `auto:${pass.id}`,
      kind: 'verdict',
      verdict,
      auto: { pass: pass.id, level, sendAt: sendAt(now, ctx.config.holdMs) },
    },
  ]);
}

function finishPass(pass: AutoPass, mr: Mr, ctx: AutoContext, now: number): void {
  if (mr.sha !== pass.sha) return supersedePass(pass, HEAD_MOVED);
  settle(pass.key, 'finished');
  queueVerdict(pass, mr, ctx, now);
}

function freshCopy(key: string, ports: AutoPorts): Promise<Mr | null | undefined> {
  const ref = keyParts(key);
  return ref ? ports.freshMr(ref).catch(() => undefined) : Promise.resolve(undefined);
}

/** An MR that merged or closed while its pass ran is off the list, and would otherwise never settle. */
async function settleDone(pass: AutoPass, ctx: AutoContext, ports: AutoPorts): Promise<void> {
  const listed = ctx.mrs.find((m) => mrKey(m) === pass.key);
  const mr = listed ?? (await freshCopy(pass.key, ports));
  if (mr === undefined) return;
  if (mr === null || !isOpen(mr)) return closePass(pass);
  finishPass(pass, mr, ctx, ports.now());
}

export async function settlePasses(ctx: AutoContext, ports: AutoPorts): Promise<void> {
  for (const memory of Object.values(loadAutoMemory())) {
    const pass = memory.pass;
    if (!pass || pass.settled) continue;
    if (passExpired(pass, ports.now())) settle(memory.key, 'expired');
    else if (pass.doneAt) await settleDone(pass, ctx, ports);
  }
}

async function replyArrived(mr: Mr, memory: AutoMemory | undefined, me: string, ports: AutoPorts): Promise<boolean> {
  if (!memory?.pass || memory.notesSeen === mr.notes) return false;
  const threads = await ports.discussions(mr).catch(() => null);
  if (!threads) return false;
  updateAutoMemory(mrKey(mr), (m) => ({ ...m, notesSeen: mr.notes }));
  return hasNewReply(threads, me, memory.pass.launchedAt, memory.handedBack ?? []);
}

function busy(memory: AutoMemory | undefined, mr: Mr, ctx: AutoContext, now: number): boolean {
  const unsettled = Boolean(memory?.pass?.doneAt && !memory.pass.settled);
  return passActive(memory?.pass, now) || unsettled || Boolean(ctx.agentOn?.(mr));
}

async function triggerFor(mr: Mr, me: string, ctx: AutoContext, ports: AutoPorts): Promise<AutoTrigger | null> {
  if (!levelForMr(mr, me, ctx.config) || ineligible(mr, me)) return null;
  const memory = loadAutoMemory()[mrKey(mr)];
  if (busy(memory, mr, ctx, ports.now())) return null;
  const quick = cheapTrigger(mr, memory);
  if (quick) return quick;
  return (await replyArrived(mr, memory, me, ports)) ? 'reply' : null;
}

async function startPass(mr: Mr, trigger: AutoTrigger, me: string, ctx: AutoContext, ports: AutoPorts): Promise<string | null> {
  const key = mrKey(mr);
  const previous = loadAutoMemory()[key]?.pass;
  const level = levelForMr(mr, me, ctx.config);
  const pass: AutoPass = {
    ...(level ? { level } : {}),
    ...(askedOnly(mr, ctx.config) ? { asked: true } : {}),
    id: randomUUID(),
    key,
    author: mr.author,
    sha: mr.sha,
    trigger,
    launchedAt: new Date(ports.now()).toISOString(),
    previousSha: previous?.sha ?? null,
  };
  retireShadows(key);
  updateAutoMemory(key, (m) => ({ ...m, pass, notesSeen: mr.notes }));
  const since = trigger === 'new' ? null : pass.previousSha;
  try {
    await ports.launch(mr, autoReviewPrompt({ webUrl: mr.webUrl, passId: pass.id, me, since }));
    return null;
  } catch (e) {
    settle(key, 'failed');
    return `${key}: ${e instanceof Error ? e.message : String(e)}`;
  }
}

export interface LaunchReport {
  launched: string[];
  /** Of those, the ones reviewed only because they ask for you. */
  asked: string[];
  errors: string[];
}

/** Bounded per poll, so switching someone on does not start an agent on every MR at once; pause is read before each one. */
export async function launchPasses(ctx: AutoContext, ports: AutoPorts): Promise<LaunchReport> {
  const report: LaunchReport = { launched: [], asked: [], errors: [] };
  const me = ctx.me;
  if (!me) return report;
  const stopped = (): boolean => ports.paused() || Boolean(ctx.noLaunch);
  for (const mr of ctx.mrs) {
    if (report.launched.length + report.errors.length >= MAX_LAUNCHES_PER_POLL || stopped()) break;
    const trigger = await triggerFor(mr, me, ctx, ports);
    if (!trigger || stopped() || ctx.agentOn?.(mr)) continue;
    const error = await startPass(mr, trigger, me, ctx, ports);
    if (error) report.errors.push(error);
    else report.launched.push(mrKey(mr));
    if (!error && askedOnly(mr, ctx.config)) report.asked.push(mrKey(mr));
  }
  return report;
}
