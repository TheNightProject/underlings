import { loadAutoMemory, loadQueue, updateQueueItem } from '../data/store.js';
import { mrKey, SEVERITY_ORDER, type AutoLevel, type AutoMark, type AutoMemory, type QueuedComment } from '../types.js';
import type { AutoConfig } from './config.js';
import { passComments, threadCapReason } from './guards.js';
import { sendAt } from './hold.js';
import { handBack, keyOf, passIdOf } from './ledger.js';
import { levelFor, levelForMr } from './people.js';
import type { AutoContext, AutoPorts } from './ports.js';

/** Replies first, because closing your threads is worth more than opening new ones. */
function adoptionOrder(items: QueuedComment[]): QueuedComment[] {
  const rank = (c: QueuedComment): number => (c.kind === 'reply' ? -1 : SEVERITY_ORDER.indexOf(c.severity));
  return [...items].sort((a, b) => rank(a) - rank(b));
}

function heldReason(
  item: QueuedComment,
  memory: AutoMemory | undefined,
  level: AutoLevel | null,
  queue: QueuedComment[],
  config: AutoConfig,
): string | null {
  if (!memory?.pass) return 'it names a pass this merge request is not running';
  if (!level) return 'its author is not in full auto any more';
  if (item.kind === 'reply' && memory.handedBack?.includes(item.replyTo ?? '')) return 'that thread is yours now';
  const capped = item.kind === 'reply' ? threadCapReason(item, queue) : null;
  if (capped) return capped;
  const sent = passComments(queue, memory.pass.id);
  return sent >= config.maxComments ? `over the cap of ${config.maxComments} comments for one pass` : null;
}

function staleReason(item: QueuedComment, memory: AutoMemory | undefined): string | null {
  if (!memory?.pass) return null;
  if (memory.pass.id !== passIdOf(item)) return 'a newer pass replaced it';
  return memory.pass.settled === 'superseded' ? 'its pass was superseded' : null;
}

function levelOf(memory: AutoMemory | undefined, ctx: AutoContext): AutoLevel | null {
  if (!memory?.pass) return null;
  const mr = ctx.mrs.find((m) => mrKey(m) === memory.key);
  return mr ? levelForMr(mr, ctx.me, ctx.config) : levelFor(memory.pass.author, ctx.config.people);
}

function patchFor(item: QueuedComment, memory: AutoMemory | undefined, queue: QueuedComment[], ctx: AutoContext, now: number): Partial<QueuedComment> {
  const config = ctx.config;
  const level = levelOf(memory, ctx);
  const mark: AutoMark = { pass: passIdOf(item) ?? '', level: level ?? 'shadow', sendAt: sendAt(now, config.holdMs) };
  const stale = staleReason(item, memory);
  if (stale) return { status: 'discarded', auto: { ...mark, superseded: stale } };
  const held = heldReason(item, memory, level, queue, config);
  return { auto: held ? { ...mark, held } : mark };
}

/** Counted as each is adopted, so a batch arriving at once cannot slip past the caps. */
export function adoptLanded(ctx: AutoContext, ports: AutoPorts): number {
  let queue = loadQueue();
  const landed = queue.filter((c) => c.status === 'pending' && !c.auto && passIdOf(c));
  for (const item of adoptionOrder(landed)) {
    const memory = loadAutoMemory()[keyOf(item)];
    const patch = patchFor(item, memory, queue, ctx, ports.now());
    updateQueueItem(item.id, patch);
    if (patch.auto?.held && item.kind === 'reply' && item.replyTo) handBack(keyOf(item), item.replyTo);
    queue = queue.map((c) => (c.id === item.id ? { ...c, ...patch } : c));
  }
  return landed.length;
}
