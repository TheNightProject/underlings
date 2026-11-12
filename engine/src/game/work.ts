import { forgeOf, GITLAB, type ActivityEvent, type MrBrief } from '../data/forge.js';
import { ticketsMovedBy } from '../data/jira.js';
import { eachAtMost, eventWindow } from '../standup/build.js';
import { addDays, DAY, dayIn, startOfDay, timeZone } from '../locale.js';
import { idKey, keyOf } from '../refs.js';

const JIRA_AT_ONCE = 2;
const REVIEWING = new Set(['commented on', 'approved']);

export interface WorkBrief {
  projectPath: string;
  author: string;
  title: string;
}

export interface WorkMerge {
  key: string;
  title: string;
  at: string;
  day: string;
}

export interface WorkReview {
  key: string;
  title: string;
  day: string;
  at: string;
  comments: number;
  approved: boolean;
}

export interface WorkMove {
  key: string;
  status: string;
  day: string;
  summary: string;
}

export interface GitlabWork {
  me: string;
  merged: WorkMerge[];
  reviews: WorkReview[];
  briefs: Record<string, WorkBrief>;
}

const eventKey = (e: ActivityEvent): string => idKey(e);

export function daysBetween(from: string, to: string): string[] {
  const days: string[] = [];
  for (let day = from; day <= to; day = addDays(day, 1)) days.push(day);
  return days;
}

export function workFrom(me: string, events: ActivityEvent[], merged: MrBrief[], briefs: Record<string, WorkBrief>, from: string, to: string, zone = timeZone()): Pick<GitlabWork, 'merged' | 'reviews'> {
  const inRange = (day: string) => day >= from && day <= to;
  const dayOf = (at: string): string => dayIn(Date.parse(at), zone);
  const mergedWork = merged
    .filter((mr) => mr.author === me && mr.mergedAt && inRange(dayOf(mr.mergedAt)))
    .map((mr) => ({ key: keyOf(mr), title: mr.title, at: mr.mergedAt as string, day: dayOf(mr.mergedAt as string) }));
  const reviews = new Map<string, WorkReview>();
  for (const e of [...events].sort((a, b) => a.at.localeCompare(b.at))) {
    const brief = briefs[eventKey(e)];
    const day = dayOf(e.at);
    if (e.author !== me || !REVIEWING.has(e.action) || !brief || brief.author === me || !inRange(day)) continue;
    const key = keyOf({ projectPath: brief.projectPath, iid: e.iid as number });
    const review = reviews.get(`${key}@${day}`) ?? { key, title: brief.title, day, at: e.at, comments: 0, approved: false };
    if (e.action === 'approved') review.approved = true;
    else review.comments += 1;
    reviews.set(`${key}@${day}`, review);
  }
  return { merged: mergedWork, reviews: [...reviews.values()] };
}

function checkWindow(from: string, to: string): void {
  if (!DAY.test(from) || !DAY.test(to) || from > to) throw new Error('a work window runs from one day like 2026-11-09 to another no earlier');
}

export async function readGitlabWork(from: string, to: string, known: Record<string, WorkBrief> = {}, zone = timeZone()): Promise<GitlabWork> {
  checkWindow(from, to);
  const gitlab = forgeOf(GITLAB);
  const me = await gitlab.me();
  const [events, merged] = await Promise.all([
    gitlab.myEvents(eventWindow(from, zone).after, eventWindow(to, zone).before),
    gitlab.myMrs('merged', new Date(startOfDay(from, zone)).toISOString()),
  ]);
  const wanted = [...new Map(events.filter((e) => e.iid !== null && REVIEWING.has(e.action) && !known[eventKey(e)]).map((e) => [eventKey(e), e])).values()];
  const fetched = await eachAtMost(wanted, (e) => gitlab.brief({ projectId: e.projectId, iid: e.iid as number }));
  const briefs = { ...known };
  wanted.forEach((e, n) => {
    const mr = fetched[n];
    if (mr) briefs[eventKey(e)] = { projectPath: mr.projectPath, author: mr.author, title: mr.title };
  });
  return { me, briefs, ...workFrom(me, events, merged, briefs, from, to, zone) };
}

// A status the workflow does not have is refused by name, which only means nothing moved there.
export async function readTicketMoves(from: string, to: string, statuses: string[]): Promise<WorkMove[]> {
  checkWindow(from, to);
  const asks = daysBetween(from, to).flatMap((day) => [...new Set(statuses)].map((status) => ({ day, status })));
  const found = await eachAtMost(asks, ({ day, status }) => ticketsMovedBy(status, day).catch((err: Error) => err), JIRA_AT_ONCE);
  const failed = found.filter((r): r is Error => r instanceof Error && !/does not exist/i.test(r.message));
  if (failed.length === asks.length && asks.length) throw failed[0];
  return asks.flatMap(({ day, status }, n) => {
    const tickets = found[n];
    return Array.isArray(tickets) ? tickets.map((t) => ({ key: t.key, status, day, summary: t.summary })) : [];
  });
}
