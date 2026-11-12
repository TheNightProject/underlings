import { launchReview, type LaunchOutcome } from '../actions/launch.js';
import { postOne } from '../actions/post.js';
import { recordReviewTerminal, watchForReview } from '../actions/watch.js';
import { forgeOf } from '../data/forge.js';
import { readTerminal } from '../agents/index.js';
import { changeSettings, loadQueue, loadSettings, recordRun, updateQueueItem } from '../data/store.js';
import type { Settings } from '../settings.js';
import { mrKey, type Mr } from '../types.js';
import { autoConfig } from './config.js';
import { diffStats } from './gates.js';
import { rearmed } from './hold.js';
import type { AutoPorts } from './ports.js';

/** The same steps `r` takes, so an auto review is watched, journalled and one per MR. */
export async function startAutoReview(mr: Mr, prompt: string, launch = launchReview): Promise<LaunchOutcome> {
  const key = mrKey(mr);
  watchForReview(mr);
  // The last run's terminal and workspace would otherwise have this run's output captured from them.
  recordRun(key, {
    webUrl: mr.webUrl,
    startedAt: new Date().toISOString(),
    status: 'launching',
    tail: [],
    terminal: undefined,
    worktreePath: undefined,
    capturedAt: undefined,
    endedAt: undefined,
  });
  try {
    const launched = await launch(mr, prompt);
    if (launched.handle) recordReviewTerminal(key, launched.handle);
    recordRun(key, {
      status: 'working',
      ...(launched.handle ? { terminal: launched.handle } : {}),
      ...(launched.path ? { worktreePath: launched.path } : {}),
    });
    return launched;
  } catch (e) {
    recordRun(key, { status: 'launch failed', tail: [e instanceof Error ? e.message : String(e)] });
    throw e;
  }
}

export const livePorts: AutoPorts = {
  launch: startAutoReview,
  freshMr: (ref) => forgeOf(ref).one(ref),
  discussions: (mr) => forgeOf(mr).discussions(mr),
  diffStats: async (mr) => {
    const { files, complete } = await forgeOf(mr).files(mr);
    return diffStats(files, complete);
  },
  changedPaths: async (mr, from, to) => (await forgeOf(mr).since(mr, from, to)).paths,
  post: postOne,
  resolve: (mr, discussionId) => forgeOf(mr).resolve(mr, discussionId, true),
  readTerminal: (handle) => readTerminal(handle),
  paused: () => loadSettings().autoPaused === true,
  now: () => Date.now(),
};

/** Flipped on what is on disk, under the state lock, so two front ends pressing it at once cannot cancel out unseen. */
export function toggleAutoPause(now = Date.now()): Settings {
  const next = changeSettings((settings) => ({ ...settings, autoPaused: !settings.autoPaused }));
  if (!next.autoPaused) {
    const { holdMs } = autoConfig(next);
    for (const { id, sendAt } of rearmed(loadQueue(), now, holdMs)) {
      const item = loadQueue().find((c) => c.id === id);
      if (item?.auto) updateQueueItem(id, { auto: { ...item.auto, sendAt } });
    }
  }
  return next;
}
