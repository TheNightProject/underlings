import { ticketSourceOf } from '../../lib/ticketkeys.mjs';
import type { AcliOptions } from './data/acli.js';
import { githubIssues } from './data/github-issues.js';
import * as jira from './data/jira.js';
import { loadSettings } from './data/store.js';
import { TICKET_KEY } from './ticketkeys.js';
import type { Ticket } from './types.js';

export type TicketReadOptions = AcliOptions;

export interface TicketView extends Ticket {
  type: string;
  epic: boolean;
  parent: { key: string; summary: string; epic: boolean } | null;
  description: string;
  /** Null while the source cannot say where a ticket may move, as acli cannot. */
  transitions: string[] | null;
}

export interface NewTicket {
  project: string;
  type?: string;
  summary: string;
  /** Plain text: lines that name a section become headings and lines starting "- " a list. */
  description: string;
  parent?: string;
  /** An email, an account id, or `@me`. */
  assignee?: string;
}

/** Where tickets come from: every read and write the app makes of them goes through one of these. */
export interface TicketSource {
  readonly id: 'jira' | 'github';
  readonly name: string;
  isKey(key: string): boolean;
  mine(limit?: number): Promise<Ticket[]>;
  view(key: string, options?: TicketReadOptions): Promise<TicketView>;
  find(keys: string[]): Promise<Map<string, Ticket>>;
  mentioning(phrases: string[], limit?: number): Promise<Ticket[]>;
  children(parent: string, limit?: number): Promise<Ticket[]>;
  create(ticket: NewTicket): Promise<Ticket>;
  move(key: string, status: string): Promise<void>;
  inProgress(): Promise<Ticket[]>;
  movedTo(status: string, day: string): Promise<Ticket[]>;
  movedBy(status: string, day: string): Promise<Ticket[]>;
  /** The board's columns in order, or null for the page's own. */
  columns(): Promise<string[] | null>;
  available(): Promise<boolean>;
}

export const jiraSource: TicketSource = {
  id: 'jira',
  name: 'Jira',
  isKey: (key) => TICKET_KEY.test(key),
  mine: (limit) => jira.fetchMyTickets(limit),
  view: (key, options) => jira.viewTicket(key, options),
  find: (keys) => jira.fetchTickets(keys),
  mentioning: (phrases, limit) => jira.ticketsMentioning(phrases, limit),
  children: (parent, limit) => jira.ticketChildren(parent, limit),
  create: (ticket) => jira.createTicket(ticket),
  move: (key, status) => jira.transitionTicket(key, status),
  inProgress: () => jira.ticketsInProgress(),
  movedTo: (status, day) => jira.ticketsMovedTo(status, day),
  movedBy: (status, day) => jira.ticketsMovedBy(status, day),
  columns: () => Promise.resolve(null),
  available: () => jira.isAvailable(),
};

const SOURCES: Record<TicketSource['id'], TicketSource> = { jira: jiraSource, github: githubIssues };
const OFF: Record<string, string> = {
  chosen: 'Tickets are off under Ticket settings',
  github: 'Tickets come from GitHub Issues, and GitHub is off: switch it on in Setup',
  jira: 'No Jira site set. Add one in settings to use the ticket pane.',
};

/** The source chosen under Ticket settings, or null while tickets are off. */
export function ticketSource(): TicketSource | null {
  const chosen = ticketSourceOf(loadSettings());
  return chosen.id === 'off' ? null : SOURCES[chosen.id as TicketSource['id']];
}

function source(): TicketSource {
  const found = ticketSource();
  if (found) return found;
  throw new Error(OFF[ticketSourceOf(loadSettings()).why ?? 'chosen'] ?? OFF['chosen']);
}

export const fetchMyTickets = async (limit?: number): Promise<Ticket[]> => source().mine(limit);
export const viewTicket = async (key: string, options?: TicketReadOptions): Promise<TicketView> => source().view(key, options);
export const fetchTickets = async (keys: string[]): Promise<Map<string, Ticket>> => source().find(keys);
export const ticketsMentioning = async (phrases: string[], limit?: number): Promise<Ticket[]> => source().mentioning(phrases, limit);
export const ticketChildren = async (parent: string, limit?: number): Promise<Ticket[]> => source().children(parent, limit);
export const createTicket = async (ticket: NewTicket): Promise<Ticket> => source().create(ticket);
export const transitionTicket = async (key: string, status: string): Promise<void> => source().move(key, status);
export const ticketsInProgress = async (): Promise<Ticket[]> => source().inProgress();
export const ticketsMovedTo = async (status: string, day: string): Promise<Ticket[]> => source().movedTo(status, day);
export const ticketsMovedBy = async (status: string, day: string): Promise<Ticket[]> => source().movedBy(status, day);
export const isAvailable = async (): Promise<boolean> => source().available();
export const ticketColumns = async (): Promise<string[] | null> => source().columns();
