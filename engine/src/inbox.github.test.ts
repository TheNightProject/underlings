import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { readFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { promisify } from 'node:util';
import { fakeGitlab } from '../../lib/fixtures/gitlab-golden/fakegitlab.mjs';
import { goldenWorld, HOST } from '../../lib/fixtures/gitlab-golden/world.mjs';
import { githubHarness } from './fixtures/github/harness.mjs';

const h = githubHarness();
process.env['GITLAB_TOKEN'] = 'gitlab-token';
process.env['GITHUB_TOKEN'] = 'ghp_0123456789abcdefghijklmnopqrstuv';

// Orca at its boundary: no terminals, and nothing is started.
Object.assign(childProcess, { execFile: Object.assign(() => undefined, { [promisify.custom]: () => Promise.reject(new Error('spawn orca ENOENT')) }) });
syncBuiltinESMExports();

let gitlabDown = false;
const gitlab = fakeGitlab(goldenWorld(), { host: HOST, token: 'gitlab-token' });
const seen: string[] = [];
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = new URL(String(input));
  seen.push(url.origin);
  if (url.origin === HOST) return gitlabDown ? Response.json({ message: '401 Unauthorized' }, { status: 401 }) : gitlab.fetch(input, init);
  return h.fake.fetch(input, init);
}) as typeof fetch;

const { fetchInbox, inboxRows, meFor } = await import('./inbox.js');
const { changeSettings, saveRepoCache } = await import('./data/store.js');
const { forgeOf, forges, forgeView } = await import('./data/forge.js');
const { resetGithubLimits, forgetGithubToken } = await import('./data/github.js');
const { DEFAULT_GITHUB } = await import('./settings.js');

const github = (over: Record<string, unknown> = {}) => changeSettings((s) => ({ ...s, github: { ...DEFAULT_GITHUB, on: true, ...over } }));
const mine = (rows: ReturnType<typeof inboxRows>, key: string) => rows.find((r) => r.key === key)!.flags.mine;
const keys = (mrs: { projectPath: string; iid: number; provider?: string }[]) => mrs.map((m) => `${m.projectPath}${m.provider ? '#' : '!'}${m.iid}`);

after(() => h.done());
beforeEach(() => {
  gitlabDown = false;
  seen.length = 0;
  gitlab.requests.length = 0;
  h.fake.requests.length = 0;
  Object.assign(h.world, { viewer: { login: 'frank-gh', name: 'Frank Foster', scopes: 'repo, read:org' } });
  resetGithubLimits();
  forgetGithubToken();
  saveRepoCache([{ path: 'acme/engine', label: 'Engine', openCount: 3 }, { path: 'acme/web', label: 'Web', openCount: 3 }, { path: 'acme/tools/cli', label: 'Cli', openCount: 1 }]);
  changeSettings((s) => ({ ...s, github: DEFAULT_GITHUB }));
});

test('with GitHub off nothing is asked of it, whatever token is in the environment or gh holds, and the inbox has the shape it always had', async () => {
  h.signedInWith('gho_signedinsignedinsignedinsignedinsi');
  const inbox = await fetchInbox();
  assert.deepEqual([h.fake.count(), h.ghCalls(), new Set(seen)], [0, [], new Set([HOST])]);
  assert.deepEqual(forges().map((f) => f.id), ['gitlab']);
  assert.throws(() => forgeOf({ provider: 'github' }), { message: 'GitHub is switched off, so nothing is asked of it. Turn it on in Settings' });
  assert.deepEqual(forgeView().github.on, false);
  for (const left of ['accounts', 'errors', 'answeredAt']) assert.equal(left in inbox, false, left);
  assert.deepEqual([inbox.me, inbox.repoCount, inbox.mrs.some((m) => m.provider)], ['frank', 3, false]);
});

test('GitLab and GitHub are read together into one list, each with its own me, and the repos of both counted', async () => {
  github();
  const inbox = await fetchInbox();
  assert.deepEqual(inbox.accounts, { gitlab: 'frank', github: 'frank-gh' });
  assert.equal(inbox.me, 'frank');
  assert.deepEqual(inbox.errors, {});
  assert.deepEqual(new Set(seen), new Set([HOST, 'https://api.github.com']));
  const listed = keys(inbox.mrs);
  assert.ok(listed.includes('acme/engine!7') && listed.includes('acme-co/web#12'));
  assert.deepEqual(inbox.mrs.filter((m) => m.provider).length, 6);
  assert.equal(inbox.repoCount, 3 + 4);
  assert.deepEqual(Object.keys(inbox.answeredAt ?? {}).sort(), ['github', 'gitlab']);
  assert.ok(gitlab.requests.every((r) => r.path.startsWith('/api/')));
  assert.ok(h.fake.requests.every((r) => r.bearer === process.env['GITHUB_TOKEN']));
});

const rowsOf = (inbox: Awaited<ReturnType<typeof fetchInbox>>) =>
  inboxRows({ mrs: inbox.mrs, me: inbox.me, accounts: inbox.accounts, queue: [], watches: {}, agents: inbox.agents, threads: inbox.threads, verdicts: {} });

test('the repos the organisations scope finds are kept in a file of GitHub\'s own for a day, and GitLab\'s list is left as it was', async () => {
  github({ scope: 'orgs' });
  await fetchInbox();
  await fetchInbox();
  assert.equal(h.fake.asked('Orgs').length, 1, 'found once, then read from the cache');
  const kept = (name: string) => JSON.parse(readFileSync(join(process.env['UNDERLINGS_STATE_DIR']!, name), 'utf8')).repos.map((r: { path: string }) => r.path);
  assert.deepEqual(kept('repos-github.json'), ['acme-co/web', 'acme-co/engine']);
  assert.deepEqual(kept('repos.json'), ['acme/engine', 'acme/web', 'acme/tools/cli']);
});

test('rows of both come in one order, by what each needs of you and then how lately it moved, whichever forge it is on', async () => {
  github();
  const rows = rowsOf(await fetchInbox());
  const rank = (f: (typeof rows)[number]['flags']): number => (f.queued > 0 ? 0 : f.waitingOnYou ? 1 : f.changed ? 2 : f.red ? 3 : f.mine ? 4 : 5);
  const ordered = rows.slice(1).every((row, n) => {
    const above = rows[n]!;
    return rank(above.flags) < rank(row.flags) || (rank(above.flags) === rank(row.flags) && Date.parse(above.mr.updatedAt) >= Date.parse(row.mr.updatedAt));
  });
  assert.ok(ordered);
  assert.ok(rows.findLastIndex((r) => r.mr.provider) > rows.findIndex((r) => !r.mr.provider), 'GitHub rows sit among the GitLab ones, not after them');
  assert.equal(new Set(rows.map((r) => r.key)).size, rows.length);
});

test('a repo named alike on both is told apart by a GH on the GitHub label', async () => {
  github();
  const { mrs } = await fetchInbox();
  const label = (key: string) => mrs.find((m) => keys([m])[0] === key)!.repoLabel;
  assert.deepEqual([label('acme/engine!7'), label('acme-co/engine#7'), label('acme/web!30'), label('acme-co/web#12')], ['Engine', 'Engine GH', 'Web', 'Co Web']);
});

test('GitHub failing leaves GitLab answering, says why for GitHub alone, and keeps the GitHub rows the last read had', async () => {
  github();
  const before = await fetchInbox();
  h.fake.inject({ op: 'Involved' }, { status: 502, body: { message: 'Bad Gateway' } });
  const after = await fetchInbox(before);
  assert.deepEqual(Object.keys(after.errors ?? {}), ['github']);
  assert.match(after.errors?.github ?? '', /^GitHub 502 .*GraphQL/);
  assert.deepEqual(keys(after.mrs).sort(), keys(before.mrs).sort());
  assert.deepEqual(after.accounts, before.accounts);
  assert.equal(after.answeredAt?.github, before.answeredAt?.github);
  assert.notEqual(after.answeredAt?.gitlab, undefined);
  assert.equal(after.repoCount, before.repoCount);
});

test('GitHub failing on a first read lists no GitHub rows and still lists every GitLab one', async () => {
  github();
  h.fake.inject({ op: 'Involved' }, { status: 401, body: { message: 'Bad credentials' } });
  const inbox = await fetchInbox();
  assert.deepEqual(inbox.errors, { github: 'GitHub refused the token (401): it is wrong, revoked or expired' });
  assert.equal(inbox.mrs.some((m) => m.provider), false);
  assert.ok(keys(inbox.mrs).includes('acme/engine!7'));
  assert.equal(inbox.accounts?.github, undefined);
  assert.equal(inbox.accounts?.gitlab, 'frank');
});

test('GitLab failing leaves GitHub answering, with each name still its own', async () => {
  github();
  const before = await fetchInbox();
  gitlabDown = true;
  const after = await fetchInbox(before);
  assert.deepEqual(Object.keys(after.errors ?? {}), ['gitlab']);
  assert.equal(after.accounts?.github, 'frank-gh');
  assert.equal(after.me, 'frank');
  assert.deepEqual(keys(after.mrs).sort(), keys(before.mrs).sort());
  assert.equal(after.answeredAt?.gitlab, before.answeredAt?.gitlab);
});

test('both failing fails the read with GitLab\'s error, as it alone always did, carrying the reason for each', async () => {
  github();
  gitlabDown = true;
  h.fake.inject({ op: 'Involved' }, { status: 401, body: { message: 'Bad credentials' } });
  const error = await fetchInbox().then(() => null, (e: Error & { errors?: Record<string, string> }) => e);
  assert.ok(error);
  assert.match(error.message, /401/);
  assert.deepEqual(Object.keys(error.errors ?? {}).sort(), ['github', 'gitlab']);
  assert.match(error.errors?.github ?? '', /wrong, revoked or expired/);
});

test('with only GitLab on, its failure is the plain error with nothing attached', async () => {
  gitlabDown = true;
  const error = await fetchInbox().then(() => null, (e: Error & { errors?: unknown }) => e);
  assert.ok(error);
  assert.equal('errors' in error, false);
});

test('a GitHub user who shares your GitLab name is not you, and you are you on GitHub whatever GitLab calls you', async () => {
  github();
  const web15 = h.world.prs.find((p: { number: number }) => p.number === 15);
  const namesake = structuredClone(web15);
  Object.assign(namesake, { number: 31, author: 'frank', requested: [], assignees: ['frank-gh'], title: 'Same name, someone else' });
  h.world.prs.push(namesake);
  const inbox = await fetchInbox();
  const rows = rowsOf(inbox);
  const gitlabFrank = inbox.mrs.find((m) => !m.provider && m.author === 'frank')!;
  assert.equal(mine(rows, `${gitlabFrank.projectPath}!${gitlabFrank.iid}`), true);
  assert.equal(mine(rows, 'acme/engine!7'), false);
  assert.equal(mine(rows, 'acme-co/web#31'), false);
  assert.equal(mine(rows, 'acme-co/web#15'), true);
  const gh = inbox.mrs.find((m) => m.iid === 15 && m.provider)!;
  assert.deepEqual([meFor(gh, inbox.me, inbox.accounts), meFor(gitlabFrank, inbox.me, inbox.accounts)], ['frank-gh', 'frank']);
});

test('what GitLab said before there were accounts still reads: the plain name stands in for it', () => {
  assert.equal(meFor({}, 'frank', undefined), 'frank');
  assert.equal(meFor({ provider: 'github' }, 'frank', undefined), undefined);
  assert.equal(meFor({}, undefined, { gitlab: 'ivan' }), 'ivan');
});
