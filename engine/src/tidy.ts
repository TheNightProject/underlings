import { forgeOf, type MrState } from './data/forge.js';
import { expireClosed, loadQueue, reviveReopened } from './data/store.js';
import { mrKey, type ExpiredReason, type Mr, type QueuedComment } from './types.js';

const RECHECK_MS = 60 * 60 * 1000;
const ASKS_PER_ROUND = 16;
const ASKING_AT_ONCE = 4;
const FIXTURE_PREFIX = 'acme/';
const FIXTURE_PATHS = new Set(['acme', 'a/b']);
const FIXTURE_HOST = 'https://gitlab.example/';

type MrRef = Pick<QueuedComment, 'projectPath' | 'iid'>;
export type AskState = (projectPath: string, iid: number) => Promise<MrState | null>;

interface Known {
  state: MrState | null;
  at: number;
}

const known = new Map<string, Known>();

/** The paths and host every test in the engine and the app makes its fixtures from. */
export function isTestData(c: Pick<QueuedComment, 'projectPath' | 'webUrl'>): boolean {
  const path = c.projectPath;
  return FIXTURE_PATHS.has(path) || path.startsWith(FIXTURE_PREFIX) || String(c.webUrl ?? '').startsWith(FIXTURE_HOST);
}

/** GitLab answering with no MR at all means it is gone, which is how hasClosed reads it too. */
export function reasonFor(state: MrState | null | undefined): ExpiredReason | null {
  if (state === 'merged') return 'MR merged';
  if (state === 'closed' || state === null) return 'MR closed';
  return null;
}

export function knownReason(key: string): ExpiredReason | null {
  const entry = known.get(key);
  return entry ? reasonFor(entry.state) : null;
}

export function forgetStates(): void {
  known.clear();
}

function due(key: string, now: number): boolean {
  const entry = known.get(key);
  return !entry || (entry.state !== 'merged' && now - entry.at >= RECHECK_MS);
}

async function askEach(refs: MrRef[], ask: AskState, now: number): Promise<string[]> {
  const failed: string[] = [];
  for (let i = 0; i < refs.length; i += ASKING_AT_ONCE) {
    const batch = refs.slice(i, i + ASKING_AT_ONCE);
    const answers = await Promise.allSettled(batch.map((r) => ask(r.projectPath, r.iid)));
    answers.forEach((answer, n) => {
      const key = mrKey(batch[n] as MrRef);
      if (answer.status === 'fulfilled') known.set(key, { state: answer.value, at: now });
      else failed.push(`${key}: ${answer.reason instanceof Error ? answer.reason.message : String(answer.reason)}`);
    });
  }
  return failed;
}

export interface StateCheck {
  asked: number;
  failed: string[];
}

/** A merged MR never reopens, so only the other answers are asked again, at most hourly. */
export async function checkStates(
  refs: MrRef[],
  options: { ask?: AskState; now?: number; limit?: number } = {},
): Promise<StateCheck> {
  const now = options.now ?? Date.now();
  const asking = refs.filter((r) => due(mrKey(r), now)).slice(0, options.limit ?? ASKS_PER_ROUND);
  const failed = await askEach(asking, options.ask ?? askForge, now);
  return { asked: asking.length, failed };
}

async function askForge(projectPath: string, iid: number): Promise<MrState | null> {
  const ref = { projectPath, iid };
  return forgeOf(ref).state(ref);
}

// Those with something still pending come first, since only they can be expired.
function missingFromList(queue: QueuedComment[], open: ReadonlySet<string>): MrRef[] {
  const refs = new Map<string, MrRef & { pending: boolean }>();
  for (const c of queue) {
    const key = mrKey(c);
    if (open.has(key) || isTestData(c)) continue;
    const pending = c.status === 'pending' || Boolean(refs.get(key)?.pending);
    refs.set(key, { projectPath: c.projectPath, iid: c.iid, pending });
  }
  return [...refs.values()].sort((a, b) => Number(b.pending) - Number(a.pending));
}

function reasonOf(c: QueuedComment): ExpiredReason | null {
  return isTestData(c) ? 'test data' : knownReason(mrKey(c));
}

export interface TidyReport extends StateCheck {
  expired: QueuedComment[];
  revived: QueuedComment[];
}

const openAgain = (key: string, open: ReadonlySet<string>): boolean =>
  open.has(key) || (known.has(key) && knownReason(key) === null);

function reopened(queue: QueuedComment[], open: ReadonlySet<string>): Set<string> {
  const keys = new Set<string>();
  for (const c of queue) {
    if (c.expiredReason === 'MR closed' && c.status === 'expired' && openAgain(mrKey(c), open)) keys.add(mrKey(c));
  }
  return keys;
}

function closedReasons(queue: QueuedComment[], open: ReadonlySet<string>): Map<string, ExpiredReason> {
  const reasons = new Map<string, ExpiredReason>();
  for (const c of queue) {
    const reason = c.status === 'pending' && !open.has(mrKey(c)) ? reasonOf(c) : null;
    if (reason) reasons.set(mrKey(c), reason);
  }
  return reasons;
}

/** Asks GitLab about the queued MRs missing from the open list, expires what is pending on those that closed, and brings back what a reopened one lost. */
export async function tidyQueue(
  openMrs: Mr[],
  options: { ask?: AskState; now?: number; limit?: number } = {},
): Promise<TidyReport> {
  const open = new Set(openMrs.map(mrKey));
  const queue = loadQueue();
  const check = await checkStates(missingFromList(queue, open), options);
  const back = reopened(queue, open);
  const revived = back.size > 0 ? reviveReopened(back) : [];
  const reasons = closedReasons(queue, open);
  const expired = reasons.size > 0 ? expireClosed(reasons) : [];
  return { ...check, expired, revived };
}

export interface ArchiveGroup {
  key: string;
  /** null until GitLab has said the MR is merged or closed. */
  why: ExpiredReason | null;
  ids: string[];
}

export function archivable(queue: QueuedComment[], openMrs: Mr[]): ArchiveGroup[] {
  const open = new Set(openMrs.map(mrKey));
  const groups = new Map<string, ArchiveGroup>();
  for (const c of queue) {
    const key = mrKey(c);
    if (c.status === 'pending' || open.has(key)) continue;
    const group = groups.get(key) ?? { key, why: reasonOf(c), ids: [] };
    group.ids.push(c.id);
    groups.set(key, group);
  }
  return [...groups.values()];
}
