// A stand-in for the review engine: tests load it through loadEngine({ matrixEngine }) and steer it through world.
import { engine as loaded } from './engine.mjs';
import { keyOf, mrUrl } from './refs.mjs';

export const world = freshWorld();

export function freshWorld() {
  return {
    me: 'frank', mrs: [], discussions: {}, jobs: {}, queue: [], archive: [], memory: {}, settings: {}, watches: {}, runs: {}, calls: [], agents: [],
    terminals: [], terminalsError: undefined, lock: { holder: null, frontends: {} }, turns: [], step: null, tokens: 0, failTurn: null, ends: {}, rowFlags: {}, change: null,
  };
}

export function reset(changes = {}) {
  Object.assign(world, freshWorld(), changes);
}

export function mr(projectPath, iid, extra = {}) {
  return {
    projectPath, projectId: 7, repoLabel: projectPath.split('/').pop(), iid, title: `MR ${iid}`, webUrl: mrUrl({ projectPath, iid }, gitlabHost()),
    draft: false, conflicts: false, notes: 0, author: 'ivan', reviewers: ['frank'], approvedBy: [], pipeline: 'SUCCESS', mergeStatus: 'MERGEABLE',
    createdAt: '2026-11-01T09:00:00Z', updatedAt: '2026-11-05T09:00:00Z', sha: 'aaa111', sourceBranch: `feat/${iid}`, ticket: 'ABC-1', unresolvedThreads: 0,
    ...extra,
  };
}

export async function fetchInbox() {
  world.calls.push(['fetchInbox']);
  return {
    me: world.me, repoCount: 1, mrs: world.mrs.map((m) => ({ ...m })), agents: new Map(), threads: new Map(), fetchedAt: new Date().toISOString(),
    terminals: world.terminals, terminalsError: world.terminalsError, listedAt: Date.now(),
  };
}

export function rowsFor(inbox) {
  return inbox.mrs.map((m) => ({ mr: m, key: keyOf(m), flags: world.rowFlags[keyOf(m)] ?? {}, phase: 'open', count: 0, mood: 'quiet', verdict: null }));
}

export const loadSettings = () => world.settings;
export const gitlabHost = () => world.settings?.gitlab?.host ?? 'https://gitlab.com';

// As the engine reads a ticket template, so a test can give one in world.settings.jira.
export function ticketTemplateOf(text) {
  const lines = String(text ?? '').split('\n').map((line) => line.trim()).filter(Boolean);
  return { headings: lines.filter((l) => l.startsWith('#')).map((l) => l.replace(/^#+\s*/, '')), guidance: lines.filter((l) => !l.startsWith('#')).join(' ') };
}
export const claudeBinary = () => process.env.UNDERLINGS_CLAUDE_BIN || 'claude';
export const childEnv = (bin, env = process.env) => ({ ...env });
export const loadState = () => ({ watches: world.watches, settings: world.settings });
export const loadQueue = () => world.queue;
export const loadArchive = ({ offset = 0, limit = 50 } = {}) => ({ total: world.archive.length, items: world.archive.slice(offset, offset + limit) });
export const loadRuns = () => world.runs;
export const loadAutoMemory = () => world.memory;
export const parsePeople = () => [];
export const claudeAgents = () => world.agents;
export const roster = () => [];

export async function fetchOneMr(projectPath, iid) {
  world.calls.push(['fetchOneMr', projectPath, iid]);
  const found = world.mrs.find((m) => m.projectPath === projectPath && m.iid === iid);
  return found ? { ...found } : null;
}

export async function fetchMrEnd(projectPath, iid) {
  world.calls.push(['fetchMrEnd', projectPath, iid]);
  return world.ends[keyOf({ projectPath, iid })] ?? { state: 'opened', mergedBy: null };
}

export async function fetchDiscussions(projectId, iid) {
  world.calls.push(['fetchDiscussions', projectId, iid]);
  return world.discussions[iid] ?? [];
}

export async function fetchPipelineJobs(projectId, sha) {
  world.calls.push(['fetchPipelineJobs', projectId, sha]);
  return world.jobs[sha] ?? [];
}

// The forge method to the old export it stands for, in the GitLab adapter's argument order.
const GITLAB_CALLS = {
  one: ['fetchOneMr', (r) => [r.projectPath, r.iid]],
  end: ['fetchMrEnd', (r) => [r.projectPath, r.iid]],
  detail: ['fetchMrDetail', (r) => [r.projectId, r.iid]],
  branchFacts: ['fetchBranchFacts', (r) => [r.projectId, r.iid]],
  discussions: ['fetchDiscussions', (r) => [r.projectId, r.iid]],
  files: ['fetchMrFiles', (r) => [r.projectId, r.iid]],
  since: ['fetchSince', (r, from, to) => [r.projectId, from, to]],
  checks: ['fetchPipelineJobs', (r, sha) => [r.projectId, sha]],
  jobLog: ['fetchJobTrace', (r, jobId, lines) => [r.projectId, jobId, lines]],
  retryJob: ['retryJob', (r, jobId) => [r.projectId, jobId]],
  retryChecks: ['retryPipeline', (r, pipelineId) => [r.projectId, pipelineId]],
  reply: ['replyToDiscussion', (r, threadId, body) => [r.projectId, r.iid, threadId, body]],
  resolve: ['setDiscussionResolved', (r, threadId, resolved) => [r.projectId, r.iid, threadId, resolved]],
  merge: ['mergeMr', (r, how) => [r.projectId, r.iid, how]],
  cancelAutoMerge: ['cancelAutoMerge', (r) => [r.projectId, r.iid]],
  rebase: ['rebaseMr', (r) => [r.projectId, r.iid]],
  rebaseState: ['rebaseState', (r) => [r.projectId, r.iid]],
  ready: ['setDraft', (r) => [r.projectPath, r.iid, false]],
  setReviewers: ['setReviewers', (r, names) => [r.projectId, r.iid, names]],
  rerequest: ['rerequestReview', (r, name) => [r.projectPath, r.iid, name]],
  myName: ['fetchMyName', () => []],
};
const CAPS = { hold: true, withdrawApproval: true, rebase: true, autoMerge: true, jobLogs: true, retry: true, todos: true };

// Built over the engine the worker has loaded, so a test's own fetchOneMr is the one asked, and a call it leaves out reads as an older build.
export function forgeOf() {
  const forge = { id: 'gitlab', name: 'GitLab', caps: CAPS };
  for (const [method, [name, args]] of Object.entries(GITLAB_CALLS)) {
    if (typeof loaded?.[name] === 'function') forge[method] = (...given) => loaded[name](...args(...given));
  }
  return forge;
}

export function awaitsYou(discussion, me) {
  if (!discussion || discussion.resolved || discussion.notes.length < 2) return false;
  return discussion.notes[discussion.notes.length - 1]?.author !== me;
}

// The lock as the engine keeps it on disk, held in world.lock so a test can plant a stale or a live holder.
export const AUTO_BEAT_MS = 5000;
const STALE_MS = 30_000;
const CONFIRM_MS = 5000;
const HOLD_MS = 15_000;

const cleared = (seat) => ({ ...seat, token: null, beatOkAt: null, probation: false, yielding: false, staleSeen: null });

export function takeAutoTurn(seat, intent, now) {
  if (world.failTurn) throw new Error(world.failTurn);
  world.turns.push({ now, intent, token: seat?.token ?? null });
  const mine = seat ?? { owner: intent.owner, pid: process.pid, startedAt: now, token: null, beatOkAt: null, probation: false, yielding: false, staleSeen: null };
  world.lock.frontends[`${mine.owner}-${mine.pid}`] = { owner: mine.owner, pid: mine.pid, ppid: process.ppid, wants: intent.wants, why: intent.why, beatAt: now };
  const holder = world.lock.holder;
  if (mine.token && holder?.token !== mine.token) return { seat: cleared(mine), held: false, event: holder ? `${holder.owner} pid ${holder.pid} took over` : 'the full auto lock was removed' };
  if (mine.token && !intent.wants) return stepAside(mine, intent, now);
  if (mine.token) {
    holder.beatAt = now;
    const next = { ...mine, beatOkAt: now, probation: false, yielding: false };
    return { seat: next, held: true, event: null };
  }
  if (!intent.wants) return { seat: mine, held: false, event: null };
  if (!holder) return claim(mine, now, false, 'took the full auto lock');
  if (now - holder.beatAt <= STALE_MS) return { seat: { ...mine, staleSeen: null }, held: false, event: null };
  const mark = `${holder.token}@${holder.beatAt}`;
  if (mine.staleSeen?.mark === mark && now - mine.staleSeen.at >= CONFIRM_MS) return claim(mine, now, true, `took over full auto from ${holder.owner} pid ${holder.pid}`);
  return { seat: { ...mine, staleSeen: mine.staleSeen?.mark === mark ? mine.staleSeen : { mark, at: now } }, held: false, event: null };
}

function claim(seat, now, probation, event) {
  world.tokens += 1;
  const token = `token-${world.tokens}`;
  world.lock.holder = { v: 1, owner: seat.owner, pid: seat.pid, token, startedAt: now, beatAt: now };
  return { seat: { ...seat, token, beatOkAt: now, probation, yielding: false, staleSeen: null }, held: !probation, event };
}

function stepAside(seat, intent, now) {
  if (intent.busy) {
    world.lock.holder.beatAt = now;
    return { seat: { ...seat, beatOkAt: now, yielding: true }, held: false, event: null };
  }
  world.lock.holder = null;
  return { seat: cleared(seat), held: false, event: 'handed full auto over' };
}

export function autoTurnHeld(seat, now) {
  return Boolean(seat?.token && !seat.probation && !seat.yielding && seat.beatOkAt !== null && now - seat.beatOkAt < HOLD_MS);
}

export function releaseAutoTurn(seat, { keepLock = false } = {}) {
  world.calls.push(['releaseAutoTurn', seat.token, keepLock]);
  if (!keepLock && world.lock.holder?.token === seat.token) world.lock.holder = null;
  delete world.lock.frontends[`${seat.owner}-${seat.pid}`];
  return cleared(seat);
}

export function readAutoDriver(now) {
  const holder = world.lock.holder;
  return {
    holder: holder ? { ...holder, live: now - holder.beatAt <= STALE_MS } : null,
    frontends: Object.values(world.lock.frontends).map((f) => ({ v: 1, ...f, live: now - f.beatAt < STALE_MS })),
    stateDir: '/state/thematrix',
  };
}

const emptyReport = () => ({ launched: [], reReviewed: [], sent: 0, held: 0, captured: 0, errors: [] });

export function backgroundPoll(input, ports) {
  return step('backgroundPoll', input, ports);
}

export function backgroundTick(input, ports) {
  return step('backgroundTick', input, ports);
}

async function step(name, input, ports) {
  world.calls.push([name, input, ports.held()]);
  return { ...emptyReport(), ...(await world.step?.(name, input, ports)) };
}

export function fencedPorts(held) {
  return { held, paused: () => Boolean(world.settings.autoPaused) || !held() };
}

export function reportLine(report) {
  const parts = [
    ...(report.launched ?? []).map((key) => `reviewing ${key}`),
    ...(report.reReviewed ?? []).map((key) => `re-reviewing ${key}`),
    ...(report.sent ? [`sent ${report.sent}`] : []),
    ...(report.held ? [`${report.held} handed back to you`] : []),
  ];
  return parts.length ? `auto: ${parts.join(', ')}` : null;
}

export function setEditing(id, by, until) {
  world.calls.push(['setEditing', id, by, until]);
  const item = world.queue.find((c) => c.id === id);
  if (item?.status !== 'pending') return false;
  if (until === null && item.editing?.by !== by) return true;
  item.editing = until === null ? undefined : { by, until: new Date(until).toISOString() };
  return true;
}

// The engine's one-agent rule: a live agent on the watch or the run, or a run still launching or started since the agents were listed.
export function agentOnFor(watches, runs, terminals, { listedAt, now = Date.now() } = {}) {
  const alive = new Set(terminals.filter((t) => t.agent && t.connected && !t.orphaned).map((t) => t.handle));
  return (m) => {
    const key = keyOf(m);
    const run = runs[key];
    const started = Date.parse(run?.startedAt);
    if (run?.status === 'launching' && now - started < 300_000) return true;
    if ((run?.status === 'working' || run?.status === 'idle') && listedAt !== undefined && started >= listedAt) return true;
    return [watches[key]?.terminal, run?.terminal].some((t) => t !== undefined && alive.has(t));
  };
}
