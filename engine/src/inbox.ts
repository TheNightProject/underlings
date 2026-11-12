import type { RepoSpec } from './config.js';
import { forgeOf, forges, GITLAB, isHeld, type Forge, type Todo } from './data/forge.js';
import { githubRepos } from './data/github-forge.js';
import { agentWorking } from './agents/host.js';
import { listAgentTerminals } from './agents/index.js';
import type { AgentTerminal } from './agents/host.js';
import { loadQueue, loadRepoCache, loadSettings, loadState, saveRepoCache } from './data/store.js';
import { deriveFlags, sortForReview, type RowFlags } from './flags.js';
import { moodForRow, type Mood } from './pulse.js';
import { reviewPhase, reviewVerdict, type AgentState, type ReviewPhase, type ThreadSummary } from './review.js';
import { movedSince } from './auto/rereview.js';
import type { Provider } from './refs.js';
import { applyFilter } from './settings.js';
import { mrKey, type Mr, type QueuedComment, type Watch } from './types.js';

const THREAD_CANDIDATES = 40;
const THREAD_BATCH = 8;

/** Discovered once, cached, then narrowed by settings. */
export async function currentRepos(): Promise<RepoSpec[]> {
  let repos = loadRepoCache();
  if (!repos) {
    repos = await forgeOf(GITLAB).discoverRepos();
    saveRepoCache(repos);
  }
  return applyFilter(repos, loadSettings().repoFilter);
}

export function agentStates(terminals: AgentTerminal[]): Map<string, AgentState> {
  return new Map(
    terminals
      .filter((t) => t.agent)
      .map((t) => [
        t.handle,
        {
          alive: t.connected && !t.orphaned,
          working: agentWorking(t),
          ...(t.lastOutputAt !== undefined ? { lastOutputAt: t.lastOutputAt } : {}),
          ...(t.worktreePath ? { worktreePath: t.worktreePath } : {}),
        },
      ]),
  );
}

/** The list query cannot say whose threads are open, so only MRs with one are worth a call. */
const threadReads = new Map<string, { mark: string; state: ThreadSummary }>();
const readMark = (m: Mr): string => `${m.notes}:${m.unresolvedThreads}:${m.sha}`;

/** Who you are on each forge; a name on one is never taken for you on the other. */
export type Accounts = Partial<Record<Provider, string>>;

export const providerOf = (mr: Pick<Mr, 'provider'>): Provider => mr.provider ?? 'gitlab';

/** GitLab's name stands in when the accounts were not read, as every inbox before GitHub had only it. */
export function meFor(mr: Pick<Mr, 'provider'>, me: string | undefined, accounts?: Accounts): string | undefined {
  return mr.provider === 'github' ? accounts?.github : (accounts?.gitlab ?? me);
}

/** Read where you wrote something, on every watched MR and on each of yours with notes; an MR that has not moved is not read again. */
export async function threadsFor(
  mrs: Mr[],
  me: string,
  watches: Record<string, Watch>,
  accounts?: Accounts,
): Promise<Map<string, ThreadSummary>> {
  const mine = (m: Mr): string => meFor(m, me, accounts) ?? '';
  const rank = (m: Mr): number =>
    watches[mrKey(m)] || m.reviewers.includes(mine(m)) || m.author === mine(m) ? 0 : 1;
  const candidates = mrs
    .filter((m) => m.notes > 0 && (m.unresolvedThreads > 0 || Boolean(watches[mrKey(m)]) || m.author === mine(m)))
    .sort((a, b) => rank(a) - rank(b))
    .slice(0, THREAD_CANDIDATES);
  const found = new Map<string, ThreadSummary>();
  const keep = (m: Mr, state: ThreadSummary): void => {
    if (state.mine > 0 || m.author === mine(m)) found.set(mrKey(m), state);
  };
  const unread = candidates.filter((m) => {
    const known = threadReads.get(mrKey(m));
    if (known?.mark !== readMark(m)) return true;
    keep(m, known.state);
    return false;
  });
  for (let i = 0; i < unread.length; i += THREAD_BATCH) {
    const batch = unread.slice(i, i + THREAD_BATCH);
    const settled = await Promise.allSettled(
      batch.map((m) => forgeOf(m).threadState(m, mine(m), m.sha)),
    );
    settled.forEach((r, n) => {
      const m = batch[n];
      if (r.status !== 'fulfilled' || !m) return;
      threadReads.set(mrKey(m), { mark: readMark(m), state: r.value });
      keep(m, r.value);
    });
  }
  return found;
}

export interface TerminalList {
  terminals: AgentTerminal[];
  /** Set when they could not be listed, so nothing reads an empty list as every agent gone. */
  terminalsError?: string;
  /** When they were listed, so a review launched since is not read as gone from the list. */
  listedAt: number;
}

export async function listTerminalsOrError(): Promise<TerminalList> {
  const listedAt = Date.now();
  return listAgentTerminals().then(
    (terminals) => ({ terminals, listedAt }),
    (e: unknown) => ({ terminals: [], terminalsError: e instanceof Error ? e.message : String(e), listedAt }),
  );
}

export interface InboxData extends TerminalList {
  /** GitLab's name, as it always was; accounts says who you are on each forge. */
  me: string;
  accounts?: Accounts;
  /** A forge that did not answer, while another did. */
  errors?: Accounts;
  /** When each forge last answered, so one failing for long is said even while another keeps answering. */
  answeredAt?: Accounts;
  repoCount: number;
  mrs: Mr[];
  agents: Map<string, AgentState>;
  threads: Map<string, ThreadSummary>;
  fetchedAt: string;
  todos?: Todo[];
  /** A failed read is said, never shown as an empty list. */
  todosError?: string;
}

async function todosOrError(forge: Forge): Promise<Pick<InboxData, 'todos' | 'todosError'>> {
  if (!forge.caps.todos) return {};
  try {
    return { todos: await forge.todos() };
  } catch (e) {
    return { todosError: e instanceof Error ? e.message : String(e) };
  }
}

interface ForgeRead {
  provider: Provider;
  me: string;
  mrs: Mr[];
  repos: number;
  todos: Pick<InboxData, 'todos' | 'todosError'>;
}

async function readGitlab(forge: Forge): Promise<ForgeRead> {
  const repos = await currentRepos();
  const [{ mrs }, me, todos] = await Promise.all([forge.listOpen(repos), forge.me(), todosOrError(forge)]);
  return { provider: 'gitlab', me, mrs, repos: repos.length, todos };
}

async function readGithub(forge: Forge): Promise<ForgeRead> {
  const repos = await githubRepos();
  const [{ mrs }, me] = await Promise.all([forge.listOpen(repos), forge.me()]);
  return { provider: 'github', me, mrs, repos: new Set([...repos.map((r) => r.path), ...mrs.map((m) => m.projectPath)]).size, todos: {} };
}

const reason = (e: unknown): string => (e instanceof Error ? e.message : String(e));

// GitLab's error is the one said, as it always was; the others travel with it for their own cards.
function everyFailed(failed: { provider: Provider; error: unknown }[]): unknown {
  const first = failed[0]?.error;
  if (failed.length < 2 || !(first instanceof Error)) return first;
  return Object.assign(first, { errors: Object.fromEntries(failed.map((f) => [f.provider, reason(f.error)])) });
}

// A GitHub repo named as a GitLab one is told apart, so a filter or a workspace never takes one for the other.
function labelled(mrs: Mr[]): Mr[] {
  const gitlab = new Set(mrs.filter((m) => !m.provider).map((m) => m.repoLabel));
  return mrs.map((m) => (m.provider === 'github' && gitlab.has(m.repoLabel) ? { ...m, repoLabel: `${m.repoLabel} GH` } : m));
}

/**
 * Everything that costs a request, from each forge at once. One that fails keeps the rows it
 * had and says why; only every forge failing fails the read, as GitLab alone always did.
 */
export async function fetchInbox(previous?: InboxData | null): Promise<InboxData> {
  const [listed, ...settled] = await Promise.all([listTerminalsOrError(), ...forges().map((f) => (f.id === 'gitlab' ? readGitlab(f) : readGithub(f)).then((read) => ({ read }), (error: unknown) => ({ provider: f.id, error })))]);
  const failed = settled.flatMap((s) => ('error' in s ? [s] : []));
  if (failed.length === settled.length) throw everyFailed(failed);
  const reads = settled.flatMap((s) => ('read' in s ? [s.read] : []));
  const accounts: Accounts = Object.fromEntries([...Object.entries(previous?.accounts ?? {}), ...reads.map((r) => [r.provider, r.me])]);
  const errors: Accounts = Object.fromEntries(failed.map((f) => [f.provider, reason(f.error)]));
  const kept = failed.flatMap((f) => (previous?.mrs ?? []).filter((m) => providerOf(m) === f.provider));
  const mrs = labelled([...reads.flatMap((r) => r.mrs), ...kept]);
  const me = accounts.gitlab ?? '';
  const now = new Date().toISOString();
  const answeredAt: Accounts = Object.fromEntries([...failed.map((f) => [f.provider, previous?.answeredAt?.[f.provider] ?? previous?.fetchedAt ?? now]), ...reads.map((r) => [r.provider, now])]);
  return {
    me,
    ...(reads.some((r) => r.provider !== 'gitlab') || failed.length ? { accounts, errors, answeredAt } : {}),
    repoCount: reads.reduce((n, r) => n + r.repos, 0) + new Set(kept.map((m) => `${providerOf(m)}:${m.projectPath}`)).size,
    mrs,
    agents: agentStates(listed.terminals),
    threads: await threadsFor(mrs, me, loadState().watches, accounts),
    fetchedAt: now,
    ...listed,
    ...reads.find((r) => r.provider === 'gitlab')?.todos,
  };
}

export interface InboxRow {
  mr: Mr;
  key: string;
  flags: RowFlags;
  phase: ReviewPhase;
  count: number;
  mood: Mood;
  verdict: string | null;
  agent?: 'working' | 'idle';
}

export interface InboxInput {
  mrs: Mr[];
  me: string | undefined;
  accounts?: Accounts;
  queue: QueuedComment[];
  watches: Record<string, Watch>;
  agents: Map<string, AgentState>;
  threads: Map<string, ThreadSummary>;
  verdicts: Record<string, { verdict: 'approved' | 'changes' }>;
}

function pendingCounts(queue: QueuedComment[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const c of queue) {
    if (c.status === 'pending') counts.set(mrKey(c), (counts.get(mrKey(c)) ?? 0) + 1);
  }
  return counts;
}

/** The inbox rows, in order and with their moods. */
export function inboxRows(input: InboxInput): InboxRow[] {
  const queued = pendingCounts(input.queue);
  const mine = (mr: Mr): string | undefined => meFor(mr, input.me, input.accounts);
  const flagsFor = (mr: Mr): RowFlags => {
    const watch = input.watches[mrKey(mr)];
    const me = mine(mr);
    return deriveFlags(mr, {
      ...(me ? { me } : {}),
      watched: Boolean(watch),
      changed: watch ? movedSince(watch, mr) : false,
      queued: queued.get(mrKey(mr)) ?? 0,
      held: isHeld(mr),
    });
  };
  return sortForReview(input.mrs, flagsFor).map((mr) => {
    const key = mrKey(mr);
    const watch = input.watches[key];
    const flags = flagsFor(mr);
    const { phase, count } = reviewPhase(key, input.queue, watch, input.agents, input.threads.get(key));
    const agent = watch?.terminal ? input.agents.get(watch.terminal) : undefined;
    return {
      mr,
      key,
      flags,
      phase,
      count,
      mood: moodForRow({ flags, review: { phase } }),
      verdict: reviewVerdict(mr, mine(mr), input.verdicts[key]?.verdict)?.label ?? null,
      ...(agent?.alive ? { agent: agent.working ? ('working' as const) : ('idle' as const) } : {}),
    };
  });
}

/** Rows from the last fetch, against the queue and watches as they are on disk now. */
export function rowsFor(data: InboxData): InboxRow[] {
  const state = loadState();
  return inboxRows({
    ...data,
    queue: loadQueue(),
    watches: state.watches,
    verdicts: state.verdicts ?? {},
  });
}
