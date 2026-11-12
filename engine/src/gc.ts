import type { Workspace } from './agents/host.js';
import { keyOf } from './refs.js';
import type { Mr } from './types.js';

export interface Candidate {
  workspace: Workspace;
  repoLabel: string;
  iid: number;
  reason: 'mr closed' | 'review finished';
}

const REVIEW_NAME = /^review-(.+)-(\d+)$/;

export const labelKey = (repoLabel: string, iid: number): string => keyOf({ projectPath: repoLabel.toLowerCase(), iid });

/** `review-Order-Book-649` is the name the review launcher gives a workspace. */
export function parseReviewName(name: string): { repoLabel: string; iid: number } | null {
  const m = REVIEW_NAME.exec(name);
  if (!m?.[1] || !m[2]) return null;
  return { repoLabel: m[1].replace(/-/g, ' '), iid: Number(m[2]) };
}

export interface ReapOptions {
  /**
   * The repos the open-MR list actually covers. An MR missing from that list only means
   * "closed" for a repo that was queried; for any other repo it means "not looked at",
   * and reaping on that would close a workspace whose review is still live.
   */
  knownRepoLabels: string[];
  /** Whether a review agent is still live for that MR. */
  agentAlive: (repoLabel: string, iid: number) => boolean;
  /** Findings queued for it and not yet posted or discarded. */
  pending: (repoLabel: string, iid: number) => number;
  /** Also reap workspaces whose MR is still open but whose review is finished. */
  includeFinished?: boolean;
}

/**
 * Only workspaces this tool created for a review, and only ones with nothing left to
 * lose. A ticket workspace is a real git worktree on its own branch, so it is never a
 * candidate however old it looks: the branch is the work.
 */
export function reapable(
  workspaces: Workspace[],
  openMrs: Mr[],
  options: ReapOptions,
): Candidate[] {
  const open = new Set(openMrs.map((m) => labelKey(m.repoLabel, m.iid)));
  const known = new Set(options.knownRepoLabels.map((l) => l.toLowerCase()));
  const out: Candidate[] = [];

  for (const workspace of workspaces) {
    if (workspace.isMainWorktree || workspace.branch) continue;
    const named = parseReviewName(workspace.displayName);
    if (!named) continue;
    const { repoLabel, iid } = named;
    if (!known.has(repoLabel.toLowerCase())) continue;
    if (options.agentAlive(repoLabel, iid)) continue;
    if (options.pending(repoLabel, iid) > 0) continue;

    const stillOpen = open.has(labelKey(repoLabel, iid));
    if (!stillOpen) {
      out.push({ workspace, repoLabel, iid, reason: 'mr closed' });
    } else if (options.includeFinished) {
      out.push({ workspace, repoLabel, iid, reason: 'review finished' });
    }
  }
  return out;
}

/** Review workspaces the scan could say nothing about, so the sweep can own up to them. */
export function outOfScope(workspaces: Workspace[], knownRepoLabels: string[]): Workspace[] {
  const known = new Set(knownRepoLabels.map((l) => l.toLowerCase()));
  return workspaces.filter((w) => {
    if (w.isMainWorktree || w.branch) return false;
    const named = parseReviewName(w.displayName);
    return named !== null && !known.has(named.repoLabel.toLowerCase());
  });
}

/** Matched on the name the launcher gave it, the only link to the MR; a worktree on a branch is somebody's ticket work, never one of these. */
export function workspaceForReview<W extends Workspace>(
  workspaces: W[],
  repoLabel: string,
  iid: number,
): W | undefined {
  return workspaces.find((w) => {
    if (w.isMainWorktree || w.branch) return false;
    const named = parseReviewName(w.displayName);
    return named !== null && named.iid === iid && named.repoLabel.toLowerCase() === repoLabel.toLowerCase();
  });
}
