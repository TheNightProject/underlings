import type { PostOutcome } from '../actions/post.js';
import type { SendHow } from '../comment.js';
import type { Discussion, ForgeRef } from '../data/forge.js';
import type { TerminalRead } from '../agents/host.js';
import type { MrRef } from '../refs.js';
import type { Mr, QueuedComment } from '../types.js';
import type { AutoConfig } from './config.js';
import type { DiffStats } from './gates.js';

export interface AutoPorts {
  launch(mr: Mr, prompt: string): Promise<unknown>;
  freshMr(ref: MrRef): Promise<Mr | null>;
  discussions(mr: ForgeRef): Promise<Discussion[]>;
  diffStats(mr: ForgeRef): Promise<DiffStats>;
  changedPaths(mr: ForgeRef, from: string, to: string): Promise<string[]>;
  post(item: QueuedComment, how: SendHow): Promise<PostOutcome>;
  resolve(mr: ForgeRef, discussionId: string): Promise<void>;
  readTerminal(handle: string): Promise<TerminalRead>;
  /** Read at every send, not once a tick, so the kill switch stops a batch part way. */
  paused(): boolean;
  /** Absent means always: set by fencedPorts, so a front end that is not driving writes nothing. */
  held?(): boolean;
  now(): number;
}

export interface AutoContext {
  mrs: Mr[];
  me: string | undefined;
  config: AutoConfig;
  agentOn?: (mr: Mr) => boolean;
  isEditing?: (id: string) => boolean;
  /** `auto:<token>`: the send claim this driver takes, and the one claim it never hands back. */
  claimBy?: string;
  noLaunch?: string;
}
