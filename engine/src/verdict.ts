import { setApproved } from './commands.js';
import { forgeOf, needs } from './data/forge.js';
import { agentWorking, type AgentTerminal, type Workspace } from './agents/host.js';
import { listAgentTerminals, listWorktrees, removeWorktree } from './agents/index.js';
import { changeUnsent, forgetReviewHold, loadQueue, loadSettings, loadState, recordVerdict } from './data/store.js';
import { workspaceForReview } from './gc.js';
import { mrKey, type Mr } from './types.js';

export type Verdict = 'approve' | 'changes';

export const CHANGES_NOTE = "My comments are up and need addressing, so I've requested changes until they are.";

export interface WorkspacePorts {
  listWorktrees: () => Promise<Workspace[]>;
  removeWorktree: (id: string) => Promise<void>;
  listAgentTerminals: () => Promise<AgentTerminal[]>;
}

const HOSTS: WorkspacePorts = { listWorktrees, removeWorktree, listAgentTerminals };

export interface DecideOptions {
  /** Approving twice is a GitLab error, so an MR you already approved only has its verdict recorded. */
  me?: string;
  hosts?: WorkspacePorts;
}

export interface Decision {
  liftedHold: boolean;
  warning?: string;
  /** kept says why a workspace that would have closed is still open. */
  workspace: { closed: boolean; kept?: string };
}

export async function decide(mr: Mr, verdict: Verdict, { me, hosts = HOSTS }: DecideOptions = {}): Promise<Decision> {
  const outcome = verdict === 'approve' ? await approve(mr, me) : await requestChanges(mr);
  recordVerdict(mrKey(mr), verdict === 'approve' ? 'approved' : 'changes', mr.sha);
  forgetReviewHold(mrKey(mr));
  dropQueuedVerdicts(mrKey(mr));
  return { ...outcome, workspace: await closeReviewWorkspace(mr, hosts) };
}

/** Your own decision stands, so a verdict full auto queued on the MR never follows it. */
function dropQueuedVerdicts(key: string): void {
  for (const c of loadQueue()) {
    if (c.kind === 'verdict' && c.status === 'pending' && mrKey(c) === key) changeUnsent(c.id, { status: 'discarded', error: 'you decided' });
  }
}

async function approve(mr: Mr, me: string | undefined): Promise<{ liftedHold: boolean }> {
  if (me && mr.approvedBy.includes(me)) return { liftedHold: false };
  return setApproved(mr, true);
}

// GitLab answers "Reviewer not found" yet places the hold, so only a status that is not held counts as refused.
async function requestChanges(mr: Mr): Promise<{ liftedHold: false; warning?: string }> {
  const forge = forgeOf(mr);
  needs(forge, 'hold', 'hold a merge');
  const { status, warning } = await forge.hold(mr, true);
  if (warning && (status ?? '').toUpperCase() !== 'REQUESTED_CHANGES') throw new Error(warning);
  await forge.note(mr, CHANGES_NOTE).catch(() => undefined);
  return warning ? { liftedHold: false, warning } : { liftedHold: false };
}

async function closeReviewWorkspace(mr: Mr, hosts: WorkspacePorts): Promise<Decision['workspace']> {
  if (!loadSettings().closeWorkspaceWhenDone) return { closed: false };
  try {
    if (await reviewAgentWorking(mr, hosts)) return { closed: false, kept: 'its agent is still working' };
    const found = workspaceForReview(await hosts.listWorktrees(), mr.repoLabel, mr.iid);
    if (!found) return { closed: false };
    await hosts.removeWorktree(found.id);
    return { closed: true };
  } catch (err) {
    return { closed: false, kept: err instanceof Error ? err.message : String(err) };
  }
}

async function reviewAgentWorking(mr: Mr, hosts: WorkspacePorts): Promise<boolean> {
  const handle = loadState().watches[mrKey(mr)]?.terminal;
  if (!handle) return false;
  const terminal = (await hosts.listAgentTerminals()).find((t) => t.handle === handle);
  return terminal !== undefined && agentWorking(terminal);
}
