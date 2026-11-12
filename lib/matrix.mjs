import { driverView, EDITOR } from './autoloop.mjs';
import { agentCheck, agentReading, BAD_KEY, engine, engineError, failure, fetchError, fetchErrors, gitlabHost, inbox, loading, meFor, MR_KEY, mrFor, mrOrQueued, notify, pendingItem, refreshIfStale, requireEngine, sendingNow, supports } from './engine.mjs';
import { changeOf, movedWords } from './since.mjs';
import { projectList } from './ticketkeys.mjs';
import { keyOf } from './refs.mjs';
import { queueCleanup } from './tidy.mjs';

const RECENT_DONE = 60;
const EXPIRED_SHOWN = 200;
const RUN_LIMIT = 60;
const AUTO_LOG_LIMIT = 50;
const LEVELS = [null, 'off', 'shadow', 'comments', 'verdict'];
const ANYONE = '*';
const MAX_BODY = 20_000;
const MAX_PATH = 1024;
const ANCHOR_RETRY_MS = 15_000;
const SEVERITIES = new Set(['CRITICAL', 'MAJOR', 'MINOR', 'NIT', 'QUESTION']);
const QUEUED_BY = 'claude-panel';
const REFUSED = new Set(['already being sent', 'it is being edited', 'already posted', 'it was discarded', 'it is no longer in the queue']);
const refusedPost = (error) => REFUSED.has(error) || /^it expired \(/.test(error ?? '');

// Keyed by MR head: which line of each queued hunk its comment is on, found from the diff.
const anchors = new Map();

export async function readMatrix() {
  if (!engine) return { available: false, error: engineError };
  const settings = engine.loadSettings();
  refreshIfStale(settings);
  const state = engine.loadState();
  const people = engine.parsePeople(settings.fullAuto);
  const rules = supports('peopleRules') ? engine.peopleRules(String(settings.fullAuto ?? '')) : null;
  const watches = state.watches ?? {};
  const queue = engine.loadQueue();
  const runs = engine.loadRuns();
  const agentOn = agentCheck(watches, runs);
  return {
    available: true,
    driver: driverView(),
    me: inbox?.me ?? null,
    inbox: {
      fetchedAt: inbox?.fetchedAt ?? null,
      loading: loading(),
      error: fetchError ?? inbox?.errors?.gitlab ?? null,
      repoCount: inbox?.repoCount ?? 0,
      rows: inbox ? engine.rowsFor(inbox).map((row) => summariseRow(row, people, watches, agentOn, rules)) : [],
    },
    paused: Boolean(settings.autoPaused),
    holdSeconds: settings.autoHoldSeconds ?? null,
    holdWhileReviewing: Boolean(settings.holdWhileReviewing),
    jiraSite: settings.jiraSite || null,
    jiraProjects: projectList(settings.jira?.projects),
    defaultProject: projectList(settings.jira?.defaultProject)[0] ?? null,
    issueType: settings.jira?.issueType || 'Task',
    gitlabHost: gitlabHost(),
    providers: providersView(),
    fullAuto: people,
    onRequest: rules ? { level: rules.onRequest, optedOut: [...rules.optedOut], available: true } : { level: null, optedOut: [], available: false },
    roster: engine.roster((inbox?.mrs ?? []).filter((mr) => !mr.provider), inbox?.me, people),
    watches: Object.values(watches).map(summariseWatch),
    verdicts: state.verdicts ?? {},
    queue: summariseQueue(queue),
    cleanup: queueCleanup(),
    autoLog: supports('autoLogRows') ? engine.autoLogRows(queue).slice(0, AUTO_LOG_LIMIT) : [],
    autoCounts: supports('autoCounts') ? engine.autoCounts(queue) : null,
    runs: summariseRuns(runs),
    autoPasses: Object.values(engine.loadAutoMemory())
      .map(summarisePass)
      .sort((a, b) => String(b.launchedAt ?? '').localeCompare(String(a.launchedAt ?? ''))),
  };
}

// A read where every forge failed keeps the last rows, so each forge's error then comes from the failure, not from those rows.
function providerError(id) {
  if (id === 'gitlab') return fetchError ?? inbox?.errors?.gitlab ?? null;
  return (fetchError ? fetchErrors?.[id] : inbox?.errors?.[id]) ?? null;
}

// Each forge's own name, account and error, so one that fails never reads as the other failing too.
function providersView() {
  if (!supports('forgeView')) return null;
  return Object.fromEntries(Object.entries(engine.forgeView()).map(([id, f]) => [id, {
    name: f.name,
    on: f.on,
    caps: f.caps,
    error: f.on ? providerError(id) : null,
    me: f.on ? meFor({ provider: id === 'gitlab' ? undefined : id }) : null,
    ...(id === 'github' && f.on && supports('githubWeb') ? { web: engine.githubWeb() } : {}),
    ...(id === 'github' && f.on && supports('githubLimits') ? { limits: engine.githubLimits() } : {}),
  }]));
}

function summariseRuns(runs) {
  const live = new Set((inbox?.terminals ?? []).filter((t) => t.connected && !t.orphaned).map((t) => t.handle));
  return Object.values(runs)
    .sort((a, b) => String(b.startedAt).localeCompare(String(a.startedAt)))
    .slice(0, RUN_LIMIT)
    .map(({ key, webUrl, startedAt, endedAt, status, worktreePath, tail, terminal, kickoff }) => {
      const alive = Boolean(terminal && live.has(terminal));
      return {
        key, webUrl, startedAt, endedAt: endedAt ?? null, status: status ?? 'launching', worktreePath: worktreePath ?? null,
        tail: (tail ?? []).slice(-30), terminal: terminal ?? null, live: alive, working: alive && status === 'working', kickoff: Boolean(kickoff),
      };
    });
}

function summarisePass({ key, pass, handedBack }) {
  return {
    key,
    id: pass?.id ?? null,
    sha: pass?.sha ?? null,
    author: pass?.author,
    trigger: pass?.trigger,
    launchedAt: pass?.launchedAt,
    doneAt: pass?.doneAt,
    state: !pass ? 'none' : pass.settled ?? (pass.doneAt ? 'finishing' : 'reviewing'),
    handedBack: handedBack ?? [],
  };
}

function summariseRow({ mr, key, flags, phase, count, mood, verdict, agent }, people, watches, agentOn, rules) {
  const own = mr.provider ? null : people.find((p) => p.username === mr.author.toLowerCase())?.level ?? null;
  const level = own ?? (rules && inbox?.me ? engine.levelForMr(mr, inbox.me, rules) : null);
  const watch = watches[key];
  return {
    key,
    ...(mr.provider ? { provider: mr.provider } : {}),
    iid: mr.iid,
    repo: mr.repoLabel,
    title: mr.title,
    webUrl: mr.webUrl,
    author: mr.author,
    reviewers: mr.reviewers,
    approvedBy: mr.approvedBy,
    draft: mr.draft,
    pipeline: mr.pipeline,
    ticket: mr.ticket,
    createdAt: mr.createdAt ?? null,
    updatedAt: mr.updatedAt,
    unresolved: mr.unresolvedThreads,
    threads: inbox.threads?.get(key) ?? null,
    mergeStatus: mr.mergeStatus ?? null,
    sourceBranch: mr.sourceBranch ?? null,
    sha: mr.sha ?? null,
    autoMerge: Boolean(mr.autoMerge),
    reviewStates: mr.reviewStates ?? null,
    agentHandle: watch?.terminal ?? null,
    watch: watch ? { auto: Boolean(watch.auto) } : null,
    flags: { ...flags, heldByMe: heldByMe(mr, flags) },
    movedWhy: flags.changed ? movedWords(changeOf(watch, mr)) : null,
    phase,
    count,
    mood,
    verdict,
    agent: agent ?? null,
    agentStarting: !agent && agentOn(key),
    level,
    askedYou: Boolean(level && !own),
  };
}

function heldByMe(mr, flags) {
  if (!flags.held) return false;
  const me = meFor(mr);
  return supports('heldByMe') && me ? engine.heldByMe(mr, me) : true;
}

function summariseWatch({ key, webUrl, auto, seen, reviewedAt, terminal }) {
  return { key, webUrl, auto, reviewedAt, terminal: Boolean(terminal), pipeline: seen?.pipeline, notes: seen?.notes, approvals: seen?.approvals, unresolved: seen?.unresolved };
}

const settledAt = (i) => String(i.postedAt || i.expiredAt || i.createdAt);
const newestFirst = (a, b) => settledAt(b).localeCompare(settledAt(a));

// Expired items are listed apart, or a busy day of posting would push them off the page before they are archived.
function summariseQueue(items) {
  const pending = items.filter((i) => i.status === 'pending');
  const expired = items.filter((i) => i.status === 'expired').sort(newestFirst).slice(0, EXPIRED_SHOWN);
  const settled = [...expired, ...items.filter((i) => i.status !== 'pending' && i.status !== 'expired').sort(newestFirst).slice(0, RECENT_DONE)];
  const heads = new Map((inbox?.mrs ?? []).map((mr) => [keyOf(mr), mr]));
  const found = anchorsFor(pending, heads);
  const waiting = waitingIds(items);
  return [...pending, ...settled].map((i) => summariseItem(i, heads.get(keyOf(i)), found, waiting));
}

// The engine's own rule, so the page and the TUI count the same items as waiting to post.
function waitingIds(items) {
  if (!inbox || !supports('waitingToPost')) return null;
  return new Set(engine.waitingToPost(items, inbox.mrs).map((i) => i.id));
}

export function settledFor(items, key) {
  return items.filter((i) => i.status !== 'pending' && keyOf(i) === key).sort(newestFirst).map((i) => summariseItem(i, null, {}));
}

function summariseItem(i, mr, found, waiting = null) {
  const position = i.position ?? {};
  const pending = i.status === 'pending';
  return {
    id: i.id,
    key: keyOf(i),
    webUrl: i.webUrl,
    severity: i.severity,
    kind: i.kind ?? (i.replyTo ? 'reply' : 'finding'),
    outcome: i.outcome ?? null,
    verdict: i.verdict ?? null,
    body: String(i.body ?? '').slice(0, MAX_BODY),
    hunk: i.diffHunk ? String(i.diffHunk).slice(0, MAX_BODY) : null,
    path: position.new_path ?? position.newPath ?? position.old_path ?? null,
    line: position.new_line ?? position.old_line ?? null,
    side: position.new_line ? 'new' : position.old_line ? 'old' : null,
    anchor: found[i.id] ?? null,
    stale: Boolean(pending && mr && supports('outdated') && engine.outdated(i.position, mr.sha)),
    createdBy: i.createdBy,
    createdAt: i.createdAt,
    status: i.status,
    waiting: pending && (!waiting || waiting.has(i.id)),
    postedAt: i.postedAt,
    expiredAt: i.expiredAt ?? null,
    expiredReason: i.expiredReason ?? null,
    auto: i.auto ? { ...i.auto, held: i.auto.held ?? null } : null,
    sending: i.sending ?? null,
    editing: i.editing ?? null,
    error: i.error,
    discussionId: i.discussionId ?? null,
    replyTo: i.replyTo ?? null,
    sendsItself: pending && Boolean(i.auto) && !i.auto.held && i.auto.level !== 'shadow',
    print: supports('findingPrint') ? engine.findingPrint(i) : null,
  };
}

function anchorsFor(pending, heads) {
  if (!supports('hunkAnchors')) return {};
  const found = {};
  const live = new Set();
  for (const mr of heads.values()) {
    const items = pending.filter((i) => i.diffHunk && i.position && i.projectPath === mr.projectPath && i.iid === mr.iid);
    if (!items.length || !mr.sha) continue;
    const head = `${keyOf(mr)}@${mr.sha}`;
    live.add(head);
    Object.assign(found, knownAnchors(head, mr, items));
  }
  for (const head of anchors.keys()) if (!live.has(head)) anchors.delete(head);
  return found;
}

// Asked for in the background, so the page shows hunks at once and marks their lines on the next refresh.
function knownAnchors(head, mr, items) {
  const known = anchors.get(head);
  if (known && (known.loading || Date.now() < known.retryAt || items.every((i) => i.id in known.found))) return known.found;
  const entry = { found: known?.found ?? {}, loading: true, retryAt: 0 };
  anchors.set(head, entry);
  engine
    .hunkAnchors(mr, items)
    .then((found) => {
      entry.found = found;
      notify('matrix');
    })
    // A failure waits before it is asked again and wakes no page, or each page read would retry it at once.
    .catch(() => { entry.retryAt = Date.now() + ANCHOR_RETRY_MS; })
    .finally(() => { entry.loading = false; });
  return entry.found;
}

function validPath(path) {
  return typeof path === 'string' && path.length <= MAX_PATH && !/[\0\r\n]/.test(path)
    && !path.startsWith('/') && !path.split('/').includes('..');
}

export async function readMrFile(key, path, folded) {
  if (!engine) throw failure(503, engineError);
  if (!supports('inlineFile')) throw failure(501, 'The review engine needs rebuilding before it can show files');
  if (typeof key !== 'string' || !MR_KEY.test(key)) throw failure(400, BAD_KEY);
  if (path && !validPath(path)) throw failure(400, 'that is not a path inside the repository');
  if (!inbox) throw failure(503, 'the MR list has not loaded yet');
  const mr = mrFor(key);
  const view = await engine.inlineFile(mr, path ?? '', { me: meFor(mr) ?? undefined, folded: Boolean(folded) });
  if (!view) throw failure(404, path ? `${path} is neither changed nor commented on in ${key}` : `nothing in ${key} is commented on a line`);
  return view;
}

async function review({ key }) {
  if (agentReading(key)) throw failure(409, `an agent is already reading ${key}`);
  const { alreadyWatched, holdWarning } = await engine.startReview(mrFor(key));
  const said = `Reviewing ${key}, ${alreadyWatched ? 'watch baseline reset' : 'now watching for changes'}`;
  return holdWarning ? `${said}. Hold: ${holdWarning}` : said;
}

async function approve({ key, approving }) {
  const { liftedHold } = await engine.setApproved(mrFor(key), Boolean(approving));
  return `${approving ? 'Approved' : 'Approval withdrawn on'} ${key}${liftedHold ? ', hold lifted' : ''}`;
}

async function hold({ key, held }) {
  const { warning } = await engine.setHeld(mrFor(key), Boolean(held));
  return `${held ? 'Merge held on' : 'Hold lifted from'} ${key}${warning ? ` (${warning})` : ''}`;
}

// The last item posted or discarded on an MR lifts the hold your review placed, as Post all does.
async function liftIfDone(key) {
  if (!supports('liftReviewHoldIfDone') || !inbox) return false;
  const listed = inbox.mrs.find((mr) => keyOf(mr) === key);
  return listed ? (await engine.liftReviewHoldIfDone(listed, meFor(listed) ?? undefined).catch(() => ({ liftedHold: false }))).liftedHold : false;
}

async function post({ id }) {
  const item = pendingItem(id);
  const outcome = await engine.postOne(item);
  if (outcome.ok) return (await liftIfDone(keyOf(item))) ? 'Posted, and your hold is lifted' : 'Posted';
  if (!refusedPost(outcome.error)) throw new Error(outcome.error ?? 'post failed');
  throw failure(409, outcome.error === 'already being sent' ? sendingNow(id) : outcome.error);
}

// Posting all reports only counts, so an item already on its way is caught before anything goes.
async function postAll({ key }) {
  const sending = engine.loadQueue().filter((c) => c.status === 'pending' && c.sending && keyOf(c) === key);
  if (sending.length) throw failure(409, `full auto is sending ${sending.length === 1 ? 'one of these' : `${sending.length} of these`} right now`);
  const { posted, total, liftedHold } = await engine.postAll(mrOrQueued(key));
  return `Posted ${posted} of ${total}${liftedHold ? ', hold lifted' : ''}`;
}

// On the MR as a whole, since a line needs diff refs the MR list does not carry.
function queueFinding({ key, severity, body }) {
  requireEngine('addToQueue', 'queueInput');
  if (!SEVERITIES.has(severity)) throw failure(400, `severity is one of ${[...SEVERITIES].join(', ')}`);
  if (typeof body !== 'string' || !body.trim() || body.length > MAX_BODY) throw failure(400, 'the finding needs some text');
  const mr = mrFor(key);
  const item = { projectPath: mr.projectPath, projectId: mr.projectId, iid: mr.iid, webUrl: mr.webUrl, severity, body: body.trim(), createdBy: QUEUED_BY };
  engine.addToQueue([engine.queueInput(item, 0)]);
  return `Queued a ${severity} finding on ${key}, waiting for you to post it`;
}

// A send already claimed goes out as it was claimed, so neither a discard nor an edit would hold.
function unsent(id) {
  const item = pendingItem(id);
  if (item.sending) throw failure(409, sendingNow(id));
  return item.id;
}

function refusedNow(id) {
  const item = engine.loadQueue().find((c) => c.id === id);
  return failure(409, item?.status === 'pending' && item.sending ? sendingNow(id) : 'that item is not waiting to be posted any more');
}

async function discard({ id }) {
  const item = pendingItem(id);
  if (engine.discard(unsent(id)) === false) throw refusedNow(id);
  return (await liftIfDone(keyOf(item))) ? 'Discarded, and your hold is lifted' : 'Discarded';
}

function edit({ id, body }) {
  if (typeof body !== 'string' || !body.trim() || body.length > MAX_BODY) throw new Error('the comment needs some text');
  if (!engine.editQueued(unsent(id), body)) throw refusedNow(id);
  if (supports('setEditing')) engine.setEditing(id, EDITOR, null);
  return 'Saved';
}

// The default row reviews on request at shadow only, and an older engine would read it as a person called '*'.
function level({ username, level: wanted }) {
  const name = username === ANYONE ? ANYONE : engine.typedUsername(String(username ?? ''));
  if (!name) throw new Error('that is not a GitLab username');
  if (!LEVELS.includes(wanted ?? null)) throw new Error('unknown level');
  if ((name === ANYONE || wanted === 'off') && !supports('peopleRules')) throw failure(501, 'The review engine needs rebuilding: this build has no peopleRules');
  if (name === ANYONE && wanted && wanted !== 'shadow' && wanted !== 'off') throw failure(400, 'reviewing on request is shadow or off');
  engine.setPersonLevel(name, wanted ?? null);
  if (name === ANYONE) return wanted === 'shadow' ? 'Every MR that asks for you is reviewed at shadow: queued for you, nothing sent' : 'MRs that ask for you are no longer reviewed on their own';
  if (wanted === 'off') return `${name} is never in full auto`;
  if (wanted) return `${name} is in full auto at ${engine.LEVEL_LABEL[wanted]}`;
  const onRequest = supports('peopleRules') && engine.peopleRules(String(engine.loadSettings().fullAuto ?? '')).onRequest;
  return onRequest ? `${name} follows the default row` : `${name} is out of full auto`;
}

function pause() {
  const { autoPaused } = engine.toggleFullAutoPause();
  return autoPaused ? 'Full auto paused, nothing sends until you resume it' : 'Full auto resumed, every hold window starts again';
}

const REAPED = { 'mr closed': 'its MR is closed', 'review finished': 'review finished, nothing left to post' };

// stillGoing(w) replaces gc's connected-terminal test, which would keep every finished review whose terminal is still open.
export async function judgeReviews(workspaces, stillGoing) {
  const unavailable = reviewRulesMissing();
  if (unavailable) return (w) => (looksLikeReview(w) ? { blocker: unavailable } : null);
  const rules = await gcRules(workspaces, stillGoing);
  const shaped = workspaces.map(asMatrixWorkspace);
  const reaped = new Map(engine.reapable(shaped, inbox.mrs, rules).map((c) => [c.workspace.id, REAPED[c.reason]]));
  const unwatched = new Set(engine.outOfScope(shaped, rules.knownRepoLabels).map((w) => w.id));
  return (w) => {
    const review = reviewName(w);
    if (!review) return null;
    if (reaped.has(w.id)) return { reason: reaped.get(w.id) };
    return { blocker: unwatched.has(w.id) ? `${review.repoLabel} is not in the repos this page reviews` : heldBack(review, rules) };
  };
}

function reviewRulesMissing() {
  if (!engine) return 'the review engine is not loaded';
  if (!engine.reapable) return 'this review engine build has no clean-up rules, so rebuild it';
  return inbox ? null : 'the MR list has not loaded yet';
}

async function gcRules(workspaces, stillGoing) {
  const repos = await engine.currentRepos();
  const pathOf = new Map(repos.map((r) => [r.label.toLowerCase(), r.path]));
  const queue = engine.loadQueue();
  return {
    knownRepoLabels: repos.map((r) => r.label),
    agentAlive: (label, iid) => workspaces.some((w) => isSameReview(reviewName(w), label, iid) && stillGoing(w)),
    pending: (label, iid) => queue.filter((c) => c.status === 'pending' && c.iid === iid && c.projectPath === pathOf.get(label.toLowerCase())).length,
    includeFinished: true,
  };
}

export async function reviewKeyOf() {
  const pathOf = new Map((await engine.currentRepos()).map((r) => [r.label.toLowerCase(), r.path]));
  return (w) => {
    const review = reviewName(w);
    const path = review && pathOf.get(review.repoLabel.toLowerCase());
    return path ? keyOf({ projectPath: path, iid: review.iid }) : null;
  };
}

function asMatrixWorkspace(w) {
  return { id: w.id, displayName: w.name, path: w.path, branch: w.branch, isMainWorktree: w.main };
}

function reviewName(w) {
  return w.branch || w.main ? null : engine.parseReviewName(w.name);
}

function isSameReview(review, label, iid) {
  return review?.iid === iid && review.repoLabel.toLowerCase() === label.toLowerCase();
}

function heldBack({ repoLabel, iid }, rules) {
  if (rules.agentAlive(repoLabel, iid)) return 'another review of this MR has not finished';
  const waiting = rules.pending(repoLabel, iid);
  return `${waiting} finding${waiting === 1 ? '' : 's'} still waiting to post`;
}

// Without the engine the exact name pattern is unknown, so anything named like a review is held back.
function looksLikeReview(w) {
  return !w.branch && !w.main && w.name.startsWith('review-');
}

export const ACTIONS = { review, approve, hold, post, 'post-all': postAll, discard, edit, level, pause, 'queue-finding': queueFinding };

export const ROUTES = {
  'GET /api/matrix/file': ({ query }) => readMrFile(query.get('key'), query.get('path'), query.get('folded') === '1'),
};
