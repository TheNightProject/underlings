import { mayAnswer } from '../auto/guards.js';
import type { RepoSpec } from '../config.js';
import type { Discussion } from './forge.js';

/** What a file read answers in place of a file longer than it was asked to hold. */
export const TOO_BIG = Symbol('too big');

export interface ThreadEntry {
  id: string;
  resolvable: boolean;
  resolved: boolean;
  openedBy: string;
  /** You wrote in it. */
  mine: boolean;
  lastNoteId: number | null;
  lastAt: string;
  lastAuthor: string;
  /** The last word is a person's other than yours, not a bot's or automated text. */
  fromPerson: boolean;
}

export interface ThreadState {
  /** Threads this MR has that you are a participant in. */
  mine: number;
  /** Of those, still unresolved. */
  unresolved: number;
  /** Of those, where the last word is somebody else's: the ball is with you. */
  awaitingYou: number;
  /** Of those nobody has answered, the ones the author has pushed over. */
  moved: number;
  /** Every thread and plain comment, yours or not, so a reviewer's thread on your own MR is seen too. */
  threads?: ThreadEntry[];
}

function threadEntry(d: Discussion, me: string): ThreadEntry {
  const last = d.notes[d.notes.length - 1];
  return {
    id: d.id,
    resolvable: Boolean(d.resolvable),
    resolved: d.resolved,
    openedBy: d.notes[0]?.author ?? '',
    mine: d.notes.some((n) => n.author === me),
    lastNoteId: last?.id ?? null,
    lastAt: last?.createdAt ?? '',
    lastAuthor: last?.author ?? '',
    fromPerson: Boolean(last) && last!.author !== me && mayAnswer(last!, me),
  };
}

export function threadStateOf(discussions: Discussion[], me: string, head?: string | null): ThreadState {
  let mine = 0;
  let unresolved = 0;
  let awaitingYou = 0;
  let moved = 0;
  for (const discussion of discussions) {
    const notes = discussion.notes;
    if (!notes.some((n) => n.author === me)) continue;
    mine += 1;
    if (discussion.resolved) continue;
    unresolved += 1;
    if (notes[notes.length - 1]?.author !== me) {
      awaitingYou += 1;
      continue;
    }
    // Nobody has answered, but the author has pushed over the line it sits on, which is
    // how most comments get dealt with. That is still your move to make.
    const anchor = discussion.position;
    if (anchor?.head_sha && head && anchor.head_sha !== head) moved += 1;
  }
  return { mine, unresolved, awaitingYou, moved, threads: discussions.map((d) => threadEntry(d, me)) };
}

/** The widest a repo label can be before the list column starts eating it. */
const LABEL_MAX = 16;

function words(segment: string): string[] {
  return segment
    .replace(/[-_]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((w) => w[0]?.toUpperCase() + w.slice(1));
}

/** Each repo by the shortest unique tail of its path, as the column is narrow; labels that clash take words back from the parent groups. */
export function labelRepos(paths: string[]): RepoSpec[] {
  const entries = paths.map((path) => {
    const segments = path.split('/');
    const own = words(segments[segments.length - 1] ?? path);
    // Parents come first, so taking a longer tail walks up the tree.
    const all = [...segments.slice(0, -1).flatMap(words), ...own];
    let keep = own.length;
    while (keep > 1 && all.slice(-keep).join(' ').length > LABEL_MAX) keep -= 1;
    return { path, all, keep, text: all.slice(-keep).join(' ') };
  });

  // Both sides of a clash move, or one repo keeps the bare name and its twin looks like
  // the odd one out when neither has a better claim to it.
  for (let pass = 0; pass < 8; pass += 1) {
    const groups = new Map<string, typeof entries>();
    for (const e of entries) groups.set(e.text, [...(groups.get(e.text) ?? []), e]);

    const clashing = [...groups.values()].filter(
      (group) => group.length > 1 && group.some((e) => e.keep < e.all.length),
    );
    if (clashing.length === 0) break;

    for (const group of clashing) {
      for (const e of group) {
        if (e.keep >= e.all.length) continue;
        e.keep += 1;
        e.text = e.all.slice(-e.keep).join(' ');
      }
    }
  }
  return entries.map((e) => ({ path: e.path, label: e.text }));
}
