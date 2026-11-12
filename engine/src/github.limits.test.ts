import assert from 'node:assert/strict';
import { after, beforeEach, mock, test } from 'node:test';
import { githubHarness } from './fixtures/github/harness.mjs';

const h = githubHarness();
process.env['GITHUB_TOKEN'] = 'ghp_0123456789abcdefghijklmnopqrstuv';

const github = await import('./data/github.js');
const NOW = Date.parse('2026-11-10T12:00:00Z');
const FILES = '/repos/acme-co/web/pulls/12/files?per_page=100&page=1';

const flush = async (): Promise<void> => {
  for (let i = 0; i < 6; i += 1) await new Promise((resolve) => setImmediate(resolve));
};
const limited = (status: number, headers: Record<string, string>) => ({ status, body: { message: 'API rate limit exceeded' }, headers });
const inOneHour = () => String(Math.floor(Date.now() / 1000) + 3600);

after(() => h.done());
beforeEach(() => {
  mock.timers.reset();
  mock.timers.enable({ apis: ['setTimeout', 'Date'], now: NOW });
  h.fake.requests.length = 0;
  h.world.clock = () => Date.now();
  github.resetGithubLimits();
  github.forgetGithubToken();
});

const res = (status: number, headers: Record<string, string> = {}) => new Response(null, { status, headers });

test('GitHub is left alone for as long as it asks: retry-after, else until the reset when none is left, else a fallback, and never for an ordinary refusal', () => {
  const reset = (seconds: number) => ({ 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(NOW / 1000 + seconds) });
  assert.deepEqual([
    github.waitAsked(res(429, { 'retry-after': '7' }), 1000, NOW),
    github.waitAsked(res(403, { 'retry-after': '2' }), 1000, NOW),
    github.waitAsked(res(403, reset(120)), 1000, NOW),
    github.waitAsked(res(403, reset(-30)), 1000, NOW),
    github.waitAsked(res(403, { 'x-ratelimit-remaining': '0' }), 1000, NOW),
    github.waitAsked(res(429), 4000, NOW),
    github.waitAsked(res(403, { 'x-ratelimit-remaining': '12' }), 1000, NOW),
    github.waitAsked(res(403), 1000, NOW),
    github.waitAsked(res(200, { 'retry-after': '5' }), 1000, NOW),
    github.waitAsked(res(502), 1000, NOW),
  ], [7000, 2000, 120_000, 0, 1000, 4000, null, null, null, null]);
});

test('a request limited with a retry-after is sent again once that long has passed, and not before', async () => {
  h.fake.inject({ op: 'Viewer' }, { status: 429, body: { message: 'secondary rate limit' }, headers: { 'retry-after': '3' } });
  const login = github.viewerLogin();
  await flush();
  assert.equal(h.fake.count(), 1);
  mock.timers.tick(2999);
  await flush();
  assert.equal(h.fake.count(), 1);
  mock.timers.tick(1);
  assert.equal(await login, 'frank-gh');
  assert.equal(h.fake.count(), 2);
});

test('with no retry-after a limit is retried after one, four and ten seconds, and then reported', async () => {
  h.fake.inject({ op: 'Viewer' }, ...Array(4).fill({ status: 429, body: { message: 'slow down' } }));
  const login = github.viewerLogin().catch((e: Error) => e);
  for (const [sent, wait] of [[1, 1000], [2, 4000], [3, 10_000]] as const) {
    await flush();
    assert.equal(h.fake.count(), sent);
    mock.timers.tick(wait - 1);
    await flush();
    assert.equal(h.fake.count(), sent, `still waiting just before ${wait}ms`);
    mock.timers.tick(1);
  }
  const error = await login;
  assert.match((error as Error).message, /^GitHub is rate limiting \(429\): poll less often or narrow GitHub repos$/);
  assert.equal(h.fake.count(), 4);
});

test('a wait longer than a minute is not slept through: one request, then nothing is sent until the reset', async () => {
  h.fake.inject({ op: 'Viewer' }, limited(403, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': inOneHour() }));
  await assert.rejects(github.viewerLogin(), /^Error: GitHub is rate limiting \(403\) until 13:00 UTC: poll less often or narrow GitHub repos$/);
  assert.equal(h.fake.count(), 1);
  await assert.rejects(github.viewerLogin(), { message: "GitHub's rate limit is spent until 13:00 UTC, so nothing is asked until then" });
  await assert.rejects(github.rest(FILES), /nothing is asked until then/);
  assert.equal(h.fake.count(), 1);
  assert.ok(github.githubLimits().blockedUntil);
  mock.timers.setTime(NOW + 3_601_000);
  assert.equal(await github.viewerLogin(), 'frank-gh');
  assert.equal(h.fake.count(), 2);
  assert.equal(github.githubLimits().blockedUntil, null);
});

test('GraphQL says it is limited in its body, with a 200, and that stops the asking too', async () => {
  h.fake.inject({ op: 'Viewer' }, { status: 200, body: { errors: [{ type: 'RATE_LIMITED', message: 'API rate limit already exceeded for user ID 4242.' }] }, headers: { 'x-ratelimit-reset': inOneHour() } });
  await assert.rejects(github.viewerLogin(), { message: "GitHub's GraphQL rate limit is spent until 13:00 UTC" });
  await assert.rejects(github.viewerLogin(), /nothing is asked until then/);
  assert.equal(h.fake.count(), 1);
});

test('GraphQL errors with no data are said in GitHub\'s words, and the cost of each query is kept', async () => {
  h.fake.inject({ op: 'Viewer' }, { status: 200, body: { errors: [{ message: "Field 'nope' doesn't exist on type 'User'" }, { message: 'second' }] } });
  await assert.rejects(github.viewerLogin(), { message: "GitHub GraphQL: Field 'nope' doesn't exist on type 'User'; second" });
  await github.viewerLogin();
  assert.deepEqual([github.githubLimits().lastCost, github.githubLimits().remaining], [1, 4990]);
  assert.equal(github.githubLimits().resetAt, new Date(NOW + 3_600_000).toISOString());
});

test('a server error says what GitHub said and which call it was', async () => {
  h.fake.inject({ op: 'Viewer' }, { status: 502, body: { message: 'Server Error' } });
  await assert.rejects(github.viewerLogin(), { message: 'GitHub 502 on GraphQL: Server Error' });
  h.fake.inject({ path: `/repos/acme-co/web/pulls/12/files` }, { status: 500, body: { message: 'Server Error' } });
  await assert.rejects(github.rest(FILES), { message: `GitHub 500 on ${FILES}: Server Error` });
});

test('no more than four requests are in flight at once, the rest waiting their turn', async () => {
  let live = 0;
  let peak = 0;
  let release = (): void => undefined;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    live += 1;
    peak = Math.max(peak, live);
    await gate;
    live -= 1;
    return h.fake.fetch(input, init);
  }) as typeof fetch;
  try {
    const all = Array.from({ length: 10 }, (_, n) => github.rest(`/repos/acme-co/web/pulls/12/files?per_page=100&page=${n + 1}`));
    await flush();
    assert.equal(peak, 4);
    release();
    await Promise.all(all);
  } finally {
    globalThis.fetch = h.fake.fetch;
  }
  assert.deepEqual([peak, h.fake.count()], [4, 10]);
});

test('a read asked again carries its last ETag, and a 304 answers with what was read before; a changed answer replaces it', async () => {
  const first = await github.rest<{ filename: string }[]>(FILES);
  const again = await github.rest<{ filename: string }[]>(FILES);
  assert.deepEqual(again, first);
  const [one, two] = h.fake.requests;
  assert.equal(one!.headers['if-none-match'], undefined);
  assert.match(String(two!.headers['if-none-match']), /^W\/"[0-9a-f]{16}"$/);
  h.world.prs.find((p: { number: number }) => p.number === 12).files.push({ filename: 'src/new.ts', patch: '@@ -0,0 +1 @@\n+x' });
  const changed = await github.rest<{ filename: string }[]>(FILES);
  assert.equal(changed.length, first.length + 1);
  assert.notEqual(h.fake.requests[2]!.headers['if-none-match'], undefined);
  assert.deepEqual(await github.rest(FILES), changed);
});

test('a write or a GraphQL query is never sent with an ETag', async () => {
  await github.viewerLogin();
  github.forgetGithubToken();
  await github.viewerLogin();
  assert.deepEqual(h.fake.requests.map((r) => r.headers['if-none-match']), [undefined, undefined]);
});
