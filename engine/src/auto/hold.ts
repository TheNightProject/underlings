import type { QueuedComment } from '../types.js';

export function sendAt(now: number, holdMs: number): string {
  return new Date(now + holdMs).toISOString();
}

export function sendsItself(c: QueuedComment): boolean {
  return c.status === 'pending' && Boolean(c.auto) && !c.auto?.held && c.auto?.level !== 'shadow';
}

/** A verdict goes last, after everything its pass said, so it never outruns the reasons. */
function waitingOnItsPass(item: QueuedComment, queue: QueuedComment[]): boolean {
  return queue.some(
    (c) => c.id !== item.id && c.kind !== 'verdict' && c.auto?.pass === item.auto?.pass && sendsItself(c),
  );
}

/** Renewed well inside its life, so a closed tab or a killed front end frees the item within a minute and a half. */
export const EDIT_MARK_MS = 90_000;
export const EDIT_RENEW_MS = 30_000;

export function beingEdited(item: QueuedComment, now: number): boolean {
  return Boolean(item.editing && Date.parse(item.editing.until) > now);
}

export function isDue(item: QueuedComment, queue: QueuedComment[], now: number): boolean {
  if (!sendsItself(item) || item.sending || beingEdited(item, now)) return false;
  if (Date.parse(item.auto?.sendAt ?? '') > now) return false;
  return item.kind !== 'verdict' || !waitingOnItsPass(item, queue);
}

export function dueItems(queue: QueuedComment[], now: number): QueuedComment[] {
  return queue.filter((c) => isDue(c, queue, now));
}

/** Resuming starts every window again, so a backlog built up while paused does not all go at once. */
export function rearmed(queue: QueuedComment[], now: number, holdMs: number): { id: string; sendAt: string }[] {
  return queue
    .filter((c) => sendsItself(c) && Date.parse(c.auto?.sendAt ?? '') < now + holdMs)
    .map((c) => ({ id: c.id, sendAt: sendAt(now, holdMs) }));
}
