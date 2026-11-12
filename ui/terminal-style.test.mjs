import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openPage } from './testkit.mjs';

const page = await openPage();
const w = page.window;
const GRAPH = 'acme/order-book!898';
const plain = (value) => JSON.parse(JSON.stringify(value));
const known = (over = {}) => w.terminalKnowing({ mrs: [GRAPH], tickets: ['ABC-1'], ...over });
const at = (first, texts) => texts.map((text, i) => ({ line: first + i, text, wrapped: false }));
const SCREEN = [
  '⏺ Here is where the open work stands:',
  '  │ ABC-2871 │ order-book! │',
  '  │          │ 898         │',
  '  ├──────────┼─────────────┤',
  '  │ ABC-2900 │ UTF-8       │',
  '────────────────────',
  '> fix ABC-2933 next',
];
const noInput = new Set();
const plan = (args) => w.terminalStylePlan({ entries: [], seen: new Map(), input: noInput, known: known(), ...args });
const added = (p) => plain(p.add).map((r) => [r.key, r.pieces.map((x) => x.line)]);
const asEntries = (refs) => refs.map((r) => ({ lines: r.pieces.map((x) => x.line), gone: false, key: r.key }));

test('the first pass decorates every reference found, at its line in the buffer, and leaves plain text and the input rows alone', () => {
  const rows = at(40, SCREEN);
  const first = plan({ rows, input: new Set([46]) });
  assert.deepEqual(added(first), [['ABC-2871', [41]], [GRAPH, [41, 42]], ['ABC-2900', [44]]]);
  assert.deepEqual(plain(first.drop), []);
  assert.equal(first.seen.has(46), false, 'an input row is never recorded as seen, so it is read again once it stops being input');
});

test('a pass over rows that have not changed reads nothing and changes nothing', () => {
  const rows = at(40, SCREEN);
  const first = plan({ rows });
  const again = plan({ rows, seen: first.seen, entries: asEntries(first.add) });
  assert.deepEqual([plain(again.scanned), plain(again.drop), added(again)], [[], [], []]);
});

test('a changed row is read again with its neighbours only: its decoration goes, the rest stay', () => {
  const rows = at(40, SCREEN);
  const first = plan({ rows });
  const entries = asEntries(first.add);
  const changed = at(40, SCREEN.map((t, i) => (i === 4 ? '  │ ABC-2933 │ UTF-8       │' : t)));
  const next = plan({ rows: changed, seen: first.seen, entries });
  assert.deepEqual([...next.scanned].sort(), [43, 44, 45]);
  assert.deepEqual(plain(next.drop).map((e) => e.key), ['ABC-2900']);
  assert.deepEqual(added(next), [['ABC-2933', [44]]]);
});

test('a reference wrapped over two rows goes when either row changes, and comes back whole', () => {
  const rows = at(40, SCREEN);
  const first = plan({ rows });
  const changed = at(40, SCREEN.map((t, i) => (i === 2 ? '  │          │ 899         │' : t)));
  const next = plan({ rows: changed, seen: first.seen, entries: asEntries(first.add) });
  assert.deepEqual(plain(next.drop).map((e) => e.key).sort(), ['ABC-2871', GRAPH].sort(), 'the key beside it is on a neighbouring row, so it is read again too');
  assert.deepEqual(added(next), [['ABC-2871', [41]], ['acme/order-book!899', [41, 42]]]);
});

test('a decoration whose line left the buffer is dropped, and so is one on a row that became input', () => {
  const rows = at(40, SCREEN);
  const first = plan({ rows });
  const entries = asEntries(first.add);
  entries[0].gone = true;
  const next = plan({ rows, seen: first.seen, entries, input: new Set([44]) });
  assert.deepEqual(plain(next.drop).map((e) => e.key), ['ABC-2871', 'ABC-2900']);
  assert.deepEqual(added(next), []);
});

test('a reset, after a resize, a reflow, a theme change or a change in what the page knows, drops and redraws everything', () => {
  const rows = at(40, SCREEN);
  const first = plan({ rows });
  const next = plan({ rows, seen: first.seen, entries: asEntries(first.add), reset: true });
  assert.equal(next.drop.length, first.add.length);
  assert.deepEqual(added(next), added(first));
});

test('after the scrollback trims its oldest lines, rows that only moved up are still known and not read again', () => {
  const first = plan({ rows: at(40, SCREEN) });
  const moved = at(37, SCREEN);
  assert.deepEqual(plain(plan({ rows: moved, seen: w.terminalShifted(first.seen, 3) }).scanned), []);
  assert.equal(plan({ rows: moved, seen: first.seen }).scanned.length, SCREEN.length, 'without the shift every row looks new');
  assert.deepEqual(plain([...w.terminalShifted(new Map([[1, 'a'], [5, 'b']]), 3)]), [[2, 'b']], 'a line trimmed away is forgotten');
});

test('the input is the lowest prompt line down to the rule under it, with the cursor\'s line, in either prompt style', () => {
  const lines = (texts, cursor) => [...w.terminalInputLines(at(0, texts), cursor)].sort((a, b) => a - b);
  assert.deepEqual(lines(['> asked before', 'answer ABC-1', '─────', '> fix ABC-2900', '  and ABC-2933', '─────', '  ? for shortcuts'], 6), [3, 4, 6]);
  assert.deepEqual(lines(['╭─────╮', '│ > fix ABC-2900 │', '╰─────╯'], 2), [1, 2]);
  assert.deepEqual(lines(['ABC-1 is done', 'no prompt here'], 1), [1]);
  assert.deepEqual(lines(['quoted > text ABC-1'], 0), [0], 'a > inside a line is not a prompt');
});

test('what the page knows is marked by its MRs, projects and which agents wait, so a change there redraws', () => {
  const agent = (waiting) => ({ handle: 'h', ticket: 'ABC-2900', waiting });
  const mark = (k) => w.terminalKnownMark(k);
  assert.equal(mark(known({ agents: [agent(false)] })), mark(known({ agents: [agent(false)] })));
  assert.notEqual(mark(known({ agents: [agent(false)] })), mark(known({ agents: [agent(true)] })));
  assert.notEqual(mark(known()), mark(known({ mrs: [GRAPH, 'acme/x!1'] })));
});
