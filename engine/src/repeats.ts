import type { Discussion } from './data/forge.js';
import { mrKey, type QueuedComment } from './types.js';

const SEVERITY_TAG = /^\s*\**\s*\[?(CRITICAL|MAJOR|MINOR|NIT|QUESTION|NAB|CONSIDER)\]?\s*[:\-–]?\s*\**\s*/i;

function firstLine(body: string): string {
  return body.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
}

function plain(text: string): string {
  return text.replace(SEVERITY_TAG, '').replace(/[*_`>#~]/g, '').replace(/\s+/g, ' ').trim().toLowerCase();
}

/** The path and the first line, so the same point raised again on a shifted line is still the same point. */
export function findingPrint(item: Pick<QueuedComment, 'body' | 'position'>): string {
  const position = (item.position ?? {}) as { new_path?: string; old_path?: string };
  return `${position.new_path ?? position.old_path ?? ''}|${plain(firstLine(item.body))}`;
}

/** Raised before on this MR, whatever became of it, or already said as the opening note of one of your open threads. */
export function isRepeat(item: QueuedComment, queue: QueuedComment[], threads: Discussion[], me: string): boolean {
  const print = findingPrint(item);
  const earlier = queue.some((c) => c.id !== item.id && mrKey(c) === mrKey(item) && c.kind !== 'verdict' && c.kind !== 'reply' && c.createdAt < item.createdAt && findingPrint(c) === print);
  if (earlier) return true;
  const said = plain(firstLine(item.body));
  return threads.some((t) => !t.resolved && t.notes[0]?.author === me && plain(firstLine(t.notes[0].body)) === said);
}
