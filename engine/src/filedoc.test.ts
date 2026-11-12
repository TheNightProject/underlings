import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  buildDoc,
  changedLines,
  noteWidth,
  threadStarts,
  wrapText,
  type FileInput,
} from './filedoc.js';
import type { InlineThread } from './inline.js';

const DIFF = [
  '@@ -1,4 +1,4 @@',
  ' one',
  '-two',
  '+TWO',
  ' three',
  ' four',
].join('\n');

const FILE = ['one', 'TWO', 'three', 'four'].join('\n');

const thread = (line: number, notes = 1, resolved = false): InlineThread => ({
  id: `t${line}`,
  path: 'a.py',
  line,
  side: 'new',
  resolved,
  notes: Array.from({ length: notes }, (_, i) => ({
    author: `person${i}`,
    body: `comment ${i}`,
    createdAt: '',
  })),
});

const file = (over: Partial<FileInput> = {}): FileInput => ({
  path: 'a.py',
  text: FILE,
  diff: DIFF,
  threads: [],
  ...over,
});

test('the diff says which lines changed and what went', () => {
  const { added, removedAfter } = changedLines(DIFF);
  assert.deepEqual([...added], [2], 'TWO is the added line');
  assert.deepEqual(removedAfter.get(1), [{ text: 'two', oldLine: 2 }], 'under line 1, numbered 2');
});

test('the whole file is shown, not just the changed part', () => {
  const rows = buildDoc([file()]);
  const code = rows.filter((r) => r.kind === 'code' && r.change !== '-');
  assert.deepEqual(code.map((r) => r.text), ['one', 'TWO', 'three', 'four']);
  assert.equal(code.length, 4, 'every line of the file, context and all');
});

test('a changed line is marked, and an untouched one is not', () => {
  const rows = buildDoc([file()]);
  const byLine = new Map(rows.filter((r) => r.kind === 'code' && r.change !== '-').map((r) => [r.line, r.change]));
  assert.equal(byLine.get(2), '+', 'the addition');
  assert.equal(byLine.get(3), ' ', 'and the rest left alone');
});

test('a removed line is shown where it used to be', () => {
  const rows = buildDoc([file()]);
  const gone = rows.findIndex((r) => r.change === '-');
  const after = rows.findIndex((r) => r.line === 2 && r.change === '+');
  assert.ok(gone > 0 && gone < after, 'the removal sits just before what replaced it');
  assert.equal(rows[gone]?.text, 'two');
});

test('a comment sits under the line it is about', () => {
  const rows = buildDoc([file({ threads: [thread(3)] })]);
  const code = rows.findIndex((r) => r.kind === 'code' && r.line === 3 && r.change !== '-');
  const note = rows.findIndex((r) => r.kind === 'note');
  assert.ok(note === code + 2, 'author then body, immediately after the line');
  assert.equal(rows[code + 1]?.kind, 'author');
});

test('every note of a thread comes through, and a resolved one says so', () => {
  const rows = buildDoc([file({ threads: [thread(2, 3, true)] })]);
  assert.equal(rows.filter((r) => r.kind === 'note').length, 3, 'all three replies');
  assert.ok(rows.some((r) => r.kind === 'author' && r.text.includes('resolved')));
});

test('threads are numbered in document order so a key can jump between them', () => {
  const rows = buildDoc([file({ threads: [thread(4), thread(2)] })]);
  const starts = threadStarts(rows);
  assert.equal(starts.length, 2);
  assert.ok((starts[0] ?? 0) < (starts[1] ?? 0), 'in the order they appear, not as given');
  // The earlier start belongs to line 2, which is above line 4 in the file.
  assert.equal(rows[(starts[0] ?? 0) - 1]?.line, 2);
});

test('several files are one document, each with a heading', () => {
  const rows = buildDoc([file(), file({ path: 'b.py' })]);
  assert.deepEqual(rows.filter((r) => r.kind === 'file').map((r) => r.text), ['a.py', 'b.py']);
});

test('a file that could not be read falls back to its diff rather than vanishing', () => {
  const rows = buildDoc([file({ text: null, threads: [thread(2)] })]);
  assert.ok(rows.some((r) => r.kind === 'code'), 'the diff still renders');
  assert.ok(rows.some((r) => r.kind === 'note'), 'and the comment still lands');
});

test('an empty input gives an empty document rather than throwing', () => {
  assert.deepEqual(buildDoc([]), []);
  assert.deepEqual(threadStarts([]), []);
  assert.ok(buildDoc([file({ text: '', diff: '' })]).length > 0, 'a heading at least');
});

test('a run of removals keeps its own numbers rather than repeating one', () => {
  // They all hang under the same surviving line, but they were different lines.
  const diff = ['@@ -1,4 +1,1 @@', ' kept', '-gone one', '-gone two', '-gone three'].join('\n');
  const rows = buildDoc([file({ text: 'kept', diff, threads: [] })]);
  const removed = rows.filter((r) => r.change === '-');
  assert.deepEqual(removed.map((r) => r.text), ['gone one', 'gone two', 'gone three']);
  assert.deepEqual(removed.map((r) => r.line), [2, 3, 4], 'each with the number it had');
});

test('removals after the last surviving line are not dropped', () => {
  // They anchor to a line the loop has already passed, which is how they went missing.
  const diff = ['@@ -1,3 +1,1 @@', ' kept', '-gone one', '-gone two'].join('\n');
  const rows = buildDoc([file({ text: 'kept', diff, threads: [] })]);
  assert.deepEqual(rows.filter((r) => r.change === '-').map((r) => r.text), ['gone one', 'gone two']);
});

test('removals from the very top are not dropped either', () => {
  const diff = ['@@ -1,3 +1,1 @@', '-gone first', '-gone second', ' kept'].join('\n');
  const rows = buildDoc([file({ text: 'kept', diff, threads: [] })]);
  const removed = rows.filter((r) => r.change === '-');
  assert.deepEqual(removed.map((r) => r.text), ['gone first', 'gone second']);
  const kept = rows.findIndex((r) => r.text === 'kept' && r.change === ' ');
  assert.ok(rows.indexOf(removed[0]!) < kept, 'and they sit above what survived');
});

test('a queued comment reads as unsent, so it is never mistaken for one that is up', () => {
  const queued: InlineThread = { ...thread(3), pending: 'MAJOR' };
  const rows = buildDoc([file({ threads: [queued] })]);
  const author = rows.find((r) => r.kind === 'author');
  assert.ok(author?.text.includes('MAJOR, not posted yet'), author?.text);
  assert.equal(author?.pending, true);
  assert.ok(
    rows.filter((r) => r.kind === 'note').every((r) => r.pending),
    'the body is marked too, so it can be drawn differently',
  );
});

test('folding a file keeps its comments and drops the code between them', () => {
  const rows = buildDoc([file({ threads: [thread(3)] })], new Set(['a.py']));
  assert.deepEqual(
    rows.filter((r) => r.kind === 'code').map((r) => r.line),
    [3],
    'only the line the comment is on survives',
  );
  assert.equal(rows.filter((r) => r.kind === 'note').length, 1, 'the comment stays');
  assert.equal(rows.find((r) => r.kind === 'file')?.condensed, true);
});

test('folding never moves a comment to a different number', () => {
  // The cursor is an index into the threads, so if folding renumbered them, pressing z
  // would silently put you on somebody else's comment.
  const two: FileInput[] = [
    file({ path: 'a.py', threads: [thread(2), thread(4)] }),
    file({ path: 'b.py', text: 'x\ny', diff: '@@ -1,2 +1,2 @@\n x\n+y', threads: [] }),
  ];
  two[1]!.threads = [{ ...thread(2), path: 'b.py', id: 'b2' }];
  const numbering = (rows: ReturnType<typeof buildDoc>): [number, string][] =>
    rows.filter((r) => r.kind === 'author').map((r) => [r.thread!, r.text]);

  const open = numbering(buildDoc(two));
  assert.deepEqual(open.map(([n]) => n), [0, 1, 2]);
  for (const folded of [new Set(['a.py']), new Set(['b.py']), new Set(['a.py', 'b.py'])]) {
    assert.deepEqual(numbering(buildDoc(two, folded)), open, `folded ${[...folded]}`);
  }
});

test('a folded file with no text to show still folds, working off the diff', () => {
  const rows = buildDoc([file({ text: null, threads: [thread(2)] })], new Set(['a.py']));
  const code = rows.filter((r) => r.kind === 'code');
  assert.deepEqual(code.map((r) => r.text), ['two', 'TWO'], 'both sides of the changed line');
  assert.deepEqual(code.map((r) => r.line), [2, 2]);
  assert.equal(rows.filter((r) => r.kind === 'note').length, 1);
});

// Two lines added at the top and old line 6 removed, so new line 6 is old line 4.
const SHIFTED = ['@@ -1,8 +1,9 @@', '+a', '+b', ' l1', ' l2', ' l3', ' l4', ' l5', '-l6', ' l7', ' l8'].join('\n');
const SHIFTED_TEXT = ['a', 'b', 'l1', 'l2', 'l3', 'l4', 'l5', 'l7', 'l8'].join('\n');
const onRemoved = (line: number): InlineThread => ({ ...thread(line), id: `old${line}`, side: 'old' });
const sitsUnder = (rows: ReturnType<typeof buildDoc>): [number | undefined, string | undefined][] =>
  rows.flatMap((r, i) => (r.kind === 'author' ? [[r.thread, rows[i - 1]?.text]] : []));

test('a comment on a removed line sits under it, not under the new line with its number', () => {
  const rows = buildDoc([file({ text: SHIFTED_TEXT, diff: SHIFTED, threads: [onRemoved(6)] })]);
  const author = rows.findIndex((r) => r.kind === 'author');
  assert.deepEqual(rows[author - 1], { kind: 'code', text: 'l6', line: 6, change: '-' });
});

test('folded, a removed line keeps its comment, and every comment keeps its number', () => {
  const files = [file({ text: SHIFTED_TEXT, diff: SHIFTED, threads: [thread(1), onRemoved(6), thread(9)] })];
  const open = sitsUnder(buildDoc(files));
  assert.deepEqual(open, [[0, 'a'], [1, 'l6'], [2, 'l8']]);
  assert.deepEqual(sitsUnder(buildDoc(files, new Set(['a.py']))), open);
});

test('with no file to show, a comment on a removed line still sits under it, in a deleted file too', () => {
  const rows = buildDoc([file({ text: null, diff: SHIFTED, threads: [onRemoved(6)] })]);
  assert.deepEqual(sitsUnder(rows), [[0, 'l6']]);
  assert.equal(rows.find((r) => r.text === 'l6')?.line, 6, 'numbered on the side it was removed from');
  const deleted = buildDoc([file({ text: null, diff: '@@ -1,2 +0,0 @@\n-x\n-y', threads: [onRemoved(2)] })]);
  assert.deepEqual(sitsUnder(deleted), [[0, 'y']]);
});

test('only an unsent finding carries a queue id, so p and d cannot touch a posted one', () => {
  const rows = buildDoc([
    file({ threads: [{ ...thread(2), id: 'q1', pending: 'NIT' }, { ...thread(3), id: 'gl9' }] }),
  ]);
  const ids = rows.filter((r) => r.kind === 'author').map((r) => r.queueId);
  assert.deepEqual(ids, ['q1', undefined]);
});

test('a comment wraps on words and never runs off the row', () => {
  const lines = wrapText('the quick brown fox jumps over the lazy dog', 12);
  assert.ok(lines.every((l) => l.length <= 12), lines.join('|'));
  assert.equal(lines.join(' '), 'the quick brown fox jumps over the lazy dog', 'nothing is lost');
});

test('a word wider than the column is cut rather than overflowing', () => {
  const url = 'https://gitlab.example/a/very/long/path/that/never/breaks';
  const lines = wrapText(`see ${url} for it`, 20);
  assert.ok(lines.every((l) => l.length <= 20), lines.join('|'));
  assert.equal(lines.join('').replace(/ /g, ''), `see${url}forit`.replace(/ /g, ''));
});

test('a short comment is left as one row', () => {
  assert.deepEqual(wrapText('short', 40), ['short']);
  assert.deepEqual(wrapText('', 40), ['']);
});

test('the document wraps comments itself, so a row on screen is a row in the doc', () => {
  // The view draws a fixed count of rows. A body the terminal wrapped would take three
  // rows and be counted as one, pushing two rows off the bottom of every screen.
  const long = 'x'.repeat(200);
  const wide = { ...thread(3) };
  wide.notes = [{ author: 'someone', body: long, createdAt: '' }];
  const rows = buildDoc([file({ threads: [wide] })], new Set(), 60);
  const notes = rows.filter((r) => r.kind === 'note');
  assert.equal(notes.length, Math.ceil(200 / noteWidth(60)));
  assert.ok(notes.every((r) => r.text.length <= noteWidth(60)));
  assert.equal(notes.map((r) => r.text).join(''), long, 'and the comment is all still there');
});
