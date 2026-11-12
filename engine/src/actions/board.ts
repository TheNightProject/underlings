import type { RepoSpec } from '../config.js';
import { forgeOf, GITLAB } from '../data/forge.js';
import {
  tally,
  type CommentEvent,
  type Contribution,
  type Score,
  type Weights,
} from '../leaderboard.js';
import { dailyCounts } from '../sparkline.js';

export interface Series {
  opened: number[];
  merged: number[];
  reviews: number[];
  days: number;
}

export interface BoardProgress {
  /** What it is doing, in words the view can show as is. */
  phase: string;
  done: number;
  total: number;
  /** Which of the stages below, so the view can show the ones already behind it. */
  step: number;
  /** Running totals, so a stage with nothing to show still proves it is moving. */
  found: { mrs: number; comments: number };
}

/** In order, so the view can show what is done and what is still to come. */
export const BOARD_STAGES = [
  'reading merge requests',
  'paging the busy repos',
  'reading reviews',
  'counting',
] as const;

export interface Board {
  scores: Score[];
  series: Series;
  since: string;
  days: number;
  repos: number;
  builtAt: number;
  /** Repos whose window held more than one page, so the numbers under-count. */
  partial: string[];
}

/**
 * High enough that no real repo reaches it, and present only so a runaway cannot hang the
 * build. Anything that does hit it is reported rather than quietly dropped.
 */
const EVENT_PAGES_PER_REPO = 40;
const EVENT_CONCURRENCY = 4;

export async function buildBoard(
  repos: RepoSpec[],
  days: number,
  options: {
    includeAutomated?: boolean;
    weights?: Weights;
    onProgress?: (p: BoardProgress) => void;
  } = {},
): Promise<Board> {
  const sinceDate = new Date(Date.now() - days * 86_400_000);
  const since = sinceDate.toISOString();
  const report = options.onProgress ?? ((): void => undefined);
  const found = { mrs: 0, comments: 0 };
  const say = (step: number, done: number, total: number): void =>
    report({ phase: BOARD_STAGES[step] ?? '', done, total, step, found: { ...found } });

  say(0, 0, repos.length);
  const gitlab = forgeOf(GITLAB);
  const projects = await gitlab.boardMrs(repos, since, {
    onBatch: (done, mrs) => {
      found.mrs = mrs;
      say(0, done, repos.length);
    },
    onPaging: (done, total, mrs) => {
      found.mrs = mrs;
      say(1, done, total);
    },
  });

  const opened: Contribution[] = projects.flatMap((p) => p.opened);
  const partial = projects.filter((p) => p.truncated).map((p) => p.path);

  const day = since.slice(0, 10);
  const comments: CommentEvent[] = [];
  // Only repos with merge requests in the window can have reviews of them.
  const worth = projects.filter((p) => p.opened.length > 0);
  say(2, 0, worth.length);
  for (let i = 0; i < worth.length; i += EVENT_CONCURRENCY) {
    const slice = worth.slice(i, i + EVENT_CONCURRENCY);
    const results = await Promise.all(
      slice.map((p) =>
        gitlab.boardComments(p, day, EVENT_PAGES_PER_REPO).catch(() => ({
          events: [] as CommentEvent[],
          complete: true,
        })),
      ),
    );
    results.forEach((r, n) => {
      comments.push(...r.events);
      const path = slice[n]?.path;
      if (!r.complete && path && !partial.includes(path)) partial.push(path);
    });
    found.comments = comments.length;
    say(2, Math.min(i + slice.length, worth.length), worth.length);
  }

  say(3, 0, 1);
  // Tallying is synchronous, so without yielding the terminal never repaints and the
  // last stage goes from unstarted to gone without ever being seen.
  await new Promise((resolve) => setTimeout(resolve, 0));

  // The chart covers the same window, so the two halves of the tab always agree.
  const series: Series = {
    opened: dailyCounts(projects.flatMap((p) => p.createdAt), days),
    merged: dailyCounts(projects.flatMap((p) => p.mergedAt), days),
    reviews: dailyCounts(comments.flatMap((c) => (c.at ? [c.at] : [])), days),
    days,
  };

  const scores = tally(opened, comments, {
    ...(options.includeAutomated === undefined ? {} : { includeAutomated: options.includeAutomated }),
    ...(options.weights ? { weights: options.weights } : {}),
  });
  say(3, 1, 1);

  return {
    scores,
    series,
    since,
    days,
    repos: repos.length,
    builtAt: Date.now(),
    partial,
  };
}
