import { mrKey, type Mr, type QueuedComment } from './types.js';

/** A repo with nothing in the list (not polled, or its batch failed) says nothing, so its findings stay. */
export function waitingToPost(queue: QueuedComment[], openMrs: Mr[]): QueuedComment[] {
  const open = new Set(openMrs.map(mrKey));
  const listed = new Set(openMrs.map((mr) => mr.projectPath));
  return queue.filter(
    (c) => c.status === 'pending' && (open.has(mrKey(c)) || !listed.has(c.projectPath)),
  );
}
