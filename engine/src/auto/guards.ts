import { AUTO_FOOTER } from '../config.js';
import type { Discussion } from '../data/forge.js';
import { looksAutomated as serviceAccount } from '../leaderboard.js';
import { dropped, type Mr, type QueuedComment } from '../types.js';
import { MAX_REPLIES_PER_THREAD } from './config.js';

type Note = Discussion['notes'][number];

export function ineligible(mr: Mr, me: string | undefined): string | null {
  if (!me) return 'who you are is not known yet';
  if (mr.draft) return 'it is a draft';
  if (!mr.reviewers.includes(me)) return 'you are not a requested reviewer';
  if (mr.approvedBy.includes(me)) return 'you have approved it';
  return null;
}

const AUTOMATED_MARKERS = [
  /\u{1F916}/u,
  /\bgenerated (by|with)\b/i,
  /\bauto-?generated\b/i,
  /\bposted automatically\b/i,
  /\bautomated (review|reply|comment)\b/i,
];

export function soundsAutomated(body: string): boolean {
  return body.includes(AUTO_FOOTER) || AUTOMATED_MARKERS.some((marker) => marker.test(body));
}

export function fromBot(note: Note): boolean {
  return note.bot === true || serviceAccount(note.author);
}

/** Your own word may be followed up; anyone else's automation never is, or two agents talk forever. */
export function mayAnswer(note: Note, me: string): boolean {
  if (note.author === me) return true;
  return !fromBot(note) && !soundsAutomated(note.body);
}

export function lastNote(thread: Discussion): Note | undefined {
  return thread.notes[thread.notes.length - 1];
}

export function openedBy(thread: Discussion, me: string): boolean {
  return thread.notes[0]?.author === me;
}

export function replyBlocker(thread: Discussion | undefined, me: string): string | null {
  if (!thread) return 'the thread has gone';
  if (!openedBy(thread, me)) return 'it is not a thread you opened';
  if (thread.resolved) return 'the thread is already resolved';
  const last = lastNote(thread);
  if (last && !mayAnswer(last, me)) return 'the last word on it is a bot or another automation';
  return null;
}

function counted(c: QueuedComment): boolean {
  return Boolean(c.auto) && !c.auto?.held && !dropped(c);
}

export function autoRepliesOn(queue: QueuedComment[], thread: string, except?: string): QueuedComment[] {
  return queue.filter(
    (c) => c.kind === 'reply' && c.replyTo === thread && c.id !== except && counted(c),
  );
}

export function threadCapReason(item: QueuedComment, queue: QueuedComment[]): string | null {
  const prior = autoRepliesOn(queue, item.replyTo ?? '', item.id);
  if (prior.length >= MAX_REPLIES_PER_THREAD) {
    return `${MAX_REPLIES_PER_THREAD} auto replies on that thread already, it is yours now`;
  }
  const disagreedBefore = prior.some((c) => c.outcome === 'disagree');
  if (item.outcome === 'disagree' && disagreedBefore) {
    return 'the author has disagreed twice, it is yours now';
  }
  return null;
}

export function passComments(queue: QueuedComment[], pass: string): number {
  return queue.filter((c) => c.auto?.pass === pass && c.kind !== 'verdict' && counted(c)).length;
}
