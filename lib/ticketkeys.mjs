// The one shape of a Jira key, kept identical to the engine's KEY_PATTERN and the page's TICKET_KEY_SOURCE.
export const KEY_PATTERN = '[A-Z][A-Z0-9]+-[1-9]\\d*';
export const TICKET_KEY = new RegExp(`^${KEY_PATTERN}$`);
const PROJECT_KEY = /^[A-Z][A-Z0-9]+$/;
const KEY_IN_TEXT = new RegExp(`\\b(${KEY_PATTERN})\\b`);

export const keysInText = () => new RegExp(`\\b(${KEY_PATTERN})\\b`, 'g');

export function firstKeyIn(text) {
  return KEY_IN_TEXT.exec(String(text ?? ''))?.[1] ?? null;
}

export function projectOf(key) {
  return key.slice(0, key.lastIndexOf('-'));
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
