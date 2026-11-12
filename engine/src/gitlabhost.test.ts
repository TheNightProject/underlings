import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';

const state = mkdtempSync(join(tmpdir(), 'gitlab-host-'));
process.env['UNDERLINGS_STATE_DIR'] = state;
process.env['GITLAB_TOKEN'] = 'not-a-real-token';

const asked: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request) => {
  asked.push(String(input));
  const body = String(input).endsWith('/graphql') ? { data: { group: { mergeRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: [] } } } } : { username: 'ivan' };
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

const { fetchFile, fetchJobTrace, fetchMe, fetchMergedMrs } = await import('./data/gitlab.js');
const { changeSettings } = await import('./data/store.js');
const { gitlabHost, graphqlUrl, restUrl } = await import('./config.js');
const { DEFAULT_GITLAB } = await import('./settings.js');

after(() => {
  globalThis.fetch = realFetch;
  rmSync(state, { recursive: true, force: true });
});
beforeEach(() => {
  asked.length = 0;
  changeSettings((s) => ({ ...s, gitlab: DEFAULT_GITLAB }));
});

const useHost = (host: string) => changeSettings((s) => ({ ...s, gitlab: { host } }));

test('with no host set every URL is gitlab.com', () => {
  assert.deepEqual([gitlabHost(), restUrl(), graphqlUrl()], ['https://gitlab.com', 'https://gitlab.com/api/v4', 'https://gitlab.com/api/graphql']);
});

test('a self-hosted GitLab reaches REST, GraphQL, job logs and raw files at its own host', async () => {
  useHost('https://git.acme.test/gitlab');
  await fetchMe();
  await fetchMergedMrs('acme', '2026-11-01T00:00:00Z');
  await fetchJobTrace(7, 9).catch(() => null);
  await fetchFile(7, 'README.md', 'main').catch(() => null);
  assert.ok(asked.length >= 4);
  for (const url of asked) assert.ok(url.startsWith('https://git.acme.test/gitlab/api/'), url);
  assert.ok(asked.some((url) => url === 'https://git.acme.test/gitlab/api/graphql'));
});

test('a host read from the settings is tidied: the scheme added, a trailing slash taken off, and anything unusable falls back', () => {
  useHost('git.acme.test/');
  assert.equal(gitlabHost(), 'https://git.acme.test');
  useHost('http://10.0.0.5:8080');
  assert.equal(gitlabHost(), 'http://10.0.0.5:8080');
  useHost('https://git.acme.test/?x=1');
  assert.equal(gitlabHost(), 'https://gitlab.com');
});
