import assert from 'node:assert/strict';
import { test } from 'node:test';
import { waitingToPost } from './queue.js';
import type { Mr, QueuedComment } from './types.js';

function mr(projectPath: string, iid: number): Mr {
  return {
    projectPath,
    projectId: 1,
    repoLabel: 'Engine',
    iid,
    title: 'a title',
    webUrl: 'https://gitlab.com/x',
    draft: false,
    conflicts: false,
    notes: 0,
    author: 'them',
    reviewers: [],
    approvedBy: [],
    pipeline: 'SUCCESS',
    mergeStatus: null,
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-01T00:00:00Z',
    sha: 'abc',
    sourceBranch: 'b',
    ticket: null,
    unresolvedThreads: 0,
  };
}

function finding(
  projectPath: string,
  iid: number,
  status: QueuedComment['status'] = 'pending',
): QueuedComment {
  return {
    id: Math.random().toString(36).slice(2),
    projectPath,
    projectId: 1,
    iid,
    webUrl: 'https://gitlab.com/x',
    severity: 'MINOR',
    body: 'something',
    createdAt: '2026-11-01T00:00:00Z',
    createdBy: 'review',
    status,
  };
}

const ENGINE = 'acme/engine';

test('findings on a merge request that has merged are not waiting to be posted', () => {
  const queue = [finding(ENGINE, 1), finding(ENGINE, 1), finding(ENGINE, 2), finding(ENGINE, 2)];
  const waiting = waitingToPost(queue, [mr(ENGINE, 2)]);
  assert.deepEqual(
    waiting.map((c) => c.iid),
    [2, 2],
    'a post-all leaves this as the count, not every finding ever left behind on a merged one',
  );
});

test('posted, discarded and expired findings never count', () => {
  const queue = [finding(ENGINE, 2, 'posted'), finding(ENGINE, 2, 'discarded'), finding(ENGINE, 2, 'expired'), finding(ENGINE, 2)];
  assert.equal(waitingToPost(queue, [mr(ENGINE, 2)]).length, 1);
});

test('a repo with nothing in the list says nothing about its merge requests, so they still count', () => {
  const queue = [finding('acme/elsewhere', 9)];
  assert.equal(waitingToPost(queue, [mr(ENGINE, 2)]).length, 1);
});

test('before the first list arrives nothing is known to be closed', () => {
  const queue = [finding(ENGINE, 1), finding(ENGINE, 2)];
  assert.equal(waitingToPost(queue, []).length, 2);
});
