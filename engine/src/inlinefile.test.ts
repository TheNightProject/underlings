import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'thematrix-inlinefile-'));
process.env['UNDERLINGS_STATE_DIR'] = dir;
process.env['GITLAB_TOKEN'] = 'not-a-real-token';

const { fileView, hunkAnchor, hunkAnchors, inlineFile } = await import('./inlinefile.js');
const { saveQueue } = await import('./data/store.js');
type Discussion = import('./data/gitlab.js').Discussion;
type MrFile = import('./data/gitlab.js').MrFile;
type QueuedComment = import('./types.js').QueuedComment;

const DIFF = ['@@ -1,4 +1,4 @@', ' one', '-two', '+TWO', ' three', ' four'].join('\n');
const TEXT = ['one', 'TWO', 'three', 'four', ''].join('\n');
const FILE: MrFile = { oldPath: 'a.py', newPath: 'a.py', diff: DIFF, tooLarge: false };
const MR = { projectId: 1001, projectPath: 'acme/engine', iid: 621, sha: 'head-1' };

function finding(line: number, over: Partial<QueuedComment> = {}): QueuedComment {
  return {
    id: `q${line}`,
    projectPath: 'acme/engine',
    projectId: 1001,
    iid: 621,
    webUrl: 'https://x',
    severity: 'MINOR',
    body: `MINOR: about line ${line}`,
    position: { base_sha: 'b', start_sha: 's', head_sha: 'head-1', new_path: 'a.py', new_line: line },
    createdAt: '',
    createdBy: 'ws:mr-review',
    status: 'pending',
    ...over,
  };
}

function posted(line: number): Discussion {
  return {
    id: `d${line}`,
    resolved: false,
    position: { new_path: 'a.py', new_line: line },
    notes: [{ author: 'ivan', body: 'posted', createdAt: '', system: false }],
  };
}

const view = (over: Partial<Parameters<typeof fileView>[0]> = {}) =>
  fileView({ path: 'a.py', text: TEXT, file: FILE, diffComplete: true, discussions: [], queue: [], ...over });

test('a pending finding carries its queue id, so the page can post, edit or drop it', () => {
  const rows = view({ queue: [finding(3)] }).rows.filter((r) => r.pending);
  assert.ok(rows.length > 0);
  assert.ok(rows.every((r) => r.queueId === 'q3'));
});

test('a posted thread carries its GitLab id and whether it is resolved, and a pending finding carries neither', () => {
  const done = { ...posted(4), id: 'd-done', resolved: true };
  const rows = view({ queue: [finding(3)], discussions: [posted(2), done] }).rows;
  const owner = (r: (typeof rows)[number]) => `${r.discussionId} ${r.resolved} ${r.queueId}`;
  const owners = (thread: number) => new Set(rows.filter((r) => r.thread === thread).map(owner));
  assert.deepEqual(owners(0), new Set(['d2 false undefined']));
  assert.deepEqual(owners(1), new Set(['undefined undefined q3']));
  assert.deepEqual(owners(2), new Set(['d-done true undefined']));
  assert.ok(rows.filter((r) => r.pending).every((r) => !('discussionId' in r) && !('resolved' in r)));
});

test('a thread past the end of the file is counted, not silently dropped', () => {
  const v = view({ queue: [finding(3), finding(40)], discussions: [posted(2)] });
  assert.equal(v.threads, 3);
  assert.equal(v.placed, 2);
  assert.equal(v.unplaced, 1);
  assert.equal(v.pending, 1, 'only the finding that found its line');
});

test('a file that could not be read falls back to its diff', () => {
  const v = view({ text: null, queue: [finding(2)] });
  assert.equal(v.source, 'diff');
  assert.equal(v.fileTooBig, false, 'and does not blame its size');
  assert.equal(v.rows.filter((r) => r.kind === 'gap')[0]?.text, '@@ -1,4 +1,4 @@');
  assert.equal(v.placed, 1);
});

test('a diff GitLab collapsed still places threads, and says it marked nothing', () => {
  const v = view({ file: { ...FILE, diff: '', tooLarge: true }, queue: [finding(3)] });
  assert.equal(v.tooLarge, true);
  assert.equal(v.placed, 1);
  assert.ok(v.rows.every((r) => r.change !== '+' && r.change !== '-'));
});

test('a final newline draws no empty line past the end', () => {
  const lines = view().rows.filter((r) => r.kind === 'code' && r.change !== '-');
  assert.deepEqual(lines.map((r) => r.line), [1, 2, 3, 4]);
});

test('a file too big to send is shown as its diff instead, and says why', () => {
  const v = view({ text: 'x'.repeat(1_000_001) });
  assert.equal(v.source, 'diff');
  assert.equal(v.fileTooBig, true);
});

test('a file with more lines than a page can draw is shown as its diff, however few characters', () => {
  assert.equal(view({ text: 'x\n'.repeat(20_000) }).source, 'file');
  const v = view({ text: 'x\n'.repeat(20_001) });
  assert.equal(v.source, 'diff');
  assert.equal(v.fileTooBig, true);
});

test('a finding on a removed line sits under it, and one on a line the diff does not remove is unplaced', () => {
  const removed = (line: number, id: string) =>
    finding(line, { id, position: { base_sha: 'b', start_sha: 's', head_sha: 'head-1', old_path: 'a.py', new_path: 'a.py', old_line: line } });
  const v = view({ queue: [removed(2, 'gone'), removed(3, 'kept')] });
  const at = v.rows.findIndex((r) => r.queueId === 'gone');
  assert.deepEqual(v.rows[at - 1], { kind: 'code', text: 'two', line: 2, change: '-' });
  assert.equal(v.placed, 1);
  assert.equal(v.unplaced, 1);
});

test('every commented path is listed, so the page can move between them', () => {
  const other = posted(1);
  other.position = { new_path: 'b.py', new_line: 1 };
  assert.deepEqual(view({ discussions: [posted(2), other] }).commentedPaths, ['a.py', 'b.py']);
});

const HUNK_B = [
  '             elements, anchor = anchor_optional_pattern(',
  '+            if anchor is None and elements[0].variable in saved_bound_vars:',
  '+                _reject_rebound_vars(frozenset(saved_bound_vars))',
  '             ctx.fragments, ctx.bound_vars = [], {}',
].join('\n');
const DIFF_B = [
  '@@ -597,2 +597,4 @@',
  '             elements, anchor = anchor_optional_pattern(',
  '+            if anchor is None and elements[0].variable in saved_bound_vars:',
  '+                _reject_rebound_vars(frozenset(saved_bound_vars))',
  '             ctx.fragments, ctx.bound_vars = [], {}',
].join('\n');

test('the commented line is found in its hunk even when it is not the last line', () => {
  assert.equal(hunkAnchor(HUNK_B, DIFF_B, { new_line: 598 }), 1);
  assert.equal(hunkAnchor(HUNK_B, DIFF_B, { new_line: 599 }), 2);
});

test('existing code quoted without diff markers still finds its line', () => {
  const diff = ['@@ -10,3 +7,3 @@', ' class Placeholder:', '     """', '-    Old text.', '+    New text.'].join('\n');
  const hunk = ['class Placeholder:', '    """'].join('\n');
  assert.equal(hunkAnchor(hunk, diff, { new_line: 7, old_line: 10 }), 0);
});

test('a repeated line is told apart by the lines before it', () => {
  const diff = ['@@ -1,5 +1,6 @@', ' a()', ' }', ' b()', '+c()', ' }', ' b()'].join('\n');
  const hunk = [' a()', ' }', ' b()', '+c()', ' }'].join('\n');
  assert.equal(hunkAnchor(hunk, diff, { new_line: 5 }), 4);
});

test('what follows a repeated line tells it apart across a prose separator', () => {
  const diff = ['@@ -1,3 +1,3 @@', ' v()', ' }', ' y()'].join('\n');
  const hunk = [' }', ' w()', 'and later, in the same file:', ' }', ' y()'].join('\n');
  assert.equal(hunkAnchor(hunk, diff, { new_line: 2 }), 3);
});

test('a line quoted as the diff has it beats the same code quoted bare', () => {
  const diff = ['@@ -1,1 +1,2 @@', ' a()', '+x()'].join('\n');
  const hunk = ['x()', 'replacing, in other.py:', '+x()'].join('\n');
  assert.equal(hunkAnchor(hunk, diff, { new_line: 2 }), 2);
});

test('a line the diff does not cover, or a hunk that does not quote it, has no anchor', () => {
  assert.equal(hunkAnchor(HUNK_B, DIFF_B, { new_line: 900 }), null);
  assert.equal(hunkAnchor('+something else', DIFF_B, { new_line: 598 }), null);
});

// GitLab at its boundary: every request is answered here and recorded, none leaves.
const calls: string[] = [];
const realFetch = globalThis.fetch;
let discussions: unknown[] = [];
let rawBody: () => string | ReadableStream<Uint8Array> = () => TEXT;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  calls.push(`${init?.method ?? 'GET'} ${url.replace(/^.*\/api\/v4/, '')}`);
  if (url.includes('/raw?')) return new Response(rawBody(), { status: 200 });
  const body = url.includes('/discussions')
    ? discussions
    : [{ old_path: 'a.py', new_path: 'a.py', diff: DIFF, too_large: false, collapsed: false }];
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

after(() => {
  globalThis.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  calls.length = 0;
  discussions = [];
  rawBody = () => TEXT;
  saveQueue([]);
});

test('findings queued on another MR do not leak into this file', async () => {
  saveQueue([finding(2), finding(3, { iid: 999 })]);
  const v = await inlineFile({ ...MR, sha: 'head-leak' }, 'a.py');
  assert.equal(v?.pending, 1);
  assert.equal(v?.threads, 1);
});

test('a path neither changed nor commented on is refused before any file is read', async () => {
  const v = await inlineFile({ ...MR, sha: 'head-guard' }, '.env');
  assert.equal(v, null);
  assert.ok(!calls.some((c) => c.includes('/repository/files/')), calls.join('\n'));
});

test('no path opens the first commented file', async () => {
  saveQueue([finding(3)]);
  const v = await inlineFile({ ...MR, sha: 'head-first' }, '');
  assert.equal(v?.path, 'a.py');
});

test('the file and diff are read once per head, the threads every time', async () => {
  const head = { ...MR, sha: 'head-cache' };
  await inlineFile(head, 'a.py');
  await inlineFile(head, 'a.py');
  const count = (part: string) => calls.filter((c) => c.includes(part)).length;
  assert.equal(count('/raw?'), 1);
  assert.equal(count('/diffs?'), 1);
  assert.equal(count('/discussions?'), 2);
  assert.ok(calls.every((c) => c.startsWith('GET ')), 'reads only');
});

test('each finding learns its anchored hunk line from the diff at the head', async () => {
  const hunk = [' one', '-two', '+TWO', ' three'].join('\n');
  const found = await hunkAnchors({ ...MR, sha: 'head-anchors' }, [
    finding(2, { diffHunk: hunk }),
    finding(4, { diffHunk: hunk }),
    finding(3, { id: 'general', diffHunk: hunk, position: undefined }),
  ]);
  assert.deepEqual(found, { q2: 2, q4: null, general: null });
});

test('a file too big to show is read no further than the cap, and only once per head', async () => {
  let pulled = 0;
  rawBody = () =>
    new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        controller.enqueue(new Uint8Array(64 * 1024).fill(120));
        if (pulled === 1000) controller.close();
      },
    });
  const head = { ...MR, sha: 'head-big' };
  const first = await inlineFile(head, 'a.py');
  const second = await inlineFile(head, 'a.py');
  assert.equal(first?.source, 'diff');
  assert.equal(first?.fileTooBig, true);
  assert.equal(second?.fileTooBig, true);
  assert.ok(pulled < 40, `read ${pulled} chunks of 64 KB`);
  assert.equal(calls.filter((c) => c.includes('/raw?')).length, 1, 'the verdict is kept, so it is not read again');
});
