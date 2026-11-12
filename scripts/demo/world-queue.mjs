import { AUDIT_HUNK } from './world-gitlab.mjs';

const MINUTE = 60_000;
const TOKEN_HUNK = '@@ -10,4 +10,8 @@ export function lookup(id) {\n export function lookup(id) {\n   const key = keyOf(id);';
const LINTER_HUNK = '@@ -12,3 +12,3 @@\n   "devDependencies": {\n-    "eslint": "^9.38.0",\n+    "eslint": "^9.39.1",';

const base = (path, id, iid, project) => ({ projectPath: path, projectId: project, iid, webUrl: `https://gitlab.com/${path}/-/merge_requests/${iid}`, createdBy: 'review', status: 'pending', id });

export function demoQueue(now = Date.now()) {
  const made = (minutesAgo) => new Date(now - minutesAgo * MINUTE).toISOString();
  const shas = { base_sha: 'base7000', start_sha: 'base7000', head_sha: 'e7a1e7a1' };
  const engine = (id, extra) => ({ ...base('acme/engine', id, 7, 1001), createdAt: made(40), ...extra });
  const at = (line, path = 'src/token.ts') => ({ position: { ...shas, new_path: path, new_line: line }, diffHunk: TOKEN_HUNK });
  return [
    engine('demo-token-expiry', { severity: 'CRITICAL', body: 'A revoked token keeps working: the cache has no expiry, so it is served until the process restarts.', ...at(14) }),
    engine('demo-tenant-key', { severity: 'MAJOR', body: 'The key does not include the tenant, so two tenants with the same id share one cached token.', ...at(12) }),
    engine('demo-empty-token', { severity: 'MINOR', body: 'An empty token is cached for ever. Skip the cache when fetchToken returns nothing.', ...at(15) }),
    engine('demo-key-twice', { severity: 'NIT', body: 'keyOf runs twice on every lookup. Keep the first result in key.', ...at(11) }),
    engine('demo-name', { severity: 'QUESTION', body: 'Should this be called lookupToken, to match fetchToken beside it?', ...at(10) }),
    engine('demo-verdict', { severity: 'MAJOR', kind: 'verdict', verdict: 'changes', body: 'Request changes' }),
    {
      ...base('acme/api', 'demo-audit-sql', 41, 1004), createdAt: made(25), severity: 'MAJOR', body: 'The limit goes into the SQL as text. Bind it as a parameter.',
      diffHunk: AUDIT_HUNK, position: { base_sha: 'abase41', start_sha: 'abase41', head_sha: 'a41aa41a', new_path: 'src/audit/list.ts', new_line: 24 },
    },
    {
      ...base('acme/api', 'demo-audit-page', 41, 1004), createdAt: made(25), severity: 'MINOR', body: 'A page past the end returns an empty list. Say how many pages there are.',
      diffHunk: AUDIT_HUNK, position: { base_sha: 'abase41', start_sha: 'abase41', head_sha: 'a41aa41a', new_path: 'src/audit/list.ts', new_line: 25 },
    },
    {
      ...base('acme/web', 'demo-linter', 30, 1002), createdAt: made(70), severity: 'MINOR', body: 'Pin the linter to an exact version.', diffHunk: LINTER_HUNK,
      position: { base_sha: 'base3000', start_sha: 'base3000', head_sha: 'w30aw30a', new_path: 'package.json', new_line: 13 },
    },
  ];
}
