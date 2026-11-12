import { isHeld, type ThreadEntry } from './data/forge.js';
import { mrKey, type Mr, type QueuedComment, type Watch } from './types.js';

export type ReviewPhase =
  | 'none'
  | 'running'
  | 'stalled'
  | 'ready'
  | 'awaiting'
  | 'moved'
  | 'open'
  | 'posted';

export interface AgentState {
  /** The agent terminal is alive. */
  alive: boolean;
  /** Mid-turn: said by its host, or read off an Orca terminal's spinning title glyph. */
  working: boolean;
  lastOutputAt?: number;
  /** Where the review is running, so a browser tab can open beside it. */
  worktreePath?: string;
}

export interface ReviewBadge {
  phase: ReviewPhase;
  glyph: string;
  /** Emoji occupy two terminal cells whatever their code-unit length. */
  width: number;
  colour: string;
  label: string;
  count: number;
}

const BADGES: Record<ReviewPhase, Omit<ReviewBadge, 'count' | 'phase'>> = {
  none: { glyph: '  ', width: 2, colour: 'gray', label: '' },
  // All four sit above U+FFFF and carry no variation selector. A BMP emoji measures as
  // one cell and a surrogate pair as two, so mixing the two shifts whole rows sideways.
  running: { glyph: '🔄', width: 2, colour: 'yellow', label: 'review running' },
  stalled: { glyph: '🚫', width: 2, colour: 'red', label: 'review ended with nothing' },
  ready: { glyph: '📝', width: 2, colour: 'yellow', label: 'waiting for you to post' },
  posted: { glyph: '📤', width: 2, colour: 'green', label: 'comments posted' },
  awaiting: { glyph: '💬', width: 2, colour: 'magenta', label: 'someone replied to you' },
  moved: { glyph: '🔨', width: 2, colour: '#ffa733', label: 'the code changed under you' },
  open: { glyph: '👀', width: 2, colour: 'cyan', label: 'your threads still open' },
};

/** Where an MR sits in your review, from the queue and the agent host; a finished agent that queued nothing is a review that died. */
export interface ThreadSummary {
  mine: number;
  unresolved: number;
  awaitingYou: number;
  /** Threads of yours nobody answered that the author has since pushed over. */
  moved?: number;
  threads?: ThreadEntry[];
}

export function reviewPhase(
  key: string,
  queue: QueuedComment[],
  watch: Watch | undefined,
  agents: Map<string, AgentState>,
  threads?: ThreadSummary,
): { phase: ReviewPhase; count: number } {
  const mine = queue.filter((c) => mrKey(c) === key);
  const pending = mine.filter((c) => c.status === 'pending');
  const posted = mine.filter((c) => c.status === 'posted');

  if (pending.length > 0) return { phase: 'ready', count: pending.length };

  // Somebody answered a thread of yours: that needs your words, not an agent's.
  if (threads && threads.awaitingYou > 0) {
    return { phase: 'awaiting', count: threads.awaitingYou };
  }

  // Nobody answered, but the code under the comment has been rewritten. Most comments
  // are dealt with that way rather than by a reply, and it is still yours to check.
  if (threads && (threads.moved ?? 0) > 0) {
    return { phase: 'moved', count: threads.moved ?? 0 };
  }

  const agent = watch?.terminal ? agents.get(watch.terminal) : undefined;
  if (agent?.alive && agent.working) return { phase: 'running', count: 0 };

  // Threads you opened that nobody has answered yet: the ball is with the author.
  if (threads && threads.unresolved > 0) return { phase: 'open', count: threads.unresolved };

  if (threads && threads.mine > 0) return { phase: 'posted', count: threads.mine };
  if (posted.length > 0) return { phase: 'posted', count: posted.length };

  // Launched, the agent is done or gone, and nothing ever reached the queue.
  if (watch?.reviewedAt && watch.terminal && !agent?.working) {
    return { phase: 'stalled', count: 0 };
  }
  if (agent?.alive) return { phase: 'running', count: 0 };
  return { phase: 'none', count: 0 };
}

export function reviewBadge(phase: ReviewPhase, count: number): ReviewBadge {
  return { ...BADGES[phase], phase, count };
}

/** Pad by display width, since an emoji's code-unit length does not predict its cells. */
export function padBadge(badge: ReviewBadge, width: number): { text: string; pad: number } {
  const count = badge.count > 0 ? ` ${badge.count}` : '';
  const used = badge.width + count.length;
  return { text: `${badge.glyph}${count}`, pad: Math.max(width - used, 0) };
}

export const REVIEW_LEGEND: ReviewBadge[] = (
  ['running', 'ready', 'awaiting', 'moved', 'open', 'posted', 'stalled'] as ReviewPhase[]
).map((p) => reviewBadge(p, 0));

export interface Verdict {
  label: string;
  colour: string;
}

/** A hold goes on by itself while a review runs and GitLab reports it per MR, so it counts only beside a decision you made. */
export function reviewVerdict(mr: Mr, me?: string, recorded?: 'approved' | 'changes'): Verdict | null {
  if (me && mr.approvedBy.includes(me)) return { label: 'YOU APPROVED', colour: 'green' };
  // Only a decision you made. A hold is placed automatically while a review runs, so
  // reading one back would label every merge request under review as blocked on purpose.
  if (recorded === 'changes' && isHeld(mr)) {
    return { label: 'YOU REQUESTED CHANGES', colour: '#ffa733' };
  }
  return null;
}
