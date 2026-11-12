import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { githubHarness } from './fixtures/github/harness.mjs';

const h = githubHarness();
process.env['GITHUB_TOKEN'] = 'ghp_0123456789abcdefghijklmnopqrstuv';

const { changeSettings } = await import('./data/store.js');
const { forgeOf, needs } = await import('./data/forge.js');
const { githubForge } = await import('./data/github-forge.js');
const { gitlabForge } = await import('./data/gitlab-forge.js');
const { levelForMr, peopleRules } = await import('./auto/people.js');
const { mr } = await import('./auto/testkit.js');
const { DEFAULT_GITHUB } = await import('./settings.js');
const { resetGithubLimits, forgetGithubToken } = await import('./data/github.js');

const WEB = 'acme-co/web';
const REF = { provider: 'github' as const, projectPath: WEB, projectId: 501, iid: 12 };

after(() => h.done());
beforeEach(() => {
  h.fake.requests.length = 0;
  resetGithubLimits();
  forgetGithubToken();
  changeSettings((s) => ({ ...s, github: { ...DEFAULT_GITHUB, on: true } }));
});

test('GitHub can do none of what it cannot yet, and says so by flag: no hold, no taking an approval back, no log for another app\'s check', () => {
  assert.deepEqual(githubForge.caps, {
    hold: false, withdrawApproval: false, rebase: false, autoMerge: false, jobLogs: 'actions', retry: false, todos: false, generalThreads: false, post: false, agents: false, ownMr: false,
  });
  assert.throws(() => needs(githubForge, 'hold', 'hold a merge'), { message: 'GitHub has no way to hold a merge' });
  assert.throws(() => needs(githubForge, 'post', 'send anything to it from here yet'), /^Error: GitHub has no way to send anything/);
  assert.doesNotThrow(() => needs(githubForge, 'jobLogs', 'read a log'));
});

test('a flag GitLab leaves out is one it can do, so the flags it always had read as they did', () => {
  for (const cap of ['post', 'agents', 'ownMr', 'generalThreads'] as const) {
    assert.equal(gitlabForge.caps[cap], undefined);
    assert.doesNotThrow(() => needs(gitlabForge, cap, 'do it'));
  }
});

test('every write GitHub cannot yet do says it comes in a later version, and asks GitHub nothing', async () => {
  const forge = forgeOf(REF);
  const tries = [
    forge.postFinding({ id: 'q1' } as never, 'single' as never), forge.reply(REF, 'PRRT_1', 'ok'), forge.resolve(REF, 'PRRT_1', true), forge.note(REF, 'hi'), forge.approve(REF, true),
    forge.hold(REF, true), forge.merge(REF, { sha: 'a', whenGreen: false } as never), forge.cancelAutoMerge(REF), forge.rebase(REF), forge.rebaseState(REF), forge.ready(REF),
    forge.setReviewers(REF, ['trent']), forge.rerequest(REF, 'trent'), forge.retryJob(REF, 7001), forge.retryChecks(REF, 9001),
  ];
  const settled = await Promise.allSettled(tries);
  assert.equal(settled.length, 15);
  for (const result of settled) {
    assert.equal(result.status, 'rejected');
    assert.match(String((result as PromiseRejectedResult).reason.message), /^GitHub: .+ from here comes in a later version\. Do it on GitHub for now$/);
  }
  assert.equal(h.fake.count(), 0);
});

test('the reads for activity, to-dos and boards answer nothing for GitHub, without asking it', async () => {
  const forge = forgeOf(REF);
  assert.deepEqual(await Promise.all([forge.todos(), forge.myEvents('a', 'b'), forge.myMrs('opened'), forge.mergedIn('x', 'a'), forge.mergedMentioning('ABC-1', ['x']), forge.mergedBy('x', 'a'), forge.reviewedBy('x', 'a'), forge.boardMrs([], 'a')]), [[], [], [], [], [], [], [], []]);
  assert.deepEqual(await forge.boardComments({} as never, 'a'), { events: [], complete: true });
  assert.equal(h.fake.count(), 0);
});

test('who you are on GitHub is the login and the name the token belongs to', async () => {
  assert.equal(await forgeOf(REF).me(), 'frank-gh');
  assert.equal(await githubForge.myName?.(), 'Frank Foster');
});

test('full auto never takes a GitHub pull request, whoever wrote it and whatever the default row says', () => {
  const rules = peopleRules('*:shadow, ivan:comments');
  assert.equal(levelForMr(mr({ author: 'ivan' }), 'frank', rules), 'comments');
  assert.equal(levelForMr(mr({ author: 'judy' }), 'frank', rules), 'shadow');
  assert.equal(levelForMr({ ...mr({ author: 'ivan' }), provider: 'github' }, 'frank', rules), null);
  assert.equal(levelForMr({ ...mr({ author: 'judy' }), provider: 'github' }, 'frank', rules), null);
});

test('a watched GitHub pull request remembers it is one, so whether it has closed is asked of GitHub, and a GitLab watch is stored as it was', async () => {
  const { toggleWatch } = await import('./actions/watch.js');
  const { hasClosed } = await import('./watching.js');
  const { loadState } = await import('./data/store.js');
  toggleWatch({ ...mr({ projectPath: WEB, iid: 12 }), provider: 'github' });
  toggleWatch(mr({ projectPath: 'acme/engine', iid: 7 }));
  const { watches } = loadState();
  assert.equal(watches['acme-co/web#12']?.provider, 'github');
  assert.equal('provider' in watches['acme/engine!7']!, false);
  assert.equal(await hasClosed(watches['acme-co/web#12']!), false);
  Object.assign(h.world.prs.find((p: { number: number }) => p.number === 12), { state: 'MERGED', mergedBy: 'ivan' });
  assert.equal(await hasClosed(watches['acme-co/web#12']!), true);
  assert.deepEqual(h.fake.requests.map((r) => r.op), ['PrEnd', 'PrEnd']);
});
