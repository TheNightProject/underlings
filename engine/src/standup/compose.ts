import type { ActivityEvent, MrBrief } from '../data/forge.js';
import { cleanTitle } from '../flags.js';
import { idKey, keyOf, refNumber } from '../refs.js';
import { extractTicket, type Ticket } from '../types.js';
import { namesLine, type Meeting } from './calendar.js';

export const NO_TICKET = '?';
export const DEFAULT_EXCLUDED: string[] = [];

export interface StandupLine {
  id: string;
  tag: string;
  text: string;
  ticked: boolean;
  unknown?: boolean;
}

export interface OpenMr extends MrBrief {
  approvedBy: string[];
}

export interface Move {
  status: string;
  ticket: Ticket;
}

export interface GitlabDay {
  me: string;
  events: ActivityEvent[];
  mrs: Map<string, MrBrief>;
  merged: MrBrief[];
}

export const mrKey = (projectId: number, iid: number) => idKey({ projectId, iid });
const ref = (mr: MrBrief) => keyOf(mr);
const repo = (mr: MrBrief) => `${mr.projectPath.split('/').pop()} ${refNumber(mr)}`;
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

export function isExcluded(path: string, excluded: string[]): boolean {
  const full = path.toLowerCase();
  return excluded.map((e) => e.trim().replace(/^\/+|\/+$/g, '').toLowerCase()).some((e) => e && (full === e || full.endsWith(`/${e}`)));
}

export function ticketOf(mr: MrBrief): string | null {
  return extractTicket(mr.title, mr.sourceBranch);
}

// A title ends a sentence here, so it loses its capital unless its first word has capitals of its own.
export function plainTitle(title: string, ticket: string | null): string {
  let bare = cleanTitle(title, ticket).replace(/^draft:\s*/i, '');
  if (ticket) bare = bare.replace(new RegExp(`^\\[${ticket}\\]\\s*[:-]?\\s*`), '');
  bare = bare.trim();
  return /^[A-Z][a-z]+\b/.test(bare) ? bare.charAt(0).toLowerCase() + bare.slice(1) : bare;
}

function ownLine(kind: 'merged' | 'opened', mr: MrBrief): StandupLine {
  const ticket = ticketOf(mr);
  const verb = kind === 'merged' ? 'Merged' : 'Opened';
  return { id: `${kind}:${ref(mr)}`, tag: ticket ?? NO_TICKET, text: `${verb} ${repo(mr)}: ${plainTitle(mr.title, ticket)}`, ticked: true, ...(ticket ? {} : { unknown: true }) };
}

function mine(day: GitlabDay): ActivityEvent[] {
  return day.events.filter((e) => e.author === day.me && e.iid !== null);
}

interface Seen {
  mr: MrBrief;
  at: string;
}

export function ownWork(day: GitlabDay, excluded: string[]): { merged: StandupLine[]; opened: StandupLine[] } {
  const merged = new Map<string, Seen>();
  const opened = new Map<string, Seen>();
  const note = (into: Map<string, Seen>, mr: MrBrief, at: string) => {
    const seen = into.get(ref(mr));
    if (!seen || at < seen.at) into.set(ref(mr), { mr, at });
  };
  for (const e of mine(day)) {
    const mr = day.mrs.get(mrKey(e.projectId, e.iid as number));
    if (mr?.author !== day.me) continue;
    if (e.action === 'accepted') note(merged, mr, e.at);
    if (e.action === 'opened') note(opened, mr, e.at);
  }
  for (const mr of day.merged) if (mr.mergedAt) note(merged, mr, mr.mergedAt);
  const lines = (found: Map<string, Seen>, kind: 'merged' | 'opened') => [...found.values()]
    .filter(({ mr }) => !isExcluded(mr.projectPath, excluded) && (kind === 'merged' || !merged.has(ref(mr))))
    .sort((a, b) => a.at.localeCompare(b.at))
    .map(({ mr }) => ownLine(kind, mr));
  return { merged: lines(merged, 'merged'), opened: lines(opened, 'opened') };
}

interface Review {
  mr: MrBrief;
  ticket: string | null;
  comments: number;
  approved: boolean;
}

export function reviews(day: GitlabDay, excluded: string[]): StandupLine[] {
  const found = new Map<string, Review>();
  for (const e of mine(day).filter((x) => x.action === 'commented on' || x.action === 'approved')) {
    const mr = day.mrs.get(mrKey(e.projectId, e.iid as number));
    if (!mr || mr.author === day.me || isExcluded(mr.projectPath, excluded)) continue;
    const review = found.get(ref(mr)) ?? { mr, ticket: ticketOf(mr), comments: 0, approved: false };
    if (e.action === 'approved') review.approved = true;
    else review.comments += 1;
    found.set(ref(mr), review);
  }
  return reviewOrder([...found.values()]).map(reviewLine);
}

function reviewOrder(list: Review[]): Review[] {
  const busiest = (a: Review, b: Review) => b.comments - a.comments || ref(a.mr).localeCompare(ref(b.mr));
  const groups = new Map<string, Review[]>();
  for (const review of list) groups.set(review.ticket ?? '', [...(groups.get(review.ticket ?? '') ?? []), review]);
  const total = (ticket: string) => (groups.get(ticket) ?? []).reduce((sum, r) => sum + r.comments, 0);
  const ticketed = [...groups.keys()].filter(Boolean).sort((a, b) => total(b) - total(a) || a.localeCompare(b));
  return [...ticketed, ''].flatMap((ticket) => (groups.get(ticket) ?? []).sort(busiest));
}

function reviewLine({ mr, ticket, comments, approved }: Review): StandupLine {
  const said = [comments ? plural(comments, 'comment') : null, approved ? 'approved' : null].filter(Boolean).join(', ');
  return { id: `review:${ref(mr)}`, tag: `Review - ${ticket ?? 'NoTicket'}`, text: `${repo(mr)}, ${said}: ${plainTitle(mr.title, ticket)}`, ticked: true };
}

export function movedLines(moves: Move[]): StandupLine[] {
  return moves.map(({ status, ticket }) => ({ id: `moved:${ticket.key}`, tag: ticket.key, text: `Moved to ${status}: ${ticket.summary}`, ticked: true }));
}

export function meetingLines(meetings: Meeting[], prefix: string, clock: (m: Meeting) => string = (m) => m.time ?? ''): StandupLine[] {
  return meetings.map((m) => ({
    id: `${prefix}:${m.id}`,
    tag: `Meeting: ${m.summary}`,
    text: m.time === null ? 'all day' : m.others.length ? `${clock(m)} with ${namesLine(m.others)}` : clock(m),
    ticked: m.time !== null && m.others.length > 0,
  }));
}

interface Step {
  verb: string;
  state: string;
}

const WAITING_ON: Record<string, Step> = {
  requested_changes: { verb: 'Address the review on', state: 'changes requested' },
  need_rebase: { verb: 'Rebase', state: 'needs rebase' },
  ci_must_pass: { verb: 'Fix the pipeline on', state: 'pipeline failing' },
  discussions_not_resolved: { verb: 'Resolve the threads on', state: 'unresolved threads' },
  blocked_status: { verb: 'Unblock', state: 'blocked by another MR' },
  merge_request_blocked: { verb: 'Unblock', state: 'blocked by another MR' },
};

export function nextStep(mr: OpenMr): Step {
  const status = (mr.mergeStatus ?? '').toLowerCase();
  if (mr.draft || status === 'draft_status') return { verb: 'Finish', state: 'draft' };
  if (mr.conflicts || status === 'conflict') return { verb: 'Fix conflicts on', state: 'conflict' };
  if (WAITING_ON[status]) return WAITING_ON[status];
  if (mr.approvedBy.length && status === 'mergeable') return { verb: 'Merge', state: 'ready to merge' };
  if (mr.approvedBy.length && status === 'ci_still_running') return { verb: 'Merge', state: 'approved, pipeline running' };
  return mr.reviewers.length ? { verb: 'Chase review on', state: 'awaiting review' } : { verb: 'Ask for a review on', state: 'no reviewers' };
}

export function openMrLines(mrs: OpenMr[], excluded: string[]): StandupLine[] {
  return mrs.filter((mr) => !isExcluded(mr.projectPath, excluded)).map((mr) => {
    const ticket = ticketOf(mr);
    const { verb, state } = nextStep(mr);
    return { id: `open:${ref(mr)}`, tag: ticket ?? NO_TICKET, text: `${verb} ${repo(mr)} (${state})`, ticked: true, ...(ticket ? {} : { unknown: true }) };
  });
}

// An MR in a repo left out of standups still covers its ticket, so side-project work stays out.
export function inProgressLines(tickets: Ticket[], openMrs: MrBrief[]): StandupLine[] {
  const covered = new Set(openMrs.map(ticketOf).filter(Boolean));
  return tickets.filter((t) => !covered.has(t.key)).map((t) => ({ id: `progress:${t.key}`, tag: t.key, text: `${t.summary} (${t.status})`, ticked: true }));
}
