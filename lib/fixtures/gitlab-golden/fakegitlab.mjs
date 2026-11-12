const GID = { project: 'gid://gitlab/Project/', pipeline: 'gid://gitlab/Ci::Pipeline/' };
const PAGE = 100;

export function fakeGitlab(world, { host, token, now = () => new Date().toISOString() }) {
  const requests = [];
  let step = null;
  let gate = null;
  let openGate = () => {};
  const shape = shapes(world, host);
  const answerGraphql = graphqlAnswers(world, shape);
  const answerRest = restAnswers([...readRoutes(world, shape), ...writeRoutes(world, shape, now)]);

  async function fetch(input, init = {}) {
    const url = new URL(String(input));
    if (url.origin !== host || !url.pathname.startsWith('/api/')) throw new TypeError(`the baseline session reaches only ${host}/api, not ${url.href}`);
    const entry = { step, method: (init.method ?? 'GET').toUpperCase(), path: url.pathname, search: url.search, headers: recordedHeaders(init.headers, token), body: bodyOf(init.body) };
    requests.push(entry);
    await gate;
    const answer = url.pathname === '/api/graphql' ? answerGraphql(entry.body) : answerRest(entry, url);
    if (answer.status === 404) entry.unanswered = true;
    return answer;
  }

  return {
    fetch,
    requests,
    world,
    mark: (name) => { step = name; },
    hold: () => { gate = new Promise((resolve) => { openGate = resolve; }); },
    release: () => { openGate(); gate = null; },
    count: () => requests.length,
  };
}

function shapes(world, host) {
  const webUrl = (m) => `${host}/${m.path}/-/merge_requests/${m.iid}`;
  const realNotes = (m) => m.discussions.flatMap((d) => d.notes).filter((n) => !n.system);
  const isResolved = (d) => d.notes.every((n) => n.resolved !== false);
  return {
    webUrl,
    isResolved,
    mrsOf: (path) => world.mrs.filter((m) => m.path === path),
    findMr: (projectId, iid) => world.mrs.find((m) => m.projectId === Number(projectId) && m.iid === Number(iid)),
    projectOf: (path) => world.projects.find((p) => p.fullPath === path),
    inGroup: (m, group) => m.path.startsWith(`${group}/`),
    gqlMr: (m, withState) => {
      const resolvable = m.discussions.filter((d) => d.notes.some((n) => n.resolvable));
      return {
        iid: String(m.iid), title: m.title, webUrl: webUrl(m), draft: m.draft, conflicts: m.conflicts, userNotesCount: realNotes(m).length,
        ...(withState ? { state: m.state } : {}),
        resolvableDiscussionsCount: resolvable.length, resolvedDiscussionsCount: resolvable.filter(isResolved).length,
        createdAt: m.createdAt, updatedAt: m.updatedAt, diffHeadSha: m.sha, sourceBranch: m.sourceBranch, detailedMergeStatus: m.mergeStatus, autoMergeEnabled: m.autoMerge,
        author: { username: m.author },
        reviewers: { nodes: m.reviewers.map((username) => ({ username, mergeRequestInteraction: { reviewState: m.reviewStates[username] ?? 'UNREVIEWED' } })) },
        approvedBy: { nodes: m.approvedBy.map((username) => ({ username })) },
        headPipeline: m.pipeline ? { id: GID.pipeline + m.pipeline.id, status: m.pipeline.status } : null,
      };
    },
    restMr: (m) => ({
      id: m.projectId * 1000 + m.iid, iid: m.iid, project_id: m.projectId, title: m.title, description: m.description, state: m.state, draft: m.draft, has_conflicts: m.conflicts,
      detailed_merge_status: m.mergeStatus.toLowerCase(), target_branch: m.targetBranch, source_branch: m.sourceBranch, web_url: webUrl(m), sha: m.sha,
      author: { username: m.author }, reviewers: m.reviewers.map((username) => ({ id: world.users[username], username })),
      merged_at: m.mergedAt, created_at: m.createdAt, updated_at: m.updatedAt, references: { full: `${m.path}!${m.iid}` },
      merge_when_pipeline_succeeds: m.autoMerge, changes_count: String(m.diffs.length), user_notes_count: realNotes(m).length,
    }),
  };
}

function graphqlAnswers(world, { mrsOf, projectOf, gqlMr, inGroup, webUrl }) {
  const mrIn = (path, iid) => mrsOf(path).find((m) => m.iid === Number(iid));
  const project = (path, nodes) => {
    const p = projectOf(path);
    return p ? { id: GID.project + p.id, fullPath: p.fullPath, name: p.name, mergeRequests: { count: nodes.length, nodes } } : null;
  };
  const byAlias = (vars, each) => Object.fromEntries(Object.keys(vars).map((k) => [`p${k.slice(1)}`, each(vars[k])]));
  const openIn = (path) => mrsOf(path).filter((m) => m.state === 'opened').sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const mergedIn = (group, after, before) => world.mrs.filter((m) => m.state === 'merged' && inGroup(m, group) && m.mergedAt >= after && (!before || m.mergedAt < before));
  const mergedNode = (m) => ({
    iid: String(m.iid), title: m.title, webUrl: webUrl(m), sourceBranch: m.sourceBranch, mergedAt: m.mergedAt, author: { username: m.author, name: m.author[0].toUpperCase() + m.author.slice(1) },
    project: { fullPath: m.path }, diffStatsSummary: { additions: 12, deletions: 3 },
  });
  const boardNode = (m) => ({ iid: String(m.iid), createdAt: m.createdAt, mergedAt: m.mergedAt, author: { username: m.author }, approvedBy: { nodes: m.approvedBy.map((username) => ({ username })) } });
  const boardProject = (path, since) => {
    const p = project(path, mrsOf(path).filter((m) => m.createdAt >= since).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map(boardNode));
    return p && { id: p.id, fullPath: p.fullPath, mergeRequests: { ...p.mergeRequests, pageInfo: { hasNextPage: false, endCursor: null } } };
  };

  const OPERATIONS = {
    Mrs: (vars) => byAlias(vars, (path) => project(path, openIn(path).map((m) => gqlMr(m, false)))),
    One: ({ f, iid }) => ({ p0: project(f, mrsOf(f).filter((m) => m.iid === Number(iid)).map((m) => gqlMr(m, true))) }),
    End: ({ f, iid }) => ({ project: projectOf(f) ? { mergeRequest: endOf(mrIn(f, iid)) } : null }),
    State: ({ f, iid }) => ({ project: projectOf(f) ? { mergeRequest: mrIn(f, iid) ? { state: mrIn(f, iid).state } : null } : null }),
    Hold: ({ path, iid }, query) => hold(world, mrIn(path, iid), /mergeRequestRequestChanges/.test(query)),
    Draft: ({ path, iid, draft }) => setDraft(mrIn(path, iid), draft),
    Rereview: () => ({ mergeRequestReviewerRereview: { errors: [] } }),
    board: (vars, query) => byAlias(vars, (path) => boardProject(path, /createdAfter: "([^"]+)"/.exec(query)?.[1] ?? '')),
    merged: ({ group, after, before }) => ({ group: world.groups.includes(group) ? { mergeRequests: { pageInfo: { hasNextPage: false, endCursor: null }, nodes: mergedIn(group, after, before).map(mergedNode) } } : null }),
  };

  return ({ query, variables }) => {
    const [, kind, name] = /^(query|mutation)\s+(\w+)/.exec(query) ?? [];
    const answer = OPERATIONS[name]?.(variables, query);
    if (!kind || !answer) return Response.json({ errors: [{ message: `the fake has no ${kind ?? 'operation'} ${name ?? query.slice(0, 40)}` }] }, { status: 404 });
    return Response.json({ data: answer });
  };
}

const endOf = (m) => (m ? { state: m.state, mergeUser: m.mergedBy ? { username: m.mergedBy } : null } : null);

function hold(world, m, held) {
  const field = held ? 'mergeRequestRequestChanges' : 'mergeRequestDestroyRequestedChanges';
  m.reviewStates[world.me] = held ? 'REQUESTED_CHANGES' : 'UNREVIEWED';
  m.mergeStatus = held ? 'REQUESTED_CHANGES' : m.approvedBy.length ? 'MERGEABLE' : 'NOT_APPROVED';
  return { [field]: { errors: [], mergeRequest: { detailedMergeStatus: m.mergeStatus } } };
}

function setDraft(m, draft) {
  m.draft = draft;
  m.title = draft ? `Draft: ${m.title.replace(/^Draft: /, '')}` : m.title.replace(/^Draft: /, '');
  if (!draft && m.mergeStatus === 'DRAFT_STATUS') m.mergeStatus = 'NOT_APPROVED';
  return { mergeRequestSetDraft: { errors: [], mergeRequest: { draft } } };
}

function restAnswers(routes) {
  return (entry, url) => {
    const path = url.pathname.replace(/^\/api\/v4/, '');
    for (const [method, pattern, answer] of routes) {
      const match = method === entry.method && pattern.exec(path);
      if (!match) continue;
      const value = answer(Object.fromEntries(url.searchParams), match.slice(1), entry.body ?? {});
      return value instanceof Response ? value : Response.json(value);
    }
    return Response.json({ message: '404 Not Found' }, { status: 404 });
  };
}

function readRoutes(world, { findMr, inGroup, restMr }) {
  const page = (q, list) => (Number(q.page ?? 1) > 1 ? [] : list.slice(0, PAGE));
  const pipelineById = (id) => Object.values(world.pipelines).find((p) => p.id === Number(id));
  const asked = (q) => (q.scope === 'created_by_me'
    ? (m) => m.author === world.me
    : (m) => (!q.author_username || m.author === q.author_username) && (!q.reviewer_username || m.reviewers.includes(q.reviewer_username)));
  const listed = (q) => world.mrs.filter((m) => asked(q)(m) && (!q.state || q.state === 'all' || m.state === q.state) && (!q.updated_after || m.updatedAt >= q.updated_after));
  const inGroupAsked = (group, q) => world.mrs.filter((m) => inGroup(m, group) && m.state === q.state && (!q.search || m.title.includes(q.search)));
  const detail = (m, q) => (m ? {
    ...restMr(m),
    ...('include_diverged_commits_count' in q ? { diverged_commits_count: m.behind } : {}),
    ...('include_rebase_in_progress' in q ? { rebase_in_progress: m.rebasing, merge_error: null } : {}),
  } : Response.json({ message: '404 Not found' }, { status: 404 }));
  const compare = (projectId, to) => {
    const m = world.mrs.find((x) => x.projectId === Number(projectId) && x.sha === to);
    return { commits: [{ id: to }], diffs: (m?.diffs ?? []).map(({ old_path, new_path }) => ({ old_path, new_path })) };
  };
  const commentEvent = (m, n) => ({ author: { username: n.author }, created_at: n.created_at, project_id: m.projectId, action_name: 'commented on', target_title: m.title, note: { noteable_type: 'MergeRequest', noteable_iid: m.iid } });
  const commentEvents = (projectId, after) => world.mrs.filter((m) => m.projectId === Number(projectId))
    .flatMap((m) => m.discussions.flatMap((d) => d.notes).filter((n) => !n.system && n.created_at.slice(0, 10) > after).map((n) => commentEvent(m, n)));

  return [
    ['GET', /^\/user$/, () => ({ id: world.users[world.me], username: world.me, name: 'Frank' })],
    ['GET', /^\/groups$/, () => world.groups.map((full_path) => ({ full_path }))],
    ['GET', /^\/groups\/([^/]+)\/merge_requests$/, (q, [group]) => page(q, inGroupAsked(decodeURIComponent(group), q).map(restMr))],
    ['GET', /^\/todos$/, () => world.todos],
    ['GET', /^\/users$/, (q) => Object.entries(world.users).filter(([name]) => name === q.username).map(([username, id]) => ({ id, username }))],
    ['GET', /^\/events$/, (q) => page(q, world.events.filter((e) => e.created_at.slice(0, 10) > q.after && e.created_at.slice(0, 10) < q.before))],
    ['GET', /^\/merge_requests$/, (q) => page(q, listed(q).map(restMr))],
    ['GET', /^\/projects\/(\d+)\/events$/, (q, [id]) => page(q, commentEvents(id, q.after))],
    ['GET', /^\/projects\/(\d+)\/merge_requests\/(\d+)$/, (q, ids) => detail(findMr(...ids), q)],
    ['GET', /^\/projects\/(\d+)\/merge_requests\/(\d+)\/discussions$/, (q, ids) => findMr(...ids).discussions.map(restThread)],
    ['GET', /^\/projects\/(\d+)\/merge_requests\/(\d+)\/diffs$/, (q, ids) => (Number(q.page ?? 1) > 1 ? [] : findMr(...ids).diffs)],
    ['GET', /^\/projects\/(\d+)\/merge_requests\/(\d+)\/approvals$/, (q, ids) => ({ approved_by: findMr(...ids).approvedBy.map((username) => ({ user: { username } })) })],
    ['GET', /^\/projects\/(\d+)\/repository\/compare$/, (q, [p]) => compare(p, q.to)],
    ['GET', /^\/projects\/(\d+)\/repository\/files\/([^/]+)\/raw$/, (q, [p, path]) => raw(world.files[`${p}:${decodeURIComponent(path)}@${q.ref}`])],
    ['GET', /^\/projects\/(\d+)\/pipelines$/, (q) => (world.pipelines[q.sha] ? [{ id: world.pipelines[q.sha].id }] : [])],
    ['GET', /^\/projects\/(\d+)\/pipelines\/(\d+)\/jobs$/, (q, [, id]) => pipelineById(id)?.jobs ?? []],
    ['GET', /^\/projects\/(\d+)\/jobs\/(\d+)\/trace$/, (q, [, id]) => raw(world.traces[id])],
    ['POST', /^\/projects\/(\d+)\/pipelines\/(\d+)\/retry$/, (q, [, id]) => retryPipeline(pipelineById(id))],
  ];
}

function writeRoutes(world, { findMr, isResolved, restMr }, now) {
  let next = 1;
  const userName = (id) => Object.entries(world.users).find(([, n]) => n === Number(id))?.[0];
  const threadOf = (m, id) => m.discussions.find((d) => d.id === id);
  const opened = (m, discussionId, note) => {
    m.discussions.push({ id: discussionId, notes: [{ id: next++, author: world.me, created_at: now(), system: false, ...note }] });
    return m.discussions.at(-1);
  };
  const reply = (thread, body) => {
    const resolvable = thread.notes.some((n) => n.resolvable);
    const added = { id: next++, author: world.me, body, created_at: now(), system: false, resolvable, ...(resolvable ? { resolved: isResolved(thread) } : {}) };
    thread.notes.push(added);
    return restNote(added);
  };
  const resolve = (thread, resolved) => {
    for (const n of thread.notes) if (n.resolvable) n.resolved = resolved;
    return restThread(thread);
  };
  const approve = (m, approving) => {
    m.approvedBy = approving ? [...new Set([...m.approvedBy, world.me])] : m.approvedBy.filter((u) => u !== world.me);
    if (m.reviewers.includes(world.me)) m.reviewStates[world.me] = approving ? 'APPROVED' : 'UNREVIEWED';
    if (m.mergeStatus === 'NOT_APPROVED' && approving) m.mergeStatus = 'MERGEABLE';
    return { approved: approving };
  };
  const merge = (m, { auto_merge: auto }) => {
    if (auto) m.autoMerge = true;
    else Object.assign(m, { state: 'merged', mergedAt: now(), mergedBy: world.me, updatedAt: now() });
    return { ...restMr(m), merge_when_pipeline_succeeds: m.autoMerge };
  };
  const rebase = (m) => {
    m.sha = `${m.sha.slice(0, 4)}beef`;
    m.behind = 0;
    world.pipelines[m.sha] = { id: m.pipeline.id + 1, jobs: [] };
    m.pipeline = { id: m.pipeline.id + 1, status: 'RUNNING' };
    return { rebase_in_progress: true };
  };
  const retryJob = (id) => {
    Object.values(world.pipelines).flatMap((p) => p.jobs).find((j) => j.id === id).status = 'pending';
    return { id: id + 1, status: 'pending' };
  };

  return [
    ['PUT', /^\/projects\/(\d+)\/merge_requests\/(\d+)$/, (q, ids, { reviewer_ids }) => restMr(Object.assign(findMr(...ids), { reviewers: reviewer_ids.filter(Boolean).map(userName) }))],
    ['POST', /^\/projects\/(\d+)\/merge_requests\/(\d+)\/discussions$/, (q, ids, { body, position }) => restThread(opened(findMr(...ids), `new${next++}`, { body, resolvable: true, resolved: false, ...(position ? { position } : {}) }))],
    ['POST', /^\/projects\/(\d+)\/merge_requests\/(\d+)\/discussions\/(\w+)\/notes$/, (q, [p, i, d], { body }) => reply(threadOf(findMr(p, i), d), body)],
    ['PUT', /^\/projects\/(\d+)\/merge_requests\/(\d+)\/discussions\/(\w+)$/, (q, [p, i, d]) => resolve(threadOf(findMr(p, i), d), q.resolved === 'true')],
    ['POST', /^\/projects\/(\d+)\/merge_requests\/(\d+)\/notes$/, (q, ids, { body }) => ({ id: opened(findMr(...ids), `note${next}`, { body, resolvable: false }).notes[0].id })],
    ['POST', /^\/projects\/(\d+)\/merge_requests\/(\d+)\/(approve|unapprove)$/, (q, [p, i, how]) => approve(findMr(p, i), how === 'approve')],
    ['PUT', /^\/projects\/(\d+)\/merge_requests\/(\d+)\/rebase$/, (q, ids) => rebase(findMr(...ids))],
    ['PUT', /^\/projects\/(\d+)\/merge_requests\/(\d+)\/merge$/, (q, ids, body) => merge(findMr(...ids), body)],
    ['POST', /^\/projects\/(\d+)\/merge_requests\/(\d+)\/cancel_merge_when_pipeline_succeeds$/, (q, ids) => restMr(Object.assign(findMr(...ids), { autoMerge: false }))],
    ['POST', /^\/projects\/(\d+)\/jobs\/(\d+)\/retry$/, (q, [, id]) => retryJob(Number(id))],
  ];
}

function retryPipeline(p) {
  for (const j of p.jobs) if (j.status === 'failed' || j.status === 'canceled') j.status = 'pending';
  return { id: p.id, status: 'pending' };
}

const raw = (text) => (text === undefined ? Response.json({ message: '404 File Not Found' }, { status: 404 }) : new Response(text, { headers: { 'content-type': 'text/plain' } }));
const restNote = (n) => ({ ...n, author: { username: n.author } });
const restThread = (d) => ({ id: d.id, individual_note: !d.notes.some((n) => n.resolvable), notes: d.notes.map(restNote) });

function recordedHeaders(headers, token) {
  const entries = !headers ? [] : headers instanceof Headers ? [...headers.entries()] : Object.entries(headers);
  const shown = (name, value) => (name === 'private-token' ? (value === token ? '<token>' : `<not the token: ${value}>`) : String(value));
  return Object.fromEntries(entries.map(([k, v]) => [k.toLowerCase(), shown(k.toLowerCase(), v)]).sort(([a], [b]) => a.localeCompare(b)));
}

// GraphQL text is kept as one line, as its layout is not part of what GitLab is asked.
function bodyOf(body) {
  if (body === undefined || body === null) return null;
  try {
    const parsed = JSON.parse(String(body));
    return typeof parsed?.query === 'string' ? { ...parsed, query: parsed.query.replace(/\s+/g, ' ').trim() } : parsed;
  } catch {
    return String(body);
  }
}
