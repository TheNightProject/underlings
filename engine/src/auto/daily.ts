import { DAY_MS } from '../actions/watch.js';
import { reviewPrompt } from '../config.js';
import { mutateState } from '../data/store.js';
import { isOpen, mrKey, type Mr, type Watch } from '../types.js';
import { MAX_LAUNCHES_PER_POLL } from './config.js';
import { levelForMr } from './people.js';
import { giveBack, takeChange, type ReReviewReport } from './rereview.js';
import type { AutoContext, AutoPorts } from './ports.js';

// Full auto already reviews its authors' moves, and a second agent on one MR would queue the same findings twice.
function waits(mr: Mr, ctx: AutoContext): boolean {
  return Boolean(levelForMr(mr, ctx.me, ctx.config)) || Boolean(ctx.agentOn?.(mr));
}

/** Claimed under the state lock against the slot it was due in, so a day's look happens once whichever front end drives. */
function takeSlot(key: string, nextAt: string, now: number): boolean {
  return mutateState((state) => {
    const watch = state.watches[key];
    if (watch?.daily?.nextAt !== nextAt) return false;
    watch.daily = { nextAt: new Date(now + DAY_MS).toISOString() };
    return true;
  });
}

/** What Orca's daily automation did: look once a day, and run the review command only if the MR moved. */
export async function dailyReReviews(ctx: AutoContext, ports: AutoPorts, watches: Record<string, Watch>): Promise<ReReviewReport> {
  const report: ReReviewReport = { reReviewed: [], errors: [] };
  for (const mr of ctx.mrs) {
    if (report.reReviewed.length + report.errors.length >= MAX_LAUNCHES_PER_POLL || ports.paused()) break;
    const nextAt = watches[mrKey(mr)]?.daily?.nextAt;
    if (!nextAt || Date.parse(nextAt) > ports.now() || waits(mr, ctx)) continue;
    const fresh = await ports.freshMr(mr).catch(() => null);
    if (!fresh || !isOpen(fresh) || ports.paused() || !takeSlot(mrKey(mr), nextAt, ports.now())) continue;
    const before = takeChange(fresh, { autoOnly: false });
    if (!before) continue;
    try {
      await ports.launch({ ...fresh, repoLabel: mr.repoLabel }, reviewPrompt(mr.webUrl));
      report.reReviewed.push(mrKey(mr));
    } catch (e) {
      const error = e instanceof Error ? e.message : String(e);
      giveBack(fresh, before, error);
      report.errors.push(`daily re-review of ${mrKey(mr)}: ${error}`);
    }
  }
  return report;
}
