import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { githubWorker } from './fixtures/github-worker.mjs';

const w = await githubWorker();
await w.start();
const { readMatrix } = await import('./matrix.mjs');
const selfheal = await import('./selfheal.mjs');
const { TOOLS } = await import('./mcptools.mjs');

const WEB12 = 'acme-co/web#12';
const tokenFile = join(w.home, '.config', 'underlings', 'github-token');
const unpaste = () => rmSync(tokenFile, { force: true });
const GITHUB_CAPS = { hold: false, withdrawApproval: false, rebase: false, autoMerge: false, jobLogs: 'actions', retry: false, todos: false, generalThreads: false, post: false, agents: false, ownMr: false };
const refused = (promise) => promise.then(() => null, (e) => ({ status: e.status, message: e.message }));
const GITHUB_ROWS = ['acme-co/engine#7', 'acme-co/web#12', 'acme-co/web#15', 'acme-co/web#18', 'octo/api#21', 'octo/web#3'];

after(() => w.stop());
beforeEach(async () => {
  w.down.gitlab = false;
  await w.settled();
});

test('the page is told what each provider is, who you are on it, what it can do and whether it answered, and every GitHub row says so', async () => {
  const { providers, inbox, me } = await readMatrix();
  assert.deepEqual(providers.gitlab, { name: 'GitLab', on: true, caps: { hold: true, withdrawApproval: true, rebase: true, autoMerge: true, jobLogs: true, retry: true, todos: true }, error: null, me: 'frank' });
  const { limits, ...github } = providers.github;
  assert.deepEqual(github, { name: 'GitHub', on: true, caps: GITHUB_CAPS, error: null, me: 'frank-gh', web: 'https://github.com' });
  assert.deepEqual([limits.remaining, limits.lastCost, limits.blockedUntil], [4990, 1, null]);
  assert.equal('limits' in providers.gitlab, false);
  assert.equal(me, 'frank');
  assert.deepEqual(inbox.rows.filter((r) => r.provider).map((r) => r.key).sort(), GITHUB_ROWS);
  assert.ok(inbox.rows.filter((r) => !r.provider).every((r) => !('provider' in r)));
  const row = (key) => inbox.rows.find((r) => r.key === key);
  assert.deepEqual([row('acme-co/web#15').flags.mine, row(WEB12).flags.mine, row('acme/engine!7').flags.mine], [true, false, false]);
  assert.equal(inbox.error, null);
});

test('a key may be either form, and the one message for a bad one names both, on every route that takes one', async () => {
  const bad = 'key must look like group/repo!123 or owner/repo#123';
  for (const path of ['/api/matrix/mr', '/api/matrix/file', '/api/matrix/pipeline', '/api/matrix/job-log']) {
    assert.deepEqual(await refused(w.get(path, { key: 'nonsense' })), { status: 400, message: bad }, path);
  }
  const rest = { resolved: true, jobId: 1, pipelineId: 1, discussionId: 'x', verdict: 'approve', reviewers: [], auto: true, approving: true, held: true, body: 'x', severity: 'MINOR', expect: {} };
  const names = ['decide', 'review-own', 'rebase', 'ready', 'merge', 'reviewers', 'rerequest', 'fix', 'cancel-merge', 'retry-job', 'retry-pipeline', 'reply', 'resolve', 'thread-ticket-finish', 'archive-mr', 'watch', 'unwatch', 'auto', 'seen', 'schedule', 'unschedule', 'move-automation'];
  for (const name of names) assert.deepEqual(await refused(w.act(name, { key: 'nonsense', ...rest })), { status: 400, message: bad }, name);
  assert.equal((await refused(w.get('/api/matrix/mr', { key: WEB12 }))), null);
  assert.equal((await refused(w.get('/api/matrix/mr', { key: 'acme/engine!7' }))), null);
});

const mcp = async (tool, args) => JSON.parse((await w.post('/api/mcp/call', { tool, args })).text);

test('review agents list and read GitHub pull requests through the same tools, by a key of either form', async () => {
  const listed = await mcp('list_mrs', { repo: 'acme-co/web' });
  assert.deepEqual(listed.mrs.map((r) => r.mr ?? r.key).sort(), ['acme-co/web#12', 'acme-co/web#15', 'acme-co/web#18']);
  const group = (await mcp('list_mrs', { repo: 'acme' })).mrs.map((r) => r.mr ?? r.key);
  assert.ok(group.length > 3 && group.every((k) => k.startsWith('acme/') && k.includes('!')), 'a group is its own forge\'s, and acme-co is not acme');
  const read = await mcp('get_mr', { mr: WEB12 });
  assert.deepEqual([read.mr, read.merge.status, read.target, read.threads.map((t) => t.id)], [WEB12, 'not_approved', 'main', ['review-301', 'PRRT_kwDOAA', 'comment-501']]);
  assert.deepEqual(await refused(w.post('/api/mcp/call', { tool: 'get_mr', args: { mr: 'nope' } })), { status: 400, message: 'mr looks like group/repo!123 or owner/repo#123, as list_mrs gives it' });
  assert.match(TOOLS.find((t) => t.name === 'get_mr').inputSchema.properties.mr.description, /group\/repo!iid, or owner\/repo#iid for a GitHub pull request/);
});

test('the drawer reads a pull request through the worker: discussions, checks, merge words, branches and files, all in the app\'s own shapes', async () => {
  const read = await w.get('/api/matrix/mr', { key: WEB12 });
  assert.deepEqual([read.mr.provider, read.mr.repo, read.me], ['github', 'Web', 'frank-gh']);
  assert.deepEqual(read.discussions.map((d) => [d.id, d.resolvable, d.resolved, d.awaitsYou]), [['review-301', false, true, false], ['PRRT_kwDOAA', true, false, true], ['comment-501', false, true, false]]);
  assert.deepEqual(read.jobs.map((j) => [j.name, j.status]), [['build', 'success'], ['test', 'success'], ['Vercel', 'skipped'], ['ci/license', 'success']]);
  assert.deepEqual(read.merge, { status: 'not_approved', words: 'needs approval', tone: 'blocked' });
  assert.equal(read.detail.targetBranch, 'main');
  assert.deepEqual(read.files.list.map((f) => f.path ?? f.newPath), ['src/token.ts', 'src/cache.ts', 'dist/bundle.js']);
  const ruled = await w.get('/api/matrix/mr', { key: 'acme-co/web#15' });
  assert.deepEqual(ruled.merge, { status: 'ci_must_pass', words: 'pipeline must succeed', tone: 'blocked' });
});

test('a merge a branch rule blocks says so in GitHub\'s words, never GitLab\'s', async () => {
  Object.assign(w.hub.world.prs.find((p) => p.number === 3), { reviewDecision: null });
  await w.refresh();
  const read = await w.get('/api/matrix/mr', { key: 'octo/web#3' });
  assert.deepEqual(read.merge, { status: 'branch_rules', words: 'blocked: branch rules', tone: 'blocked' });
  Object.assign(w.hub.world.prs.find((p) => p.number === 18), { mergeable: 'MERGEABLE', mergeStateStatus: 'UNKNOWN', rollup: 'SUCCESS' });
  await w.refresh();
  assert.equal((await w.get('/api/matrix/mr', { key: 'acme-co/web#18' })).merge.words, 'GitHub is checking');
});

test('the pipeline tab lists checks as jobs, a log only for Actions, and a link for the rest', async () => {
  const { jobs, pipelineId } = await w.get('/api/matrix/pipeline', { key: WEB12 });
  assert.equal(pipelineId, 9001);
  assert.deepEqual(jobs.filter((j) => j.logs === false).map((j) => [j.name, j.webUrl]), [['Vercel', 'https://vercel.com/acme-co/web/abc'], ['ci/license', 'https://license.example/acme-co/web/12']]);
  assert.ok(jobs.filter((j) => j.logs !== false).every((j) => !('webUrl' in j)));
  const log = await w.get('/api/matrix/job-log', { key: WEB12, job: '7002' });
  assert.deepEqual(log.lines, ['Run npm test', 'npm test', '42 passing', 'Error: Process completed with exit code 1.']);
  assert.deepEqual(await refused(w.get('/api/matrix/job-log', { key: WEB12, job: '7003' })), { status: 400, message: 'Vercel is not a GitHub Actions job, so its log is only on the page it links to' });
});

test('every action a GitHub pull request cannot take yet is refused by its flag before anything is read or written', async () => {
  const asks = {
    review: {}, 'review-own': {}, fix: {}, auto: { auto: true }, schedule: {},
    'queue-finding': { severity: 'MINOR', body: 'x' }, approve: { approving: true }, decide: { verdict: 'approve' }, reply: { discussionId: 'x', body: 'y' }, resolve: { discussionId: 'x', resolved: true },
    'post-all': {}, 'thread-ticket': { discussionId: 'x' }, merge: {}, 'cancel-merge': {}, ready: {}, reviewers: { reviewers: [] }, rerequest: { reviewers: [] },
    hold: { held: true }, rebase: {}, 'retry-job': { jobId: 7001 }, 'retry-pipeline': { pipelineId: 9001 },
  };
  const before = [w.hub.count(), w.gitlab.count()];
  const said = {};
  for (const [name, body] of Object.entries(asks)) said[name] = await refused(w.act(name, { key: WEB12, ...body }));
  assert.deepEqual(Object.entries(said).filter(([, r]) => r?.status !== 400 || !/^GitHub has no way to /.test(r.message)), []);
  assert.deepEqual([w.hub.count(), w.gitlab.count()], before);
  assert.equal(said['hold'].message, 'GitHub has no way to hold a merge');
  assert.equal(said['review'].message, 'GitHub has no way to launch an agent on it from here yet');
});

test('a GitLab merge request is asked nothing of those flags, so what it could do it still can', async () => {
  const said = await refused(w.act('hold', { key: 'acme/web!30', held: true }));
  assert.equal(said, null);
  await w.settled();
});

test('GitHub failing is its own card: its error is its alone, GitLab\'s rows stay, and the GitHub rows of the last read stay too', async () => {
  const before = (await readMatrix()).inbox.rows.map((r) => r.key).sort();
  w.hub.inject({ op: 'Involved' }, { status: 401, body: { message: 'Bad credentials' } });
  await w.refresh();
  const { providers, inbox } = await readMatrix();
  assert.match(providers.github.error, /wrong, revoked or expired/);
  assert.equal(providers.gitlab.error, null);
  assert.equal(inbox.error, null);
  assert.deepEqual(inbox.rows.map((r) => r.key).sort(), before);
  await w.refresh();
  assert.equal((await readMatrix()).providers.github.error, null);
});

test('GitLab failing is its own card too, with the GitHub rows still there and GitHub saying nothing is wrong', async () => {
  w.down.gitlab = true;
  await w.refresh();
  const { providers, inbox } = await readMatrix();
  assert.match(providers.gitlab.error, /401/);
  assert.equal(providers.github.error, null);
  assert.match(inbox.error, /401/);
  assert.deepEqual(inbox.rows.filter((r) => r.provider).map((r) => r.key).sort(), GITHUB_ROWS);
});

test('both failing keeps the last rows and gives each its own reason', async () => {
  w.down.gitlab = true;
  w.hub.inject({ op: 'Involved' }, { status: 401, body: { message: 'Bad credentials' } });
  await w.refresh();
  const { providers, inbox } = await readMatrix();
  assert.match(providers.gitlab.error, /401/);
  assert.match(providers.github.error, /wrong, revoked or expired/);
  assert.ok(inbox.rows.length > 6);
});

test('switching GitHub off in Settings takes its rows away and asks it nothing more, and switching it on brings them back', async () => {
  assert.equal(await w.post('/api/matrix/settings', { patch: { 'github.on': false } }).then(() => 'saved', (e) => e.message), 'saved');
  await w.refresh();
  const asked = w.hub.count();
  let matrix = await readMatrix();
  assert.deepEqual([matrix.providers.github.on, matrix.providers.github.error, matrix.providers.github.me], [false, null, null]);
  assert.equal(matrix.inbox.rows.some((r) => r.provider), false);
  await w.refresh();
  assert.equal(w.hub.count(), asked);
  assert.deepEqual(await refused(w.get('/api/matrix/mr', { key: WEB12 })), { status: 409, message: 'GitHub is switched off, so nothing is asked of it. Turn it on in Settings' });
  await w.post('/api/matrix/settings', { patch: { 'github.on': true } });
  await w.refresh();
  matrix = await readMatrix();
  assert.deepEqual(matrix.inbox.rows.filter((r) => r.provider).map((r) => r.key).sort(), GITHUB_ROWS);
  assert.ok(w.hub.count() > asked);
});

test('turning GitHub on reads the shell\'s token for an app opened from Finder, which has none of its own', async () => {
  await w.post('/api/matrix/settings', { patch: { 'github.on': false } });
  const token = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  w.shell.GITHUB_TOKEN = 'ghp_fromtheshellfromtheshellfromthes';
  try {
    await w.post('/api/matrix/settings', { patch: { 'github.on': true } });
    await w.until(() => process.env.GITHUB_TOKEN === 'ghp_fromtheshellfromtheshellfromthes');
    await w.refresh();
    assert.equal(w.hub.requests.at(-1).bearer, 'ghp_fromtheshellfromtheshellfromthes');
    assert.ok(w.calls.some(([cmd, ...names]) => cmd === 'zsh' && names.includes('GITHUB_TOKEN')));
  } finally {
    process.env.GITHUB_TOKEN = token;
    delete w.shell.GITHUB_TOKEN;
  }
});

test('a pasted token is checked for its shape, kept readable by you alone, used before the environment\'s, and GitHub is asked again', async () => {
  assert.deepEqual(await refused(w.post('/api/github/token', { token: 'not a token' })), { status: 400, message: 'that does not look like a GitHub token' });
  const pasted = 'ghp_pastedpastedpastedpastedpastedpa';
  const said = await w.post('/api/github/token', { token: ` ${pasted} ` });
  assert.deepEqual(said, { ok: true, text: 'GitHub answered' });
  assert.equal(readFileSync(tokenFile, 'utf8'), `${pasted}\n`);
  assert.equal(statSync(tokenFile).mode & 0o777, 0o600);
  assert.equal(w.hub.requests.at(-1).bearer, pasted);
});

test('Retry GitHub reads the shell\'s tokens again and asks again, and says why when GitHub still does not answer', async () => {
  w.shell.GITHUB_TOKEN = 'ghp_retriedretriedretriedretriedretr';
  const said = await w.post('/api/github/retry', {});
  assert.deepEqual(said, { ok: true, text: 'GitHub answered' });
  w.hub.inject({ op: 'Involved' }, { status: 502, body: { message: 'Bad Gateway' } });
  assert.match((await refused(w.post('/api/github/retry', {}))).message, /^GitHub: GitHub 502/);
  delete w.shell.GITHUB_TOKEN;
});

const setupOf = async () => (await w.get('/api/setup')).checks.find((c) => c.id === 'github');
const userCalls = () => w.hub.requests.filter((r) => r.path === '/user');

test('Setup says which token is in use, who it is, and what scopes it has', async () => {
  unpaste();
  const check = await setupOf();
  assert.deepEqual([check.state, check.title, check.source, check.user, check.scopes, check.on, check.optional], ['pass', 'GitHub', 'GITHUB_TOKEN', 'frank-gh', ['repo', 'read:org'], true, true]);
  assert.equal(check.detail, 'Signed in to GitHub as frank-gh, with GITHUB_TOKEN in your shell profile (repo, read:org).');
  assert.equal(check.link, 'https://github.com/settings/tokens/new?scopes=repo,read:org&description=Underlings');
});

test('a token missing a scope fails with what it lacks and what it has, and for gh the command that adds it', async () => {
  Object.assign(w.hub.world.viewer, { scopes: 'repo' });
  const check = await setupOf();
  assert.deepEqual([check.state, check.missing, check.scopes, check.command], ['fail', ['read:org'], ['repo'], undefined]);
  assert.equal(check.detail, 'Signed in to GitHub as frank-gh, with GITHUB_TOKEN in your shell profile, but it lacks read:org. It has repo.');
  const token = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  w.shell.gh = 'gho_viaghviaghviaghviaghviaghviaghvia1';
  try {
    await w.post('/api/github/retry', {}).catch(() => null);
    const viaGh = await setupOf();
    assert.deepEqual([viaGh.source, viaGh.command], ['gh', 'gh auth refresh -s read:org']);
    assert.ok(w.calls.some((c) => c[0] === 'gh' && c.slice(1).join(' ') === 'auth token --hostname github.com'));
  } finally {
    process.env.GITHUB_TOKEN = token;
    delete w.shell.gh;
    Object.assign(w.hub.world.viewer, { scopes: 'repo, read:org' });
  }
});

test('a fine-grained token lists no scopes, so Setup says what it needs instead of failing it', async () => {
  Object.assign(w.hub.world.viewer, { scopes: null });
  const check = await setupOf();
  assert.deepEqual([check.state, check.scopes, check.user], ['pass', null, 'frank-gh']);
  assert.match(check.detail, /a fine-grained token, so GitHub lists no scopes\. It needs read access to pull requests, contents, checks, commit statuses and Actions, and covers one owner only/);
  Object.assign(w.hub.world.viewer, { scopes: 'repo, read:org' });
});

test('a refused token, an organisation that wants single sign-on and GitHub failing each fail with their own words', async () => {
  w.hub.inject({ path: '/user' }, { status: 401, body: { message: 'Bad credentials' } });
  const wrong = await setupOf();
  assert.deepEqual([wrong.state, wrong.detail], ['fail', 'GitHub refused GITHUB_TOKEN in your shell profile: it is wrong, revoked or expired.']);
  Object.assign(w.hub.world.viewer, { sso: 'https://github.com/orgs/acme-co/sso?authorization_request=ABC' });
  const sso = await setupOf();
  assert.equal(sso.state, 'fail');
  assert.match(sso.detail, /but authorise this token for acme-co's single sign-on: https:\/\/github.com\/orgs\/acme-co\/sso\?authorization_request=ABC\.$/);
  delete w.hub.world.viewer.sso;
  w.hub.inject({ path: '/user' }, { status: 502, body: { message: 'Bad Gateway' } });
  assert.equal((await setupOf()).detail, 'GitHub answered 502 when asked who GITHUB_TOKEN in your shell profile belongs to.');
});

test('with no token anywhere Setup fails with how to get one, and a pasted token is read before the shell\'s', async () => {
  const token = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  try {
    await w.post('/api/github/retry', {}).catch(() => null);
    const none = await setupOf();
    assert.deepEqual([none.state, none.command, none.detail], ['fail', 'gh auth login', 'No token found. Paste one here, set GITHUB_TOKEN or GH_TOKEN in your shell profile, or sign in with gh.']);
  } finally {
    process.env.GITHUB_TOKEN = token;
  }
  mkdirSync(join(tokenFile, '..'), { recursive: true });
  writeFileSync(tokenFile, 'ghp_pastedbeforepastedbeforepastedbe\n');
  assert.equal((await setupOf()).source, 'saved');
  unpaste();
});

test('with GitHub off Setup shows it off and optional, asks GitHub nothing, and does not read gh, whatever it is signed in as', async () => {
  await w.post('/api/matrix/settings', { patch: { 'github.on': false } });
  await w.refresh();
  w.shell.gh = 'gho_signedinsignedinsignedinsignedin12';
  const shellReads = () => w.calls.filter((c) => c[0] === 'zsh' && c.includes('GITHUB_TOKEN')).length;
  const [users, ghCalls, requests, shells] = [userCalls().length, w.calls.filter((c) => c[0] === 'gh').length, w.hub.count(), shellReads()];
  const check = await setupOf();
  assert.deepEqual([check.state, check.on, check.optional, check.detail], ['off', false, true, 'Optional. Off until you switch it on here; being signed in to gh does not turn it on.']);
  assert.deepEqual([userCalls().length, w.calls.filter((c) => c[0] === 'gh').length, w.hub.count(), shellReads()], [users, ghCalls, requests, shells]);
  assert.deepEqual(await refused(w.post('/api/github/retry', {})), { status: 409, message: 'GitHub is off. Switch it on in Setup or Settings first.' });
  assert.deepEqual(await w.post('/api/github/token', { token: 'ghp_savedwhileoffsavedwhileoffsavedw' }), { ok: true, text: 'Saved. Switch GitHub on to use it' });
  assert.equal(w.hub.count(), requests);
  const token = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  w.shell.GITHUB_TOKEN = 'ghp_fromtheshellfromtheshellfromthes';
  try {
    await selfheal.adoptGitHubEnv();
    assert.deepEqual([process.env.GITHUB_TOKEN, shellReads()], [undefined, shells], 'a start with GitHub off does not read the shell for its token');
  } finally {
    process.env.GITHUB_TOKEN = token;
    delete w.shell.GITHUB_TOKEN;
  }
  delete w.shell.gh;
});
