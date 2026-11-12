import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  workspaceRoot,
  reviewPrompt,
  ticketPrompt,
  type RepoSpec,
} from '../config.js';
import { agentCommands, kickoffLine } from '../agentprompts.js';
import { checkoutFor, discoverCheckouts, noCheckout, type Checkout } from '../checkouts.js';
import type { Discussion } from '../data/forge.js';
import type { AgentSpec } from '../agents/host.js';
import { agentStateOn, launchHost, listWorkspaceAgents, listWorktrees, removeWorktree } from '../agents/index.js';
import { loadRuns, loadSettings, recordRun } from '../data/store.js';
import { conflictBrief, fixBrief, fixKey } from '../fix.js';
import { workspaceForReview } from '../gc.js';
import { refNumber } from '../refs.js';
import { TICKET_KEY } from '../ticketkeys.js';
import { ticketKey } from '../tickets.js';
import { mrKey, type Mr, type Ticket } from '../types.js';

const run = promisify(execFile);

/** Read per call, because it can be changed in settings while the tool runs. */
const root = (): string => workspaceRoot(loadSettings().workspaceRoot);

export interface LaunchOutcome {
  how: 'worktree' | 'terminal' | 'claude';
  handle?: string;
  path?: string;
  name?: string;
  note?: string;
}

function safeName(input: string): string {
  return input.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60);
}

export function branchSlug(summary: string): string {
  return summary
    .replace(/^\[[^\]]*\]\s*/, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .split('-')
    .filter(Boolean)
    .slice(0, 5)
    .join('-');
}

export function worktreeDirName(repo: RepoSpec, ticketKey: string): string {
  const prefix = repo.prefix ?? safeName(repo.label).toLowerCase();
  return `${prefix}-${safeName(ticketKey).toLowerCase()}`;
}

export async function launchReview(mr: Mr, prompt = reviewPrompt(mr.webUrl)): Promise<LaunchOutcome> {
  const name = safeName(`review-${mr.repoLabel}-${mr.iid}`);
  const kept = await retirePreviousReview(mr);
  const started = await startAgent({ name, prompt, title: `review ${refNumber(mr)}`, kind: 'review', mr: mrKey(mr) });
  const note = [started.note, kept].filter(Boolean).join('; ');
  return { ...started, ...(note ? { note } : {}) };
}

/** Each re-review would otherwise leave a workspace behind; one with an agent still going, or changes git will not drop, stays. */
async function retirePreviousReview(mr: Mr): Promise<string | null> {
  if (!loadSettings().closeWorkspaceWhenDone) return null;
  try {
    const previous = workspaceForReview(await listWorkspaceAgents(), mr.repoLabel, mr.iid);
    if (!previous || previous.agentStates.some((s) => s !== 'done')) return null;
    await removeWorktree(previous.id);
    return null;
  } catch (e) {
    return `the previous review workspace stays: ${e instanceof Error ? e.message : String(e)}`;
  }
}

/** A ticket needs a real checkout inside the repo it targets, so the git worktree is cut the way the team does by hand and the agent is told to work in it. */
export async function launchTicket(
  ticket: Ticket,
  repo: RepoSpec,
  opts: { baseBranch?: string } = {},
): Promise<LaunchOutcome> {
  const dir = repo.dir ?? checkoutFor(repo.path, discoverCheckouts(root()))?.dir;
  const repoPath = dir ? join(root(), dir) : null;
  if (!repoPath || !existsSync(repoPath)) throw noCheckout(repo.path, root());

  const dirName = worktreeDirName(repo, ticket.key);
  const target = join(root(), dirName);
  const branch = `fix/${ticket.key}-${branchSlug(ticket.summary)}`;

  if (!existsSync(target)) {
    const base = opts.baseBranch ?? 'origin/main';
    await run('git', ['-C', repoPath, 'fetch', '--quiet', 'origin']);
    await run('git', ['-C', repoPath, 'worktree', 'add', target, '-b', branch, base]);
  }

  const started = await startAgent({ name: dirName, prompt: ticketPrompt(ticket.key, ticket.summary, target), title: ticket.key, kind: 'ticket', ticket: ticket.key, worktree: target });
  return { how: started.how, handle: started.handle, path: target };
}

export function kickoffPrompt(key: string, checkouts = discoverCheckouts(root())): string {
  return [
    kickoffLine(key, checkouts, root()),
    'Before any git push, merge request, Jira transition or comment, stop and ask me with the AskUserQuestion tool and wait for my answer.',
  ].join('\n');
}

// A command of your own finds its repos itself; the built-in prompt is handed the ones found here.
function kickoffCheckouts(): Checkout[] {
  const found = discoverCheckouts(root());
  if (!found.length && !agentCommands().kickoffCommand) throw new Error(`No git checkouts under ${root()} to start a ticket in. Set Workspace root in Settings to the folder your clones live in.`);
  return found;
}

/** The kickoff agent finds the repo and cuts the checkout itself, so it starts in the workspace folder. */
export async function launchKickoff(key: string, url = ''): Promise<LaunchOutcome> {
  if (!TICKET_KEY.test(key)) throw new Error(`${key} is not a Jira key`);
  const prompt = kickoffPrompt(key, kickoffCheckouts());
  const journal = ticketKey(key);
  if (launching.has(journal)) throw new Error(`an agent is already starting on ${key}`);
  launching.add(journal);
  try {
    if (await runAlive(journal)) throw new Error(`an agent is still open on ${key}`);
    recordRun(journal, { webUrl: url, startedAt: new Date().toISOString(), status: 'launching', tail: [], terminal: undefined, worktreePath: undefined, endedAt: undefined, kickoff: true });
    const name = `kickoff-${key}`;
    const started = await startAgent({ name, prompt, title: `kickoff ${key}`, kind: 'kickoff', ticket: key }).catch((e: unknown) => {
      recordRun(journal, { status: 'launch failed', tail: [e instanceof Error ? e.message : String(e)] });
      throw e;
    });
    recordRun(journal, { status: 'running', terminal: started.handle });
    return { how: started.how, handle: started.handle, name };
  } finally {
    launching.delete(journal);
  }
}

const LAUNCH_GRACE_MS = 5 * 60_000;
const BRANCH_NAME = /^(?!-)[\w./-]+$/;
const launching = new Set<string>();

/** An agent that has ended its turn may be waiting on your yes, so a run lives as long as its host still has the agent. */
async function runAlive(journal: string): Promise<boolean> {
  const run = loadRuns()[journal];
  if (!run || run.status === 'launch failed') return false;
  if (!run.terminal) return Date.now() - Date.parse(run.startedAt) < LAUNCH_GRACE_MS;
  return (await agentStateOn(run.terminal)) !== null;
}

export function fixRunAlive(key: string): Promise<boolean> {
  return runAlive(fixKey(key));
}

export function kickoffRunAlive(key: string): Promise<boolean> {
  return runAlive(ticketKey(key));
}

export interface FixOptions {
  me: string;
  head: string;
  targetBranch: string | null;
  conflicts?: boolean;
}

function fixRefusal(mr: Mr, threads: Discussion[], { me, head, conflicts }: FixOptions): string | null {
  if (mr.author !== me) return `${refNumber(mr)} is ${mr.author}'s MR, so no agent changes it for you`;
  if (!mr.sha || mr.sha !== head) return `the head of ${refNumber(mr)} moved since you looked`;
  if (conflicts && !mr.conflicts) return `GitLab reports no conflicts on ${refNumber(mr)}`;
  if (!conflicts && threads.length === 0) return `nothing on ${refNumber(mr)} is left to fix`;
  if (!BRANCH_NAME.test(mr.sourceBranch)) return `${mr.sourceBranch} is not a branch an agent can start from`;
  if (launching.has(mrKey(mr))) return `a fix agent is already starting on ${refNumber(mr)}`;
  return null;
}

/** The checkout sits beside the repos so the agent, started in the workspace root, gets the workspace CLAUDE.md and commands. */
export async function launchFix(mr: Mr, threads: Discussion[], opts: FixOptions): Promise<LaunchOutcome> {
  const key = mrKey(mr);
  const refused = fixRefusal(mr, threads, opts);
  if (refused) throw new Error(refused);
  launching.add(key);
  try {
    if (await fixRunAlive(key)) throw new Error(`a fix agent is still open on ${refNumber(mr)}`);
    const found = checkoutFor(mr.projectPath, discoverCheckouts(root()));
    if (!found) throw noCheckout(mr.projectPath, root());
    const checkout = join(root(), found.dir);
    return await startFix(mr, checkout, (path) => (opts.conflicts
      ? conflictBrief({ mr, targetBranch: opts.targetBranch, checkout: path })
      : fixBrief({ mr, targetBranch: opts.targetBranch, threads, checkout: path })));
  } finally {
    launching.delete(key);
  }
}

async function startFix(mr: Mr, checkout: string, brief: (path: string) => string): Promise<LaunchOutcome> {
  const journal = fixKey(mrKey(mr));
  recordRun(journal, { webUrl: mr.webUrl, startedAt: new Date().toISOString(), status: 'launching', tail: [], terminal: undefined, worktreePath: undefined, sha: mr.sha });
  try {
    const name = await freeFixName(checkout, safeName(`fix-${mr.repoLabel}-${mr.iid}`));
    const path = join(root(), name);
    await run('git', ['-C', checkout, 'fetch', '--quiet', 'origin', mr.sourceBranch]);
    await run('git', ['-C', checkout, 'worktree', 'add', '--quiet', '-b', name, path, `origin/${mr.sourceBranch}`]);
    recordRun(journal, { worktreePath: path });
    const started = await startAgent({ name, prompt: brief(path), title: `fix ${refNumber(mr)}`, kind: 'fix', mr: mrKey(mr), worktree: path, link: mr.webUrl });
    recordRun(journal, { status: 'running', terminal: started.handle });
    return { how: started.how, handle: started.handle, path, name, ...(started.note ? { note: started.note } : {}) };
  } catch (e) {
    recordRun(journal, { status: 'launch failed', tail: [e instanceof Error ? e.message : String(e)] });
    throw e;
  }
}

// Every agent starts in the workspace root, where the workspace CLAUDE.md, settings and commands are.
function startAgent(spec: Omit<AgentSpec, 'cwd'>): Promise<LaunchOutcome> {
  return launchHost().start({ ...spec, cwd: root() });
}

async function freeFixName(checkout: string, base: string): Promise<string> {
  const [worktrees, branches] = await Promise.all([
    listWorktrees(),
    run('git', ['-C', checkout, 'branch', '--list', `${base}*`, '--format=%(refname:short)']),
  ]);
  const taken = new Set([...worktrees.map((w) => w.displayName), ...branches.stdout.split('\n')]);
  for (let n = 1; ; n += 1) {
    const name = n === 1 ? base : `${base}-${n}`;
    if (!taken.has(name) && !existsSync(join(root(), name))) return name;
  }
}
