import { looksAutomated } from '../leaderboard.js';
import type { AutoLevel, Mr } from '../types.js';
import { ineligible } from './guards.js';

export interface AutoPerson {
  username: string;
  level: AutoLevel;
}

const LEVELS: Record<string, AutoLevel> = {
  shadow: 'shadow',
  comments: 'comments',
  verdict: 'verdict',
  'comments+verdict': 'verdict',
};

const LEVEL_RANK: Record<AutoLevel, number> = { shadow: 0, comments: 1, verdict: 2 };

export const LEVEL_LABEL: Record<AutoLevel, string> = {
  shadow: 'shadow',
  comments: 'comments',
  verdict: 'comments + verdict',
};

/** The username of the row for anyone who asks for your review and has no row of their own. */
export const ANYONE = '*';

interface Entry {
  username: string;
  level: AutoLevel | 'off';
}

/** Dropped rather than guessed: the setting saves per keystroke, so a half-typed entry must switch nothing on. */
function parseEntry(raw: string): Entry | null {
  const [name, level] = raw.split(':').map((part) => part.trim());
  const username = (name ?? '').replace(/^@/, '').toLowerCase();
  const typed = (level ?? '').replace(/\s+/g, '').toLowerCase();
  const known = typed === 'off' ? 'off' : LEVELS[typed];
  return username && known ? { username, level: known } : null;
}

function entries(text: string): Entry[] {
  const all = text.split(',').map(parseEntry).filter((p): p is Entry => p !== null);
  return [...new Map(all.map((p) => [p.username, p])).values()];
}

const isPerson = (e: Entry): e is AutoPerson => e.username !== ANYONE && e.level !== 'off';

export function parsePeople(text: string): AutoPerson[] {
  return entries(text).filter(isPerson);
}

export interface PeopleRules {
  people: AutoPerson[];
  /** Reviewing on request never posts without you, so the only level it takes is shadow. */
  onRequest: AutoLevel | null;
  optedOut: Set<string>;
}

export function peopleRules(text: string): PeopleRules {
  const all = entries(text);
  const anyone = all.find((e) => e.username === ANYONE);
  return {
    people: all.filter(isPerson),
    onRequest: anyone && anyone.level !== 'off' ? 'shadow' : null,
    optedOut: new Set(all.filter((e) => e.username !== ANYONE && e.level === 'off').map((e) => e.username)),
  };
}

/** A person's own row wins; failing that, an MR that asks you is reviewed at the on-request level. Full auto works on GitLab MRs for now. */
export function levelForMr(mr: Mr, me: string | undefined, rules: PeopleRules): AutoLevel | null {
  if (mr.provider === 'github') return null;
  const author = mr.author.toLowerCase();
  const own = levelFor(author, rules.people);
  if (own) return own;
  if (!rules.onRequest || rules.optedOut.has(author)) return null;
  if (!me || author === me.toLowerCase() || looksAutomated(author)) return null;
  return ineligible(mr, me) ? null : rules.onRequest;
}

export function askedOnly(mr: Mr, rules: PeopleRules): boolean {
  return !levelFor(mr.author, rules.people);
}

export function levelFor(author: string, people: AutoPerson[]): AutoLevel | null {
  return people.find((p) => p.username === author.toLowerCase())?.level ?? null;
}

export function atLeast(level: AutoLevel | null, wanted: AutoLevel): boolean {
  return level !== null && LEVEL_RANK[level] >= LEVEL_RANK[wanted];
}

export function describePeople(people: AutoPerson[]): string {
  return people.map((p) => `${p.username} ${LEVEL_LABEL[p.level]}`).join(', ');
}

/** The setting's own text, so what the picker writes reads back through `parsePeople`. */
export function formatPeople(people: AutoPerson[], rules?: Pick<PeopleRules, 'onRequest' | 'optedOut'>): string {
  const anyone = rules?.onRequest ? [`${ANYONE}:${rules.onRequest}`] : [];
  const off = [...(rules?.optedOut ?? [])].map((name) => `${name}:off`);
  return [...anyone, ...people.map((p) => `${p.username}:${p.level}`), ...off].join(', ');
}
