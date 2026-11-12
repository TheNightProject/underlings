import { forgeOf, GITLAB, type ActivityEvent, type MrBrief } from '../data/forge.js';
import { ticketsInProgress, ticketsMovedTo } from '../data/jira.js';
import type { Ticket } from '../types.js';
import { fetchCalendar, meetingsOn, type Meeting } from './calendar.js';
import {
  DEFAULT_EXCLUDED, inProgressLines, meetingLines, movedLines, mrKey, openMrLines, ownWork, reviews,
  type GitlabDay, type Move, type OpenMr, type StandupLine,
} from './compose.js';
import { addDays, DAY, formatted, savedLocale, startOfDay, timeZone, wallClock, workDays, workingDay } from '../locale.js';

const AT_ONCE = 6;
// Furthest along last, so a ticket moved twice in a day is said once, where it ended up.
export const MOVED_TO = ['QA', 'Resolved', 'Done', 'Closed'];
export const NO_CALENDAR = 'Add your calendar\'s secret iCal address in Settings, under Standup, to list your meetings.';

export interface StandupRequest {
  day: string;
  today?: string;
  excludedRepos?: string[];
  calendarAddress?: string | null;
  timeZone?: string;
  region?: string;
  clock?: string;
  workDays?: number[];
}

export interface StandupGroup {
  id: string;
  title: string;
  lines: StandupLine[];
  error: string | null;
  note: string | null;
}

export interface StandupSection {
  id: 'yesterday' | 'today';
  title: string;
  day: string;
  groups: StandupGroup[];
}

export interface Standup {
  day: string;
  today: string;
  generatedAt: string;
  sections: StandupSection[];
}

export async function buildStandup(request: StandupRequest): Promise<Standup> {
  const { day } = request;
  if (!DAY.test(day) || (request.today !== undefined && !DAY.test(request.today))) throw new Error('a standup day looks like 2026-11-09');
  const zone = request.timeZone ?? timeZone();
  const format = { timeZone: zone, region: request.region ?? savedLocale().region, clock: request.clock ?? savedLocale().clock };
  const today = request.today ?? workingDay(day, 1, request.workDays ?? workDays());
  const excluded = request.excludedRepos ?? DEFAULT_EXCLUDED;
  const me = forgeOf(GITLAB).me();
  const [gitlab, open, moves, progress, meetings] = await Promise.allSettled([
    me.then((name) => gitlabDay(name, day, zone)),
    me.then(() => openMrs()),
    movesOn(day),
    ticketsInProgress(),
    request.calendarAddress ? fetchCalendar(request.calendarAddress).then((ics) => meetingsOn(ics, [day, today], zone)) : Promise.resolve(null),
  ]);
  return {
    day,
    today,
    generatedAt: new Date().toISOString(),
    sections: [
      { id: 'yesterday', title: 'Yesterday', day, groups: yesterdayGroups(day, excluded, gitlab, moves, meetings, format) },
      { id: 'today', title: 'Today', day: today, groups: todayGroups(today, excluded, open, progress, meetings, format) },
    ],
  };
}

type Settled<T> = PromiseSettledResult<T>;
type Meetings = Settled<Map<string, Meeting[]> | null>;
type Format = Parameters<typeof formatted>[2];

function yesterdayGroups(day: string, excluded: string[], gitlab: Settled<GitlabDay>, moves: Settled<Move[]>, meetings: Meetings, format: Format): StandupGroup[] {
  const own = settled(gitlab, (g) => ownWork(g, excluded));
  return [
    { ...group('merged', 'Merged', own, (o) => o.merged), note: unread(gitlab, ['accepted', 'opened']) },
    group('opened', 'Opened', own, (o) => o.opened),
    group('moved', 'Tickets moved', settled(moves, movedLines)),
    meetingGroup('meetings', meetings, day, format),
    { ...group('reviews', 'Reviews', settled(gitlab, (g) => reviews(g, excluded))), note: unread(gitlab, ['commented on', 'approved']) },
  ];
}

function todayGroups(today: string, excluded: string[], open: Settled<OpenMr[]>, progress: Settled<Ticket[]>, meetings: Meetings, format: Format): StandupGroup[] {
  const openNow = open.status === 'fulfilled' ? open.value : [];
  return [
    group('open', 'Open MRs', settled(open, (list) => openMrLines(list, excluded))),
    group('progress', 'Tickets in progress', settled(progress, (tickets) => inProgressLines(tickets, openNow))),
    meetingGroup('today-meetings', meetings, today, format),
  ];
}

type Outcome<T> = { value: T } | { error: string };

function settled<T, R>(result: Settled<T>, then: (value: T) => R): Outcome<R> {
  return result.status === 'fulfilled' ? { value: then(result.value) } : { error: (result.reason as Error)?.message ?? String(result.reason) };
}

function group<T>(id: string, title: string, outcome: Outcome<T>, pick: (value: T) => StandupLine[] = (v) => v as StandupLine[]): StandupGroup {
  if ('error' in outcome) return { id, title, lines: [], error: outcome.error, note: null };
  return { id, title, lines: pick(outcome.value), error: null, note: null };
}

function unread(result: Settled<GitlabDay>, actions: string[]): string | null {
  if (result.status !== 'fulfilled') return null;
  const { events, mrs } = result.value;
  const keys = new Set(events.filter((e) => e.iid !== null && actions.includes(e.action)).map((e) => mrKey(e.projectId, e.iid as number)).filter((key) => !mrs.has(key)));
  if (!keys.size) return null;
  return keys.size === 1 ? 'GitLab would not show one MR, so it is left out.' : `GitLab would not show ${keys.size} MRs, so they are left out.`;
}

function meetingGroup(id: string, result: Meetings, day: string, format: Format): StandupGroup {
  if (result.status === 'fulfilled' && result.value === null) return { id, title: 'Meetings', lines: [], error: null, note: NO_CALENDAR };
  const clock = (m: Meeting) => formatted(m.at, { hour: '2-digit', minute: '2-digit' }, format);
  return group(id, 'Meetings', settled(result, (found) => meetingLines(found?.get(day) ?? [], id, clock)));
}

const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);

// GitLab's bounds are whole UTC days, so your day is widened to every UTC day it touches and trimmed here.
export function eventWindow(day: string, zone = timeZone()): { after: string; before: string } {
  return { after: addDays(utcDay(startOfDay(day, zone)), -1), before: addDays(utcDay(startOfDay(addDays(day, 1), zone) - 1), 1) };
}

async function gitlabDay(me: string, day: string, zone: string): Promise<GitlabDay> {
  const { after, before } = eventWindow(day, zone);
  const gitlab = forgeOf(GITLAB);
  const [events, merged] = await Promise.all([gitlab.myEvents(after, before), gitlab.myMrs('merged', new Date(startOfDay(day, zone)).toISOString())]);
  const onDay = events.filter((e) => e.author === me && wallClock(Date.parse(e.at), zone).date === day);
  return {
    me,
    events: onDay,
    mrs: await briefsFor(onDay),
    merged: merged.filter((mr) => mr.author === me && mr.mergedAt && wallClock(Date.parse(mr.mergedAt), zone).date === day),
  };
}

async function briefsFor(events: ActivityEvent[]): Promise<Map<string, MrBrief>> {
  const wanted = [...new Map(events.filter((e) => e.iid !== null).map((e) => [mrKey(e.projectId, e.iid as number), e])).values()];
  const gitlab = forgeOf(GITLAB);
  const briefs = await eachAtMost(wanted, (e) => gitlab.brief({ projectId: e.projectId, iid: e.iid as number }));
  return new Map(wanted.flatMap((e, n) => (briefs[n] ? [[mrKey(e.projectId, e.iid as number), briefs[n]]] : [])));
}

async function openMrs(): Promise<OpenMr[]> {
  const gitlab = forgeOf(GITLAB);
  const mrs = await gitlab.myMrs('opened');
  const approvers = await eachAtMost(mrs, (mr) => gitlab.approvers(mr));
  return mrs.map((mr, n) => ({ ...mr, approvedBy: approvers[n] ?? [] }));
}

// A status the Jira workflow does not have is refused by name, which only means nothing moved there.
async function movesOn(day: string): Promise<Move[]> {
  const found = await Promise.allSettled(MOVED_TO.map((status) => ticketsMovedTo(status, day)));
  const failed = found.flatMap((r) => (r.status === 'rejected' ? [(r.reason as Error).message] : []));
  const real = failed.filter((why) => !/does not exist/i.test(why));
  if (real.length) throw new Error(real[0]);
  const last = new Map<string, Move>();
  found.forEach((r, n) => {
    if (r.status === 'fulfilled') for (const ticket of r.value) last.set(ticket.key, { status: MOVED_TO[n] as string, ticket });
  });
  return [...last.values()];
}

export async function eachAtMost<T, R>(items: T[], fn: (item: T) => Promise<R>, limit = AT_ONCE): Promise<(R | null)[]> {
  const out: (R | null)[] = new Array(items.length).fill(null);
  let next = 0;
  const worker = async () => {
    for (let at = next++; at < items.length; at = next++) out[at] = await fn(items[at] as T).catch(() => null);
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
