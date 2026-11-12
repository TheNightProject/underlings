import { listOf } from '../settings.js';
import { KEY_PATTERN, PROJECT_KEY, TICKET_KEY } from '../ticketkeys.js';
import { sectionPattern, ticketTemplate } from '../tickettemplate.js';
import type { Ticket } from '../types.js';
import { runAcli, type AcliOptions } from './acli.js';
import { loadSettings } from './store.js';

const SEARCH_TIMEOUT_MS = 90_000;
const VIEW_TIMEOUT_MS = 30_000;
const MOVE_TIMEOUT_MS = 60_000;
const WHOLE_LIST = 500;

function site(): string {
  return loadSettings().jiraSite;
}

/** acli says what went wrong on its first line of output; the exit status says nothing. */
function acliError(err: unknown, timeout?: number): Error {
  const out = err as { stdout?: string; stderr?: string; message?: string; killed?: boolean };
  if (out.killed && timeout) return new Error(`Jira did not answer acli within ${timeout / 1000} s`);
  const said = `${out.stdout ?? ''}\n${out.stderr ?? ''}`.split('\n').map((l) => l.trim()).find(Boolean);
  return new Error(said ?? out.message ?? 'acli failed');
}

/**
 * Jira goes through acli, not the Atlassian MCP server: the MCP endpoint is frequently
 * unreachable from here, and acli holds its own oauth session.
 */
async function acli(args: string[], timeout: number, options: AcliOptions): Promise<unknown> {
  const { stdout } = await runAcli(args, { ...options, timeout }).catch((err: unknown) => {
    throw acliError(err, timeout);
  });
  const start = stdout.indexOf('[');
  const brace = stdout.indexOf('{');
  const from = start >= 0 && (brace < 0 || start < brace) ? start : brace;
  if (from < 0) throw new Error(`acli ${args.join(' ')} returned no JSON`);
  return JSON.parse(stdout.slice(from));
}

function assertKey(key: string): void {
  if (!TICKET_KEY.test(key)) throw new Error(`${key} is not a Jira key`);
}

interface RawType {
  name?: string;
  hierarchyLevel?: number;
}

interface RawIssue {
  key: string;
  transitions?: { to?: { name?: string } }[] | null;
  fields?: {
    summary?: string;
    description?: AdfNode | string | null;
    labels?: string[];
    status?: { name?: string };
    issuetype?: RawType;
    parent?: { key: string; fields?: { summary?: string; issuetype?: RawType } };
    assignee?: { displayName?: string } | null;
  };
}

function toTicket(raw: RawIssue): Ticket {
  return {
    key: raw.key,
    summary: raw.fields?.summary ?? '',
    status: raw.fields?.status?.name ?? 'Unknown',
    labels: raw.fields?.labels ?? [],
    url: `https://${site()}/browse/${raw.key}`,
  };
}

async function searchRaw(jql: string, limit: number, fields: string, options: AcliOptions = {}): Promise<RawIssue[]> {
  const data = (await acli([
    'jira', 'workitem', 'search',
    '--jql', jql,
    '--fields', fields,
    '--limit', String(limit),
    '--json',
  ], SEARCH_TIMEOUT_MS, options)) as (RawIssue | null)[] | { issues?: RawIssue[] };
  const issues = Array.isArray(data) ? data : data.issues ?? [];
  return issues.filter((issue): issue is RawIssue => Boolean(issue?.key));
}

async function searchIssues(jql: string, limit: number): Promise<Ticket[]> {
  return (await searchRaw(jql, limit, 'key,summary,status,labels')).map(toTicket);
}

export interface AssignedTicket extends Ticket {
  assignee: string | null;
}

export async function fetchAssignedTickets(jql: string, options: AcliOptions = {}): Promise<AssignedTicket[]> {
  const issues = await searchRaw(jql, WHOLE_LIST, 'key,summary,status,assignee', options);
  return issues.map((raw) => ({ ...toTicket(raw), assignee: raw.fields?.assignee?.displayName ?? null }));
}

// acli answers a search for the key alone with a row of nulls, so it is asked for the status too.
export async function fetchTicketKeys(jql: string, options: AcliOptions = {}): Promise<string[]> {
  return (await searchRaw(jql, WHOLE_LIST, 'key,status', options)).map((raw) => raw.key);
}

const quotedStatus = (name: string): string => (/^\w+$/.test(name) ? name : `"${name.replace(/["\\]/g, '\\$&')}"`);

// A workflow can keep unfinished work in Jira's Done category, so naming the finished statuses wins over the category.
export function doneClause(doneStatuses: string): string {
  const named = listOf(doneStatuses);
  return named.length ? `status NOT IN (${named.map(quotedStatus).join(', ')})` : 'statusCategory != Done';
}

export async function fetchMyTickets(limit = 200): Promise<Ticket[]> {
  if (!site()) throw new Error('No Jira site set. Add one in settings to use the ticket pane.');
  return searchIssues(`assignee = currentUser() AND ${doneClause(loadSettings().jira.doneStatuses)} ORDER BY updated DESC`, limit);
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const STATUS = /^[\w -]{1,40}$/;

export async function ticketsMovedTo(status: string, day: string): Promise<Ticket[]> {
  if (!DAY.test(day) || !STATUS.test(status)) throw new Error(`cannot search for ${status} on ${day}`);
  return searchIssues(`assignee = currentUser() AND status CHANGED TO "${status}" DURING ("${day} 00:00", "${day} 23:59") ORDER BY updated DESC`, 100);
}

export async function ticketsMovedBy(status: string, day: string): Promise<Ticket[]> {
  if (!DAY.test(day) || !STATUS.test(status)) throw new Error(`cannot search for ${status} on ${day}`);
  return searchIssues(`status CHANGED TO "${status}" BY currentUser() DURING ("${day} 00:00", "${day} 23:59") ORDER BY updated DESC`, 100);
}

export async function ticketsInProgress(): Promise<Ticket[]> {
  return searchIssues('assignee = currentUser() AND statusCategory = "In Progress" ORDER BY updated DESC', 100);
}

export async function fetchTickets(keys: string[]): Promise<Map<string, Ticket>> {
  const out = new Map<string, Ticket>();
  for (let i = 0; i < keys.length; i += 50) {
    const batch = keys.slice(i, i + 50);
    const found = await searchIssues(`key in (${batch.join(',')})`, batch.length).catch(() => []);
    for (const ticket of found) out.set(ticket.key, ticket);
  }
  return out;
}

/** Exact phrases, so a note id finds the tickets that link its thread and nothing that only shares a word. */
export async function ticketsMentioning(phrases: string[], limit = 5): Promise<Ticket[]> {
  const clauses = phrases.map((p) => p.replace(/["\\]/g, '').trim()).filter(Boolean).map((p) => `text ~ "\\"${p}\\""`);
  if (clauses.length === 0) return [];
  return searchIssues(`(${clauses.join(' OR ')}) ORDER BY created DESC`, limit);
}

export async function ticketChildren(parent: string, limit = 8): Promise<Ticket[]> {
  assertKey(parent);
  return searchIssues(`parent = ${parent} ORDER BY created DESC`, limit);
}

export interface TicketView extends Ticket {
  type: string;
  epic: boolean;
  parent: { key: string; summary: string; epic: boolean } | null;
  description: string;
  /** Null while acli leaves out the transitions its JSON has room for, as every version so far does. */
  transitions: string[] | null;
}

function transitionsOf(raw: RawIssue): string[] | null {
  if (!Array.isArray(raw.transitions)) return null;
  return [...new Set(raw.transitions.map((t) => t?.to?.name).filter((name): name is string => typeof name === 'string' && name.length > 0))];
}

const isEpic = (type?: RawType): boolean => type?.hierarchyLevel === 1 || type?.name === 'Epic';

/** acli's search will not return a parent, so the one read that needs it views the work item. */
export async function viewTicket(key: string, options: AcliOptions = {}): Promise<TicketView> {
  assertKey(key);
  const raw = (await acli([
    'jira', 'workitem', 'view', key,
    '--fields', 'key,summary,status,labels,issuetype,parent,description',
    '--json',
  ], VIEW_TIMEOUT_MS, options)) as RawIssue;
  const parent = raw.fields?.parent;
  return {
    ...toTicket(raw),
    type: raw.fields?.issuetype?.name ?? 'Unknown',
    epic: isEpic(raw.fields?.issuetype),
    parent: parent ? { key: parent.key, summary: parent.fields?.summary ?? '', epic: isEpic(parent.fields?.issuetype) } : null,
    description: typeof raw.fields?.description === 'string' ? raw.fields.description : adfText(raw.fields?.description),
    transitions: transitionsOf(raw),
  };
}

const BLOCKS = new Set(['paragraph', 'heading', 'codeBlock', 'blockquote', 'rule', 'tableRow']);

/** The description as plain text, a line per block and a dash per list item, since the page never renders markup from Jira. */
export function adfText(node: AdfNode | null | undefined): string {
  return adfLines(node).join('').replace(/\n{3,}/g, '\n\n').trim();
}

function adfLines(node: AdfNode | null | undefined): string[] {
  if (!node) return [];
  if (node.type === 'text') return [node.text ?? ''];
  if (node.type === 'hardBreak') return ['\n'];
  if (['mention', 'emoji', 'inlineCard'].includes(node.type)) return [String(node.attrs?.['text'] ?? node.attrs?.['shortName'] ?? node.attrs?.['url'] ?? '')];
  const inner = (node.content ?? []).flatMap(adfLines);
  if (node.type === 'listItem') return ['- ', inner.join('').trimEnd(), '\n'];
  return BLOCKS.has(node.type) ? [...inner, '\n'] : inner;
}

export interface NewTicket {
  project: string;
  type?: string;
  summary: string;
  /** Plain text: lines that name a section become bold headings and lines starting "- " a list. */
  description: string;
  parent?: string;
  /** An email, an account id, or `@me`. */
  assignee?: string;
}

/** Each value is one argument joined to its flag by `=`, never a shell string, so none of it runs or reads as a flag. */
export function createArgs(ticket: NewTicket): string[] {
  return [
    'jira', 'workitem', 'create',
    `--project=${ticket.project}`,
    `--type=${ticket.type || loadSettings().jira.issueType || 'Task'}`,
    `--summary=${ticket.summary}`,
    `--description=${JSON.stringify(descriptionDoc(ticket.description))}`,
    ...(ticket.parent ? [`--parent=${ticket.parent}`] : []),
    ...(ticket.assignee ? [`--assignee=${ticket.assignee}`] : []),
    '--json',
  ];
}

export async function createTicket(ticket: NewTicket): Promise<Ticket> {
  if (!PROJECT_KEY.test(ticket.project)) throw new Error(`${ticket.project} is not a Jira project key`);
  if (ticket.parent) assertKey(ticket.parent);
  const { stdout } = await runAcli(createArgs(ticket)).catch((err: unknown) => {
    throw acliError(err);
  });
  const key = createdKey(stdout);
  // The work item exists by now, so a caller must not make it again.
  if (!key) throw Object.assign(new Error(`acli created a work item but did not say its key: ${stdout.trim().slice(0, 200)}`), { created: true });
  return { key, summary: ticket.summary, status: 'Unknown', labels: [], url: `https://${site()}/browse/${key}` };
}

export function createdKey(stdout: string): string | null {
  return keyInJson(stdout) ?? new RegExp(`\\b${KEY_PATTERN}\\b`).exec(stdout)?.[0] ?? null;
}

function keyInJson(stdout: string): string | null {
  const brace = stdout.indexOf('{');
  if (brace < 0) return null;
  try {
    const key = (JSON.parse(stdout.slice(brace)) as { key?: unknown }).key;
    return typeof key === 'string' && TICKET_KEY.test(key) ? key : null;
  } catch {
    return null;
  }
}

interface AdfNode {
  type: string;
  version?: number;
  content?: AdfNode[];
  text?: string;
  attrs?: Record<string, unknown>;
  marks?: { type: string; attrs?: Record<string, string> }[];
}

const BULLET = /^\s*[-*•]\s+/;
const INLINE = /`([^`]+)`|(https?:\/\/[^\s<>]*[^\s<>.,;:!?)'"])/g;

/** The template's headings go in bold and "- " lines become a list, which a plain-text description cannot carry. */
export function descriptionDoc(text: string, headings: string[] = ticketTemplate().headings): AdfNode {
  const sections = sectionPattern(headings);
  const blocks: AdfNode[] = [];
  let lines: string[] = [];
  let items: AdfNode[] = [];
  const endParagraph = (): void => {
    if (lines.length) blocks.push({ type: 'paragraph', content: withBreaks(lines) });
    lines = [];
  };
  const endList = (): void => {
    if (items.length) blocks.push({ type: 'bulletList', content: items });
    items = [];
  };
  for (const raw of text.replace(/\r\n?/g, '\n').split('\n')) {
    const line = raw.trim();
    const section = sections?.exec(line)?.[1];
    const bullet = BULLET.test(raw);
    if (!bullet) endList();
    if (!line || section || bullet) endParagraph();
    if (section) blocks.push({ type: 'paragraph', content: [{ type: 'text', text: section, marks: [{ type: 'strong' }] }] });
    else if (bullet) items.push({ type: 'listItem', content: [{ type: 'paragraph', content: inline(raw.replace(BULLET, '').trim()) }] });
    else if (line) lines.push(line);
  }
  endParagraph();
  endList();
  return { type: 'doc', version: 1, content: blocks };
}

function withBreaks(lines: string[]): AdfNode[] {
  return lines.flatMap((line, i) => (i ? [{ type: 'hardBreak' }, ...inline(line)] : inline(line)));
}

function inline(text: string): AdfNode[] {
  const out: AdfNode[] = [];
  let at = 0;
  for (const m of text.matchAll(INLINE)) {
    if (m.index > at) out.push({ type: 'text', text: text.slice(at, m.index) });
    if (m[1] !== undefined) out.push({ type: 'text', text: m[1], marks: [{ type: 'code' }] });
    else if (m[2] !== undefined) out.push({ type: 'text', text: m[2], marks: [{ type: 'link', attrs: { href: m[2] } }] });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ type: 'text', text: text.slice(at) });
  return out;
}

/**
 * acli offers no way to list the transitions a work item allows, so the caller offers
 * likely statuses and Jira is the one that says no. The error comes back verbatim,
 * because "Transition not valid" is the useful half of the answer.
 */
export async function transitionTicket(key: string, status: string): Promise<void> {
  assertKey(key);
  try {
    await runAcli(['jira', 'workitem', 'transition', '--key', key, '--status', status, '--yes'], { timeout: MOVE_TIMEOUT_MS });
  } catch (err) {
    const out = err as { stdout?: string; stderr?: string };
    const said = `${out.stdout ?? ''}${out.stderr ?? ''}`.trim();
    throw new Error(said.split('\n').find((l) => l.trim()) ?? `could not move ${key} to ${status}`);
  }
}

export function isAvailable(): Promise<boolean> {
  return runAcli(['jira', 'auth', 'status'], { timeout: VIEW_TIMEOUT_MS })
    .then(({ stdout }) => stdout.includes('Authenticated'))
    .catch(() => false);
}
