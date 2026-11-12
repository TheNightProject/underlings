import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { AgentState } from './review.js';
import {
  moveTargets,
  TICKET_LEGEND,
  statusChoices,
  ticketBadge,
  ticketKey,
  ticketMood,
  ticketPhase,
} from './tickets.js';
import type { Mr, ReviewRun, Ticket } from './types.js';

const TICKET: Ticket = {
  key: 'ABC-1234',
  summary: 'Write the member_of edge at sign-in',
  status: 'In Progress',
  labels: [],
  url: 'https://example.atlassian.net/browse/ABC-1234',
};

function mr(extra: Partial<Mr> = {}): Mr {
  return { ticket: 'ABC-1234', draft: false, approvedBy: [], iid: 9, ...extra } as Mr;
}

function run(extra: Partial<ReviewRun> = {}): ReviewRun {
  return { key: ticketKey('ABC-1234'), webUrl: '', startedAt: '', ...extra };
}

const agents = (state?: Partial<AgentState>): Map<string, AgentState> =>
  state ? new Map([['term1', { alive: true, working: false, ...state }]]) : new Map();

test('nothing started reads as nothing started', () => {
  assert.equal(ticketPhase(TICKET, [], agents(), undefined).phase, 'none');
});

test('a run with no output yet is starting, not dead', () => {
  assert.equal(ticketPhase(TICKET, [], agents(), run({ tail: [] })).phase, 'starting');
});

test('a run whose agent has gone, having said something and raised nothing, is stalled', () => {
  const r = run({ terminal: 'term1', tail: ['I had a look', 'and stopped'] });
  assert.equal(ticketPhase(TICKET, [], agents(), r).phase, 'stalled');
});

test('a live agent is working or waiting on you, and the two are different', () => {
  const r = run({ terminal: 'term1' });
  assert.equal(ticketPhase(TICKET, [], agents({ working: true }), r).phase, 'working');
  assert.equal(ticketPhase(TICKET, [], agents({ working: false }), r).phase, 'idle');
});

test('an MR outranks the agent, because it is the furthest the work has got', () => {
  // The agent is still sitting there after raising it; the MR is the real news.
  const r = run({ terminal: 'term1' });
  const busy = agents({ working: true });
  assert.equal(ticketPhase(TICKET, [mr({ draft: true })], busy, r).phase, 'draft');
  assert.equal(ticketPhase(TICKET, [mr({ draft: false })], busy, r).phase, 'open');
});

test('your own approval is what makes it approved, not anyone\'s', () => {
  const theirs = [mr({ approvedBy: ['someone'] })];
  assert.equal(ticketPhase(TICKET, theirs, agents(), undefined, 'you').phase, 'open');
  const yours = [mr({ approvedBy: ['someone', 'you'] })];
  assert.equal(ticketPhase(TICKET, yours, agents(), undefined, 'you').phase, 'approved');
});

test('an MR for a different ticket is not this ticket\'s MR', () => {
  const other = [mr({ ticket: 'ABC-9999' }), mr({ ticket: null })];
  assert.equal(ticketPhase(TICKET, other, agents(), undefined).phase, 'none');
});

test('every badge is two cells, or the columns after it shift', () => {
  for (const badge of TICKET_LEGEND) {
    assert.equal(badge.width, 2);
    assert.ok(
      (badge.glyph.codePointAt(0) ?? 0) > 0xffff,
      `${badge.glyph} is not astral, so it measures as one cell`,
    );
    assert.ok(!badge.glyph.includes('️'), 'a variation selector measures inconsistently');
  }
  assert.equal(ticketBadge('none').glyph.length, 2, 'the empty badge still holds its column');
});

test('a ticket borrows the MR list\'s colours, so one glance reads the same in both', () => {
  assert.equal(ticketMood('idle'), 'awaitingYou', 'the agent stopped and is waiting');
  assert.equal(ticketMood('stalled'), 'awaitingYou');
  assert.equal(ticketMood('working'), 'reviewing');
  assert.equal(ticketMood('approved'), 'approved', 'done is done');
});

test('a ticket journal key cannot collide with a merge request one', () => {
  assert.equal(ticketKey('ABC-1234'), 'ticket:ABC-1234');
  assert.ok(!ticketKey('ABC-1234').includes('!'), 'MR keys are repo!iid');
});

test('status choices come from the board, busiest first, without the one it is in', () => {
  const board = [
    { ...TICKET, status: 'In Progress' },
    { ...TICKET, status: 'To Do' },
    { ...TICKET, status: 'To Do' },
    { ...TICKET, status: 'Peer Review' },
    { ...TICKET, status: 'To Do' },
  ];
  assert.deepEqual(statusChoices(board, 'In Progress'), ['To Do', 'Peer Review']);
  assert.ok(
    !statusChoices(board, 'To Do').includes('To Do'),
    'moving a ticket to where it already is is not a move',
  );
});

test('a board of one status offers nothing, rather than offering a no-op', () => {
  assert.deepEqual(statusChoices([{ ...TICKET, status: 'To Do' }], 'To Do'), []);
  assert.deepEqual(statusChoices([], 'To Do'), []);
});

test('with no statuses named, a ticket can move to each status seen on your tickets but its own, whatever its project', () => {
  assert.deepEqual(moveTargets('Open', ['Open', 'Doing', 'Unknown', 'Shipped', 'Doing']), ['Doing', 'Shipped']);
  assert.deepEqual(moveTargets('Open', ['Open']), []);
});

test('the transitions acli says for a ticket are its targets, in place of every guess', () => {
  assert.deepEqual(moveTargets('Open', ['Open', 'Doing', 'Shipped'], ['Review', 'Open']), ['Review']);
});
