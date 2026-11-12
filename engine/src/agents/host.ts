import { terminalIsWorking } from '../data/orca.js';

export interface AgentTerminal {
  handle: string;
  title: string;
  agent?: string;
  connected: boolean;
  orphaned: boolean;
  lastOutputAt?: number;
  worktreePath?: string;
  /** working, waiting, blocked or done. */
  state?: string;
  /** Said by a host that knows; an Orca terminal's is read from its title. */
  working?: boolean;
}

export interface TerminalRead {
  status?: string;
  tail: string[];
}

export interface Workspace {
  id: string;
  displayName: string;
  path: string;
  branch: string;
  isMainWorktree: boolean;
  lastActivityAt?: number;
}

export interface WorkspaceAgents extends Workspace {
  agentStates: string[];
}

export type AgentKind = 'review' | 'fix' | 'kickoff' | 'ticket' | 'master' | 'message';

export interface AgentSpec {
  /** The workspace's name, which is all that links a review workspace back to its MR. */
  name: string;
  prompt: string;
  title: string;
  cwd: string;
  kind: AgentKind;
  /** The MR it works for, as group/repo!iid. */
  mr?: string;
  /** The Jira ticket it works for. */
  ticket?: string;
  /** The git worktree cut for it, when it does not work in cwd itself. */
  worktree?: string;
  /** An MR web link for Orca to show on the workspace. */
  link?: string;
  /** More claude arguments, on every start and resume; only the master and message agents take them. */
  args?: string[];
}

export interface StartedAgent {
  how: 'worktree' | 'terminal' | 'claude';
  handle: string;
  path?: string | undefined;
  note?: string;
}

/** What the launches, run capture, verdicts, full auto and clean-up need from whatever runs the agents. */
export interface AgentHost {
  start(spec: AgentSpec): Promise<StartedAgent>;
  agents(): Promise<AgentTerminal[]>;
  read(handle: string, limit?: number): Promise<TerminalRead>;
  send(handle: string, text: string): Promise<void>;
  /** working, waiting, blocked or done, and null once no agent is on the handle. */
  stateOf(handle: string): Promise<string | null>;
  stop(handle: string): Promise<void>;
  workspaces(): Promise<Workspace[]>;
  workspaceAgents(): Promise<WorkspaceAgents[]>;
  removeWorkspace(id: string): Promise<void>;
}

export function agentWorking(t: AgentTerminal): boolean {
  return t.working ?? terminalIsWorking(t.title);
}
