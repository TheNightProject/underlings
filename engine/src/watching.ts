import { forgeOf } from './data/forge.js';
import { movedSince } from './auto/rereview.js';
import type { AgentState } from './review.js';
import { mrKey, type Mr, type Watch } from './types.js';

export interface WatchRow {
  watch: Watch;
  repoLabel: string;
  /** False once the merge request has left the open list: merged, closed, or out of scope. */
  stillOpen: boolean;
  /** It has moved since you last acknowledged it. */
  moved: boolean;
  /** What the review agent for it is doing, if there is still one. */
  agent?: 'working' | 'idle';
}

/** Every watch, whether or not its merge request is still in the list. */
export function watchRows(
  watches: Record<string, Watch>,
  mrs: Mr[],
  agents: Map<string, AgentState>,
): WatchRow[] {
  const byKey = new Map(mrs.map((m) => [mrKey(m), m]));
  return Object.values(watches)
    .map((watch) => {
      const mr = byKey.get(watch.key);
      const agent = watch.terminal ? agents.get(watch.terminal) : undefined;
      return {
        watch,
        ...(agent?.alive ? { agent: agent.working ? ('working' as const) : ('idle' as const) } : {}),
        repoLabel: mr?.repoLabel ?? watch.projectPath.split('/').pop() ?? watch.projectPath,
        stillOpen: mr !== undefined,
        moved: mr ? movedSince(watch, mr) : false,
      };
    })
    // The ones that act on their own first, then the ones that have something to say.
    .sort((a, b) => {
      const rank = (r: WatchRow): number =>
        r.watch.auto ? 0 : r.agent ? 1 : !r.stillOpen ? 2 : r.moved ? 3 : 4;
      return rank(a) - rank(b) || a.repoLabel.localeCompare(b.repoLabel);
    });
}

// A repo whose query failed drops its MRs from the open list too, so only GitLab can say a watched MR has gone.
export async function hasClosed(watch: Pick<Watch, 'provider' | 'projectPath' | 'iid'>): Promise<boolean> {
  const state = await forgeOf(watch).state(watch);
  return state === null || state === 'merged' || state === 'closed';
}
