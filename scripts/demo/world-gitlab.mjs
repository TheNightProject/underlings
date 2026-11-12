import { goldenWorld } from '../../lib/fixtures/gitlab-golden/world.mjs';

const GOLDEN_NOW = Date.parse('2026-11-10T10:00:00Z');
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z$/;
const HOUR = 3_600_000;

function shifted(value, by) {
  if (typeof value === 'string') return ISO.test(value) ? new Date(Date.parse(value) + by).toISOString() : value;
  if (Array.isArray(value)) return value.map((v) => shifted(v, by));
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, shifted(v, by)]));
  return value;
}

const mr = (fields) => ({
  state: 'opened', draft: false, conflicts: false, approvedBy: [], reviewStates: {}, autoMerge: false, targetBranch: 'main', behind: 0,
  description: '', mergedAt: null, mergedBy: null, rebasing: false, discussions: [], diffs: [], ...fields,
});

const job = (id, name, stage, status, duration) => ({ id, name, stage, status, duration });

const AUDIT_DIFF = [
  '@@ -22,4 +22,5 @@ export async function listAudit(db, query) {',
  '   const limit = Number(query.limit ?? 50);',
  "-  const rows = await db.all('select * from audit order by id desc');",
  '+  const offset = Number(query.page ?? 0) * limit;',
  '+  const rows = await db.all(`select * from audit order by id desc limit ${limit} offset ${offset}`);',
  '   return rows.map(toEntry);',
  ' }',
].join('\n');

export const AUDIT_HUNK = AUDIT_DIFF;

function openExtras(at) {
  const ago = (hours) => new Date(at - hours * HOUR).toISOString();
  return [
    mr({
      projectId: 1004, path: 'acme/api', iid: 41, title: 'ABC-112 Paginate the audit endpoint', author: 'trent', reviewers: ['frank'], sha: 'a41aa41a', sourceBranch: 'feat/ABC-112-audit-paging',
      pipeline: { id: 4041, status: 'RUNNING' }, mergeStatus: 'CI_STILL_RUNNING', createdAt: ago(20), updatedAt: ago(2), description: 'Pages the audit list.',
      diffs: [{ old_path: 'src/audit/list.ts', new_path: 'src/audit/list.ts', diff: AUDIT_DIFF }],
    }),
    mr({
      projectId: 1004, path: 'acme/api', iid: 44, title: 'ABC-113 Rate limit by tenant', author: 'frank', reviewers: ['rupert', 'ivan'], approvedBy: ['rupert'], reviewStates: { rupert: 'APPROVED', ivan: 'UNREVIEWED' },
      sha: 'a44aa44a', sourceBranch: 'feat/ABC-113-rate-limit', pipeline: { id: 4044, status: 'RUNNING' }, mergeStatus: 'CI_STILL_RUNNING', createdAt: ago(30), updatedAt: ago(3), description: 'Limits each tenant.',
    }),
    mr({
      projectId: 1005, path: 'acme/mobile', iid: 15, title: 'ABC-114 Offline queue for uploads', author: 'trent', reviewers: ['frank', 'ivan'], reviewStates: { ivan: 'REQUESTED_CHANGES', frank: 'UNREVIEWED' },
      sha: 'm15am15a', sourceBranch: 'feat/ABC-114-offline-queue', pipeline: { id: 5015, status: 'SUCCESS' }, mergeStatus: 'REQUESTED_CHANGES', createdAt: ago(52), updatedAt: ago(5),
      discussions: [{ id: 'd1501', notes: [{ id: 15011, author: 'ivan', body: 'What happens to a queued upload when the app is killed?', created_at: ago(6), system: false, resolvable: true, resolved: false }] }],
    }),
    mr({
      projectId: 1002, path: 'acme/web', iid: 25, title: 'ABC-116 Dark mode for the dashboard', author: 'frank', reviewers: ['ivan'], sha: 'w25aw25a', sourceBranch: 'feat/ABC-116-dark-mode',
      pipeline: { id: 2025, status: 'SUCCESS' }, mergeStatus: 'NOT_APPROVED', createdAt: ago(8), updatedAt: ago(1), description: 'Follows the system theme.',
    }),
    mr({
      projectId: 1003, path: 'acme/tools/cli', iid: 4, title: 'ABC-117 Colourise the help output', author: 'trent', reviewers: ['frank'], sha: 'c4a0c4a0', sourceBranch: 'feat/ABC-117-help-colour',
      pipeline: { id: 3004, status: 'SUCCESS' }, mergeStatus: 'NOT_APPROVED', createdAt: ago(14), updatedAt: ago(4), description: 'Colours the help.',
    }),
  ];
}

function mergedExtras(at) {
  const days = (n) => new Date(at - n * 24 * HOUR).toISOString();
  const merged = (projectId, path, iid, title, author, ago) => mr({
    projectId, path, iid, title, author, reviewers: ['frank'], state: 'merged', sha: `m${iid}a${iid}`, sourceBranch: `feat/${title.split(' ')[0]}`, pipeline: { id: projectId * 10 + iid, status: 'SUCCESS' },
    mergeStatus: 'MERGEABLE', createdAt: days(ago + 3), updatedAt: days(ago), mergedAt: days(ago), mergedBy: author,
  });
  return [
    merged(1004, 'acme/api', 38, 'ABC-111 Rotate the signing key', 'rupert', 2),
    merged(1001, 'acme/engine', 9, 'ABC-115 Speed up the cold start', 'rupert', 3),
    merged(1002, 'acme/web', 19, 'ABC-122 Trim the onboarding emails', 'trent', 5),
    merged(1004, 'acme/api', 36, 'ABC-123 Fix the timezone in reports', 'ivan', 6),
    merged(1001, 'acme/engine', 8, 'ABC-124 Cache the avatar lookups', 'ivan', 9),
    merged(1003, 'acme/tools/cli', 2, 'ABC-125 Upgrade the build image', 'trent', 12),
  ];
}

export function gitlabWorld(at = Date.now()) {
  const world = shifted(goldenWorld(), at - GOLDEN_NOW);
  world.jira = null;
  world.projects.push({ id: 1004, fullPath: 'acme/api', name: 'api' }, { id: 1005, fullPath: 'acme/mobile', name: 'mobile' });
  world.mrs.push(...openExtras(at), ...mergedExtras(at));
  world.pipelines.a41aa41a = { id: 4041, jobs: [job(40411, 'build', 'build', 'success', 52), job(40412, 'test', 'test', 'running', null)] };
  world.pipelines.a44aa44a = { id: 4044, jobs: [job(40441, 'build', 'build', 'success', 49), job(40442, 'test', 'test', 'running', null)] };
  return world;
}

export const WORKSPACE_REPOS = [['engine', 'acme/engine'], ['web', 'acme/web'], ['cli', 'acme/tools/cli'], ['api', 'acme/api'], ['mobile', 'acme/mobile']];
