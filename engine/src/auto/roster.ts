import { looksAutomated } from '../leaderboard.js';
import type { AutoLevel, Mr } from '../types.js';
import type { AutoPerson } from './people.js';

export interface RosterRow {
  username: string;
  level: AutoLevel | null;
  /** Their open, non-draft merge requests with you as a reviewer: what full auto acts on. */
  askingYou: number;
  open: number;
  /** Open merge requests they review or have approved, so a reviewer with none of their own is still listed. */
  reviewing: number;
}

export const LEVEL_STEPS: (AutoLevel | null)[] = [null, 'shadow', 'comments', 'verdict'];

const USERNAME = /^[a-z0-9][a-z0-9_.-]*$/;

function blank(username: string): RosterRow {
  return { username, level: null, askingYou: 0, open: 0, reviewing: 0 };
}

function counted(mrs: Mr[], me: string | undefined): Map<string, RosterRow> {
  const rows = new Map<string, RosterRow>();
  const mine = me?.toLowerCase();
  const rowFor = (name: string): RosterRow | null => {
    const username = name.toLowerCase();
    if (username === mine || looksAutomated(username)) return null;
    const row = rows.get(username) ?? blank(username);
    rows.set(username, row);
    return row;
  };
  for (const mr of mrs) {
    const author = rowFor(mr.author);
    if (author) {
      author.open += 1;
      if (me && !mr.draft && mr.reviewers.includes(me)) author.askingYou += 1;
    }
    const engaged = new Set([...mr.reviewers, ...mr.approvedBy].filter((name) => name !== mr.author));
    for (const name of engaged) {
      const reviewer = rowFor(name);
      if (reviewer) reviewer.reviewing += 1;
    }
  }
  return rows;
}

/** Ordered by merge requests, never by level, so changing a level leaves the cursor on that person. */
export function roster(mrs: Mr[], me: string | undefined, people: AutoPerson[]): RosterRow[] {
  const rows = counted(mrs, me);
  for (const p of people) if (!rows.has(p.username)) rows.set(p.username, blank(p.username));
  return [...rows.values()]
    .map((row) => ({ ...row, level: people.find((p) => p.username === row.username)?.level ?? null }))
    .sort(
      (a, b) =>
        b.askingYou - a.askingYou || b.open - a.open || b.reviewing - a.reviewing || a.username.localeCompare(b.username),
    );
}

/** A name typed into the find box, if it could be a GitLab username, so someone not listed can still be added. */
export function typedUsername(text: string): string | null {
  const name = text.trim().replace(/^@/, '').toLowerCase();
  return USERNAME.test(name) ? name : null;
}

export function withLevel(people: AutoPerson[], username: string, level: AutoLevel | null): AutoPerson[] {
  const others = people.filter((p) => p.username !== username);
  return level ? [...others, { username, level }] : others;
}
