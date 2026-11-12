import { loadSettings } from './data/store.js';
import type { Mood } from './pulse.js';
import { listOf } from './settings.js';
import type { AgentState } from './review.js';
import type { Mr, ReviewRun, Ticket } from './types.js';

/** Where a ticket has got to, from Jira, the agent host and GitLab; an MR wins when there is one, as the furthest the work has got. */
export type TicketPhase =
  | 'none'
  | 'starting'
  | 'working'
  | 'idle'
  | 'stalled'
  | 'draft'
  | 'open'
  | 'approved';

export interface TicketBadge {
  phase: TicketPhase;
  glyph: string;
  /** Emoji occupy two terminal cells whatever their code-unit length. */
  width: number;
  colour: string;
  label: string;
}

const BADGES: Record<TicketPhase, Omit<TicketBadge, 'phase'>> = {
  none: { glyph: '  ', width: 2, colour: 'gray', label: '' },
  // All of these sit above U+FFFF and carry no variation selector. A BMP emoji measures
  // as one cell and a surrogate pair as two, so mixing the two shifts whole rows sideways.
  starting: { glyph: '🚀', width: 2, colour: 'cyan', label: 'workspace starting' },
  working: { glyph: '🔄', width: 2, colour: 'yellow', label: 'agent working' },
  idle: { glyph: '👋', width: 2, colour: 'magenta', label: 'agent stopped, wants you' },
  stalled: { glyph: '🚫', width: 2, colour: 'red', label: 'agent gone, nothing raised' },
  draft: { glyph: '📄', width: 2, colour: 'cyan', label: 'draft MR raised' },
  open: { glyph: '👀', width: 2, colour: 'blue', label: 'MR open for review' },
  approved: { glyph: '🟢', width: 2, colour: 'green', label: 'MR approved' },
};

/** The MR this ticket produced, if the work got that far. */
export function mrForTicket(ticket: Ticket, mrs: Mr[]): Mr | undefined {
  return mrs.find((mr) => mr.ticket === ticket.key);
}

/** Nothing has happened yet unless a run was recorded, so "started" means exactly that. */
export function ticketPhase(
  ticket: Ticket,
  mrs: Mr[],
  agents: Map<string, AgentState>,
  run: ReviewRun | undefined,
  me?: string,
): { phase: TicketPhase; mr?: Mr } {
  const mr = mrForTicket(ticket, mrs);
  if (mr) {
    if (me && mr.approvedBy.includes(me)) return { phase: 'approved', mr };
    return { phase: mr.draft ? 'draft' : 'open', mr };
  }

  const agent = run?.terminal ? agents.get(run.terminal) : undefined;
  if (agent?.alive && agent.working) return { phase: 'working' };
  if (agent?.alive) return { phase: 'idle' };
  if (!run) return { phase: 'none' };
  // A run with no output yet is still spinning up, not dead.
  return (run.tail?.length ?? 0) === 0 ? { phase: 'starting' } : { phase: 'stalled' };
}

export function ticketBadge(phase: TicketPhase): TicketBadge {
  return { ...BADGES[phase], phase };
}

/**
 * The same palette the MR list uses, so one glance reads the same in both panes: moving
 * means it wants you, still means it is settled.
 */
const MOODS: Record<TicketPhase, Mood> = {
  none: 'unreviewed',
  starting: 'reviewing',
  working: 'reviewing',
  idle: 'awaitingYou',
  stalled: 'awaitingYou',
  draft: 'reviewed',
  open: 'reviewed',
  approved: 'approved',
};

export function ticketMood(phase: TicketPhase): Mood {
  return MOODS[phase];
}

export const TICKET_LEGEND: TicketBadge[] = (
  ['starting', 'working', 'idle', 'stalled', 'draft', 'open', 'approved'] as TicketPhase[]
).map(ticketBadge);

/** Journal keys are shared with reviews, so a ticket's has to be unmistakable. */
export function ticketKey(key: string): string {
  return `ticket:${key}`;
}

const UNKNOWN_STATUS = 'Unknown';

/** acli cannot list the legal transitions, so offer every status seen on your board, busiest first, and let Jira refuse the rest. */
export function statusChoices(tickets: Ticket[], current: string): string[] {
  const counts = new Map<string, number>();
  for (const t of tickets) counts.set(t.status, (counts.get(t.status) ?? 0) + 1);
  counts.delete(current);
  return [...counts.entries()].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([s]) => s);
}

/** A ticket's own transitions when acli says them, else every status you named and then each one your tickets are in; Jira refuses the rest. */
export function moveTargets(current: string, seen: string[] = [], transitions: string[] | null = null, named = listOf(loadSettings().jira.statuses)): string[] {
  const offered = transitions ?? [...named, ...seen.filter((status) => status !== UNKNOWN_STATUS)];
  return [...new Set(offered)].filter((status) => status !== current);
}
