// The one shape of a Jira key, kept identical to the engine's KEY_PATTERN and the page's TICKET_KEY_SOURCE.
export const KEY_PATTERN = '[A-Z][A-Z0-9]+-[1-9]\\d*';
export const TICKET_KEY = new RegExp(`^${KEY_PATTERN}$`);
// A GitHub issue, kept identical to the engine's GITHUB_ISSUE_PATTERN and the page's GITHUB_ISSUE_SOURCE.
export const GITHUB_ISSUE_PATTERN = '[\\w.-]+\\/[\\w.-]+#[1-9]\\d*';
export const GITHUB_ISSUE = new RegExp(`^${GITHUB_ISSUE_PATTERN}$`);
export const GITHUB_REPO = /^[\w.-]+\/[\w.-]+$/;
const PROJECT_KEY = /^[A-Z][A-Z0-9]+$/;
const KEY_IN_TEXT = new RegExp(`\\b(${KEY_PATTERN})\\b`);
const SOURCES = { jira: 'Jira', github: 'GitHub' };

export const keysInText = () => new RegExp(`\\b(${KEY_PATTERN})\\b`, 'g');
export const issuesInText = () => new RegExp(`(?<![\\w/.-])(${GITHUB_ISSUE_PATTERN})\\b`, 'g');

export function firstKeyIn(text) {
  return KEY_IN_TEXT.exec(String(text ?? ''))?.[1] ?? null;
}

export function projectOf(key) {
  return GITHUB_ISSUE.test(key) ? key.slice(0, key.lastIndexOf('#')) : key.slice(0, key.lastIndexOf('-'));
}

export function projectList(text) {
  const named = String(text ?? '').split(/[\s,]+/).map((p) => p.trim().toUpperCase());
  return [...new Set(named.filter((p) => PROJECT_KEY.test(p)))];
}

export function inProjects(key, projects) {
  return typeof key === 'string' && TICKET_KEY.test(key) && (!projects.length || projects.includes(projectOf(key)));
}

export function exampleKey(project) {
  return `${project && PROJECT_KEY.test(project) ? project : 'ABC'}-1234`;
}

/** Jira unless another is chosen, and off while the one chosen cannot be reached: Jira without a site, or GitHub switched off. */
export function ticketSourceOf(settings) {
  const chosen = settings?.tickets?.source;
  if (chosen === 'off') return { id: 'off', why: 'chosen' };
  if (chosen === 'github') return settings?.github?.on === true ? { id: 'github', name: SOURCES.github } : { id: 'off', why: 'github' };
  return String(settings?.jiraSite ?? '').trim() ? { id: 'jira', name: SOURCES.jira } : { id: 'off', why: 'jira' };
}
