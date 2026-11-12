import type { AcliOptions, AcliPriority } from '../data/acli.js';
import { forgeOf, GITLAB, type MergedMr } from '../data/forge.js';
import { fetchAssignedTickets, fetchTicketKeys, type AssignedTicket } from '../data/jira.js';
import { keyOf } from '../refs.js';
import { listOf } from '../settings.js';

export const QA_WINDOW_DAYS = 60;
export const QA_STATUS = 'QA';
const DAY_MS = 86_400_000;
const SLICE_DAYS = 7;
const AT_ONCE = 4;
const OVERLAP_MS = 3_600_000;
const FULL_EVERY_MS = DAY_MS;
// A version such as vite-6.x in a bot's branch is not a ticket.
const KEY_LIKE = /\b[A-Za-z][A-Za-z0-9]{1,9}-[1-9]\d*\b(?!\.[\dx])/g;

// Each edge costs a Jira search, so days are exact for two weeks and ranges after that.
export const QA_EDGES = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 21, 28, 42, 60, 90];

export interface QaBucket {
  id: string;
  label: string;
  upTo: number | null;
}

export const QA_BUCKETS: QaBucket[] = [
  { id: 'today', label: 'Today', upTo: 1 },
  { id: 'days-2-3', label: '2 to 3 days', upTo: 3 },
  { id: 'days-4-7', label: '4 to 7 days', upTo: 7 },
  { id: 'weeks-1-2', label: '1 to 2 weeks', upTo: 14 },
  { id: 'weeks-2-plus', label: 'Over 2 weeks', upTo: null },
];

export interface QaDays {
  from: number;
  to: number | null;
}

export interface QaMr {
  project: string;
  iid: number;
  url: string;
  title: string;
  mergedAt: string;
  author: string;
  additions: number;
  deletions: number;
  keys: string[];
}

export interface QaMerged {
  group: string;
  windowDays: number;
  fullAt: string;
  through: string;
  mrs: QaMr[];
}

export interface QaTicket {
  key: string;
  summary: string;
  assignee: string | null;
  url: string;
  days: QaDays;
  bucket: string;
  mrs: QaMr[];
}

export interface QaBoard {
  generatedAt: string;
  jql: string;
  status: string;
  /** Comma separated, as a board can join MRs from more than one group. */
  group: string;
  windowDays: number;
  buckets: QaBucket[];
  tickets: QaTicket[];
  merged: QaMerged;
}

export interface QaRequest {
  jql: string;
  status?: string;
  group?: string;
  windowDays?: number;
  merged?: QaMerged | null;
  full?: boolean;
  now?: number;
  priority?: AcliPriority;
}

const iso = (ms: number): string => new Date(ms).toISOString();
const BEYOND: QaDays = { from: (QA_EDGES.at(-1) as number) + 1, to: null };

export async function buildQaBoard(request: QaRequest): Promise<QaBoard> {
  const jql = String(request.jql ?? '').trim();
  if (!jql) throw new Error('the QA search needs some JQL, such as project = ABC AND status = QA');
  const status = request.status?.trim() || QA_STATUS;
  const group = listOf(request.group).join(', ');
  const windowDays = request.windowDays ?? QA_WINDOW_DAYS;
  const now = request.now ?? Date.now();
  const jira = { priority: request.priority };
  const [tickets, days, merged] = await Promise.all([
    fetchAssignedTickets(jql, jira),
    daysInQa(jql, status, jira),
    mergedMrs(group, windowDays, now, request.full ? null : request.merged ?? null),
  ]);
  const byKey = mrsByKey(merged.mrs);
  return {
    generatedAt: iso(now),
    jql,
    status,
    group,
    windowDays,
    buckets: QA_BUCKETS,
    tickets: tickets.map((t) => qaTicket(t, days.get(t.key) ?? BEYOND, byKey.get(t.key) ?? [])).sort(oldestFirst),
    merged,
  };
}

export function ticketKeysIn(...texts: string[]): string[] {
  return [...new Set(texts.flatMap((text) => text.match(KEY_LIKE) ?? []).map((key) => key.toUpperCase()))];
}

export function bucketOf(days: QaDays): string {
  return (QA_BUCKETS.find((b) => b.upTo === null || days.from <= b.upTo) as QaBucket).id;
}

function qaTicket(ticket: AssignedTicket, days: QaDays, mrs: QaMr[]): QaTicket {
  return { key: ticket.key, summary: ticket.summary, assignee: ticket.assignee, url: ticket.url, days, bucket: bucketOf(days), mrs };
}

function oldestFirst(a: QaTicket, b: QaTicket): number {
  return b.days.from - a.days.from || (b.days.to ?? Infinity) - (a.days.to ?? Infinity) || a.key.localeCompare(b.key, 'en', { numeric: true });
}

const withoutOrder = (jql: string): string => jql.replace(/\s+order\s+by\s[\s\S]*$/i, '');

async function daysInQa(jql: string, status: string, jira: AcliOptions): Promise<Map<string, QaDays>> {
  const base = withoutOrder(jql);
  const named = status.replace(/["\\]/g, '\\$&');
  const found = await atMost(QA_EDGES, (days) => fetchTicketKeys(`(${base}) AND status CHANGED TO "${named}" AFTER startOfDay(-${days - 1})`, jira));
  const out = new Map<string, QaDays>();
  QA_EDGES.forEach((to, n) => {
    for (const key of found[n] ?? []) if (!out.has(key)) out.set(key, { from: (QA_EDGES[n - 1] ?? 0) + 1, to });
  });
  return out;
}

function reusable(known: QaMerged | null, group: string, windowDays: number, now: number): known is QaMerged {
  if (!known || known.group !== group || known.windowDays !== windowDays || !Array.isArray(known.mrs)) return false;
  return now - Date.parse(known.fullAt) < FULL_EVERY_MS && Number.isFinite(Date.parse(known.through));
}

// A merged MR rarely changes, so only new merges are asked for; the daily full read catches a title fixed later.
async function mergedMrs(group: string, windowDays: number, now: number, known: QaMerged | null): Promise<QaMerged> {
  const start = now - windowDays * DAY_MS;
  const reuse = reusable(known, group, windowDays, now);
  const from = reuse ? Math.max(start, Date.parse(known.through) - OVERLAP_MS) : start;
  const asks = listOf(group).flatMap((one) => slices(from, now).map(([after, before]) => ({ one, after, before })));
  const gitlab = forgeOf(GITLAB);
  const pages = await atMost(asks, ({ one, after, before }) => gitlab.mergedIn(one, after, before));
  const byRef = new Map((reuse ? known.mrs : []).map((mr) => [keyOf({ projectPath: mr.project, iid: mr.iid }), mr]));
  for (const mr of pages.flat()) {
    const keys = ticketKeysIn(mr.title, mr.sourceBranch);
    if (keys.length) byRef.set(keyOf(mr), qaMr(mr, keys));
    else byRef.delete(keyOf(mr));
  }
  const mrs = [...byRef.values()].filter((mr) => Date.parse(mr.mergedAt) >= start).sort((a, b) => Date.parse(b.mergedAt) - Date.parse(a.mergedAt));
  return { group, windowDays, fullAt: reuse ? known.fullAt : iso(now), through: iso(now), mrs };
}

// GitLab reads mergedBefore as the end of that day, so slices meeting on a bound overlap and never leave a gap.
function slices(from: number, to: number): [string, string | null][] {
  const out: [string, string | null][] = [];
  for (let at = from; at < to; at += SLICE_DAYS * DAY_MS) {
    const end = at + SLICE_DAYS * DAY_MS;
    out.push([iso(at), end >= to ? null : iso(end)]);
  }
  return out.length ? out : [[iso(from), null]];
}

function qaMr(mr: MergedMr, keys: string[]): QaMr {
  return {
    project: mr.projectPath, iid: mr.iid, url: mr.webUrl, title: mr.title, mergedAt: mr.mergedAt,
    author: mr.author, additions: mr.additions, deletions: mr.deletions, keys,
  };
}

function mrsByKey(mrs: QaMr[]): Map<string, QaMr[]> {
  const out = new Map<string, QaMr[]>();
  for (const mr of [...mrs].reverse()) for (const key of mr.keys) out.set(key, [...(out.get(key) ?? []), mr]);
  return out;
}

async function atMost<T, R>(items: readonly T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const at = next++;
      out[at] = await fn(items[at] as T);
    }
  };
  await Promise.all(Array.from({ length: Math.min(AT_ONCE, items.length) }, worker));
  return out;
}
