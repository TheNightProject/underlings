import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Discussion } from './data/gitlab.js';
import { allThreads, contextFor, inlineThreads, queuedThreads } from './inline.js';

const DIFF = [
  '@@ -10,5 +10,6 @@ def handler():',
  ' import os',
  ' import sys',
  '-old_call()',
  '+new_call()',
  '+extra_call()',
  ' return None',
].join('\n');

function thread(id: string, position: Discussion['position'], authors: string[] = ['ivan']): Discussion {
  return {
    id,
    resolved: false,
    ...(position ? { position } : {}),
    notes: authors.map((author) => ({ author, body: `${author} said something`, createdAt: '', system: false })),
  };
}

test('only threads hanging off a line are listed, in reading order', () => {
  const given = [
    thread('c', { new_path: 'b.py', new_line: 3 }),
    thread('a', { new_path: 'a.py', new_line: 9 }),
    thread('b', { new_path: 'a.py', new_line: 2 }),
    thread('general', undefined),
  ];
  assert.deepEqual(
    inlineThreads(given).map((t) => `${t.path}:${t.line}`),
    ['a.py:2', 'a.py:9', 'b.py:3'],
    'by file, then down the file',
  );
});

test('a thread from anyone is listed, not only your own', () => {
  const given = [
    thread('x', { new_path: 'a.py', new_line: 1 }, ['ivan']),
    thread('y', { new_path: 'a.py', new_line: 2 }, ['sybil', 'you']),
  ];
  const out = inlineThreads(given);
  assert.equal(out.length, 2);
  assert.deepEqual(out[1]?.notes.map((n) => n.author), ['sybil', 'you'], 'replies come along');
});

test('a thread on a deleted line is kept, and knows which side it is on', () => {
  const [only] = inlineThreads([thread('d', { old_path: 'a.py', old_line: 12 })]);
  assert.equal(only?.side, 'old');
  assert.equal(only?.line, 12);
  assert.equal(only?.path, 'a.py');
});

test('a position with no line at all is not an inline thread', () => {
  assert.deepEqual(inlineThreads([thread('n', { new_path: 'a.py' })]), []);
  assert.deepEqual(inlineThreads([thread('n', { new_line: 4 })]), [], 'nor one with no path');
});

test('the context is the diff around the line, with the line itself marked', () => {
  const rows = contextFor(DIFF, 12, 'new', 2);
  const anchor = rows.find((r) => r.anchor);
  assert.ok(anchor, 'the anchored line is in there');
  assert.equal(anchor?.text, 'new_call()');
  assert.equal(anchor?.kind, '+');
  assert.equal(rows.filter((r) => r.anchor).length, 1, 'and only one line is the anchor');
});

test('each line keeps the number from the side it belongs to', () => {
  const rows = contextFor(DIFF, 12, 'new', 3);
  const added = rows.filter((r) => r.kind === '+').map((r) => r.line);
  assert.deepEqual(added, [12, 13], 'additions count on the right');
  const removed = rows.filter((r) => r.kind === '-').map((r) => r.line);
  assert.deepEqual(removed, [12], 'and removals on the left');
});

test('a thread on a removed line anchors to the removal, not the addition beside it', () => {
  const rows = contextFor(DIFF, 12, 'old', 2);
  const anchor = rows.find((r) => r.anchor);
  assert.equal(anchor?.kind, '-');
  assert.equal(anchor?.text, 'old_call()');
});

test('the radius bounds how much code comes with it', () => {
  assert.ok(contextFor(DIFF, 12, 'new', 1).length <= 3);
  assert.ok(contextFor(DIFF, 12, 'new', 10).length <= DIFF.split('\n').length);
});

test('a line the diff does not cover yields nothing rather than a wrong hunk', () => {
  assert.deepEqual(contextFor(DIFF, 900, 'new'), []);
  assert.deepEqual(contextFor('', 3, 'new'), []);
  assert.deepEqual(contextFor('not a diff at all', 3, 'new'), []);
});

test('a queued finding becomes a thread so it can be read in the file', () => {
  const queued = [
    {
      id: 'q1', projectPath: 'a/b', projectId: 1, iid: 2, webUrl: '',
      severity: 'MAJOR' as const, body: 'MAJOR: this breaks on an empty list',
      createdAt: '', createdBy: 'you', status: 'pending' as const,
      position: { base_sha: 'b', start_sha: 's', head_sha: 'h', new_path: 'a.py', new_line: 12 },
    },
  ];
  const [only] = queuedThreads(queued);
  assert.equal(only?.path, 'a.py');
  assert.equal(only?.line, 12);
  assert.equal(only?.pending, 'MAJOR', 'it carries its severity, and says it is unsent');
  assert.equal(
    only?.notes[0]?.body,
    'this breaks on an empty list',
    'the severity is on the thread, so the comment does not repeat it',
  );
});

test('only pending findings come through; posted and discarded ones do not', () => {
  const base = {
    projectPath: 'a/b', projectId: 1, iid: 2, webUrl: '', severity: 'NIT' as const,
    body: 'x', createdAt: '', createdBy: 'you',
    position: { base_sha: 'b', start_sha: 's', head_sha: 'h', new_path: 'a.py', new_line: 1 },
  };
  const queue = [
    { ...base, id: '1', status: 'pending' as const },
    { ...base, id: '2', status: 'posted' as const },
    { ...base, id: '3', status: 'discarded' as const },
  ];
  assert.deepEqual(queuedThreads(queue).map((t) => t.id), ['1'], 'posted ones are already threads');
});

test('a general finding with no line is not shown in the file', () => {
  const general = [{
    id: 'g', projectPath: 'a/b', projectId: 1, iid: 2, webUrl: '', severity: 'QUESTION' as const,
    body: 'why', createdAt: '', createdBy: 'you', status: 'pending' as const,
  }];
  assert.deepEqual(queuedThreads(general), []);
});

test('posted and pending are interleaved by where they sit, not by source', () => {
  const posted = [thread('p', { new_path: 'a.py', new_line: 20 })];
  const queued = [{
    id: 'q', projectPath: 'a/b', projectId: 1, iid: 2, webUrl: '', severity: 'MINOR' as const,
    body: 'earlier', createdAt: '', createdBy: 'you', status: 'pending' as const,
    position: { base_sha: 'b', start_sha: 's', head_sha: 'h', new_path: 'a.py', new_line: 5 },
  }];
  const out = allThreads(posted, queued);
  assert.deepEqual(out.map((t) => t.line), [5, 20], 'line five reads before line twenty');
  assert.equal(out[0]?.pending, 'MINOR');
  assert.equal(out[1]?.pending, undefined);
});
