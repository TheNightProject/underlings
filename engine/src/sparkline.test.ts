import assert from 'node:assert/strict';
import { test } from 'node:test';
import { dailyCounts, sparkline } from './sparkline.js';

test('a sparkline is one cell per value, scaled to its own peak', () => {
  const line = sparkline([0, 1, 2, 3, 4, 5, 6, 7]);
  assert.equal(line.length, 8);
  assert.equal(line[0], '▁', 'the floor');
  assert.equal(line[7], '█', 'the peak');
});

test('a quiet day is the lowest block, not a space', () => {
  // A blank would read as missing data rather than a day where nothing happened.
  assert.equal(sparkline([0, 0, 0]), '▁▁▁');
  assert.ok(!sparkline([0, 5, 0]).includes(' '));
});

test('every block is one cell wide, or the three lines will not align', () => {
  for (const line of [sparkline([1, 9, 3]), sparkline([0]), sparkline([7, 7, 7])]) {
    for (const ch of line) {
      assert.equal((ch.codePointAt(0) ?? 0) <= 0xffff, true, `${ch} must be a BMP block`);
    }
  }
});

test('a shared peak lets two lines be compared against each other', () => {
  // Scaled separately, a series peaking at 3 and one peaking at 300 look identical.
  assert.equal(sparkline([3], 3), '█');
  assert.equal(sparkline([3], 300), '▁', 'against a bigger peak it is nearly nothing');
});

test('an empty series draws nothing rather than throwing', () => {
  assert.equal(sparkline([]), '');
  assert.deepEqual(dailyCounts([], 7), [0, 0, 0, 0, 0, 0, 0]);
});

test('counts land on the right day, oldest first', () => {
  // Days are local, so the times here are middays: 23:00Z on the 12th is already the
  // 13th in British Summer Time, which is the right answer but a confusing fixture.
  const now = new Date('2026-10-14T12:00:00Z').getTime();
  const counts = dailyCounts(
    ['2026-10-14T09:00:00Z', '2026-10-14T10:00:00Z', '2026-10-12T12:00:00Z'],
    7,
    now,
  );
  assert.equal(counts.length, 7);
  assert.equal(counts[6], 2, 'today is last');
  assert.equal(counts[4], 1, 'two days ago');
  assert.equal(counts.reduce((a, b) => a + b, 0), 3);
});

test('a day is a local day, so an evening in BST is not yesterday', () => {
  const now = new Date('2026-07-14T12:00:00Z').getTime();
  const counts = dailyCounts(['2026-07-13T23:30:00Z'], 3, now);
  assert.equal(counts[2], 1, '23:30Z on the 13th is just after midnight on the 14th');
});

test('anything outside the window is dropped, not folded into the ends', () => {
  // Folding would put a spike on the first bar that never happened.
  const now = new Date('2026-10-14T12:00:00Z').getTime();
  const counts = dailyCounts(['2026-01-01T00:00:00Z', '2027-01-01T00:00:00Z'], 7, now);
  assert.deepEqual(counts, [0, 0, 0, 0, 0, 0, 0]);
});

test('an unparseable date is ignored rather than counted as now', () => {
  const now = new Date('2026-10-14T12:00:00Z').getTime();
  assert.deepEqual(dailyCounts(['not a date'], 3, now), [0, 0, 0]);
});
