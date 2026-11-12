import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'thematrix-commands-'));
process.env['UNDERLINGS_STATE_DIR'] = dir;
process.env['GITLAB_TOKEN'] = 'not-a-real-token';

const { liftReviewHoldIfDone, postAll, reviewRefusal, setApproved, setHeld, setPersonLevel, startReview, toggleFullAutoPause } = await import('./commands.js');
const { addToQueue, loadQueue, loadSettings, loadState, recordRun, saveSettings, updateQueueItem } = await import('./data/store.js');
const { recordReviewTerminal, toggleWatch } = await import('./actions/watch.js');
const { HOLD_NOTE, RELEASE_NOTE_BARE, RELEASE_NOTE_WITH_COMMENTS } = await import('./config.js');
const { DEFAULT_SETTINGS } = await import('./settings.js');
const { mr, resetState } = await import('./auto/testkit.js');

/** GitLab's merge status for the MR as a fresh fetch reports it. */
let liveStatus = 'NOT_APPROVED';
let liveSha = 'head-1';
let liveReviewers: { username: string; mergeRequestInteraction: { reviewState: string } }[] = [];
const calls: string[] = [];
const realFetch = globalThis.fetch;

function describe(url: string, init?: RequestInit): string {
  const body = init?.body ? (JSON.parse(String(init.body)) as { query?: string; body?: string }) : {};
  if (body.query?.includes('mergeRequestRequestChanges')) return 'hold';
  if (body.query?.includes('mergeRequestDestroyRequestedChanges')) return 'release';
  if (body.query) return 'fetch';
  if (url.endsWith('/notes')) return `note: ${body.body}`;
  return url.split('/').pop() ?? url;
}

function answer(call: string): unknown {
  if (call === 'fetch') {
    const node = {
      iid: '621', title: 'Scope it', webUrl: 'https://x', draft: false, conflicts: false, userNotesCount: 0,
      resolvableDiscussionsCount: 0, resolvedDiscussionsCount: 0, createdAt: '', updatedAt: '',
      diffHeadSha: liveSha, sourceBranch: 'b', detailedMergeStatus: liveStatus,
      author: { username: 'heidi' }, reviewers: { nodes: liveReviewers }, approvedBy: { nodes: [] }, headPipeline: null,
    };
    return { data: { p0: { id: 'gid://gitlab/Project/1001', fullPath: 'acme/engine', name: 'relay', mergeRequests: { count: 1, nodes: [node] } } } };
  }
  const result = { errors: [], mergeRequest: { detailedMergeStatus: liveStatus } };
  if (call === 'hold') return { data: { mergeRequestRequestChanges: result } };
  if (call === 'release') return { data: { mergeRequestDestroyRequestedChanges: result } };
  return { id: 'd-new' };
}

// GitLab at its boundary: every request is recorded and answered here, none leaves.
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const call = describe(String(input), init);
  calls.push(call);
  return new Response(JSON.stringify(answer(call)), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

after(() => {
  globalThis.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  resetState();
  calls.length = 0;
  liveStatus = 'NOT_APPROVED';
  liveSha = 'head-1';
  liveReviewers = [];
  saveSettings({ ...DEFAULT_SETTINGS });
});

const launched = async (): Promise<void> => {
  calls.push('launch');
};

function queueFinding(): void {
  addToQueue([{ projectPath: 'acme/engine', projectId: 1001, iid: 621, webUrl: 'https://x', severity: 'MINOR', body: 'b', createdBy: 'agent' }]);
}

test('a review holds the merge, with its reason, only after the agent is launched', async () => {
  await startReview(mr(), launched);
  assert.deepEqual(calls, ['fetch', 'launch', 'fetch', 'hold', `note: ${HOLD_NOTE}`]);
});

test('the hold note is the one saved in Settings, and a blank one posts the default', async () => {
  saveSettings({ ...DEFAULT_SETTINGS, holdNote: 'Holding this while my review runs.' });
  await startReview(mr(), launched);
  assert.equal(calls.at(-1), 'note: Holding this while my review runs.');
  calls.length = 0;
  saveSettings({ ...DEFAULT_SETTINGS, holdNote: '  ' });
  await setHeld(mr(), true);
  assert.equal(calls.at(-1), `note: ${HOLD_NOTE}`);
});

test('a launch that fails holds nothing', async () => {
  const failing = async (): Promise<void> => {
    throw new Error('orca is not running');
  };
  await assert.rejects(startReview(mr(), failing), /orca is not running/);
  assert.deepEqual(calls, ['fetch']);
});

test('a review does not hold an MR GitLab already reports held, however old the caller copy', async () => {
  liveStatus = 'REQUESTED_CHANGES';
  await startReview(mr({ mergeStatus: 'NOT_APPROVED' }), launched);
  assert.deepEqual(calls, ['fetch', 'launch', 'fetch']);
});

test('a review holds nothing when holding is switched off', async () => {
  saveSettings({ ...DEFAULT_SETTINGS, holdWhileReviewing: false });
  await startReview(mr(), launched);
  assert.deepEqual(calls, ['fetch', 'launch', 'fetch']);
});

test('a review of your own MR never holds it, whatever the setting', async () => {
  await startReview(mr(), launched, { hold: false });
  assert.deepEqual(calls, ['fetch', 'launch']);
});

test('a review is launched, and so baselined, on the MR as GitLab has it now, under the caller\'s label', async () => {
  liveSha = 'head-2';
  const given: { sha: string | null; repoLabel: string }[] = [];
  await startReview(mr({ sha: 'head-1' }), async (m) => void given.push({ sha: m.sha, repoLabel: m.repoLabel }), { hold: false });
  assert.deepEqual(given, [{ sha: 'head-2', repoLabel: 'Engine' }]);
});

test('r refuses while the other front end is still launching a review, or has launched one since the terminals were listed', () => {
  const listed = { terminals: [{ handle: 't-old', title: 'claude', agent: 'claude', connected: false, orphaned: true }], listedAt: Date.now() - 60_000 };
  toggleWatch(mr());
  recordReviewTerminal('acme/engine!621', 't-old');
  assert.equal(reviewRefusal(mr(), listed), null, 'the last agent is gone');
  recordRun('acme/engine!621', { webUrl: '', startedAt: new Date().toISOString(), status: 'launching', tail: [] });
  assert.equal(reviewRefusal(mr(), listed), 'an agent is already reading !621, f focuses it');
  recordRun('acme/engine!621', { status: 'working', terminal: 't-new' });
  assert.equal(reviewRefusal(mr(), listed), 'an agent is already reading !621, f focuses it', 'back from Orca, after the list');
});

test('approving lifts a hold that is on now, even when the caller copy predates it', async () => {
  liveStatus = 'REQUESTED_CHANGES';
  const { liftedHold } = await setApproved(mr({ mergeStatus: 'NOT_APPROVED' }), true);
  assert.equal(liftedHold, true);
  assert.deepEqual(calls, ['fetch', 'approve', 'release', `note: ${RELEASE_NOTE_BARE}`]);
});

test('withdrawing an approval leaves a hold alone', async () => {
  liveStatus = 'REQUESTED_CHANGES';
  await setApproved(mr(), false);
  assert.deepEqual(calls, ['fetch', 'unapprove']);
});

test('releasing a hold says the comments are up once any have been posted', async () => {
  queueFinding();
  await postAll(mr());
  calls.length = 0;
  await setHeld(mr(), false);
  assert.deepEqual(calls, ['release', `note: ${RELEASE_NOTE_WITH_COMMENTS}`]);
});

test('posting everything lifts the hold once all of it is up', async () => {
  queueFinding();
  liveStatus = 'REQUESTED_CHANGES';
  const outcome = await postAll(mr());
  assert.deepEqual(outcome, { posted: 1, total: 1, liftedHold: true });
  assert.deepEqual(calls, ['discussions', 'fetch', 'release', `note: ${RELEASE_NOTE_WITH_COMMENTS}`]);
});

test('posting with nothing queued leaves the hold on', async () => {
  liveStatus = 'REQUESTED_CHANGES';
  assert.deepEqual(await postAll(mr()), { posted: 0, total: 0, liftedHold: false });
  assert.deepEqual(calls, []);
});

test('a level set here keeps a pause made elsewhere since', () => {
  saveSettings({ ...loadSettings(), autoPaused: true });
  setPersonLevel('heidi', 'shadow');
  assert.equal(loadSettings().autoPaused, true);
  assert.equal(loadSettings().fullAuto, 'heidi:shadow');
});

test('pausing flips what is on disk, not a stale copy', () => {
  saveSettings({ ...loadSettings(), autoPaused: true });
  assert.equal(toggleFullAutoPause().autoPaused, false);
  assert.equal(loadSettings().autoPaused, false);
});

test('the picker keeps the default row and the off entries, and off on a row means never once a default is set', () => {
  saveSettings({ ...loadSettings(), fullAuto: '' });
  setPersonLevel('*', 'shadow');
  setPersonLevel('heidi', 'comments');
  setPersonLevel('judy', 'off');
  assert.equal(loadSettings().fullAuto, '*:shadow, heidi:comments, judy:off');
  setPersonLevel('judy', null);
  setPersonLevel('*', null);
  assert.equal(loadSettings().fullAuto, 'heidi:comments', 'null follows the default again, and the default goes');
});

test('approving records the verdict with the head, withdrawing clears it, and a hold records changes', async () => {
  await setApproved(mr(), true);
  assert.deepEqual([loadState().verdicts?.['acme/engine!621']?.verdict, loadState().verdicts?.['acme/engine!621']?.sha], ['approved', 'head-1']);
  await setApproved(mr(), false);
  assert.equal(loadState().verdicts?.['acme/engine!621'], undefined);
  await setHeld(mr(), true);
  assert.equal(loadState().verdicts?.['acme/engine!621']?.verdict, 'changes');
});

test('posting the last pending item lifts the hold your review placed, saying the comments are up', async () => {
  await startReview(mr(), launched);
  assert.ok(loadState().reviewHolds?.['acme/engine!621'], 'the review noted its hold');
  queueFinding();
  queueFinding();
  liveStatus = 'REQUESTED_CHANGES';
  const [first, second] = loadQueue();
  updateQueueItem(first!.id, { status: 'posted', postedAt: new Date().toISOString() });
  calls.length = 0;
  assert.deepEqual(await liftReviewHoldIfDone(mr()), { liftedHold: false }, 'one is still pending');
  assert.deepEqual(calls, []);
  updateQueueItem(second!.id, { status: 'discarded' });
  assert.deepEqual(await liftReviewHoldIfDone(mr()), { liftedHold: true });
  assert.deepEqual(calls, ['fetch', 'release', `note: ${RELEASE_NOTE_WITH_COMMENTS}`]);
  assert.equal(loadState().reviewHolds?.['acme/engine!621'], undefined);
});

test('a hold you placed yourself after the review stands when the last item is posted or discarded', async () => {
  await startReview(mr(), launched);
  liveStatus = 'REQUESTED_CHANGES';
  await setHeld(mr(), true);
  queueFinding();
  queueFinding();
  const [first, second] = loadQueue();
  updateQueueItem(first!.id, { status: 'posted', postedAt: new Date().toISOString() });
  updateQueueItem(second!.id, { status: 'discarded' });
  calls.length = 0;
  assert.deepEqual(await liftReviewHoldIfDone(mr(), 'heidi'), { liftedHold: false });
  assert.deepEqual(calls, []);
  assert.equal(loadState().verdicts?.['acme/engine!621']?.verdict, 'changes');
});

test('a colleague\'s change request is never lifted as your review hold', async () => {
  await startReview(mr(), launched);
  liveStatus = 'REQUESTED_CHANGES';
  liveReviewers = [{ username: 'frank', mergeRequestInteraction: { reviewState: 'REVIEWED' } }, { username: 'judy', mergeRequestInteraction: { reviewState: 'REQUESTED_CHANGES' } }];
  queueFinding();
  updateQueueItem(loadQueue()[0]!.id, { status: 'posted', postedAt: new Date().toISOString() });
  calls.length = 0;
  assert.deepEqual(await liftReviewHoldIfDone(mr(), 'frank'), { liftedHold: false });
  assert.deepEqual(calls, ['fetch']);
});

test('a hold your review did not place is never lifted by the last post', async () => {
  liveStatus = 'REQUESTED_CHANGES';
  queueFinding();
  updateQueueItem(loadQueue()[0]!.id, { status: 'posted', postedAt: new Date().toISOString() });
  assert.deepEqual(await liftReviewHoldIfDone(mr()), { liftedHold: false });
  assert.deepEqual(calls, []);
});
