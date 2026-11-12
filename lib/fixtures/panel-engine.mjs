// The stand-in engine, with the agent and queue calls the Claude panel and its tools make, steered through world and claude.
import { world } from '../testkit.mjs';

export * from '../testkit.mjs';

export const claude = { started: [], replies: [], removed: [], stopped: [], made: 0 };

export const handleOf = (n) => `claude:00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export function agent(n, extra = {}) {
  return {
    handle: handleOf(n), sessionId: handleOf(n).slice(7), name: `agent-${n}`, title: `chat ${n}`, cwd: '/ws-root', createdAt: '2026-11-10T09:00:00Z',
    kind: 'master', mr: null, ticket: null, worktree: null, state: 'done', since: 1000 + n, lastAt: 1000 + n, alive: false, said: '', outcome: null, pending: null, ...extra,
  };
}

export async function startClaudeAgent(spec) {
  claude.made += 1;
  claude.started.push(spec);
  const made = agent(100 + claude.made, { name: spec.name, title: spec.title, cwd: spec.cwd, kind: spec.kind, state: 'working', alive: true });
  world.agents.push(made);
  return { how: 'claude', handle: made.handle, path: spec.cwd };
}

export function agentConversation(handle) {
  const found = world.agents.find((a) => a.handle === handle);
  if (!found) throw new Error(`no Claude Code agent ${handle} is recorded`);
  return { entries: [], partial: null, ...found };
}

export function replyToAgent(handle, reply) {
  claude.replies.push([handle, reply]);
}

export async function stopAgent(handle) {
  claude.stopped.push(handle);
  const found = world.agents.find((a) => a.handle === handle);
  if (found) found.alive = false;
}

export async function removeWorktree(handle) {
  claude.removed.push(handle);
  world.agents = world.agents.filter((a) => a.handle !== handle);
}

export const queueInput = (item) => ({ ...item });

export function addToQueue(items) {
  const added = items.map((item, i) => ({ ...item, id: `queued-${world.queue.length + i}`, createdAt: new Date().toISOString(), status: 'pending' }));
  world.queue.push(...added);
  return added;
}

export function discard(id) {
  const item = world.queue.find((c) => c.id === id);
  if (item?.status !== 'pending') return false;
  item.status = 'discarded';
  return true;
}
