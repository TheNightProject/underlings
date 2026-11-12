import assert from 'node:assert/strict';
import { test } from 'node:test';
import { openPage } from './testkit.mjs';
import { visibleLines } from '../lib/fixtures/gitlab-golden/pagetext.mjs';

const AT = '2026-11-05T12:00:00Z';
const GL = 'acme/engine!7';
const GH = 'acme-co/web#12';
const GH2 = 'octo/web#3';
const GH3 = 'acme-co/engine#7';
const GITLAB_CAPS = { hold: true, withdrawApproval: true, rebase: true, autoMerge: true, jobLogs: true, retry: true, todos: true };
const GITHUB_CAPS = { hold: false, withdrawApproval: false, rebase: false, autoMerge: false, jobLogs: 'actions', retry: false, todos: false, generalThreads: false, post: false, agents: false, ownMr: false };
const plain = (value) => JSON.parse(JSON.stringify(value));

const webUrl = (key) => (key.includes('#') ? `https://github.com/${key.replace('#', '/pull/')}` : `https://gitlab.com/${key.replace('!', '/-/merge_requests/')}`);

function row(key, extra = {}) {
  const github = key.includes('#');
  const iid = Number(key.split(/[!#]/)[1]);
  return {
    key, ...(github ? { provider: 'github' } : {}), iid, repo: key.split('/').at(-1).split(/[!#]/)[0], title: 'Change ' + iid, webUrl: webUrl(key), author: 'ivan', reviewers: [github ? 'frank-gh' : 'frank'], approvedBy: [],
    draft: false, pipeline: 'SUCCESS', ticket: null, updatedAt: AT, unresolved: 1, threads: null, mergeStatus: github ? 'NOT_APPROVED' : 'MERGEABLE', sourceBranch: 'feat/' + iid, sha: 'aaa111bbb222',
    agentHandle: null, watch: null, flags: { waitingOnYou: true }, phase: 'open', count: 0, mood: 'awaitingYou', verdict: null, agent: null, level: null, ...extra,
  };
}

const provider = (name, on, caps, extra = {}) => ({ name, on, caps, error: null, me: on ? (name === 'GitHub' ? 'frank-gh' : 'frank') : null, ...extra });

function snapshot(rows, { providers = {}, matrix = {}, attention = {} } = {}) {
  return {
    generatedAt: AT, version: { ui: 1, lib: 1, worker: 1, loaded: 1 }, agents: [], artifacts: [],
    attention: { cards: [], agents: [], system: [], count: 0, prefs: { enabled: true, quiet: false, quietFrom: '22:00', quietTo: '07:00', weekends: false, clickable: false }, toasts: [], offers: [], notReaching: null, ...attention },
    matrix: {
      available: true, me: 'frank', paused: false, holdSeconds: null, holdWhileReviewing: false, gitlabHost: 'https://gitlab.com',
      providers: { gitlab: provider('GitLab', true, GITLAB_CAPS), github: provider('GitHub', true, GITHUB_CAPS, { web: 'https://github.com' }), ...providers },
      inbox: { fetchedAt: AT, loading: false, error: null, repoCount: 2, rows },
      fullAuto: [], roster: [], watches: [], verdicts: {}, queue: [], runs: [], autoPasses: [], ...matrix,
    },
  };
}

function detail(key, over = {}) {
  const r = row(key);
  return {
    key, me: 'frank-gh', fetchedAt: AT,
    mr: { ...(key.includes('#') ? { provider: 'github' } : {}), iid: r.iid, repo: r.repo, title: r.title, webUrl: r.webUrl, author: r.author, reviewers: r.reviewers, approvedBy: [], draft: false, conflicts: false, pipeline: r.pipeline, mergeStatus: r.mergeStatus, sourceBranch: r.sourceBranch, sha: r.sha, ticket: null, createdAt: AT, updatedAt: AT, unresolved: 1 },
    discussions: [], jobs: [],
    merge: { status: 'not_approved', words: 'needs approval', tone: 'blocked' },
    detail: { description: '', clipped: false, targetBranch: 'main', changes: '3', notes: 2 },
    files: { complete: true, list: [] },
    missing: {},
    ...over,
  };
}

async function open(snap, { hash = 'merge-requests', respond = () => null } = {}) {
  const posts = [];
  const page = await openPage({
    respond(path, init) {
      if (init?.method === 'POST') {
        posts.push([path, JSON.parse(init.body ?? 'null')]);
        return { ok: true, text: 'Done' };
      }
      return respond(new URL(path, 'http://page'), init);
    },
  });
  page.show(snap, hash);
  await page.settle(60);
  return Object.assign(page, { posts });
}

const buttons = (root) => root.querySelectorAll('button').map((b) => b.textContent);
const rowOf = (page, key) => page.$$('#main .mr').find((r) => r.textContent.includes(key.includes('#') ? key : key.split('!')[1] === undefined ? key : `!${key.split('!')[1]}`));

test('a GitHub row shows a GitHub mark and owner/repo#12, a GitLab row shows what it always has, and the list names the forges it holds', async () => {
  const page = await open(snapshot([row(GL), row(GH)]));
  const lines = visibleLines(page.$('#main'));
  assert.ok(lines.some((l) => l.startsWith('engine !7 · ivan')), 'the GitLab row reads as before');
  assert.ok(lines.some((l) => l.startsWith('GitHubacme-co/web#12 · ivan')), 'the GitHub row has its mark and its full reference');
  assert.equal(page.$$('#main .forge-mark').length, 1);
  assert.equal(page.$('#main .forge-mark').getAttribute('title'), 'A GitHub pull request');
  assert.ok(lines.includes('Refresh GitLab and GitHub'));
  const gitlabOnly = await open(snapshot([row(GL)]));
  assert.ok(visibleLines(gitlabOnly.$('#main')).includes('Refresh GitLab'));
  assert.equal(gitlabOnly.$$('#main .forge-mark').length, 0);
});

test('a GitHub row offers no action GitHub cannot do yet, and says why, while a GitLab row keeps every one', async () => {
  const page = await open(snapshot([row(GL), row(GH)]));
  const gitlab = rowOf(page, GL);
  const github = rowOf(page, GH);
  assert.deepEqual(buttons(gitlab).filter((b) => ['Review', 'Approve', 'Hold'].includes(b)), ['Review', 'Approve', 'Hold']);
  assert.deepEqual(buttons(github).filter((b) => ['Review', 'Approve', 'Hold', 'Release', 'Withdraw'].includes(b)), []);
  const note = github.querySelector('.read-only');
  assert.equal(note.textContent, 'read only here');
  assert.match(note.getAttribute('title'), /come in a later version; open it on GitHub to act on it/);
  assert.equal(gitlab.querySelector('.read-only'), null);
});

test('the actions each flag hides stay hidden for your own GitHub pull request and its findings, threads and menu', async () => {
  const mine = row(GH2, { author: 'frank-gh', reviewers: ['ivan'], flags: { mine: true }, pipeline: 'FAILED', mergeStatus: 'CI_MUST_PASS', agent: null });
  const queue = [{ id: 'q1', key: GH2, webUrl: mine.webUrl, severity: 'MINOR', kind: 'finding', body: 'x', hunk: '', path: 'a.ts', line: 1, side: 'new', anchor: 1, stale: false, createdBy: 'review', createdAt: AT, status: 'pending', postedAt: null, auto: null, error: null, discussionId: null, replyTo: null, outcome: null, verdict: null }];
  const page = await open(snapshot([mine], { matrix: { queue } }));
  const labels = buttons(rowOf(page, GH2));
  for (const hidden of ['Review my MR', 'Merge', 'Rebase', 'Mark ready', 'Fix', 'Post all 1', 'Approve', 'Hold']) assert.equal(labels.some((l) => l.startsWith(hidden)), false, hidden);
  page.$('#main .mr .menu-wrap button').click();
  page.run('render(true)');
  const menu = page.$$('#main .menu button').map((b) => b.textContent);
  assert.ok(menu.includes('Watch'));
  for (const hidden of ['Re-review daily', 'Auto re-review on']) assert.equal(menu.includes(hidden), false, hidden);
});

test('the drawer of a GitHub pull request is headed by its mark and reference, opens it on GitHub, and says GitHub in what it says is loading', async () => {
  const page = await open(snapshot([row(GH)]), { respond: (url) => (url.pathname === '/api/matrix/mr' ? detail(GH) : null) });
  page.run(`openMr('${GH}', 'overview')`);
  const head = page.$('#drawer .drawer-head');
  assert.match(head.textContent, /reading GitHub…/);
  await page.settle();
  const shown = page.$('#drawer .drawer-head');
  assert.match(shown.textContent, /GitHubacme-co\/web#12/);
  const onGithub = shown.querySelectorAll('button').find((b) => b.textContent === 'Open on GitHub');
  assert.equal(onGithub.getAttribute('title'), 'Opens https://github.com/acme-co/web/pull/12 in your browser');
  const facts = page.$('#drawer .kv').childNodes;
  const merge = facts[facts.findIndex((n) => n.tagName === 'DT' && n.textContent === 'Merge status') + 1];
  assert.equal(merge.querySelector('.pill').getAttribute('title'), 'GitHub: not_approved');
  assert.equal(buttons(page.$('#drawer')).some((b) => ['Review', 'Approve', 'Hold', 'Merge'].includes(b)), false);
  assert.deepEqual(page.errors, []);
});

test('the drawer of a GitHub pull request has only the tabs it can use, and a GitLab one has all six', async () => {
  const github = await open(snapshot([row(GH)]), { respond: (url) => (url.pathname === '/api/matrix/mr' ? detail(GH) : null) });
  github.run(`openMr('${GH}', 'findings')`);
  await github.settle();
  assert.deepEqual(github.$$('#drawer .tab').map((t) => t.textContent), ['Overview', 'Threads', 'Pipeline', 'Files']);
  assert.equal(github.$('#drawer .tab[aria-selected="true"]').textContent, 'Overview', 'a tab it does not have falls back to the first');
  const gitlab = await open(snapshot([row(GL)]), { respond: (url) => (url.pathname === '/api/matrix/mr' ? detail(GL) : null) });
  gitlab.run(`openMr('${GL}', 'agent')`);
  await gitlab.settle();
  assert.deepEqual(gitlab.$$('#drawer .tab').map((t) => t.textContent), ['Overview', 'Findings', 'Threads', 'Pipeline', 'Files', 'Agent']);
  assert.equal(gitlab.$('#drawer .tab[aria-selected="true"]').textContent, 'Agent');
});

test('in a pull request #12 is the same repo and owner/repo#12 another, each a link only when the page has it, and a bare number elsewhere stays text', async () => {
  const description = 'Closes #12 and #99, see acme-co/engine#7 and acme-co/nowhere#4, and issue #3.\nAlso !7, which is GitLab\'s.';
  const page = await open(snapshot([row(GH), row(GH3), row(GL)]), { respond: (url) => (url.pathname === '/api/matrix/mr' ? detail(GH, { detail: { description, clipped: false, targetBranch: 'main', changes: '1', notes: 0 } }) : null) });
  page.run(`openMr('${GH}', 'overview')`);
  await page.settle();
  assert.deepEqual(page.$$('#drawer .mr-desc .ref').map((b) => [b.dataset.key, b.textContent]), [[GH, '#12'], [GH3, 'acme-co/engine#7']]);
  assert.equal(page.$('#drawer .mr-desc').textContent, description);
});

test('a GitLab description keeps reading #12 as plain text, as it always did, even when GitHub is on', async () => {
  const description = 'See #12 and acme-co/web#12 and !7.';
  const page = await open(snapshot([row(GH), row(GL, { key: GL })]), { respond: (url) => (url.pathname === '/api/matrix/mr' ? detail(GL, { detail: { description, clipped: false, targetBranch: 'main', changes: '1', notes: 0 } }) : null) });
  page.run(`openMr('${GL}', 'overview')`);
  await page.settle();
  assert.deepEqual(page.$$('#drawer .mr-desc .ref').map((b) => b.dataset.key), [GH, GL], '#12 is text; GitHub\'s full reference and GitLab\'s !7 are the buttons they are');
});

test('the pipeline tab of a pull request has no retry, a log toggle only for Actions jobs, and a link out for every other check', async () => {
  const jobs = [
    { id: 7001, name: 'build', stage: 'CI', status: 'running', duration: 360, allowFailure: false },
    { id: 7101, name: 'test', stage: 'CI', status: 'failed', duration: 720, allowFailure: false },
    { id: 7003, name: 'Vercel', stage: 'Vercel', status: 'skipped', duration: null, allowFailure: true, logs: false, webUrl: 'https://vercel.com/acme-co/web/abc' },
  ];
  const mine = row(GH, { author: 'frank-gh', flags: { mine: true }, pipeline: 'FAILED' });
  const page = await open(snapshot([mine]), { respond: (url) => (url.pathname === '/api/matrix/pipeline' ? { key: GH, sha: 'aaa111bbb222', status: 'FAILED', pipelineId: 9001, fetchedAt: AT, jobs } : url.pathname === '/api/matrix/mr' ? detail(GH) : null) });
  page.run(`openMr('${GH}', 'pipeline')`);
  await page.settle();
  const body = page.$('#drawer .drawer-body');
  assert.deepEqual(body.querySelectorAll('.job-toggle').map((b) => b.textContent).sort(), ['build', 'test']);
  assert.equal(body.querySelectorAll('.job-name').map((s) => s.textContent).join(), 'Vercel');
  assert.equal(buttons(body).some((b) => b.startsWith('Retry')), false);
  const out = buttons(body).indexOf('Open Vercel');
  assert.ok(out >= 0);
  assert.equal(body.querySelectorAll('button').find((b) => b.textContent === 'Open Vercel').getAttribute('title'), 'Opens https://vercel.com/acme-co/web/abc in your browser');
});

test('the same tab on GitLab still offers each failed job its retry', async () => {
  const gitlabRow = row(GL, { author: 'frank', flags: { mine: true }, pipeline: 'FAILED' });
  const jobs = [{ id: 12, name: 'lint', stage: 'test', status: 'failed', duration: 3, allowFailure: false }];
  const page = await open(snapshot([gitlabRow]), { respond: (url) => (url.pathname === '/api/matrix/pipeline' ? { key: GL, sha: 'aaa', status: 'FAILED', pipelineId: 9, fetchedAt: AT, jobs } : url.pathname === '/api/matrix/mr' ? detail(GL) : null) });
  page.run(`openMr('${GL}', 'pipeline')`);
  await page.settle();
  assert.ok(buttons(page.$('#drawer .drawer-body')).includes('Retry job'));
});

test('a thread on a GitHub pull request is read in the Threads tab with no reply or resolve box, and one on GitLab keeps both', async () => {
  const discussions = [{ id: 'PRRT_1', resolved: false, resolvable: true, path: 'src/token.ts', line: 14, notes: [{ author: 'trent', body: 'Does this expire?', createdAt: AT, system: false }], awaitsYou: true, bot: false, handedBack: false, queuedReply: null }];
  const github = await open(snapshot([row(GH)]), { respond: (url) => (url.pathname === '/api/matrix/mr' ? detail(GH, { discussions }) : null) });
  github.run(`openMr('${GH}', 'threads')`);
  await github.settle();
  assert.match(github.$('#drawer .drawer-body').textContent, /Does this expire\?/);
  assert.equal(buttons(github.$('#drawer .drawer-body')).some((b) => /Reply|Resolve/.test(b)), false);
  const gitlab = await open(snapshot([row(GL)]), { respond: (url) => (url.pathname === '/api/matrix/mr' ? detail(GL, { discussions }) : null) });
  gitlab.run(`openMr('${GL}', 'threads')`);
  await gitlab.settle();
  assert.ok(buttons(gitlab.$('#drawer .drawer-body')).some((b) => /Reply|Resolve/.test(b)));
});

const known = (page, over = {}) => page.window.terminalKnowing({ mrs: [GL, GH, GH2, GH3], tickets: [], ...over });
const found = (page, line, k = known(page)) => plain(page.window.terminalRefs([line], k)).map((r) => [r.kind, r.key, r.text]);

test('in a terminal owner/repo#12 and a pull request address open the GitHub drawer, and a bare #12 is never a link', async () => {
  const page = await open(snapshot([row(GL), row(GH), row(GH2), row(GH3)]));
  assert.deepEqual(found(page, 'Reviewed acme-co/web#12, then https://github.com/octo/web/pull/3/files and acme/engine!7.'), [
    ['mr', GH, 'acme-co/web#12'], ['mr', GH2, 'https://github.com/octo/web/pull/3/files'], ['mr', GL, 'acme/engine!7'],
  ]);
  assert.deepEqual(found(page, 'Fixes #12, and item #3, colour #123456 and heading ## #4'), []);
  const action = (line) => plain(page.window.terminalAction(page.window.terminalRefs([line], known(page))[0], known(page)));
  assert.deepEqual([action('acme-co/web#12').kind, action('acme-co/web#12').words], ['mr', 'open the pull request']);
  assert.equal(action('acme/engine!7').words, 'open the MR');
});

test('repo#12 is a link only when the pull requests the page knows leave one owner, and a full reference to a pull request it does not know opens it on GitHub', async () => {
  const page = await open(snapshot([row(GL), row(GH), row(GH2), row(GH3)]));
  assert.deepEqual(found(page, 'web#12 and engine#7'), [['mr', GH3, 'engine#7']], 'web is in two owners, engine in one');
  const k = known(page);
  const [unknown] = page.window.terminalRefs(['acme-co/web#99'], k);
  assert.equal(unknown.key, 'acme-co/web#99');
  const action = plain(page.window.terminalAction(unknown, k));
  assert.deepEqual([action.kind, action.url], ['browser', 'https://github.com/acme-co/web/issues/99']);
  assert.deepEqual(found(page, 'nobody#4 and fix #5'), [], 'a bare repo name the page has never seen is text');
  const [place] = page.window.terminalRefs(['other/place#8'], k);
  assert.equal(plain(page.window.terminalAction(place, k)).url, 'https://github.com/other/place/issues/8', 'a full reference goes to GitHub, which sends an issue link on to the pull request when the number is one');
});

test('with GitHub off none of that is a link: a pull request address and owner/repo#12 stay text', async () => {
  const off = snapshot([row(GL)], { providers: { github: provider('GitHub', false, GITHUB_CAPS) } });
  const page = await open(off);
  assert.deepEqual(found(page, 'acme-co/web#12 https://github.com/acme-co/web/pull/12 acme/engine!7', known(page, { mrs: [GL] })), [['mr', GL, 'acme/engine!7']]);
});

test('a pull request address opens the drawer when GitHub is on, and not when it is off', async () => {
  const page = await open(snapshot([row(GH)]));
  assert.equal(page.run("mrKeyOf('https://github.com/acme-co/web/pull/12')"), GH);
  assert.equal(page.run("mrKeyOf('https://github.com/acme-co/web/pull/99')"), null);
  const off = await open(snapshot([row(GH)], { providers: { github: provider('GitHub', false, GITHUB_CAPS) } }));
  assert.equal(off.run("mrKeyOf('https://github.com/acme-co/web/pull/12')"), null);
});

const SETUP_OFF = { id: 'github', state: 'off', optional: true, title: 'GitHub', detail: 'Optional. Off until you switch it on here; being signed in to gh does not turn it on.', on: false, token: true };
const SETUP_ON = { ...SETUP_OFF, state: 'pass', detail: 'Signed in to GitHub as frank-gh, with GITHUB_TOKEN in your shell profile (repo, read:org).', on: true, source: 'GITHUB_TOKEN', user: 'frank-gh', scopes: ['repo', 'read:org'], needs: ['repo', 'read:org'], link: 'https://github.com/settings/tokens/new?scopes=repo,read:org&description=Underlings' };
const SETUP_LACKING = { ...SETUP_ON, state: 'fail', source: 'gh', scopes: ['repo'], missing: ['read:org'], command: 'gh auth refresh -s read:org', detail: 'Signed in to GitHub as frank-gh, with gh auth token, but it lacks read:org. It has repo.' };

async function setupPage(github) {
  return open(snapshot([]), { hash: 'setup', respond: (url) => (url.pathname === '/api/setup' ? { done: false, checks: [github] } : null) });
}

test('Setup offers GitHub as a switch that is off until it is turned on here, and turning it on saves only that setting', async () => {
  const page = await setupPage(SETUP_OFF);
  const sw = page.$('#setup-github-on');
  assert.deepEqual([sw.getAttribute('aria-checked'), sw.textContent], ['false', 'Off']);
  assert.equal(page.$('.setup-facts'), null);
  sw.click();
  await page.settle();
  assert.deepEqual(page.posts, [['/api/matrix/settings', { patch: { 'github.on': true } }]]);
});

test('Setup with GitHub on says which token is in use, who you are and what scopes it has', async () => {
  const page = await setupPage(SETUP_ON);
  const facts = page.$$('.setup-facts dt, .setup-facts dd').map((n) => n.textContent);
  assert.deepEqual(facts, ['Token from', 'GITHUB_TOKEN', 'Signed in as', 'frank-gh', 'Scopes', 'repo, read:org']);
  assert.equal(page.$('#setup-github-token'), null, 'a passing check offers no token to paste');
});

test('Setup names what a token lacks, the command that adds it for gh, a link to make one, and a place to paste one that is kept private', async () => {
  const page = await setupPage(SETUP_LACKING);
  assert.match(page.$('.setup-facts').textContent, /Scopes\s*repo\s*\(needs read:org\)/);
  assert.equal(page.$('.setup-command')?.textContent.includes('gh auth refresh -s read:org') ?? page.$('#main').textContent.includes('gh auth refresh -s read:org'), true);
  const make = page.$$('#main button').find((b) => b.textContent === 'Make a token with repo and read:org');
  assert.match(make.getAttribute('title'), /^Opens https:\/\/github.com\/settings\/tokens\/new\?scopes=repo,read:org&description=Underlings in your browser$/);
  const field = page.$('#setup-github-token');
  assert.equal(field.getAttribute('type'), 'password');
  field.value = ' ghp_pastedpastedpastedpastedpastedpa ';
  page.fire(field, 'input');
  page.$$('#main button').find((b) => b.textContent === 'Save' && b.parentNode.querySelector('#setup-github-token')).click();
  await page.settle();
  assert.deepEqual(page.posts.at(-1), ['/api/github/token', { token: 'ghp_pastedpastedpastedpastedpastedpa' }]);
  assert.match(page.$('#main').textContent, /Kept in ~\/\.config\/\w+\/github-token, readable only by you, and used before GITHUB_TOKEN, GH_TOKEN and gh/);
});

const GITHUB_SETTINGS = [
  { key: 'github.on', label: 'GitHub', hint: 'reads your GitHub pull requests into the same list.', kind: 'toggle', value: true },
  { key: 'github.scope', label: 'Pull requests', hint: 'involved or orgs.', kind: 'choice', choices: [['involved', 'Involving me'], ['orgs', 'My organisations']], value: 'involved' },
  { key: 'github.repos', label: 'GitHub repos', hint: 'organisations or owner/repo patterns.', kind: 'text', value: '' },
  { key: 'github.host', label: 'GitHub API', hint: 'the API your GitHub answers on.', kind: 'text', value: 'https://api.github.com' },
];

test('Settings has a GitHub group with the switch, the inbox scope, the repos to include or exclude and the API host, each saved on its own', async () => {
  const page = await open(snapshot([]), { hash: 'settings', respond: (url) => (url.pathname === '/api/matrix/settings' ? { rows: GITHUB_SETTINGS, repos: null } : null) });
  page.run('render()');
  await page.settle(60);
  const group = page.$$('#main .settings-group').find((g) => g.querySelector('h2').textContent === 'GitHub');
  assert.ok(group, 'a GitHub group');
  assert.deepEqual(group.querySelectorAll('.setting .label, .setting label').map((l) => l.textContent).slice(0, 4), ['GitHub', 'Pull requests', 'GitHub repos', 'GitHub API']);
  const orgs = group.querySelectorAll('button').find((b) => b.textContent === 'My organisations');
  orgs.click();
  await page.settle();
  assert.deepEqual(page.posts.at(-1), ['/api/matrix/settings', { patch: { 'github.scope': 'orgs' } }]);
});

test('GitHub failing is a banner of its own with its own retry and a way to Setup for a token, and GitLab\'s banner stays away', async () => {
  const error = 'GitHub refused the token (401): it is wrong, revoked or expired';
  const page = await open(snapshot([row(GL), row(GH)], { providers: { github: { ...provider('GitHub', true, GITHUB_CAPS), error } } }));
  const banners = page.$$('#main .banner').map((b) => b.textContent);
  assert.equal(banners.filter((b) => b.startsWith('GitHub refused the token (401)')).length, 1, 'an error that names GitHub is not prefixed with it again');
  assert.equal(banners.filter((b) => b.startsWith('GitLab')).length, 0);
  const banner = page.$$('#main .banner').find((b) => b.textContent.startsWith('GitHub refused'));
  assert.deepEqual(buttons(banner), ['Retry GitHub']);
  assert.ok(banner.querySelectorAll('a').some((a) => a.textContent === 'Set up' && a.getAttribute('href') === '#setup'));
  buttons(banner);
  banner.querySelector('button').click();
  await page.settle();
  assert.deepEqual(page.posts.at(-1), ['/api/github/retry', {}]);
  const gitlab = await open(snapshot([row(GL), row(GH)], { matrix: { inbox: { fetchedAt: AT, loading: false, error: 'GitLab 502', repoCount: 2, rows: [row(GL), row(GH)] } } }));
  const gitlabBanners = gitlab.$$('#main .banner').map((b) => b.textContent);
  assert.equal(gitlabBanners.some((b) => b.startsWith('GitHub')), false);
  assert.equal(gitlabBanners.some((b) => b.includes('GitLab 502')), true);
});

test('a GitHub error that is not about the token offers a retry and no way to Setup', async () => {
  const page = await open(snapshot([row(GH)], { providers: { github: { ...provider('GitHub', true, GITHUB_CAPS), error: 'GitHub 502 on GraphQL: Bad Gateway' } } }));
  const banner = page.$$('#main .banner').find((b) => b.textContent.startsWith('GitHub 502'));
  assert.equal(banner.querySelectorAll('a').some((a) => a.textContent === 'Set up'), false);
  const other = await open(snapshot([row(GH)], { providers: { github: { ...provider('GitHub', true, GITHUB_CAPS), error: 'rate limited' } } }));
  assert.ok(other.$$('#main .banner').some((b) => b.textContent.startsWith('GitHub: rate limited')), 'any other error is');
});

test('the status line names GitHub beside GitLab only when it is on, and says its error in its own words', async () => {
  const on = await open(snapshot([row(GL), row(GH)]));
  const rail = on.$('#health').textContent;
  assert.match(rail, /GitLab 7 d ago/);
  assert.match(rail, /GitHub 7 d ago/);
  const limited = await open(snapshot([row(GL)], { providers: { github: { ...provider('GitHub', true, GITHUB_CAPS), limits: { remaining: 4812, resetAt: '2026-11-05T13:00:00Z', lastCost: 1, blockedUntil: null } } } }));
  const span = limited.$$('#health span').find((s) => s.textContent.startsWith('GitHub'));
  assert.match(span.getAttribute('title'), /^4,812 requests left in GitHub's hour, which starts again at \d\d:\d\d$/);
  assert.equal(on.$$('#health span').find((s) => s.textContent.startsWith('GitHub')).getAttribute('title'), null);
  const failing = await open(snapshot([row(GL)], { providers: { github: { ...provider('GitHub', true, GITHUB_CAPS), error: 'rate limited' } } }));
  assert.match(failing.$('#health').textContent, /GitHub: rate limited/);
  const off = await open(snapshot([row(GL)], { providers: { github: provider('GitHub', false, GITHUB_CAPS) } }));
  assert.doesNotMatch(off.$('#health').textContent, /GitHub/);
});

test('Needs you carries a card for each forge that stopped answering, each with its own retry', async () => {
  const system = [
    { kind: 'github', key: null, group: 'system', id: 'github:1', since: AT, why: 'GitHub has not answered since 12:00: down', title: 'GitHub', tab: null, next: 'retry-github', tier: 'interrupt', settled: true },
    { kind: 'gitlab', key: null, group: 'system', id: 'gitlab:1', since: AT, why: 'GitLab has not answered since 12:00: down', title: 'GitLab', tab: null, next: 'retry-gitlab', tier: 'interrupt', settled: true },
  ];
  const page = await open(snapshot([], { attention: { system } }), { hash: 'needs-you' });
  const cards = page.$$('#main .need-card');
  assert.deepEqual(cards.map((c) => buttons(c)), [['Retry GitHub'], ['Retry GitLab']]);
  cards[0].querySelector('button').click();
  await page.settle();
  assert.deepEqual(page.posts.at(-1), ['/api/github/retry', {}]);
  cards[1].querySelector('button').click();
  await page.settle();
  assert.deepEqual(page.posts.at(-1), ['/api/matrix/refresh', {}]);
});
