import type { RepoSpec } from '../config.js';
import { withoutEmojiSelector } from '../flags.js';
import { keyOf, type MrRef } from '../refs.js';
import { applyFilter } from '../settings.js';
import { extractTicket, type Mr, type PipelineStatus } from '../types.js';
import type { BranchFacts, Discussion, JobTrace, MrDetail, MrEnd, MrFetch, MrFile, MrState, PipelineJob } from './forge.js';
import { githubSettings, graphql, rest, restStream } from './github.js';
import { labelRepos, TOO_BIG } from './shared.js';

const SEARCH_FIRST = 50;
const REPO_FIRST = 50;
const REPOS_A_QUERY = 10;
const MAX_FILE_PAGES = 30;
const FILES_A_PAGE = 100;
const DISCOVERY_PAGES = 5;
const STALE_DAYS = 90;
const LOG_TAIL_CHARS = 256 * 1024;

const RATE = 'rateLimit { cost remaining resetAt }';

const PR_FIELDS = `
fragment pr on PullRequest {
  number title url isDraft state mergeable mergeStateStatus reviewDecision
  createdAt updatedAt headRefName headRefOid totalCommentsCount
  author { login __typename }
  repository { databaseId nameWithOwner name }
  autoMergeRequest { enabledAt }
  reviews { totalCount }
  reviewThreads(first: 100) { nodes { isResolved } }
  reviewRequests(first: 20) { nodes { requestedReviewer { __typename ... on User { login } } } }
  latestOpinionatedReviews(first: 20) { nodes { state author { login } } }
  latestReviews(first: 20) { nodes { state author { login } } }
  commits(last: 1) { nodes { commit { statusCheckRollup { state } checkSuites(first: 20) { nodes { workflowRun { databaseId } } } } } }
}`;

/** Each search is one way a pull request can involve you, so a request for your review is known even when it was asked of your team. */
export const INVOLVED = {
  requested: 'review-requested:@me',
  authored: 'author:@me',
  assigned: 'assignee:@me',
  mentioned: 'mentions:@me',
} as const;

type Involvement = keyof typeof INVOLVED;

export const INVOLVED_QUERY = `query Involved(${Object.keys(INVOLVED).map((k) => `$${k}: String!`).join(', ')}) {
  ${RATE}
  viewer { login }
  ${Object.keys(INVOLVED).map((k) => `${k}: search(type: ISSUE, query: $${k}, first: ${SEARCH_FIRST}) { issueCount nodes { ...pr } }`).join('\n  ')}
}
${PR_FIELDS}`;

export interface GhPr {
  number: number;
  title: string;
  url: string;
  isDraft: boolean;
  state: 'OPEN' | 'CLOSED' | 'MERGED';
  mergeable: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN';
  mergeStateStatus: string | null;
  reviewDecision: 'APPROVED' | 'CHANGES_REQUESTED' | 'REVIEW_REQUIRED' | null;
  createdAt: string;
  updatedAt: string;
  headRefName: string;
  headRefOid: string | null;
  totalCommentsCount: number | null;
  author: { login: string; __typename?: string } | null;
  repository: { databaseId: number; nameWithOwner: string; name: string };
  autoMergeRequest: { enabledAt: string } | null;
  reviews: { totalCount: number } | null;
  reviewThreads: { nodes: { isResolved: boolean }[] } | null;
  reviewRequests: { nodes: { requestedReviewer: { __typename: string; login?: string } | null }[] } | null;
  latestOpinionatedReviews: { nodes: GhReview[] } | null;
  latestReviews: { nodes: GhReview[] } | null;
  commits: { nodes: { commit: { statusCheckRollup: { state: string } | null; checkSuites: { nodes: { workflowRun: { databaseId: number } | null }[] } | null } }[] } | null;
}

interface GhReview {
  state: string;
  author: { login: string } | null;
}

const searchTerms = (term: string): string => `is:pr is:open archived:false sort:updated-desc ${term}`;

export const PIPELINE: Record<string, PipelineStatus> = { SUCCESS: 'SUCCESS', FAILURE: 'FAILED', ERROR: 'FAILED', PENDING: 'RUNNING', EXPECTED: 'PENDING' };

export const REVIEW_STATE: Record<string, string> = { APPROVED: 'APPROVED', CHANGES_REQUESTED: 'REQUESTED_CHANGES', COMMENTED: 'REVIEWED' };

const MR_STATE: Record<GhPr['state'], MrState> = { OPEN: 'opened', CLOSED: 'closed', MERGED: 'merged' };

const login = (who: { login?: string } | null | undefined): string | null => who?.login ?? null;

function requested(pr: GhPr): string[] {
  return (pr.reviewRequests?.nodes ?? []).flatMap((r) => (r.requestedReviewer?.__typename === 'User' && r.requestedReviewer.login ? [r.requestedReviewer.login] : []));
}

/** An approval or change request outlasts a later comment, as GitHub keeps it; a review asked again reads as not yet given. */
export function reviewStatesOf(pr: GhPr): Record<string, string> {
  const states: Record<string, string> = {};
  for (const r of pr.latestReviews?.nodes ?? []) if (login(r.author) && REVIEW_STATE[r.state]) states[login(r.author)!] = REVIEW_STATE[r.state]!;
  for (const r of pr.latestOpinionatedReviews?.nodes ?? []) if (login(r.author) && REVIEW_STATE[r.state]) states[login(r.author)!] = REVIEW_STATE[r.state]!;
  for (const name of requested(pr)) states[name] = 'UNREVIEWED';
  return states;
}

const rollupOf = (pr: GhPr): string | null => pr.commits?.nodes[0]?.commit.statusCheckRollup?.state ?? null;

export function pipelineOf(state: string | null): PipelineStatus {
  return state ? (PIPELINE[state] ?? null) : null;
}

/** Highest first, so a run that starts after a failure reads as a new pipeline. */
function pipelineIdOf(pr: GhPr): number | null {
  const ids = (pr.commits?.nodes[0]?.commit.checkSuites?.nodes ?? []).flatMap((s) => (s.workflowRun ? [s.workflowRun.databaseId] : []));
  return ids.length ? Math.max(...ids) : null;
}

/** GitHub's merge state, said in the codes GitLab's detailed merge status uses, so the page needs no second vocabulary. */
export function mergeCode(pr: Pick<GhPr, 'state' | 'isDraft' | 'mergeable' | 'mergeStateStatus' | 'reviewDecision'> & { rollup: string | null }): string {
  const status = pr.mergeStateStatus ?? 'UNKNOWN';
  if (pr.state !== 'OPEN') return 'NOT_OPEN';
  if (pr.isDraft) return 'DRAFT_STATUS';
  if (pr.mergeable === 'CONFLICTING' || status === 'DIRTY') return 'CONFLICT';
  if (status === 'BEHIND') return 'NEED_REBASE';
  if (pr.reviewDecision === 'CHANGES_REQUESTED') return 'REQUESTED_CHANGES';
  const blocked = status === 'BLOCKED';
  if (blocked && (pr.rollup === 'PENDING' || pr.rollup === 'EXPECTED')) return 'CI_STILL_RUNNING';
  if (blocked && (pr.rollup === 'FAILURE' || pr.rollup === 'ERROR')) return 'CI_MUST_PASS';
  if (pr.reviewDecision === 'REVIEW_REQUIRED') return 'NOT_APPROVED';
  if (blocked) return 'BRANCH_RULES';
  if (status === 'UNKNOWN' || pr.mergeable === 'UNKNOWN') return 'CHECKING';
  return 'MERGEABLE';
}

export const isBot = (author: GhPr['author']): boolean => author?.__typename === 'Bot' || Boolean(author?.login.endsWith('[bot]'));

export function prOf(pr: GhPr, label: string, readAt?: number, me?: string | null): Mr {
  const states = reviewStatesOf(pr);
  const reviewers = [...new Set([...requested(pr), ...Object.keys(states), ...(me ? [me] : [])])];
  const pipelineId = pipelineIdOf(pr);
  return {
    provider: 'github',
    projectPath: pr.repository.nameWithOwner,
    projectId: pr.repository.databaseId,
    repoLabel: label,
    iid: pr.number,
    title: withoutEmojiSelector(pr.title),
    webUrl: pr.url,
    draft: pr.isDraft,
    conflicts: pr.mergeable === 'CONFLICTING',
    notes: (pr.totalCommentsCount ?? 0) + (pr.reviews?.totalCount ?? 0),
    author: login(pr.author) ?? 'ghost',
    reviewers,
    approvedBy: (pr.latestOpinionatedReviews?.nodes ?? []).filter((r) => r.state === 'APPROVED').flatMap((r) => (login(r.author) ? [login(r.author)!] : [])),
    pipeline: pipelineOf(rollupOf(pr)),
    ...(pipelineId === null ? {} : { pipelineId }),
    mergeStatus: mergeCode({ ...pr, rollup: rollupOf(pr) }),
    createdAt: pr.createdAt,
    updatedAt: pr.updatedAt,
    sha: pr.headRefOid,
    sourceBranch: pr.headRefName,
    ticket: extractTicket(pr.title, pr.headRefName),
    unresolvedThreads: (pr.reviewThreads?.nodes ?? []).filter((t) => !t.isResolved).length,
    autoMerge: Boolean(pr.autoMergeRequest),
    ...(me ? { reviewStates: { [me]: 'UNREVIEWED', ...states } } : Object.keys(states).length ? { reviewStates: states } : {}),
    state: MR_STATE[pr.state],
    ...(readAt === undefined ? {} : { readAt }),
  };
}

const ownerAndName = (path: string): { owner: string; name: string } => {
  const [owner = '', name = ''] = path.split('/');
  return { owner, name };
};

const prVars = (r: MrRef): Record<string, unknown> => ({ ...ownerAndName(r.projectPath), number: r.iid });

const inScope = (mrs: Mr[]): Mr[] => {
  const filter = githubSettings().repos;
  if (!filter.trim()) return mrs;
  const kept = new Set(applyFilter(mrs.map((m) => ({ path: m.projectPath, label: '' })), filter).map((r) => r.path));
  return mrs.filter((m) => kept.has(m.projectPath));
};

/** Searches answer with the repo's name, and the inbox makes it unique beside the GitLab labels. */
export async function fetchInvolved(): Promise<Mr[]> {
  const readAt = Date.now();
  const data = await graphql<Record<Involvement, { nodes: (GhPr | Record<string, never>)[] } | null> & { viewer: { login: string } }>(INVOLVED_QUERY, Object.fromEntries(Object.entries(INVOLVED).map(([k, term]) => [k, searchTerms(term)])));
  const viewer = data.viewer.login;
  const found = new Map<string, Mr>();
  for (const way of Object.keys(INVOLVED) as Involvement[]) {
    for (const node of data[way]?.nodes ?? []) {
      if (!('number' in node)) continue;
      const mr = prOf(node as GhPr, (node as GhPr).repository.name, readAt, way === 'requested' ? viewer : null);
      const known = found.get(keyOf(mr));
      found.set(keyOf(mr), known && way !== 'requested' ? known : mr);
    }
  }
  return [...found.values()];
}

function repoBatchQuery(batch: RepoSpec[]): string {
  const first = Math.min(Math.max(...batch.map((r) => r.openCount ?? REPO_FIRST), 1), REPO_FIRST);
  const params = batch.map((_, n) => `$o${n}: String!, $n${n}: String!`).join(', ');
  const aliases = batch.map((_, n) => `r${n}: repository(owner: $o${n}, name: $n${n}) { pullRequests(states: OPEN, first: ${first}, orderBy: { field: UPDATED_AT, direction: DESC }) { nodes { ...pr } } }`).join('\n  ');
  return `query RepoPrs(${params}) {\n  ${RATE}\n  ${aliases}\n}\n${PR_FIELDS}`;
}

async function fetchRepoBatch(batch: RepoSpec[]): Promise<Mr[]> {
  const readAt = Date.now();
  const variables = Object.fromEntries(batch.flatMap((r, n) => [[`o${n}`, ownerAndName(r.path).owner], [`n${n}`, ownerAndName(r.path).name]]));
  const data = await graphql<Record<string, { pullRequests: { nodes: GhPr[] } } | null>>(repoBatchQuery(batch), variables);
  return batch.flatMap((repo, n) => (data[`r${n}`]?.pullRequests.nodes ?? []).map((pr) => prOf(pr, repo.label, readAt)));
}

/** The searches run in either scope, so a review asked of you outside your organisations is never missed. */
export async function listOpenPrs(repos: RepoSpec[]): Promise<MrFetch> {
  const batches: RepoSpec[][] = [];
  for (let i = 0; i < repos.length; i += REPOS_A_QUERY) batches.push(repos.slice(i, i + REPOS_A_QUERY));
  const [involved, ...read] = await Promise.allSettled([fetchInvolved(), ...batches.map(fetchRepoBatch)]);
  if (involved?.status === 'rejected') throw involved.reason;
  const errors = read.flatMap((r) => (r.status === 'rejected' ? [r.reason instanceof Error ? r.reason.message : String(r.reason)] : []));
  const missed = batches.flatMap((batch, n) => (read[n]?.status === 'rejected' ? batch.map((r) => r.path) : []));
  const byKey = new Map<string, Mr>();
  for (const r of read) if (r.status === 'fulfilled') for (const mr of r.value) byKey.set(keyOf(mr), mr);
  for (const mr of involved?.status === 'fulfilled' ? involved.value : []) byKey.set(keyOf(mr), mr);
  return { mrs: labelled(inScope([...byKey.values()])), missed, errors };
}

/** Each repo gets the short label GitLab's do, and two owners' repos of one name stay apart. */
function labelled(mrs: Mr[]): Mr[] {
  const labels = new Map(labelRepos([...new Set(mrs.map((m) => m.projectPath))]).map((r) => [r.path, r.label]));
  return mrs.map((m) => ({ ...m, repoLabel: labels.get(m.projectPath) ?? m.repoLabel }));
}

interface OwnerRepos {
  repositoryOwner: {
    repositories: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: { nameWithOwner: string; name: string; pushedAt: string | null; pullRequests: { totalCount: number } }[];
    };
  } | null;
}

const ORGS_QUERY = `query Orgs { ${RATE} viewer { login organizations(first: 100) { nodes { login } } } }`;
const OWNER_REPOS_QUERY = `query OwnerRepos($login: String!, $cursor: String) {
  ${RATE}
  repositoryOwner(login: $login) {
    repositories(first: 100, after: $cursor, isArchived: false, orderBy: { field: PUSHED_AT, direction: DESC }) {
      pageInfo { hasNextPage endCursor }
      nodes { nameWithOwner name pushedAt pullRequests(states: OPEN) { totalCount } }
    }
  }
}`;

/** Repos pushed to in the last 90 days with an open pull request, in your organisations and your own account. */
export async function discoverPrRepos(): Promise<RepoSpec[]> {
  const { viewer } = await graphql<{ viewer: { login: string; organizations: { nodes: { login: string }[] } } }>(ORGS_QUERY);
  const owners = [viewer.login, ...viewer.organizations.nodes.map((o) => o.login)];
  const since = Date.now() - STALE_DAYS * 86_400_000;
  const found: RepoSpec[] = [];
  for (const owner of owners) found.push(...(await ownerRepos(owner, since)));
  const labels = new Map(labelRepos(found.map((r) => r.path)).map((r) => [r.path, r.label]));
  return applyFilter(found.map((r) => ({ ...r, label: labels.get(r.path) ?? r.label })), githubSettings().repos);
}

async function ownerRepos(owner: string, since: number): Promise<RepoSpec[]> {
  const found: RepoSpec[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < DISCOVERY_PAGES; page += 1) {
    const data: OwnerRepos = await graphql<OwnerRepos>(OWNER_REPOS_QUERY, { login: owner, cursor });
    const repos = data.repositoryOwner?.repositories;
    if (!repos) break;
    const fresh = repos.nodes.filter((r) => r.pushedAt && Date.parse(r.pushedAt) >= since);
    found.push(...fresh.filter((r) => r.pullRequests.totalCount > 0).map((r) => ({ path: r.nameWithOwner, label: r.name, openCount: r.pullRequests.totalCount })));
    if (fresh.length < repos.nodes.length || !repos.pageInfo.hasNextPage) break;
    cursor = repos.pageInfo.endCursor;
  }
  return found;
}

const ONE_QUERY = `query Pr($owner: String!, $name: String!, $number: Int!) {
  ${RATE}
  repository(owner: $owner, name: $name) { pullRequest(number: $number) { ...pr } }
}
${PR_FIELDS}`;

export async function fetchPr(r: MrRef): Promise<Mr | null> {
  const readAt = Date.now();
  const data = await graphql<{ repository: { pullRequest: GhPr | null } | null }>(ONE_QUERY, prVars(r));
  const pr = data.repository?.pullRequest;
  return pr ? prOf(pr, labelRepos([pr.repository.nameWithOwner])[0]!.label, readAt) : null;
}

export async function fetchPrEnd(r: MrRef): Promise<MrEnd> {
  const data = await graphql<{ repository: { pullRequest: { state: GhPr['state']; mergedBy: { login: string } | null } | null } | null }>(
    `query PrEnd($owner: String!, $name: String!, $number: Int!) { ${RATE} repository(owner: $owner, name: $name) { pullRequest(number: $number) { state mergedBy { login } } } }`,
    prVars(r),
  );
  const pr = data.repository?.pullRequest;
  return { state: pr ? MR_STATE[pr.state] : null, mergedBy: pr?.mergedBy?.login ?? null };
}

export async function fetchPrDetail(r: MrRef): Promise<MrDetail> {
  const data = await graphql<{ repository: { pullRequest: { body: string | null; baseRefName: string; changedFiles: number; totalCommentsCount: number | null } | null } | null }>(
    `query PrDetail($owner: String!, $name: String!, $number: Int!) { ${RATE} repository(owner: $owner, name: $name) { pullRequest(number: $number) { body baseRefName changedFiles totalCommentsCount } } }`,
    prVars(r),
  );
  const pr = data.repository?.pullRequest;
  if (!pr) throw new Error(`GitHub has no ${keyOf(r)}`);
  return { description: pr.body ?? '', detailedMergeStatus: null, targetBranch: pr.baseRefName, changesCount: String(pr.changedFiles), userNotesCount: pr.totalCommentsCount ?? 0 };
}

interface GhComment {
  databaseId: number;
  author: { login: string; __typename?: string } | null;
  body: string;
  createdAt: string;
}

interface GhThread {
  id: string;
  isResolved: boolean;
  path: string;
  line: number | null;
  originalLine: number | null;
  diffSide: 'LEFT' | 'RIGHT';
  comments: { nodes: (GhComment & { originalCommit: { oid: string } | null })[] };
}

interface GhReviewBody extends GhComment {
  state: string;
}

const THREADS_QUERY = `query PrThreads($owner: String!, $name: String!, $number: Int!) {
  ${RATE}
  repository(owner: $owner, name: $name) {
    pullRequest(number: $number) {
      reviewThreads(first: 100) { nodes { id isResolved path line originalLine diffSide comments(first: 50) { nodes { databaseId body createdAt author { login __typename } originalCommit { oid } } } } }
      reviews(first: 100) { nodes { databaseId state body createdAt author { login __typename } } }
      comments(first: 100) { nodes { databaseId body createdAt author { login __typename } } }
    }
  }
}`;

const noteOf = (c: GhComment): Discussion['notes'][number] => ({
  id: c.databaseId,
  author: login(c.author) ?? 'ghost',
  body: c.body,
  createdAt: c.createdAt,
  system: false,
  ...(isBot(c.author) ? { bot: true } : {}),
});

function threadOf(t: GhThread): Discussion {
  const line = t.line ?? t.originalLine;
  const first = t.comments.nodes[0];
  return {
    id: t.id,
    resolved: t.isResolved,
    resolvable: true,
    position: { new_path: t.path, old_path: t.path, ...(t.diffSide === 'LEFT' ? { old_line: line } : { new_line: line }), head_sha: first?.originalCommit?.oid ?? null },
    notes: t.comments.nodes.map(noteOf),
  };
}

// A review's own words and a comment on the conversation are GitHub's plain comments: shown, and never resolvable.
const plain = (prefix: string, c: GhComment): Discussion => ({ id: `${prefix}${c.databaseId}`, resolved: true, resolvable: false, notes: [noteOf(c)] });

/** Line threads, the words of each review, and the conversation, oldest first as GitLab lists them. */
export async function fetchPrDiscussions(r: MrRef): Promise<Discussion[]> {
  const data = await graphql<{ repository: { pullRequest: { reviewThreads: { nodes: GhThread[] }; reviews: { nodes: GhReviewBody[] }; comments: { nodes: GhComment[] } } | null } | null }>(THREADS_QUERY, prVars(r));
  const pr = data.repository?.pullRequest;
  if (!pr) return [];
  const all = [
    ...pr.reviewThreads.nodes.filter((t) => t.comments.nodes.length).map(threadOf),
    ...pr.reviews.nodes.filter((v) => v.body.trim()).map((v) => plain('review-', v)),
    ...pr.comments.nodes.map((c) => plain('comment-', c)),
  ];
  return all.sort((a, b) => String(a.notes[0]?.createdAt).localeCompare(String(b.notes[0]?.createdAt)));
}

interface GhFile {
  filename: string;
  previous_filename?: string;
  patch?: string;
}

/** GitHub leaves the patch out of a file too big to show, and lists 3,000 files at most. */
export async function fetchPrFiles(r: MrRef): Promise<{ files: MrFile[]; complete: boolean }> {
  const files: MrFile[] = [];
  for (let page = 1; page <= MAX_FILE_PAGES; page += 1) {
    const raw = await rest<GhFile[]>(`/repos/${r.projectPath}/pulls/${r.iid}/files?per_page=${FILES_A_PAGE}&page=${page}`);
    files.push(...raw.map((f) => ({ oldPath: f.previous_filename ?? f.filename, newPath: f.filename, diff: f.patch ?? '', tooLarge: f.patch === undefined })));
    if (raw.length < FILES_A_PAGE) return { files, complete: true };
  }
  return { files, complete: false };
}

interface GhCompare {
  total_commits?: number;
  behind_by?: number;
  files?: { filename: string; previous_filename?: string }[];
}

const compare = (r: MrRef, base: string, head: string): Promise<GhCompare> => rest<GhCompare>(`/repos/${r.projectPath}/compare/${encodeURIComponent(base)}...${encodeURIComponent(head)}`);

export async function fetchPrSince(r: MrRef, from: string, to: string): Promise<{ commits: number; paths: string[] }> {
  const compared = await compare(r, from, to);
  return { commits: compared.total_commits ?? 0, paths: [...new Set((compared.files ?? []).flatMap((f) => [f.previous_filename ?? f.filename, f.filename]))] };
}

export async function fetchPrBranch(r: MrRef & { sha?: string | null }): Promise<BranchFacts> {
  const data = await graphql<{ repository: { pullRequest: { baseRefName: string; headRefOid: string } | null } | null }>(
    `query PrBranch($owner: String!, $name: String!, $number: Int!) { ${RATE} repository(owner: $owner, name: $name) { pullRequest(number: $number) { baseRefName headRefOid } } }`,
    prVars(r),
  );
  const pr = data.repository?.pullRequest;
  if (!pr) return { targetBranch: null, behind: null };
  const behind = await compare(r, pr.baseRefName, pr.headRefOid).then((c) => c.behind_by ?? null, () => null);
  return { targetBranch: pr.baseRefName, behind };
}

/** A file at a ref, read only as far as maxBytes. */
export async function fetchPrFile(r: MrRef, path: string, at: string, maxBytes: number): Promise<string | null | typeof TOO_BIG> {
  const encoded = path.split('/').map(encodeURIComponent).join('/');
  try {
    const res = await restStream(`/repos/${r.projectPath}/contents/${encoded}?ref=${encodeURIComponent(at)}`, 'application/vnd.github.raw+json');
    if (!res?.body) return res ? '' : null;
    const decoder = new TextDecoder();
    let text = '';
    let read = 0;
    for await (const chunk of res.body) {
      read += chunk.byteLength;
      if (read > maxBytes) return TOO_BIG;
      text += decoder.decode(chunk, { stream: true });
    }
    return text + decoder.decode();
  } catch {
    return null;
  }
}

interface GhCheckRun {
  __typename: 'CheckRun';
  databaseId: number;
  name: string;
  status: string;
  conclusion: string | null;
  startedAt: string | null;
  completedAt: string | null;
  detailsUrl: string | null;
  isRequired: boolean;
  checkSuite: { app: { name: string; slug: string } | null; workflowRun: { databaseId: number; workflow: { name: string } } | null } | null;
}

interface GhStatus {
  __typename: 'StatusContext';
  id: string;
  context: string;
  state: string;
  targetUrl: string | null;
  createdAt: string;
  isRequired: boolean;
  creator: { login: string } | null;
}

const CHECKS_QUERY = `query PrChecks($owner: String!, $name: String!, $number: Int!, $sha: GitObjectID!) {
  ${RATE}
  repository(owner: $owner, name: $name) {
    object(oid: $sha) {
      ... on Commit {
        statusCheckRollup {
          contexts(first: 100) {
            nodes {
              __typename
              ... on CheckRun { databaseId name status conclusion startedAt completedAt detailsUrl isRequired(pullRequestNumber: $number) checkSuite { app { name slug } workflowRun { databaseId workflow { name } } } }
              ... on StatusContext { id context state targetUrl createdAt isRequired(pullRequestNumber: $number) creator { login } }
            }
          }
        }
      }
    }
  }
}`;

export const RUN_STATUS: Record<string, string> = { QUEUED: 'pending', WAITING: 'pending', PENDING: 'pending', REQUESTED: 'pending', IN_PROGRESS: 'running' };

export const CONCLUSION: Record<string, string> = {
  SUCCESS: 'success', FAILURE: 'failed', TIMED_OUT: 'failed', STARTUP_FAILURE: 'failed', CANCELLED: 'canceled',
  SKIPPED: 'skipped', NEUTRAL: 'skipped', STALE: 'skipped', ACTION_REQUIRED: 'manual',
};

export const STATUS_STATE: Record<string, string> = { SUCCESS: 'success', FAILURE: 'failed', ERROR: 'failed', PENDING: 'pending', EXPECTED: 'pending' };

export const jobStatusOf = (run: Pick<GhCheckRun, 'status' | 'conclusion'>): string => (run.status === 'COMPLETED' ? (CONCLUSION[run.conclusion ?? ''] ?? 'failed') : (RUN_STATUS[run.status] ?? 'pending'));

const seconds = (from: string | null, to: string | null): number | null => (from && to ? Math.max(Math.round((Date.parse(to) - Date.parse(from)) / 1000), 0) : null);

// A commit status has no number of its own, so it is given a negative one no check run can have.
const statusId = (id: string): number => -(([...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) >>> 0, 7) % 2_000_000_000) + 1);

export type GithubJob = PipelineJob & { logs: boolean; webUrl: string | null };

export function jobOf(node: GhCheckRun | GhStatus): GithubJob {
  if (node.__typename === 'StatusContext') {
    return { id: statusId(node.id), pipelineId: 0, name: node.context, status: STATUS_STATE[node.state] ?? 'pending', stage: node.creator?.login ?? 'commit status', duration: null, allowFailure: !node.isRequired, logs: false, webUrl: node.targetUrl };
  }
  const run = node.checkSuite?.workflowRun;
  return {
    id: node.databaseId,
    pipelineId: run?.databaseId ?? 0,
    name: node.name,
    status: jobStatusOf(node),
    stage: run?.workflow.name ?? node.checkSuite?.app?.name ?? 'checks',
    duration: seconds(node.startedAt, node.completedAt),
    allowFailure: !node.isRequired,
    logs: Boolean(run) && node.checkSuite?.app?.slug === 'github-actions',
    webUrl: node.detailsUrl,
  };
}

/** Actions jobs and every other app's check runs, then commit statuses, newest run first as GitLab lists its pipeline. */
export async function fetchPrChecks(r: MrRef, sha: string): Promise<GithubJob[]> {
  const data = await graphql<{ repository: { object: { statusCheckRollup: { contexts: { nodes: (GhCheckRun | GhStatus)[] } } | null } | null } | null }>(CHECKS_QUERY, { ...prVars(r), sha });
  const nodes = data.repository?.object?.statusCheckRollup?.contexts.nodes ?? [];
  return nodes.filter((n) => n.__typename === 'CheckRun' || n.__typename === 'StatusContext').map(jobOf).sort((a, b) => b.pipelineId - a.pipelineId);
}

const STAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z ?/;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

/** An Actions log without its timestamps, colours and fold markers, as the run page shows it. */
export function plainLog(raw: string): string[] {
  const out: string[] = [];
  for (const line of raw.split('\n')) {
    const text = line.replace(/\r$/, '').replace(STAMP, '').replace(ANSI, '');
    if (text.startsWith('##[endgroup]')) continue;
    out.push(text.replace(/^##\[group\]/, '').replace(/^##\[(error|warning)\]/, (_, kind: string) => `${kind === 'error' ? 'Error' : 'Warning'}: `));
  }
  while (out.length > 0 && !out.at(-1)?.trim()) out.pop();
  return out;
}

/** GitHub redirects to the log itself, which only the end of is kept as it streams in. */
export async function fetchPrJobLog(r: MrRef, jobId: number, lines = 200): Promise<JobTrace> {
  const res = await restStream(`/repos/${r.projectPath}/actions/jobs/${jobId}/logs`, 'application/vnd.github+json');
  if (!res?.body) throw new Error(`GitHub has no log for job ${jobId}, or no longer keeps it`);
  const decoder = new TextDecoder();
  let text = '';
  let cut = false;
  for await (const chunk of res.body) {
    text += decoder.decode(chunk, { stream: true });
    if (text.length > LOG_TAIL_CHARS) {
      text = text.slice(-LOG_TAIL_CHARS);
      cut = true;
    }
  }
  text += decoder.decode();
  const all = plainLog(cut ? text.slice(text.indexOf('\n') + 1) : text);
  return { lines: all.slice(-lines), total: cut ? null : all.length };
}
