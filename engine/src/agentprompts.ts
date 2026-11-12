import type { Checkout } from './checkouts.js';
import { loadSettings } from './data/store.js';
import { skillCommand } from './plugin.js';
import type { AgentCommands } from './settings.js';
import { styleLines } from './style.js';

export const QUEUE_TOOL = 'queue_findings';
export const FINISH_TOOL = 'finish_review';
export const REVIEW_SKILL = skillCommand('review');
export const SELF_REVIEW_SKILL = skillCommand('pre-mr-review');
export const KICKOFF_SKILL = skillCommand('kickoff');
const CHECKOUTS_LISTED = 40;

export function agentCommands(): AgentCommands {
  const { agents } = loadSettings();
  const read = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
  return { reviewCommand: read(agents.reviewCommand), selfReviewCommand: read(agents.selfReviewCommand), kickoffCommand: read(agents.kickoffCommand) };
}

/** One line, as the Orca fallback types it into a terminal where a newline submits early. */
export function reviewLine(webUrl: string): string {
  const { reviewCommand } = agentCommands();
  return reviewCommand ? `${reviewCommand} ${webUrl}` : [REVIEW_SKILL, webUrl, ...styleLines('each finding')].join(' ');
}

export function finishLine(passId: string): string {
  return `When you have finished, call the ${FINISH_TOOL} tool with pass ${passId}`;
}

export function selfReviewCommand(): string {
  return agentCommands().selfReviewCommand || SELF_REVIEW_SKILL;
}

function checkoutLines(checkouts: Checkout[], root: string): string[] {
  if (!checkouts.length) return [];
  const shown = checkouts.slice(0, CHECKOUTS_LISTED).map((c) => `- ${c.dir}${c.path ? ` (${c.path})` : ''}`);
  const more = checkouts.length - shown.length;
  return [`The checkouts under ${root}:`, ...shown, ...(more > 0 ? [`- and ${more} more`] : [])];
}

/** The skill finds the repo and cuts the worktree itself; the checkouts and the writing rules are what only the app knows. */
export function kickoffLine(key: string, checkouts: Checkout[], root: string): string {
  const { kickoffCommand } = agentCommands();
  if (kickoffCommand) return `${kickoffCommand} ${key}`;
  return [`${KICKOFF_SKILL} ${key}`, ...checkoutLines(checkouts, root), ...styleLines('commit messages, code comments and the merge request')].join('\n');
}
