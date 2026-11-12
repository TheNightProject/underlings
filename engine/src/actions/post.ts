import { randomUUID } from 'node:crypto';
import { renderCommentBody, type SendHow } from '../comment.js';
import { forgeOf, needs } from '../data/forge.js';
import { changeUnsent, claimToSend, heldClaim, loadQueue, loadSettings, recordVerdict, updateQueueItem, type Claim } from '../data/store.js';
import { footersOf } from '../settings.js';
import { mrKey, type QueuedComment } from '../types.js';

export interface PostOutcome {
  id: string;
  ok: boolean;
  error?: string;
}

async function sendReply(comment: QueuedComment, how: SendHow): Promise<{ id?: string }> {
  if (!comment.replyTo) throw new Error('a reply with no thread to go on');
  await forgeOf(comment).reply(comment, comment.replyTo, renderCommentBody(comment, how));
  return {};
}

/** GitLab reports a hold it applied as "Reviewer not found" too, so a warning is not a failure. */
async function sendVerdict(comment: QueuedComment): Promise<{ id?: string }> {
  const forge = forgeOf(comment);
  if (comment.verdict === 'approve') {
    await forge.approve(comment, true);
  } else if (comment.verdict === 'changes') {
    needs(forge, 'hold', 'hold a merge');
    await forge.hold(comment, true);
  } else {
    throw new Error('a verdict with no decision in it');
  }
  recordVerdict(mrKey(comment), comment.verdict === 'approve' ? 'approved' : 'changes');
  return {};
}

/** A reply you approved saying fixed closes its thread; full auto resolves only what the code shows fixed, after its own send. */
async function resolveFixed(comment: QueuedComment, how: SendHow): Promise<void> {
  if (how.automatic || comment.kind !== 'reply' || comment.outcome !== 'fixed' || !comment.replyTo) return;
  await forgeOf(comment).resolve(comment, comment.replyTo, true).catch(() => undefined);
}

function send(comment: QueuedComment, how: SendHow): Promise<{ id?: string }> {
  if (comment.kind === 'reply') return sendReply(comment, how);
  if (comment.kind === 'verdict') return sendVerdict(comment);
  return forgeOf(comment).postFinding(comment, how);
}

function claimFor(comment: QueuedComment, how: SendHow): Claim {
  if (!how.claimedBy) return claimToSend(comment.id, `manual:${randomUUID()}`, Date.now());
  const item = heldClaim(comment.id, how.claimedBy);
  return item ? { item } : { refused: 'its send claim was handed back' };
}

/** Sent from the queue as it is on disk, under a claim, so a rewrite lands and a second sender is told 'already being sent'. */
export async function postOne(comment: QueuedComment, how: SendHow = {}): Promise<PostOutcome> {
  if (comment.status === 'posted' || comment.discussionId) {
    return { id: comment.id, ok: false, error: 'already posted' };
  }
  const claim = claimFor(comment, how);
  if ('refused' in claim) return { id: comment.id, ok: false, error: claim.refused };
  const item = claim.item;
  try {
    const sent = await send(item, { ...how, footers: how.footers ?? footersOf(loadSettings()) });
    await resolveFixed(item, how);
    updateQueueItem(item.id, {
      status: 'posted',
      postedAt: new Date().toISOString(),
      ...(sent.id ? { discussionId: sent.id } : {}),
      ...(how.automatic && item.auto ? { auto: { ...item.auto, sentAuto: true } } : {}),
      error: undefined,
      sending: undefined,
    });
    return { id: item.id, ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    updateQueueItem(item.id, { error: message, sending: undefined });
    return { id: item.id, ok: false, error: message };
  }
}

/** Verdicts are left out: posting everything should never approve as a side effect. */
export async function postAllFor(projectPath: string, iid: number): Promise<PostOutcome[]> {
  const queue = loadQueue().filter(
    (c) =>
      c.status === 'pending' && c.projectPath === projectPath && c.iid === iid && c.kind !== 'verdict',
  );
  const results: PostOutcome[] = [];
  for (const comment of queue) {
    results.push(await postOne(comment));
  }
  return results;
}

/** Refused while a send holds it, as that send goes out whatever the queue says after. */
export function discard(id: string): boolean {
  return changeUnsent(id, { status: 'discarded' });
}

/** Rewriting a queued finding before it goes anywhere. Posted ones are GitLab's now, and one being sent goes as it was claimed. */
export function editQueued(id: string, body: string): boolean {
  return changeUnsent(id, { body });
}
