import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'thematrix-myrepos-'));
process.env['UNDERLINGS_STATE_DIR'] = dir;
process.env['GITLAB_TOKEN'] = 'not-a-real-token';

const MINUTE = 60_000;
const DISCOVERED = '2026-11-16T08:00:00.000Z';

// GitLab at its boundary: the one query that names your MRs' projects, counted, and nothing else.
let mine: string[] | Error = [];
let asked = 0;
const realFetch = globalThis.fetch;
globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
  const { query } = JSON.parse(String(init?.body ?? '{}')) as { query?: string };
  if (!query?.startsWith('query Mine')) throw new Error(`not asked in this test: ${query ?? 'a REST call'}`);
  asked += 1;
  if (mine instanceof Error) return new Response('down', { status: 502, statusText: 'Bad Gateway' });
  const nodes = mine.map((fullPath) => ({ project: { fullPath } }));
  return Response.json({ data: { currentUser: { authored: { nodes }, assigned: { nodes: [] }, reviewing: { nodes: [{ project: null }] } } } });
}) as typeof fetch;
after(() => {
  globalThis.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
});

const { currentRepos } = await import('./inbox.js');
const { changeSettings } = await import('./data/store.js');

const cacheFile = join(dir, 'repos.json');
const cached = (): { at: string; repos: { path: string; label: string }[] } => JSON.parse(readFileSync(cacheFile, 'utf8'));
const paths = (repos: { path: string }[]): string[] => repos.map((r) => r.path);
let clock = Date.parse(DISCOVERED) + MINUTE;
const later = (minutes: number): number => (clock += minutes * MINUTE);

beforeEach(() => {
  writeFileSync(cacheFile, JSON.stringify({ at: new Date().toISOString(), repos: [{ path: 'acme/engine', label: 'engine', openCount: 4 }] }));
  changeSettings((s) => ({ ...s, repoFilter: '' }));
  mine = [];
  asked = 0;
});

test('a repo that had no open MR when repos were found joins as soon as an MR of yours opens there', async () => {
  const at = cached().at;
  mine = ['acme/engine', 'acme/tools'];
  assert.deepEqual(paths(await currentRepos(later(10))), ['acme/engine', 'acme/tools']);
  assert.deepEqual(paths(cached().repos), ['acme/engine', 'acme/tools'], 'and it is kept');
  assert.equal(cached().at, at, 'without making the list any younger, so the daily look still comes');
});

test('a newcomer whose name another repo has is labelled apart, as the next discovery would', async () => {
  mine = ['other/engine'];
  const repos = await currentRepos(later(10));
  const labels = repos.map((r) => r.label);
  assert.equal(new Set(labels).size, 2, labels.join());
});

test('your MRs\' projects are asked for at most every five minutes', async () => {
  await currentRepos(later(10));
  await currentRepos(later(4));
  assert.equal(asked, 1);
  await currentRepos(later(1));
  assert.equal(asked, 2);
});

test('a lookup GitLab fails leaves the list as it was', async () => {
  mine = new Error('down');
  assert.deepEqual(paths(await currentRepos(later(10))), ['acme/engine']);
  assert.deepEqual(paths(cached().repos), ['acme/engine']);
});

test('the Repos filter still narrows a repo found this way', async () => {
  changeSettings((s) => ({ ...s, repoFilter: 'engine' }));
  mine = ['acme/tools'];
  assert.deepEqual(paths(await currentRepos(later(10))), ['acme/engine']);
  assert.deepEqual(paths(cached().repos), ['acme/engine', 'acme/tools'], 'though it is known, for when the filter takes it');
});

test('a pattern in the filter that no repo found matches is named, and an exclusion never is', async () => {
  const { unmatchedPatterns } = await import('./settings.js');
  const repos = [{ path: 'acme/engine', label: 'engine' }, { path: 'acme/web', label: 'web' }];
  assert.deepEqual(unmatchedPatterns(repos, 'engine, tools, acme/docs*, !legacy'), ['tools', 'acme/docs*']);
  assert.deepEqual(unmatchedPatterns(repos, ''), []);
});
