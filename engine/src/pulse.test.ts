import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ReviewPhase } from './review.js';
import {
  AWAITS_YOU,
  MOOD_LABELS,
  REVIEWED_BY_YOU,
  moodFor,
  moodForRow,
  railColour,
  railFor,
  rowWash,
  type Mood,
} from './pulse.js';

const ACTIVE: Mood[] = ['awaitingYou', 'reviewing', 'approved', 'reviewed', 'unreviewed'];

function channels(hex: string): number[] {
  return [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
}

function luma(hex: string): number {
  const [r, g, b] = channels(hex);
  return (0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0)) / 255;
}

test('every mood has a real rail colour and a real wash', () => {
  for (const mood of ACTIVE) {
    assert.match(railColour(mood), /^#[0-9a-f]{6}$/, `${mood} rail`);
    assert.match(rowWash(mood) ?? '', /^#[0-9a-f]{6}$/, `${mood} wash`);
  }
});

test('nothing moves: the same mood always draws the same thing', () => {
  for (const mood of [...ACTIVE, 'quiet' as Mood]) {
    assert.deepEqual(railFor(mood), railFor(mood));
    assert.equal(railColour(mood), railColour(mood));
    assert.equal(rowWash(mood), rowWash(mood));
  }
});

test('mood precedence runs from what you owe down to what nobody owes', () => {
  const none = {
    awaitingYou: false,
    moved: false,
    reviewing: false,
    approvedByYou: false,
    reviewedByYou: false,
    unreviewed: false,
  };
  assert.equal(
    moodFor({ ...none, awaitingYou: true, moved: true, reviewing: true, approvedByYou: true, reviewedByYou: true, unreviewed: true }),
    'awaitingYou',
    'the list is your inbox before it is a status board',
  );
  assert.equal(moodFor({ ...none, reviewing: true, approvedByYou: true, reviewedByYou: true }), 'reviewing');
  assert.equal(
    moodFor({ ...none, approvedByYou: true, reviewedByYou: true }),
    'approved',
    'your comments outlive the approval, so signing off has to win or it reads as unfinished',
  );
  assert.equal(moodFor({ ...none, reviewedByYou: true, unreviewed: true }), 'reviewed');
  assert.equal(moodFor({ ...none, unreviewed: true }), 'unreviewed');
  assert.equal(moodFor(none), 'quiet');
});

test('a red pipeline is the author\'s problem and never colours the row', () => {
  // It stays in the pipeline column. Nothing in a mood can be driven by it, which this
  // test holds by the shape of MoodInput itself.
  assert.deepEqual(Object.keys(MOOD_LABELS).sort(), [
    'approved',
    'awaitingYou',
    'moved',
    'reviewed',
    'reviewing',
    'unreviewed',
  ]);
});

test('red means you, green means done: the three states you act on', () => {
  const dominant = (hex: string, i: number): boolean => {
    const ch = channels(hex);
    return ch.every((v, n) => n === i || (ch[i] ?? 0) > v);
  };
  assert.ok(dominant(railColour('awaitingYou'), 0), 'waiting on you must read as red');
  assert.ok(dominant(railColour('reviewed'), 1), 'reviewed must read as green');
  assert.ok(dominant(railColour('approved'), 1), 'approved is green too');
});

test('the two greens are told apart by shade, because nothing moves to separate them', () => {
  assert.notEqual(railColour('reviewed'), railColour('approved'));
  assert.notEqual(rowWash('reviewed'), rowWash('approved'));
  assert.ok(
    luma(railColour('approved')) < luma(railColour('reviewed')),
    'signed off sits deeper than still open',
  );
});

test('a quiet row has no wash and a blank one-cell rail', () => {
  assert.equal(rowWash('quiet'), undefined);
  const rail = railFor('quiet');
  assert.equal(rail.glyph, ' ');
  assert.equal(rail.glyph.length, 1);
});

test('every rail glyph is one cell, or the columns after it shift', () => {
  for (const mood of [...ACTIVE, 'quiet' as Mood]) {
    const g = railFor(mood).glyph;
    assert.equal(g.length, 1, `${mood} drew ${JSON.stringify(g)}`);
    assert.ok((g.codePointAt(0) ?? 0) <= 0xffff, 'no astral glyph in a one-cell column');
  }
});

test('every wash stays dark enough to read the row on top of it', () => {
  for (const mood of ACTIVE) {
    const hex = rowWash(mood);
    assert.ok(hex, `${mood} always has a wash`);
    assert.ok(luma(hex) < 0.18, `${mood} wash ${hex} is too bright to sit text on`);
  }
});

test('the nudge is neutral and the alarms are saturated, which is what reads as quieter', () => {
  // Luminance is the wrong measure here: a neutral grey is calmer than a saturated red
  // even when it is brighter. Saturation is what makes a colour shout.
  const chroma = (hex: string): number => {
    const ch = channels(hex);
    return Math.max(...ch) - Math.min(...ch);
  };
  assert.equal(chroma(railColour('unreviewed')), 0, 'the nudge must be a true grey');
  assert.ok(chroma(railColour('awaitingYou')) > 100, 'red must be unmistakably red');
  assert.ok(chroma(railColour('reviewing')) > 60, 'amber must be unmistakably amber');
  const grey = luma(railColour('unreviewed'));
  assert.ok(grey < 0.6, `grey sits at ${grey.toFixed(3)}, too bright for a nudge`);
  assert.ok(grey > 0.15, `grey sits at ${grey.toFixed(3)}, too dark to see`);
});

test('the phase sets split cleanly: a phase is never both yours and theirs', () => {
  for (const phase of AWAITS_YOU) {
    assert.ok(!REVIEWED_BY_YOU.has(phase), `${phase} cannot be both`);
  }
  assert.ok(AWAITS_YOU.has('ready'), 'findings queued is yours to post');
  assert.ok(AWAITS_YOU.has('awaiting'), 'someone replied, so it is your turn');
  assert.ok(REVIEWED_BY_YOU.has('posted'), 'comments are up, the author owes the move');
  assert.ok(REVIEWED_BY_YOU.has('open'), 'and threads of yours are still open');
  assert.ok(!AWAITS_YOU.has('none') && !REVIEWED_BY_YOU.has('none'));
  assert.ok(!AWAITS_YOU.has('running') && !REVIEWED_BY_YOU.has('running'));
});

test('a push over your comment puts the row back on you', () => {
  // A push is the other way most comments get answered.
  assert.ok(AWAITS_YOU.has('moved'), 'the code changing under you is your move');
  assert.ok(!REVIEWED_BY_YOU.has('moved'), 'and not theirs');
});

test('code moved is its own bucket, so it can be filtered to on its own', () => {
  // It is still your move, but it is a different move from answering a reply, and
  // lumping it into waiting on me meant it could not be picked out of a long list.
  const row = (phase: ReviewPhase): Parameters<typeof moodForRow>[0] => ({
    flags: { youApproved: false, unreviewed: false },
    review: { phase },
  });
  assert.equal(moodForRow(row('moved')), 'moved');
  assert.equal(moodForRow(row('awaiting')), 'awaitingYou', 'a reply is still waiting on me');
  assert.equal(moodForRow(row('ready')), 'awaitingYou', 'so are findings to post');
});

test('answering a reply comes before looking at a rewrite', () => {
  const none = {
    awaitingYou: false, moved: false, reviewing: false,
    approvedByYou: false, reviewedByYou: false, unreviewed: false,
  };
  assert.equal(moodFor({ ...none, awaitingYou: true, moved: true }), 'awaitingYou');
  assert.equal(moodFor({ ...none, moved: true, reviewedByYou: true }), 'moved', 'and before "I reviewed"');
});

test('the moved colours are told apart from the rest, not just from each other', () => {
  const all = (['awaitingYou', 'moved', 'reviewing', 'approved', 'reviewed', 'unreviewed'] as const)
    .map((m) => railColour(m));
  assert.equal(new Set(all).size, all.length, 'every rail colour is distinct');
  assert.notEqual(rowWash('moved'), rowWash('awaitingYou'));
});
