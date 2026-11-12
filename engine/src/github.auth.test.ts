import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { githubHarness } from './fixtures/github/harness.mjs';

const h = githubHarness();

const { changeSettings } = await import('./data/store.js');
const github = await import('./data/github.js');

const SAVED = 'ghp_savedsavedsavedsavedsavedsavedsa';
const FROM_ENV = 'ghp_environmentenvironmentenvironmen2';
const FROM_GH_ENV = 'ghp_ghenvghenvghenvghenvghenvghenvghe3';
const FROM_GH = 'gho_ghclighclighclighclighclighcligh';

const settle = (over: Record<string, unknown> = {}) => changeSettings((s) => ({ ...s, github: { on: true, scope: 'involved', repos: '', host: '', ...over } as never }));
const bearers = () => h.fake.requests.map((r) => r.bearer);
const FILES = '/repos/acme-co/web/pulls/12/files?per_page=100&page=1';

after(() => h.done());
beforeEach(() => {
  for (const name of ['GITHUB_TOKEN', 'GH_TOKEN']) delete process.env[name];
  rmFile(h.savedTokenFile);
  h.signedInWith(null);
  h.fake.requests.length = 0;
  Object.assign(h.world, { viewer: { login: 'frank-gh', name: 'Frank Foster', scopes: 'repo, read:org' } });
  github.resetGithubLimits();
  github.forgetGithubToken();
  settle();
});

const rmFile = (path: string): void => rmSync(path, { force: true });

const filesUnder = (dir: string): string[] => readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);

const saveToken = (token: string) => {
  mkdirSync(dirname(h.savedTokenFile), { recursive: true });
  writeFileSync(h.savedTokenFile, `${token}\n`);
};

test('the token comes from a pasted one first, then GITHUB_TOKEN, then GH_TOKEN, then gh, and says which', async () => {
  h.signedInWith(FROM_GH);
  process.env['GITHUB_TOKEN'] = FROM_ENV;
  process.env['GH_TOKEN'] = FROM_GH_ENV;
  saveToken(SAVED);
  assert.deepEqual(await github.githubToken(), { token: SAVED, source: 'saved' });
  rmFile(h.savedTokenFile);
  assert.deepEqual(await github.githubToken(), { token: FROM_ENV, source: 'GITHUB_TOKEN' });
  delete process.env['GITHUB_TOKEN'];
  assert.deepEqual(await github.githubToken(), { token: FROM_GH_ENV, source: 'GH_TOKEN' });
  assert.deepEqual(h.ghCalls(), [], 'gh is asked only when nothing earlier is there');
  delete process.env['GH_TOKEN'];
  assert.deepEqual(await github.githubToken(), { token: FROM_GH, source: 'gh' });
  assert.deepEqual(h.ghCalls(), ['auth token --hostname github.com']);
  h.signedInWith(null);
  github.forgetGithubToken();
  assert.equal(await github.githubToken(), null);
});

test('a token from gh is held in memory and written nowhere, and gh is asked once however many calls follow', async () => {
  h.signedInWith(FROM_GH);
  await github.viewerLogin();
  await github.rest(FILES);
  assert.deepEqual(new Set(bearers()), new Set([FROM_GH]));
  assert.equal(h.ghCalls().length, 1);
  assert.deepEqual(filesUnder(h.home), []);
  assert.equal(existsSync(h.savedTokenFile), false);
});

test('every request names the API version and the app, carries the token as a bearer and has a time limit', async () => {
  process.env['GITHUB_TOKEN'] = FROM_ENV;
  await github.viewerLogin();
  const [sent] = h.fake.requests;
  assert.deepEqual([sent!.method, sent!.path, sent!.bearer, sent!.timed], ['POST', '/graphql', FROM_ENV, true]);
  assert.deepEqual([sent!.headers['accept'], sent!.headers['x-github-api-version'], sent!.headers['user-agent'], sent!.headers['content-type']], ['application/vnd.github+json', '2022-11-28', 'Underlings', 'application/json']);
});

test('with no token anywhere the read says how to get one, and asks GitHub nothing', async () => {
  await assert.rejects(github.viewerLogin(), /there is no GitHub token. Paste one in Setup, set GITHUB_TOKEN, or sign in with gh auth login/);
  assert.equal(h.fake.count(), 0);
});

test('a token gh gave that GitHub refuses is asked for again once, and the new one is used', async () => {
  h.signedInWith([FROM_GH, 'gho_renewedrenewedrenewedrenewedrene']);
  h.fake.inject({ op: 'Viewer' }, { status: 401, body: { message: 'Bad credentials' } });
  assert.equal(await github.viewerLogin(), 'frank-gh');
  assert.deepEqual(bearers(), [FROM_GH, 'gho_renewedrenewedrenewedrenewedrene']);
  assert.equal(h.ghCalls().length, 2);
});

test('a pasted token that GitHub refuses is reported as wrong, revoked or expired, and is not swapped for another', async () => {
  saveToken(SAVED);
  process.env['GITHUB_TOKEN'] = FROM_ENV;
  h.fake.inject({ op: 'Viewer' }, { status: 401, body: { message: 'Bad credentials' } });
  await assert.rejects(github.viewerLogin(), { message: 'GitHub refused the token (401): it is wrong, revoked or expired' });
  assert.deepEqual(bearers(), [SAVED]);
  assert.deepEqual(h.ghCalls(), []);
});

test('Setup learns who the token is and what it may do from the user call, and a fine-grained token lists no scopes', async () => {
  process.env['GITHUB_TOKEN'] = FROM_ENV;
  assert.deepEqual(await github.checkToken(), { source: 'GITHUB_TOKEN', login: 'frank-gh', scopes: ['repo', 'read:org'], status: 200, sso: null });
  Object.assign(h.world.viewer, { scopes: null });
  assert.deepEqual(await github.checkToken(), { source: 'GITHUB_TOKEN', login: 'frank-gh', scopes: null, status: 200, sso: null });
  Object.assign(h.world.viewer, { scopes: 'read:user' });
  assert.deepEqual((await github.checkToken())?.scopes, ['read:user']);
  assert.deepEqual(h.fake.requests.map((r) => [r.method, r.path]), [['GET', '/user'], ['GET', '/user'], ['GET', '/user']]);
});

test('Setup with no token finds none, with a refused token says 401, and under single sign-on says which organisation to authorise it for', async () => {
  assert.equal(await github.checkToken(), null);
  process.env['GITHUB_TOKEN'] = FROM_ENV;
  h.fake.inject({ path: '/user' }, { status: 401, body: { message: 'Bad credentials' } });
  assert.deepEqual(await github.checkToken(), { source: 'GITHUB_TOKEN', login: null, scopes: null, status: 401, sso: null });
  Object.assign(h.world.viewer, { sso: 'https://github.com/orgs/acme-co/sso?authorization_request=ABC123' });
  const check = await github.checkToken();
  assert.equal(check?.status, 403);
  assert.equal(check?.sso, "authorise this token for acme-co's single sign-on: https://github.com/orgs/acme-co/sso?authorization_request=ABC123");
});

test('a read refused for single sign-on says so and where to authorise, not just 403', async () => {
  process.env['GITHUB_TOKEN'] = FROM_ENV;
  h.fake.inject({ op: 'Involved' }, { status: 403, body: { message: 'Resource protected by organization SAML enforcement.' }, headers: { 'x-github-sso': 'required; url=https://github.com/orgs/acme-co/sso?authorization_request=XYZ' } });
  await assert.rejects(github.graphql('query Involved { viewer { login } }'), { message: "GitHub: authorise this token for acme-co's single sign-on: https://github.com/orgs/acme-co/sso?authorization_request=XYZ" });
});

test('an Enterprise host is reached for REST and GraphQL at its own paths, and gh is asked for that host', async () => {
  settle({ host: 'ghe.acme.test/api/v3/' });
  h.signedInWith(FROM_GH);
  const seen: string[] = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push(String(input));
    const to = String(input).replace('https://ghe.acme.test/api/v3', 'https://api.github.com').replace('https://ghe.acme.test/api/graphql', 'https://api.github.com/graphql');
    return h.fake.fetch(to, init);
  }) as typeof fetch;
  try {
    assert.equal(await github.viewerLogin(), 'frank-gh');
    await github.rest(FILES);
  } finally {
    globalThis.fetch = h.fake.fetch;
  }
  assert.deepEqual(seen, ['https://ghe.acme.test/api/graphql', 'https://ghe.acme.test/api/v3/repos/acme-co/web/pulls/12/files?per_page=100&page=1']);
  assert.deepEqual(h.ghCalls(), ['auth token --hostname ghe.acme.test']);
  assert.equal(github.githubWeb(), 'https://ghe.acme.test');
});

test('the host defaults to api.github.com, and a host that is not a web address falls back to it', () => {
  assert.deepEqual([github.githubApi(), github.githubWeb(), github.githubGraphqlUrl()], ['https://api.github.com', 'https://github.com', 'https://api.github.com/graphql']);
  settle({ host: 'ftp://nope' });
  assert.equal(github.githubApi(), 'https://api.github.com');
});
