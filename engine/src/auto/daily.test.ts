import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'thematrix-daily-'));
process.env['UNDERLINGS_STATE_DIR'] = dir;
process.env['GITLAB_TOKEN'] = 'not-a-real-token';

const { DAY_MS, moveAutomation, scheduleReReview, toggleWatch, unscheduleReReview } = await import('../actions/watch.js');
const { backgroundPoll, fencedPorts } = await import('./driver.js');
const { dailyReReviews } = await import('./daily.js');
const { builtInReview } = await import('../agentprompts.js');
const store = await import('../data/store.js');
const { MINUTE, START, context, fakeWorld, mr, resetState } = await import('./testkit.js');
type Mr = import('../types.js').Mr;

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => resetState());

const KEY = 'acme/engine!621';
const watches = () => store.loadState().watches;

function scheduled(over: Partial<Mr> = {}): Mr {
  const watched = mr(over);
  toggleWatch(watched);
  scheduleReReview(watched, START);
  return watched;
}

async function lookAt(mrs: Mr[], clock: number, over: Parameters<typeof context>[2] = {}) {
  const fake = fakeWorld({ mrs, clock });
  const report = await dailyReReviews(context(fake.world, '', over), fake.ports, watches());
  return { report, fake };
}

test('scheduling keeps the slot on the watch in the state folder, a day out', () => {
  scheduled();
  assert.deepEqual(watches()[KEY]?.daily, { nextAt: new Date(START + DAY_MS).toISOString() });
  unscheduleReReview(KEY);
  assert.equal(watches()[KEY]?.daily, undefined);
});

test('nothing launches before the day is up, and once it is an MR that has not moved is looked at and left', async () => {
  const unmoved = scheduled();
  assert.deepEqual((await lookAt([unmoved], START + DAY_MS - MINUTE)).fake.calls.launched, []);
  const { fake, report } = await lookAt([unmoved], START + DAY_MS);
  assert.deepEqual([fake.calls.launched, report.reReviewed], [[], []]);
  assert.equal(watches()[KEY]?.daily?.nextAt, new Date(START + 2 * DAY_MS).toISOString(), 'the day was used');
});

test('an MR that moved since it was last seen gets the review command, once, and its baseline moves on', async () => {
  scheduled();
  const moved = mr({ sha: 'head-2' });
  const { fake, report } = await lookAt([moved], START + DAY_MS);
  assert.deepEqual(fake.calls.launched.map((l) => l.prompt), [builtInReview('https://gitlab.example/acme/engine/-/merge_requests/621')]);
  assert.deepEqual(report.reReviewed, [KEY]);
  assert.equal(watches()[KEY]?.seen.sha, 'head-2');
  assert.deepEqual((await lookAt([moved], START + DAY_MS + MINUTE)).fake.calls.launched, [], 'the same day does not fire twice');
});

test('it waits while an agent is on the MR, and leaves anyone in full auto to full auto', async () => {
  scheduled();
  const moved = mr({ sha: 'head-2' });
  assert.deepEqual((await lookAt([moved], START + DAY_MS, { agentOn: () => true })).fake.calls.launched, []);
  const fake = fakeWorld({ mrs: [moved], clock: START + DAY_MS });
  await dailyReReviews(context(fake.world, 'heidi:shadow'), fake.ports, watches());
  assert.deepEqual(fake.calls.launched, []);
  assert.equal(watches()[KEY]?.daily?.nextAt, new Date(START + DAY_MS).toISOString(), 'the day is still due');
});

test('a launch that fails keeps the change for next time and says why', async () => {
  scheduled();
  const moved = mr({ sha: 'head-2' });
  const fake = fakeWorld({ mrs: [moved], clock: START + DAY_MS, failLaunch: true });
  const report = await dailyReReviews(context(fake.world, ''), fake.ports, watches());
  assert.deepEqual(report.errors, [`daily re-review of ${KEY}: the launch failed`]);
  assert.equal(watches()[KEY]?.seen.sha, 'head-1');
  assert.equal(watches()[KEY]?.relaunch?.error, 'the launch failed');
});

test('whichever front end holds the full auto turn fires it from its poll, and one that does not hold it fires nothing', async () => {
  scheduled();
  const moved = mr({ sha: 'head-2' });
  const fake = fakeWorld({ mrs: [moved], clock: START + DAY_MS });
  const input = { mrs: [moved], me: 'frank', terminals: [], claimBy: 'auto:t' };
  assert.deepEqual((await backgroundPoll(input, fencedPorts(() => false, fake.ports))).reReviewed, []);
  const report = await backgroundPoll(input, fencedPorts(() => true, fake.ports));
  assert.deepEqual([report.reReviewed, fake.calls.launched.length], [[KEY], 1]);
});

test('an Orca automation an older build scheduled moves onto the schedule, and the move names it so it can be deleted in Orca', () => {
  scheduled();
  unscheduleReReview(KEY);
  store.mutateState((state) => {
    state.watches[KEY]!.automation = 're-review Engine!621';
  });
  assert.equal(moveAutomation(KEY, START), 're-review Engine!621');
  assert.equal(watches()[KEY]?.automation, undefined);
  assert.equal(watches()[KEY]?.daily?.nextAt, new Date(START + DAY_MS).toISOString());
  assert.throws(() => moveAutomation(KEY), /has no daily re-review in Orca/);
});
