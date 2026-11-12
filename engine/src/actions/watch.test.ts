import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

// config.ts reads the state path at module load, so it is set before the dynamic imports.
const dir = mkdtempSync(join(tmpdir(), 'thematrix-test-'));
process.env['UNDERLINGS_STATE_DIR'] = dir;

const { watchForReview, toggleWatch, isWatched, setAuto, stopWatching } = await import('./watch.js');
const { loadState } = await import('../data/store.js');
const { mrKey, fingerprintDiffers, fingerprint } = await import('../types.js');

after(() => rmSync(dir, { recursive: true, force: true }));

function mr(over: Partial<import('../types.js').Mr> = {}): import('../types.js').Mr {
  return {
    projectPath: 'acme/engine',
    projectId: 1001,
    repoLabel: 'Engine',
    iid: 621,
    title: 'Scope the App Library',
    webUrl: 'https://gitlab.com/x/-/merge_requests/621',
    draft: false,
    conflicts: false,
    notes: 3,
    author: 'hugo',
    reviewers: [],
    approvedBy: [],
    pipeline: 'SUCCESS',
    mergeStatus: 'NOT_APPROVED',
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-02T00:00:00Z',
    sha: 'abc123',
    sourceBranch: 'fix/thing',
    ticket: 'ABC-3568',
    unresolvedThreads: 0,
    ...over,
  };
}

test('reviewing starts a watch, so the obligation is not a key you must remember', () => {
  const subject = mr();
  assert.equal(isWatched(mrKey(subject)), false);
  const { alreadyWatched } = watchForReview(subject);
  assert.equal(alreadyWatched, false);
  assert.equal(isWatched(mrKey(subject)), true);
  assert.ok(loadState().watches[mrKey(subject)]?.reviewedAt, 'records when it was reviewed');
});

test('the baseline is the state you reviewed, so a later push reads as changed', () => {
  const reviewed = mr({ sha: 'abc123' });
  watchForReview(reviewed);
  const seen = loadState().watches[mrKey(reviewed)]!.seen;
  assert.equal(fingerprintDiffers(seen, fingerprint(mr({ sha: 'abc123' }))), false);
  assert.equal(fingerprintDiffers(seen, fingerprint(mr({ sha: 'pushed-later' }))), true);
});

test('re-reviewing resets the baseline but keeps auto and the schedule', () => {
  const subject = mr({ iid: 700, sha: 'first' });
  watchForReview(subject);
  const key = mrKey(subject);
  setAuto(key, true);
  const before = loadState().watches[key]!;
  const { alreadyWatched } = watchForReview(mr({ iid: 700, sha: 'second' }));
  assert.equal(alreadyWatched, true);
  const afterWatch = loadState().watches[key]!;
  assert.equal(afterWatch.auto, true, 'auto survives a re-review');
  assert.equal(afterWatch.addedAt, before.addedAt, 'original watch date is kept');
  assert.equal(afterWatch.seen.sha, 'second', 'baseline moves to what was just reviewed');
});

test('w still toggles a review-started watch off', () => {
  const subject = mr({ iid: 800 });
  watchForReview(subject);
  assert.equal(toggleWatch(subject), false);
  assert.equal(isWatched(mrKey(subject)), false);
});

test('a watch can be dropped by key, once its merge request is gone', () => {
  // The ones worth clearing out are exactly the ones toggleWatch can no longer reach:
  // it needs the Mr itself, and a merged one has dropped out of the list.
  const gone = mr({ iid: 4242 });
  toggleWatch(gone);
  const key = mrKey(gone);
  assert.equal(isWatched(key), true);
  assert.equal(stopWatching(key), true);
  assert.equal(isWatched(key), false, 'and it is gone');
  assert.equal(stopWatching(key), false, 'dropping one twice is not an error');
});
