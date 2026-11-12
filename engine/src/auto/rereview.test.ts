import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'thematrix-rereview-'));
process.env['UNDERLINGS_STATE_DIR'] = dir;
process.env['GITLAB_TOKEN'] = 'not-a-real-token';

const { autoReReview } = await import('./rereview.js');
const { startAutoReview } = await import('./live.js');
const { markSeen, setAuto, toggleWatch, watchForReview } = await import('../actions/watch.js');
const { takeChange } = await import('./rereview.js');
const { postOne } = await import('../actions/post.js');
const gitlab = await import('../data/gitlab.js');
const store = await import('../data/store.js');
const { ME, MINUTE, START, context, fakeWorld, mr, note, resetState, thread } = await import('./testkit.js');
const { MAX_RELAUNCHES, SETTLE_MS } = await import('./rereview.js');
type Mr = import('../types.js').Mr;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) =>
  Response.json(String(input).includes('/diffs') ? [] : { id: 'd-1' })) as typeof fetch;

after(() => {
  globalThis.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => resetState());

const KEY = 'acme/engine!621';

function watchedAuto(over: Partial<Mr> = {}): Mr {
  const watched = mr(over);
  toggleWatch(watched);
  setAuto(`${watched.projectPath}!${watched.iid}`, true);
  return watched;
}

async function reReviewWith(mrs: Mr[], fullAuto = '', over: Parameters<typeof context>[2] = {}, world: Parameters<typeof fakeWorld>[0] = {}) {
  const fake = fakeWorld({ mrs, ...world });
  const report = await autoReReview(context(fake.world, fullAuto, over), fake.ports, store.loadState().watches);
  return { report, fake };
}

/** A person answering on a thread you opened, after the baseline was taken. */
const answeredThread = () => [
  thread('d-1', [note(ME, 'Null check?', '2026-01-01T00:00:00Z'), note('heidi', 'Done, see the new commit', new Date(Date.now() + MINUTE).toISOString())]),
];

/** Two polls of the same head with its pipeline done: the first only notes the head. */
async function settledPolls(mrs: Mr[], fullAuto = '', over: Parameters<typeof context>[2] = {}) {
  const first = await reReviewWith(mrs, fullAuto, over);
  assert.deepEqual(first.fake.calls.launched, [], 'a head seen once launches nothing yet');
  return reReviewWith(mrs, fullAuto, over);
}

test('it leaves alone anyone in full auto, and an MR an agent is already on', async () => {
  watchedAuto();
  const moved = [mr({ sha: 'head-2' })];
  assert.deepEqual((await settledPolls(moved, 'heidi:comments')).fake.calls.launched, []);
  assert.deepEqual((await settledPolls(moved, '', { agentOn: () => true })).fake.calls.launched, []);
  assert.equal((await settledPolls(moved)).fake.calls.launched.length, 1, 'and fires once neither holds');
});

test('a new head launches once, on the second poll that sees it, once its pipeline has finished', async () => {
  watchedAuto();
  const running = [mr({ sha: 'head-2', pipeline: 'RUNNING' })];
  for (let poll = 0; poll < 3; poll += 1) {
    assert.deepEqual((await reReviewWith(running)).fake.calls.launched, [], `pipeline still running, poll ${poll}`);
  }
  const passed = [mr({ sha: 'head-2', pipeline: 'SUCCESS' })];
  const fired = await reReviewWith(passed);
  assert.deepEqual(fired.report.reReviewed, [KEY]);
  for (let poll = 0; poll < 3; poll += 1) {
    assert.deepEqual((await reReviewWith(passed)).fake.calls.launched, [], `and once only, poll ${poll}`);
  }
});

test('a pipeline that runs on for half an hour stops holding the head back', async () => {
  watchedAuto();
  const running = [mr({ sha: 'head-2', pipeline: 'RUNNING' })];
  await reReviewWith(running);
  store.mutateState((state) => {
    state.watches[KEY]!.moving = { sha: 'head-2', since: START - SETTLE_MS };
  });
  assert.equal((await reReviewWith(running)).fake.calls.launched.length, 1);
});

test('a second push before the head settles starts the wait again', async () => {
  watchedAuto();
  await reReviewWith([mr({ sha: 'head-2' })]);
  assert.deepEqual((await reReviewWith([mr({ sha: 'head-3' })])).fake.calls.launched, [], 'head-3 is new');
  assert.equal((await reReviewWith([mr({ sha: 'head-3' })])).fake.calls.launched.length, 1, 'one pass for the head that settled');
});

test('the pipeline, an approval or a resolution alone launches nothing, and folds into the next pass', async () => {
  const moves: Partial<Mr>[] = [{ pipeline: 'FAILED' }, { approvedBy: ['alice'] }, { unresolvedThreads: 1 }, { notes: 4 }];
  for (const move of moves) {
    resetState();
    watchedAuto();
    for (let poll = 0; poll < 3; poll += 1) {
      assert.deepEqual((await reReviewWith([mr(move)])).fake.calls.launched, [], JSON.stringify(move));
    }
    assert.equal(store.loadState().watches[KEY]?.seen.sha, 'head-1', 'the baseline is kept for the pass that comes');
  }
});

test('a person\'s new note on a thread you opened launches, once', async () => {
  watchedAuto();
  const noted = [mr({ notes: 4 })];
  const fired = await reReviewWith(noted, '', {}, { threads: answeredThread() });
  assert.deepEqual(fired.report.reReviewed, [KEY]);
  assert.deepEqual((await reReviewWith(noted, '', {}, { threads: answeredThread() })).fake.calls.launched, []);
});

test('a note from a bot, from you, or on a thread someone else opened launches nothing', async () => {
  const cases = [
    [thread('d-1', [note(ME, 'Null check?', '2026-01-01T00:00:00Z'), note('gitlab-bot', 'Pipeline passed', new Date(Date.now() + MINUTE).toISOString(), { bot: true })])],
    [thread('d-1', [note(ME, 'Null check?', '2026-01-01T00:00:00Z'), note(ME, 'Any news?', new Date(Date.now() + MINUTE).toISOString())])],
    [thread('d-1', [note('alice', 'Rename this', '2026-01-01T00:00:00Z'), note('heidi', 'Done', new Date(Date.now() + MINUTE).toISOString())])],
  ];
  for (const threads of cases) {
    resetState();
    watchedAuto();
    assert.deepEqual((await reReviewWith([mr({ notes: 4 })], '', {}, { threads })).fake.calls.launched, []);
  }
});

test('the prompt reads the change since the last review and answers your threads', async () => {
  watchedAuto();
  const fired = await settledPolls([mr({ sha: 'head-2' })]);
  const prompt = fired.fake.calls.launched[0]?.prompt ?? '';
  assert.match(prompt, /^\/underlings:review https:/);
  assert.match(prompt, /The last review saw head-1: read the change since then/);
  assert.match(prompt, new RegExp(`For each unresolved thread opened by ${ME}, queue a reply`));
  assert.match(prompt, /"createdBy":"rereview:head-2"/);
  assert.doesNotMatch(prompt, /finish_review/, 'its items wait for you, as no pass owns them');
});

test('a launch that throws puts the change back, and is tried at most three times on that head', async () => {
  watchedAuto();
  await reReviewWith([mr({ sha: 'head-2' })]);
  let attempts = 0;
  for (let poll = 0; poll < MAX_RELAUNCHES + 2; poll += 1) {
    const fake = fakeWorld({ mrs: [mr({ sha: 'head-2' })], failLaunch: true });
    const launch = fake.ports.launch;
    fake.ports.launch = async (m, prompt) => { attempts += 1; return launch(m, prompt); };
    const report = await autoReReview(context(fake.world, ''), fake.ports, store.loadState().watches);
    if (poll < MAX_RELAUNCHES) assert.deepEqual(report.errors, [`re-review of ${KEY}: the launch failed`], `poll ${poll}`);
  }
  assert.equal(attempts, MAX_RELAUNCHES);
  const watch = store.loadState().watches[KEY];
  assert.equal(watch?.seen.sha, 'head-1', 'the baseline is the one from before');
  assert.deepEqual([watch?.relaunch?.sha, watch?.relaunch?.tries], ['head-2', MAX_RELAUNCHES]);
  await reReviewWith([mr({ sha: 'head-3' })]);
  assert.equal((await reReviewWith([mr({ sha: 'head-3' })])).fake.calls.launched.length, 1, 'a new head is tried again');
  assert.equal(store.loadState().watches[KEY]?.relaunch, undefined, 'and a launch that works clears the count');
});

test('what the engine itself posted never fires it, so an always-on worker cannot loop', async () => {
  watchedAuto();
  const [finding] = store.addToQueue([
    { projectPath: 'acme/engine', projectId: 1001, iid: 621, webUrl: '', severity: 'MINOR', body: 'b', createdBy: 'agent' },
  ]);
  assert.equal((await postOne(finding!)).ok, true);
  await gitlab.replyToDiscussion(1001, 621, 'd-9', 'Fixed, thanks.');
  await gitlab.setDiscussionResolved(1001, 621, 'd-9', true);
  await gitlab.setApproval(1001, 621, true);
  await gitlab.postNote(1001, 621, 'My comments are up, so the hold is off.');
  const afterOwn = mr({ notes: 6, unresolvedThreads: 0, approvedBy: [ME] });
  for (let poll = 0; poll < 5; poll += 1) {
    assert.deepEqual((await reReviewWith([afterOwn])).fake.calls.launched, [], `poll ${poll}`);
  }
  const answered = mr({ notes: 7, unresolvedThreads: 0, approvedBy: [ME] });
  assert.equal((await reReviewWith([answered], '', {}, { threads: answeredThread() })).fake.calls.launched.length, 1, 'the author answering does');
  for (let poll = 0; poll < 5; poll += 1) {
    assert.deepEqual((await reReviewWith([answered], '', {}, { threads: answeredThread() })).fake.calls.launched, [], `and only once, poll ${poll}`);
  }
});

async function postFinding(): Promise<void> {
  const [finding] = store.addToQueue([
    { projectPath: 'acme/engine', projectId: 1001, iid: 621, webUrl: '', severity: 'MINOR', body: 'b', createdBy: 'agent' },
  ]);
  assert.equal((await postOne(finding!)).ok, true);
}

test('a baseline taken from a copy read before the engine\'s own post does not let that post fire it', async () => {
  const baselines: [string, (copy: Mr) => void][] = [
    ['markSeen', (copy) => markSeen([copy])],
    ['watchForReview', (copy) => void watchForReview(copy)],
  ];
  for (const [name, baseline] of baselines) {
    resetState();
    watchedAuto();
    const listed = { ...mr(), readAt: Date.now() };
    await postFinding();
    baseline(listed);
    const ownPost = mr({ notes: 4, unresolvedThreads: 1 });
    assert.deepEqual((await reReviewWith([ownPost])).fake.calls.launched, [], name);
    const answered = mr({ notes: 5, unresolvedThreads: 1 });
    assert.equal((await reReviewWith([answered], '', {}, { threads: answeredThread() })).fake.calls.launched.length, 1, `${name}: the author answering does`);
  }
});

test('the engine\'s own post landing while the fresh read is out fires nothing, then or after', async () => {
  watchedAuto();
  const afterPost = mr({ notes: 4, unresolvedThreads: 1 });
  const fake = fakeWorld({ mrs: [afterPost] });
  let reads = 0;
  fake.ports.freshMr = async () => {
    reads += 1;
    if (reads > 1) return afterPost;
    const readAt = Date.now();
    await postFinding();
    return { ...mr(), readAt };
  };
  for (let poll = 0; poll < 3; poll += 1) {
    await autoReReview(context(fake.world, ''), fake.ports, store.loadState().watches);
  }
  assert.deepEqual(fake.calls.launched, []);
});

test('a copy read before the latest baseline cannot say the MR moved since it', () => {
  watchedAuto();
  const readBefore = Date.now() - 1_000;
  watchForReview({ ...mr({ sha: 'head-2' }), readAt: Date.now() });
  assert.equal(takeChange({ ...mr({ sha: 'head-1' }), readAt: readBefore }), null);
  assert.equal(store.loadState().watches[KEY]?.seen.sha, 'head-2', 'and the newer baseline stays');
});

test('the baseline is written before the launch, so a second call during the launch fires nothing', async () => {
  watchedAuto();
  const moved = mr({ sha: 'head-2' });
  await reReviewWith([moved]);
  const fake = fakeWorld({ mrs: [moved] });
  const finishes: (() => void)[] = [];
  const baselineAtLaunch: (string | null | undefined)[] = [];
  fake.ports.launch = async () => {
    baselineAtLaunch.push(store.loadState().watches[KEY]?.seen.sha);
    await new Promise<void>((resolve) => finishes.push(resolve));
  };
  const first = autoReReview(context(fake.world, ''), fake.ports, store.loadState().watches);
  await new Promise((resolve) => setImmediate(resolve));
  const second = autoReReview(context(fake.world, ''), fake.ports, store.loadState().watches);
  await new Promise((resolve) => setImmediate(resolve));
  for (const finish of finishes) finish();
  await Promise.all([first, second]);
  assert.deepEqual(baselineAtLaunch, ['head-2'], 'one launch, with the new baseline already on disk');
});

test('paused, it launches nothing, and fires once resumed', async () => {
  watchedAuto();
  const moved = [mr({ sha: 'head-2' })];
  await reReviewWith(moved);
  const fake = fakeWorld({ mrs: moved, paused: true });
  await autoReReview(context(fake.world, ''), fake.ports, store.loadState().watches);
  assert.deepEqual(fake.calls.launched, []);
  fake.world.paused = false;
  await autoReReview(context(fake.world, ''), fake.ports, store.loadState().watches);
  assert.equal(fake.calls.launched.length, 1);
});

test('a failed launch is journalled in Review runs', async () => {
  watchedAuto();
  await reReviewWith([mr({ sha: 'head-2' })]);
  const fake = fakeWorld({ mrs: [mr({ sha: 'head-2' })] });
  fake.ports.launch = (m, prompt) => startAutoReview(m, prompt, async () => { throw new Error('no Orca'); });
  const report = await autoReReview(context(fake.world, ''), fake.ports, store.loadState().watches);
  assert.deepEqual(report.errors, [`re-review of ${KEY}: no Orca`]);
  assert.equal(store.loadRuns()[KEY]?.status, 'launch failed');
});

test('at most two per call', async () => {
  for (const iid of [1, 2, 3]) watchedAuto({ iid });
  const moved = [1, 2, 3].map((iid) => mr({ iid, sha: 'head-2' }));
  await reReviewWith(moved);
  const first = await reReviewWith(moved);
  assert.deepEqual(first.report.reReviewed, ['acme/engine!1', 'acme/engine!2']);
  const second = await reReviewWith(moved);
  assert.deepEqual(second.report.reReviewed, ['acme/engine!3']);
});

test('a re-review launches under the list\'s label, so gc and clean-up find its workspace', async () => {
  watchedAuto();
  await reReviewWith([mr({ sha: 'head-2' })]);
  const fake = fakeWorld({ mrs: [mr({ sha: 'head-2' })] });
  fake.ports.freshMr = async () => mr({ sha: 'head-2', repoLabel: 'relay' });
  await autoReReview(context(fake.world, ''), fake.ports, store.loadState().watches);
  assert.deepEqual(fake.calls.launched.map((l) => l.mr.repoLabel), ['Engine']);
});
