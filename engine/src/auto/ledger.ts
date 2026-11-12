import { changeUnsent, loadQueue, updateAutoMemory, updateQueueItem } from '../data/store.js';
import { keyOf } from '../refs.js';
import { dropped, type AutoPass, type QueuedComment } from '../types.js';

export { keyOf };

/** Only adoption turns this tag into an auto mark; nothing the agent sends can. */
export function passIdOf(c: QueuedComment): string | null {
  return c.createdBy.startsWith('auto:') ? c.createdBy.slice('auto:'.length) : null;
}

/** What a pass found and you have not thrown away, which is what its verdict rests on. */
export function foundBy(queue: QueuedComment[], pass: string): QueuedComment[] {
  return queue.filter((c) => passIdOf(c) === pass && c.kind !== 'verdict' && !dropped(c));
}

export function settle(key: string, settled: AutoPass['settled']): void {
  updateAutoMemory(key, (m) => (m.pass ? { ...m, pass: { ...m.pass, settled } } : m));
}

function unsent(c: QueuedComment): boolean {
  return c.status === 'pending' && Boolean(c.auto) && !c.auto?.held;
}

/** Judged again on the item as it is under the lock, so one posted or being sent since the read is left alone. */
function dropUnsent(match: (c: QueuedComment) => boolean, reason: string): void {
  const drop = (c: QueuedComment): Partial<QueuedComment> | null =>
    unsent(c) && match(c) && c.auto ? { status: 'discarded', auto: { ...c.auto, superseded: reason } } : null;
  for (const c of loadQueue()) if (drop(c)) changeUnsent(c.id, drop);
}

/** Findings about a head that has gone are dropped, and the next poll reviews the new one. */
export function supersedePass(pass: AutoPass, reason: string): void {
  dropUnsent((c) => c.auto?.pass === pass.id, reason);
  settle(pass.key, 'superseded');
}

export function closePass(pass: AutoPass): void {
  dropUnsent((c) => c.auto?.pass === pass.id, 'its MR is no longer open');
  settle(pass.key, 'closed');
}

/** Shadow items are never sent, so without this every push would stack another copy. */
export function retireShadows(key: string): void {
  dropUnsent((c) => keyOf(c) === key && c.auto?.level === 'shadow', 'a newer pass replaced it');
}

export function handBack(key: string, thread: string): void {
  updateAutoMemory(key, (m) => ({ ...m, handedBack: [...new Set([...(m.handedBack ?? []), thread])] }));
}

export function holdItem(item: QueuedComment, why: string): void {
  if (!item.auto) return;
  updateQueueItem(item.id, { auto: { ...item.auto, held: why } });
  if (item.kind === 'reply' && item.replyTo) handBack(keyOf(item), item.replyTo);
}
