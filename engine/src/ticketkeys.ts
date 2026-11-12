/** The one shape of a Jira key, kept identical to lib/ticketkeys.mjs and the page's TICKET_KEY_SOURCE. */
export const KEY_PATTERN = '[A-Z][A-Z0-9]+-[1-9]\\d*';
export const TICKET_KEY = new RegExp(`^${KEY_PATTERN}$`);
export const PROJECT_KEY = /^[A-Z][A-Z0-9]+$/;
const KEY_IN_TEXT = new RegExp(`\\b(${KEY_PATTERN})\\b`);

export function firstKeyIn(text: string): string | null {
  return KEY_IN_TEXT.exec(text)?.[1] ?? null;
}

export function projectOf(key: string): string {
  return key.slice(0, key.lastIndexOf('-'));
}

export function projectList(text: string | null | undefined): string[] {
  const named = String(text ?? '').split(/[\s,]+/).map((p) => p.trim().toUpperCase());
  return [...new Set(named.filter((p) => PROJECT_KEY.test(p)))];
}
