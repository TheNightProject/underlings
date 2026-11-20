import type { Discussion } from '../data/forge.js';
import { dropped, mrKey, type AutoMemory, type AutoPass, type AutoTrigger, type Mr, type QueuedComment } from '../types.js';
import { PASS_TIMEOUT_MS } from './config.js';
import { lastNote, mayAnswer, openedBy } from './guards.js';
import { keyOf, passIdOf } from './ledger.js';

export function passActive(pass: AutoPass | undefined, now: number): boolean {
  if (!pass || pass.settled || pass.doneAt) return false;
  return now - Date.parse(pass.launchedAt) < PASS_TIMEOUT_MS;
}

export function passExpired(pass: AutoPass, now: number): boolean {
  return !pass.settled && !pass.doneAt && now - Date.parse(pass.launchedAt) >= PASS_TIMEOUT_MS;
}

/** The newest head anyone read, a pass or you by hand, and when. */
export function lastLook(memory: AutoMemory | undefined): { sha: string | null; at: string } | null {
  const pass = memory?.pass ? { sha: memory.pass.sha, at: memory.pass.launchedAt } : null;
  const yours = memory?.yours ?? null;
  if (!pass || !yours) return pass ?? yours;
  return yours.at > pass.at ? yours : pass;
}

export function cheapTrigger(mr: Mr, memory: AutoMemory | undefined): AutoTrigger | null {
  const look = lastLook(memory);
  if (!look) return 'new';
  return mr.sha !== look.sha ? 'commit' : null;
}

/** Your own findings on this head, waiting or posted: a pass now would only say them again. */
export function reviewedByHand(mr: Mr, queue: QueuedComment[]): boolean {
  const key = mrKey(mr);
  return mr.sha !== null && queue.some((c) => keyOf(c) === key && !passIdOf(c) && !dropped(c) && c.position?.head_sha === mr.sha);
}

export function hasNewReply(
  threads: Discussion[],
  me: string,
  since: string,
  handedBack: string[],
): boolean {
  return threads.some((thread) => {
    const last = lastNote(thread);
    if (!last || thread.resolved || !openedBy(thread, me)) return false;
    if (handedBack.includes(thread.id) || last.author === me) return false;
    return mayAnswer(last, me) && last.createdAt > since;
  });
}
