import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { githubHarness } from './fixtures/github/harness.mjs';
import { githubWorld } from './fixtures/github/world.mjs';

const h = githubHarness();
process.env['GITHUB_TOKEN'] = 'ghp_0123456789abcdefghijklmnopqrstuv';

const { changeSettings } = await import('./data/store.js');
const { forgeOf } = await import('./data/forge.js');
const { resetGithubLimits, forgetGithubToken } = await import('./data/github.js');
const prs = await import('./data/github-prs.js');
const { TOO_BIG } = await import('./data/shared.js');

const github = (over: Record<string, unknown> = {}) => changeSettings((s) => ({ ...s, github: { on: true, scope: 'involved', repos: '', host: '', ...over } as never }));
const forge = () => forgeOf({ provider: 'github' });
const ref = (path: string, iid: number) => ({ provider: 'github' as const, projectPath: path, projectId: 501, iid });
const WEB12 = ref('acme-co/web', 12);
const HEAD = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0';

after(() => h.done());
beforeEach(() => {
  Object.assign(h.world, githubWorld());
  h.fake.requests.length = 0;
  resetGithubLimits();
  forgetGithubToken();
  github();
});

const keys = (mrs: { projectPath: string; iid: number }[]) => mrs.map((m) => `${m.projectPath}#${m.iid}`);

test('the involved search is one query of four searches, each for open, unarchived pull requests that involve you', async () => {
  const { mrs } = await forge().listOpen([]);
  assert.equal(h.fake.asked('Involved').length, 1);
  assert.equal(h.fake.requests.length, 1);
  const vars = (h.fake.asked('Involved')[0]!.body as { variables: Record<string, string> }).variables;
  assert.deepEqual(Object.keys(vars), ['requested', 'authored', 'assigned', 'mentioned']);
  for (const [name, term] of [['requested', 'review-requested:@me'], ['authored', 'author:@me'], ['assigned', 'assignee:@me'], ['mentioned', 'mentions:@me']] as const) {
    assert.match(vars[name]!, /^is:pr is:open archived:false /);
    assert.ok(vars[name]!.endsWith(term), vars[name]);
  }
  assert.deepEqual(keys(mrs).sort(), ['acme-co/engine#7', 'acme-co/web#12', 'acme-co/web#15', 'acme-co/web#18', 'octo/api#21', 'octo/web#3']);
});

test('a pull request found by two searches is listed once, and a request made of your team still names you as a reviewer', async () => {
  const web18 = h.world.prs.find((p: { number: number }) => p.number === 18);
  Object.assign(web18, { requestedViaTeam: true, assignees: ['frank-gh'] });
  const { mrs } = await forge().listOpen([]);
  assert.equal(keys(mrs).filter((k) => k === 'acme-co/web#18').length, 1);
  const found = mrs.find((m) => m.iid === 18)!;
  assert.deepEqual(found.reviewers, ['frank-gh']);
  assert.deepEqual(found.reviewStates, { 'frank-gh': 'UNREVIEWED' });
  assert.equal(mrs.find((m) => m.iid === 15)!.reviewers.includes('frank-gh'), false);
});

test('each pull request carries what the app reads off a merge request, in GitHub terms and the app\'s codes', async () => {
  const { mrs } = await forge().listOpen([]);
  const asked = mrs.find((m) => m.iid === 12)!;
  assert.equal(asked.provider, 'github');
  assert.deepEqual(
    [asked.projectPath, asked.projectId, asked.author, asked.title, asked.webUrl, asked.sourceBranch, asked.sha, asked.draft, asked.conflicts],
    ['acme-co/web', 501, 'ivan', 'Cache the token lookup', 'https://github.com/acme-co/web/pull/12', 'ivan/cache-lookup', HEAD, false, false],
  );
  assert.deepEqual([asked.mergeStatus, asked.pipeline, asked.pipelineId, asked.unresolvedThreads, asked.notes, asked.state, asked.autoMerge], ['NOT_APPROVED', 'SUCCESS', 9001, 1, 4, 'opened', false]);
  assert.deepEqual(asked.reviewers, ['frank-gh', 'trent']);
  assert.deepEqual(asked.reviewStates, { 'frank-gh': 'UNREVIEWED', trent: 'REVIEWED' });
  const mine = mrs.find((m) => m.iid === 15)!;
  assert.deepEqual([mine.mergeStatus, mine.pipeline, mine.approvedBy, mine.reviewStates], ['CI_MUST_PASS', 'FAILED', ['ivan'], { ivan: 'APPROVED' }]);
  assert.deepEqual(mrs.filter((m) => m.conflicts).map((m) => m.iid), [21]);
  assert.deepEqual(mrs.filter((m) => m.draft).map((m) => [m.iid, m.mergeStatus]), [[7, 'DRAFT_STATUS']]);
  assert.equal(mrs.find((m) => m.iid === 18)!.mergeStatus, 'CHECKING');
  assert.equal(mrs.find((m) => m.iid === 3)!.mergeStatus, 'REQUESTED_CHANGES');
});

test('repos named alike under two owners, or by a GitLab project, get labels that tell them apart', async () => {
  const { mrs } = await forge().listOpen([]);
  const label = (iid: number, path: string) => mrs.find((m) => m.iid === iid && m.projectPath === path)!.repoLabel;
  assert.notEqual(label(12, 'acme-co/web'), label(3, 'octo/web'));
  assert.deepEqual([label(12, 'acme-co/web'), label(3, 'octo/web'), label(21, 'octo/api'), label(7, 'acme-co/engine')], ['Co Web', 'Octo Web', 'Api', 'Engine']);
  assert.equal(new Set(mrs.map((m) => m.repoLabel)).size, new Set(mrs.map((m) => m.projectPath)).size);
});

test('the repos setting keeps what it names and drops what it excludes, over owner/repo', async () => {
  github({ repos: 'acme-co/*, !acme-co/engine' });
  assert.deepEqual(keys((await forge().listOpen([])).mrs).sort(), ['acme-co/web#12', 'acme-co/web#15', 'acme-co/web#18']);
  github({ repos: '!octo/*' });
  assert.deepEqual(keys((await forge().listOpen([])).mrs).sort(), ['acme-co/engine#7', 'acme-co/web#12', 'acme-co/web#15', 'acme-co/web#18']);
});

test('the organisations scope finds the repos pushed to in the last 90 days that have open pull requests, a page at a time', async () => {
  h.world.pageSize = 1;
  const found = await forge().discoverRepos();
  assert.deepEqual(found.map((r) => [r.path, r.openCount]), []);
  github({ scope: 'orgs' });
  assert.deepEqual((await forge().discoverRepos()).map((r) => [r.path, r.openCount]), [['acme-co/web', 3], ['acme-co/engine', 1]]);
  assert.deepEqual(h.fake.asked('OwnerRepos').map((r) => (r.body as { variables: { login: string; cursor: string | null } }).variables), [
    { login: 'frank-gh', cursor: null }, { login: 'acme-co', cursor: null }, { login: 'acme-co', cursor: '1' },
  ]);
});

test('open pull requests are read ten repos to a query, and the searches still run beside them', async () => {
  github({ scope: 'orgs' });
  const repos = ['acme-co/web', 'acme-co/engine', ...Array.from({ length: 10 }, (_, n) => `acme-co/gone-${n}`)].map((path) => ({ path, label: path, openCount: 3 }));
  const { mrs, missed, errors } = await forge().listOpen(repos);
  assert.equal(h.fake.asked('RepoPrs').length, 2);
  assert.equal(h.fake.asked('Involved').length, 1);
  const first = (h.fake.asked('RepoPrs')[0]!.body as { variables: Record<string, string> }).variables;
  assert.deepEqual([first['o0'], first['n0'], first['o9'], first['n9']], ['acme-co', 'web', 'acme-co', 'gone-7']);
  assert.deepEqual([missed, errors], [[], []]);
  assert.deepEqual(keys(mrs).sort(), ['acme-co/engine#7', 'acme-co/web#12', 'acme-co/web#15', 'acme-co/web#18', 'octo/api#21', 'octo/web#3']);
});

test('one repo batch failing is named in the answer, and the rest of the list still comes', async () => {
  github({ scope: 'orgs' });
  h.fake.inject({ op: 'RepoPrs' }, { status: 502, body: { message: 'Bad Gateway' } }, { status: 502 }, { status: 502 }, { status: 502 });
  const { mrs, missed, errors } = await forge().listOpen([{ path: 'acme-co/web', label: 'Co Web' }]);
  assert.deepEqual(missed, ['acme-co/web']);
  assert.match(errors[0]!, /GitHub 502/);
  assert.ok(mrs.length > 0);
});

test('one pull request, its end state, detail and branch come from their own small queries', async () => {
  const one = (await forge().one(WEB12))!;
  assert.deepEqual([one.iid, one.mergeStatus, one.sha], [12, 'NOT_APPROVED', HEAD]);
  assert.equal(await forge().one(ref('acme-co/web', 999)), null);
  assert.equal(await forge().one(ref('nobody/nothing', 1)), null);
  assert.deepEqual(await forge().end(WEB12), { state: 'opened', mergedBy: null });
  assert.equal(await forge().state(WEB12), 'opened');
  Object.assign(h.world.prs.find((p: { number: number }) => p.number === 15), { state: 'MERGED', mergedBy: 'ivan' });
  assert.deepEqual(await forge().end(ref('acme-co/web', 15)), { state: 'merged', mergedBy: 'ivan' });
  assert.deepEqual(await forge().detail(WEB12), { description: 'Adds a cache in front of `lookup`.\n\nCloses acme-co/web#9. See also acme-co/engine#7.', detailedMergeStatus: null, targetBranch: 'main', changesCount: '3', userNotesCount: 3 });
  assert.deepEqual(await forge().branchFacts(WEB12), { targetBranch: 'main', behind: 3 });
});

test('line threads, the words of a review and the conversation read as discussions, oldest first, and only threads can be resolved', async () => {
  const found = await forge().discussions(WEB12);
  assert.deepEqual(found.map((d) => [d.id, d.resolvable, d.resolved, d.notes.length]), [['review-301', false, true, 1], ['PRRT_kwDOAA', true, false, 2], ['comment-501', false, true, 1]]);
  const thread = found[1]!;
  assert.deepEqual(thread.position, { new_path: 'src/token.ts', old_path: 'src/token.ts', new_line: 12, head_sha: HEAD });
  assert.deepEqual(thread.notes.map((n) => [n.id, n.author, n.system]), [[401, 'trent', false], [402, 'ivan', false]]);
  const state = await forge().threadState(WEB12, 'trent', HEAD);
  assert.deepEqual([state.mine, state.unresolved, state.awaitingYou], [2, 1, 1]);
  assert.deepEqual((await forge().threadState(WEB12, 'ivan', HEAD)).awaitingYou, 0);
  assert.equal((await forge().threadState(WEB12, 'someone-else', HEAD)).mine, 0);
});

test('a comment from a bot is marked as one, by its type or its [bot] name', async () => {
  Object.assign(h.world.prs.find((p: { number: number }) => p.number === 12), { comments: [{ id: 601, author: 'github-actions[bot]', body: 'Coverage 91%', createdAt: '2026-11-10T07:00:00Z' }] });
  const found = await forge().discussions(WEB12);
  assert.equal(found.find((d) => d.id === 'comment-601')!.notes[0]!.bot, true);
  assert.equal(found.find((d) => d.id === 'PRRT_kwDOAA')!.notes[0]!.bot, undefined);
});

test('the changed files come with their patches, and a file GitHub left the patch out of is too large to show', async () => {
  const { files, complete } = await forge().files(WEB12);
  assert.equal(complete, true);
  assert.deepEqual(files.map((f) => [f.newPath, f.tooLarge, f.diff === '']), [['src/token.ts', false, false], ['src/cache.ts', false, false], ['dist/bundle.js', true, true]]);
  assert.deepEqual(h.fake.requests.map((r) => r.path + r.search), ['/repos/acme-co/web/pulls/12/files?per_page=100&page=1']);
});

test('a pull request of 3,000 files is listed as incomplete', async () => {
  const web12 = h.world.prs.find((p: { number: number }) => p.number === 12);
  web12.files = Array.from({ length: 3000 }, (_, n) => ({ filename: `src/f${n}.ts`, patch: '@@ -1 +1 @@\n-a\n+b' }));
  const { files, complete } = await forge().files(WEB12);
  assert.deepEqual([files.length, complete, h.fake.requests.length], [3000, false, 30]);
});

test('checks come as jobs: Actions runs with their workflow, other apps and commit statuses without a log', async () => {
  const jobs = (await forge().checks(WEB12, HEAD)) as { id: number; name: string; status: string; stage: string; pipelineId: number; allowFailure: boolean; logs: boolean; webUrl: string | null; duration: number | null }[];
  assert.deepEqual(jobs.map((j) => [j.name, j.status, j.stage, j.pipelineId, j.allowFailure, j.logs]), [
    ['build', 'success', 'CI', 9001, false, true], ['test', 'success', 'CI', 9001, false, true], ['Vercel', 'skipped', 'Vercel', 0, true, false], ['ci/license', 'success', 'license-bot', 0, true, false],
  ]);
  assert.equal(jobs[0]!.duration, 360);
  assert.equal(jobs[2]!.webUrl, 'https://vercel.com/acme-co/web/abc');
  assert.ok(jobs[3]!.id < 0, 'a commit status takes a number no check run can have');
  assert.deepEqual(await forge().checks(WEB12, 'ffff'.repeat(10)), []);
});

test("an Actions job's log is its tail without timestamps, colours or fold markers, and another app's has none", async () => {
  assert.deepEqual(await forge().jobLog(WEB12, 7002, 3), { lines: ['npm test', '42 passing', 'Error: Process completed with exit code 1.'], total: 4 });
  await assert.rejects(forge().jobLog(WEB12, 7003, 50), /GitHub has no log for job 7003/);
});

test('a file is read at a ref, and a file longer than asked for is TOO_BIG, a missing one null', async () => {
  const text = await forge().file(WEB12, 'src/token.ts', HEAD, 10_000);
  assert.match(String(text), /^\/\/ line 1\n[\s\S]*export function lookup\(id\) \{\n  const hit/);
  assert.equal(await forge().file(WEB12, 'src/token.ts', HEAD, 10), TOO_BIG);
  assert.equal(await forge().file(WEB12, 'src/missing.ts', HEAD, 10_000), null);
  assert.equal(h.fake.requests.at(-1)!.path, '/repos/acme-co/web/contents/src/missing.ts');
});

test('what changed between two heads is the commits and the paths, read from the compare', async () => {
  h.world.compares['acme-co/web:aaa...bbb'] = { status: 'ahead', ahead_by: 2, behind_by: 0, total_commits: 2, files: [{ filename: 'src/a.ts' }, { filename: 'src/new.ts', previous_filename: 'src/old.ts' }] };
  assert.deepEqual(await forge().since(WEB12, 'aaa', 'bbb'), { commits: 2, paths: ['src/a.ts', 'src/old.ts', 'src/new.ts'] });
});

test('every read says GitHub in its words when it fails, and a pull request that is gone reads as missing', async () => {
  await assert.rejects(forge().detail(ref('acme-co/web', 999)), { message: 'GitHub has no acme-co/web#999' });
  assert.deepEqual(await forge().discussions(ref('acme-co/web', 999)), []);
  assert.deepEqual(await forge().branchFacts(ref('acme-co/web', 999)), { targetBranch: null, behind: null });
});

const rolled = (state: string | null) => ({ state: 'OPEN' as const, isDraft: false, mergeable: 'MERGEABLE' as const, mergeStateStatus: 'BLOCKED', reviewDecision: null, rollup: state });

test("GitHub's merge state becomes the codes GitLab's detailed merge status uses, checked in the order that decides them", () => {
  const code = (over: Record<string, unknown>) => prs.mergeCode({ ...rolled('SUCCESS'), mergeStateStatus: 'CLEAN', ...over } as never);
  assert.deepEqual([
    code({ state: 'MERGED' }), code({ state: 'CLOSED' }),
    code({ isDraft: true, mergeable: 'CONFLICTING' }),
    code({ mergeable: 'CONFLICTING' }), code({ mergeStateStatus: 'DIRTY' }),
    code({ mergeStateStatus: 'BEHIND', reviewDecision: 'CHANGES_REQUESTED' }),
    code({ reviewDecision: 'CHANGES_REQUESTED', mergeStateStatus: 'BLOCKED' }),
    code({ mergeStateStatus: 'BLOCKED', rollup: 'PENDING' }), code({ mergeStateStatus: 'BLOCKED', rollup: 'EXPECTED' }),
    code({ mergeStateStatus: 'BLOCKED', rollup: 'FAILURE' }), code({ mergeStateStatus: 'BLOCKED', rollup: 'ERROR' }),
    code({ mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED' }),
    code({ mergeStateStatus: 'BLOCKED' }),
    code({ mergeStateStatus: 'UNKNOWN', mergeable: 'UNKNOWN' }), code({ mergeStateStatus: null }),
    code({}), code({ mergeStateStatus: 'HAS_HOOKS' }), code({ mergeStateStatus: 'UNSTABLE' }),
  ], [
    'NOT_OPEN', 'NOT_OPEN', 'DRAFT_STATUS', 'CONFLICT', 'CONFLICT', 'NEED_REBASE', 'REQUESTED_CHANGES', 'CI_STILL_RUNNING', 'CI_STILL_RUNNING', 'CI_MUST_PASS', 'CI_MUST_PASS',
    'NOT_APPROVED', 'BRANCH_RULES', 'CHECKING', 'CHECKING', 'MERGEABLE', 'MERGEABLE', 'MERGEABLE',
  ]);
});

test('the check rollup, a check run and a commit status each become the pipeline and job codes the app shows', () => {
  assert.deepEqual(['SUCCESS', 'FAILURE', 'ERROR', 'PENDING', 'EXPECTED', null, 'WHAT'].map((s) => prs.pipelineOf(s)), ['SUCCESS', 'FAILED', 'FAILED', 'RUNNING', 'PENDING', null, null]);
  const status = (run: { status: string; conclusion: string | null }) => prs.jobStatusOf(run);
  assert.deepEqual(['QUEUED', 'WAITING', 'PENDING', 'REQUESTED', 'IN_PROGRESS'].map((s) => status({ status: s, conclusion: null })), ['pending', 'pending', 'pending', 'pending', 'running']);
  assert.deepEqual(['SUCCESS', 'FAILURE', 'TIMED_OUT', 'STARTUP_FAILURE', 'CANCELLED', 'SKIPPED', 'NEUTRAL', 'STALE', 'ACTION_REQUIRED', null].map((c) => status({ status: 'COMPLETED', conclusion: c })), [
    'success', 'failed', 'failed', 'failed', 'canceled', 'skipped', 'skipped', 'skipped', 'manual', 'failed',
  ]);
  const commit = (state: string) => prs.jobOf({ __typename: 'StatusContext', id: 'SC_1', context: 'ci/x', state, targetUrl: null, createdAt: '', isRequired: true, creator: null }).status;
  assert.deepEqual(['SUCCESS', 'FAILURE', 'ERROR', 'PENDING', 'EXPECTED'].map(commit), ['success', 'failed', 'failed', 'pending', 'pending']);
});

test('reviews become the states GitLab reviewers have: an approval or a change request outlasts a comment, and a request made again reads as not yet given', () => {
  const review = (state: string, login: string) => ({ state, author: { login } });
  const base = { latestReviews: { nodes: [] as ReturnType<typeof review>[] }, latestOpinionatedReviews: { nodes: [] as ReturnType<typeof review>[] }, reviewRequests: { nodes: [] as { requestedReviewer: { __typename: string; login?: string } | null }[] } };
  const states = prs.reviewStatesOf({
    ...base,
    latestReviews: { nodes: [review('COMMENTED', 'ann'), review('COMMENTED', 'bob'), review('DISMISSED', 'cy')] },
    latestOpinionatedReviews: { nodes: [review('APPROVED', 'ann'), review('CHANGES_REQUESTED', 'dee')] },
    reviewRequests: { nodes: [{ requestedReviewer: { __typename: 'User', login: 'dee' } }, { requestedReviewer: { __typename: 'Team' } }, { requestedReviewer: null }] },
  } as never);
  assert.deepEqual(states, { ann: 'APPROVED', bob: 'REVIEWED', dee: 'UNREVIEWED' });
});

test('a log loses its timestamps, colours and fold markers, and says errors and warnings in words', () => {
  const raw = '2026-11-10T09:58:01.0000000Z ##[group]Build\r\n2026-11-10T09:58:02Z \u001b[31mred\u001b[0m\n2026-11-10T09:58:03Z ##[endgroup]\n2026-11-10T09:58:04Z ##[warning]Node 18 is old\n2026-11-10T09:58:05Z ##[error]boom\n\n\n';
  assert.deepEqual(prs.plainLog(raw), ['Build', 'red', 'Warning: Node 18 is old', 'Error: boom']);
});

test('a bot is an author of type Bot, or one whose login ends in [bot]', () => {
  assert.deepEqual([{ login: 'x', __typename: 'Bot' }, { login: 'renovate[bot]' }, { login: 'ivan', __typename: 'User' }, null].map((a) => prs.isBot(a as never)), [true, true, false, false]);
});
