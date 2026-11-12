import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

// The store reads its directory once, at import, so this goes first.
const dir = mkdtempSync(join(tmpdir(), 'thematrix-edit-'));
process.env['UNDERLINGS_STATE_DIR'] = dir;
const { discard, editQueued } = await import('./actions/post.js');
const { addToQueue, claimToSend, loadQueue, updateQueueItem } = await import('./data/store.js');

after(() => rmSync(dir, { recursive: true, force: true }));

const finding = {
  projectPath: 'acme/engine', projectId: 1, iid: 7, webUrl: '',
  severity: 'MINOR' as const, body: 'as queued', createdBy: 'you',
};

test('a queued finding can be rewritten before it is sent', () => {
  const [queued] = addToQueue([finding]);
  assert.equal(editQueued(queued!.id, 'rewritten'), true);
  assert.equal(loadQueue().find((c) => c.id === queued!.id)?.body, 'rewritten');
});

test('one that has gone cannot be rewritten behind GitLab\'s back', () => {
  const [queued] = addToQueue([finding]);
  updateQueueItem(queued!.id, { status: 'posted', discussionId: 'd1' });
  assert.equal(editQueued(queued!.id, 'too late'), false);
  assert.equal(loadQueue().find((c) => c.id === queued!.id)?.body, 'as queued');
});

test('and a finding that was never there is not invented', () => {
  assert.equal(editQueued('nope', 'anything'), false);
});

test('one being sent can be neither rewritten nor discarded, since the send goes out as it was claimed', () => {
  const [queued] = addToQueue([finding]);
  assert.ok('item' in claimToSend(queued!.id, 'manual:page', Date.now()));
  assert.equal(editQueued(queued!.id, 'rewritten mid-send'), false);
  assert.equal(discard(queued!.id), false);
  const after = loadQueue().find((c) => c.id === queued!.id);
  assert.deepEqual([after?.status, after?.body], ['pending', 'as queued']);
});

test('one waiting to be sent can be discarded, and one already gone cannot', () => {
  const [waiting, posted] = addToQueue([finding, finding]);
  updateQueueItem(posted!.id, { status: 'posted', discussionId: 'd2' });
  assert.equal(discard(waiting!.id), true);
  assert.equal(discard(posted!.id), false);
  assert.deepEqual([waiting, posted].map((c) => loadQueue().find((q) => q.id === c!.id)?.status), ['discarded', 'posted']);
});
