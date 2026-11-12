import { existsSync } from 'node:fs';
import { basename, join } from 'node:path';
import { listAgents } from './claudeagents.mjs';
import { engine, failure, requireEngine, still, workspaceRoot } from './engine.mjs';
import { judgeReviews, reviewKeyOf } from './matrix.mjs';
import { git, listGitWorktrees, removeGitWorktree } from './worktrees.mjs';

const HOUR_MS = 36e5;
// A whole day, overnight included: anything shorter sweeps up an agent still waiting on you after a long meeting or a night's sleep.
const STALE_HOURS = 24;
// An agent that finished within the hour may be the one you are still reading.
const FINISHED_AFTER_MS = HOUR_MS;
// Ignored paths an install or a build puts back; any other ignored file may be the only copy.
const REGENERABLE = /^(node_modules|\.venv|venv|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache|\.next|\.turbo|dist|build|coverage|.+\.egg-info|\.DS_Store)$/;
const HANDLE = /^claude:[0-9a-f-]{36}$/;

export const ACTIONS = {
  'agent-remove': { verify: verifyRemoveAgent, run: removeAgent },
};

export async function planCleanup(config, now = Date.now()) {
  const { ctx, candidates } = await plan(config, now);
  return { staleHours: ctx.staleHours, candidates };
}

async function plan(config, now) {
  const ctx = await scan(config, now);
  const candidates = await Promise.all(ctx.workspaces.map((w) => candidateFor(w, ctx)));
  return { ctx, candidates: candidates.filter(Boolean) };
}

// Judged as clean-up judges them, so a run offers Remove only where clean-up would remove its workspace.
export async function planRunWorkspaces(config, now = Date.now()) {
  const runs = Object.values(requireEngine('loadRuns', 'currentRepos', 'parseReviewName').loadRuns());
  const ctx = await scan(config, now);
  const keyOf = await reviewKeyOf();
  const placed = await Promise.all(runs.map(async (run) => {
    const w = runWorkspace(run, ctx, keyOf);
    return w ? [run.key, await removalVerdict(w, ctx)] : null;
  }));
  return Object.fromEntries(placed.filter(Boolean));
}

// Each git worktree beside the repos is a workspace with the agents that work in it; an agent with no worktree is a workspace of its own.
async function scan(config, now) {
  const [worktrees, agents] = [await listGitWorktrees(workspaceRoot(config)), listAgents() ?? []];
  const paths = new Set(worktrees.map((w) => w.path));
  const workspaces = [
    ...worktrees.map((w) => worktreeWorkspace(w, agents.filter((a) => a.worktree === w.path))),
    ...agents.filter((a) => !paths.has(a.worktree)).map(agentWorkspace),
  ];
  const staleHours = config.staleHours ?? STALE_HOURS;
  const finished = (a) => completed(a) && Boolean(a.since) && now - a.since > FINISHED_AFTER_MS;
  const stillGoing = (w) => w.agents.some((a) => !finished(a));
  const ctx = { now, staleHours, staleMs: staleHours * HOUR_MS, workspaces, finished, stillGoing };
  ctx.judgeReview = await judgeReviews(workspaces, stillGoing);
  return ctx;
}

function worktreeWorkspace(w, agents) {
  const lastActivityAt = Math.max(w.activityAt ?? 0, ...agents.map((a) => a.lastAt ?? 0)) || null;
  return { id: w.path, name: basename(w.path), repo: w.repo, branch: w.branch, path: w.path, main: false, worktree: true, locked: w.locked, lastActivityAt, agents };
}

function agentWorkspace(a) {
  return { id: a.handle, name: a.name, repo: 'Claude Code', branch: '', path: a.cwd, main: false, worktree: false, locked: false, lastActivityAt: a.lastAt, agents: [a] };
}

function runWorkspace(run, ctx, keyOf) {
  return ctx.workspaces.find((w) => w.worktree && w.path === run.worktreePath)
    ?? ctx.workspaces.find((w) => w.id === run.terminal)
    ?? newest(ctx.workspaces.filter((w) => !w.worktree && keyOf(w) === run.key));
}

function newest(workspaces) {
  return workspaces.reduce((best, w) => (!best || (w.lastActivityAt ?? 0) > (best.lastActivityAt ?? 0) ? w : best), null);
}

async function removalVerdict(w, ctx) {
  const c = await candidateFor(w, ctx);
  const removable = c?.action === 'remove';
  return { id: w.id, name: w.name, removable, blocker: removable ? null : c?.blocker ?? staysBecause(w, ctx) };
}

function staysBecause(w, ctx) {
  if (w.agents.some((a) => a.state === 'working')) return 'an agent in it is still working';
  if (ctx.judgeReview(w)) return 'its agent is waiting on you or finished under an hour ago';
  return `it was used in the last ${ctx.staleHours} h`;
}

// A turn cut short by Stop, a crash or a provider error is not finished.
function completed(a) {
  return a.state === 'done' && (a.outcome ?? 'success') === 'success';
}

async function candidateFor(w, ctx) {
  const removal = await removalFor(w, ctx);
  const agents = closableAgents(w, ctx);
  const blocker = removal?.blocker ?? null;
  const base = { id: w.id, name: w.name, repo: w.repo, branch: w.branch || null, worktree: w.worktree, lastActivityAt: w.lastActivityAt, agents, blocker };
  if (removal && !blocker) return { ...base, action: 'remove', reasons: removal.reasons, suggested: !removal.waiting };
  if (agents.length) return { ...base, action: 'close-agents', reasons: [`${plural(agents.length, 'agent')} finished over an hour ago`], suggested: true };
  if (removal) return { ...base, action: 'keep', reasons: removal.reasons, suggested: false };
  return null;
}

// An agent-only workspace goes whole, so only a worktree that stays has its finished agents closed apart.
function closableAgents(w, ctx) {
  return w.worktree ? w.agents.filter(ctx.finished).map(({ handle, name }) => ({ handle, title: name })) : [];
}

async function removalFor(w, ctx) {
  if (w.agents.some((a) => a.state === 'working')) return null;
  const review = ctx.judgeReview(w);
  if (review) return ctx.stillGoing(w) ? null : withBlocker(w, { reasons: [review.reason ?? 'review agent finished'], blocker: review.blocker });
  const reasons = idleReasons(w, ctx);
  if (!reasons.length) return null;
  const waiting = w.agents.some((a) => !completed(a));
  return withBlocker(w, { reasons: waiting ? [...reasons, 'an agent is still waiting on you'] : reasons, blocker: null, waiting });
}

function idleReasons(w, ctx) {
  const quietMs = ctx.now - (w.lastActivityAt || 0);
  return [
    w.agents.length && w.agents.every(ctx.finished) ? 'every agent finished' : null,
    w.lastActivityAt && quietMs > ctx.staleMs ? `no activity for ${Math.floor(quietMs / HOUR_MS)} h` : null,
  ].filter(Boolean);
}

async function withBlocker(w, removal) {
  if (removal.blocker || !w.worktree) return removal;
  return { ...removal, blocker: w.locked ? 'git has it locked' : await checkoutBlocker(w.path) };
}

export async function checkoutBlocker(path) {
  try {
    return (await statusBlocker(path)) ?? (await hiddenEdits(path)) ?? (await unpushed(path));
  } catch (err) {
    return `git could not check it: ${firstLine(err.message)}`;
  }
}

async function statusBlocker(path) {
  const lines = (await git(path, 'status', '--porcelain', '--ignored')).split('\n').filter(Boolean);
  const changes = lines.filter((l) => !l.startsWith('!! ')).length;
  if (changes) return plural(changes, 'uncommitted change');
  const ignored = lines.map((l) => l.slice(3).replace(/^"|"$/g, '')).filter((p) => !regenerable(p));
  return ignored.length ? `${plural(ignored.length, 'ignored path')} git would delete: ${listed(ignored)}` : null;
}

function regenerable(path) {
  return REGENERABLE.test(path.replace(/\/$/, '').split('/').pop());
}

// git status cannot see edits to a file marked skip-worktree (S) or assume-unchanged (lower case).
async function hiddenEdits(path) {
  const flagged = (await git(path, 'ls-files', '-v')).split('\n').filter((l) => /^[Sa-z] /.test(l)).map((l) => l.slice(2));
  return flagged.length ? `${plural(flagged.length, 'file')} marked skip-worktree or assume-unchanged: ${listed(flagged)}` : null;
}

// Asking for commits on no remote branch at all covers pushed, merged and a detached checkout alike.
async function unpushed(path) {
  const count = Number((await git(path, 'rev-list', '--count', 'HEAD', '--not', '--remotes')).trim());
  return count ? `${plural(count, 'commit')} not pushed` : null;
}

// The worktree goes first, so an agent is forgotten only once git has let its checkout go.
async function removeWorkspace(w) {
  if (w.worktree) await removeGitWorktree(w.path);
  for (const a of w.agents) await engine.removeWorktree(a.handle);
}

export async function applyCleanup(config, { remove, close } = {}) {
  const ids = new Set(strings(remove));
  const handles = new Set(strings(close));
  if (!ids.size && !handles.size) throw new Error('nothing was ticked');
  requireEngine('removeWorktree');
  const { ctx, candidates } = await plan(config, Date.now());
  const tally = { removed: 0, closed: 0, failed: [], asked: ids.size + handles.size };
  for (const c of candidates) await settle(ctx.workspaces.find((w) => w.id === c.id), c, ids, handles, tally);
  return { ok: true, text: summary(tally), removed: tally.removed, closed: tally.closed, failed: tally.failed };
}

async function settle(w, c, ids, handles, tally) {
  if (c.action === 'remove' && ids.has(c.id)) return attempt(tally, 'removed', `remove ${c.name}`, () => removeWorkspace(w));
  for (const agent of c.agents.filter((a) => handles.has(a.handle))) {
    await attempt(tally, 'closed', `close ${agent.title} in ${c.name}`, () => engine.removeWorktree(agent.handle));
  }
}

async function attempt(tally, counter, what, action) {
  try {
    await action();
    tally[counter]++;
  } catch (err) {
    tally.failed.push(`${what}: ${firstLine(err.message).replace(/\.$/, '')}`);
  }
}

// One agent on its own, from its row: never while it runs, and its worktree only if git would lose nothing.
async function verifyRemoveAgent({ handle, expect }) {
  requireEngine('removeWorktree');
  if (typeof handle !== 'string' || !HANDLE.test(handle)) throw failure(400, 'handle must name a Claude Code agent');
  const agent = (listAgents() ?? []).find((a) => a.handle === handle);
  if (!agent) throw failure(404, 'that agent is not recorded any more');
  still(expect, { state: agent.state, since: agent.since }, `the agent ${agent.name}`);
  if (agent.alive) throw failure(409, `${agent.name} is still running, so stop it first`);
  const worktree = Boolean(agent.worktree) && existsSync(join(agent.worktree, '.git'));
  const blocker = worktree && (await checkoutBlocker(agent.worktree));
  if (blocker) throw failure(409, `${basename(agent.worktree)} stays: ${blocker}`);
  return { agent, worktree };
}

async function removeAgent({ handle }, { agent, worktree }) {
  if (worktree) await removeGitWorktree(agent.worktree);
  await engine.removeWorktree(handle);
  return worktree ? `Removed ${agent.name} and its worktree` : `Removed ${agent.name}`;
}

function summary({ removed, closed, failed, asked }) {
  const done = [removed && `removed ${plural(removed, 'workspace')}`, closed && `closed ${plural(closed, 'finished agent')}`].filter(Boolean);
  const leftAlone = asked - removed - closed - failed.length;
  return [
    done.length ? `${capitalise(done.join(' and '))}.` : 'Nothing was removed or closed.',
    ...failed.map((f) => `Could not ${f}.`),
    leftAlone ? `${leftAlone} had changed since the preview and ${leftAlone === 1 ? 'was' : 'were'} left alone.` : '',
  ].filter(Boolean).join(' ');
}

function listed(paths) {
  return paths.slice(0, 3).join(', ') + (paths.length > 3 ? ` and ${paths.length - 3} more` : '');
}

function firstLine(text) {
  return String(text).split('\n')[0];
}

function strings(list) {
  return Array.isArray(list) ? list.filter((x) => typeof x === 'string') : [];
}

function plural(n, word) {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function capitalise(text) {
  return text[0].toUpperCase() + text.slice(1);
}

export const ROUTES = {
  'GET /api/agents/cleanup': ({ config }) => planCleanup(config),
  'GET /api/matrix/run-workspaces': ({ config }) => planRunWorkspaces(config),
  'POST /api/agents/cleanup': async ({ config, body }) => applyCleanup(config, await body()),
};
