import { createHash } from 'node:crypto';

const API = 'https://api.github.com';
const WEB = 'https://github.com';
const PAGE = 100;

export const emptyWorld = (viewer = 'frank-gh') => ({
  viewer: { login: viewer, name: 'Frank Foster', scopes: 'repo, read:org' },
  orgs: [],
  repos: [],
  prs: [],
  compares: {},
  files: {},
  logs: {},
  clock: () => Date.now(),
});

const sha256 = (text) => createHash('sha256').update(text).digest('hex');

/**
 * GitHub at its boundary: REST and GraphQL answered from a world, every call recorded, and any other host refused.
 * `inject` makes the next matching call fail the way GitHub fails: 401, 403 for single sign-on or limits, 429, 502.
 */
export function fakeGithub(world = emptyWorld(), { api = API, web = WEB } = {}) {
  const requests = [];
  const injected = [];
  const shape = shapes(world, web);

  async function fetch(input, init = {}) {
    const url = new URL(String(input));
    if (url.origin !== new URL(api).origin) throw new TypeError(`the fake GitHub answers only ${api}, not ${url.href}`);
    const body = bodyOf(init.body);
    const entry = { method: (init.method ?? 'GET').toUpperCase(), path: url.pathname, search: url.search, op: operationOf(body), headers: headersOf(init.headers), bearer: bearerOf(init.headers), timed: init.signal instanceof AbortSignal, body };
    requests.push(entry);
    const failure = takeFailure(entry);
    if (failure) return reply(failure.status, failure.body ?? { message: 'failed' }, { ...rateHeaders(world), ...failure.headers });
    const route = entry.path === '/graphql' ? graphqlAnswer(world, shape, entry) : restAnswer(world, shape, entry, url);
    const answer = route ?? { status: 404, body: { message: 'Not Found', documentation_url: 'https://docs.github.com/rest' } };
    return respond(answer, entry);
  }

  function takeFailure(entry) {
    const at = injected.findIndex((f) => matches(f.match, entry));
    if (at < 0) return null;
    const [failure] = injected.splice(at, 1);
    return failure;
  }

  function respond({ status = 200, body, headers = {}, text }, entry) {
    if (text !== undefined) return new Response(text, { status, headers: { 'content-type': 'text/plain', ...headers } });
    const json = JSON.stringify(body);
    const etag = entry.method === 'GET' && status === 200 ? `W/"${sha256(json).slice(0, 16)}"` : null;
    if (etag && entry.headers['if-none-match'] === etag) return new Response(null, { status: 304, headers: { etag, ...rateHeaders(world) } });
    return new Response(status === 204 ? null : json, { status, headers: { 'content-type': 'application/json', ...(etag ? { etag } : {}), ...rateHeaders(world), ...headers } });
  }

  return {
    fetch,
    requests,
    world,
    web,
    count: () => requests.length,
    inject: (match, ...failures) => injected.push(...failures.map((f) => ({ match, ...f }))),
    asked: (op) => requests.filter((r) => r.op === op),
  };
}

const matches = (match, entry) => (match.op ? entry.op === match.op : entry.path === match.path) && (!match.method || entry.method === match.method);

function operationOf(body) {
  return typeof body?.query === 'string' ? /^\s*query\s+(\w+)/.exec(body.query)?.[1] ?? 'anonymous' : null;
}

function bodyOf(raw) {
  if (typeof raw !== 'string') return null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function bearerOf(raw = {}) {
  const found = Object.entries(raw).find(([k]) => k.toLowerCase() === 'authorization');
  return found ? String(found[1]).replace(/^Bearer /, '') : null;
}

function headersOf(raw = {}) {
  const lower = Object.fromEntries(Object.entries(raw).map(([k, v]) => [k.toLowerCase(), v]));
  if (lower.authorization) lower.authorization = lower.authorization.replace(/^(\w+) .+$/, '$1 <token>');
  return lower;
}

function rateHeaders(world) {
  return { 'x-ratelimit-limit': '5000', 'x-ratelimit-remaining': '4990', 'x-ratelimit-used': '10', 'x-ratelimit-resource': 'core', 'x-ratelimit-reset': String(Math.floor(world.clock() / 1000) + 3600) };
}

function reply(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
}

function shapes(world, web) {
  const find = (path, number) => world.prs.find((p) => p.repo === path && p.number === Number(number));
  const repoOf = (path) => world.repos.find((r) => `${r.owner}/${r.name}` === path);
  const latestBy = (reviews) => {
    const last = new Map();
    for (const r of reviews) last.set(r.author, r);
    return [...last.values()];
  };
  const author = (login) => ({ login, __typename: login.endsWith('[bot]') ? 'Bot' : 'User' });
  const review = (r) => ({ state: r.state, author: { login: r.author } });
  const pr = (p) => {
    const repo = repoOf(p.repo);
    const opinionated = latestBy(p.reviews.filter((r) => r.state !== 'COMMENTED'));
    return {
      number: p.number, title: p.title, url: `${web}/${p.repo}/pull/${p.number}`, isDraft: p.isDraft ?? false, state: p.state ?? 'OPEN',
      mergeable: p.mergeable ?? 'MERGEABLE', mergeStateStatus: p.mergeStateStatus ?? 'CLEAN', reviewDecision: p.reviewDecision ?? null,
      createdAt: p.createdAt, updatedAt: p.updatedAt, headRefName: p.headRefName, headRefOid: p.headRefOid,
      totalCommentsCount: p.comments.length + p.threads.reduce((n, t) => n + t.comments.length, 0),
      author: author(p.author),
      repository: { databaseId: repo.databaseId, nameWithOwner: p.repo, name: repo.name },
      autoMergeRequest: p.autoMerge ? { enabledAt: p.updatedAt } : null,
      reviews: { totalCount: p.reviews.length },
      reviewThreads: { nodes: p.threads.map((t) => ({ isResolved: t.isResolved })) },
      reviewRequests: { nodes: p.requested.map((login) => ({ requestedReviewer: { __typename: 'User', login } })) },
      latestOpinionatedReviews: { nodes: opinionated.map(review) },
      latestReviews: { nodes: latestBy(p.reviews).map(review) },
      commits: { nodes: [{ commit: { statusCheckRollup: p.rollup ? { state: p.rollup } : null, checkSuites: { nodes: (p.runs ?? []).map((databaseId) => ({ workflowRun: { databaseId } })) } } }] },
    };
  };
  return { find, repoOf, pr };
}

const rate = (world) => ({ cost: 1, remaining: 4990, resetAt: new Date(world.clock() + 3_600_000).toISOString() });

function graphqlAnswer(world, shape, { op, body }) {
  const v = body.variables ?? {};
  const open = world.prs.filter((p) => (p.state ?? 'OPEN') === 'OPEN');
  const answers = {
    Viewer: () => ({ viewer: { login: world.viewer.login } }),
    ViewerName: () => ({ viewer: { name: world.viewer.name } }),
    Involved: () => involved(world, shape, v, open),
    RepoPrs: () => repoPrs(shape, v, open),
    Orgs: () => ({ viewer: { login: world.viewer.login, organizations: { nodes: world.orgs.map((login) => ({ login })) } } }),
    OwnerRepos: () => ownerRepos(world, v),
    Pr: () => ({ repository: onePr(shape, v, (p) => shape.pr(p)) }),
    PrEnd: () => ({ repository: onePr(shape, v, (p) => ({ state: p.state ?? 'OPEN', mergedBy: p.mergedBy ? { login: p.mergedBy } : null })) }),
    PrDetail: () => ({ repository: onePr(shape, v, (p) => ({ body: p.body ?? null, baseRefName: p.baseRefName ?? 'main', changedFiles: p.files.length, totalCommentsCount: shape.pr(p).totalCommentsCount })) }),
    PrBranch: () => ({ repository: onePr(shape, v, (p) => ({ baseRefName: p.baseRefName ?? 'main', headRefOid: p.headRefOid })) }),
    PrThreads: () => ({ repository: onePr(shape, v, (p) => threadsOf(p)) }),
    PrChecks: () => ({ repository: checksOf(world, shape, v) }),
  };
  const make = answers[op];
  if (!make) return { status: 200, body: { errors: [{ message: `the fake GitHub has no query named ${op}` }] } };
  return { body: { data: { rateLimit: rate(world), ...make() } } };
}

const TERMS = {
  'review-requested:@me': (p, me) => p.requested.includes(me) || p.requestedViaTeam === true,
  'author:@me': (p, me) => p.author === me,
  'assignee:@me': (p, me) => (p.assignees ?? []).includes(me),
  'mentions:@me': (p, me) => (p.mentions ?? []).includes(me),
};

function involved(world, shape, v, open) {
  const me = world.viewer.login;
  const out = { viewer: { login: me } };
  for (const name of ['requested', 'authored', 'assigned', 'mentioned']) {
    const text = String(v[name] ?? '');
    const term = Object.keys(TERMS).find((t) => text.endsWith(t));
    const required = ['is:pr', 'is:open', 'archived:false'].every((w) => text.includes(w));
    const hits = required && term ? open.filter((p) => TERMS[term](p, me)) : [];
    out[name] = { issueCount: hits.length, nodes: hits.slice(0, 50).map(shape.pr) };
  }
  return out;
}

function repoPrs(shape, v, open) {
  const out = {};
  for (let n = 0; v[`o${n}`] !== undefined; n += 1) {
    const path = `${v[`o${n}`]}/${v[`n${n}`]}`;
    out[`r${n}`] = shape.repoOf(path) ? { pullRequests: { nodes: open.filter((p) => p.repo === path).map(shape.pr) } } : null;
  }
  return out;
}

function ownerRepos(world, v) {
  const owned = world.repos.filter((r) => r.owner === v.login).sort((a, b) => b.pushedAt.localeCompare(a.pushedAt));
  const size = world.pageSize ?? PAGE;
  const from = v.cursor ? Number(v.cursor) : 0;
  const page = owned.slice(from, from + size);
  const more = from + size < owned.length;
  const count = (r) => world.prs.filter((p) => p.repo === `${r.owner}/${r.name}` && (p.state ?? 'OPEN') === 'OPEN').length;
  const nodes = page.map((r) => ({ nameWithOwner: `${r.owner}/${r.name}`, name: r.name, pushedAt: r.pushedAt, pullRequests: { totalCount: count(r) } }));
  if (!world.repos.some((r) => r.owner === v.login) && !world.orgs.includes(v.login) && v.login !== world.viewer.login) return { repositoryOwner: null };
  return { repositoryOwner: { repositories: { pageInfo: { hasNextPage: more, endCursor: more ? String(from + size) : null }, nodes } } };
}

function onePr(shape, v, pick) {
  const found = shape.find(`${v.owner}/${v.name}`, v.number);
  if (!shape.repoOf(`${v.owner}/${v.name}`)) return null;
  return { pullRequest: found ? pick(found) : null };
}

function threadsOf(p) {
  const comment = (c) => ({ databaseId: c.id, body: c.body, createdAt: c.createdAt, author: { login: c.author, __typename: c.author.endsWith('[bot]') ? 'Bot' : 'User' } });
  return {
    reviewThreads: { nodes: p.threads.map((t) => ({ id: t.id, isResolved: t.isResolved, path: t.path, line: t.line ?? null, originalLine: t.originalLine ?? t.line ?? null, diffSide: t.side ?? 'RIGHT', comments: { nodes: t.comments.map((c) => ({ ...comment(c), originalCommit: { oid: t.commit ?? p.headRefOid } })) } })) },
    reviews: { nodes: p.reviews.map((r) => ({ ...comment({ ...r, body: r.body ?? '' }), databaseId: r.id, state: r.state })) },
    comments: { nodes: p.comments.map(comment) },
  };
}

function checksOf(world, shape, v) {
  const found = shape.find(`${v.owner}/${v.name}`, v.number);
  if (!found) return null;
  const run = (c) => ({
    __typename: 'CheckRun', databaseId: c.id, name: c.name, status: c.status ?? 'COMPLETED', conclusion: c.conclusion ?? null, startedAt: c.startedAt ?? null, completedAt: c.completedAt ?? null,
    detailsUrl: c.detailsUrl ?? null, isRequired: c.required ?? false,
    checkSuite: { app: { name: c.app ?? 'GitHub Actions', slug: c.slug ?? 'github-actions' }, workflowRun: c.runId ? { databaseId: c.runId, workflow: { name: c.workflow } } : null },
  });
  const status = (s) => ({ __typename: 'StatusContext', id: s.id, context: s.context, state: s.state, targetUrl: s.targetUrl ?? null, createdAt: s.createdAt, isRequired: s.required ?? false, creator: s.creator ? { login: s.creator } : null });
  const nodes = [...(found.checks ?? []).map(run), ...(found.statuses ?? []).map(status)];
  return { object: v.sha === found.headRefOid ? { statusCheckRollup: nodes.length ? { contexts: { nodes } } : null } : null };
}

function restAnswer(world, shape, { method, path }, url) {
  if (method !== 'GET') return null;
  if (path === '/user') return userAnswer(world);
  const parts = path.split('/').filter(Boolean);
  if (parts[0] !== 'repos' || parts.length < 4) return null;
  const repo = `${parts[1]}/${parts[2]}`;
  const [kind, id, tail] = [parts[3], parts[4], parts[5]];
  if (!shape.repoOf(repo)) return null;
  if (kind === 'pulls' && tail === 'files') return filesAnswer(shape, repo, id, url);
  if (kind === 'compare') return compareAnswer(world, repo, decodeURIComponent(parts.slice(4).join('/')));
  if (kind === 'contents') return contentsAnswer(world, repo, parts.slice(4).map(decodeURIComponent).join('/'), url.searchParams.get('ref'));
  if (kind === 'actions' && id === 'jobs' && parts[6] === 'logs') return logAnswer(world, parts[5]);
  return null;
}

function userAnswer(world) {
  const { login, scopes } = world.viewer;
  if (world.viewer.sso) return { status: 403, body: { message: 'Resource protected by organization SAML enforcement.' }, headers: { 'x-github-sso': `required; url=${world.viewer.sso}` } };
  return { body: { login, id: 4242, type: 'User' }, headers: scopes === null ? {} : { 'x-oauth-scopes': scopes, 'x-accepted-oauth-scopes': '' } };
}

function filesAnswer(shape, repo, number, url) {
  const found = shape.find(repo, number);
  if (!found) return null;
  const per = Number(url.searchParams.get('per_page') ?? 30);
  const page = Number(url.searchParams.get('page') ?? 1);
  const files = found.files.slice((page - 1) * per, page * per).map((f) => ({ sha: sha256(f.filename).slice(0, 40), filename: f.filename, status: f.status ?? 'modified', additions: 1, deletions: 0, changes: 1, ...(f.previous ? { previous_filename: f.previous } : {}), ...(f.patch === undefined ? {} : { patch: f.patch }) }));
  return { body: files };
}

function compareAnswer(world, repo, range) {
  const known = world.compares[`${repo}:${range}`];
  if (known) return { body: known };
  return { body: { status: 'ahead', ahead_by: 1, behind_by: 0, total_commits: 1, files: [] } };
}

function contentsAnswer(world, repo, path, ref) {
  const text = world.files[`${repo}@${ref}:${path}`];
  return text === undefined ? null : { text };
}

function logAnswer(world, jobId) {
  const text = world.logs[jobId];
  return text === undefined ? null : { text };
}
