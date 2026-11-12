export const GITLAB_KEY_TEXT = '[\\w.-]+(?:\\/[\\w.-]+)*![1-9]\\d*';
export const GITLAB_KEY = new RegExp(`^${GITLAB_KEY_TEXT}$`);
export const GITHUB_KEY = /^[\w.-]+\/[\w.-]+#[1-9]\d*$/;
export const ANY_KEY = new RegExp(`^(?:${GITLAB_KEY.source.slice(1, -1)}|${GITHUB_KEY.source.slice(1, -1)})$`);
const GITLAB_URLS = /https?:\/\/[\w.-]+(?::\d+)?\/([\w.-]+(?:\/[\w.-]+)+)\/-\/merge_requests\/(\d+)/g;
const GITHUB_URLS = /https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)/g;

const separator = (provider) => (provider === 'github' ? '#' : '!');

export const keyOf = (ref) => `${ref.projectPath}${separator(ref.provider)}${ref.iid}`;

// Project ids repeat across providers, so a join on ids keeps the separator that tells them apart.
export const idKey = (ref) => `${ref.projectId}${separator(ref.provider)}${ref.iid}`;

function keyProvider(key) {
  if (typeof key !== 'string') return null;
  if (GITLAB_KEY.test(key)) return 'gitlab';
  return GITHUB_KEY.test(key) ? 'github' : null;
}

export const isKey = (key) => keyProvider(key) !== null;

// A GitLab key parses with no provider, as every record written before GitHub has none, so it round-trips to what it was built from.
export function keyParts(key) {
  const provider = keyProvider(key);
  if (!provider) return null;
  const at = key.lastIndexOf(separator(provider));
  const ref = { projectPath: key.slice(0, at), iid: Number(key.slice(at + 1)) };
  return provider === 'github' ? { provider, ...ref } : ref;
}

export const keyPath = (key) => keyParts(key)?.projectPath ?? null;

export function refNumber(ref) {
  const { provider, iid } = typeof ref === 'string' ? keyParts(ref) ?? {} : ref;
  return `${separator(provider)}${iid}`;
}

export const shortKey = (key) => key.split('/').pop();

export function mrUrl(ref, host) {
  const path = ref.provider === 'github' ? 'pull' : '-/merge_requests';
  return `${host}/${ref.projectPath}/${path}/${ref.iid}`;
}

export function keysInText(text) {
  const found = [
    ...[...text.matchAll(GITLAB_URLS)].map((m) => ({ at: m.index, key: keyOf({ projectPath: m[1], iid: m[2] }) })),
    ...[...text.matchAll(GITHUB_URLS)].map((m) => ({ at: m.index, key: keyOf({ provider: 'github', projectPath: m[1], iid: m[2] }) })),
  ];
  return found.sort((a, b) => a.at - b.at).map((f) => f.key);
}

// Only GitHub's # needs escaping in a page hash, so a GitLab key reads there exactly as before.
export const inHash = (target) => target.replaceAll('#', '%23');
