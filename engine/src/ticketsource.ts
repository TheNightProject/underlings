import type { AcliOptions } from './data/acli.js';
import * as jira from './data/jira.js';
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
  readonly id: 'jira';
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
  available: () => jira.isAvailable(),
};

export function ticketSource(): TicketSource {
  return jiraSource;
}

export const fetchMyTickets = (limit?: number): Promise<Ticket[]> => ticketSource().mine(limit);
export const viewTicket = (key: string, options?: TicketReadOptions): Promise<TicketView> => ticketSource().view(key, options);
export const fetchTickets = (keys: string[]): Promise<Map<string, Ticket>> => ticketSource().find(keys);
export const ticketsMentioning = (phrases: string[], limit?: number): Promise<Ticket[]> => ticketSource().mentioning(phrases, limit);
export const ticketChildren = (parent: string, limit?: number): Promise<Ticket[]> => ticketSource().children(parent, limit);
export const createTicket = (ticket: NewTicket): Promise<Ticket> => ticketSource().create(ticket);
export const transitionTicket = (key: string, status: string): Promise<void> => ticketSource().move(key, status);
export const ticketsInProgress = (): Promise<Ticket[]> => ticketSource().inProgress();
export const ticketsMovedTo = (status: string, day: string): Promise<Ticket[]> => ticketSource().movedTo(status, day);
export const ticketsMovedBy = (status: string, day: string): Promise<Ticket[]> => ticketSource().movedBy(status, day);
export const isAvailable = (): Promise<boolean> => ticketSource().available();
