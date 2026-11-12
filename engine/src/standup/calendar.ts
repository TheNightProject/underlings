import type IcalModule from 'ical.js';
import { addDays, DAY, startOfDay, timeZone, wallClock, zonedTime } from '../locale.js';

type Ical = typeof IcalModule;
type Component = InstanceType<Ical['Component']>;
type Time = InstanceType<Ical['Time']>;

export const CALENDAR_TIMEOUT_MS = 30_000;
const MAX_CALENDAR_BYTES = 40 * 1024 * 1024;
const MAX_OCCURRENCES = 20_000;
const DAY_MS = 86_400_000;
const NAMES_SHOWN = 4;
const NOT_PEOPLE = new Set(['RESOURCE', 'ROOM']);
const EMAIL = /^[^\s@]+@[^\s@]+$/;
const MAX_DESCRIPTION = 5000;
const MAX_LOCATION = 500;
const RESPONSES: Record<string, Response> = { ACCEPTED: 'accepted', TENTATIVE: 'tentative', DECLINED: 'declined' };
const LINK_END = String.raw`[^\s"'<>)]+`;
const JOIN_LINKS: [RegExp, JoinKind][] = [
  [new RegExp(String.raw`https://meet\.google\.com/` + LINK_END, 'i'), 'meet'],
  [new RegExp(String.raw`https://(?:[\w-]+\.)*zoom\.us/(?:j|my|w|s)/` + LINK_END, 'i'), 'zoom'],
  [new RegExp(String.raw`https://teams\.microsoft\.com/l/meetup-join/` + LINK_END, 'i'), 'teams'],
  [new RegExp(String.raw`https://teams\.live\.com/meet/` + LINK_END, 'i'), 'teams'],
];
const HTML = /<\/?(?:a|b|i|u|p|br|div|span|strong|em|ul|ol|li|h[1-6])\b[^>]*>/i;
const MEET_NOTES = /-::~[:~]*::-[\s\S]*?-::~[:~]*::-/g;
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

export interface Meeting {
  id: string;
  summary: string;
  day: string;
  time: string | null;
  at: number;
  others: string[];
}

export type Response = 'accepted' | 'tentative' | 'needs-action' | 'declined';
type JoinKind = 'meet' | 'zoom' | 'teams' | 'other';

export interface Attendee {
  name: string;
  email: string;
  response: Response;
  self: boolean;
  organiser: boolean;
  optional: boolean;
}

export interface Join {
  url: string;
  kind: JoinKind;
}

export interface CalendarEvent {
  id: string;
  title: string;
  start: number;
  end: number;
  allDay: boolean;
  firstDay: string;
  lastDay: string;
  location: string | null;
  description: string | null;
  join: Join | null;
  organiser: { name: string; email: string } | null;
  attendees: Attendee[];
  response: Response | null;
  others: string[];
}

interface Person {
  email: string;
  name: string;
  partstat: string;
  cutype: string;
  role: string;
}

interface Occurrence {
  comp: Component;
  start: Time;
  id: string;
  spanDays: number;
  seconds: number;
}

interface Parsed {
  ical: Ical;
  events: Component[];
  self: Set<string>;
}

interface Window {
  days: string[];
  from: number;
  to: number;
  zone: string;
}

// The address is a secret, so no error here repeats it.
export async function fetchCalendar(address: string): Promise<string> {
  const res = await fetch(calendarUrl(address), { signal: AbortSignal.timeout(CALENDAR_TIMEOUT_MS), headers: { accept: 'text/calendar' } }).catch((err: unknown) => {
    throw new Error(`the calendar could not be read: ${(err as Error).name === 'TimeoutError' ? 'it did not answer within 30 s' : 'the request failed'}`);
  });
  if (!res.ok) throw new Error(`the calendar answered ${res.status}${res.status === 404 ? ', so check the address in Settings' : ''}`);
  const text = await res.text();
  if (text.length > MAX_CALENDAR_BYTES) throw new Error('the calendar is too big to read');
  if (!text.trimStart().startsWith('BEGIN:VCALENDAR')) throw new Error('that address did not return a calendar');
  return text;
}

export function calendarUrl(address: string): string {
  let url: URL;
  try {
    url = new URL(address.trim().replace(/^webcal:/i, 'https:'));
  } catch {
    throw new Error('the calendar address is not a link');
  }
  if (url.protocol !== 'https:') throw new Error('the calendar address must start with https://');
  return url.href;
}

export async function loadIcal(): Promise<Ical> {
  try {
    return (await import('ical.js')).default;
  } catch {
    throw new Error("the calendar reader is not installed, so run npm install in the review engine's folder");
  }
}

async function parsed(ics: string): Promise<Parsed> {
  const ical = await loadIcal();
  const root = new ical.Component(ical.parse(ics));
  const events = root.getAllSubcomponents('vevent');
  return { ical, events, self: selfEmails(root, events) };
}

function windowOf(days: string[], zone: string): Window {
  const sorted = [...days].sort();
  return { days, from: startOfDay(sorted[0] as string, zone), to: startOfDay(addDays(sorted.at(-1) as string, 1), zone), zone };
}

export async function meetingsOn(ics: string, days: string[], zone = timeZone()): Promise<Map<string, Meeting[]>> {
  const { ical, events, self } = await parsed(ics);
  const window = windowOf(days, zone);
  const found = new Map(days.map((day) => [day, [] as Meeting[]]));
  for (const occurrence of occurrences(ical, events, window)) {
    if (!wanted(occurrence.comp, self)) continue;
    for (const meeting of meetingsFor(ical, occurrence, window, self)) found.get(meeting.day)?.push(meeting);
  }
  for (const list of found.values()) list.sort((a, b) => a.at - b.at || a.summary.localeCompare(b.summary));
  return found;
}

export async function calendarEvents(ics: string, from: string, to: string, zone = timeZone()): Promise<CalendarEvent[]> {
  if (![from, to].every(isDay) || to < from) throw new Error('a calendar window looks like 2026-11-09 to 2026-11-13');
  const { ical, events, self } = await parsed(ics);
  const window = windowOf([from, to], zone);
  const found = [...occurrences(ical, events, window)]
    .filter((o) => !cancelled(o.comp))
    .map((o) => eventFor(ical, o, self, zone))
    .filter((e) => e.start < window.to && Math.max(e.end, e.start + 1) > window.from);
  return found.sort((a, b) => a.start - b.start || Number(b.allDay) - Number(a.allDay) || a.title.localeCompare(b.title));
}

const isDay = (day: string) => DAY.test(day) && addDays(day, 0) === day;

// A moved instance is read from its own component, since the series still puts it at its original time.
function* occurrences(ical: Ical, events: Component[], window: Window): Generator<Occurrence> {
  const moved = new Map<string, Set<number>>();
  for (const comp of events.filter((c) => c.hasProperty('recurrence-id'))) {
    const event = new ical.Event(comp);
    const was = event.recurrenceId.toUnixTime();
    moved.set(event.uid, (moved.get(event.uid) ?? new Set()).add(was));
    yield { comp, start: event.startDate, id: `${event.uid}@${was}`, spanDays: spanOf(event), seconds: event.duration.toSeconds() };
  }
  for (const comp of events.filter((c) => !c.hasProperty('recurrence-id'))) yield* series(ical, comp, moved, window);
}

function* series(ical: Ical, comp: Component, moved: Map<string, Set<number>>, window: Window): Generator<Occurrence> {
  const event = new ical.Event(comp);
  const spanDays = spanOf(event);
  const seconds = event.duration.toSeconds();
  const lasts = Math.max(seconds * 1000, spanDays * DAY_MS);
  if (!event.isRecurring()) {
    yield { comp, start: event.startDate, id: `${event.uid}@${event.startDate.toUnixTime()}`, spanDays, seconds };
    return;
  }
  const skip = moved.get(event.uid) ?? new Set<number>();
  const iterator = event.iterator();
  for (let n = 0, next = iterator.next(); next && n < MAX_OCCURRENCES; n += 1, next = iterator.next()) {
    const at = epochOf(ical, next, window.zone);
    if (at >= window.to) return;
    if (at + lasts > window.from && !skip.has(next.toUnixTime())) yield { comp, start: next, id: `${event.uid}@${next.toUnixTime()}`, spanDays, seconds };
  }
}

const spanOf = (event: InstanceType<Ical['Event']>) => (event.startDate.isDate ? Math.max(1, Math.round(event.duration.toSeconds() / 86_400)) : 0);

function meetingsFor(ical: Ical, { comp, start, id, spanDays }: Occurrence, window: Window, self: Set<string>): Meeting[] {
  const summary = summaryOf(comp);
  const at = epochOf(ical, start, window.zone);
  const meeting = (day: string, time: string | null): Meeting => ({ id, summary, day, time, at, others: otherNames(comp, self) });
  if (start.isDate) {
    const first = dateOf(start);
    return Array.from({ length: spanDays }, (_, n) => addDays(first, n)).filter((day) => window.days.includes(day)).map((day) => meeting(day, null));
  }
  const wall = floating(ical, start) ? { date: dateOf(start), time: clockOf(start) } : wallClock(at, window.zone);
  return window.days.includes(wall.date) ? [meeting(wall.date, wall.time)] : [];
}

function eventFor(ical: Ical, occurrence: Occurrence, self: Set<string>, zone: string): CalendarEvent {
  const { comp, id } = occurrence;
  const attendees = attendeesOf(comp, self);
  return {
    id,
    title: summaryOf(comp),
    ...spanFor(ical, occurrence, zone),
    location: clipped(textOf(comp, 'location'), MAX_LOCATION),
    description: plainText(textOf(comp, 'description')),
    join: joinOf(comp),
    organiser: organiserOf(comp),
    attendees,
    response: attendees.find((a) => a.self)?.response ?? null,
    others: otherNames(comp, self),
  };
}

function spanFor(ical: Ical, { start, spanDays, seconds }: Occurrence, zone: string): Pick<CalendarEvent, 'start' | 'end' | 'allDay' | 'firstDay' | 'lastDay'> {
  if (start.isDate) {
    const firstDay = dateOf(start);
    return { start: startOfDay(firstDay, zone), end: startOfDay(addDays(firstDay, spanDays), zone), allDay: true, firstDay, lastDay: addDays(firstDay, spanDays - 1) };
  }
  const at = epochOf(ical, start, zone);
  const end = at + seconds * 1000;
  const firstDay = wallClock(at, zone).date;
  const lastDay = wallClock(Math.max(at, end - 1), zone).date;
  return { start: at, end, allDay: false, firstDay, lastDay: lastDay < firstDay ? firstDay : lastDay };
}

const summaryOf = (comp: Component) => String(comp.getFirstPropertyValue('summary') ?? '').trim() || '(no title)';
const textOf = (comp: Component, name: string) => String(comp.getFirstPropertyValue(name) ?? '');
const clipped = (text: string, max: number) => (text.trim() ? text.trim().slice(0, max) : null);

function cancelled(comp: Component): boolean {
  return String(comp.getFirstPropertyValue('status') ?? '').toUpperCase() === 'CANCELLED';
}

function wanted(comp: Component, self: Set<string>): boolean {
  if (cancelled(comp)) return false;
  return !people(comp).some((p) => self.has(p.email) && p.partstat === 'DECLINED');
}

function people(comp: Component): Person[] {
  return comp.getAllProperties('attendee').map((p) => ({
    email: String(p.getFirstValue() ?? '').replace(/^mailto:/i, '').trim().toLowerCase(),
    name: String(p.getParameter('cn') ?? '').trim(),
    partstat: String(p.getParameter('partstat') ?? '').toUpperCase(),
    cutype: String(p.getParameter('cutype') ?? 'INDIVIDUAL').toUpperCase(),
    role: String(p.getParameter('role') ?? '').toUpperCase(),
  }));
}

function organiserOf(comp: Component): { name: string; email: string } | null {
  const prop = comp.getFirstProperty('organizer');
  const email = String(prop?.getFirstValue() ?? '').replace(/^mailto:/i, '').trim().toLowerCase();
  if (!email) return null;
  return { name: fullName(String(prop?.getParameter('cn') ?? '').trim(), email), email };
}

function attendeesOf(comp: Component, self: Set<string>): Attendee[] {
  const organiser = organiserOf(comp)?.email;
  const seen = new Map<string, Attendee>();
  for (const p of people(comp).filter((x) => human(x) && x.email && !seen.has(x.email))) {
    seen.set(p.email, { name: fullName(p.name, p.email), email: p.email, response: RESPONSES[p.partstat] ?? 'needs-action', self: self.has(p.email), organiser: p.email === organiser, optional: p.role === 'OPT-PARTICIPANT' });
  }
  return [...seen.values()].sort((a, b) => Number(b.organiser) - Number(a.organiser));
}

function fullName(name: string, email: string): string {
  if (name && !EMAIL.test(name)) return name;
  const words = (email.split('@')[0] ?? '').split(/[._-]+/).filter(Boolean);
  return words.map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ') || email;
}

function joinOf(comp: Component): Join | null {
  const conference = String(comp.getFirstPropertyValue('x-google-conference') ?? '').trim();
  if (isHttps(conference)) return { url: conference, kind: kindOf(conference) };
  return linkIn(textOf(comp, 'location')) ?? linkIn(textOf(comp, 'description'));
}

function linkIn(text: string): Join | null {
  const found = JOIN_LINKS.map(([pattern, kind]) => ({ match: pattern.exec(text), kind })).filter((f) => f.match);
  const first = found.sort((a, b) => (a.match?.index ?? 0) - (b.match?.index ?? 0))[0];
  if (!first?.match) return null;
  return { url: first.match[0].replaceAll('&amp;', '&').replace(/[.,;:!?]+$/, ''), kind: first.kind };
}

function kindOf(url: string): JoinKind {
  return JOIN_LINKS.find(([pattern]) => pattern.test(url))?.[1] ?? 'other';
}

function isHttps(text: string): boolean {
  try {
    return new URL(text).protocol === 'https:';
  } catch {
    return false;
  }
}

function plainText(raw: string): string | null {
  const text = decoded(HTML.test(raw) ? untagged(raw) : raw).replace(MEET_NOTES, '');
  const tidy = text.split(/\r?\n/).map((line) => line.trimEnd()).join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!tidy) return null;
  return tidy.length > MAX_DESCRIPTION ? tidy.slice(0, MAX_DESCRIPTION - 1) + '…' : tidy;
}

function untagged(html: string): string {
  return html
    .replace(/<a\b[^>]*?href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a>/gi, (_, url: string, label: string) => linkText(decoded(url), decoded(stripTags(label))))
    .replace(/<br\s*\/?>|<\/(?:div|h[1-6])>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '\n- ')
    .replace(/<\/(?:p|ul|ol)>/gi, '\n\n')
    .replace(/<[^>]*>/g, '');
}

const stripTags = (html: string) => html.replace(/<[^>]*>/g, '');
const linkText = (url: string, label: string) => (!label.trim() || label.trim() === url ? url : `${label.trim()} (${url})`);

function decoded(text: string): string {
  return text.replace(/&(#x[\da-f]+|#\d+|[a-z]+);/gi, (whole, name: string) => {
    if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? whole;
    const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

const human = (p: Person) => !NOT_PEOPLE.has(p.cutype) && !p.email.endsWith('.calendar.google.com');

function otherNames(comp: Component, self: Set<string>): string[] {
  const others = people(comp).filter((p) => human(p) && !self.has(p.email) && p.partstat !== 'DECLINED');
  return [...new Set(others.map(firstName))];
}

// An exported calendar is named after its owner, and the owner is on every invite, so either says who you are.
function selfEmails(root: Component, events: Component[]): Set<string> {
  const named = String(root.getFirstPropertyValue('x-wr-calname') ?? '').trim().toLowerCase();
  if (EMAIL.test(named)) return new Set([named]);
  const seen = new Map<string, number>();
  for (const p of events.flatMap(people)) seen.set(p.email, (seen.get(p.email) ?? 0) + 1);
  const top = [...seen].sort((a, b) => b[1] - a[1])[0]?.[0];
  return new Set(top ? [top] : []);
}

function firstName(p: Person): string {
  const from = p.name && !EMAIL.test(p.name) ? p.name : (p.name || p.email).split('@')[0] ?? '';
  const word = from.split(/[\s._-]+/).find(Boolean) ?? from;
  return word.charAt(0).toUpperCase() + word.slice(1);
}

export function namesLine(names: string[]): string {
  if (names.length <= 1) return names[0] ?? '';
  const shown = names.length > NAMES_SHOWN ? [...names.slice(0, NAMES_SHOWN - 1), `${names.length - NAMES_SHOWN + 1} others`] : names;
  return `${shown.slice(0, -1).join(', ')} and ${shown.at(-1)}`;
}

function floating(ical: Ical, t: Time): boolean {
  return !t.zone || t.zone === ical.Timezone.localTimezone;
}

const pad = (n: number) => String(n).padStart(2, '0');
const dateOf = (t: Time) => `${t.year}-${pad(t.month)}-${pad(t.day)}`;
const clockOf = (t: Time) => `${pad(t.hour)}:${pad(t.minute)}`;

function epochOf(ical: Ical, t: Time, zone: string): number {
  if (t.isDate) return startOfDay(dateOf(t), zone);
  return floating(ical, t) ? zonedTime(dateOf(t), clockOf(t), zone) : t.toUnixTime() * 1000;
}
