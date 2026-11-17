import { keyOf, type MrRef } from '../refs.js';
import type { MergeOutcome, RebaseState } from './forge.js';
import { graphql, mutate, rest } from './github.js';
import { fetchPrChecks, prVars, RATE } from './github-prs.js';
import { prNode } from './github-writes.js';

type Headed = MrRef & { sha?: string | null };
type Method = 'MERGE' | 'SQUASH' | 'REBASE';

const pulls = (r: MrRef): string => `/repos/${r.projectPath}/pulls/${r.iid}`;
const send = (method: string, body: unknown): RequestInit => ({ method, body: JSON.stringify(body) });
const keyIn = (r: MrRef): string => keyOf({ ...r, provider: 'github' });
const RETRYABLE = new Set(['failed', 'canceled']);

interface MergeFacts {
  repository: {
    viewerDefaultMergeMethod: Method;
    mergeCommitAllowed: boolean;
    squashMergeAllowed: boolean;
    rebaseMergeAllowed: boolean;
    pullRequest: { id: string } | null;
  } | null;
}

const MERGE_QUERY = `query PrMerge($owner: String!, $name: String!, $number: Int!) {
  ${RATE}
  repository(owner: $owner, name: $name) { viewerDefaultMergeMethod mergeCommitAllowed squashMergeAllowed rebaseMergeAllowed pullRequest(number: $number) { id } }
}`;

/** The way GitHub's own button would merge it: your last choice, or the repo's default, among the ways the repo allows. */
async function mergeWay(r: MrRef): Promise<{ id: string; method: Method }> {
  const repo = (await graphql<MergeFacts>(MERGE_QUERY, prVars(r))).repository;
  if (!repo?.pullRequest) throw new Error(`GitHub has no ${keyIn(r)}`);
  const allowed: Record<Method, boolean> = { MERGE: repo.mergeCommitAllowed, SQUASH: repo.squashMergeAllowed, REBASE: repo.rebaseMergeAllowed };
  const method = allowed[repo.viewerDefaultMergeMethod] ? repo.viewerDefaultMergeMethod : (Object.keys(allowed) as Method[]).find((m) => allowed[m]);
  if (!method) throw new Error(`${r.projectPath} allows no way to merge`);
  return { id: repo.pullRequest.id, method };
}

const AUTO_MERGE = `mutation PrAutoMerge($pr: ID!, $method: PullRequestMergeMethod!, $head: GitObjectID!) {
  enablePullRequestAutoMerge(input: { pullRequestId: $pr, mergeMethod: $method, expectedHeadOid: $head }) { pullRequest { autoMergeRequest { enabledAt } } }
}`;

/** The head is sent either way, so GitHub itself refuses a branch that moved after you looked. */
export async function mergePr(r: MrRef, { sha, whenGreen }: { sha: string; whenGreen: boolean }): Promise<MergeOutcome> {
  const { id, method } = await mergeWay(r);
  if (whenGreen) {
    const data = await mutate<{ enablePullRequestAutoMerge: { pullRequest: { autoMergeRequest: { enabledAt: string } | null } } }>(AUTO_MERGE, { pr: id, method, head: sha });
    return { merged: false, autoMerge: Boolean(data.enablePullRequestAutoMerge.pullRequest.autoMergeRequest) };
  }
  const done = await rest<{ merged?: boolean }>(`${pulls(r)}/merge`, send('PUT', { sha, merge_method: method.toLowerCase() }));
  return { merged: Boolean(done?.merged), autoMerge: false };
}

export async function cancelPrAutoMerge(r: MrRef): Promise<void> {
  const { id } = await prNode(r);
  await mutate('mutation PrCancelAutoMerge($pr: ID!) { disablePullRequestAutoMerge(input: { pullRequestId: $pr }) { pullRequest { autoMergeRequest { enabledAt } } } }', { pr: id });
}

export async function markPrReady(r: MrRef): Promise<{ draft: boolean }> {
  const { id } = await prNode(r);
  const data = await mutate<{ markPullRequestReadyForReview: { pullRequest: { isDraft: boolean } } }>(
    'mutation PrReady($pr: ID!) { markPullRequestReadyForReview(input: { pullRequestId: $pr }) { pullRequest { isDraft } } }',
    { pr: id },
  );
  return { draft: data.markPullRequestReadyForReview.pullRequest.isDraft };
}

/** GitHub's update branch merges the target in, as its button does, and does it in the background. */
export async function updatePrBranch(r: Headed): Promise<void> {
  await rest(`${pulls(r)}/update-branch`, send('PUT', r.sha ? { expected_head_sha: r.sha } : {}));
}

/** GitHub says nothing of an update under way, so it is under way until the head moves. */
export async function prBranchState(r: Headed): Promise<RebaseState> {
  const { headRefOid } = await prNode(r);
  return { inProgress: Boolean(r.sha) && headRefOid === r.sha, error: null };
}

interface Requested {
  users: { login: string }[];
}

const lowered = (names: string[]): Set<string> => new Set(names.map((n) => n.toLowerCase()));

async function reviewedBy(r: MrRef): Promise<string[]> {
  const reviews = await rest<{ user: { login: string } | null }[]>(`${pulls(r)}/reviews?per_page=100`);
  return [...new Set(reviews.flatMap((v) => (v.user ? [v.user.login] : [])))];
}

/**
 * Asks those not yet asked and stops asking those left out. Someone who has reviewed already is a reviewer
 * whatever is asked, so keeping them asks nothing of them again; that is what Ask again is for.
 */
export async function setPrReviewers(r: MrRef, names: string[]): Promise<string[]> {
  const [{ users }, reviewed] = await Promise.all([rest<Requested>(`${pulls(r)}/requested_reviewers`), reviewedBy(r)]);
  const asked = users.map((u) => u.login);
  const wanted = lowered(names);
  const known = lowered([...asked, ...reviewed]);
  const drop = asked.filter((name) => !wanted.has(name.toLowerCase()));
  const add = names.filter((name) => !known.has(name.toLowerCase()));
  let now = asked;
  if (drop.length) now = (await rest<{ requested_reviewers: { login: string }[] }>(`${pulls(r)}/requested_reviewers`, send('DELETE', { reviewers: drop }))).requested_reviewers.map((u) => u.login);
  if (add.length) now = (await rest<{ requested_reviewers: { login: string }[] }>(`${pulls(r)}/requested_reviewers`, send('POST', { reviewers: add }))).requested_reviewers.map((u) => u.login);
  const kept = reviewed.filter((name) => wanted.has(name.toLowerCase()) && !lowered(now).has(name.toLowerCase()));
  return [...now, ...kept];
}

/** Asking someone who has reviewed is how GitHub asks them to look again. */
export async function rerequestPrReview(r: MrRef, name: string): Promise<void> {
  await rest(`${pulls(r)}/requested_reviewers`, send('POST', { reviewers: [name] }));
}

/** Only an Actions job can be run again from here; another app's check is retried on its own page. */
export async function retryPrJob(r: MrRef, jobId: number): Promise<{ id: number; status: string }> {
  await rest(`/repos/${r.projectPath}/actions/jobs/${jobId}/rerun`, send('POST', {}));
  return { id: jobId, status: 'pending' };
}

/** Each Actions run on the head with a job that failed or was cancelled runs those again, as GitLab's Retry does a pipeline's. */
export async function retryPrChecks(r: Headed, pipelineId: number): Promise<{ id: number; status: string }> {
  const sha = r.sha ?? (await prNode(r)).headRefOid;
  const jobs = await fetchPrChecks(r, sha);
  const runs = [...new Set(jobs.filter((j) => j.logs && j.pipelineId > 0 && RETRYABLE.has(j.status)).map((j) => j.pipelineId))];
  if (!runs.length) throw new Error(`no GitHub Actions job on the head of ${keyIn(r)} has failed or been cancelled`);
  for (const run of runs) await rest(`/repos/${r.projectPath}/actions/runs/${run}/rerun-failed-jobs`, send('POST', {}));
  return { id: pipelineId, status: 'pending' };
}
