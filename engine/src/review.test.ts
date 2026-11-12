import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  padBadge,
  REVIEW_LEGEND,
  reviewBadge,
  reviewPhase,
  reviewVerdict,
  type AgentState,
} from './review.js';
import type { Mr, QueuedComment, Watch } from './types.js';

const KEY = 'acme/engine!621';

function comment(over: Partial<QueuedComment> = {}): QueuedComment {
  return {
    id: Math.random().toString(36).slice(2),
    projectPath: 'acme/engine',
    projectId: 1001,
    iid: 621,
    webUrl: 'https://gitlab.com/x',
    severity: 'MINOR',
    body: 'something',
    createdAt: '2026-10-12T10:00:00Z',
    createdBy: 'ws:mr-review',
    status: 'pending',
    ...over,
  };
}

function watch(over: Partial<Watch> = {}): Watch {
  return {
    key: KEY,
    projectPath: 'acme/engine',
    iid: 621,
    webUrl: 'https://gitlab.com/x',
    auto: false,
    seen: { sha: 'a', pipeline: 'SUCCESS', notes: 0, approvals: 0 },
    addedAt: '2026-10-12T10:00:00Z',
    ...over,
  };
}

const working: AgentState = { alive: true, working: true };
const idle: AgentState = { alive: true, working: false };

test('an untouched MR shows nothing', () => {
  assert.equal(reviewPhase(KEY, [], undefined, new Map()).phase, 'none');
});

test('a working agent reads as running', () => {
  const w = watch({ reviewedAt: '2026-10-12T10:00:00Z', terminal: 't1' });
  const agents = new Map([['t1', working]]);
  assert.equal(reviewPhase(KEY, [], w, agents).phase, 'running');
});

test('queued findings outrank a still-running agent, since they are already actionable', () => {
  const w = watch({ reviewedAt: '2026-10-12T10:00:00Z', terminal: 't1' });
  const agents = new Map([['t1', working]]);
  const r = reviewPhase(KEY, [comment(), comment()], w, agents);
  assert.equal(r.phase, 'ready');
  assert.equal(r.count, 2);
});

test('posting them all moves it to posted with the posted count', () => {
  const w = watch({ reviewedAt: '2026-10-12T10:00:00Z', terminal: 't1' });
  const r = reviewPhase(
    KEY,
    [comment({ status: 'posted' }), comment({ status: 'posted' })],
    w,
    new Map([['t1', idle]]),
  );
  assert.equal(r.phase, 'posted');
  assert.equal(r.count, 2);
});

test('an agent that finished having queued nothing is a stalled review, not an untouched one', () => {
  const w = watch({ reviewedAt: '2026-10-12T10:00:00Z', terminal: 't1' });
  assert.equal(reviewPhase(KEY, [], w, new Map([['t1', idle]])).phase, 'stalled');
  // Terminal gone entirely is the same story.
  assert.equal(reviewPhase(KEY, [], w, new Map()).phase, 'stalled');
});

test('discarded findings do not count as waiting for you', () => {
  const w = watch({ reviewedAt: '2026-10-12T10:00:00Z', terminal: 't1' });
  const r = reviewPhase(KEY, [comment({ status: 'discarded' })], w, new Map([['t1', idle]]));
  assert.notEqual(r.phase, 'ready');
});

test('another MR\'s findings never leak into this one', () => {
  const other = comment({ iid: 999 });
  assert.equal(reviewPhase(KEY, [other], undefined, new Map()).phase, 'none');
});

test('every badge occupies the column exactly, whatever the emoji byte length', () => {
  for (const phase of ['none', 'running', 'stalled', 'ready', 'posted'] as const) {
    for (const count of [0, 3, 12]) {
      const badge = reviewBadge(phase, count);
      const { text, pad } = padBadge(badge, 5);
      const cells = badge.width + (count > 0 ? ` ${count}`.length : 0);
      assert.equal(cells + pad, 5, `${phase}/${count} does not fill the column`);
      assert.ok(text.length > 0);
    }
  }
});

test('the glyphs are two cells wide, which is what the column budgets for', () => {
  for (const phase of ['running', 'stalled', 'ready', 'posted'] as const) {
    assert.equal(reviewBadge(phase, 0).width, 2);
  }
});

test('every glyph is astral and carries no variation selector, or rows shift sideways', () => {
  for (const phase of ['running', 'stalled', 'ready', 'posted'] as const) {
    const g = reviewBadge(phase, 0).glyph;
    assert.equal(g.length, 2, `${phase}: a BMP emoji measures as one cell, not two`);
    assert.ok((g.codePointAt(0) ?? 0) > 0xffff, `${phase} must sit above U+FFFF`);
    assert.ok(!g.includes('\uFE0F'), `${phase} must not carry U+FE0F`);
  }
});

test('a reply to your thread outranks everything but findings you have not posted', () => {
  const t = { mine: 7, unresolved: 1, awaitingYou: 1 };
  const w = watch({ reviewedAt: '2026-10-12T10:00:00Z', terminal: 't1' });
  const r = reviewPhase(KEY, [], w, new Map([['t1', working]]), t);
  assert.equal(r.phase, 'awaiting', 'a reply needs your words, not a running agent');
  assert.equal(r.count, 1);
  // Unposted findings still come first: they are the thing only you can release.
  assert.equal(reviewPhase(KEY, [comment()], w, new Map(), t).phase, 'ready');
});

test('your own open threads read as open, with the ball in the author\'s court', () => {
  const t = { mine: 3, unresolved: 3, awaitingYou: 0 };
  const r = reviewPhase(KEY, [], undefined, new Map(), t);
  assert.equal(r.phase, 'open');
  assert.equal(r.count, 3);
});

test('threads all resolved reads as posted, not as untouched', () => {
  const t = { mine: 4, unresolved: 0, awaitingYou: 0 };
  const r = reviewPhase(KEY, [], undefined, new Map(), t);
  assert.equal(r.phase, 'posted');
  assert.equal(r.count, 4);
});

test('a review posted outside thematrix still shows, with no queue and no watch', () => {
  // The case that started this: /team:review posted straight to GitLab.
  const r = reviewPhase(KEY, [], undefined, new Map(), { mine: 3, unresolved: 3, awaitingYou: 0 });
  assert.notEqual(r.phase, 'none');
});

test('the panel says which way you went, not just that you reviewed', () => {
  const mr = (over: Partial<Mr>): Mr =>
    ({ approvedBy: [], mergeStatus: null, ...over }) as unknown as Mr;

  assert.equal(reviewVerdict(mr({ approvedBy: ['frank'] }), 'frank')?.label, 'YOU APPROVED');
  assert.equal(
    reviewVerdict(mr({ mergeStatus: 'REQUESTED_CHANGES' }), 'frank', 'changes')?.label,
    'YOU REQUESTED CHANGES',
  );
  assert.equal(reviewVerdict(mr({}), 'frank'), null, 'nothing decided yet says nothing');
});

test('the hold a review places on its own is not a decision', () => {
  // holdWhileReviewing puts one on every merge request an agent starts reading. Reading
  // that back as a verdict would mark everything under review as deliberately blocked.
  const underReview = { approvedBy: [], mergeStatus: 'REQUESTED_CHANGES' } as unknown as Mr;
  assert.equal(reviewVerdict(underReview, 'frank'), null, 'no decision recorded, so none shown');
  assert.equal(reviewVerdict(underReview, 'frank', 'changes')?.label, 'YOU REQUESTED CHANGES');
});

test('a recorded decision still has to match the merge request', () => {
  // The hold was lifted elsewhere, so the record is stale and must not be shown.
  const lifted = { approvedBy: [], mergeStatus: 'NOT_APPROVED' } as unknown as Mr;
  assert.equal(reviewVerdict(lifted, 'frank', 'changes'), null);
});

test('someone else approving is not you approving', () => {
  const mr = { approvedBy: ['yusuf'], mergeStatus: null } as unknown as Mr;
  assert.equal(reviewVerdict(mr, 'frank'), null);
  assert.equal(reviewVerdict(mr, 'yusuf')?.label, 'YOU APPROVED');
  assert.equal(reviewVerdict(mr, undefined), null, 'and with no name, nothing is claimed');
});

test('approving wins over a hold, because approving is what lifts it', () => {
  const both = { approvedBy: ['frank'], mergeStatus: 'REQUESTED_CHANGES' } as unknown as Mr;
  assert.equal(reviewVerdict(both, 'frank', 'changes')?.label, 'YOU APPROVED');
});

test('the two verdicts are told apart by their words, not only their colour', () => {
  const ok = reviewVerdict({ approvedBy: ['x'], mergeStatus: null } as unknown as Mr, 'x');
  const no = reviewVerdict(
    { approvedBy: [], mergeStatus: 'REQUESTED_CHANGES' } as unknown as Mr,
    'x',
    'changes',
  );
  assert.notEqual(ok?.colour, no?.colour);
  assert.notEqual(ok?.label, no?.label);
});

test('code changing under a comment is your move, not the author\'s', () => {
  // Most comments get dealt with by a push, not a reply. Treating that as "reviewed, ball
  // with them" leaves it sitting in the wrong bucket until somebody happens to look.
  const threads = { mine: 3, unresolved: 2, awaitingYou: 0, moved: 2 };
  assert.equal(reviewPhase(KEY, [], undefined, new Map(), threads).phase, 'moved');
  assert.equal(reviewPhase(KEY, [], undefined, new Map(), threads).count, 2);
});

test('a reply still outranks a push, because words need answering', () => {
  const both = { mine: 3, unresolved: 2, awaitingYou: 1, moved: 2 };
  assert.equal(reviewPhase(KEY, [], undefined, new Map(), both).phase, 'awaiting');
});

test('findings still to post outrank everything, including a push', () => {
  const threads = { mine: 1, unresolved: 1, awaitingYou: 0, moved: 1 };
  const queued = [comment({ status: 'pending' })];
  assert.equal(reviewPhase(KEY, queued, undefined, new Map(), threads).phase, 'ready');
});

test('a summary from before moved was counted does not change anything', () => {
  const old = { mine: 2, unresolved: 2, awaitingYou: 0 };
  assert.equal(reviewPhase(KEY, [], undefined, new Map(), old).phase, 'open');
});

test('every phase with a badge is in the legend, or the help window lies by omission', () => {
  const listed = new Set(REVIEW_LEGEND.map((b) => b.phase));
  for (const phase of ['running', 'ready', 'awaiting', 'moved', 'open', 'posted', 'stalled'] as const) {
    assert.ok(listed.has(phase), `${phase} has a badge but no legend entry`);
  }
});
