import { restUrl } from '../config.js';
import { keyPath } from '../refs.js';
import { firstKeyIn } from '../ticketkeys.js';
import type { Forge, RecentMr } from './forge.js';
import {
  cancelAutoMerge,
  discoverRepos,
  fetchApprovers,
  fetchBoardMrs,
  fetchBranchFacts,
  fetchCommentEvents,
  fetchDiscussions,
  fetchFileWithin,
  fetchJobTrace,
  fetchMe,
  fetchMergedMrs,
  fetchMrBrief,
  fetchMrDetail,
  fetchMrEnd,
  fetchMrFiles,
  fetchMrsDetailed,
  fetchMrState,
  fetchMyEvents,
  fetchMyMrs,
  fetchMyName,
  fetchOneMr,
  fetchPipelineJobs,
  fetchSince,
  fetchThreadState,
  fetchTodos,
  mergeMr,
  postComment,
  postNote,
  rebaseMr,
  rebaseState,
  replyToDiscussion,
  rerequestReview,
  retryJob,
  retryPipeline,
  setApproval,
  setDiscussionResolved,
  setDraft,
  setMergeHold,
  setReviewers,
} from './gitlab.js';

const RECENT_PAGES = 5;
const SEARCH_TIMEOUT_MS = 30_000;

interface ListedMr {
  iid: number;
  title?: string;
  author?: { username?: string } | null;
  created_at?: string | null;
  merged_at?: string | null;
  references?: { full?: string };
}

interface SearchedMr {
  iid: number;
  title?: string;
  references: { full: string };
}

/** Only the stats' and the ticket suggestions' reads are written here; every other method is a gitlab.ts call. */
export const gitlabForge: Forge = {
  id: 'gitlab',
  name: 'GitLab',
  caps: { hold: true, withdrawApproval: true, rebase: true, autoMerge: true, jobLogs: true, retry: true, todos: true },
  me: () => fetchMe(),
  myName: () => fetchMyName(),
  discoverRepos: () => discoverRepos(),
  listOpen: (repos) => fetchMrsDetailed(repos),
  todos: () => fetchTodos(),
  one: (r) => fetchOneMr(r.projectPath, r.iid),
  state: (r) => fetchMrState(r.projectPath, r.iid),
  end: (r) => fetchMrEnd(r.projectPath, r.iid),
  detail: (r) => fetchMrDetail(r.projectId, r.iid),
  branchFacts: (r) => fetchBranchFacts(r.projectId, r.iid),
  discussions: (r) => fetchDiscussions(r.projectId, r.iid),
  threadState: (r, me, head) => fetchThreadState(r.projectId, r.iid, me, head),
  files: (r) => fetchMrFiles(r.projectId, r.iid),
  since: (r, from, to) => fetchSince(r.projectId, from, to),
  file: (r, path, at, maxBytes) => fetchFileWithin(r.projectId, path, at, maxBytes),
  checks: (r, sha) => fetchPipelineJobs(r.projectId, sha),
  jobLog: (r, jobId, lines) => fetchJobTrace(r.projectId, jobId, lines),
  retryJob: (r, jobId) => retryJob(r.projectId, jobId),
  retryChecks: (r, pipelineId) => retryPipeline(r.projectId, pipelineId),
  postFinding: (item, how) => postComment(item, how),
  reply: (r, threadId, body) => replyToDiscussion(r.projectId, r.iid, threadId, body),
  resolve: (r, threadId, resolved) => setDiscussionResolved(r.projectId, r.iid, threadId, resolved),
  note: (r, body) => postNote(r.projectId, r.iid, body),
  approve: (r, on) => setApproval(r.projectId, r.iid, on),
  hold: (r, on) => setMergeHold(r.projectPath, r.iid, on),
  merge: (r, how) => mergeMr(r.projectId, r.iid, how),
  cancelAutoMerge: (r) => cancelAutoMerge(r.projectId, r.iid),
  rebase: (r) => rebaseMr(r.projectId, r.iid),
  rebaseState: (r) => rebaseState(r.projectId, r.iid),
  ready: (r) => setDraft(r.projectPath, r.iid, false),
  setReviewers: (r, names) => setReviewers(r.projectId, r.iid, names),
  rerequest: (r, name) => rerequestReview(r.projectPath, r.iid, name),
  brief: (r) => fetchMrBrief(r.projectId, r.iid),
  approvers: (r) => fetchApprovers(r.projectId, r.iid),
  myEvents: (after, before) => fetchMyEvents(after, before),
  myMrs: (state, updatedAfter) => fetchMyMrs(state, updatedAfter),
  mergedIn: (scope, after, before) => fetchMergedMrs(scope, after, before),
  mergedMentioning: (ticket, scopes) => searchMerged(ticket, scopes),
  mergedBy: (username, updatedAfter) => listMrs({ state: 'merged', author_username: username, updated_after: updatedAfter }),
  reviewedBy: (username, updatedAfter) => listMrs({ reviewer_username: username, updated_after: updatedAfter }),
  boardMrs: (repos, since, hooks) => fetchBoardMrs(repos, since, hooks),
  boardComments: (project, since, pages) => fetchCommentEvents(project.projectId, since, project.authors, pages),
};

async function listMrs(params: Record<string, string>): Promise<RecentMr[]> {
  const token = process.env['GITLAB_TOKEN'];
  if (!token) throw new Error('there is no GitLab token');
  const found: RecentMr[] = [];
  for (let page = 1; page && page <= RECENT_PAGES;) {
    const query = new URLSearchParams({ scope: 'all', per_page: '100', page: String(page), ...params });
    const res = await fetch(`${restUrl()}/merge_requests?${query}`, { headers: { 'PRIVATE-TOKEN': token } });
    if (!res.ok) throw new Error(`GitLab ${res.status} ${res.statusText}`.trim());
    found.push(...((await res.json()) as ListedMr[]).map(recentOf));
    page = Number(res.headers.get('x-next-page')) || 0;
  }
  return found;
}

function recentOf(mr: ListedMr): RecentMr {
  return { key: mr.references?.full ?? '', title: mr.title ?? '', author: mr.author?.username ?? null, createdAt: mr.created_at ?? null, mergedAt: mr.merged_at ?? null };
}

async function searchMerged(ticket: string, groups: string[]): Promise<{ path: string | null; iid: number }[]> {
  const token = process.env['GITLAB_TOKEN'];
  if (!token) throw new Error('there is no GitLab token');
  const found: { path: string | null; iid: number }[] = [];
  for (const group of groups) {
    const query = new URLSearchParams({ state: 'merged', search: ticket, in: 'title', per_page: '100' });
    // The ticket list waits on these reads before Jira is read again, so a GitLab that never answers must not hold it.
    const res = await fetch(`${restUrl()}/groups/${encodeURIComponent(group)}/merge_requests?${query}`, { headers: { 'PRIVATE-TOKEN': token }, signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS) });
    if (!res.ok) throw new Error(`GitLab ${res.status} ${res.statusText}`.trim());
    for (const mr of (await res.json()) as SearchedMr[]) if (carries(mr, ticket)) found.push({ path: keyPath(mr.references.full), iid: mr.iid });
  }
  return found;
}

// GitLab's search finds ABC-123 for ABC-12 too, so an MR counts only when the key is the first in its title, as the review engine reads it.
const carries = (mr: SearchedMr, ticket: string): boolean => firstKeyIn(mr.title ?? '') === ticket;
