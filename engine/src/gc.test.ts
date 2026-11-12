import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Workspace } from './agents/host.js';
import { outOfScope, parseReviewName, reapable, workspaceForReview } from './gc.js';
import type { Mr } from './types.js';

function workspace(displayName: string, extra: Partial<Workspace> = {}): Workspace {
  return {
    id: `repo1::/home/dev/work::workspace:${displayName}`,
    displayName,
    path: '/home/dev/work',
    branch: '',
    isMainWorktree: false,
    ...extra,
  };
}

function mr(repoLabel: string, iid: number): Mr {
  return { repoLabel, iid, projectPath: `acme/${repoLabel}` } as Mr;
}

const OPEN = [mr('Engine', 792), mr('Order Book', 649)];
const LABELS = ['Engine', 'Order Book', 'Frontend'];
const QUIET = { agentAlive: () => false, pending: () => 0, knownRepoLabels: LABELS };

test('a workspace whose MR has closed is reaped', () => {
  const found = reapable([workspace('review-Engine-519')], OPEN, QUIET);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.iid, 519);
  assert.equal(found[0]?.reason, 'mr closed');
});

test('a workspace whose MR is still open is left alone by default', () => {
  assert.deepEqual(reapable([workspace('review-Engine-792')], OPEN, QUIET), []);
});

test('--finished reaches open MRs whose review has nothing left to do', () => {
  const found = reapable([workspace('review-Engine-792')], OPEN, {
    ...QUIET,
    includeFinished: true,
  });
  assert.equal(found[0]?.reason, 'review finished');
});

test('a live agent keeps its workspace, whatever the MR is doing', () => {
  const opts = { ...QUIET, agentAlive: () => true, includeFinished: true };
  assert.deepEqual(reapable([workspace('review-Engine-519')], OPEN, opts), []);
});

test('findings still waiting to be posted keep the workspace', () => {
  // The queue outlives the terminal, but closing the workspace loses the context the
  // comments were written against.
  const opts = { ...QUIET, pending: () => 3, includeFinished: true };
  assert.deepEqual(reapable([workspace('review-Engine-519')], OPEN, opts), []);
});

test('the checkout itself is never a candidate', () => {
  const main = workspace('Acme', { isMainWorktree: true });
  const plain = workspace('Acme');
  assert.deepEqual(reapable([main, plain], OPEN, { ...QUIET, includeFinished: true }), []);
});

test('a ticket workspace is never a candidate, because its branch is the work', () => {
  const ticket = workspace('review-Engine-519', { branch: 'refs/heads/fix/ABC-3834' });
  assert.deepEqual(reapable([ticket], OPEN, { ...QUIET, includeFinished: true }), []);
  const unnamed = workspace('abc-3834-member-of-edges');
  assert.deepEqual(reapable([unnamed], OPEN, { ...QUIET, includeFinished: true }), []);
});

test('a repo label with a space survives the round trip through the workspace name', () => {
  assert.deepEqual(parseReviewName('review-Order-Book-649'), {
    repoLabel: 'Order Book',
    iid: 649,
  });
  assert.deepEqual(parseReviewName('review-Engine-792'), { repoLabel: 'Engine', iid: 792 });
  assert.equal(parseReviewName('Acme'), null);
  assert.equal(parseReviewName('review-Engine'), null, 'no iid, no match');
  // And the match must survive it: Order Book !649 is open, so it is not reaped.
  assert.deepEqual(reapable([workspace('review-Order-Book-649')], OPEN, QUIET), []);
});

test('the reap is addressed by workspace id, which is what tells two of them apart', () => {
  // Every workspace on a folder repo reports the same path, so a path selector could
  // match the checkout. Two workspaces for one MR must stay separately addressable.
  const a = workspace('review-Engine-519', { id: 'repo::/w::workspace:a' });
  const b = workspace('review-Engine-519', { id: 'repo::/w::workspace:b' });
  const found = reapable([a, b], OPEN, QUIET);
  assert.equal(found.length, 2);
  assert.equal(new Set(found.map((c) => c.workspace.id)).size, 2);
});

test('a repo the scan never queried is left alone, not mistaken for closed', () => {
  // An MR missing from the list means "closed" only for a repo that was looked at.
  const ws = workspace('review-Kontor-12');
  assert.deepEqual(reapable([ws], OPEN, { ...QUIET, includeFinished: true }), []);
  assert.deepEqual(
    outOfScope([ws], LABELS).map((w) => w.displayName),
    ['review-Kontor-12'],
    'and the sweep says so rather than passing over it silently',
  );
  assert.deepEqual(outOfScope([workspace('review-Engine-519')], LABELS), []);
});

test('the workspace a review was given is found by the name the launcher set', () => {
  const ws = (displayName: string, over: Partial<Workspace> = {}): Workspace =>
    ({ id: displayName, displayName, path: '', branch: '', isMainWorktree: false, ...over });
  const all = [
    ws('review-Order-Book-679'),
    ws('review-Engine-621'),
    ws('fix-ABC-3835', { branch: 'fix/ABC-3835' }),
  ];
  assert.equal(workspaceForReview(all, 'Order Book', 679)?.id, 'review-Order-Book-679');
  assert.equal(workspaceForReview(all, 'order book', 679)?.id, 'review-Order-Book-679', 'case does not matter');
  assert.equal(workspaceForReview(all, 'Order Book', 680), undefined, 'a different MR is not it');
  assert.equal(workspaceForReview(all, 'Engine', 999), undefined);
});

test('a worktree on a branch is somebody\'s ticket, never a review to close', () => {
  // The branch is the work. Closing one of these loses it.
  const looksRight: Workspace = {
    id: 'w', displayName: 'review-Engine-621', path: '', branch: 'fix/ABC-1', isMainWorktree: false,
  };
  assert.equal(workspaceForReview([looksRight], 'Engine', 621), undefined);
  const main: Workspace = { ...looksRight, branch: '', isMainWorktree: true };
  assert.equal(workspaceForReview([main], 'Engine', 621), undefined, 'nor the main worktree');
});
