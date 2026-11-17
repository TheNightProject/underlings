import { keyOf as refKey } from '../refs.js';
import { listOf, matchRepo, parseFilter, projectRefOf, type ProjectRef } from '../settings.js';
import { GITHUB_ISSUE, GITHUB_REPO, issueParts, type IssueParts } from '../ticketkeys.js';
import { sectionPattern, ticketTemplate } from '../tickettemplate.js';
import type { NewTicket, TicketSource, TicketView } from '../ticketsource.js';
import type { Ticket } from '../types.js';
import { githubSettings, githubToken, graphql, rest, viewerLogin } from './github.js';
import { loadSettings } from './store.js';

export const OPEN = 'Open';
export const CLOSED = 'Closed';
export const NO_STATUS = 'No Status';
const STATUS_FIELD = 'Status';
const SEARCH_FIRST = 100;
const FOUND_AT_ONCE = 20;
const PHRASES_AT_ONCE = 5;
const BOARD_MS = 5 * 60_000;
const FINISHED = ['Done'];
const RATE = 'rateLimit { cost remaining resetAt }';

const ISSUE_FIELDS = `
fragment issue on Issue {
  id number title url state
  repository { nameWithOwner }
  labels(first: 20) { nodes { name } }
  parent { number title repository { nameWithOwner } }
  projectItems(first: 20) { nodes { id project { id } status: fieldValueByName(name: "${STATUS_FIELD}") { ... on ProjectV2ItemFieldSingleSelectValue { name } } } }
  closedByPullRequestsReferences(first: 10, includeClosedPrs: false) { nodes { number repository { nameWithOwner } } }
}`;

const MINE_QUERY = `query MyIssues($assigned: String!) {
  ${RATE}
  assigned: search(type: ISSUE, query: $assigned, first: ${SEARCH_FIRST}) { nodes { ...issue } }
}
${ISSUE_FIELDS}`;

const SEARCH_QUERY = `query IssueSearch($query: String!, $first: Int!) {
  ${RATE}
  search(type: ISSUE, query: $query, first: $first) { nodes { ...issue } }
}
${ISSUE_FIELDS}`;

const ISSUE_QUERY = `query Issue($owner: String!, $name: String!, $number: Int!) {
  ${RATE}
  repository(owner: $owner, name: $name) { issue(number: $number) { ...issue body } }
}
${ISSUE_FIELDS}`;

const CHILDREN_QUERY = `query SubIssues($owner: String!, $name: String!, $number: Int!, $last: Int!) {
  ${RATE}
  repository(owner: $owner, name: $name) { issue(number: $number) { subIssues(last: $last) { nodes { ...issue } } } }
}
${ISSUE_FIELDS}`;

const BOARD_FIELDS = `
fragment board on ProjectV2 {
  id title url
  field(name: "${STATUS_FIELD}") { __typename ... on ProjectV2SingleSelectField { id options { id name } } }
}`;

// A login is a user or an organisation, and GitHub says which only by answering one and refusing the other.
const BOARD_QUERY = `query ProjectBoard($owner: String!, $number: Int!) {
  ${RATE}
  organization(login: $owner) { projectV2(number: $number) { ...board } }
  user(login: $owner) { projectV2(number: $number) { ...board } }
}
${BOARD_FIELDS}`;

const MOVE_MUTATION = `mutation MoveItem($project: ID!, $item: ID!, $field: ID!, $option: String!) {
  updateProjectV2ItemFieldValue(input: { projectId: $project, itemId: $item, fieldId: $field, value: { singleSelectOptionId: $option } }) { projectV2Item { id } }
}`;

const ADD_ITEM_MUTATION = `mutation AddItem($project: ID!, $content: ID!) {
  addProjectV2ItemById(input: { projectId: $project, contentId: $content }) { item { id } }
}`;

const SUB_ISSUE_MUTATION = `mutation AddSubIssue($parent: ID!, $child: ID!) {
  addSubIssue(input: { issueId: $parent, subIssueId: $child }) { issue { id } }
}`;

interface GhRepoRef {
  nameWithOwner: string;
}

export interface GhIssue {
  id: string;
  number: number;
  title: string;
  url: string;
  state: 'OPEN' | 'CLOSED';
  body?: string | null;
  repository: GhRepoRef;
  labels: { nodes: ({ name: string } | null)[] } | null;
  parent: { number: number; title: string; repository: GhRepoRef } | null;
  projectItems: { nodes: ({ id: string; project: { id: string } | null; status: { name?: string } | null } | null)[] } | null;
  closedByPullRequestsReferences: { nodes: ({ number: number; repository: GhRepoRef } | null)[] } | null;
}

export interface Board {
  id: string;
  title: string;
  url: string;
  fieldId: string;
  options: { id: string; name: string }[];
}

interface GhBoard {
  id: string;
  title: string;
  url: string;
  field: { __typename: string; id?: string; options?: { id: string; name: string }[] } | null;
}

type Owned = { projectV2: GhBoard | null } | null;

const keyOf = (issue: Pick<GhIssue, 'number' | 'repository'>): string => refKey({ provider: 'github', projectPath: issue.repository.nameWithOwner, iid: issue.number });
const issueNodes = <T>(nodes: (T | null)[] | undefined): T[] => (nodes ?? []).filter((n): n is T => Boolean(n));

function partsOf(key: string): IssueParts {
  const parts = issueParts(key);
  if (!parts) throw new Error(`${key} is not a GitHub issue, which looks like acme/web#12`);
  return parts;
}

let board: { ref: string; at: number; value: Board | null } | null = null;

export function forgetBoard(): void {
  board = null;
}

function projectRef(): ProjectRef | null {
  return projectRefOf(loadSettings().tickets.githubProject);
}

function boardOf(found: GhBoard | null, ref: ProjectRef): Board {
  const name = `${ref.owner}/${ref.number}`;
  if (!found) throw new Error(`GitHub has no Project ${name} that this token can read`);
  const field = found.field;
  if (field?.__typename !== 'ProjectV2SingleSelectField' || !field.id) throw new Error(`the Project ${found.title} has no single-select field named ${STATUS_FIELD}`);
  return { id: found.id, title: found.title, url: found.url, fieldId: field.id, options: field.options ?? [] };
}

/** The Project named in Ticket settings, read again every few minutes; null while none is named. */
export async function projectBoard(now = Date.now()): Promise<Board | null> {
  const ref = projectRef();
  if (!ref) return null;
  const named = `${ref.owner}/${ref.number}`;
  if (board?.ref === named && now - board.at < BOARD_MS) return board.value;
  const data = await graphql<{ organization: Owned; user: Owned }>(BOARD_QUERY, { owner: ref.owner, number: ref.number });
  const value = boardOf(data.organization?.projectV2 ?? data.user?.projectV2 ?? null, ref);
  board = { ref: named, at: now, value };
  return value;
}

function itemOn(issue: GhIssue, on: Board | null): { id: string; status: string } | null {
  if (!on) return null;
  const item = issueNodes(issue.projectItems?.nodes).find((node) => node.project?.id === on.id);
  return item ? { id: item.id, status: item.status?.name || NO_STATUS } : null;
}

export function statusOf(issue: GhIssue, on: Board | null): string {
  return itemOn(issue, on)?.status ?? (issue.state === 'CLOSED' ? CLOSED : OPEN);
}

export function toTicket(issue: GhIssue, on: Board | null): Ticket {
  return {
    key: keyOf(issue),
    summary: issue.title,
    status: statusOf(issue, on),
    labels: issueNodes(issue.labels?.nodes).map((l) => l.name),
    url: issue.url,
    prs: issueNodes(issue.closedByPullRequestsReferences?.nodes).map(keyOf),
  };
}

function finished(): string[] {
  const named = listOf(loadSettings().jira.doneStatuses);
  return named.length ? named : FINISHED;
}

function inRepos(key: string): boolean {
  return matchRepo(key.slice(0, key.indexOf('#')), parseFilter(githubSettings().repos));
}

const SEARCH_BASE = 'is:issue is:open archived:false sort:updated-desc';

/** Open issues assigned to you, as Jira's are, narrowed by GitHub repos, less those the Project calls finished; each read as fully as a view, bar its body. */
export async function myIssues(limit = SEARCH_FIRST): Promise<TicketView[]> {
  const [data, on] = await Promise.all([
    graphql<{ assigned: { nodes: (GhIssue | null)[] } }>(MINE_QUERY, { assigned: `${SEARCH_BASE} assignee:@me` }),
    projectBoard(),
  ]);
  const seen = new Map<string, GhIssue>();
  for (const issue of issueNodes(data.assigned.nodes)) if (issue.repository && !seen.has(keyOf(issue))) seen.set(keyOf(issue), issue);
  const done = new Set(finished());
  return [...seen.values()]
    .map((issue) => viewOf(issue, on))
    .filter((t) => inRepos(t.key) && !done.has(t.status))
    .slice(0, limit);
}

async function readIssue(key: string): Promise<GhIssue> {
  const { owner, name, number } = partsOf(key);
  const data = await graphql<{ repository: { issue: GhIssue | null } | null }>(ISSUE_QUERY, { owner, name, number });
  const issue = data.repository?.issue;
  if (!issue) throw new Error(`GitHub has no issue ${key} that this token can read`);
  return issue;
}

/** Any issue can hold sub-issues, so each is an epic here; the moves are the Project's columns, or Open and Closed off it. */
export function viewOf(issue: GhIssue, on: Board | null): TicketView {
  const parent = issue.parent;
  return {
    ...toTicket(issue, on),
    type: 'Issue',
    epic: true,
    parent: parent ? { key: keyOf(parent), summary: parent.title, epic: true } : null,
    description: issue.body ?? '',
    transitions: itemOn(issue, on) && on ? on.options.map((o) => o.name) : [OPEN, CLOSED],
  };
}

export async function viewIssue(key: string): Promise<TicketView> {
  const [issue, on] = await Promise.all([readIssue(key), projectBoard()]);
  return viewOf(issue, on);
}

export async function findIssues(keys: string[]): Promise<Map<string, Ticket>> {
  const out = new Map<string, Ticket>();
  const wanted = [...new Set(keys.filter((key) => GITHUB_ISSUE.test(key)))];
  if (!wanted.length) return out;
  const on = await projectBoard().catch(() => null);
  for (let i = 0; i < wanted.length; i += FOUND_AT_ONCE) {
    const batch = wanted.slice(i, i + FOUND_AT_ONCE).map((key) => partsOf(key));
    const vars = batch.map((_, n) => `$o${n}: String!, $n${n}: String!, $k${n}: Int!`).join(', ');
    const asks = batch.map((_, n) => `i${n}: repository(owner: $o${n}, name: $n${n}) { issue(number: $k${n}) { ...issue } }`).join('\n  ');
    const values = Object.fromEntries(batch.flatMap((p, n) => [[`o${n}`, p.owner], [`n${n}`, p.name], [`k${n}`, p.number]]));
    const data = await graphql<Record<string, { issue: GhIssue | null } | null>>(`query Issues(${vars}) {\n  ${RATE}\n  ${asks}\n}\n${ISSUE_FIELDS}`, values).catch(() => ({}) as Record<string, null>);
    for (let n = 0; n < batch.length; n += 1) {
      const issue = data[`i${n}`]?.issue;
      if (issue) out.set(keyOf(issue), toTicket(issue, on));
    }
  }
  return out;
}

async function searchIssues(query: string, first: number): Promise<Ticket[]> {
  const [data, on] = await Promise.all([graphql<{ search: { nodes: (GhIssue | null)[] } }>(SEARCH_QUERY, { query, first }), projectBoard().catch(() => null)]);
  return issueNodes(data.search.nodes).filter((issue) => issue.repository).map((issue) => toTicket(issue, on));
}

/** Exact phrases, as with Jira, so a note id finds the issues that link its thread. */
export async function issuesMentioning(phrases: string[], limit = 5): Promise<Ticket[]> {
  const quoted = phrases.map((p) => p.replace(/["\\]/g, '').trim()).filter(Boolean).slice(0, PHRASES_AT_ONCE).map((p) => `"${p}"`);
  if (!quoted.length) return [];
  return searchIssues(`is:issue in:body ${quoted.join(' OR ')}`, limit);
}

export async function subIssues(parent: string, limit = 8): Promise<Ticket[]> {
  const { owner, name, number } = partsOf(parent);
  const [data, on] = await Promise.all([
    graphql<{ repository: { issue: { subIssues: { nodes: (GhIssue | null)[] } } | null } | null }>(CHILDREN_QUERY, { owner, name, number, last: limit }),
    projectBoard().catch(() => null),
  ]);
  return issueNodes(data.repository?.issue?.subIssues.nodes).map((issue) => toTicket(issue, on)).reverse();
}

/** The template's headings become Markdown headings; the rest is Markdown already. */
export function issueBody(text: string, headings: string[] = ticketTemplate().headings): string {
  const sections = sectionPattern(headings);
  return text.replace(/\r\n?/g, '\n').split('\n').map((line) => {
    const section = sections?.exec(line.trim())?.[1];
    return section ? `### ${section}` : line;
  }).join('\n').trim();
}

interface CreatedIssue {
  number: number;
  html_url: string;
  node_id: string;
}

/** The project is a repo, owner/repo, and a parent issue's repo wins over it; linking under the parent and onto the Project is best effort. */
export async function createIssue(ticket: NewTicket): Promise<Ticket> {
  const parent = ticket.parent ? partsOf(ticket.parent) : null;
  const repo = parent ? `${parent.owner}/${parent.name}` : ticket.project;
  if (!GITHUB_REPO.test(repo)) throw new Error(`${repo} is not a GitHub repo, which looks like acme/web`);
  const assignee = ticket.assignee === '@me' ? await viewerLogin() : ticket.assignee;
  const made = await rest<CreatedIssue>(`/repos/${repo}/issues`, {
    method: 'POST',
    body: JSON.stringify({ title: ticket.summary, body: issueBody(ticket.description), ...(assignee ? { assignees: [assignee] } : {}) }),
  });
  const key = refKey({ provider: 'github', projectPath: repo, iid: made.number });
  await Promise.allSettled([
    parent ? readIssue(ticket.parent as string).then((p) => graphql(SUB_ISSUE_MUTATION, { parent: p.id, child: made.node_id })) : null,
    projectBoard().then((on) => (on ? graphql(ADD_ITEM_MUTATION, { project: on.id, content: made.node_id }) : null)),
  ]);
  return { key, summary: ticket.summary, status: OPEN, labels: [], url: made.html_url };
}

/** On the Project the move sets its Status; off it, only Open and Closed are moves, and they open or close the issue. */
export async function moveIssue(key: string, status: string): Promise<void> {
  const { owner, name, number } = partsOf(key);
  const [issue, on] = await Promise.all([readIssue(key), projectBoard()]);
  const item = itemOn(issue, on);
  if (item && on) {
    const option = on.options.find((o) => o.name === status);
    if (!option) throw new Error(`the Project ${on.title} has no ${status} column`);
    await graphql(MOVE_MUTATION, { project: on.id, item: item.id, field: on.fieldId, option: option.id });
    return;
  }
  if (status !== OPEN && status !== CLOSED) throw new Error(`${key} is not on ${on ? `the Project ${on.title}` : 'a GitHub Project'}, so it only moves between ${OPEN} and ${CLOSED}`);
  await rest(`/repos/${owner}/${name}/issues/${number}`, { method: 'PATCH', body: JSON.stringify({ state: status === CLOSED ? 'closed' : 'open' }) });
}

const DAY = /^\d{4}-\d{2}-\d{2}$/;

/** GitHub keeps no history of a Project's Status, so the one move it can say is an issue of yours closing that day, as Closed or a finished status. */
export async function issuesClosedOn(status: string, day: string): Promise<Ticket[]> {
  if (!DAY.test(day)) throw new Error(`cannot search for ${status} on ${day}`);
  if (status !== CLOSED && !finished().includes(status)) return [];
  return searchIssues(`is:issue assignee:@me closed:${day}`, SEARCH_FIRST);
}

/** In progress is what the Project calls in progress, so without one there is nothing to go on. */
export async function issuesInProgress(): Promise<Ticket[]> {
  if (!projectRef()) throw new Error('Tickets in progress come from the Status of a GitHub Project: name one under Ticket settings');
  return (await myIssues()).filter((t) => /progress/i.test(t.status));
}

export async function issueColumns(): Promise<string[]> {
  const on = await projectBoard();
  return on ? on.options.map((o) => o.name) : [OPEN, CLOSED];
}

export const githubIssues: TicketSource = {
  id: 'github',
  name: 'GitHub',
  isKey: (key) => GITHUB_ISSUE.test(key),
  mine: (limit) => myIssues(limit),
  view: (key) => viewIssue(key),
  find: (keys) => findIssues(keys),
  mentioning: (phrases, limit) => issuesMentioning(phrases, limit),
  children: (parent, limit) => subIssues(parent, limit),
  create: (ticket) => createIssue(ticket),
  move: (key, status) => moveIssue(key, status),
  inProgress: () => issuesInProgress(),
  movedTo: (status, day) => issuesClosedOn(status, day),
  movedBy: (status, day) => issuesClosedOn(status, day),
  columns: () => issueColumns(),
  available: async () => Boolean(await githubToken()),
};
