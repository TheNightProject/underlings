/** The one shape of a Jira key, kept identical to lib/ticketkeys.mjs and the page's TICKET_KEY_SOURCE. */
export const KEY_PATTERN = '[A-Z][A-Z0-9]+-[1-9]\\d*';
export const TICKET_KEY = new RegExp(`^${KEY_PATTERN}$`);
export const PROJECT_KEY = /^[A-Z][A-Z0-9]+$/;
/** A GitHub issue as owner/repo#12, kept identical to lib/ticketkeys.mjs and the page's GITHUB_ISSUE_SOURCE. */
export const GITHUB_ISSUE_PATTERN = '[\\w.-]+\\/[\\w.-]+#[1-9]\\d*';
export const GITHUB_ISSUE = new RegExp(`^${GITHUB_ISSUE_PATTERN}$`);
export const GITHUB_REPO = /^[\w.-]+\/[\w.-]+$/;
const KEY_IN_TEXT = new RegExp(`\\b(${KEY_PATTERN})\\b`);

export function firstKeyIn(text: string): string | null {
  return KEY_IN_TEXT.exec(text)?.[1] ?? null;
}

export function projectOf(key: string): string {
  return GITHUB_ISSUE.test(key) ? key.slice(0, key.lastIndexOf('#')) : key.slice(0, key.lastIndexOf('-'));
}

export interface IssueParts {
  owner: string;
  name: string;
  number: number;
}

export function issueParts(key: string): IssueParts | null {
  if (!GITHUB_ISSUE.test(key)) return null;
  const [repo, number] = key.split('#') as [string, string];
  const [owner, name] = repo.split('/') as [string, string];
  return { owner, name, number: Number(number) };
}

export function projectList(text: string | null | undefined): string[] {
  const named = String(text ?? '').split(/[\s,]+/).map((p) => p.trim().toUpperCase());
  return [...new Set(named.filter((p) => PROJECT_KEY.test(p)))];
}
