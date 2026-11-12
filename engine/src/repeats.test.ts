import assert from 'node:assert/strict';
import { test } from 'node:test';
import { findingPrint, isRepeat } from './repeats.js';
import { ME, note, thread } from './auto/testkit.js';
import type { QueuedComment } from './types.js';

const item = (id: string, body: string, line: number, createdAt: string): QueuedComment => ({
  id, projectPath: 'acme/engine', projectId: 1001, iid: 621, webUrl: '', severity: 'MAJOR', body, createdBy: 'agent', createdAt, status: 'pending',
  position: { new_path: 'src/app.ts', new_line: line },
} as QueuedComment);

test('a finding raised again on a shifted line is a repeat, whatever its tag and spacing', () => {
  const before = { ...item('a', '**[MAJOR]** Null check is missing\nmore', 10, '2026-11-01T00:00:00Z'), status: 'discarded' as const };
  const again = item('b', 'MAJOR: Null   check is *missing*', 14, '2026-11-02T00:00:00Z');
  assert.equal(findingPrint(before), findingPrint(again));
  assert.equal(isRepeat(again, [before, again], [], ME), true);
});

test('a new first line is not a repeat', () => {
  const before = item('a', 'Null check is missing', 10, '2026-11-01T00:00:00Z');
  const fresh = item('b', 'The retry never backs off', 10, '2026-11-02T00:00:00Z');
  assert.equal(isRepeat(fresh, [before, fresh], [], ME), false);
});

test('the opening note of your own open thread counts, and someone else\'s or a resolved one does not', () => {
  const finding = item('b', 'Null check is missing', 10, '2026-11-02T00:00:00Z');
  const said = (author: string, resolved = false) => [thread('d-1', [note(author, 'Null check is missing', '2026-11-01T00:00:00Z')], { resolved })];
  assert.equal(isRepeat(finding, [finding], said(ME), ME), true);
  assert.equal(isRepeat(finding, [finding], said('alice'), ME), false);
  assert.equal(isRepeat(finding, [finding], said(ME, true), ME), false);
});
