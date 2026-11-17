import { claudeHost, isClaudeHandle } from './claude.js';
import type { AgentTerminal, TerminalRead, Workspace, WorkspaceAgents } from './host.js';

// A handle an older build started in Orca is answered by nothing now, so it reads as gone.
const gone = (handle: string): Error => new Error(`${handle} ran in Orca, which is no longer used`);

function claudeOnly(handle: string): void {
  if (!isClaudeHandle(handle)) throw gone(handle);
}

export const listAgentTerminals = (): Promise<AgentTerminal[]> => claudeHost.agents();
export const listWorktrees = (): Promise<Workspace[]> => claudeHost.workspaces();
export const listWorkspaceAgents = (): Promise<WorkspaceAgents[]> => claudeHost.workspaceAgents();

export async function readTerminal(handle: string, limit?: number): Promise<TerminalRead> {
  claudeOnly(handle);
  return claudeHost.read(handle, limit);
}

export async function removeWorktree(id: string): Promise<void> {
  claudeOnly(id);
  return claudeHost.removeWorkspace(id);
}

// No host means no agent, as far as a launch waiting on the last one is concerned.
export async function agentStateOn(handle: string): Promise<string | null> {
  return isClaudeHandle(handle) ? claudeHost.stateOf(handle) : null;
}
