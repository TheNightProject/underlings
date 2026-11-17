import type { RepoSpec } from '../config.js';
import { loadGithubRepoCache, saveGithubRepoCache } from './store.js';
import type { Forge } from './forge.js';
import { githubSettings, graphql, viewerLogin } from './github.js';
import {
  discoverPrRepos,
  fetchPr,
  fetchPrBranch,
  fetchPrChecks,
  fetchPrDetail,
  fetchPrDiscussions,
  fetchPrEnd,
  fetchPrFile,
  fetchPrFiles,
  fetchPrJobLog,
  fetchPrSince,
  listOpenPrs,
} from './github-prs.js';
import { cancelPrAutoMerge, markPrReady, mergePr, prBranchState, rerequestPrReview, retryPrChecks, retryPrJob, setPrReviewers, updatePrBranch } from './github-own.js';
import { postPrComment, postPrFinding, replyOnPr, resolveOnPr, setPrApproval, setPrHold } from './github-writes.js';
import { threadStateOf } from './shared.js';

const notYet = (what: string) => async (): Promise<never> => {
  throw new Error(`GitHub: ${what} from here comes in a later version. Do it on GitHub for now`);
};

const none = async (): Promise<never[]> => [];

/** A write it cannot do yet says so rather than half working. */
export const githubForge: Forge = {
  id: 'github',
  name: 'GitHub',
  caps: {
    hold: true,
    withdrawApproval: true,
    rebase: true,
    autoMerge: true,
    jobLogs: 'actions',
    retry: 'actions',
    todos: false,
    generalThreads: false,
    post: true,
    agents: false,
    ownMr: true,
  },
  me: () => viewerLogin(),
  myName: async () => (await graphql<{ viewer: { name: string | null } }>('query ViewerName { viewer { name } }')).viewer.name ?? '',
  discoverRepos: async () => (githubSettings().scope === 'orgs' ? discoverPrRepos() : []),
  listOpen: (repos) => listOpenPrs(repos),
  todos: none,
  one: (r) => fetchPr(r),
  state: async (r) => (await fetchPrEnd(r)).state,
  end: (r) => fetchPrEnd(r),
  detail: (r) => fetchPrDetail(r),
  branchFacts: (r) => fetchPrBranch(r),
  discussions: (r) => fetchPrDiscussions(r),
  threadState: async (r, me, head) => threadStateOf(await fetchPrDiscussions(r), me, head),
  files: (r) => fetchPrFiles(r),
  since: (r, from, to) => fetchPrSince(r, from, to),
  file: (r, path, at, maxBytes) => fetchPrFile(r, path, at, maxBytes),
  checks: (r, sha) => fetchPrChecks(r, sha),
  jobLog: (r, jobId, lines) => fetchPrJobLog(r, jobId, lines),
  retryJob: (r, jobId) => retryPrJob(r, jobId),
  retryChecks: (r, pipelineId) => retryPrChecks(r, pipelineId),
  postFinding: (item, how) => postPrFinding(item, how),
  reply: (r, threadId, body) => replyOnPr(r, threadId, body),
  resolve: (r, threadId, resolved) => resolveOnPr(r, threadId, resolved),
  note: (r, body) => postPrComment(r, body),
  approve: (r, on) => setPrApproval(r, on),
  hold: (r, on, note) => setPrHold(r, on, note),
  merge: (r, how) => mergePr(r, how),
  cancelAutoMerge: (r) => cancelPrAutoMerge(r),
  rebase: (r) => updatePrBranch(r),
  rebaseState: (r) => prBranchState(r),
  ready: (r) => markPrReady(r),
  setReviewers: (r, names) => setPrReviewers(r, names),
  rerequest: (r, name) => rerequestPrReview(r, name),
  brief: notYet('reading activity'),
  approvers: notYet('reading activity'),
  myEvents: none,
  myMrs: none,
  myRepos: none,
  mergedIn: none,
  mergedMentioning: none,
  mergedBy: none,
  reviewedBy: none,
  boardMrs: none,
  boardComments: async () => ({ events: [], complete: true }),
};

/** Discovered once a day in the orgs scope, kept apart from GitLab's list so neither overwrites the other. */
export async function githubRepos(): Promise<RepoSpec[]> {
  if (githubSettings().scope !== 'orgs') return [];
  const cached = loadGithubRepoCache();
  if (cached) return cached;
  const found = await githubForge.discoverRepos();
  saveGithubRepoCache(found);
  return found;
}
