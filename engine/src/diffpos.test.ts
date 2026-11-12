import assert from 'node:assert/strict';
import { test } from 'node:test';
import { anchor, parseHunks } from './diffpos.js';
import type { DiffPosition } from './types.js';

const SHAS = { base_sha: 'b', start_sha: 's', head_sha: 'h' };
const at = (line: number, path = 'a.yaml'): DiffPosition => ({ ...SHAS, new_path: path, new_line: line });

// The shape that broke in production: three unchanged lines, a block of deletions, then
// three more. The reported lines were the unchanged ones, which exist on both sides and
// so need both numbers.
const DIFF = [
  '@@ -21,54 +21,6 @@ dependencies:',
  ' - core',
  ' - interactive',
  ' - dashboard',
  '-- thing-01',
  '-- thing-02',
  '-- thing-03',
  '-- thing-04',
  '-- thing-05',
  '-- thing-06',
  '-- thing-07',
  '-- thing-08',
  '-- thing-09',
  '-- thing-10',
  '-- thing-11',
  '-- thing-12',
  '-- thing-13',
  '-- thing-14',
  '-- thing-15',
  '-- thing-16',
  '-- thing-17',
  '-- thing-18',
  '-- thing-19',
  '-- thing-20',
  '-- thing-21',
  '-- thing-22',
  '-- thing-23',
  '-- thing-24',
  '-- thing-25',
  '-- thing-26',
  '-- thing-27',
  '-- thing-28',
  '-- thing-29',
  '-- thing-30',
  '-- thing-31',
  '-- thing-32',
  '-- thing-33',
  '-- thing-34',
  '-- thing-35',
  '-- thing-36',
  '-- thing-37',
  '-- thing-38',
  '-- thing-39',
  '-- thing-40',
  '-- thing-41',
  '-- thing-42',
  '-- thing-43',
  '-- thing-44',
  '-- thing-45',
  '-- thing-46',
  '-- thing-47',
  '-- thing-48',
  ' auto_install: true',
  ' visibility: public',
  ' environments:',
].join('\n');

test('each side of the diff gets the line numbers that belong to it', () => {
  const { newLines, oldLines, paired } = parseHunks(DIFF);
  assert.equal(oldLines.size, 54, 'the whole left-hand span');
  assert.equal(newLines.size, 6, 'and the six that survive on the right');
  assert.equal(paired.get(21), 21, 'the unchanged lines pair across');
  assert.equal(paired.get(24), 72, 'and keep pairing after the deletions');
});

test('an added line anchors to the new side alone', () => {
  const added = ['@@ -1,1 +1,2 @@', ' kept', '+brand new'].join('\n');
  const got = anchor(at(2), added);
  assert.equal(got?.new_line, 2);
  assert.equal(got?.old_line, undefined, 'an addition has no old line');
  assert.equal(got?.old_path, 'a.yaml', 'but GitLab still wants both paths');
});

test('a deleted line anchors to the old side, where it is the only one that exists', () => {
  const got = anchor(at(40), DIFF);
  assert.equal(got?.old_line, 40);
  assert.equal(got?.new_line, undefined, 'a removal has no new line');
});

test('an unchanged line carries both sides, because GitLab wants both', () => {
  const got = anchor(at(22), DIFF);
  assert.equal(got?.new_line, 22);
  assert.equal(got?.old_line, 22);
});

test('the real failure: an unchanged line sent with only its new number', () => {
  // order-book !691 queued new_line 21 and 23 with no old_path and no old_line, and
  // GitLab answered "line code can't be blank" for both.
  for (const line of [21, 23]) {
    const got = anchor(at(line), DIFF);
    assert.equal(got?.new_line, line);
    assert.equal(got?.old_line, line, `${line} needs its old number too`);
    assert.equal(got?.old_path, 'a.yaml', 'and the old path');
  }
});

test('a line in neither side gives up rather than posting something GitLab refuses', () => {
  assert.equal(anchor(at(500), DIFF), null);
  assert.equal(anchor(at(1), DIFF), null, 'before the hunk');
});

test('the shas are carried through untouched', () => {
  const got = anchor(at(22), DIFF);
  assert.equal(got?.base_sha, 'b');
  assert.equal(got?.start_sha, 's');
  assert.equal(got?.head_sha, 'h');
});

test('a position already naming the old side is honoured, not second-guessed', () => {
  const old: DiffPosition = { ...SHAS, old_path: 'a.yaml', old_line: 22 };
  const got = anchor(old, DIFF);
  assert.equal(got?.old_line, 22);
  assert.equal(got?.new_line, undefined, 'it was told which side was meant');
});

test('several hunks each count from their own header', () => {
  const two = [
    '@@ -1,2 +1,2 @@', ' one', '-two', '+TWO',
    '@@ -40,2 +40,2 @@', ' forty', '-forty-one', '+FORTY-ONE',
  ].join('\n');
  const { newLines, oldLines } = parseHunks(two);
  assert.ok(newLines.has(2) && newLines.has(41), 'both hunks contribute');
  assert.ok(oldLines.has(2) && oldLines.has(41));
  assert.ok(!newLines.has(20), 'and nothing between them');
});

test('a no-newline marker advances neither side', () => {
  const d = ['@@ -1,1 +1,1 @@', '-old', '\\ No newline at end of file', '+new'].join('\n');
  const { newLines, oldLines } = parseHunks(d);
  assert.deepEqual([...oldLines], [1]);
  assert.deepEqual([...newLines], [1]);
});

test('rubbish in gives nothing out rather than throwing', () => {
  assert.deepEqual(parseHunks('').newLines.size, 0);
  assert.equal(anchor(at(5), 'not a diff'), null);
  assert.equal(anchor({ ...SHAS }, DIFF), null, 'no path and no line');
});
