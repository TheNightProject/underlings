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
import { threadStateOf } from './shared.js';

const notYet = (what: string) => async (): Promise<never> => {
  throw new Error(`GitHub: ${what} from here comes in a later version. Do it on GitHub for now`);
};

const none = async (): Promise<never[]> => [];

/** Reads only, for now: every write says so rather than half working. */
export const githubForge: Forge = {
  id: 'github',
  name: 'GitHub',
  caps: {
    hold: false,
    withdrawApproval: false,
    rebase: false,
    autoMerge: false,
    jobLogs: 'actions',
    retry: false,
    todos: false,
    generalThreads: false,
    post: false,
    agents: false,
    ownMr: false,
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
  retryJob: notYet('retrying a job'),
  retryChecks: notYet('retrying checks'),
  postFinding: notYet('posting a finding'),
  reply: notYet('replying'),
  resolve: notYet('resolving a thread'),
  note: notYet('commenting'),
  approve: notYet('approving'),
  hold: notYet('holding a merge'),
  merge: notYet('merging'),
  cancelAutoMerge: notYet('cancelling auto-merge'),
  rebase: notYet('updating a branch'),
  rebaseState: notYet('updating a branch'),
  ready: notYet('marking ready'),
  setReviewers: notYet('choosing reviewers'),
  rerequest: notYet('asking for a review again'),
  brief: notYet('reading activity'),
  approvers: notYet('reading activity'),
  myEvents: none,
  myMrs: none,
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
