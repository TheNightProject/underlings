import type { RepoSpec } from './config.js';

/** GitLab refuses a GraphQL query over 250 complexity; packing to this budget rather than a fixed count keeps requests under the rate limit. */
export const COMPLEXITY_BUDGET = 215;
/** Fitted against gitlab.com for exactly these fields, so measure again when they change; splitBatch makes a wrong guess cost one request. */
const PROJECT_OVERHEAD = 38.75;
const PER_MR = 0.2125;

/** Headroom, so a repo that gained MRs since discovery is not silently truncated. */
const SLACK = 5;
const MIN_FIRST = 10;
const MAX_FIRST = 100;

export function firstFor(repo: RepoSpec): number {
  const known = repo.openCount ?? MAX_FIRST;
  return Math.min(Math.max(known + SLACK, MIN_FIRST), MAX_FIRST);
}

export function costOf(first: number): number {
  return PROJECT_OVERHEAD + PER_MR * first;
}

export interface Batch {
  repos: RepoSpec[];
  /** How many MRs to ask each project in this batch for. */
  first: number;
}

/**
 * Projects are packed biggest first, so the expensive ones settle before the cheap ones
 * fill the gaps. One `first` per batch, taken from its hungriest member, because the
 * query asks every project in it the same question.
 */
export function planBatches(repos: RepoSpec[]): Batch[] {
  const sorted = [...repos].sort((a, b) => firstFor(b) - firstFor(a));
  const batches: Batch[] = [];

  for (const repo of sorted) {
    const want = firstFor(repo);
    const fits = batches.find((batch) => {
      const first = Math.max(batch.first, want);
      return costOf(first) * (batch.repos.length + 1) <= COMPLEXITY_BUDGET;
    });
    if (fits) {
      fits.first = Math.max(fits.first, want);
      fits.repos.push(repo);
    } else {
      batches.push({ repos: [repo], first: want });
    }
  }
  return batches;
}

/** A batch GitLab refused as too complex, halved so the two parts can be retried. */
export function splitBatch(batch: Batch): Batch[] {
  if (batch.repos.length < 2) return [];
  const half = Math.ceil(batch.repos.length / 2);
  return [
    { repos: batch.repos.slice(0, half), first: batch.first },
    { repos: batch.repos.slice(half), first: batch.first },
  ];
}

export function isComplexityError(message: string): boolean {
  return /exceeds max complexity/i.test(message);
}
