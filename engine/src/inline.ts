import { plainBody } from './comment.js';
import type { Discussion } from './data/forge.js';
import type { QueuedComment } from './types.js';

export interface InlineNote {
  author: string;
  body: string;
  createdAt: string;
}

export interface InlineThread {
  id: string;
  path: string;
  line: number;
  /** Which side of the diff the thread hangs off. */
  side: 'new' | 'old';
  resolved: boolean;
  /** The severity of a finding that has not been posted yet; absent once it has. */
  pending?: string;
  notes: InlineNote[];
}

export interface ContextLine {
  text: string;
  /** '+' added, '-' removed, ' ' unchanged. */
  kind: '+' | '-' | ' ';
  /** The number on the side this line belongs to. */
  line: number;
  /** True for the line the thread is attached to. */
  anchor: boolean;
}

/**
 * Every thread hanging off a line of the diff, from anyone, in the order a reader would
 * walk the change: by file, then down the file. General comments on the merge request as
 * a whole are left out, having no line to sit against.
 */
export function inlineThreads(discussions: Discussion[]): InlineThread[] {
  const out: InlineThread[] = [];
  for (const d of discussions) {
    const p = d.position;
    if (!p) continue;
    const side: 'new' | 'old' = p.new_line ? 'new' : 'old';
    const line = p.new_line ?? p.old_line;
    const path = p.new_path ?? p.old_path;
    if (!line || !path) continue;
    out.push({
      id: d.id,
      path,
      line,
      side,
      resolved: d.resolved,
      notes: d.notes.map((n) => ({ author: n.author, body: n.body, createdAt: n.createdAt })),
    });
  }
  return out.sort(byPlace);
}

function byPlace(a: InlineThread, b: InlineThread): number {
  return a.path.localeCompare(b.path) || a.line - b.line;
}

/** Queued findings shaped as threads, so what you are about to send reads beside the code it is about. */
export function queuedThreads(queue: QueuedComment[], me = 'you'): InlineThread[] {
  const out: InlineThread[] = [];
  for (const c of queue) {
    if (c.status !== 'pending') continue;
    const line = c.position?.new_line ?? c.position?.old_line;
    const path = c.position?.new_path ?? c.position?.old_path;
    if (!line || !path) continue;
    out.push({
      id: c.id,
      path,
      line,
      side: c.position?.new_line ? 'new' : 'old',
      resolved: false,
      pending: c.severity,
      notes: [{ author: me, body: plainBody(c), createdAt: c.createdAt }],
    });
  }
  return out;
}

/** Posted and pending together, in the order they sit in the files. */
export function allThreads(
  discussions: Discussion[],
  queue: QueuedComment[],
  me = 'you',
): InlineThread[] {
  return [...inlineThreads(discussions), ...queuedThreads(queue, me)].sort(byPlace);
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * The lines of the diff around an anchor, so a comment can be read against the code it
 * is about. Walks the hunks rather than the file, because a line number only means
 * anything relative to the side it came from.
 */
export function contextFor(
  diff: string,
  line: number,
  side: 'new' | 'old',
  radius = 3,
): ContextLine[] {
  const rows: ContextLine[] = [];
  let oldAt = 0;
  let newAt = 0;

  for (const raw of diff.split('\n')) {
    const header = HUNK.exec(raw);
    if (header) {
      oldAt = Number(header[1]);
      newAt = Number(header[2]);
      continue;
    }
    if ((oldAt === 0 && newAt === 0) || raw.startsWith('\\')) continue;

    const kind: ContextLine['kind'] = raw.startsWith('+') ? '+' : raw.startsWith('-') ? '-' : ' ';
    const at = kind === '+' ? newAt : kind === '-' ? oldAt : side === 'new' ? newAt : oldAt;
    // A line belongs to this side if it is on it; an addition has no old number at all.
    const onSide = side === 'new' ? kind !== '-' : kind !== '+';

    rows.push({ text: raw.slice(1), kind, line: at, anchor: onSide && at === line });
    if (kind === '+') newAt += 1;
    else if (kind === '-') oldAt += 1;
    else {
      newAt += 1;
      oldAt += 1;
    }
  }

  const found = rows.findIndex((r) => r.anchor);
  if (found < 0) return [];
  return rows.slice(Math.max(found - radius, 0), found + radius + 1);
}
