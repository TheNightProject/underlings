export interface Score {
  user: string;
  /** Merge requests they opened in the window, whatever became of them. */
  opened: number;
  /** Approvals they gave on other people's merge requests. */
  approved: number;
  /** Review comments they left on other people's merge requests. */
  comments: number;
  /**
   * The four columns under the weights in settings. Worth remembering that all four are
   * absolute counts, so whatever the weights, somebody raising a hundred small merge
   * requests outscores somebody reviewing thirty carefully.
   */
  total: number;
  /**
   * Merge requests of someone else's they engaged with at all, by comment or approval.
   * Counted once each: commenting on a merge request and then approving it is one
   * review, not two.
   */
  reviewed: number;
}

export interface Contribution {
  /** Scoped per project so two repos cannot share a merge request number. */
  mr: string;
  author: string;
  approvers: string[];
}

/** One person commenting on one merge request, however many times. */
export interface CommentEvent {
  user: string;
  /** Scoped per project so two repos cannot share a merge request number. */
  mr: string;
  author: string;
  /** When it was left, for the daily series. */
  at?: string;
}

/**
 * A name that is plainly a service account. The guess is deliberately narrow, and the
 * board says it is hiding them, because a wrong guess silently erases a person.
 */
export function looksAutomated(user: string): boolean {
  return /(^|[-_.])(bot|bots|jenkins|ci|renovate|dependabot)([-_.]|$)/i.test(user);
}

/** Counts MRs engaged with, not comments, so one useful comment is not beaten by ten small ones and a comment then an approval is one review. */
export function tally(
  opened: Contribution[],
  comments: CommentEvent[],
  options: { includeAutomated?: boolean; sortBy?: SortKey; weights?: Weights } = {},
): Score[] {
  const scores = new Map<string, Score>();
  const touched = new Map<string, Set<string>>();
  const get = (user: string): Score => {
    const found = scores.get(user) ?? {
      user,
      opened: 0,
      approved: 0,
      comments: 0,
      reviewed: 0,
      total: 0,
    };
    scores.set(user, found);
    return found;
  };

  const touch = (user: string, mr: string): void => {
    const seen = touched.get(user) ?? new Set<string>();
    seen.add(mr);
    touched.set(user, seen);
  };

  for (const mr of opened) {
    if (mr.author) get(mr.author).opened += 1;
    for (const approver of new Set(mr.approvers)) {
      // Approving your own merge request is not a review of anyone's work but your own.
      if (approver && approver !== mr.author) {
        get(approver).approved += 1;
        touch(approver, mr.mr);
      }
    }
  }

  for (const event of comments) {
    if (!event.user || event.user === event.author) continue;
    get(event.user).comments += 1;
    touch(event.user, event.mr);
  }
  for (const [user, seen] of touched) get(user).reviewed = seen.size;
  const w = options.weights ?? DEFAULT_WEIGHTS;
  for (const score of scores.values()) {
    score.total = Math.round(
      score.opened * w.opened +
        score.reviewed * w.reviewed +
        score.comments * w.comments +
        score.approved * w.approved,
    );
  }

  return [...scores.values()]
    .filter((s) => options.includeAutomated || !looksAutomated(s.user))
    .filter((s) => s.opened > 0 || s.reviewed > 0 || s.approved > 0)
    .sort(byColumn(options.sortBy ?? 'total'));
}

export interface Weights {
  opened: number;
  reviewed: number;
  comments: number;
  approved: number;
}

/** Opening and reviewing each take an MR's worth of attention; a comment already earned a review point, and an approval can be one click. */
export const DEFAULT_WEIGHTS: Weights = { opened: 3, reviewed: 3, comments: 0.5, approved: 1 };

/** `opened/reviewed/comments/approved`, so four dials fit on one line of settings. */
export function parseWeights(text: string): Weights {
  const parts = text.split('/').map((n) => n.trim());
  const keys: (keyof Weights)[] = ['opened', 'reviewed', 'comments', 'approved'];
  const out = { ...DEFAULT_WEIGHTS };
  keys.forEach((key, i) => {
    const raw = parts[i];
    // Blank is "not said", not nought: an empty box would otherwise zero the first dial.
    if (raw === undefined || raw === '') return;
    const value = Number(raw);
    // A negative weight would let one kind of work cancel out another.
    if (Number.isFinite(value) && value >= 0) out[key] = value;
  });
  return out;
}

export function formatWeights(w: Weights): string {
  return [w.opened, w.reviewed, w.comments, w.approved].join('/');
}

export type SortKey = 'total' | 'opened' | 'reviewed' | 'comments' | 'approved';

export const SORT_KEYS: SortKey[] = ['total', 'opened', 'reviewed', 'comments', 'approved'];

/** Ties fall through the other columns so the order is stable, never arbitrary. */
export function byColumn(key: SortKey): (a: Score, b: Score) => number {
  const order: SortKey[] = [key, ...SORT_KEYS.filter((k) => k !== key)];
  return (a, b) => {
    for (const column of order) {
      const diff = b[column] - a[column];
      if (diff !== 0) return diff;
    }
    return a.user.localeCompare(b.user);
  };
}
