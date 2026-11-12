import type { Discussion, NotePosition } from './data/forge.js';
import { dropped, type Mr, type QueuedComment } from './types.js';

const SEVERITY_IN_BODY = /^\**(CRITICAL|MAJOR|MINOR|NIT|QUESTION)\**[:\s]/i;

/**
 * A thread you opened by hand, shaped like a queued finding so the panel can show both in
 * one list. The `thread:` id marks it as having no queue entry behind it.
 */
export function threadAsComment(discussion: Discussion, mr: Mr): QueuedComment {
  const first = discussion.notes[0];
  const match = SEVERITY_IN_BODY.exec(first?.body ?? '');
  return {
    id: `thread:${discussion.id}`,
    projectPath: mr.projectPath,
    projectId: mr.projectId,
    iid: mr.iid,
    webUrl: mr.webUrl,
    severity: (match?.[1]?.toUpperCase() as QueuedComment['severity']) ?? 'QUESTION',
    body: first?.body ?? '',
    createdAt: first?.createdAt ?? '',
    createdBy: first?.author ?? '',
    status: 'posted',
    discussionId: discussion.id,
  };
}

/** A panel row with no queue entry behind it: posting or discarding it means nothing. */
export function isQueued(comment: QueuedComment | undefined): comment is QueuedComment {
  return comment !== undefined && !comment.id.startsWith('thread:');
}

/** True when the last word on the thread is not yours. */
export function awaitsYou(discussion: Discussion | undefined, me?: string): boolean {
  if (!discussion || discussion.resolved || discussion.notes.length < 2) return false;
  return discussion.notes[discussion.notes.length - 1]?.author !== me;
}

/**
 * What the panel lists for one MR: the findings this tool queued, plus every other thread
 * of yours on the MR. A reply usually lands on a thread you opened by hand, so a
 * queue-only panel shows "someone replied to you" in the header and then nothing to read.
 */
export function panelItems(
  queue: QueuedComment[],
  discussions: Discussion[],
  mr: Mr,
  me?: string,
): QueuedComment[] {
  // A sent reply or verdict lives on GitLab's own thread now, not as a row of its own.
  const queued = queue.filter(
    (c) =>
      !dropped(c) &&
      !(c.status === 'posted' && (c.kind === 'reply' || c.kind === 'verdict')) &&
      c.projectPath === mr.projectPath &&
      c.iid === mr.iid,
  );
  const claimed = new Set(queued.map((c) => c.discussionId).filter(Boolean));
  const unclaimed = discussions
    .filter((d) => !claimed.has(d.id) && me !== undefined && d.notes.some((n) => n.author === me))
    .map((d) => threadAsComment(d, mr));

  const byId = new Map(discussions.map((d) => [d.id, d]));
  // Anything waiting on you floats, because the panel is this MR's inbox.
  const rank = (c: QueuedComment): number =>
    awaitsYou(c.discussionId ? byId.get(c.discussionId) : undefined, me) ? 0 : 1;
  return [...queued, ...unclaimed].sort((a, b) => rank(a) - rank(b));
}

/** The head moved past the one the comment was written on; worth knowing apart from resolution, as authors often fix code and leave the thread. */
export function outdated(position: NotePosition | undefined, head: string | null): boolean {
  if (!position?.head_sha || !head) return false;
  return position.head_sha !== head;
}
