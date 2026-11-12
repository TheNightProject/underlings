import { emptyWorld } from './fakegithub.mjs';

const T = (hours) => new Date(Date.parse('2026-11-10T12:00:00Z') - hours * 3_600_000).toISOString();

const PATCH = '@@ -10,3 +10,4 @@ export function lookup(id) {\n export function lookup(id) {\n-  return cache.get(id);\n+  const hit = cache.get(id);\n+  return hit ?? load(id);\n }';

const TOKEN_FILE = [...Array.from({ length: 9 }, (_, n) => `// line ${n + 1}`), 'export function lookup(id) {', '  const hit = cache.get(id);', '  return hit ?? load(id);', '}', ''].join('\n');

const pr = (over) => ({
  state: 'OPEN', isDraft: false, mergeable: 'MERGEABLE', mergeStateStatus: 'CLEAN', reviewDecision: null, requested: [], assignees: [], mentions: [],
  reviews: [], threads: [], comments: [], files: [], checks: [], statuses: [], runs: [], rollup: null, baseRefName: 'main', body: '', ...over,
});

/** Someone else's pull request that asks you for a review, with a thread, a review and an Actions run on it. */
const ASKED = pr({
  repo: 'acme-co/web', number: 12, title: 'Cache the token lookup', author: 'ivan', headRefName: 'ivan/cache-lookup', headRefOid: 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0',
  createdAt: T(30), updatedAt: T(2), requested: ['frank-gh'], mergeStateStatus: 'BLOCKED', reviewDecision: 'REVIEW_REQUIRED', rollup: 'SUCCESS', runs: [9001],
  body: 'Adds a cache in front of `lookup`.\n\nCloses acme-co/web#9. See also acme-co/engine#7.',
  reviews: [{ id: 301, author: 'trent', state: 'COMMENTED', body: 'Looks close, two questions below.', createdAt: T(20) }],
  threads: [{ id: 'PRRT_kwDOAA', isResolved: false, path: 'src/token.ts', line: 12, side: 'RIGHT', comments: [{ id: 401, author: 'trent', body: 'Does this expire?', createdAt: T(19) }, { id: 402, author: 'ivan', body: 'Not yet, next MR.', createdAt: T(18) }] }],
  comments: [{ id: 501, author: 'ivan', body: 'Rebased on main.', createdAt: T(6) }],
  files: [{ filename: 'src/token.ts', patch: PATCH }, { filename: 'src/cache.ts', status: 'added', patch: '@@ -0,0 +1,3 @@\n+export const cache = new Map();\n+export const clear = () => cache.clear();\n+' }, { filename: 'dist/bundle.js', patch: undefined }],
  checks: [
    { id: 7001, name: 'build', status: 'COMPLETED', conclusion: 'SUCCESS', runId: 9001, workflow: 'CI', startedAt: T(2.2), completedAt: T(2.1), detailsUrl: 'https://github.com/acme-co/web/actions/runs/9001/job/7001', required: true },
    { id: 7002, name: 'test', status: 'COMPLETED', conclusion: 'SUCCESS', runId: 9001, workflow: 'CI', startedAt: T(2.2), completedAt: T(2), detailsUrl: 'https://github.com/acme-co/web/actions/runs/9001/job/7002', required: true },
    { id: 7003, name: 'Vercel', status: 'COMPLETED', conclusion: 'NEUTRAL', app: 'Vercel', slug: 'vercel', detailsUrl: 'https://vercel.com/acme-co/web/abc', required: false },
  ],
  statuses: [{ id: 'SC_kwDOAA', context: 'ci/license', state: 'SUCCESS', createdAt: T(2), creator: 'license-bot', targetUrl: 'https://license.example/acme-co/web/12' }],
});

/** Your own pull request, red, and asked of nobody yet. */
const MINE = pr({
  repo: 'acme-co/web', number: 15, title: 'Retry the token refresh once', author: 'frank-gh', headRefName: 'frank/retry-refresh', headRefOid: 'b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0a1',
  createdAt: T(50), updatedAt: T(4), mergeStateStatus: 'BLOCKED', reviewDecision: 'APPROVED', rollup: 'FAILURE', runs: [9002], assignees: ['frank-gh'],
  reviews: [{ id: 302, author: 'ivan', state: 'APPROVED', body: '', createdAt: T(10) }],
  files: [{ filename: 'src/refresh.ts', patch: PATCH }],
  checks: [{ id: 7101, name: 'test', status: 'COMPLETED', conclusion: 'FAILURE', runId: 9002, workflow: 'CI', startedAt: T(4.3), completedAt: T(4), required: true }],
});

/** Yours, with changes requested. */
const CHANGES = pr({
  repo: 'octo/web', number: 3, title: 'Move the config loader', author: 'frank-gh', headRefName: 'frank/config', headRefOid: 'c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0a1b2',
  createdAt: T(90), updatedAt: T(8), reviewDecision: 'CHANGES_REQUESTED', mergeStateStatus: 'BLOCKED', rollup: 'SUCCESS',
  reviews: [{ id: 303, author: 'trent', state: 'CHANGES_REQUESTED', body: 'The loader reads the file twice.', createdAt: T(9) }],
});

/** A draft in a repo that shares its name with a GitLab one; you are only mentioned. */
const MENTIONED = pr({
  repo: 'acme-co/engine', number: 7, title: 'Draft: split the engine', author: 'rupert', headRefName: 'rupert/split', headRefOid: 'd4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0a1b2c3',
  createdAt: T(12), updatedAt: T(1), isDraft: true, mentions: ['frank-gh'], mergeStateStatus: 'DRAFT', rollup: 'PENDING',
});

/** Assigned to you, in conflict. */
const CONFLICT = pr({
  repo: 'octo/api', number: 21, title: 'Bump the client', author: 'dependabot[bot]', headRefName: 'dependabot/npm/client', headRefOid: 'e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0a1b2c3d4',
  createdAt: T(200), updatedAt: T(20), assignees: ['frank-gh'], mergeable: 'CONFLICTING', mergeStateStatus: 'DIRTY', rollup: 'SUCCESS',
});

/** GitHub has not worked out whether it merges yet. */
const UNKNOWN = pr({
  repo: 'acme-co/web', number: 18, title: 'Trim the intro copy', author: 'frank-gh', headRefName: 'frank/intro', headRefOid: 'f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5',
  createdAt: T(3), updatedAt: T(0.5), mergeable: 'UNKNOWN', mergeStateStatus: 'UNKNOWN', rollup: 'PENDING',
});

export const PRS = { ASKED, MINE, CHANGES, MENTIONED, CONFLICT, UNKNOWN };

const repo = (owner, name, databaseId, hours = 5) => ({ owner, name, databaseId, pushedAt: T(hours) });

/** frank-gh in one organisation, with three repos that have open pull requests, two of them named alike across owners. */
export function githubWorld(over = {}) {
  return {
    ...emptyWorld('frank-gh'),
    orgs: ['acme-co'],
    repos: [repo('acme-co', 'web', 501), repo('acme-co', 'engine', 502), repo('octo', 'web', 503), repo('octo', 'api', 504, 24 * 200)],
    prs: Object.values(PRS).map((p) => structuredClone(p)),
    logs: { 7002: '2026-11-10T09:58:01.0000000Z ##[group]Run npm test\n2026-11-10T09:58:01.5000000Z \u001b[36;1mnpm test\u001b[0m\n2026-11-10T09:58:02.0000000Z ##[endgroup]\n2026-11-10T09:58:03.0000000Z 42 passing\n2026-11-10T09:58:04.0000000Z ##[error]Process completed with exit code 1.\n' },
    files: { 'acme-co/web@a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0:src/token.ts': TOKEN_FILE },
    compares: { 'acme-co/web:main...a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0': { status: 'diverged', ahead_by: 2, behind_by: 3, total_commits: 2, files: [{ filename: 'src/token.ts' }] } },
    ...over,
  };
}
