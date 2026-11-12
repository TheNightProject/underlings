import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  DEFAULT_WEIGHTS,
  formatWeights,
  looksAutomated,
  parseWeights,
  tally,
  type CommentEvent,
  type Contribution,
} from './leaderboard.js';

const opened: Contribution[] = [
  { mr: 'p1!1', author: 'ivan', approvers: ['sybil'] },
  { mr: 'p1!2', author: 'ivan', approvers: [] },
  { mr: 'p1!3', author: 'sybil', approvers: ['ivan', 'xena'] },
];

const comments: CommentEvent[] = [
  { user: 'sybil', mr: 'p1!1', author: 'ivan' },
  { user: 'sybil', mr: 'p1!1', author: 'ivan' },
  { user: 'sybil', mr: 'p1!2', author: 'ivan' },
  { user: 'xena', mr: 'p1!1', author: 'ivan' },
];

test('opened counts merge requests authored, whatever became of them', () => {
  const board = tally(opened, []);
  assert.equal(board.find((s) => s.user === 'ivan')?.opened, 2);
  assert.equal(board.find((s) => s.user === 'sybil')?.opened, 1);
});

test('reviewing counts merge requests touched, not comments left', () => {
  // Otherwise one person leaving ten small notes outranks one who says the useful thing.
  const sybil = tally(opened, comments).find((s) => s.user === 'sybil');
  assert.equal(sybil?.reviewed, 2, 'two distinct MRs');
  assert.equal(sybil?.comments, 3, 'and the raw count is still there');
});

test('commenting on a merge request and then approving it is one review, not two', () => {
  // Counting comments plus approvals scored the same piece of work twice, which put
  // people who approve what they have just reviewed above people who only reviewed.
  const both: Contribution[] = [{ mr: 'p1!7', author: 'ivan', approvers: ['sybil'] }];
  const alsoCommented = [{ user: 'sybil', mr: 'p1!7', author: 'ivan' }];
  const sybil = tally(both, alsoCommented).find((s) => s.user === 'sybil');
  assert.equal(sybil?.reviewed, 1, 'one merge request, one review');
  assert.equal(sybil?.approved, 1, 'the approval is still reported');
  assert.equal(sybil?.comments, 1, 'and so is the comment');
});

test('an approval on its own still counts as a review', () => {
  const only: Contribution[] = [{ mr: 'p1!8', author: 'ivan', approvers: ['xena'] }];
  assert.equal(tally(only, []).find((s) => s.user === 'xena')?.reviewed, 1);
});

test('the same MR number in two repos is two merge requests', () => {
  const cross: CommentEvent[] = [
    { user: 'sybil', mr: 'p1!1', author: 'ivan' },
    { user: 'sybil', mr: 'p2!1', author: 'ivan' },
  ];
  assert.equal(tally([], cross).find((s) => s.user === 'sybil')?.reviewed, 2);
});

test('commenting on your own merge request is not reviewing', () => {
  const own: CommentEvent[] = [{ user: 'ivan', mr: 'p1!9', author: 'ivan' }];
  assert.deepEqual(tally([], own), [], 'and it does not put you on the board');
});

test('approving your own merge request does not score', () => {
  const selfie: Contribution[] = [{ mr: 'p1!4', author: 'ivan', approvers: ['ivan', 'sybil'] }];
  const board = tally(selfie, []);
  assert.equal(board.find((s) => s.user === 'ivan')?.approved, 0);
  assert.equal(board.find((s) => s.user === 'sybil')?.approved, 1);
});

test('approving twice on one merge request counts once', () => {
  const twice: Contribution[] = [{ mr: 'p1!5', author: 'ivan', approvers: ['sybil', 'sybil'] }];
  assert.equal(tally(twice, []).find((s) => s.user === 'sybil')?.approved, 1);
});

test('the board ranks by total work: what you raised plus what you reviewed', () => {
  // Raising a merge request and reviewing somebody else's are both a merge request's
  // worth of effort, so both earn the same point.
  const board = tally(opened, comments);
  // Under the default weights: raised and reviewed 3 each, a comment a half, approval 1.
  assert.deepEqual(
    board.map((s) => [s.user, s.total]),
    [
      ['sybil', 12],
      ['ivan', 10],
      ['xena', 8],
    ],
  );
});

test('any column can be the ranking, because no weighting suits everyone', () => {
  const byReviewed = tally(opened, comments, { sortBy: 'reviewed' });
  assert.equal(byReviewed[0]?.user, 'sybil', 'sybil reviewed the most');
  const byOpened = tally(opened, comments, { sortBy: 'opened' });
  assert.equal(byOpened[0]?.user, 'ivan', 'ivan raised the most');
  const byComments = tally(opened, comments, { sortBy: 'comments' });
  assert.equal(byComments[0]?.user, 'sybil');
});

test('a tie falls through the other columns rather than landing arbitrarily', () => {
  const flat = { opened: 1, reviewed: 1, comments: 0, approved: 0 };
  const board = tally(opened, comments, { weights: flat });
  const tied = board.filter((s) => s.total === 3);
  assert.equal(tied.length, 2, 'ivan and sybil both total three');
  assert.ok(
    (tied[0]?.opened ?? 0) > (tied[1]?.opened ?? 0),
    'opened breaks the tie, not the order they happened to arrive in',
  );
});

test('service accounts are left out, and the guess is a narrow one', () => {
  assert.equal(looksAutomated('propagate-bot'), true);
  assert.equal(looksAutomated('jenkins-ws'), true);
  assert.equal(looksAutomated('renovate'), true);
  assert.equal(looksAutomated('ci-runner'), true);
  assert.equal(looksAutomated('xena'), false);
  assert.equal(looksAutomated('abbot'), false, 'a name that merely contains "bot" is a person');
  assert.equal(looksAutomated('nicola'), false);
});

test('bots can be shown on request, because the guess might be wrong', () => {
  const botwork: Contribution[] = [{ mr: 'p1!6', author: 'propagate-bot', approvers: [] }];
  assert.deepEqual(tally(botwork, []), []);
  assert.equal(tally(botwork, [], { includeAutomated: true })[0]?.user, 'propagate-bot');
});

test('somebody with nothing in the window is not listed at all', () => {
  const quiet: Contribution[] = [{ mr: 'p1!9', author: 'ivan', approvers: [] }];
  assert.deepEqual(tally(quiet, []).map((s) => s.user), ['ivan']);
});

test('raising and reviewing are worth the same, and a comment far less', () => {
  assert.equal(DEFAULT_WEIGHTS.opened, DEFAULT_WEIGHTS.reviewed, 'both take real attention');
  assert.ok(DEFAULT_WEIGHTS.comments < DEFAULT_WEIGHTS.reviewed, 'depth is a bonus, not the point');
  assert.ok(DEFAULT_WEIGHTS.approved < DEFAULT_WEIGHTS.reviewed, 'an approval can be one click');
});

test('the total is the four counts under their weights', () => {
  const chatty = Array.from({ length: 4 }, () => ({ user: 'sybil', mr: 'p1!1', author: 'ivan' }));
  const sybil = tally([{ mr: 'p1!1', author: 'ivan', approvers: ['sybil'] }], chatty, {
    weights: { opened: 3, reviewed: 3, comments: 0.5, approved: 1 },
  }).find((s) => s.user === 'sybil');
  // One reviewed, one approval, four comments, nothing raised.
  assert.equal(sybil?.total, 3 + 1 + 2);
});

test('weights are read from one line, and nonsense falls back rather than scoring zero', () => {
  assert.deepEqual(parseWeights('5/2/1/2'), { opened: 5, reviewed: 2, comments: 1, approved: 2 });
  assert.deepEqual(parseWeights('3 / 3 / 0.5 / 1'), DEFAULT_WEIGHTS, 'spaces are fine');
  assert.deepEqual(parseWeights(''), DEFAULT_WEIGHTS, 'an empty line keeps the defaults');
  assert.deepEqual(parseWeights('//1/'), { ...DEFAULT_WEIGHTS, comments: 1 }, 'blanks are skipped');
  assert.deepEqual(parseWeights('4'), { ...DEFAULT_WEIGHTS, opened: 4 }, 'a partial line sets what it names');
  assert.deepEqual(parseWeights('x/y/z/w'), DEFAULT_WEIGHTS, 'words are not weights');
  assert.deepEqual(
    parseWeights('-5/3/0.5/1'),
    DEFAULT_WEIGHTS,
    'a negative would let one kind of work cancel another',
  );
  assert.deepEqual(parseWeights('0/0/0/0'), { opened: 0, reviewed: 0, comments: 0, approved: 0 });
});

test('weights survive a round trip through the settings line', () => {
  assert.equal(formatWeights(DEFAULT_WEIGHTS), '3/3/0.5/1');
  assert.deepEqual(parseWeights(formatWeights(DEFAULT_WEIGHTS)), DEFAULT_WEIGHTS);
});

test('no weighting rescues a careful reviewer from somebody raising in bulk', () => {
  // Worth a test because it is the honest limit of the whole board: these are absolute
  // counts, so volume wins whatever the dials say.
  const bulk = Array.from({ length: 100 }, (_, i) => ({
    mr: `p1!${i}`,
    author: 'volume',
    approvers: [] as string[],
  }));
  const careful = [{ mr: 'p2!1', author: 'volume', approvers: ['deep'] }];
  const deepComments = Array.from({ length: 40 }, () => ({
    user: 'deep',
    mr: 'p2!1',
    author: 'volume',
  }));
  for (const weights of [
    { opened: 5, reviewed: 2, comments: 1, approved: 2 },
    DEFAULT_WEIGHTS,
    { opened: 1, reviewed: 5, comments: 1, approved: 1 },
  ]) {
    const board = tally([...bulk, ...careful], deepComments, { weights });
    assert.equal(board[0]?.user, 'volume', `volume still won at ${formatWeights(weights)}`);
  }
});
