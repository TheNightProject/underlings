import { createHash } from 'node:crypto';

const API = 'https://api.github.com';
const WEB = 'https://github.com';
const PAGE = 100;

export const emptyWorld = (viewer = 'frank-gh') => ({
  viewer: { login: viewer, name: 'Frank Foster', scopes: 'repo, read:org' },
  orgs: [],
  repos: [],
  prs: [],
  issues: [],
  projects: [],
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
    const route = entry.path === '/graphql' ? graphqlAnswer(world, shape, entry) : entry.method === 'GET' ? restAnswer(world, shape, entry, url) : writeAnswer(world, shape, entry);
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
  return typeof body?.query === 'string' ? /^\s*(?:query|mutation)\s+(\w+)/.exec(body.query)?.[1] ?? 'anonymous' : null;
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

const latestBy = (reviews) => {
  const last = new Map();
  for (const r of reviews) last.set(r.author, r);
  return [...last.values()];
};

function shapes(world, web) {
  const find = (path, number) => world.prs.find((p) => p.repo === path && p.number === Number(number));
  const repoOf = (path) => world.repos.find((r) => `${r.owner}/${r.name}` === path);
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
  const issue = (i) => ({
    id: issueId(i), number: i.number, title: i.title, url: `${web}/${i.repo}/issues/${i.number}`, state: i.state ?? 'OPEN', body: i.body ?? '',
    repository: { nameWithOwner: i.repo },
    labels: { nodes: (i.labels ?? []).map((name) => ({ name })) },
    parent: parentOf(world, i),
    projectItems: { nodes: world.projects.flatMap((p) => p.items.filter((it) => it.issue === issueKey(i)).map((it) => ({ id: it.id, project: { id: p.id }, status: it.status ? { name: it.status } : null }))) },
    closedByPullRequestsReferences: { nodes: (i.closedBy ?? []).map((key) => ({ number: Number(key.split('#')[1]), repository: { nameWithOwner: key.split('#')[0] } })) },
  });
  return { find, repoOf, pr, issue, world };
}

const issueKey = (i) => `${i.repo}#${i.number}`;
const issueId = (i) => `I_${i.repo.replace(/\W/g, '_')}_${i.number}`;

function parentOf(world, i) {
  const parent = i.parent ? world.issues.find((p) => issueKey(p) === i.parent) : null;
  return parent ? { number: parent.number, title: parent.title, repository: { nameWithOwner: parent.repo } } : null;
}

const rate = (world) => ({ cost: 1, remaining: 4990, resetAt: new Date(world.clock() + 3_600_000).toISOString() });

const PROJECT_FIELDS = /\bprojectItems\b|\bprojectV2\b/;

/** As GitHub does for a classic token: Project fields need read:project, whatever else it may do. */
function scopeRefusal(world, query) {
  if (!world.viewer.enforceScopes || /\b(read:)?project\b/.test(world.viewer.scopes ?? '') || !PROJECT_FIELDS.test(query ?? '')) return null;
  const message = `Your token has not been granted the required scopes to execute this query. The 'id' field requires one of the following scopes: ['read:project'], but your token has only been granted the: [${(world.viewer.scopes ?? '').split(/,\s*/).map((x) => `'${x}'`).join(', ')}] scopes.`;
  return { status: 200, body: { data: null, errors: [{ type: 'INSUFFICIENT_SCOPES', message }] } };
}

function graphqlAnswer(world, shape, { op, body }) {
  const refused = scopeRefusal(world, body.query);
  if (refused) return refused;
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
    PrNode: () => ({ repository: onePr(shape, v, (p) => ({ id: prId(p), headRefOid: p.headRefOid })) }),
    PrMerge: () => ({ repository: mergeFacts(shape, v) }),
    MyIssues: () => ({ assigned: issueSearch(world, shape, v.assigned) }),
    IssueSearch: () => ({ search: issueSearch(world, shape, v.query, v.first) }),
    Issue: () => ({ repository: oneIssue(shape, v.owner, v.name, v.number, shape.issue) }),
    Issues: () => manyIssues(shape, v),
    SubIssues: () => ({ repository: oneIssue(shape, v.owner, v.name, v.number, (i) => ({ subIssues: { nodes: world.issues.filter((c) => c.parent === issueKey(i)).slice(-v.last).map(shape.issue) } })) }),
    ProjectBoard: () => projectBoard(world, v),
    MoveItem: () => moveItem(world, v),
    AddItem: () => addItem(world, v),
    AddSubIssue: () => addSubIssue(world, v),
  };
  const make = answers[op] ?? mutations(world, shape, v)[op];
  if (!make) return { status: 200, body: { errors: [{ message: `the fake GitHub has no query named ${op}` }] } };
  let data;
  try {
    data = make();
  } catch (err) {
    return { body: { data: null, errors: [{ type: 'NOT_FOUND', message: err.message }] } };
  }
  if (data instanceof Refusal) return { body: { data: { [data.field]: null }, errors: [{ type: data.type, message: data.message }] } };
  return { body: { data: { rateLimit: rate(world), ...data } } };
}

class Refusal {
  constructor(field, message, type = 'UNPROCESSABLE') {
    Object.assign(this, { field, message, type });
  }
}

const now = (world) => new Date(world.clock()).toISOString();
const nextId = (world) => {
  world.nextId = (world.nextId ?? 90_000) + 1;
  return world.nextId;
};

function threadById(world, id) {
  for (const p of world.prs) {
    const thread = p.threads.find((t) => t.id === id);
    if (thread) return { p, thread };
  }
  return null;
}

/** Every comment GitHub files on a line sits in a review of its own, as a lone comment or a reply does. */
function fileReview(world, p, state, body = '') {
  const review = { id: nextId(world), author: world.viewer.login, state, body, createdAt: now(world) };
  p.reviews.push(review);
  p.requested = p.requested.filter((login) => login !== world.viewer.login);
  decide(p);
  return review;
}

// Only a pull request whose repo asks for reviews has a decision, as on GitHub.
function decide(p) {
  if (p.reviewDecision == null) return;
  const latest = latestBy(p.reviews.filter((r) => r.state !== 'COMMENTED' && r.state !== 'DISMISSED'));
  p.reviewDecision = latest.some((r) => r.state === 'CHANGES_REQUESTED') ? 'CHANGES_REQUESTED' : latest.some((r) => r.state === 'APPROVED') ? 'APPROVED' : 'REVIEW_REQUIRED';
}

const prId = (p) => `PR_fake_${p.repo}_${p.number}`;
const METHODS = ['MERGE', 'SQUASH', 'REBASE'];
const methodsOf = (repo) => repo.methods ?? METHODS;

function mergeFacts(shape, v) {
  const repo = shape.repoOf(`${v.owner}/${v.name}`);
  if (!repo) return null;
  const found = shape.find(`${v.owner}/${v.name}`, v.number);
  const allowed = methodsOf(repo);
  return {
    viewerDefaultMergeMethod: repo.defaultMethod ?? allowed[0], mergeCommitAllowed: allowed.includes('MERGE'), squashMergeAllowed: allowed.includes('SQUASH'), rebaseMergeAllowed: allowed.includes('REBASE'),
    pullRequest: found ? { id: prId(found) } : null,
  };
}

function ownMutations(world, shape, v) {
  const pr = (field) => {
    const found = world.prs.find((p) => prId(p) === v.pr);
    return found ?? new Refusal(field, `Could not resolve to a node with the global id of '${v.pr}'`, 'NOT_FOUND');
  };
  const autoMerge = () => {
    const p = pr('enablePullRequestAutoMerge');
    if (p instanceof Refusal) return p;
    const repo = shape.repoOf(p.repo);
    if (repo.autoMergeAllowed === false) return new Refusal('enablePullRequestAutoMerge', 'Auto merge is not allowed for this repository');
    if (v.head !== p.headRefOid) return new Refusal('enablePullRequestAutoMerge', 'Head sha didn\'t match expected head sha');
    if (!methodsOf(repo).includes(v.method)) return new Refusal('enablePullRequestAutoMerge', `${v.method.toLowerCase()} merges are not allowed on this repository`);
    if ((p.mergeStateStatus ?? 'CLEAN') === 'CLEAN') return new Refusal('enablePullRequestAutoMerge', 'Pull request is in clean status');
    p.autoMerge = { method: v.method };
    return { enablePullRequestAutoMerge: { pullRequest: { autoMergeRequest: { enabledAt: now(world) } } } };
  };
  const cancel = () => {
    const p = pr('disablePullRequestAutoMerge');
    if (p instanceof Refusal) return p;
    p.autoMerge = null;
    return { disablePullRequestAutoMerge: { pullRequest: { autoMergeRequest: null } } };
  };
  const ready = () => {
    const p = pr('markPullRequestReadyForReview');
    if (p instanceof Refusal) return p;
    p.isDraft = false;
    return { markPullRequestReadyForReview: { pullRequest: { isDraft: false } } };
  };
  return { PrAutoMerge: autoMerge, PrCancelAutoMerge: cancel, PrReady: ready };
}

function mutations(world, shape, v) {
  const missing = (field, id) => new Refusal(field, `Could not resolve to a node with the global id of '${id}'`, 'NOT_FOUND');
  const reply = () => {
    const found = threadById(world, v.thread);
    if (!found) return missing('addPullRequestReviewThreadReply', v.thread);
    const id = nextId(world);
    found.thread.comments.push({ id, author: world.viewer.login, body: v.body, createdAt: now(world) });
    fileReview(world, found.p, 'COMMENTED');
    return { addPullRequestReviewThreadReply: { comment: { id: `PRRC_${id}` } } };
  };
  const resolving = (field, isResolved) => () => {
    const found = threadById(world, v.thread);
    if (!found) return missing(field, v.thread);
    found.thread.isResolved = isResolved;
    return { [field]: { thread: { isResolved } } };
  };
  return { PrReply: reply, PrResolve: resolving('resolveReviewThread', true), PrUnresolve: resolving('unresolveReviewThread', false), ...ownMutations(world, shape, v) };
}

const unprocessable = (message) => ({ status: 422, body: { message: 'Unprocessable Entity', errors: [message], documentation_url: 'https://docs.github.com/rest' } });

/** The lines a patch shows on each side, as GitHub checks a comment's line against them. */
function diffLines(patch) {
  const sides = { LEFT: new Set(), RIGHT: new Set() };
  let left = 0;
  let right = 0;
  for (const line of (patch ?? '').split('\n')) {
    const hunk = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) [left, right] = [Number(hunk[1]), Number(hunk[2])];
    else if (line.startsWith('+')) sides.RIGHT.add(right++);
    else if (line.startsWith('-')) sides.LEFT.add(left++);
    else if (!line.startsWith('\\') && (left || right)) {
      sides.LEFT.add(left++);
      sides.RIGHT.add(right++);
    }
  }
  return sides;
}

function writeAnswer(world, shape, { method, path, body }) {
  const issue = issueWrite(world, shape, method, path, body);
  if (issue) return issue;
  const parts = path.split('/').filter(Boolean);
  if (parts[0] !== 'repos' || parts.length < 6) return null;
  const repo = `${parts[1]}/${parts[2]}`;
  if (parts[3] === 'actions' && shape.repoOf(repo)) return rerunAnswer(world, repo, method, parts.slice(4));
  const p = shape.repoOf(repo) && shape.find(repo, parts[4]);
  if (!p) return null;
  const route = `${method} ${parts[3]}/${parts.slice(5).map((part, n) => (n === 1 && /^\d+$/.test(part) ? ':id' : part)).join('/')}`;
  const writes = {
    'POST issues/comments': () => issueComment(world, p, body),
    'POST pulls/comments': () => lineComment(world, p, body),
    'POST pulls/reviews': () => submitReview(world, p, body),
    'PUT pulls/reviews/:id/dismissals': () => dismissReview(world, p, Number(parts[6]), body),
    'PUT pulls/merge': () => mergeAnswer(world, shape, p, body),
    'PUT pulls/update-branch': () => updateBranch(world, p, body),
    'POST pulls/requested_reviewers': () => askReviewers(p, body, (asked) => [...new Set([...p.requested, ...asked])]),
    'DELETE pulls/requested_reviewers': () => askReviewers(p, body, (dropped) => p.requested.filter((login) => !dropped.includes(login))),
  };
  return writes[route]?.() ?? null;
}

function issueComment(world, p, body) {
  if (!body?.body) return unprocessable('Body cannot be blank');
  const id = nextId(world);
  p.comments.push({ id, author: world.viewer.login, body: body.body, createdAt: now(world) });
  return { status: 201, body: { id, node_id: `IC_${id}`, body: body.body } };
}

function lineComment(world, p, body) {
  if (body?.commit_id !== p.headRefOid) return unprocessable('commit_id is not part of the pull request');
  const file = p.files.find((f) => f.filename === body.path);
  if (!file || !diffLines(file.patch)[body.side ?? 'RIGHT'].has(body.line)) return unprocessable('pull_request_review_thread.line must be part of the diff');
  const id = nextId(world);
  const review = fileReview(world, p, 'COMMENTED');
  p.threads.push({ id: `PRRT_fake${id}`, isResolved: false, path: body.path, line: body.line, side: body.side ?? 'RIGHT', commit: body.commit_id, comments: [{ id, author: world.viewer.login, body: body.body, createdAt: now(world) }] });
  return { status: 201, body: { id, node_id: `PRRC_${id}`, pull_request_review_id: review.id, path: body.path, line: body.line } };
}

const EVENTS = { APPROVE: 'APPROVED', REQUEST_CHANGES: 'CHANGES_REQUESTED', COMMENT: 'COMMENTED' };

function submitReview(world, p, body) {
  const state = EVENTS[body?.event];
  if (!state) return unprocessable('event is not one of APPROVE, REQUEST_CHANGES or COMMENT');
  if (state !== 'COMMENTED' && p.author === world.viewer.login) return unprocessable(`Can not ${state === 'APPROVED' ? 'approve' : 'request changes on'} your own pull request`);
  if (state !== 'APPROVED' && !body.body) return unprocessable(`Body is required for ${body.event}`);
  const review = fileReview(world, p, state, body.body ?? '');
  return { body: restReview(review) };
}

function dismissReview(world, p, id, body) {
  const review = p.reviews.find((r) => r.id === id);
  if (!review) return null;
  if (!body?.message) return unprocessable('message is required');
  if (review.state !== 'APPROVED' && review.state !== 'CHANGES_REQUESTED') return unprocessable('Can not dismiss a commented pull request review');
  review.state = 'DISMISSED';
  review.dismissal = body.message;
  decide(p);
  return { body: restReview(review) };
}

const MERGEABLE = new Set(['CLEAN', 'UNSTABLE', 'HAS_HOOKS']);

function mergeAnswer(world, shape, p, body) {
  const repo = shape.repoOf(p.repo);
  const method = String(body?.merge_method ?? 'merge').toUpperCase();
  if (body?.sha && body.sha !== p.headRefOid) return { status: 409, body: { message: 'Head branch was modified. Review and try the merge again.' } };
  if (!methodsOf(repo).includes(method)) return { status: 405, body: { message: `${method === 'MERGE' ? 'Merge commits are' : `${method.toLowerCase()} merges are`} not allowed on this repository.` } };
  if ((p.state ?? 'OPEN') !== 'OPEN' || p.isDraft || !MERGEABLE.has(p.mergeStateStatus ?? 'CLEAN')) return { status: 405, body: { message: 'Pull Request is not mergeable' } };
  Object.assign(p, { state: 'MERGED', mergedBy: world.viewer.login, mergedWith: method });
  return { body: { sha: sha256(`${p.headRefOid}merged`).slice(0, 40), merged: true, message: 'Pull Request successfully merged' } };
}

/** GitHub merges the target in later; the fake does it at once, so the head has moved by the next read. */
function updateBranch(world, p, body) {
  if (body?.expected_head_sha && body.expected_head_sha !== p.headRefOid) return unprocessable('expected head sha didn\'t match current head ref.');
  if (p.mergeable === 'CONFLICTING') return unprocessable('merge conflict between base and head');
  if (p.mergeStateStatus !== 'BEHIND') return unprocessable('There are no new commits on the base branch.');
  Object.assign(p, { headRefOid: sha256(`${p.headRefOid}updated`).slice(0, 40), mergeStateStatus: 'CLEAN' });
  return { status: 202, body: { message: 'Updating pull request branch.', url: `https://github.com/${p.repo}/pull/${p.number}` } };
}

function askReviewers(p, body, change) {
  const names = body?.reviewers ?? [];
  if (names.includes(p.author)) return unprocessable('Review cannot be requested from pull request author.');
  p.requested = change(names);
  return { status: 201, body: { number: p.number, requested_reviewers: p.requested.map((login) => ({ login })), requested_teams: [] } };
}

/** Only an Actions job, or a run with a job that stopped, can be run again. */
function rerunAnswer(world, repo, method, [kind, id, act]) {
  if (method !== 'POST') return null;
  const checks = world.prs.filter((p) => p.repo === repo).flatMap((p) => p.checks.filter((c) => c.runId && (c.slug ?? 'github-actions') === 'github-actions'));
  const again = (c) => Object.assign(c, { status: 'QUEUED', conclusion: null, startedAt: null, completedAt: null });
  if (kind === 'jobs' && act === 'rerun') {
    const job = checks.find((c) => c.id === Number(id));
    if (!job) return null;
    again(job);
    return { status: 201, text: '' };
  }
  if (kind === 'runs' && act === 'rerun-failed-jobs') {
    const stopped = checks.filter((c) => c.runId === Number(id) && ['FAILURE', 'CANCELLED', 'TIMED_OUT', 'STARTUP_FAILURE'].includes(c.conclusion));
    if (!stopped.length) return checks.some((c) => c.runId === Number(id)) ? { status: 403, body: { message: 'This workflow run has no failed jobs to re-run' } } : null;
    stopped.forEach(again);
    return { status: 201, text: '' };
  }
  return null;
}

const restReview = (r) => ({ id: r.id, node_id: `PRR_${r.id}`, user: { login: r.author }, body: r.body ?? '', state: r.state, submitted_at: r.createdAt });

const TERMS = {
  'review-requested:@me': (p, me) => p.requested.includes(me) || p.requestedViaTeam === true,
  'author:@me': (p, me) => p.author === me,
  'assignee:@me': (p, me) => (p.assignees ?? []).includes(me),
  'mentions:@me': (p, me) => (p.mentions ?? []).includes(me),
  'reviewed-by:@me': (p, me) => p.reviews.some((r) => r.author === me),
};

function involved(world, shape, v, open) {
  const me = world.viewer.login;
  const out = { viewer: { login: me } };
  for (const name of ['requested', 'authored', 'assigned', 'mentioned', 'reviewed']) {
    const text = String(v[name] ?? '');
    const term = Object.keys(TERMS).find((t) => text.endsWith(t));
    const required = ['is:pr', 'is:open', 'archived:false'].every((w) => text.includes(w));
    const hits = required && term ? open.filter((p) => TERMS[term](p, me)) : [];
    out[name] = { issueCount: hits.length, nodes: hits.slice(0, 50).map(shape.pr) };
  }
  return out;
}

const ISSUE_TERMS = {
  'is:open': (i) => (i.state ?? 'OPEN') === 'OPEN',
  'assignee:@me': (i, me) => (i.assignees ?? []).includes(me),
  'author:@me': (i, me) => i.author === me,
};

/** Enough of GitHub's issue search for the app's own queries: the qualifiers it sends, closed:DAY, and quoted phrases joined by OR in the body. */
function issueSearch(world, shape, text = '', first = 100) {
  const me = world.viewer.login;
  const words = String(text).match(/"[^"]*"|\S+/g) ?? [];
  if (!words.includes('is:issue')) return { nodes: [] };
  const phrases = words.filter((w) => w.startsWith('"')).map((w) => w.slice(1, -1));
  const closed = words.find((w) => w.startsWith('closed:'))?.slice('closed:'.length);
  const hits = world.issues.filter((i) => words.every((w) => !ISSUE_TERMS[w] || ISSUE_TERMS[w](i, me))
    && (!closed || (i.state === 'CLOSED' && String(i.closedAt ?? '').startsWith(closed)))
    && (!phrases.length || phrases.some((p) => String(i.body ?? '').includes(p))));
  return { nodes: hits.slice(0, first).map(shape.issue) };
}

function oneIssue(shape, owner, name, number, pick) {
  const repo = `${owner}/${name}`;
  if (!shape.repoOf(repo)) return null;
  const found = shape.world.issues.find((i) => i.repo === repo && i.number === Number(number));
  return { issue: found ? pick(found) : null };
}

function manyIssues(shape, v) {
  const out = {};
  for (let n = 0; v[`o${n}`] !== undefined; n += 1) out[`i${n}`] = oneIssue(shape, v[`o${n}`], v[`n${n}`], v[`k${n}`], shape.issue);
  return out;
}

function boardOf(p) {
  const field = p.field === null ? null : { __typename: p.field?.type ?? 'ProjectV2SingleSelectField', id: p.field?.id ?? `PVTSSF_${p.id}`, options: p.field?.options ?? [] };
  return { id: p.id, title: p.title, url: `https://github.com/${p.ownerType === 'user' ? 'users' : 'orgs'}/${p.owner}/projects/${p.number}`, field };
}

function projectBoard(world, v) {
  const found = world.projects.find((p) => p.owner === v.owner && p.number === Number(v.number));
  const isOrg = world.orgs.includes(v.owner) || world.projects.some((p) => p.owner === v.owner && p.ownerType !== 'user');
  const isUser = v.owner === world.viewer.login || world.projects.some((p) => p.owner === v.owner && p.ownerType === 'user');
  const projectOf = (type) => ({ projectV2: found && (found.ownerType ?? 'org') === type ? boardOf(found) : null });
  return { organization: isOrg ? projectOf('org') : null, user: isUser ? projectOf('user') : null };
}

function moveItem(world, v) {
  const project = world.projects.find((p) => p.id === v.project);
  const item = project?.items.find((it) => it.id === v.item);
  const option = project?.field?.options?.find((o) => o.id === v.option);
  if (!item || !option || (project.field.id ?? `PVTSSF_${project.id}`) !== v.field) throw new Error('the fake GitHub could not find that item, field or option');
  item.status = option.name;
  return { updateProjectV2ItemFieldValue: { projectV2Item: { id: item.id } } };
}

function addItem(world, v) {
  const project = world.projects.find((p) => p.id === v.project);
  const issue = world.issues.find((i) => issueId(i) === v.content);
  if (!project || !issue) throw new Error('the fake GitHub could not find that project or issue');
  const item = { id: `PVTI_${project.items.length + 1}_${issue.number}`, issue: issueKey(issue), status: null };
  project.items.push(item);
  return { addProjectV2ItemById: { item: { id: item.id } } };
}

function addSubIssue(world, v) {
  const parent = world.issues.find((i) => issueId(i) === v.parent);
  const child = world.issues.find((i) => issueId(i) === v.child);
  if (!parent || !child) throw new Error('the fake GitHub could not find those issues');
  child.parent = issueKey(parent);
  return { addSubIssue: { issue: { id: v.parent } } };
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

function restAnswer(world, shape, { path }, url) {
  if (path === '/user') return userAnswer(world);
  const parts = path.split('/').filter(Boolean);
  if (parts[0] !== 'repos' || parts.length < 4) return null;
  const repo = `${parts[1]}/${parts[2]}`;
  const [kind, id, tail] = [parts[3], parts[4], parts[5]];
  if (!shape.repoOf(repo)) return null;
  if (kind === 'pulls' && tail === 'files') return filesAnswer(shape, repo, id, url);
  if (kind === 'pulls' && tail === 'reviews') return reviewsAnswer(shape, repo, id, url);
  if (kind === 'pulls' && tail === 'requested_reviewers') return requestedAnswer(shape, repo, id);
  if (kind === 'compare') return compareAnswer(world, repo, decodeURIComponent(parts.slice(4).join('/')));
  if (kind === 'contents') return contentsAnswer(world, repo, parts.slice(4).map(decodeURIComponent).join('/'), url.searchParams.get('ref'));
  if (kind === 'actions' && id === 'jobs' && parts[6] === 'logs') return logAnswer(world, parts[5]);
  return null;
}

function requestedAnswer(shape, repo, number) {
  const found = shape.find(repo, number);
  return found ? { body: { users: found.requested.map((login) => ({ login })), teams: [] } } : null;
}

function reviewsAnswer(shape, repo, number, url) {
  const found = shape.find(repo, number);
  if (!found) return null;
  const per = Number(url.searchParams.get('per_page') ?? 30);
  const page = Number(url.searchParams.get('page') ?? 1);
  return { body: found.reviews.slice((page - 1) * per, page * per).map(restReview) };
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

/** Opening an issue, and closing or reopening one, which is all the app writes to GitHub's REST API. */
function issueWrite(world, shape, method, path, body) {
  const [, repos, owner, name, kind, number] = path.split('/');
  const repo = `${owner}/${name}`;
  if (repos !== 'repos' || kind !== 'issues' || !shape.repoOf(repo)) return null;
  if (method === 'POST' && number === undefined) {
    const taken = [...world.issues, ...world.prs].filter((i) => i.repo === repo).map((i) => i.number);
    const made = { repo, number: Math.max(0, ...taken) + 1, title: body.title, body: body.body ?? '', state: 'OPEN', author: world.viewer.login, assignees: body.assignees ?? [], labels: [] };
    world.issues.push(made);
    return { status: 201, body: { number: made.number, title: made.title, html_url: shape.issue(made).url, node_id: issueId(made) } };
  }
  const found = world.issues.find((i) => i.repo === repo && i.number === Number(number));
  if (method !== 'PATCH' || !found) return null;
  if (body.state) Object.assign(found, { state: body.state.toUpperCase(), closedAt: body.state === 'closed' ? new Date(world.clock()).toISOString() : null });
  return { body: { number: found.number, state: body.state ?? 'open', html_url: shape.issue(found).url } };
}
