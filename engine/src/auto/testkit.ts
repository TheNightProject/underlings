import { rmSync } from 'node:fs';
import { join } from 'node:path';
import type { SendHow } from '../comment.js';
import { STATE_DIR, STATE_DIR_IS_DEFAULT } from '../config.js';
import type { Discussion } from '../data/forge.js';
import { updateQueueItem } from '../data/store.js';
import type { Mr, QueuedComment } from '../types.js';
import { autoConfig } from './config.js';
import type { DiffStats } from './gates.js';
import type { AutoContext, AutoPorts } from './ports.js';

export const ME = 'frank';
export const START = Date.parse('2026-11-03T10:00:00Z');

export function mr(over: Partial<Mr> = {}): Mr {
  return {
    projectPath: 'acme/engine',
    projectId: 1001,
    repoLabel: 'Engine',
    iid: 621,
    title: 'Scope the App Library',
    webUrl: 'https://gitlab.example/acme/engine/-/merge_requests/621',
    draft: false,
    conflicts: false,
    notes: 3,
    author: 'heidi',
    reviewers: [ME],
    approvedBy: [],
    pipeline: 'SUCCESS',
    mergeStatus: 'NOT_APPROVED',
    createdAt: '2026-11-01T00:00:00Z',
    updatedAt: '2026-11-02T00:00:00Z',
    sha: 'head-1',
    sourceBranch: 'fix/thing',
    ticket: null,
    unresolvedThreads: 0,
    ...over,
  };
}

type Note = Discussion['notes'][number];

export function note(author: string, body: string, createdAt: string, over: Partial<Note> = {}): Note {
  return { author, body, createdAt, system: false, ...over };
}

export function thread(id: string, notes: Note[], over: Partial<Discussion> = {}): Discussion {
  return { id, resolved: false, notes, ...over };
}

export interface World {
  mrs: Mr[];
  threads: Discussion[];
  diff: DiffStats;
  changed: string[];
  paused: boolean;
  clock: number;
  failLaunch: boolean;
  onPost?: () => void;
  /** What each terminal has on screen, by handle. */
  screens: Record<string, string[]>;
}

export interface Calls {
  launched: { mr: Mr; prompt: string }[];
  posted: { item: QueuedComment; how: SendHow }[];
  resolved: string[];
  read: string[];
}

export function fakeWorld(over: Partial<World> = {}): { ports: AutoPorts; world: World; calls: Calls } {
  const world: World = {
    mrs: [mr()],
    threads: [],
    diff: { paths: ['src/app.ts'], changedLines: 40, complete: true },
    changed: [],
    paused: false,
    clock: START,
    failLaunch: false,
    screens: {},
    ...over,
  };
  const calls: Calls = { launched: [], posted: [], resolved: [], read: [] };
  const ports: AutoPorts = {
    launch: async (m, prompt) => {
      if (world.failLaunch) throw new Error('the launch failed');
      calls.launched.push({ mr: m, prompt });
    },
    freshMr: async ({ projectPath, iid }) => world.mrs.find((m) => m.projectPath === projectPath && m.iid === iid) ?? null,
    discussions: async () => world.threads,
    diffStats: async () => world.diff,
    changedPaths: async () => world.changed,
    post: async (item, how) => {
      calls.posted.push({ item, how });
      world.onPost?.();
      updateQueueItem(item.id, {
        status: 'posted',
        postedAt: new Date(world.clock).toISOString(),
        ...(how.automatic && item.auto ? { auto: { ...item.auto, sentAuto: true } } : {}),
      });
      return { id: item.id, ok: true };
    },
    resolve: async (_mr, discussion) => {
      calls.resolved.push(discussion);
    },
    readTerminal: async (handle) => {
      calls.read.push(handle);
      return { tail: world.screens[handle] ?? [] };
    },
    paused: () => world.paused,
    now: () => world.clock,
  };
  return { ports, world, calls };
}

export function context(world: World, fullAuto = 'heidi:verdict', over: Partial<AutoContext> = {}): AutoContext {
  return { mrs: world.mrs, me: ME, config: autoConfig({ fullAuto }), ...over };
}

export function resetState(): void {
  if (STATE_DIR_IS_DEFAULT) throw new Error(`refusing to clear ${STATE_DIR}: set UNDERLINGS_STATE_DIR before the store is imported`);
  for (const file of ['queue.json', 'queue-archive.jsonl', 'auto.json', 'state.json', 'runs.json', 'auto.lock', 'frontends']) {
    rmSync(join(STATE_DIR, file), { recursive: true, force: true });
  }
}

export const MINUTE = 60_000;
