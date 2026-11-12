import { BAD_KEY, failure, forgeFor, meFor, MR_KEY, mrOrQueued, requireEngine, supports } from './engine.mjs';
import { settledFor } from './matrix.mjs';
import { keyOf, keyParts } from './refs.mjs';
import { sinceReview } from './since.mjs';

const CACHE_MS = 30_000;
const NEEDS = ['awaitsYou', 'loadAutoMemory', 'loadQueue'];
const READS = ['one', 'discussions', 'checks'];
const MAX_DESCRIPTION = 20_000;
const STALE_BUILD = 'this review engine build cannot read it, so rebuild the engine';
const cache = new Map();

const MERGE_WORDS = {
  mergeable: 'ready to merge',
  ci_must_pass: 'pipeline must succeed',
  ci_still_running: 'waiting for the pipeline',
  discussions_not_resolved: 'blocked: unresolved threads',
  draft_status: 'blocked: still a draft',
  not_approved: 'needs approval',
  approvals_syncing: 'approvals are syncing',
  need_rebase: 'needs rebase',
  conflict: 'blocked: merge conflicts',
  blocked_status: 'blocked by another MR',
  merge_request_blocked: 'blocked by another MR',
  requested_changes: 'blocked: changes requested',
  external_status_checks: 'blocked: external status checks',
  status_checks_must_pass: 'blocked: external status checks',
  jira_association_missing: 'blocked: no Jira key in the title or description',
  security_policy_violations: 'blocked: security policy',
  locked_paths: 'blocked: locked paths',
  locked_lfs_files: 'blocked: locked LFS files',
  title_regex: 'blocked: the title does not match the required pattern',
  commits_status: 'blocked: commit status',
  not_open: 'not open',
  merge_time: 'waiting for its merge time',
  checking: 'GitLab is checking',
  unchecked: 'not checked yet',
  preparing: 'GitLab is preparing it',
  branch_rules: 'blocked: branch rules',
};
const MERGE_WAITING = new Set(['ci_still_running', 'approvals_syncing', 'merge_time', 'checking', 'unchecked', 'preparing']);

export const ACTIONS = {};

export const ROUTES = {
  'GET /api/matrix/mr': ({ query }) => readMrDetail(query.get('key')),
};

// Keyed by the head the inbox last saw and by the MR's queue, so a push or a post from elsewhere misses the cache however recently the MR was read.
export async function readMrDetail(key) {
  const engine = requireEngine(...NEEDS);
  if (typeof key !== 'string' || !MR_KEY.test(key)) throw failure(400, BAD_KEY);
  const forge = forgeFor(keyParts(key), ...READS);
  const known = mrOrQueued(key);
  const queue = engine.loadQueue();
  const cacheKey = `${key}@${known.sha ?? ''}#${queueMark(queue, key)}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.detail;
  sweep();
  const detail = fetchDetail(engine, forge, key, known, queue);
  cache.set(cacheKey, { at: Date.now(), detail });
  const forget = () => cache.get(cacheKey)?.detail === detail && cache.delete(cacheKey);
  detail.then((d) => partFailed(d) && forget(), forget);
  return detail;
}

// A stale build stays stale, but a GitLab error on one part is worth asking again on the next open.
function partFailed(detail) {
  return Object.values(detail.missing).some((why) => why !== STALE_BUILD);
}

export function invalidate(key) {
  for (const cacheKey of cache.keys()) if (!key || cacheKey.startsWith(`${key}@`)) cache.delete(cacheKey);
}

const queueMark = (queue, key) => queue.filter((c) => keyOf(c) === key).map((c) => `${c.id}:${c.status}:${c.discussionId ?? ''}`).join();

function sweep() {
  for (const [cacheKey, { at }] of cache) if (Date.now() - at >= CACHE_MS) cache.delete(cacheKey);
}

async function fetchDetail(engine, forge, key, known, queue) {
  const mr = await forge.one(known);
  if (!mr) throw failure(404, `${forge.name} has no ${key}`);
  const [discussions, jobs, more, files] = await Promise.all([
    forge.discussions(mr),
    mr.sha ? forge.checks(mr, mr.sha) : [],
    part(forge, 'detail', mr),
    part(forge, 'files', mr),
  ]);
  const me = meFor(mr) ?? undefined;
  const since = await sinceReview(engine.loadState().watches?.[key], mr, discussions, me).catch(() => null);
  const handedBack = new Set(engine.loadAutoMemory()[key]?.handedBack ?? []);
  const replies = queuedReplies(queue, key);
  return {
    key,
    me: me ?? null,
    fetchedAt: new Date().toISOString(),
    mr: summariseMr(mr),
    discussions: discussions.map((d) => shapeDiscussion(engine, d, { me, handedBack, replies })),
    jobs: jobs.map(({ name, status, stage }) => ({ name, status, stage })),
    merge: mergeState(more.value?.detailedMergeStatus ?? mr.mergeStatus, mr.provider),
    detail: more.value ? shapeMore(more.value) : null,
    files: files.value ? shapeFiles(files.value) : null,
    missing: Object.fromEntries([['detail', more.missing], ['files', files.missing]].filter(([, why]) => why)),
    settled: settledFor(queue, key),
    since,
  };
}

// An engine built before a call, or a GitLab error on one part, costs only that part of the drawer.
async function part(forge, method, mr) {
  if (typeof forge[method] !== 'function') return { missing: STALE_BUILD };
  try {
    return { value: await forge[method](mr) };
  } catch (err) {
    return { missing: err.message };
  }
}

export function mergeState(status, provider) {
  if (!status) return null;
  const code = String(status).toLowerCase();
  const tone = code === 'mergeable' ? 'ready' : MERGE_WAITING.has(code) ? 'waiting' : 'blocked';
  const words = MERGE_WORDS[code] ?? code.replace(/_/g, ' ');
  return { status: code, words: provider === 'github' ? words.replace('GitLab', 'GitHub') : words, tone };
}

function shapeMore(m) {
  const description = readable(m.description);
  return {
    description: description.slice(0, MAX_DESCRIPTION),
    clipped: description.length > MAX_DESCRIPTION,
    targetBranch: m.targetBranch ?? null,
    changes: m.changesCount ?? null,
    notes: m.userNotesCount ?? null,
  };
}

// GitLab hides HTML comments, and MR templates are full of them.
function readable(text) {
  return String(text ?? '')
    .replace(/\r\n?/g, '\n')
    .replace(/<!--[\s\S]*?(?:-->|$)/g, '')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function shapeFiles({ files, complete }) {
  return { complete: Boolean(complete), list: files.map(fileSummary) };
}

function fileSummary(f) {
  const diff = String(f.diff ?? '');
  const lines = diff.split('\n');
  const renamed = Boolean(f.oldPath && f.newPath && f.oldPath !== f.newPath);
  return {
    path: f.newPath || f.oldPath,
    oldPath: renamed ? f.oldPath : null,
    change: /^@@ -0,0 /.test(diff) ? 'added' : /^@@ -\d+(?:,\d+)? \+0,0 @@/.test(diff) ? 'deleted' : renamed ? 'renamed' : 'modified',
    added: lines.filter((l) => l.startsWith('+')).length,
    removed: lines.filter((l) => l.startsWith('-')).length,
    tooLarge: Boolean(f.tooLarge),
  };
}

function queuedReplies(queue, key) {
  const pending = queue.filter((c) => c.status === 'pending' && c.kind === 'reply' && keyOf(c) === key);
  return new Map(pending.map((c) => [c.replyTo ?? c.discussionId, c.id]));
}

function summariseMr(mr) {
  return {
    ...(mr.provider ? { provider: mr.provider } : {}),
    iid: mr.iid,
    repo: mr.repoLabel,
    title: mr.title,
    webUrl: mr.webUrl,
    author: mr.author,
    reviewers: mr.reviewers,
    approvedBy: mr.approvedBy,
    draft: mr.draft,
    conflicts: mr.conflicts,
    pipeline: mr.pipeline,
    mergeStatus: mr.mergeStatus,
    sourceBranch: mr.sourceBranch,
    sha: mr.sha,
    ticket: mr.ticket,
    createdAt: mr.createdAt,
    updatedAt: mr.updatedAt,
    unresolved: mr.unresolvedThreads,
  };
}

export function anchorOf(d) {
  const position = d.position ?? {};
  return { path: position.new_path ?? position.old_path ?? null, line: position.new_line ?? position.old_line ?? null };
}

// GitLab marks a thread resolved only when it can be, so an unresolved one, or one on a line, is resolvable.
function shapeDiscussion(engine, d, { me, handedBack, replies }) {
  return {
    id: d.id,
    resolved: d.resolved,
    resolvable: d.resolvable ?? (Boolean(d.position) || !d.resolved),
    ...anchorOf(d),
    notes: d.notes.map(({ author, body, createdAt, system }) => ({ author, body, createdAt, system: Boolean(system) })),
    awaitsYou: engine.awaitsYou(d, me),
    bot: supports('isBotThread') && engine.isBotThread(d),
    handedBack: handedBack.has(d.id),
    queuedReply: replies.get(d.id) ?? null,
  };
}
