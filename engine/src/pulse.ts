import type { ReviewPhase } from './review.js';

/**
 * The phases where the next move is yours: findings queued but not posted, or someone
 * has replied on one of your threads.
 */
export const AWAITS_YOU: ReadonlySet<ReviewPhase> = new Set<ReviewPhase>(['ready', 'awaiting', 'moved']);

/** And the phases where you have had your say and the author owes the next move. */
export const REVIEWED_BY_YOU: ReadonlySet<ReviewPhase> = new Set<ReviewPhase>(['posted', 'open']);

/**
 * What a row is doing, in the order it matters. Nothing on screen moves, so the colour
 * is the whole signal and every mood has to be told apart by hue alone.
 */
export type Mood =
  | 'awaitingYou'
  | 'moved'
  | 'reviewing'
  | 'approved'
  | 'reviewed'
  | 'unreviewed'
  | 'quiet';

const RAIL_COLOURS: Record<Exclude<Mood, 'quiet'>, string> = {
  awaitingYou: '#ff5f5f',
  // Also yours to act on, so it sits beside red rather than with the greens, but it is
  // somebody else having done something rather than somebody waiting on you.
  moved: '#d78bff',
  reviewing: '#ffa733',
  // Two greens, and no motion to separate them: approved sits deeper than reviewed.
  approved: '#2ea043',
  reviewed: '#56d364',
  // Neutral and mid: an unreviewed MR is a nudge, not an alarm.
  unreviewed: '#707070',
};

/**
 * Row washes are deliberately near-black: the whole line carries them, so anything
 * brighter wins the eye away from the text it is supposed to be drawing you to.
 */
const WASH_COLOURS: Record<Exclude<Mood, 'quiet'>, string> = {
  awaitingYou: '#3a0000',
  moved: '#24103a',
  // Amber and green carry far more luma than red at the same nominal brightness, so
  // they sit lower to stay under the same ceiling.
  reviewing: '#241800',
  approved: '#04210f',
  reviewed: '#062a15',
  unreviewed: '#1e1e1e',
};

export interface MoodInput {
  /** The ball is with you: findings to post, or a reply on one of your threads. */
  awaitingYou: boolean;
  /** The author rewrote the code under a comment of yours and said nothing. */
  moved: boolean;
  reviewing: boolean;
  approvedByYou: boolean;
  /** Your comments are up and the ball is with the author. */
  reviewedByYou: boolean;
  /** Nobody asked, nobody approved: it is waiting for a first pair of eyes. */
  unreviewed: boolean;
}

/** Moods follow only where the review has got to; approved outranks reviewed, or an MR you signed off would still read as unfinished. */
export function moodFor(input: MoodInput): Mood {
  if (input.awaitingYou) return 'awaitingYou';
  // Behind a reply, which wants words, but ahead of everything that is not your move.
  if (input.moved) return 'moved';
  if (input.reviewing) return 'reviewing';
  if (input.approvedByYou) return 'approved';
  if (input.reviewedByYou) return 'reviewed';
  if (input.unreviewed) return 'unreviewed';
  return 'quiet';
}

/** The one place a row becomes a mood, so the list and the sidebar can never disagree. */
export function moodForRow(row: {
  flags: { youApproved: boolean; unreviewed: boolean };
  review: { phase: ReviewPhase };
}): Mood {
  return moodFor({
    awaitingYou: AWAITS_YOU.has(row.review.phase) && row.review.phase !== 'moved',
    moved: row.review.phase === 'moved',
    reviewing: row.review.phase === 'running',
    approvedByYou: row.flags.youApproved,
    reviewedByYou: REVIEWED_BY_YOU.has(row.review.phase),
    unreviewed: row.flags.unreviewed,
  });
}

export function railColour(mood: Mood): string {
  return mood === 'quiet' ? 'gray' : (RAIL_COLOURS[mood] as string);
}

/** The row's own tint, or nothing when it is quiet. */
export function rowWash(mood: Mood): string | undefined {
  return mood === 'quiet' ? undefined : WASH_COLOURS[mood];
}

export interface Rail {
  glyph: string;
  colour: string;
}

/** The left edge of a row: a solid bar in the mood's colour, blank when it is quiet. */
export function railFor(mood: Mood): Rail {
  if (mood === 'quiet') return { glyph: ' ', colour: 'gray' };
  return { glyph: '▌', colour: railColour(mood) };
}

export const MOOD_LABELS: Record<Exclude<Mood, 'quiet'>, string> = {
  awaitingYou: 'waiting on you',
  moved: 'the code changed under you',
  reviewing: 'review in flight',
  approved: 'you approved it',
  reviewed: 'you reviewed, waiting on them',
  unreviewed: 'nobody reviewing yet',
};
