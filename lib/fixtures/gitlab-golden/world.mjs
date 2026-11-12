// A function rather than a constant, as the fakes change the world while the session writes to it.
export const ME = 'frank';
export const HOST = 'https://gitlab.com';

const project = (id, fullPath) => ({ id, fullPath, name: fullPath.split('/').pop() });

export const PROJECTS = [project(1001, 'acme/engine'), project(1002, 'acme/web'), project(1003, 'acme/tools/cli')];

const USERS = { frank: 101, ivan: 102, rupert: 103, trent: 104 };

const note = (id, author, body, at, extra = {}) => ({ id, author, body, created_at: at, system: false, resolvable: false, ...extra });
const threadNote = (id, author, body, at, extra = {}) => note(id, author, body, at, { resolvable: true, resolved: false, ...extra });

const TOKEN_DIFF = [
  '@@ -10,4 +10,8 @@ export function lookup(id) {',
  ' export function lookup(id) {',
  '   const key = keyOf(id);',
  '-  return fetchToken(key);',
  '+  const hit = cache.get(key);',
  '+  if (hit) return hit;',
  '+  const token = fetchToken(key);',
  '+  cache.set(key, token);',
  '+  return token;',
  ' }',
].join('\n');

const CACHE_DIFF = ['@@ -0,0 +1,3 @@', '+export const cache = new Map();', '+', '+export const forget = (key) => cache.delete(key);'].join('\n');

const UPLOAD_DIFF = ['@@ -38,3 +38,5 @@ async function upload(file) {', '   for (;;) {', '-    await send(file);', '+    const sent = await send(file).catch(() => null);', '+    if (sent) return sent;', '   }'].join('\n');

const LINTER_DIFF = ['@@ -12,3 +12,3 @@', '   "devDependencies": {', '-    "eslint": "^9.38.0",', '+    "eslint": "^9.39.1",', '   }'].join('\n');

const TOKEN_FILE = [
  "import { cache } from './cache';",
  '',
  ...Array.from({ length: 7 }, (_, n) => `// line ${n + 3}`),
  'export function lookup(id) {',
  '  const key = keyOf(id);',
  '  const hit = cache.get(key);',
  '  if (hit) return hit;',
  '  const token = fetchToken(key);',
  '  cache.set(key, token);',
  '  return token;',
  '}',
  '',
].join('\n');

const TRACE = [
  '\u001b[0Ksection_start:1762768800:prepare_script\r\u001b[0K\u001b[36;1mPreparing the job\u001b[0;m',
  'Running with gitlab-runner 18.4.0',
  '\u001b[0Ksection_end:1762768801:prepare_script\r\u001b[0K',
  '$ npm test',
  'upload retries',
  '  \u001b[32m✔\u001b[0m sends once',
  '  \u001b[31m✖\u001b[0m backs off between tries',
  'Retrying 1/3\rRetrying 2/3\rRetrying 3/3',
  '1 failing',
  'ERROR: Job failed: exit code 1',
  '',
].join('\n');

function mr(fields) {
  return {
    state: 'opened', draft: false, conflicts: false, approvedBy: [], reviewStates: {}, autoMerge: false, targetBranch: 'main', behind: 0,
    description: '', mergedAt: null, mergedBy: null, rebasing: false, discussions: [], diffs: [], ...fields,
  };
}

function openMrs() {
  return [
    mr({
      projectId: 1001, path: 'acme/engine', iid: 7, title: 'ABC-101 Cache the token lookup', author: 'ivan', reviewers: ['frank', 'rupert'], approvedBy: ['rupert'],
      reviewStates: { frank: 'REVIEWED', rupert: 'APPROVED' }, sha: 'e7a1e7a1', sourceBranch: 'feat/ABC-101-token-cache', pipeline: { id: 7001, status: 'FAILED' },
      mergeStatus: 'DISCUSSIONS_NOT_RESOLVED', createdAt: '2026-11-06T09:00:00Z', updatedAt: '2026-11-10T08:30:00Z',
      description: 'Caches the token lookup.\r\n\r\n<!-- What does this change? -->\r\nCloses ABC-101.\n\n\n\nTested by hand.',
      discussions: [
        { id: 'd701', notes: [
          threadNote(7011, 'frank', 'This lookup misses the cache when the key has a prefix.', '2026-11-07T10:00:00Z', { position: { new_path: 'src/token.ts', old_path: 'src/token.ts', new_line: 12, head_sha: 'e7a0e7a0' } }),
          threadNote(7012, 'ivan', 'Done, the prefix is stripped first now.', '2026-11-09T15:00:00Z'),
        ] },
        { id: 'd702', notes: [
          threadNote(7021, 'rupert', 'Could this use the shared cache instead?', '2026-11-08T11:00:00Z'),
          threadNote(7022, 'ivan', 'It could, but the shared one has no expiry.', '2026-11-08T12:00:00Z'),
        ] },
        { id: 'd703', notes: [note(7031, 'ivan', 'added 1 commit', '2026-11-09T14:59:00Z', { system: true })] },
        { id: 'd704', notes: [note(7041, 'ivan', 'Ready for another look.', '2026-11-09T15:01:00Z')] },
      ],
      diffs: [
        { old_path: 'src/token.ts', new_path: 'src/token.ts', diff: TOKEN_DIFF },
        { old_path: 'src/cache.ts', new_path: 'src/cache.ts', diff: CACHE_DIFF },
      ],
    }),
    mr({
      projectId: 1001, path: 'acme/engine', iid: 12, title: 'Draft: ABC-102 Retry the upload', author: 'frank', reviewers: ['rupert'], draft: true,
      sha: 'e12ae12a', sourceBranch: 'fix/ABC-102-retry-upload', pipeline: { id: 7012, status: 'FAILED' }, mergeStatus: 'DRAFT_STATUS', behind: 3,
      createdAt: '2026-11-08T09:00:00Z', updatedAt: '2026-11-10T07:45:00Z', description: 'Retries a failed upload.',
      discussions: [
        { id: 'd1201', notes: [threadNote(12011, 'rupert', 'This retry never backs off.', '2026-11-09T09:30:00Z', { position: { new_path: 'src/upload.ts', old_path: 'src/upload.ts', new_line: 40, head_sha: 'e12ae12a' } })] },
        { id: 'd1202', notes: [threadNote(12021, 'rupert', 'Is the old helper still used?', '2026-11-09T09:40:00Z', { resolved: true }), threadNote(12022, 'frank', 'No, it is gone.', '2026-11-09T10:00:00Z', { resolved: true })] },
      ],
      diffs: [{ old_path: 'src/upload.ts', new_path: 'src/upload.ts', diff: UPLOAD_DIFF }],
    }),
    mr({
      projectId: 1002, path: 'acme/web', iid: 21, title: 'ABC-103 Show the empty state', author: 'frank', reviewers: ['ivan'], approvedBy: ['ivan'], reviewStates: { ivan: 'APPROVED' },
      sha: 'w21aw21a', sourceBranch: 'feat/ABC-103-empty-state', pipeline: { id: 2021, status: 'SUCCESS' }, mergeStatus: 'MERGEABLE',
      createdAt: '2026-11-05T09:00:00Z', updatedAt: '2026-11-09T16:00:00Z', description: 'Shows the empty state.',
    }),
    mr({
      projectId: 1002, path: 'acme/web', iid: 22, title: 'ABC-104 Move the settings page', author: 'frank', reviewers: ['ivan'], conflicts: true,
      sha: 'w22aw22a', sourceBranch: 'feat/ABC-104-settings-move', pipeline: { id: 2022, status: 'SUCCESS' }, mergeStatus: 'CONFLICT', behind: 9,
      createdAt: '2026-11-04T09:00:00Z', updatedAt: '2026-11-09T11:00:00Z', description: 'Moves the settings page.',
    }),
    mr({
      projectId: 1003, path: 'acme/tools/cli', iid: 3, title: 'ABC-105 Add a dry run flag', author: 'frank', reviewers: ['ivan', 'rupert'], reviewStates: { ivan: 'REQUESTED_CHANGES', rupert: 'UNREVIEWED' },
      sha: 'c3a0c3a0', sourceBranch: 'feat/ABC-105-dry-run', pipeline: { id: 3003, status: 'RUNNING' }, mergeStatus: 'CI_STILL_RUNNING', behind: 2,
      createdAt: '2026-11-07T09:00:00Z', updatedAt: '2026-11-10T09:00:00Z', description: 'Adds --dry-run.',
    }),
    mr({
      projectId: 1002, path: 'acme/web', iid: 30, title: 'Bump the linter', author: 'rupert', reviewers: ['frank'], sha: 'w30aw30a', sourceBranch: 'chore/bump-linter',
      pipeline: { id: 2030, status: 'SUCCESS' }, mergeStatus: 'NOT_APPROVED', createdAt: '2026-11-09T13:00:00Z', updatedAt: '2026-11-10T09:30:00Z',
      diffs: [{ old_path: 'package.json', new_path: 'package.json', diff: LINTER_DIFF }],
    }),
  ];
}

function mergedMrs() {
  return [
    mr({
      projectId: 1002, path: 'acme/web', iid: 18, title: 'ABC-106 Fix the login redirect', author: 'frank', reviewers: ['ivan'], state: 'merged', sha: 'w18aw18a', sourceBranch: 'fix/ABC-106-login',
      pipeline: { id: 2018, status: 'SUCCESS' }, mergeStatus: 'MERGEABLE', createdAt: '2026-11-03T09:00:00Z', updatedAt: '2026-11-09T14:00:00Z', mergedAt: '2026-11-09T14:00:00Z', mergedBy: 'frank',
    }),
    mr({
      projectId: 1001, path: 'acme/engine', iid: 5, title: 'ABC-110 Export the audit log', author: 'ivan', reviewers: ['frank'], state: 'merged', sha: 'e5a0e5a0', sourceBranch: 'feat/ABC-110-audit-export',
      pipeline: { id: 7005, status: 'SUCCESS' }, mergeStatus: 'MERGEABLE', createdAt: '2026-11-01T09:00:00Z', updatedAt: '2026-11-06T10:00:00Z', mergedAt: '2026-11-06T10:00:00Z', mergedBy: 'rupert',
    }),
  ];
}

const job = (id, name, stage, status, duration, extra = {}) => ({ id, name, stage, status, duration, ...extra });

function pipelines() {
  return {
    'e7a1e7a1': { id: 7001, jobs: [job(70011, 'build', 'build', 'success', 61.2), job(70012, 'test', 'test', 'failed', 140.5), job(70013, 'lint', 'test', 'success', 20)] },
    'e12ae12a': { id: 7012, jobs: [job(120011, 'build', 'build', 'success', 58), job(120012, 'test', 'test', 'failed', 133.4), job(120013, 'e2e', 'test', 'failed', 300, { allow_failure: true })] },
    'w21aw21a': { id: 2021, jobs: [job(20211, 'build', 'build', 'success', 40)] },
    'c3a0c3a0': { id: 3003, jobs: [job(30031, 'build', 'build', 'success', 30), job(30032, 'test', 'test', 'running', null)] },
  };
}

function events() {
  const at = (time) => `2026-11-09T${time}Z`;
  return [
    { action_name: 'opened', project_id: 1001, target_type: 'MergeRequest', target_iid: 12, target_title: 'Draft: ABC-102 Retry the upload', author: { username: 'frank' }, created_at: at('09:05:00') },
    { action_name: 'commented on', project_id: 1001, target_type: 'Note', target_title: 'ABC-101 Cache the token lookup', note: { noteable_type: 'MergeRequest', noteable_iid: 7 }, author: { username: 'frank' }, created_at: at('10:00:00') },
    { action_name: 'approved', project_id: 1002, target_type: 'MergeRequest', target_iid: 30, target_title: 'Bump the linter', author: { username: 'frank' }, created_at: at('11:30:00') },
    { action_name: 'accepted', project_id: 1002, target_type: 'MergeRequest', target_iid: 18, target_title: 'ABC-106 Fix the login redirect', author: { username: 'frank' }, created_at: at('14:00:00') },
    { action_name: 'pushed to', project_id: 1001, target_type: null, target_title: null, author: { username: 'frank' }, created_at: at('15:30:00') },
  ];
}

function todos() {
  return [
    { id: 9001, action_name: 'review_requested', author: { username: 'rupert' }, project: { path_with_namespace: 'acme/web' }, target: { iid: 30 }, created_at: '2026-11-09T13:00:00Z', body: 'Bump the linter' },
    { id: 9002, action_name: 'mentioned', author: { username: 'ivan' }, project: { path_with_namespace: 'acme/engine' }, target: { iid: 7 }, created_at: '2026-11-09T15:01:00Z', body: '@frank ready for another look' },
  ];
}

const ticket = (key, summary, status, extra = {}) => ({ key, fields: { summary, status: { name: status }, labels: [], assignee: { displayName: 'Frank' }, issuetype: { name: 'Task', hierarchyLevel: 0 }, ...extra } });

function jira() {
  const epic = { key: 'ABC-100', fields: { summary: 'Token service', issuetype: { name: 'Epic', hierarchyLevel: 1 } } };
  return {
    mine: [
      ticket('ABC-102', 'Retry the upload', 'In Progress', { parent: epic }),
      ticket('ABC-104', 'Move the settings page', 'In Progress'),
      ticket('ABC-105', 'Add a dry run flag', 'Peer Review'),
      ticket('ABC-106', 'Fix the login redirect', 'Peer Review', { parent: epic }),
    ],
    qa: [
      ticket('ABC-110', 'Export the audit log', 'QA', { assignee: { displayName: 'Ivan' } }),
      ticket('ABC-111', 'Rotate the signing key', 'QA', { assignee: null }),
    ],
    movedToQa: { 'ABC-110': 3, 'ABC-111': 8 },
    movedOn: { '2026-11-09': { QA: ['ABC-106'] } },
  };
}

export function goldenWorld() {
  return {
    me: ME,
    users: USERS,
    projects: PROJECTS,
    groups: ['acme', 'acme/tools'],
    mrs: [...openMrs(), ...mergedMrs()],
    pipelines: pipelines(),
    traces: { 120012: TRACE, 70012: TRACE },
    files: { '1001:src/token.ts@e7a1e7a1': TOKEN_FILE },
    events: events(),
    todos: todos(),
    jira: jira(),
  };
}
