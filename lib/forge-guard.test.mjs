import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { test } from 'node:test';

const ROOT = new URL('../', import.meta.url);
const HOMES = new Set(['engine/src/data/gitlab.ts', 'engine/src/data/gitlab-forge.ts']);
const ALLOWED = {
  'engine/src/data/forge.ts': 'it re-exports the shared types, isHeld and its kin, which gitlab.ts defines, so no caller has to name gitlab.ts for them',
  'engine/src/engine.ts': 'it keeps the old GitLab exports, which a worker started before the seam goes on calling until it restarts',
  'engine/src/config.ts': "it builds GitLab's API addresses from the host in settings, and reads the token, for gitlab.ts and the adapter",
  'lib/setup.mjs': 'Setup asks the host who a token belongs to and what it may do, before the token is trusted for anything else',
};
const NOT_SHIPPED = /\.test\.|(?:^|\/)testkit\.|^lib\/workerproc\.mjs$|^engine\/src\/fixtures\//;
const IMPORTS_GITLAB = /(?:\bfrom|\bimport)\s*\(?\s*['"][^'"]*\/gitlab(?:\.js|\.ts)?['"]/;
const RAW_GITLAB = /\/api\/v4\b|\/api\/graphql\b|PRIVATE-TOKEN|\b(?:restUrl|graphqlUrl|gitlabToken)\b/;

async function shipped() {
  const dirs = [['engine/src/', true, /\.tsx?$/], ['lib/', false, /\.mjs$/], ['desktop/', false, /\.(?:mjs|cjs|js)$/]];
  const lists = await Promise.all(dirs.map(async ([dir, recursive, ext]) => (await readdir(new URL(dir, ROOT), { recursive })).filter((n) => ext.test(n)).map((n) => dir + n)));
  return ['worker.mjs', ...lists.flat()].filter((path) => !HOMES.has(path) && !NOT_SHIPPED.test(path) && !path.includes('node_modules'));
}

async function gitlabCalls() {
  const source = await readFile(new URL('engine/src/data/gitlab.ts', ROOT), 'utf8');
  return [...source.matchAll(/^export async function (\w+)/gm)].map(([, name]) => name);
}

function checksFor(calls) {
  const named = calls.join('|');
  const byName = new RegExp(`\\bengine\\??\\.(?:${named})\\b|\\b(?:requireEngine|supports)\\([^)]*['"](?:${named})['"]`);
  return [
    [IMPORTS_GITLAB, 'imports gitlab.ts instead of asking engine/src/data/forge.ts'],
    [byName, "asks the engine for a gitlab.ts call by name instead of forgeFor(ref) in lib/engine.mjs"],
    [RAW_GITLAB, "talks to GitLab's API itself instead of through the forge"],
  ];
}

function direct(text, checks) {
  return text.split('\n').flatMap((line, i) => checks.filter(([pattern]) => pattern.test(line)).map(([, what]) => `${i + 1}: ${what}: ${line.trim()}`));
}

test('nothing shipped reaches GitLab except through the forge, apart from the allowlist, each entry with its reason', async () => {
  const [files, calls] = await Promise.all([shipped(), gitlabCalls()]);
  assert.ok(files.includes('engine/src/inbox.ts') && files.includes('lib/ownmr.mjs') && files.includes('desktop/main.mjs'), 'the scan reaches every side');
  assert.ok(calls.includes('fetchOneMr') && calls.includes('setMergeHold') && calls.length > 30, 'every gitlab.ts call is named');
  const checks = checksFor(calls);
  const hits = await Promise.all(files.map(async (path) => [path, direct(await readFile(new URL(path, ROOT), 'utf8'), checks)]));
  const found = hits.filter(([path, lines]) => lines.length && !ALLOWED[path]).flatMap(([path, lines]) => lines.map((hit) => `${path}:${hit}`));
  assert.deepEqual(found, [], 'ask forgeOf(ref) in the engine, or forgeFor(ref) in the worker');
  const unneeded = Object.keys(ALLOWED).filter((path) => !hits.some(([file, lines]) => file === path && lines.length));
  assert.deepEqual(unneeded, [], 'an allowlist entry that no longer reaches GitLab directly comes off the list');
});

test('the check catches each way of reaching GitLab directly, and lets the forge and the neutral helpers through', async () => {
  const checks = checksFor(await gitlabCalls());
  const caught = [
    "import { fetchOneMr } from './data/gitlab.js';", "import type { Discussion } from '../data/gitlab.js';", "const gitlab = await import('./data/gitlab.js');",
    "export { setMergeHold } from './data/gitlab.js';", 'import { fetchMe } from "./gitlab";', 'await engine.fetchOneMr(mr.projectPath, mr.iid);',
    "const engine = requireEngine('fetchDiscussions', 'loadQueue');", "if (!supports('fetchMrEnd')) return;", 'engine?.setMergeHold(path, iid, true)',
    "await fetch(`${host}/api/v4/user`, { headers: { 'PRIVATE-TOKEN': token } });", 'fetch(`${host}/api/graphql`, init)', "import { restUrl } from '../config.js';",
    'headers: { Authorization: gitlabToken() }',
  ];
  for (const line of caught) assert.notDeepEqual(direct(line, checks), [], line);
  const fine = [
    "import { forgeOf, isHeld } from './data/forge.js';", "import { gitlabForge } from './gitlab-forge.js';", "import { gitlabHost } from './config.js';",
    "await forgeFor(mr, 'retryJob').retryJob(mr, job.id);", "requireEngine('decide', 'forgeOf', 'loadQueue');", "supports('isBotThread') && engine.isBotThread(d)",
    'engine.heldByMe(mr, me)', "const gitlab = { me: null, merged: null };", "if (forgeHas(GITLAB, 'end')) return;", "await readFile(gitlabTokenFile(), 'utf8')",
    "const link = `${host}/-/user_settings/personal_access_tokens`;",
  ];
  for (const line of fine) assert.deepEqual(direct(line, checks), [], line);
});
