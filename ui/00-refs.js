const GITLAB_KEY = /^[\w.-]+(?:\/[\w.-]+)*![1-9]\d*$/;
const GITHUB_KEY = /^[\w.-]+\/[\w.-]+#[1-9]\d*$/;
const MR_SHORT_REF = /(?<![\w/.!-])((?:[\w.-]+\/)*[\w.-]+)?!(\d+)\b/;
const PR_SHORT_REF = /(?<![\w/.#&-])((?:[\w.-]+\/)?[\w.-]+)?#(\d+)\b/;
const MR_URL_PATH = '\\/([\\w.-]+(?:\\/[\\w.-]+)+)\\/-\\/merge_requests\\/(\\d+)';
const PR_URL_PATH = '\\/([\\w.-]+\\/[\\w.-]+)\\/pull\\/(\\d+)';
let mrUrlFor = { host: null, pattern: null };
let prUrlFor = { web: null, pattern: null };

const refSeparator = (provider) => (provider === 'github' ? '#' : '!');
const keyOf = (ref) => ref.projectPath + refSeparator(ref.provider) + ref.iid;

function keyProvider(key) {
  if (typeof key !== 'string') return null;
  if (GITLAB_KEY.test(key)) return 'gitlab';
  return GITHUB_KEY.test(key) ? 'github' : null;
}

const isKey = (key) => keyProvider(key) !== null;

function keyParts(key) {
  const provider = keyProvider(key);
  if (!provider) return null;
  const at = key.lastIndexOf(refSeparator(provider));
  const ref = { projectPath: key.slice(0, at), iid: Number(key.slice(at + 1)) };
  return provider === 'github' ? { provider, ...ref } : ref;
}

const keyPath = (key) => keyParts(key)?.projectPath ?? null;

function refNumber(ref) {
  const { provider, iid } = typeof ref === 'string' ? keyParts(ref) ?? {} : ref;
  return refSeparator(provider) + iid;
}

const short = (key) => key.split('/').pop();
const forgeName = (key) => (keyProvider(key) === 'github' ? 'GitHub' : 'GitLab');

function mrUrl(ref, host = ref.provider === 'github' ? githubWeb() : gitlabHost()) {
  return host + '/' + ref.projectPath + (ref.provider === 'github' ? '/pull/' : '/-/merge_requests/') + ref.iid;
}

function mrUrlPattern() {
  const host = gitlabHost();
  if (mrUrlFor.host !== host) mrUrlFor = { host, pattern: new RegExp(regExpText(host) + MR_URL_PATH + '(?:[/?#][^\\s)>\\]]*)?') };
  return mrUrlFor.pattern;
}

function prUrlPattern() {
  const web = githubWeb();
  if (prUrlFor.web !== web) prUrlFor = { web, pattern: new RegExp(regExpText(web) + PR_URL_PATH + '(?:[/?#][^\\s)>\\]]*)?') };
  return prUrlFor.pattern;
}

// GitHub's references join the end, so every GitLab one keeps its place among the groups, and only while GitHub is on.
const githubRefSources = () => (githubShown() ? [prUrlPattern(), PR_SHORT_REF] : []);

function keyInUrl(text) {
  const m = mrUrlPattern().exec(text);
  if (m) return keyOf({ projectPath: m[1], iid: m[2] });
  const pr = githubShown() ? prUrlPattern().exec(text) : null;
  return pr && keyOf({ provider: 'github', projectPath: pr[1], iid: pr[2] });
}

function keyFromUrl(url, host = gitlabHost()) {
  const m = new RegExp('^' + regExpText(host) + MR_URL_PATH + '(?:[/?#]|$)').exec(url);
  return m && keyOf({ projectPath: m[1], iid: m[2] });
}

function githubKeyFromUrl(url, web = githubWeb()) {
  const m = new RegExp('^' + regExpText(web) + PR_URL_PATH + '(?:[/?#]|$)').exec(url);
  return m && keyOf({ provider: 'github', projectPath: m[1], iid: m[2] });
}
