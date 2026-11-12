import { keyOf } from './refs.js';
import { firstKeyIn } from './ticketkeys.js';

export type PipelineStatus =
  | 'SUCCESS'
  | 'FAILED'
  | 'RUNNING'
  | 'PENDING'
  | 'CANCELED'
  | 'CANCELLED'
  | 'SKIPPED'
  | 'MANUAL'
  | 'CREATED'
  | 'SCHEDULED'
  | 'WAITING_FOR_RESOURCE'
  | 'PREPARING'
  | null;

export interface Mr {
  /** Absent means GitLab, so every MR stored before there was a choice still reads as one. */
  provider?: 'github';
  projectPath: string;
  projectId: number;
  repoLabel: string;
  iid: number;
  title: string;
  webUrl: string;
  draft: boolean;
  conflicts: boolean;
  notes: number;
  author: string;
  reviewers: string[];
  approvedBy: string[];
  pipeline: PipelineStatus;
  /** The head pipeline's id, so a second failure on the same head reads as new. */
  pipelineId?: number;
  mergeStatus: string | null;
  createdAt: string;
  updatedAt: string;
  sha: string | null;
  sourceBranch: string;
  ticket: string | null;
  /** Resolvable threads still open, from the list query at no extra cost. */
  unresolvedThreads: number;
  /** Merge when green is set. */
  autoMerge?: boolean;
  /** Each reviewer's own state, such as REVIEWED or REQUESTED_CHANGES. */
  reviewStates?: Record<string, string>;
  /** Read only by a single-MR fetch: the list query asks for open ones and nothing else. */
  state?: string;
  /** When GitLab was asked for this copy, so the engine's own writes can be told apart from the ones it already shows. */
  readAt?: number;
}

/** A list query only returns open ones, so no state means open. */
export function isOpen(mr: Pick<Mr, 'state'>): boolean {
  return mr.state === undefined || mr.state === 'opened';
}

/** Identity of an MR across restarts. */
export function mrKey(mr: Pick<Mr, 'projectPath' | 'iid'>): string {
  return keyOf(mr);
}

/** What "changed" means for a watched MR. */
export interface Fingerprint {
  sha: string | null;
  pipeline: PipelineStatus;
  notes: number;
  approvals: number;
  /** Absent on fingerprints written before resolution was tracked. */
  unresolved?: number;
}

export function fingerprint(mr: Mr): Fingerprint {
  return {
    sha: mr.sha,
    pipeline: mr.pipeline,
    notes: mr.notes,
    approvals: mr.approvedBy.length,
    unresolved: mr.unresolvedThreads,
  };
}

export function fingerprintDiffers(a: Fingerprint | undefined, b: Fingerprint): boolean {
  if (!a) return false;
  // A resolution changes nothing else, so it is compared too, but only when both fingerprints carry it.
  const resolution =
    a.unresolved !== undefined && b.unresolved !== undefined && a.unresolved !== b.unresolved;
  return (
    a.sha !== b.sha ||
    a.pipeline !== b.pipeline ||
    a.notes !== b.notes ||
    a.approvals !== b.approvals ||
    resolution
  );
}

/** What the review engine itself did to an MR since its watch baseline, so its own writes never read as the MR moving. */
export interface OwnActivity {
  notes: number;
  unresolved: number;
  approvals: number;
}

export interface OwnWrite extends OwnActivity {
  /** When the write was noted, just after GitLab took it. */
  at: number;
  /** Noted after the baseline's read began, so the baseline may already show it. */
  maybeSeen?: true;
}

/** In the order they were noted. An object here is from a build that did not time them, and is dropped. */
export function ownWrites(watch: Watch): OwnWrite[] {
  return Array.isArray(watch.own) ? watch.own : [];
}

export interface Watch {
  /** Absent means GitLab, as on an MR. */
  provider?: 'github';
  key: string;
  projectPath: string;
  projectId?: number;
  iid: number;
  webUrl: string;
  /** Re-review the moment the poller sees a change. */
  auto: boolean;
  /** Name of the Orca automation an older build scheduled for this watch, until it is moved to `daily`. */
  automation?: string;
  /** A daily re-review: when it next looks, and it reviews only if the MR moved since the last look. */
  daily?: { nextAt: string };
  /** Set when the watch came from launching a review, so "moved" means "moved since
   * I reviewed it" rather than "since I pressed a key". */
  reviewedAt?: string;
  /** Handle of the agent doing the review, so its state can be read back. */
  terminal?: string;
  seen: Fingerprint;
  /** When the baseline's read began. */
  seenAt?: number;
  own?: OwnWrite[];
  addedAt: string;
  /** A new head auto re-review waits on until it has settled. */
  moving?: { sha: string | null; since: number };
  /** Launches of a re-review that threw on this head; the change is kept for the next poll. */
  relaunch?: { sha: string | null; tries: number; error: string };
  /** The note count replies were last looked for at, so threads are read once per new note. */
  notesChecked?: number;
}

export type Severity = 'CRITICAL' | 'MAJOR' | 'MINOR' | 'NIT' | 'QUESTION';

export interface DiffPosition {
  base_sha: string;
  start_sha: string;
  head_sha: string;
  new_path?: string;
  new_line?: number;
  old_path?: string;
  old_line?: number;
}

export type QueueKind = 'finding' | 'reply' | 'verdict';

export type ReplyOutcome = 'fixed' | 'not-fixed' | 'disagree';

export type AutoLevel = 'shadow' | 'comments' | 'verdict';

export type QueueStatus = 'pending' | 'posted' | 'discarded' | 'expired';

export type ExpiredReason = 'MR merged' | 'MR closed' | 'test data';

/** Set only by the review engine, never by an agent: it is what lets an item go without you. */
export interface AutoMark {
  pass: string;
  level: AutoLevel;
  sendAt: string;
  held?: string;
  superseded?: string;
  sentAuto?: boolean;
  resolved?: boolean;
}

export interface QueuedComment {
  id: string;
  projectPath: string;
  projectId: number;
  iid: number;
  webUrl: string;
  severity: Severity;
  body: string;
  /** Shown in the queue so the finding can be read against its code. */
  diffHunk?: string;
  position?: DiffPosition;
  createdAt: string;
  createdBy: string;
  status: QueueStatus;
  postedAt?: string;
  expiredAt?: string;
  expiredReason?: ExpiredReason;
  discussionId?: string;
  error?: string;
  /** Absent means a finding, which is everything queued before replies existed. */
  kind?: QueueKind;
  replyTo?: string;
  outcome?: ReplyOutcome;
  verdict?: 'approve' | 'changes';
  auto?: AutoMark;
  /** Taken under the queue lock before the GitLab call, so two front ends never both send it. */
  sending?: { by: string; at: string };
  editing?: { by: string; until: string };
}

/** Never sent and never will be: thrown away by you, or left behind on an MR that closed. */
export function dropped(c: Pick<QueuedComment, 'status'>): boolean {
  return c.status === 'discarded' || c.status === 'expired';
}

export interface Ticket {
  key: string;
  summary: string;
  status: string;
  labels: string[];
  url: string;
}

export const SEVERITY_ORDER: Severity[] = ['CRITICAL', 'MAJOR', 'MINOR', 'NIT', 'QUESTION'];

export function extractTicket(...sources: (string | null | undefined)[]): string | null {
  for (const s of sources) {
    const key = s ? firstKeyIn(s) : null;
    if (key) return key;
  }
  return null;
}

/** One launch of a review agent, and the last thing it drew before its window went. */
export interface ReviewRun {
  key: string;
  webUrl: string;
  startedAt: string;
  terminal?: string;
  worktreePath?: string;
  /** launching, working, idle, ended or launch failed. */
  status?: string;
  /** The agent's screen, newest capture wins. */
  tail?: string[];
  capturedAt?: string;
  endedAt?: string;
  /** Findings that reached the queue from this run. */
  queued?: number;
  /** The head when it started, so a fix run that pushed can be told from one that did not. */
  sha?: string | null;
  /** A kickoff agent stops to ask you, where a plain ticket agent raises its own MR. */
  kickoff?: boolean;
}

export type AutoTrigger = 'new' | 'commit' | 'reply';

export interface AutoPass {
  id: string;
  key: string;
  author: string;
  sha: string | null;
  trigger: AutoTrigger;
  launchedAt: string;
  previousSha?: string | null;
  level?: AutoLevel;
  /** Reviewed because the MR asks you, not because its author has a row of their own. */
  asked?: boolean;
  doneAt?: string;
  settled?: 'finished' | 'superseded' | 'expired' | 'failed' | 'closed';
}

export interface AutoMemory {
  key: string;
  pass?: AutoPass;
  /** The note count when replies were last looked for, so they are not fetched every poll. */
  notesSeen?: number;
  /** Threads auto has given up on. Nothing on them triggers or sends again. */
  handedBack?: string[];
  /** The change request standing on it is one auto placed, so auto may lift it. */
  autoHeld?: boolean;
}
