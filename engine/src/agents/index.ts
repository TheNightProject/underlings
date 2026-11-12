import { APP_NAME } from '../../../lib/product.mjs';
import { focusTerminal as focusInOrca } from '../data/orca.js';
import { loadSettings } from '../data/store.js';
import { claudeHost, isClaudeHandle } from './claude.js';
import type { AgentHost, AgentTerminal, TerminalRead, Workspace, WorkspaceAgents } from './host.js';
import { orcaHost } from './orca.js';

/** Orca is asked nothing unless the state file names it, the fallback until headless agents have proved themselves. */
export const usesOrca = (): boolean => loadSettings().agentHost === 'orca';

/** Read per launch, as settings can change while a front end runs. */
export function launchHost(): AgentHost {
  return usesOrca() ? orcaHost : claudeHost;
}

const hosts = (): AgentHost[] => (usesOrca() ? [orcaHost, claudeHost] : [claudeHost]);

const notOrca = (handle: string): Error => new Error(`${handle} ran in Orca, which agentHost no longer names`);

// An agent started on either host stays on it, whatever the setting says now.
function hostOf(handleOrId: string): AgentHost {
  if (isClaudeHandle(handleOrId)) return claudeHost;
  if (usesOrca()) return orcaHost;
  throw notOrca(handleOrId);
}

export async function listAgentTerminals(): Promise<AgentTerminal[]> {
  return (await Promise.all(hosts().map((h) => h.agents()))).flat();
}

export async function listWorktrees(): Promise<Workspace[]> {
  return (await Promise.all(hosts().map((h) => h.workspaces()))).flat();
}

export async function listWorkspaceAgents(): Promise<WorkspaceAgents[]> {
  return (await Promise.all(hosts().map((h) => h.workspaceAgents()))).flat();
}

export const readTerminal = async (handle: string, limit?: number): Promise<TerminalRead> => hostOf(handle).read(handle, limit);
export const removeWorktree = async (id: string): Promise<void> => hostOf(id).removeWorkspace(id);

// No host means no agent, as far as a launch waiting on the last one is concerned.
export async function agentStateOn(handle: string): Promise<string | null> {
  return isClaudeHandle(handle) || usesOrca() ? hostOf(handle).stateOf(handle) : null;
}

export async function focusTerminal(handle: string): Promise<unknown> {
  if (isClaudeHandle(handle)) throw new Error(`that agent runs as Claude Code in the background, so open it from ${APP_NAME}`);
  if (!usesOrca()) throw notOrca(handle);
  return focusInOrca(handle);
}
