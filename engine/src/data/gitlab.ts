import { renderCommentBody, type SendHow } from '../comment.js';
import {
  graphqlUrl,
  restUrl,
  gitlabToken,
  type RepoSpec,
} from '../config.js';
import { isComplexityError, planBatches, splitBatch, type Batch } from '../batching.js';
import type { CommentEvent, Contribution } from '../leaderboard.js';
import { anchor } from '../diffpos.js';
import { withoutEmojiSelector } from '../flags.js';
import { idKey, keyOf, keyPath } from '../refs.js';
import { noteOwnActivity } from './store.js';
import { labelRepos, threadStateOf, TOO_BIG, type ThreadState } from './shared.js';
import { extractTicket, type Mr, type OwnActivity, type PipelineStatus, type QueuedComment } from '../types.js';

export const GITLAB_TIMEOUT_MS = 30_000;

/** A hung call would stall full auto while its heartbeat still looked live. */
function timeout(): AbortSignal {
  return AbortSignal.timeout(GITLAB_TIMEOUT_MS);
}

function ownActivity(projectId: number, iid: number, delta: Partial<OwnActivity>): void {
  try {
    noteOwnActivity(projectId, iid, delta);
  } catch {
    // The write has reached GitLab, and failing it now would get it sent again.
  }
}

const mrFields = (first: number): string => `
  id
  fullPath
  name
  mergeRequests(state: opened, first: ${first}, sort: UPDATED_DESC) {
    count
    nodes {
      iid title webUrl draft conflicts userNotesCount
      resolvableDiscussionsCount resolvedDiscussionsCount
      createdAt updatedAt diffHeadSha sourceBranch detailedMergeStatus autoMergeEnabled
      author { username }
      reviewers { nodes { username mergeRequestInteraction { reviewState } } }
      approvedBy { nodes { username } }
      headPipeline { id status }
    }
  }
`;

interface GqlProject {
  id: string;
  fullPath: string;
  name: string;
  mergeRequests: {
    count: number;
    nodes: GqlMr[];
  } | null;
}

interface GqlMr {
  iid: string;
  title: string;
  webUrl: string;
  draft: boolean;
  conflicts: boolean;
  userNotesCount: number;
  resolvableDiscussionsCount: number | null;
  resolvedDiscussionsCount: number | null;
  createdAt: string;
  updatedAt: string;
  diffHeadSha: string | null;
  sourceBranch: string;
  detailedMergeStatus: string | null;
  author: { username: string } | null;
  reviewers: { nodes: { username: string; mergeRequestInteraction?: { reviewState: string | null } | null }[] } | null;
  approvedBy: { nodes: { username: string }[] } | null;
  headPipeline: { id?: string; status: PipelineStatus } | null;
  autoMergeEnabled?: boolean | null;
  state?: string;
}

function reviewStatesOf(node: GqlMr): Record<string, string> {
  const states = (node.reviewers?.nodes ?? []).flatMap((r) => (r.mergeRequestInteraction?.reviewState ? [[r.username, r.mergeRequestInteraction.reviewState]] : []));
  return Object.fromEntries(states);
}

/** `gid://gitlab/Project/75654058` -> 75654058 */
export function numericId(gid: string): number {
  const m = gid.match(/(\d+)$/);
  return m && m[1] ? Number(m[1]) : NaN;
}

const RETRY_DELAYS_MS = [1_000, 4_000, 10_000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * A 429 is a request to wait, not a failure. Retried with the server's own Retry-After
 * where it gives one, because failing the refresh blanks a board the user is reading.
 */
async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  let res = await postGraphql(query, variables);
  for (const fallback of RETRY_DELAYS_MS) {
    if (res.status !== 429) break;
    const after = Number(res.headers.get('retry-after'));
    await sleep(Number.isFinite(after) && after > 0 ? after * 1000 : fallback);
    res = await postGraphql(query, variables);
  }
  if (!res.ok) {
    const hint = res.status === 429 ? ', still rate limited: poll less often or watch fewer repos' : '';
    throw new Error(`GitLab GraphQL ${res.status} ${res.statusText}${hint}`);
  }
  const body = (await res.json()) as { data?: T; errors?: { message: string }[] };
  if (body.errors?.length) {
    throw new Error(`GitLab GraphQL: ${body.errors.map((e) => e.message).join('; ')}`);
  }
  if (!body.data) throw new Error('GitLab GraphQL returned no data');
  return body.data;
}

function postGraphql(query: string, variables: Record<string, unknown>): Promise<Response> {
  return fetch(graphqlUrl(), {
    signal: timeout(),
    method: 'POST',
    headers: { 'PRIVATE-TOKEN': gitlabToken(), 'Content-Type': 'application/json' },
    body: JSON.stringify({ query, variables }),
  });
}

export function mapMr(project: GqlProject, node: GqlMr, label: string, readAt?: number): Mr {
  return {
    projectPath: project.fullPath,
    projectId: numericId(project.id),
    repoLabel: label,
    iid: Number(node.iid),
    title: withoutEmojiSelector(node.title),
    webUrl: node.webUrl,
    draft: node.draft,
    conflicts: node.conflicts,
    notes: node.userNotesCount,
    author: node.author?.username ?? 'unknown',
    reviewers: (node.reviewers?.nodes ?? []).map((r) => r.username),
    approvedBy: (node.approvedBy?.nodes ?? []).map((a) => a.username),
    pipeline: node.headPipeline?.status ?? null,
    ...(node.headPipeline?.id ? { pipelineId: numericId(node.headPipeline.id) } : {}),
    mergeStatus: node.detailedMergeStatus,
    createdAt: node.createdAt,
    updatedAt: node.updatedAt,
    sha: node.diffHeadSha,
    sourceBranch: node.sourceBranch,
    ticket: extractTicket(node.title, node.sourceBranch),
    unresolvedThreads: Math.max(
      (node.resolvableDiscussionsCount ?? 0) - (node.resolvedDiscussionsCount ?? 0),
      0,
    ),
    ...(node.state ? { state: node.state } : {}),
    ...(node.autoMergeEnabled == null ? {} : { autoMerge: node.autoMergeEnabled }),
    ...(node.reviewers?.nodes.some((r) => r.mergeRequestInteraction) ? { reviewStates: reviewStatesOf(node) } : {}),
    ...(readAt === undefined ? {} : { readAt }),
  };
}

/** Bounded so a wide scope does not open dozens of sockets at once. */
const MAX_CONCURRENT_BATCHES = 4;

async function fetchBatch(batch: Batch): Promise<Mr[]> {
  const aliases = batch.repos
    .map((_, n) => `p${n}: project(fullPath: $f${n}) { ${mrFields(batch.first)} }`)
    .join('\n');
  const params = batch.repos.map((_, n) => `$f${n}: ID!`).join(', ');
  const variables = Object.fromEntries(batch.repos.map((r, n) => [`f${n}`, r.path]));
  const readAt = Date.now();
  const data = await gql<Record<string, GqlProject | null>>(
    `query Mrs(${params}) { ${aliases} }`,
    variables,
  );
  const out: Mr[] = [];
  batch.repos.forEach((repo, n) => {
    const project = data[`p${n}`];
    if (!project?.mergeRequests) return;
    for (const node of project.mergeRequests.nodes) {
      out.push(mapMr(project, node, repo.label, readAt));
    }
  });
  return out;
}

export interface MrFetch {
  mrs: Mr[];
  /** Repos no query answered for, so a short list can say so instead of looking complete. */
  missed: string[];
  errors: string[];
}

/**
 * The complexity estimate is only an estimate, so a batch GitLab refuses is halved and
 * retried rather than dropped. Without this an estimate a few points out silently
 * returns an empty list for every repo in that batch.
 */
async function runBatch(batch: Batch, depth = 0): Promise<{ mrs: Mr[]; errors: string[] }> {
  try {
    return { mrs: await fetchBatch(batch), errors: [] };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const halves = isComplexityError(message) && depth < 4 ? splitBatch(batch) : [];
    if (halves.length === 0) return { mrs: [], errors: [message] };
    const parts = await Promise.all(halves.map((half) => runBatch(half, depth + 1)));
    return {
      mrs: parts.flatMap((p) => p.mrs),
      errors: parts.flatMap((p) => p.errors),
    };
  }
}

export async function fetchMrsDetailed(repos: RepoSpec[]): Promise<MrFetch> {
  const batches = planBatches(repos);
  const out: Mr[] = [];
  const errors: string[] = [];
  const answered = new Set<string>();

  for (let i = 0; i < batches.length; i += MAX_CONCURRENT_BATCHES) {
    const slice = batches.slice(i, i + MAX_CONCURRENT_BATCHES);
    const results = await Promise.all(slice.map((batch) => runBatch(batch)));
    results.forEach((result, n) => {
      out.push(...result.mrs);
      errors.push(...result.errors);
      if (result.errors.length === 0) {
        for (const repo of slice[n]?.repos ?? []) answered.add(repo.path);
      }
    });
  }

  const missed = repos.map((r) => r.path).filter((path) => !answered.has(path));
  // One unreachable project must not blank the whole board.
  if (out.length === 0 && errors.length > 0) throw new Error(errors[0] ?? 'GitLab unreachable');
  return { mrs: out, missed, errors };
}

export async function fetchMrs(repos: RepoSpec[]): Promise<Mr[]> {
  return (await fetchMrsDetailed(repos)).mrs;
}

async function rest<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${restUrl()}${path}`, {
    signal: timeout(),
    ...init,
    headers: {
      'PRIVATE-TOKEN': gitlabToken(),
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitLab ${res.status} ${res.statusText} on ${path}${text ? `: ${text.slice(0, 300)}` : ''}`);
  }
  if (res.status === 204 || res.headers.get('content-length') === '0') return undefined as T;
  return (await res.json()) as T;
}

/** GitLab lists only the subgroups you belong to, never a root on its own, so the roots are their paths' distinct first segments. */
export async function fetchRootNamespaces(): Promise<string[]> {
  const groups = await rest<{ full_path: string }[]>('/groups?per_page=100');
  const roots = new Set(groups.map((g) => g.full_path.split('/')[0] ?? '').filter(Boolean));
  return [...roots].sort();
}

/** Only repos with an open MR are worth polling, and asking each root namespace for its open MRs costs a handful of calls, not hundreds. */
export async function discoverRepos(roots?: string[]): Promise<RepoSpec[]> {
  const namespaces = roots ?? (await fetchRootNamespaces());
  const seen = new Map<string, { path: string; count: number }>();

  for (const root of namespaces) {
    for (let page = 1; page <= 10; page += 1) {
      const mrs = await rest<{ references: { full: string } }[]>(
        `/groups/${encodeURIComponent(root)}/merge_requests?state=opened&per_page=100&page=${page}`,
      ).catch(() => []);
      for (const mr of mrs) {
        const path = keyPath(mr.references.full);
        if (!path) continue;
        const entry = seen.get(path) ?? { path, count: 0 };
        entry.count += 1;
        seen.set(path, entry);
      }
      if (mrs.length < 100) break;
    }
  }
  const busiest = [...seen.values()].sort((a, b) => b.count - a.count);
  // The count rides along: it is what lets a refresh pack many quiet repos into one query.
  const labelled = labelRepos(busiest.map((e) => e.path));
  return labelled.map((repo, i) => ({ ...repo, openCount: busiest[i]?.count ?? 0 }));
}

export { labelRepos };

export interface NotePosition {
  new_path?: string | null;
  old_path?: string | null;
  new_line?: number | null;
  old_line?: number | null;
  /** The head the comment was written against. Not the merge request's head any more
   * once someone has pushed, which is what makes the comment outdated. */
  head_sha?: string | null;
}

export interface Discussion {
  id: string;
  resolved: boolean;
  /** False for a plain comment, which GitLab cannot resolve and `resolved` reads as true. */
  resolvable?: boolean;
  /** Present when the thread hangs off a line of the diff rather than the whole MR. */
  position?: NotePosition;
  notes: { id?: number; author: string; body: string; createdAt: string; system: boolean; bot?: boolean }[];
}

/** The reply trailer is for findings the agent wrote, not for words you typed yourself. */
export async function replyToDiscussion(
  projectId: number,
  iid: number,
  discussionId: string,
  body: string,
): Promise<void> {
  await rest(`/projects/${projectId}/merge_requests/${iid}/discussions/${discussionId}/notes`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
  ownActivity(projectId, iid, { notes: 1 });
}

export async function setDiscussionResolved(
  projectId: number,
  iid: number,
  discussionId: string,
  resolved: boolean,
): Promise<void> {
  await rest(
    `/projects/${projectId}/merge_requests/${iid}/discussions/${discussionId}?resolved=${resolved}`,
    { method: 'PUT' },
  );
  ownActivity(projectId, iid, { unresolved: resolved ? -1 : 1 });
}

/**
 * Author and approvers only. The full merge-request field set costs about six times as
 * much per project, and asking for note authors times GitLab out entirely, so the board
 * gets its own lean query that packs many projects into one request.
 */
const BOARD_FIELDS = (since: string, after?: string): string => `
  id
  fullPath
  mergeRequests(createdAfter: "${since}", first: 100, sort: CREATED_DESC${
    after ? `, after: "${after}"` : ''
  }) {
    count
    pageInfo { hasNextPage endCursor }
    nodes { iid createdAt mergedAt author { username } approvedBy { nodes { username } } }
  }
`;

export interface BoardProject {
  projectId: number;
  path: string;
  opened: Contribution[];
  /** When each was raised, for the daily series. */
  createdAt: string[];
  /** When each was merged, counted on the day it landed rather than the day it was raised. */
  mergedAt: string[];
  /** `<projectId>!<iid>` to author, so a comment can be told from a reply on your own MR. */
  authors: Map<string, string>;
  /** True only if the data is still short after paging, so the view can own up to it. */
  truncated: boolean;
  /** Where the next page starts, while there is one. */
  cursor: string | null;
}

const BOARD_PROJECTS_PER_QUERY = 6;

export interface BoardProgressHooks {
  onBatch?: (done: number, mrsSoFar: number) => void;
  onPaging?: (done: number, total: number, mrsSoFar: number) => void;
}

export async function fetchBoardMrs(
  repos: RepoSpec[],
  since: string,
  hooks: BoardProgressHooks = {},
): Promise<BoardProject[]> {
  const out: BoardProject[] = [];
  for (let i = 0; i < repos.length; i += BOARD_PROJECTS_PER_QUERY) {
    const batch = repos.slice(i, i + BOARD_PROJECTS_PER_QUERY);
    const aliases = batch
      .map((_, n) => `p${n}: project(fullPath: $f${n}) { ${BOARD_FIELDS(since)} }`)
      .join('\n');
    const params = batch.map((_, n) => `$f${n}: ID!`).join(', ');
    const variables = Object.fromEntries(batch.map((r, n) => [`f${n}`, r.path]));
    const data = await gql<Record<string, GqlBoardProject | null>>(
      `query board(${params}) { ${aliases} }`,
      variables,
    ).catch(() => ({}) as Record<string, GqlBoardProject | null>);

    batch.forEach((repo, n) => {
      const project = data[`p${n}`];
      if (!project?.mergeRequests) return;
      const projectId = numericId(project.id);
      const authors = new Map<string, string>();
      for (const node of project.mergeRequests.nodes) {
        authors.set(idKey({ projectId, iid: node.iid }), node.author?.username ?? '');
      }
      out.push({
        projectId,
        path: repo.path,
        opened: project.mergeRequests.nodes.map((node) => ({
          mr: idKey({ projectId, iid: node.iid }),
          author: node.author?.username ?? '',
          approvers: (node.approvedBy?.nodes ?? []).map((a) => a.username),
        })),
        createdAt: project.mergeRequests.nodes.map((node) => node.createdAt),
        mergedAt: project.mergeRequests.nodes.flatMap((node) =>
          node.mergedAt ? [node.mergedAt] : [],
        ),
        authors,
        truncated: project.mergeRequests.count > project.mergeRequests.nodes.length,
        cursor: project.mergeRequests.pageInfo.hasNextPage
          ? project.mergeRequests.pageInfo.endCursor
          : null,
      });
    });
    hooks.onBatch?.(
      Math.min(i + batch.length, repos.length),
      out.reduce((n, p) => n + p.opened.length, 0),
    );
  }

  // Batching one page per project is cheap and covers nearly every repo. The handful with
  // a month busier than a page get paged on their own rather than being left short.
  const busy = out.filter((p) => p.truncated);
  hooks.onPaging?.(0, busy.length, out.reduce((n, p) => n + p.opened.length, 0));
  for (const [i, project] of busy.entries()) {
    await pageRestOfProject(project, since);
    hooks.onPaging?.(i + 1, busy.length, out.reduce((n, p) => n + p.opened.length, 0));
  }
  return out;
}

const MAX_MR_PAGES = 30;

async function pageRestOfProject(project: BoardProject, since: string): Promise<void> {
  let cursor = project.cursor;
  for (let page = 0; page < MAX_MR_PAGES && cursor; page += 1) {
    const data = await gql<{ project: GqlBoardProject | null }>(
      `query page($f: ID!) { project(fullPath: $f) { ${BOARD_FIELDS(since, cursor)} } }`,
      { f: project.path },
    ).catch(() => null);
    const mrs = data?.project?.mergeRequests;
    if (!mrs) return;

    for (const node of mrs.nodes) {
      project.authors.set(idKey({ projectId: project.projectId, iid: node.iid }), node.author?.username ?? '');
      project.opened.push({
        mr: idKey({ projectId: project.projectId, iid: node.iid }),
        author: node.author?.username ?? '',
        approvers: (node.approvedBy?.nodes ?? []).map((a) => a.username),
      });
      project.createdAt.push(node.createdAt);
      if (node.mergedAt) project.mergedAt.push(node.mergedAt);
    }
    cursor = mrs.pageInfo.hasNextPage ? mrs.pageInfo.endCursor : null;
  }
  project.truncated = Boolean(cursor);
  project.cursor = null;
}

interface GqlBoardProject {
  id: string;
  fullPath: string;
  mergeRequests: {
    count: number;
    pageInfo: { hasNextPage: boolean; endCursor: string | null };
    nodes: {
      iid: string;
      createdAt: string;
      mergedAt: string | null;
      author: { username: string } | null;
      approvedBy: { nodes: { username: string }[] } | null;
    }[];
  } | null;
}

interface RawEvent {
  author: { username: string };
  created_at: string;
  project_id: number;
  note?: { noteable_type?: string; noteable_iid?: number };
  target_title?: string;
}

/**
 * Who commented on what. GitLab has no per-author filter here, so the whole stream is
 * read and grouped locally; `pages` bounds a busy repo rather than letting one project
 * spend the whole budget.
 */
export async function fetchCommentEvents(
  projectId: number,
  since: string,
  authors: Map<string, string>,
  pages = 40,
): Promise<{ events: CommentEvent[]; complete: boolean }> {
  const events: CommentEvent[] = [];
  let complete = true;
  for (let page = 1; page <= pages; page += 1) {
    const raw = await rest<RawEvent[]>(
      `/projects/${projectId}/events?action=commented&after=${since}&per_page=100&page=${page}`,
    ).catch(() => []);
    for (const e of raw) {
      if (e.note?.noteable_type !== 'MergeRequest' || !e.note.noteable_iid) continue;
      const mr = idKey({ projectId, iid: e.note.noteable_iid });
      // An unknown author means the MR was opened before the window, so it is not yours
      // to be replying on by default; an empty name simply never matches the commenter.
      events.push({
        user: e.author.username,
        mr,
        author: authors.get(mr) ?? '',
        at: e.created_at,
      });
    }
    if (raw.length < 100) return { events, complete };
    if (page === pages) complete = false;
  }
  return { events, complete };
}

export async function fetchDiscussions(projectId: number, iid: number): Promise<Discussion[]> {
  const raw = await rest<
    {
      id: string;
      notes: {
        id: number;
        author: { username: string; bot?: boolean };
        body: string;
        created_at: string;
        system: boolean;
        resolvable?: boolean;
        resolved?: boolean;
        position?: NotePosition | null;
      }[];
    }[]
  >(`/projects/${projectId}/merge_requests/${iid}/discussions?per_page=100`);
  return raw
    .filter((d) => d.notes.some((n) => !n.system))
    .map((d) => ({
      id: d.id,
      resolved: d.notes.every((n) => n.resolved !== false),
      resolvable: d.notes.some((n) => n.resolvable === true),
      // The anchor lives on the note that opened the thread; replies carry none.
      ...(d.notes.find((n) => n.position)?.position
        ? { position: d.notes.find((n) => n.position)?.position as NotePosition }
        : {}),
      notes: d.notes
        .filter((n) => !n.system)
        .map((n) => ({
          id: n.id,
          author: n.author.username,
          body: n.body,
          createdAt: n.created_at,
          system: n.system,
          ...(n.author.bot ? { bot: true } : {}),
        })),
    }));
}

export interface PipelineJob {
  id: number;
  pipelineId: number;
  name: string;
  status: string;
  stage: string;
  duration: number | null;
  allowFailure: boolean;
}

interface RestJob {
  id: number;
  name: string;
  status: string;
  stage: string;
  duration: number | null;
  allow_failure?: boolean;
}

export async function fetchPipelineJobs(projectId: number, sha: string): Promise<PipelineJob[]> {
  const pipelines = await rest<{ id: number }[]>(
    `/projects/${projectId}/pipelines?sha=${sha}&per_page=1`,
  );
  const first = pipelines[0];
  if (!first) return [];
  const jobs = await rest<RestJob[]>(`/projects/${projectId}/pipelines/${first.id}/jobs?per_page=100`);
  return jobs.map((j) => ({
    id: j.id,
    pipelineId: first.id,
    name: j.name,
    status: j.status,
    stage: j.stage,
    duration: j.duration ?? null,
    allowFailure: Boolean(j.allow_failure),
  }));
}

const TRACE_TAIL_CHARS = 256 * 1024;
const SECTION_MARKER = /section_(?:start|end):\d+:/;
const ANSI = /\x1b\[[0-9;?]*[A-Za-z]/g;

export interface JobTrace {
  lines: string[];
  /** Lines in the whole log, or null when it was too long to keep whole. */
  total: number | null;
}

/** GitLab.com answers a Range on a job log with the whole log, so only the end of it is kept as it streams in. */
export async function fetchJobTrace(projectId: number, jobId: number, lines = 200): Promise<JobTrace> {
  const path = `/projects/${projectId}/jobs/${jobId}/trace`;
  const res = await fetch(`${restUrl()}${path}`, { signal: timeout(), headers: { 'PRIVATE-TOKEN': gitlabToken() } });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`GitLab ${res.status} ${res.statusText} on ${path}${text ? `: ${text.slice(0, 300)}` : ''}`);
  }
  const { text, cut } = await streamTail(res, TRACE_TAIL_CHARS);
  const all = plainTrace(cut ? text.slice(text.indexOf('\n') + 1) : text);
  return { lines: all.slice(-lines), total: cut ? null : all.length };
}

async function streamTail(res: Response, max: number): Promise<{ text: string; cut: boolean }> {
  if (!res.body) return { text: '', cut: false };
  const decoder = new TextDecoder();
  let text = '';
  let cut = false;
  for await (const chunk of res.body) {
    text += decoder.decode(chunk, { stream: true });
    if (text.length > max) {
      text = text.slice(-max);
      cut = true;
    }
  }
  return { text: text + decoder.decode(), cut };
}

/** The log as GitLab shows it: each line as last rewritten after a carriage return, which also drops section markers, without colours or lines that held only a marker. */
export function plainTrace(raw: string): string[] {
  const out: string[] = [];
  for (const line of raw.split('\n')) {
    const text = (line.replace(/\r$/, '').split('\r').pop() ?? '').replace(ANSI, '');
    if (!text.trim() && SECTION_MARKER.test(line)) continue;
    out.push(text);
  }
  while (out.length > 0 && !out.at(-1)?.trim()) out.pop();
  return out;
}

export async function retryJob(projectId: number, jobId: number): Promise<{ id: number; status: string }> {
  return rest<{ id: number; status: string }>(`/projects/${projectId}/jobs/${jobId}/retry`, { method: 'POST' });
}

/** Retries every failed or cancelled job in the pipeline, as GitLab's own Retry does. */
export async function retryPipeline(projectId: number, pipelineId: number): Promise<{ id: number; status: string }> {
  return rest<{ id: number; status: string }>(`/projects/${projectId}/pipelines/${pipelineId}/retry`, { method: 'POST' });
}


/** The diff of each changed file, keyed by its path on either side. */
export async function fetchMrDiffs(projectId: number, iid: number): Promise<Map<string, string>> {
  const files = await rest<{ old_path: string; new_path: string; diff: string }[]>(
    `/projects/${projectId}/merge_requests/${iid}/diffs?per_page=100`,
  );
  const out = new Map<string, string>();
  for (const f of files) {
    if (f.new_path) out.set(f.new_path, f.diff);
    if (f.old_path) out.set(f.old_path, f.diff);
  }
  return out;
}

const MAX_DIFF_PAGES = 10;

export interface MrFile {
  oldPath: string;
  newPath: string;
  diff: string;
  tooLarge: boolean;
}

/** Running out of pages reports the diff incomplete rather than pretending the rest is not there. */
export async function fetchMrFiles(
  projectId: number,
  iid: number,
): Promise<{ files: MrFile[]; complete: boolean }> {
  const files: MrFile[] = [];
  for (let page = 1; page <= MAX_DIFF_PAGES; page += 1) {
    const raw = await rest<
      { old_path: string; new_path: string; diff: string; too_large?: boolean; collapsed?: boolean }[]
    >(`/projects/${projectId}/merge_requests/${iid}/diffs?per_page=100&page=${page}`);
    for (const f of raw) {
      files.push({
        oldPath: f.old_path,
        newPath: f.new_path,
        diff: f.diff ?? '',
        tooLarge: Boolean(f.too_large || f.collapsed),
      });
    }
    if (raw.length < 100) return { files, complete: true };
  }
  return { files, complete: false };
}

export async function fetchSince(projectId: number, from: string, to: string): Promise<{ commits: number; paths: string[] }> {
  const compared = await rest<{ commits?: unknown[]; diffs: { old_path: string; new_path: string }[] }>(
    `/projects/${projectId}/repository/compare?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&straight=true`,
  );
  return { commits: compared.commits?.length ?? 0, paths: [...new Set(compared.diffs.flatMap((d) => [d.old_path, d.new_path]))] };
}

export async function fetchChangedPaths(projectId: number, from: string, to: string): Promise<string[]> {
  return (await fetchSince(projectId, from, to)).paths;
}

/** A file at a given ref. Null when it is binary, gone, or simply not readable. */
export async function fetchFile(
  projectId: number,
  path: string,
  ref: string,
): Promise<string | null> {
  try {
    const res = await fetchRaw(projectId, path, ref);
    if (!res.ok) return null;
    return await res.text();
  } catch {
    return null;
  }
}

export { TOO_BIG };

/** Stops reading past maxBytes, so a huge file is never held whole. */
export async function fetchFileWithin(
  projectId: number,
  path: string,
  ref: string,
  maxBytes: number,
): Promise<string | null | typeof TOO_BIG> {
  try {
    const res = await fetchRaw(projectId, path, ref);
    if (!res.ok) return null;
    if (!res.body) return '';
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

function fetchRaw(projectId: number, path: string, ref: string): Promise<Response> {
  const url =
    `/projects/${projectId}/repository/files/${encodeURIComponent(path)}/raw` +
    `?ref=${encodeURIComponent(ref)}`;
  return fetch(`${restUrl()}${url}`, { signal: timeout(), headers: { 'PRIVATE-TOKEN': gitlabToken() } });
}

export async function postComment(comment: QueuedComment, how: SendHow = {}): Promise<{ id: string }> {
  let position = comment.position;
  let unanchored = '';

  if (position) {
    const requested = position;
    const path = requested.new_path ?? requested.old_path ?? '';
    const diffs = await fetchMrDiffs(comment.projectId, comment.iid).catch(() => null);
    const diff = diffs?.get(path);
    const fixed = diff ? anchor(requested, diff) : requested;
    if (fixed) {
      position = fixed;
    } else {
      // The line is nowhere in the diff, usually because the file moved on since the
      // review. Losing the finding would be worse than losing the anchor.
      position = undefined;
      const line = requested.new_line ?? requested.old_line;
      unanchored = `\`${path}${line ? `:${line}` : ''}\`\n\n`;
    }
  }

  const payload: Record<string, unknown> = { body: unanchored + renderCommentBody(comment, how) };
  if (position) payload['position'] = { position_type: 'text', ...position };

  const created = await rest<{ id: string }>(
    `/projects/${comment.projectId}/merge_requests/${comment.iid}/discussions`,
    { method: 'POST', body: JSON.stringify(payload) },
  );
  ownActivity(comment.projectId, comment.iid, { notes: 1, unresolved: 1 });
  return created;
}

/** Used by `underlings changed` and the poller for a single MR, without refetching the world. */
export async function fetchOneMr(projectPath: string, iid: number): Promise<Mr | null> {
  const readAt = Date.now();
  const data = await gql<Record<string, GqlProject | null>>(
    `query One($f: ID!, $iid: String!) {
       p0: project(fullPath: $f) {
         id fullPath name
         mergeRequests(iids: [$iid], first: 1) {
           count
           nodes {
             iid title webUrl draft conflicts userNotesCount state
             resolvableDiscussionsCount resolvedDiscussionsCount
             createdAt updatedAt diffHeadSha sourceBranch detailedMergeStatus autoMergeEnabled
             author { username }
             reviewers { nodes { username mergeRequestInteraction { reviewState } } }
             approvedBy { nodes { username } }
             headPipeline { id status }
           }
         }
       }
     }`,
    { f: projectPath, iid: String(iid) },
  );
  const project = data['p0'];
  const node = project?.mergeRequests?.nodes[0];
  if (!project || !node) return null;
  return mapMr(project, node, project.name, readAt);
}

export interface MrDetail {
  description: string;
  detailedMergeStatus: string | null;
  targetBranch: string | null;
  /** GitLab caps it as a string, '1000+'. */
  changesCount: string | null;
  userNotesCount: number;
}

export async function fetchMrDetail(projectId: number, iid: number): Promise<MrDetail> {
  const mr = await rest<{
    description: string | null;
    detailed_merge_status?: string | null;
    target_branch?: string | null;
    changes_count?: string | null;
    user_notes_count?: number | null;
  }>(`/projects/${projectId}/merge_requests/${iid}`);
  return {
    description: mr.description ?? '',
    detailedMergeStatus: mr.detailed_merge_status ?? null,
    targetBranch: mr.target_branch ?? null,
    changesCount: mr.changes_count ?? null,
    userNotesCount: mr.user_notes_count ?? 0,
  };
}

export type MrState = 'opened' | 'closed' | 'locked' | 'merged';

export interface MrEnd {
  state: MrState | null;
  mergedBy: string | null;
}

/** Who merged it too; GitLab names whoever set merge when green as the merger. */
export async function fetchMrEnd(projectPath: string, iid: number): Promise<MrEnd> {
  const data = await gql<{ project: { mergeRequest: { state: MrState; mergeUser: { username: string } | null } | null } | null }>(
    `query End($f: ID!, $iid: String!) { project(fullPath: $f) { mergeRequest(iid: $iid) { state mergeUser { username } } } }`,
    { f: projectPath, iid: String(iid) },
  );
  const mr = data.project?.mergeRequest;
  return { state: mr?.state ?? null, mergedBy: mr?.mergeUser?.username ?? null };
}

/** null when GitLab no longer has the MR, or no longer lets the token see it. */
export async function fetchMrState(projectPath: string, iid: number): Promise<MrState | null> {
  const data = await gql<{ project: { mergeRequest: { state: MrState } | null } | null }>(
    `query State($f: ID!, $iid: String!) { project(fullPath: $f) { mergeRequest(iid: $iid) { state } } }`,
    { f: projectPath, iid: String(iid) },
  );
  return data.project?.mergeRequest?.state ?? null;
}

export async function fetchMe(): Promise<string> {
  const me = await rest<{ username: string }>('/user');
  return me.username;
}

export async function fetchMyName(): Promise<string> {
  const me = await rest<{ name?: string }>('/user');
  return me.name ?? '';
}

/** GitLab answers "Reviewer not found" to a caller who is not an assigned reviewer and places the hold anyway, so errors come back as a warning. */
export async function setMergeHold(
  projectPath: string,
  iid: number,
  held: boolean,
): Promise<{ status: string | null; warning?: string }> {
  const field = held ? 'mergeRequestRequestChanges' : 'mergeRequestDestroyRequestedChanges';
  const data = await gql<Record<string, { errors: string[]; mergeRequest: { detailedMergeStatus: string } | null }>>(
    `mutation Hold($path: ID!, $iid: String!) {
       ${field}(input: { projectPath: $path, iid: $iid }) {
         errors
         mergeRequest { detailedMergeStatus }
       }
     }`,
    { path: projectPath, iid: String(iid) },
  );
  const result = data[field];
  const status = result?.mergeRequest?.detailedMergeStatus ?? null;
  const errors = result?.errors ?? [];
  return errors.length > 0 ? { status, warning: errors.join('; ') } : { status };
}

export function isHeld(mr: Mr): boolean {
  return (mr.mergeStatus ?? '').toUpperCase() === 'REQUESTED_CHANGES';
}

/** Your own reviewer state, so a colleague's change request is never read as yours; a copy read without reviewer states falls back to the MR's. */
export function heldByMe(mr: Mr, me: string): boolean {
  if (!mr.reviewStates) return isHeld(mr);
  return mr.reviewStates[me] === 'REQUESTED_CHANGES';
}

export function changesRequestedBy(mr: Mr): string[] {
  return Object.entries(mr.reviewStates ?? {}).filter(([, state]) => state === 'REQUESTED_CHANGES').map(([name]) => name);
}

export interface Todo {
  id: number;
  action: string;
  key: string;
  author: string;
  createdAt: string;
  text: string;
}

interface RestTodo {
  id: number;
  action_name: string;
  author?: { username?: string };
  project?: { path_with_namespace?: string };
  target?: { iid?: number };
  created_at: string;
  body?: string;
}

/** Read only: GitLab marks most of these done itself when you reply or approve. */
export async function fetchTodos(): Promise<Todo[]> {
  const todos = await rest<RestTodo[]>('/todos?state=pending&type=MergeRequest&per_page=100');
  return todos
    .filter((t) => t.project?.path_with_namespace && t.target?.iid)
    .map((t) => ({
      id: t.id,
      action: t.action_name,
      key: keyOf({ projectPath: String(t.project?.path_with_namespace), iid: Number(t.target?.iid) }),
      author: t.author?.username ?? '',
      createdAt: t.created_at,
      text: String(t.body ?? '').slice(0, 500),
    }));
}

/** GitLab refuses with its own words when nothing is set to merge, and those are shown as they are. */
export async function cancelAutoMerge(projectId: number, iid: number): Promise<void> {
  await rest(`/projects/${projectId}/merge_requests/${iid}/cancel_merge_when_pipeline_succeeds`, { method: 'POST' });
}

export type { ThreadEntry, ThreadState } from './shared.js';

/**
 * Who said what in the threads you are in. The list query gives a total unresolved count
 * for free, but not whether any of it is yours, which is the difference between an MR
 * that is busy and one that is waiting on you.
 */
export async function fetchThreadState(
  projectId: number,
  iid: number,
  me: string,
  head?: string | null,
): Promise<ThreadState> {
  return threadStateOf(await fetchDiscussions(projectId, iid), me, head);
}

/** A plain MR comment, not a thread on a line. */
export async function postNote(projectId: number, iid: number, body: string): Promise<{ id: number }> {
  const created = await rest<{ id: number }>(`/projects/${projectId}/merge_requests/${iid}/notes`, {
    method: 'POST',
    body: JSON.stringify({ body }),
  });
  ownActivity(projectId, iid, { notes: 1 });
  return created;
}

/**
 * Approving is the other half of the hold: it is how a reviewer says the change is good,
 * and on GitLab it also clears a change request you placed yourself.
 */
export async function setApproval(
  projectId: number,
  iid: number,
  approved: boolean,
): Promise<void> {
  await rest<unknown>(
    `/projects/${projectId}/merge_requests/${iid}/${approved ? 'approve' : 'unapprove'}`,
    { method: 'POST' },
  );
  ownActivity(projectId, iid, { approvals: approved ? 1 : -1 });
}

export interface RebaseState {
  inProgress: boolean;
  error: string | null;
}

/** GitLab rebases in the background, so this only starts it and rebaseState says when it has finished. */
export async function rebaseMr(projectId: number, iid: number): Promise<void> {
  await rest(`/projects/${projectId}/merge_requests/${iid}/rebase`, { method: 'PUT' });
}

export async function rebaseState(projectId: number, iid: number): Promise<RebaseState> {
  const mr = await rest<{ rebase_in_progress?: boolean; merge_error?: string | null }>(
    `/projects/${projectId}/merge_requests/${iid}?include_rebase_in_progress=true`,
  );
  return { inProgress: Boolean(mr.rebase_in_progress), error: mr.merge_error ?? null };
}

export async function setDraft(projectPath: string, iid: number, draft: boolean): Promise<{ draft: boolean }> {
  const data = await gql<{ mergeRequestSetDraft: { errors: string[]; mergeRequest: { draft: boolean } | null } }>(
    `mutation Draft($path: ID!, $iid: String!, $draft: Boolean!) {
       mergeRequestSetDraft(input: { projectPath: $path, iid: $iid, draft: $draft }) {
         errors
         mergeRequest { draft }
       }
     }`,
    { path: projectPath, iid: String(iid), draft },
  );
  const result = data.mergeRequestSetDraft;
  if (result.errors.length > 0) throw new Error(`GitLab: ${result.errors.join('; ')}`);
  return { draft: Boolean(result.mergeRequest?.draft) };
}

export interface MergeOutcome {
  merged: boolean;
  autoMerge: boolean;
}

/** The head is sent, so GitLab itself refuses a branch that moved after you looked. */
export async function mergeMr(
  projectId: number,
  iid: number,
  { sha, whenGreen }: { sha: string; whenGreen: boolean },
): Promise<MergeOutcome> {
  const body = whenGreen ? { sha, auto_merge: true, merge_when_pipeline_succeeds: true } : { sha };
  const mr = await rest<{ state: string; merge_when_pipeline_succeeds?: boolean }>(
    `/projects/${projectId}/merge_requests/${iid}/merge`,
    { method: 'PUT', body: JSON.stringify(body) },
  );
  return { merged: mr.state === 'merged', autoMerge: Boolean(mr.merge_when_pipeline_succeeds) };
}

async function userId(username: string): Promise<number> {
  const users = await rest<{ id: number; username: string }[]>(`/users?username=${encodeURIComponent(username)}`);
  const user = users.find((u) => u.username.toLowerCase() === username.toLowerCase());
  if (!user) throw new Error(`GitLab has no user ${username}`);
  return user.id;
}

/** Replaces the whole list; GitLab reads a lone 0 as no reviewers at all. */
export async function setReviewers(projectId: number, iid: number, usernames: string[]): Promise<string[]> {
  const ids = await Promise.all(usernames.map(userId));
  const mr = await rest<{ reviewers?: { username: string }[] }>(`/projects/${projectId}/merge_requests/${iid}`, {
    method: 'PUT',
    body: JSON.stringify({ reviewer_ids: ids.length > 0 ? ids : [0] }),
  });
  return (mr.reviewers ?? []).map((r) => r.username);
}

export async function rerequestReview(projectPath: string, iid: number, username: string): Promise<void> {
  const id = await userId(username);
  const data = await gql<{ mergeRequestReviewerRereview: { errors: string[] } }>(
    `mutation Rereview($path: ID!, $iid: String!, $user: UserID!) {
       mergeRequestReviewerRereview(input: { projectPath: $path, iid: $iid, userId: $user }) { errors }
     }`,
    { path: projectPath, iid: String(iid), user: `gid://gitlab/User/${id}` },
  );
  const errors = data.mergeRequestReviewerRereview.errors;
  if (errors.length > 0) throw new Error(`GitLab: ${errors.join('; ')}`);
}

export interface BranchFacts {
  targetBranch: string | null;
  behind: number | null;
}

/** GitLab says need_rebase only for fast-forward projects, so how far behind a branch is comes from here. */
export async function fetchBranchFacts(projectId: number, iid: number): Promise<BranchFacts> {
  const mr = await rest<{ target_branch?: string | null; diverged_commits_count?: number | null }>(
    `/projects/${projectId}/merge_requests/${iid}?include_diverged_commits_count=true`,
  );
  return { targetBranch: mr.target_branch ?? null, behind: mr.diverged_commits_count ?? null };
}

export interface ActivityEvent {
  action: string;
  projectId: number;
  iid: number | null;
  title: string;
  author: string;
  at: string;
}

interface RawActivity {
  action_name?: string;
  project_id?: number;
  target_type?: string | null;
  target_iid?: number | null;
  target_title?: string | null;
  author?: { username?: string } | null;
  author_username?: string;
  created_at?: string;
  note?: { noteable_type?: string; noteable_iid?: number } | null;
}

const ACTIVITY_PAGES = 50;
const MY_MR_PAGES = 5;

function activityOf(e: RawActivity): ActivityEvent {
  const onMrNote = e.note?.noteable_type === 'MergeRequest';
  const iid = onMrNote ? e.note?.noteable_iid : e.target_type === 'MergeRequest' ? e.target_iid : null;
  return {
    action: e.action_name ?? '',
    projectId: e.project_id ?? 0,
    iid: iid ?? null,
    title: e.target_title ?? '',
    author: e.author?.username ?? e.author_username ?? '',
    at: e.created_at ?? '',
  };
}

/** The token's own events; `after` and `before` are dates, and GitLab leaves both days out. */
export async function fetchMyEvents(after: string, before: string): Promise<ActivityEvent[]> {
  const out: ActivityEvent[] = [];
  for (let page = 1; page <= ACTIVITY_PAGES; page += 1) {
    const raw = await rest<RawActivity[]>(`/events?after=${after}&before=${before}&per_page=100&page=${page}`);
    out.push(...raw.map(activityOf));
    if (raw.length < 100) break;
  }
  return out;
}

export interface MrBrief {
  projectId: number;
  projectPath: string;
  iid: number;
  title: string;
  author: string;
  sourceBranch: string;
  webUrl: string;
  draft: boolean;
  conflicts: boolean;
  mergeStatus: string | null;
  mergedAt: string | null;
  reviewers: string[];
}

interface RawMr {
  project_id: number;
  iid: number;
  title?: string;
  author?: { username?: string } | null;
  source_branch?: string;
  web_url?: string;
  draft?: boolean;
  has_conflicts?: boolean;
  detailed_merge_status?: string | null;
  merged_at?: string | null;
  reviewers?: { username: string }[];
  references?: { full?: string };
}

function briefOf(mr: RawMr): MrBrief {
  return {
    projectId: mr.project_id,
    projectPath: keyPath(mr.references?.full) ?? String(mr.project_id),
    iid: mr.iid,
    title: withoutEmojiSelector(mr.title ?? ''),
    author: mr.author?.username ?? '',
    sourceBranch: mr.source_branch ?? '',
    webUrl: mr.web_url ?? '',
    draft: Boolean(mr.draft),
    conflicts: Boolean(mr.has_conflicts),
    mergeStatus: mr.detailed_merge_status ?? null,
    mergedAt: mr.merged_at ?? null,
    reviewers: (mr.reviewers ?? []).map((r) => r.username),
  };
}

export async function fetchMrBrief(projectId: number, iid: number): Promise<MrBrief> {
  return briefOf(await rest<RawMr>(`/projects/${projectId}/merge_requests/${iid}`));
}

export async function fetchMyMrs(state: 'opened' | 'merged', updatedAfter?: string): Promise<MrBrief[]> {
  const out: MrBrief[] = [];
  const since = updatedAfter ? `&updated_after=${encodeURIComponent(updatedAfter)}` : '';
  for (let page = 1; page <= MY_MR_PAGES; page += 1) {
    const raw = await rest<RawMr[]>(`/merge_requests?scope=created_by_me&state=${state}${since}&per_page=100&page=${page}`);
    out.push(...raw.map(briefOf));
    if (raw.length < 100) break;
  }
  return out;
}

export async function fetchApprovers(projectId: number, iid: number): Promise<string[]> {
  const approvals = await rest<{ approved_by?: { user?: { username?: string } }[] }>(`/projects/${projectId}/merge_requests/${iid}/approvals`);
  return (approvals.approved_by ?? []).flatMap((a) => (a.user?.username ? [a.user.username] : []));
}

export interface MergedMr {
  projectPath: string;
  iid: number;
  title: string;
  sourceBranch: string;
  webUrl: string;
  mergedAt: string;
  author: string;
  additions: number;
  deletions: number;
}

interface GqlMergedPage {
  group: {
    mergeRequests: {
      pageInfo: { hasNextPage: boolean; endCursor: string | null };
      nodes: {
        iid: string;
        title: string;
        webUrl: string;
        sourceBranch: string;
        mergedAt: string;
        author: { username: string; name?: string | null } | null;
        project: { fullPath: string };
        diffStatsSummary: { additions: number; deletions: number } | null;
      }[];
    };
  } | null;
}

const MERGED_PAGES = 50;
const MERGED_QUERY = `query merged($group: ID!, $after: Time!, $before: Time, $cursor: String) {
  group(fullPath: $group) {
    mergeRequests(state: merged, mergedAfter: $after, mergedBefore: $before, includeSubgroups: true, sort: MERGED_AT_DESC, first: 100, after: $cursor) {
      pageInfo { hasNextPage endCursor }
      nodes { iid title webUrl sourceBranch mergedAt author { username name } project { fullPath } diffStatsSummary { additions deletions } }
    }
  }
}`;

export async function fetchMergedMrs(group: string, after: string, before: string | null = null): Promise<MergedMr[]> {
  const out: MergedMr[] = [];
  let cursor: string | null = null;
  for (let page = 0; page < MERGED_PAGES; page += 1) {
    const data: GqlMergedPage = await gql<GqlMergedPage>(MERGED_QUERY, { group, after, before, cursor });
    if (!data.group) throw new Error(`GitLab has no group ${group} that this token can read`);
    const { nodes, pageInfo } = data.group.mergeRequests;
    out.push(...nodes.map((node) => ({
      projectPath: node.project.fullPath,
      iid: Number(node.iid),
      title: withoutEmojiSelector(node.title),
      sourceBranch: node.sourceBranch,
      webUrl: node.webUrl,
      mergedAt: node.mergedAt,
      author: node.author?.name || node.author?.username || '',
      additions: node.diffStatsSummary?.additions ?? 0,
      deletions: node.diffStatsSummary?.deletions ?? 0,
    })));
    if (!pageInfo.hasNextPage) return out;
    cursor = pageInfo.endCursor;
  }
  throw new Error(`more than ${MERGED_PAGES * 100} MRs merged in ${group} between ${after} and ${before ?? 'now'}`);
}
