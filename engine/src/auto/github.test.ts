import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'underlings-auto-github-'));
process.env['UNDERLINGS_STATE_DIR'] = dir;

const { launchPasses, settlePasses } = await import('./passes.js');
const { sendDue } = await import('./send.js');
const { levelForMr, peopleRules } = await import('./people.js');
const { approvalBlockers } = await import('./gates.js');
const store = await import('../data/store.js');
const { MINUTE, START, context, fakeWorld, mr, resetState } = await import('./testkit.js');

after(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => resetState());

const ACCOUNTS = { gitlab: 'frank', github: 'frank-gh' };
const path = 'acme-co/web';
const PR = mr({ provider: 'github', projectPath: path, projectId: 501, repoLabel: 'Web', iid: 12, author: 'ivan', reviewers: ['frank-gh'], webUrl: 'https://github.com/acme-co/web/pull/12' });
const PR_KEY = 'acme-co/web#12';

test('full auto takes a pull request that asks for your GitHub login, as it does a merge request that asks for your GitLab name', async () => {
  const fake = fakeWorld({ mrs: [mr(), PR, { ...PR, iid: 13, author: 'judy', reviewers: ['frank'] }] });
  const report = await launchPasses(context(fake.world, 'heidi:verdict, ivan:comments, judy:comments', { accounts: ACCOUNTS }), fake.ports);
  assert.deepEqual(report.launched, ['acme/engine!621', PR_KEY]);
  const prompt = fake.calls.launched[1]!.prompt;
  assert.ok(prompt.startsWith('/underlings:review https://github.com/acme-co/web/pull/12 Unattended full-auto pass'));
  assert.ok(prompt.includes('opened by frank-gh') && prompt.includes('"provider":"github"'), prompt);
});

test('with no GitHub login known, a pull request is never taken for one asking your GitLab name', async () => {
  const fake = fakeWorld({ mrs: [{ ...PR, reviewers: ['frank'] }] });
  assert.deepEqual((await launchPasses(context(fake.world, 'ivan:comments'), fake.ports)).launched, []);
  assert.equal(levelForMr(PR, 'frank-gh', peopleRules('*:shadow')), 'shadow', 'and one that asks you is reviewed on request');
});

test('a finished pass on a pull request queues its verdict as GitHub\'s, and full auto sends it by your GitHub login', async () => {
  const launchedAt = new Date(START - 10 * MINUTE).toISOString();
  store.updateAutoMemory(PR_KEY, (m) => ({ ...m, pass: { id: 'p1', key: PR_KEY, author: 'ivan', sha: 'head-1', trigger: 'new', launchedAt, doneAt: launchedAt } }));
  const fake = fakeWorld({ mrs: [PR] });
  const ctx = context(fake.world, 'ivan:verdict', { accounts: ACCOUNTS });
  await settlePasses(ctx, fake.ports);
  const [verdict] = store.loadQueue();
  assert.deepEqual([verdict!.provider, verdict!.kind, verdict!.verdict], ['github', 'verdict', 'approve']);
  fake.world.clock = START + 60 * MINUTE;
  assert.equal((await sendDue(ctx, fake.ports)).sent, 1);
  assert.deepEqual(fake.calls.posted.map((p) => p.item.id), [verdict!.id]);
});

test('an approval gate on a pull request names GitHub as the one that did not return the whole diff', () => {
  const facts = { mr: PR, me: 'frank-gh', passSha: 'head-1', blocking: false, threads: [], diff: { paths: [], changedLines: 1, complete: false }, heldByHand: false, handedBack: 0 };
  assert.deepEqual(approvalBlockers(facts, { maxDiffLines: 400, sensitive: [] }), ['GitHub did not return the whole diff']);
});
