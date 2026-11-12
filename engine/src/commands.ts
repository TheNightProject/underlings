import type { LaunchOutcome } from './actions/launch.js';
import { postAllFor } from './actions/post.js';
import { isWatched } from './actions/watch.js';
import { agentOnNow } from './auto/driver.js';
import { startAutoReview, toggleAutoPause } from './auto/live.js';
import { ANYONE, formatPeople, peopleRules } from './auto/people.js';
import { withLevel } from './auto/roster.js';
import { currentUser, RELEASE_NOTE_BARE, RELEASE_NOTE_WITH_COMMENTS, reviewPrompt } from './config.js';
import { forgeOf, heldByMe, isHeld, needs } from './data/forge.js';
import { changeSettings, clearVerdict, forgetReviewHold, loadQueue, loadSettings, loadState, noteReviewHold, recordVerdict } from './data/store.js';
import type { TerminalList } from './inbox.js';
import { refNumber } from './refs.js';
import { holdNoteOf, type Settings } from './settings.js';
import { mrKey, type AutoLevel, type Mr } from './types.js';

// Each re-reads the MR and settings, as the caller's copy may be a poll old.

async function current(mr: Mr): Promise<Mr> {
  const fresh = await forgeOf(mr).one(mr);
  return fresh ? { ...fresh, repoLabel: mr.repoLabel } : mr;
}

async function liftHold(mr: Mr, note: string): Promise<boolean> {
  const forge = forgeOf(mr);
  const lifted = await forge.hold(mr, false).catch(() => null);
  if (!lifted) return false;
  await forge.note(mr, note).catch(() => undefined);
  return true;
}

export interface ReviewStarted {
  alreadyWatched: boolean;
  holdWarning?: string;
  note?: string;
}

type Launch = (mr: Mr, prompt: string) => Promise<LaunchOutcome | void>;

/** A second agent would hold the MR again and queue every finding twice; read from disk now, so a launch still in flight elsewhere counts. */
export function reviewRefusal(mr: Mr, listed: TerminalList | null): string | null {
  if (!agentOnNow(listed?.terminals ?? [], listed?.listedAt)(mr)) return null;
  return `an agent is already reading ${refNumber(mr)}, f focuses it`;
}

/** `r`. The hold goes on only once an agent is really reading it, or a failed launch blocks a merge for nothing. */
export async function startReview(mr: Mr, launch: Launch = startAutoReview, { hold = true } = {}): Promise<ReviewStarted> {
  const alreadyWatched = isWatched(mrKey(mr));
  const outcome = await launch(await current(mr), reviewPrompt(mr.webUrl));
  const launched: ReviewStarted = outcome?.note ? { alreadyWatched, note: outcome.note } : { alreadyWatched };
  const forge = forgeOf(mr);
  if (!hold || !forge.caps.hold) return launched;
  const fresh = await current(mr);
  if (!loadSettings().holdWhileReviewing || isHeld(fresh)) return launched;
  const held = await forge.hold(mr, true).catch(() => null);
  if (held) {
    noteReviewHold(mrKey(mr), fresh.sha);
    await forge.note(mr, holdNoteOf(loadSettings())).catch(() => undefined);
  }
  return held?.warning ? { ...launched, holdWarning: held.warning } : launched;
}

/** `v`. Approving ends your review, so a hold you placed comes off with it. */
export async function setApproved(mr: Mr, approving: boolean): Promise<{ liftedHold: boolean }> {
  const forge = forgeOf(mr);
  if (!approving) needs(forge, 'withdrawApproval', 'take an approval back');
  const live = await current(mr);
  const held = isHeld(live);
  await forge.approve(mr, approving);
  if (approving) recordVerdict(mrKey(mr), 'approved', live.sha);
  else clearVerdict(mrKey(mr));
  if (!approving || !held) return { liftedHold: false };
  forgetReviewHold(mrKey(mr));
  return { liftedHold: await liftHold(mr, RELEASE_NOTE_BARE) };
}

/** `h`. Never a bare change request: the author needs the reason. A hold you place yourself is your verdict, so the last post never lifts it. */
export async function setHeld(mr: Mr, held: boolean): Promise<{ warning?: string }> {
  const forge = forgeOf(mr);
  needs(forge, 'hold', 'hold a merge');
  const posted = loadQueue().some((c) => c.status === 'posted' && mrKey(c) === mrKey(mr));
  const result = await forge.hold(mr, held);
  if (held) recordVerdict(mrKey(mr), 'changes', mr.sha);
  forgetReviewHold(mrKey(mr));
  const note = held ? holdNoteOf(loadSettings()) : posted ? RELEASE_NOTE_WITH_COMMENTS : RELEASE_NOTE_BARE;
  await forge.note(mr, note).catch(() => undefined);
  return result.warning ? { warning: result.warning } : {};
}

/** `P`. The comments being up is what the hold was waiting for, so it comes off once all of them are. */
export async function postAll(mr: Mr): Promise<{ posted: number; total: number; liftedHold: boolean }> {
  const results = await postAllFor(mr.projectPath, mr.iid);
  const posted = results.filter((r) => r.ok).length;
  const done = { posted, total: results.length, liftedHold: false };
  if (posted === 0 || posted < results.length || !isHeld(await current(mr))) return done;
  forgetReviewHold(mrKey(mr));
  return { ...done, liftedHold: await liftHold(mr, RELEASE_NOTE_WITH_COMMENTS) };
}

/** After a single post or discard: once nothing is left to post, the hold your review placed comes off, as Post all does. */
export async function liftReviewHoldIfDone(mr: Mr, me: string | undefined = currentUser()): Promise<{ liftedHold: boolean }> {
  const key = mrKey(mr);
  if (!loadState().reviewHolds?.[key]) return { liftedHold: false };
  const items = loadQueue().filter((c) => mrKey(c) === key);
  if (items.some((c) => c.status === 'pending')) return { liftedHold: false };
  const live = await current(mr);
  if (!(me ? heldByMe(live, me) : isHeld(live))) {
    forgetReviewHold(key);
    return { liftedHold: false };
  }
  const posted = items.some((c) => c.status === 'posted' && c.kind !== 'verdict');
  const lifted = await liftHold(mr, posted ? RELEASE_NOTE_WITH_COMMENTS : RELEASE_NOTE_BARE);
  if (lifted) forgetReviewHold(key);
  return { liftedHold: lifted };
}

/** The people picker. Changed on what is on disk, so a change made in the other front end meanwhile is kept. Null follows the default row, 'off' means never. */
export function setPersonLevel(username: string, level: AutoLevel | 'off' | null): Settings {
  return changeSettings((settings) => {
    const rules = peopleRules(settings.fullAuto);
    const optedOut = new Set([...rules.optedOut].filter((name) => name !== username));
    if (username === ANYONE) {
      const onRequest = level && level !== 'off' ? 'shadow' : null;
      return { ...settings, fullAuto: formatPeople(rules.people, { onRequest, optedOut }) };
    }
    if (level === 'off') optedOut.add(username);
    const people = withLevel(rules.people, username, level === 'off' ? null : level);
    return { ...settings, fullAuto: formatPeople(people, { onRequest: rules.onRequest, optedOut }) };
  });
}

/** `!`, from whatever is on disk rather than a copy that may predate the last flip. */
export function toggleFullAutoPause(now = Date.now()): Settings {
  return toggleAutoPause(now);
}
