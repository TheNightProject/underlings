import {
  closeSync,
  existsSync,
  fstatSync,
  fsyncSync,
  linkSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { randomUUID } from 'node:crypto';
import {
  AUTO_FILE,
  QUEUE_ARCHIVE_FILE,
  QUEUE_FILE,
  GITHUB_REPO_CACHE_FILE,
  REPO_CACHE_FILE,
  RUNS_FILE,
  STATE_DIR,
  STATE_DIR_IS_DEFAULT,
  STATE_FILE,
} from '../config.js';
import { beingEdited, isDue } from '../auto/hold.js';
import {
  mrKey,
  ownWrites,
  type AutoMemory,
  type ExpiredReason,
  type Fingerprint,
  type OwnActivity,
  type OwnWrite,
  type QueuedComment,
  type ReviewRun,
  type Watch,
} from '../types.js';
import type { RepoSpec } from '../config.js';
import { everyEffortOf, modelsOf } from '../../../lib/modeltiers.mjs';
import { DEFAULT_SETTINGS, type Settings } from '../settings.js';

export const UNDER_TEST_RUNNER =
  Boolean(process.env['NODE_TEST_CONTEXT']) ||
  process.execArgv.includes('--test') ||
  /\.test\.[cm]?[jt]sx?$/.test(process.argv[1] ?? '');

/** A test that forgets UNDERLINGS_STATE_DIR would otherwise write its fixtures into your real queue. */
export function assertWritableState(): void {
  if (UNDER_TEST_RUNNER && STATE_DIR_IS_DEFAULT) {
    throw new Error(`refusing to write ${STATE_DIR} from a test: set UNDERLINGS_STATE_DIR before the store is imported`);
  }
}

export interface State {
  watches: Record<string, Watch>;
  /** Remembered layout choices, so a resize survives a restart. */
  prefs?: { panelRatio?: number };
  settings?: Partial<Settings>;
  /** Last fingerprint the user has actually looked at, per MR. */
  seen: Record<string, Fingerprint>;
  /**
   * How you finished a review, per MR. A hold cannot be read back as a decision: one is
   * placed automatically while a review runs, and GitLab reports it on the merge request
   * rather than per reviewer, so the only way to know you meant it is to write it down.
   */
  verdicts?: Record<string, { verdict: 'approved' | 'changes'; at: string; sha?: string | null }>;
  /** A change request a review you started placed, so posting the last of its findings may lift it. */
  reviewHolds?: Record<string, { at: string; sha: string | null }>;
}

// A test that never named its own state folder reads none, so the settings on this machine cannot steer it.
function readJson<T>(path: string, fallback: T): T {
  if (UNDER_TEST_RUNNER && STATE_DIR_IS_DEFAULT) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8')) as T;
  } catch {
    return fallback;
  }
}

/** Write through a temp file so a crash mid-write cannot truncate the queue. */
function writeJson(path: string, value: unknown): void {
  assertWritableState();
  mkdirSync(STATE_DIR, { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  renameSync(tmp, path);
}

/** Node has no synchronous sleep, and the lock loop must not yield to the event loop. */
function pause(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 30_000;

interface LockSeen {
  text: string;
  ino: number;
  at: number;
}

function lookAt(path: string): LockSeen | null {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
  try {
    const { ino, mtimeMs } = fstatSync(fd);
    return { text: readFileSync(fd, 'utf8'), ino, at: mtimeMs };
  } finally {
    closeSync(fd);
  }
}

function holderGone(text: string): boolean {
  const pid = Number(text.split(' ')[0]);
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ESRCH';
  }
}

// A lock written by an earlier build is empty, so only its age can say it was abandoned.
function isStale(seen: LockSeen): boolean {
  return holderGone(seen.text) || Date.now() - seen.at > LOCK_STALE_MS;
}

function tryTake(lock: string, text: string): LockSeen | null {
  let fd: number;
  try {
    fd = openSync(lock, 'wx');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw e;
  }
  try {
    writeFileSync(fd, text);
    return { text, ino: fstatSync(fd).ino, at: Date.now() };
  } finally {
    closeSync(fd);
  }
}

/** Moved aside before it is looked at, so one taken afresh since it was judged goes back to its holder. */
function moveAsideIf(lock: string, expected: LockSeen): void {
  const aside = `${lock}.${randomUUID()}`;
  try {
    renameSync(lock, aside);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw e;
  }
  const moved = lookAt(aside);
  if (moved && (moved.ino !== expected.ino || moved.text !== expected.text)) putBack(aside, lock);
  rmSync(aside, { force: true });
}

function putBack(aside: string, lock: string): void {
  try {
    linkSync(aside, lock);
  } catch {
    // Taken by a third writer in between, which now holds it.
  }
}

function acquire(lock: string, clearStale: (lock: string, seen: LockSeen) => void): LockSeen {
  const text = `${process.pid} ${randomUUID()}`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  for (;;) {
    const mine = tryTake(lock, text);
    if (mine) return mine;
    const seen = lookAt(lock);
    if (!seen) continue;
    if (isStale(seen)) clearStale(lock, seen);
    else if (Date.now() > deadline) throw new Error(`${lock} is still held after ${LOCK_WAIT_MS / 1000} s, so nothing was written`);
    else pause(25);
  }
}

/** Every removal goes through one remover at a time, so a lock cannot be taken between a removal's look and its unlink. */
function removeIf(lock: string, expected: LockSeen): void {
  const remover = `${lock}.remover`;
  const mine = acquire(remover, moveAsideIf);
  try {
    const now = lookAt(lock);
    if (now && now.ino === expected.ino && now.text === expected.text) rmSync(lock);
  } finally {
    moveAsideIf(remover, mine);
  }
}

/** Each agent's `underlings queue add` is a writer of its own, so without the lock a second read-change-write drops the first one's findings. */
function withLock<T>(path: string, fn: () => T): T {
  assertWritableState();
  mkdirSync(STATE_DIR, { recursive: true });
  const lock = `${path}.lock`;
  const mine = acquire(lock, removeIf);
  try {
    return fn();
  } finally {
    removeIf(lock, mine);
  }
}

/**
 * Spread, not rebuilt field by field: every caller writes back what it reads, so a field
 * this function forgets is a field the next save deletes.
 */
export function loadState(): State {
  // A fresh fallback each time: writers change what they load, and a shared one would carry it into the next load.
  const s = readJson<State>(STATE_FILE, { watches: {}, seen: {}, verdicts: {} });
  return {
    ...s,
    watches: s.watches ?? {},
    seen: s.seen ?? {},
    prefs: s.prefs ?? {},
    verdicts: s.verdicts ?? {},
  };
}

export function saveState(state: State): void {
  writeJson(STATE_FILE, state);
}

/** Every state.json writer goes through here, so a pause saved by another front end is never written over with an older copy. */
export function mutateState<T>(change: (state: State) => T): T {
  return withLock(STATE_FILE, () => {
    const state = loadState();
    const result = change(state);
    saveState(state);
    return result;
  });
}

function settingsOf(state: State): Settings {
  const saved = state.settings ?? {};
  return {
    ...DEFAULT_SETTINGS,
    ...saved,
    agents: { ...DEFAULT_SETTINGS.agents, ...saved.agents },
    jira: { ...DEFAULT_SETTINGS.jira, ...saved.jira },
    gitlab: { ...DEFAULT_SETTINGS.gitlab, ...saved.gitlab },
    github: { ...DEFAULT_SETTINGS.github, ...saved.github },
    tickets: { ...DEFAULT_SETTINGS.tickets, ...saved.tickets },
    models: modelsOf(saved.models),
    everyEffort: everyEffortOf(saved.everyEffort),
  };
}

export function loadSettings(): Settings {
  return settingsOf(loadState());
}

export function saveSettings(settings: Settings): void {
  mutateState((state) => {
    state.settings = settings;
  });
}

/** For a change made against what is on disk, such as the kill switch, rather than a copy read earlier. */
export function changeSettings(change: (settings: Settings) => Settings): Settings {
  return mutateState((state) => {
    const next = change(settingsOf(state));
    state.settings = next;
    return next;
  });
}

export function loadQueue(): QueuedComment[] {
  return readJson<QueuedComment[]>(QUEUE_FILE, []);
}

export function saveQueue(queue: QueuedComment[]): void {
  writeJson(QUEUE_FILE, queue);
}

export function addToQueue(
  items: Omit<QueuedComment, 'id' | 'createdAt' | 'status'>[],
): QueuedComment[] {
  const added = items.map((item) => ({
    ...item,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    status: 'pending' as const,
  }));
  withLock(QUEUE_FILE, () => saveQueue([...loadQueue(), ...added]));
  return added;
}

export function updateQueueItem(id: string, patch: Partial<QueuedComment>): void {
  withLock(QUEUE_FILE, () => {
    saveQueue(loadQueue().map((c) => (c.id === id ? { ...c, ...patch } : c)));
  });
}

/** Checked under the lock, so a send claimed in the meantime wins and the change is refused. */
export function changeUnsent(
  id: string,
  patch: Partial<QueuedComment> | ((item: QueuedComment) => Partial<QueuedComment> | null),
): boolean {
  return withLock(QUEUE_FILE, () => {
    const queue = loadQueue();
    const item = queue.find((c) => c.id === id);
    if (item?.status !== 'pending' || item.sending) return false;
    const change = typeof patch === 'function' ? patch(item) : patch;
    if (!change) return false;
    saveQueue(queue.map((c) => (c.id === id ? { ...c, ...change } : c)));
    return true;
  });
}

export const ALREADY_SENDING = 'already being sent';
export const INTERRUPTED = 'sending was interrupted, so check the MR before it goes again';

export type Claim = { item: QueuedComment } | { refused: string };

function claimRefusal(item: QueuedComment | undefined, queue: QueuedComment[], by: string, now: number): string | null {
  if (!item) return 'it is no longer in the queue';
  if (item.status === 'posted' || item.discussionId) return 'already posted';
  if (item.status === 'expired') return `it expired (${item.expiredReason ?? 'its MR closed'})`;
  if (item.status !== 'pending') return 'it was discarded';
  if (item.sending) return ALREADY_SENDING;
  if (beingEdited(item, now)) return 'it is being edited';
  if (by.startsWith('auto:') && !isDue(item, queue, now)) return 'it is not due';
  return null;
}

/** An `auto:` claim needs the item due; anything else only needs it pending. */
export function claimToSend(id: string, by: string, now: number): Claim {
  return withLock(QUEUE_FILE, () => {
    const queue = loadQueue();
    const item = queue.find((c) => c.id === id);
    const refused = claimRefusal(item, queue, by, now);
    if (refused || !item) return { refused: refused ?? 'it is no longer in the queue' };
    const claimed = { ...item, sending: { by, at: new Date(now).toISOString() } };
    saveQueue(queue.map((c) => (c.id === id ? claimed : c)));
    return { item: claimed };
  });
}

export function heldClaim(id: string, by: string): QueuedComment | null {
  const item = loadQueue().find((c) => c.id === id);
  return item?.status === 'pending' && item.sending?.by === by ? item : null;
}

export function releaseClaim(id: string, by: string): void {
  withLock(QUEUE_FILE, () => {
    const queue = loadQueue();
    if (!queue.some((c) => c.id === id && c.status === 'pending' && c.sending?.by === by)) return;
    saveQueue(queue.map((c) => (c.id === id ? { ...c, sending: undefined } : c)));
  });
}

function interrupted(item: QueuedComment): QueuedComment {
  const auto = item.auto ? { auto: { ...item.auto, held: INTERRUPTED } } : {};
  return { ...item, ...auto, sending: undefined, error: INTERRUPTED };
}

/** Claims nobody will finish: another driver's, or a manual one older than `maxAgeMs`. Handed back, never resent. */
export function takeBackClaims(by: string, now: number, maxAgeMs: number): QueuedComment[] {
  return withLock(QUEUE_FILE, () => {
    const queue = loadQueue();
    const abandoned = queue.filter(
      (c) =>
        c.status === 'pending' &&
        c.sending !== undefined &&
        c.sending.by !== by &&
        (c.sending.by.startsWith('auto:') || now - Date.parse(c.sending.at) > maxAgeMs),
    );
    if (abandoned.length === 0) return [];
    const ids = new Set(abandoned.map((c) => c.id));
    saveQueue(queue.map((c) => (ids.has(c.id) ? interrupted(c) : c)));
    return abandoned;
  });
}

/** A null `until` clears only your own mark, so closing one editor does not unguard another. */
export function setEditing(id: string, by: string, until: number | null): boolean {
  return withLock(QUEUE_FILE, () => {
    const queue = loadQueue();
    const item = queue.find((c) => c.id === id);
    if (item?.status !== 'pending') return false;
    if (until === null && item.editing?.by !== by) return true;
    const editing = until === null ? undefined : { by, until: new Date(until).toISOString() };
    saveQueue(queue.map((c) => (c.id === id ? { ...c, editing } : c)));
    return true;
  });
}

export function loadRuns(): Record<string, ReviewRun> {
  return readJson<Record<string, ReviewRun>>(RUNS_FILE, {});
}

export function runFor(key: string): ReviewRun | undefined {
  return loadRuns()[key];
}

/**
 * The journal of what each review agent actually did. Its own log goes when the agent is
 * removed, so a review whose findings never reached the queue would otherwise leave no
 * trace of having run at all.
 */
export function recordRun(key: string, patch: Partial<ReviewRun> & { webUrl?: string }): void {
  withLock(RUNS_FILE, () => {
    const runs = loadRuns();
    const prev = runs[key];
    runs[key] = {
      key,
      webUrl: patch.webUrl ?? prev?.webUrl ?? '',
      startedAt: prev?.startedAt ?? new Date().toISOString(),
      ...prev,
      ...patch,
    };
    writeJson(RUNS_FILE, runs);
  });
}

/** A manual claim older than this belongs to a Post that died part way, since every GitLab call gives up after 30 s. */
export const CLAIM_LIFE_MS = 3 * 60_000;

/** Read off the queue file, so a send or an edit in any front end or agent keeps the item where it is. */
function inUse(c: QueuedComment, now: number): boolean {
  const claimed = c.sending !== undefined && now - Date.parse(c.sending.at) < CLAIM_LIFE_MS;
  return claimed || beingEdited(c, now);
}

export function expireClosed(reasons: ReadonlyMap<string, ExpiredReason>): QueuedComment[] {
  return withLock(QUEUE_FILE, () => {
    const queue = loadQueue();
    const now = Date.now();
    const expiredAt = new Date(now).toISOString();
    const expired: QueuedComment[] = [];
    const next = queue.map((c) => {
      const expiredReason = reasons.get(mrKey(c));
      if (c.status !== 'pending' || !expiredReason || inUse(c, now)) return c;
      const item: QueuedComment = { ...c, status: 'expired', expiredAt, expiredReason };
      expired.push(item);
      return item;
    });
    if (expired.length > 0) saveQueue(next);
    return expired;
  });
}

/** Merged is final, so only what expired on a closed MR comes back when it reopens. */
export function reviveReopened(keys: ReadonlySet<string>): QueuedComment[] {
  return withLock(QUEUE_FILE, () => {
    const revived: QueuedComment[] = [];
    const next = loadQueue().map((c) => {
      if (c.status !== 'expired' || c.expiredReason !== 'MR closed' || !keys.has(mrKey(c))) return c;
      const { expiredAt: _at, expiredReason: _why, ...rest } = c;
      const item: QueuedComment = { ...rest, status: 'pending' };
      revived.push(item);
      return item;
    });
    if (revived.length > 0) saveQueue(next);
    return revived;
  });
}

export interface ArchivedComment extends QueuedComment {
  archivedAt: string;
  why: string;
}

function endsMidLine(fd: number): boolean {
  const size = fstatSync(fd).size;
  if (size === 0) return false;
  const last = Buffer.alloc(1);
  readSync(fd, last, 0, 1, size - 1);
  return last.toString() !== '\n';
}

// A line torn by a crash would otherwise swallow the first line written after it.
function appendArchive(lines: string): void {
  const fd = openSync(QUEUE_ARCHIVE_FILE, 'a+');
  try {
    writeFileSync(fd, endsMidLine(fd) ? `\n${lines}` : lines);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function matcher(select: readonly string[] | ((c: QueuedComment) => boolean)): (c: QueuedComment) => boolean {
  if (typeof select === 'function') return select;
  const ids = new Set(select);
  return (c) => ids.has(c.id);
}

/** The archive is flushed before the queue is rewritten, so a crash in between can only duplicate an item. */
export function archiveQueue(
  select: readonly string[] | ((c: QueuedComment) => boolean),
  why: string,
): QueuedComment[] {
  const chosen = matcher(select);
  return withLock(QUEUE_FILE, () => {
    const queue = loadQueue();
    const now = Date.now();
    const going = queue.filter((c) => c.status !== 'pending' && !inUse(c, now) && chosen(c));
    if (going.length === 0) return [];
    const archivedAt = new Date(now).toISOString();
    appendArchive(going.map((c) => `${JSON.stringify({ ...c, archivedAt, why })}\n`).join(''));
    const gone = new Set(going.map((c) => c.id));
    saveQueue(queue.filter((c) => !gone.has(c.id)));
    return going;
  });
}

function readArchive(): ArchivedComment[] {
  let text = '';
  try {
    text = readFileSync(QUEUE_ARCHIVE_FILE, 'utf8');
  } catch {
    return [];
  }
  const byId = new Map<string, ArchivedComment>();
  for (const line of text.split('\n')) {
    if (!line) continue;
    try {
      const item = JSON.parse(line) as ArchivedComment;
      if (item?.id) byId.set(item.id, item);
    } catch {
      // A line cut short by a crash mid-append was never confirmed, so it is skipped.
    }
  }
  return [...byId.values()].reverse();
}

/** Newest first. An item archived twice, after a crash, is listed once. */
export function loadArchive(page: { offset?: number; limit?: number } = {}): { total: number; items: ArchivedComment[] } {
  const offset = Math.max(0, page.offset ?? 0);
  const limit = Math.max(1, page.limit ?? 50);
  const all = readArchive().sort((a, b) => String(b.archivedAt).localeCompare(String(a.archivedAt)));
  return { total: all.length, items: all.slice(offset, offset + limit) };
}

export function pendingFor(queue: QueuedComment[], projectPath: string, iid: number): QueuedComment[] {
  return queue.filter(
    (c) => c.status === 'pending' && c.projectPath === projectPath && c.iid === iid,
  );
}

export function loadRepoCache(file = REPO_CACHE_FILE): RepoSpec[] | null {
  const cached = readJson<{ at: string; repos: RepoSpec[] } | null>(file, null);
  if (!cached) return null;
  const age = Date.now() - new Date(cached.at).getTime();
  if (age > 24 * 60 * 60 * 1000) return null;
  return cached.repos;
}

export function saveRepoCache(repos: RepoSpec[], file = REPO_CACHE_FILE): void {
  writeJson(file, { at: new Date().toISOString(), repos });
}

export const loadGithubRepoCache = (): RepoSpec[] | null => loadRepoCache(GITHUB_REPO_CACHE_FILE);
export const saveGithubRepoCache = (repos: RepoSpec[]): void => saveRepoCache(repos, GITHUB_REPO_CACHE_FILE);

/** Records which way you went, so the panel can say it without guessing from a hold. */
export function recordVerdict(key: string, verdict: 'approved' | 'changes', sha?: string | null): void {
  mutateState((state) => {
    const head = sha === undefined ? {} : { sha };
    state.verdicts = { ...(state.verdicts ?? {}), [key]: { verdict, at: new Date().toISOString(), ...head } };
  });
}

export function clearVerdict(key: string): void {
  mutateState((state) => {
    if (state.verdicts) delete state.verdicts[key];
  });
}

export function noteReviewHold(key: string, sha: string | null): void {
  mutateState((state) => {
    state.reviewHolds = { ...(state.reviewHolds ?? {}), [key]: { at: new Date().toISOString(), sha } };
  });
}

export function forgetReviewHold(key: string): void {
  mutateState((state) => {
    if (state.reviewHolds) delete state.reviewHolds[key];
  });
}

/** Called after every GitLab write the engine makes, from whichever front end. */
export function noteOwnActivity(projectId: number, iid: number, delta: Partial<OwnActivity>): void {
  const matches = (w: Watch): boolean => w.projectId === projectId && w.iid === iid;
  if (!Object.values(loadState().watches).some(matches)) return;
  mutateState((state) => {
    // Timed under the lock, so the writes stay in time order whichever process notes them.
    const write: OwnWrite = { at: Date.now(), notes: delta.notes ?? 0, unresolved: delta.unresolved ?? 0, approvals: delta.approvals ?? 0 };
    for (const watch of Object.values(state.watches)) {
      if (matches(watch)) watch.own = [...ownWrites(watch), write];
    }
  });
}

export function loadAutoMemory(): Record<string, AutoMemory> {
  return readJson<Record<string, AutoMemory>>(AUTO_FILE, {});
}

/** Locked, because the agent's `underlings queue done` writes here from its own process. */
export function updateAutoMemory(key: string, change: (m: AutoMemory) => AutoMemory): void {
  withLock(AUTO_FILE, () => {
    const all = loadAutoMemory();
    all[key] = change(all[key] ?? { key });
    writeJson(AUTO_FILE, all);
  });
}

export function markPassDone(passId: string): boolean {
  return withLock(AUTO_FILE, () => {
    const all = loadAutoMemory();
    const memory = Object.values(all).find((m) => m.pass?.id === passId);
    if (!memory?.pass || memory.pass.doneAt) return Boolean(memory?.pass);
    memory.pass.doneAt = new Date().toISOString();
    writeJson(AUTO_FILE, all);
    return true;
  });
}
