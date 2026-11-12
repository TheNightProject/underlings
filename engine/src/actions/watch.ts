import { loadSettings, loadState, mutateState } from '../data/store.js';
import { fingerprint, mrKey, ownWrites, type Mr, type OwnWrite, type Watch } from '../types.js';

export const DAY_MS = 24 * 60 * 60_000;

export function isWatched(key: string): boolean {
  return Boolean(loadState().watches[key]);
}

/** The baseline is what auto re-review compares against, so the engine's own writes this copy already shows go with it. */
export function setBaseline(watch: Watch, mr: Mr): void {
  const readAt = mr.readAt ?? Date.now();
  const unshown = ownWrites(watch)
    .filter((w) => w.at >= readAt)
    .map((w): OwnWrite => ({ ...w, maybeSeen: true }));
  watch.projectId = mr.projectId;
  watch.seen = fingerprint(mr);
  watch.seenAt = readAt;
  if (unshown.length > 0) watch.own = unshown;
  else delete watch.own;
}

export function toggleWatch(mr: Mr): boolean {
  return mutateState((state) => {
    const key = mrKey(mr);
    if (state.watches[key]) {
      delete state.watches[key];
      return false;
    }
    const watch: Watch = {
      ...(mr.provider ? { provider: mr.provider } : {}),
      key,
      projectPath: mr.projectPath,
      iid: mr.iid,
      webUrl: mr.webUrl,
      auto: false,
      seen: fingerprint(mr),
      addedAt: new Date().toISOString(),
    };
    setBaseline(watch, mr);
    state.watches[key] = watch;
    return true;
  });
}

/**
 * Stop watching by key, which is the only handle left once the merge request has merged
 * or closed and dropped out of the list. toggleWatch needs the Mr itself, so it cannot
 * reach the ones most worth clearing out.
 */
export function stopWatching(key: string): boolean {
  return mutateState((state) => {
    if (!state.watches[key]) return false;
    delete state.watches[key];
    return true;
  });
}

/** A review starts its watch, with what you reviewed as the baseline, so a later ◆ means the MR moved under your review. */
export function watchForReview(mr: Mr, terminal?: string): { alreadyWatched: boolean } {
  return mutateState((state) => {
    const key = mrKey(mr);
    const existing = state.watches[key];
    const watch: Watch = {
      key,
      projectPath: mr.projectPath,
      iid: mr.iid,
      webUrl: mr.webUrl,
      auto: existing?.auto ?? loadSettings().reReviewOnChange !== false,
      ...(existing?.automation ? { automation: existing.automation } : {}),
      ...(existing?.daily ? { daily: existing.daily } : {}),
      seen: fingerprint(mr),
      addedAt: existing?.addedAt ?? new Date().toISOString(),
      reviewedAt: new Date().toISOString(),
      ...(terminal ? { terminal } : existing?.terminal ? { terminal: existing.terminal } : {}),
      ...(existing?.own ? { own: existing.own } : {}),
    };
    setBaseline(watch, mr);
    state.watches[key] = watch;
    return { alreadyWatched: Boolean(existing) };
  });
}

/** Recorded after the launch returns, so the poller can read the agent's state back. */
export function recordReviewTerminal(key: string, terminal: string): void {
  mutateState((state) => {
    const watch = state.watches[key];
    if (watch) watch.terminal = terminal;
  });
}

export function setAuto(key: string, auto: boolean): void {
  mutateState((state) => {
    const watch = state.watches[key];
    if (watch) watch.auto = auto;
  });
}

function changeWatch<T>(key: string, change: (watch: Watch) => T): T {
  return mutateState((state) => {
    const watch = state.watches[key];
    if (!watch) throw new Error(`${key} is not being watched`);
    return change(watch);
  });
}

/** The first look is a day from now, and each look launches a review only if the MR moved since the last. */
export function scheduleReReview(mr: Mr, now = Date.now()): string {
  return changeWatch(mrKey(mr), (watch) => {
    watch.daily = { nextAt: new Date(now + DAY_MS).toISOString() };
    return watch.daily.nextAt;
  });
}

export function unscheduleReReview(key: string): void {
  mutateState((state) => {
    delete state.watches[key]?.daily;
  });
}

/** The Orca automation is left for you to delete in Orca, so this says which one it was. */
export function moveAutomation(key: string, now = Date.now()): string {
  return changeWatch(key, (watch) => {
    const name = watch.automation;
    if (!name) throw new Error(`${key} has no daily re-review in Orca`);
    watch.daily ??= { nextAt: new Date(now + DAY_MS).toISOString() };
    delete watch.automation;
    return name;
  });
}

/** Mark everything the user is looking at as seen, clearing the changed markers. */
export function markSeen(mrs: Mr[]): void {
  if (mrs.length === 0) return;
  mutateState((state) => {
    for (const mr of mrs) {
      const watch = state.watches[mrKey(mr)];
      if (watch) setBaseline(watch, mr);
      state.seen[mrKey(mr)] = fingerprint(mr);
    }
  });
}
