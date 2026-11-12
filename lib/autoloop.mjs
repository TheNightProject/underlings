import { BAD_KEY, engine, failure, fetchError, freshInbox, inbox, MR_KEY, pollEveryMs, requireEngine, sendingNow, supports } from './engine.mjs';
import { KEY_PATTERN } from './ticketkeys.mjs';
import { APP_NAME, FOLDER } from './product.mjs';

const GENERATION = Symbol('autoloop generation');
const OWNER = FOLDER;
const TICK_MS = 5_000;
const STOP_WAIT_MS = 1_500;
const RECENT = 30;
const EDIT_MARK_MS = 90_000;
const TICKET_KEY = new RegExp(`^(?:ticket:)?${KEY_PATTERN}$`);
const fixedMr = (key) => key.replace(/^fix:/, '');
const STEPS = { poll: 'backgroundPoll', tick: 'backgroundTick' };
const NEEDS = ['takeAutoTurn', 'releaseAutoTurn', 'autoTurnHeld', 'readAutoDriver', 'backgroundPoll', 'backgroundTick', 'fencedPorts', 'reportLine', 'setEditing'];
export const EDITOR = `${FOLDER}:${process.pid}`;

let runner = null;
let shell = {};
let timers = {};
let retired = false;
const afterSteps = new Set();

export const ACTIONS = {};

export const ROUTES = {
  'GET /api/matrix/run': ({ query }) => readRun(query.get('key')),
  'POST /api/matrix/editing': async ({ body }) => markEditing(await body()),
};

// Takes the runner a reload carried over and starts nothing, so a start that fails later leaves the old code driving.
export function start(config, options) {
  shell = options;
  runner = options.carried?.autoloop ?? {
    seat: null, chain: Promise.resolve(), queued: new Set(), owner: null, busy: null, recent: [], problems: {},
    lastTurnAt: 0, lastTickAt: 0, lastPollAt: 0, shown: null,
  };
}

export function carry() {
  return runner;
}

// Keeps the carried runner's beat, so reloading the code never adds a turn or a tick, or brings a launch forward.
export function adopt() {
  if (retired) return;
  runner.owner = GENERATION;
  every('turn', turn, engine?.AUTO_BEAT_MS ?? TICK_MS, runner.lastTurnAt);
  every('tick', tick, TICK_MS, runner.lastTickAt);
  pollAfter(runner.lastPollAt);
}

// Only a real deactivate gets past the owner check; the code a reload replaces has a successor holding the runner.
export async function stop() {
  retired = true;
  for (const timer of Object.values(timers)) clearTimeout(timer);
  timers = {};
  if (runner?.owner !== GENERATION) return;
  runner.owner = null;
  const settled = await settledWithin(runner.chain, STOP_WAIT_MS);
  if (runner.seat && supports('releaseAutoTurn')) runner.seat = engine.releaseAutoTurn(runner.seat, { keepLock: !settled });
}

export function driverView() {
  const now = Date.now();
  const ready = readiness();
  const driver = supports('readAutoDriver') ? engine.readAutoDriver(now) : { holder: null, frontends: [], stateDir: null };
  const holder = driver.holder?.live ? driver.holder : null;
  return {
    state: stateOf(ready, held()),
    why: ready.ok ? waitingFor(holder) : ready.why,
    fix: ready.fix ?? null,
    holder: holder ? { owner: holder.owner, pid: holder.pid, since: holder.startedAt } : null,
    busy: runner?.busy ?? null,
    lastPollAt: runner?.lastPollAt || null,
    nextPollAt: runner?.lastPollAt ? runner.lastPollAt + pollInterval() : null,
    recent: runner?.recent ?? [],
    problems: Object.values(runner?.problems ?? {}).reduce((n, count) => n + count, 0),
    stateDir: driver.stateDir,
  };
}

function every(name, fn, ms, lastAt) {
  const body = safely(name, fn);
  timers[name] = later(() => {
    body();
    timers[name] = unref(setInterval(body, ms));
  }, lastAt + ms - Date.now());
}

function pollAfter(lastAt) {
  timers.poll = later(safely('poll', poll), lastAt + pollInterval() - Date.now());
}

function later(fn, ms) {
  return unref(setTimeout(fn, Math.max(0, ms)));
}

function unref(timer) {
  timer?.unref?.();
  return timer;
}

// Orca's plugin host exits on an unhandled rejection and counts it as a crash, so no timer body may throw or reject.
function safely(name, fn) {
  return () => {
    if (runner.owner !== GENERATION) return;
    try {
      Promise.resolve(fn()).catch((err) => problem(name, err));
    } catch (err) {
      problem(name, err);
    }
  };
}

function turn() {
  if (!supports('takeAutoTurn')) return;
  const now = Date.now();
  const ready = readiness();
  const result = engine.takeAutoTurn(runner.seat, { owner: OWNER, wants: ready.ok, why: ready.why, busy: Boolean(runner.busy) }, now);
  runner.seat = result.seat;
  runner.lastTurnAt = now;
  runner.problems.turn = 0;
  if (result.event) remember(sentence(result.event));
  const shown = `${result.held}|${ready.why}`;
  if (shown === runner.shown) return;
  runner.shown = shown;
  shell.notify?.('matrix');
}

function tick() {
  runner.lastTickAt = Date.now();
  if (held() && inbox?.me) enqueue('tick');
}

// Timed here rather than after each inbox fetch, so the clicks that refetch it never add launches beyond two a poll.
async function poll() {
  runner.lastPollAt = Date.now();
  try {
    await freshInbox(pollInterval() / 2);
    if (held() && inbox?.me && !fetchError) enqueue('poll');
  } finally {
    if (runner.owner === GENERATION) pollAfter(runner.lastPollAt);
  }
}

function enqueue(name) {
  if (runner.queued.has(name)) return;
  runner.queued.add(name);
  runner.chain = runner.chain.then(() => step(name)).catch((err) => problem(name, err));
}

async function step(name) {
  runner.queued.delete(name);
  if (!held() || !inbox?.me) return;
  runner.busy = { step: name, since: Date.now() };
  try {
    told(name, await engine[STEPS[name]](stepInput(), engine.fencedPorts(held)));
  } finally {
    runner.busy = null;
  }
}

// An inbox read by a build that did not pass the terminal list on must not read as one where every agent has gone.
function stepInput() {
  const listed = Array.isArray(inbox.terminals);
  return {
    mrs: inbox.mrs,
    me: inbox.me,
    terminals: listed ? inbox.terminals : [],
    terminalsError: listed ? inbox.terminalsError : 'the MR list was read before the engine was rebuilt',
    listedAt: inbox.listedAt,
    claimBy: `auto:${runner.seat.token}`,
  };
}

export function afterStep(fn) {
  afterSteps.add(fn);
  return () => afterSteps.delete(fn);
}

function told(name, report) {
  for (const fn of afterSteps) Promise.resolve().then(() => fn(report)).catch(() => {});
  const line = engine.reportLine(report);
  const errors = report?.errors ?? [];
  if (line) remember(sentence(line.replace(/^auto: /, '')));
  for (const error of errors) remember(error, true);
  runner.problems[name] = errors.length;
  if (line || errors.length || report?.captured) shell.notify?.('matrix');
}

function problem(name, err) {
  try {
    remember(err instanceof Error ? err.message : String(err), true);
    runner.problems[name] = (runner.problems[name] ?? 0) + 1;
    shell.notify?.('matrix');
  } catch {}
}

function remember(text, error = false) {
  const last = runner.recent[0];
  if (last?.text === text && last.error === error) {
    last.at = Date.now();
    last.times = (last.times ?? 1) + 1;
    return;
  }
  runner.recent.unshift({ at: Date.now(), text, error });
  runner.recent.length = Math.min(runner.recent.length, RECENT);
}

function held() {
  return runner?.owner === GENERATION && supports('autoTurnHeld') && engine.autoTurnHeld(runner.seat, Date.now());
}

function readiness() {
  if (!engine) return { ok: false, why: 'the review engine is not loaded', fix: 'rebuild' };
  const missing = NEEDS.filter((name) => !supports(name));
  if (missing.length) return { ok: false, why: `the review engine needs rebuilding: this build has no ${missing.join(', ')}`, fix: 'rebuild' };
  if (!launchRoot()) return { ok: false, why: 'there is no workspace root to launch reviews in', fix: 'settings' };
  if (!process.env.GITLAB_TOKEN) return { ok: false, why: 'GITLAB_TOKEN is not set', fix: 'token' };
  return { ok: true, why: `${APP_NAME} drives full auto` };
}

// The engine launches into this, so a blank one would put review workspaces wherever the worker happens to run.
function launchRoot() {
  return engine.loadSettings?.().workspaceRoot?.trim() || process.env.ORCA_WORKSPACE_ROOT || '';
}

function stateOf(ready, here) {
  if (!ready.ok) return 'stopped';
  return here ? 'here' : 'starting';
}

function waitingFor(holder) {
  if (held()) return `${APP_NAME} drives full auto`;
  if (holder && holder.pid !== process.pid) return `another worker (pid ${holder.pid}) drives full auto`;
  return runner?.seat?.probation ? 'taking over a full auto lock nobody was keeping' : 'taking the full auto lock';
}

function pollInterval() {
  return pollEveryMs(engine?.loadSettings?.() ?? {});
}

function settledWithin(promise, ms) {
  let timer;
  const late = new Promise((resolve) => { timer = setTimeout(resolve, ms, false); });
  return Promise.race([promise.then(() => true), late]).finally(() => clearTimeout(timer));
}

function sentence(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function readRun(key) {
  const { loadRuns } = requireEngine('loadRuns');
  if (typeof key !== 'string' || !(MR_KEY.test(fixedMr(key)) || TICKET_KEY.test(key))) throw failure(400, `${BAD_KEY}, either one after fix:, or ABC-123`);
  const found = loadRuns()[key];
  if (!found) throw failure(404, `no review run is recorded for ${key}`);
  const { status, startedAt, endedAt, capturedAt, terminal, worktreePath, tail } = found;
  return { key, status: status ?? null, startedAt, endedAt: endedAt ?? null, capturedAt: capturedAt ?? null, terminal: terminal ?? null, worktreePath: worktreePath ?? null, tail: tail ?? [] };
}

// The page never says how long: a mark is always 90 s from now, so a closed tab frees the item within that.
function markEditing({ id, editing } = {}) {
  const { setEditing, loadQueue } = requireEngine('setEditing', 'loadQueue');
  if (typeof id !== 'string' || !id) throw failure(400, 'editing takes { id, editing }');
  const item = loadQueue().find((c) => c.id === id);
  if (!item) throw failure(404, 'that item is not in the queue');
  if (item.status !== 'pending') throw failure(409, 'that item is not waiting to be posted any more');
  if (editing && item.sending) throw failure(409, sendingNow(id));
  setEditing(id, EDITOR, editing ? Date.now() + EDIT_MARK_MS : null);
  return { ok: true };
}
