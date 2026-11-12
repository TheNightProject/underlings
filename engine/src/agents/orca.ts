import {
  agentStateOn,
  closeTerminal,
  createTerminal,
  createWorktree,
  linkWorktreeMr,
  listAgentTerminals,
  listWorkspaceAgents,
  listWorktrees,
  readTerminal,
  removeWorktree,
  sendToTerminal,
  workspaceRepoId,
  type CreatedWorktree,
  type Worktree,
} from '../data/orca.js';
import { modelArgs } from '../../../lib/modeltiers.mjs';
import { agentLaunch, type AgentLaunch } from '../models.js';
import { pluginArgs } from '../plugin.js';
import type { AgentHost, AgentSpec, StartedAgent } from './host.js';

// Orca reads 'active' as the caller's cwd, which for a plugin worker is in no workspace, and refuses a path it holds no workspace for.
export function terminalWorktree(created: Partial<Worktree> | undefined, workspaceRoot: string): string {
  return created?.id ? `id:${created.id}` : `path:${created?.path || workspaceRoot}`;
}

async function linked(worktree: Partial<Worktree> | undefined, { link, name }: AgentSpec): Promise<string | null> {
  if (!link) return null;
  const done = worktree?.id ? await linkWorktreeMr(`id:${worktree.id}`, link).then(() => true, () => false) : false;
  return done ? null : `Orca did not link ${name} to its MR`;
}

// Orca types the command into a shell, where a model such as sonnet[1m] would be read as a glob.
const shellWord = (word: string): string => (/^[\w.:/@-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`);
export const terminalCommand = (launch: AgentLaunch): string => ['claude', ...modelArgs(launch), ...pluginArgs()].map(shellWord).join(' ');

async function agentIn(created: CreatedWorktree, { prompt, title, cwd }: AgentSpec, launch: AgentLaunch): Promise<Omit<StartedAgent, 'path'>> {
  const agent = created.launch?.outcome?.handle ?? created.agentTerminalHandle;
  if (agent) return { how: 'worktree', handle: agent };
  const terminal = created.startupTerminal?.handle
    ?? (await createTerminal({ worktree: terminalWorktree(created.worktree, cwd), title, command: terminalCommand(launch) })).handle;
  await sendToTerminal({ terminal, text: prompt, waitSubmitSeconds: 20 });
  return { how: 'terminal', handle: terminal, note: 'folder repo returned no agent handle, prompt sent to a new terminal' };
}

/** Every agent gets a workspace of the folder repo, as Orca refuses a terminal anywhere it holds no workspace. */
async function start(spec: AgentSpec): Promise<StartedAgent> {
  const launch = agentLaunch(spec.kind);
  const created = await createWorktree({ repo: `id:${await workspaceRepoId(spec.cwd)}`, name: spec.name, agent: 'claude', prompt: spec.prompt, surface: 'terminal', model: launch.model, effort: launch.effort });
  const started = await agentIn(created, spec, launch);
  const note = [started.note, await linked(created.worktree, spec)].filter(Boolean).join('; ');
  return { how: started.how, handle: started.handle, path: created.worktree?.path, ...(note ? { note } : {}) };
}

export const orcaHost: AgentHost = {
  start,
  agents: listAgentTerminals,
  read: readTerminal,
  send: async (handle, text) => {
    await sendToTerminal({ terminal: handle, text });
  },
  stateOf: agentStateOn,
  stop: closeTerminal,
  workspaces: listWorktrees,
  workspaceAgents: listWorkspaceAgents,
  removeWorkspace: removeWorktree,
};
