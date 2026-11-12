import type { Discussion } from '../data/forge.js';
import type { AutoMemory, AutoPass, AutoTrigger, Mr } from '../types.js';
import { PASS_TIMEOUT_MS } from './config.js';
import { lastNote, mayAnswer, openedBy } from './guards.js';

export function passActive(pass: AutoPass | undefined, now: number): boolean {
  if (!pass || pass.settled || pass.doneAt) return false;
  return now - Date.parse(pass.launchedAt) < PASS_TIMEOUT_MS;
}

export function passExpired(pass: AutoPass, now: number): boolean {
  return !pass.settled && !pass.doneAt && now - Date.parse(pass.launchedAt) >= PASS_TIMEOUT_MS;
}

export function cheapTrigger(mr: Mr, memory: AutoMemory | undefined): AutoTrigger | null {
  if (!memory?.pass) return 'new';
  return mr.sha !== memory.pass.sha ? 'commit' : null;
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
