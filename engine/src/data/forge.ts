import type { SendHow } from '../comment.js';
import type { RepoSpec } from '../config.js';
import type { CommentEvent } from '../leaderboard.js';
import type { MrRef, Provider } from '../refs.js';
import type { Mr, QueuedComment } from '../types.js';
import {
  type ActivityEvent,
  type BoardProgressHooks,
  type BoardProject,
  type BranchFacts,
  type Discussion,
  type JobTrace,
  type MergedMr,
  type MergeOutcome,
  type MrBrief,
  type MrDetail,
  type MrEnd,
  type MrFetch,
  type MrFile,
  type MrState,
  type PipelineJob,
  type RebaseState,
  type ThreadState,
  type Todo,
} from './gitlab.js';
import { githubForge } from './github-forge.js';
import { githubOn } from './github.js';
import { gitlabForge } from './gitlab-forge.js';
import { TOO_BIG } from './shared.js';

export { changesRequestedBy, heldByMe, isHeld } from './gitlab.js';
export type {
  ActivityEvent,
  BoardProgressHooks,
  BoardProject,
  BranchFacts,
  Discussion,
  JobTrace,
  MergedMr,
  MergeOutcome,
  MrBrief,
  MrDetail,
  MrEnd,
  MrFetch,
  MrFile,
  MrState,
  NotePosition,
  PipelineJob,
  RebaseState,
  ThreadEntry,
  ThreadState,
  Todo,
} from './gitlab.js';
export { TOO_BIG };

/** A flag a forge leaves out is one it can do, so GitLab's read as they always have. */
export interface Caps {
  hold: boolean;
  withdrawApproval: boolean;
  rebase: boolean;
  autoMerge: boolean;
  /** 'actions' when only GitHub Actions jobs have logs, not other apps' checks. */
  jobLogs: boolean | 'actions';
  retry: boolean | 'actions';
  todos: boolean;
  /** A comment on the whole MR can be resolved. */
  generalThreads?: boolean;
  /** Findings, replies, resolves and verdicts sent from here. */
  post?: boolean;
  /** Review and fix agents launched on it. */
  agents?: boolean;
  /** Merging, marking ready and choosing reviewers on your own. */
  ownMr?: boolean;
}

/** GitLab's REST names a project by its number and its GraphQL by its path, so most calls want both. */
export type ForgeRef = MrRef & { projectId: number };

export interface RecentMr {
  key: string;
  title: string;
  author: string | null;
  createdAt: string | null;
  mergedAt: string | null;
}

export interface Forge {
  id: Provider;
  name: 'GitLab' | 'GitHub';
  caps: Caps;
  me(): Promise<string>;
  myName(): Promise<string>;
  discoverRepos(): Promise<RepoSpec[]>;
  listOpen(repos: RepoSpec[]): Promise<MrFetch>;
  todos(): Promise<Todo[]>;
  one(r: MrRef): Promise<Mr | null>;
  state(r: MrRef): Promise<MrState | null>;
  end(r: MrRef): Promise<MrEnd>;
  detail(r: ForgeRef): Promise<MrDetail>;
  branchFacts(r: ForgeRef): Promise<BranchFacts>;
  discussions(r: ForgeRef): Promise<Discussion[]>;
  threadState(r: ForgeRef, me: string, head?: string | null): Promise<ThreadState>;
  files(r: ForgeRef): Promise<{ files: MrFile[]; complete: boolean }>;
  since(r: ForgeRef, from: string, to: string): Promise<{ commits: number; paths: string[] }>;
  file(r: ForgeRef, path: string, at: string, maxBytes: number): Promise<string | null | typeof TOO_BIG>;
  checks(r: ForgeRef, sha: string): Promise<PipelineJob[]>;
  jobLog(r: ForgeRef, jobId: number, lines?: number): Promise<JobTrace>;
  retryJob(r: ForgeRef, jobId: number): Promise<{ id: number; status: string }>;
  retryChecks(r: ForgeRef, pipelineId: number): Promise<{ id: number; status: string }>;
  postFinding(item: QueuedComment, how?: SendHow): Promise<{ id: string }>;
  reply(r: ForgeRef, threadId: string, body: string): Promise<void>;
  resolve(r: ForgeRef, threadId: string, resolved: boolean): Promise<void>;
  note(r: ForgeRef, body: string): Promise<{ id: number }>;
  approve(r: ForgeRef, on: boolean): Promise<void>;
  hold(r: MrRef, on: boolean): Promise<{ status: string | null; warning?: string }>;
  merge(r: ForgeRef, how: { sha: string; whenGreen: boolean }): Promise<MergeOutcome>;
  cancelAutoMerge(r: ForgeRef): Promise<void>;
  rebase(r: ForgeRef): Promise<void>;
  rebaseState(r: ForgeRef): Promise<RebaseState>;
  ready(r: MrRef): Promise<{ draft: boolean }>;
  setReviewers(r: ForgeRef, names: string[]): Promise<string[]>;
  rerequest(r: MrRef, name: string): Promise<void>;
  /** By number alone, as an activity event names its MR. */
  brief(r: Pick<ForgeRef, 'provider' | 'projectId' | 'iid'>): Promise<MrBrief>;
  approvers(r: ForgeRef): Promise<string[]>;
  myEvents(after: string, before: string): Promise<ActivityEvent[]>;
  myMrs(state: 'opened' | 'merged', updatedAfter?: string): Promise<MrBrief[]>;
  mergedIn(scope: string, after: string, before?: string | null): Promise<MergedMr[]>;
  mergedMentioning(ticket: string, scopes: string[]): Promise<{ path: string | null; iid: number }[]>;
  mergedBy(username: string, updatedAfter: string): Promise<RecentMr[]>;
  reviewedBy(username: string, updatedAfter: string): Promise<RecentMr[]>;
  boardMrs(repos: RepoSpec[], since: string, hooks?: BoardProgressHooks): Promise<BoardProject[]>;
  boardComments(project: BoardProject, since: string, pages?: number): Promise<{ events: CommentEvent[]; complete: boolean }>;
}

/** For what belongs to an account rather than one MR, on a forge only GitLab has so far. */
export const GITLAB: Pick<MrRef, 'provider'> = { provider: 'gitlab' };

const FORGES: Record<Provider, Forge> = { gitlab: gitlabForge, github: githubForge };

const enabled = (provider: Provider): boolean => provider === 'gitlab' || githubOn();

export function needs(forge: Forge, cap: keyof Caps, what: string): void {
  if (forge.caps[cap] === false) throw new Error(`${forge.name} has no way to ${what}`);
}

/** No provider means GitLab, so every MR, queue item and watch written before there was a choice still reads as one. */
export function forgeOf(ref: Partial<ForgeRef>): Forge {
  const provider = ref.provider ?? 'gitlab';
  const forge = FORGES[provider];
  if (!forge) throw new Error(`this build cannot reach ${provider} yet`);
  if (!enabled(provider)) throw new Error(`${forge.name} is switched off, so nothing is asked of it. Turn it on in Settings`);
  return forge;
}

/** GitLab first, as the inbox has always read it, then each other forge that is switched on. */
export function forges(): Forge[] {
  return (Object.keys(FORGES) as Provider[]).filter(enabled).map((p) => FORGES[p]);
}

export function forgeView(): Record<Provider, { name: string; on: boolean; caps: Caps }> {
  return Object.fromEntries((Object.keys(FORGES) as Provider[]).map((p) => [p, { name: FORGES[p].name, on: enabled(p), caps: FORGES[p].caps }])) as Record<Provider, { name: string; on: boolean; caps: Caps }>;
}
