import type { Discussion, MrFile, NotePosition } from '../data/forge.js';
import type { Mr, QueuedComment, Severity } from '../types.js';

export const BLOCKING: Severity[] = ['CRITICAL', 'MAJOR'];

/** Read off what the pass queued, so nothing the agent says in words can change it. */
export function passBlocking(items: QueuedComment[]): boolean {
  return items.some((c) => (c.kind ?? 'finding') === 'finding' && BLOCKING.includes(c.severity));
}

export interface DiffStats {
  paths: string[];
  changedLines: number;
  complete: boolean;
}

export function countChangedLines(diff: string): number {
  return diff.split('\n').filter((line) => line.startsWith('+') || line.startsWith('-')).length;
}

export function diffStats(files: MrFile[], complete: boolean): DiffStats {
  return {
    paths: [...new Set(files.flatMap((f) => [f.oldPath, f.newPath]).filter(Boolean))],
    changedLines: files.reduce((n, f) => n + countChangedLines(f.diff), 0),
    complete: complete && !files.some((f) => f.tooLarge),
  };
}

export function globToRegExp(glob: string): RegExp {
  const source = glob
    .split(/(\*\*\/|\*\*|\*|\?)/)
    .map((part) => {
      if (part === '**/') return '(?:.*/)?';
      if (part === '**') return '.*';
      if (part === '*') return '[^/]*';
      if (part === '?') return '[^/]';
      return part.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    })
    .join('');
  return new RegExp(`^${source}$`);
}

export function sensitiveHits(paths: string[], globs: string[]): string[] {
  const patterns = globs.map(globToRegExp);
  return paths.filter((path) => patterns.some((re) => re.test(path)));
}

export interface ApprovalFacts {
  mr: Mr;
  me: string;
  passSha: string | null;
  blocking: boolean;
  threads: Discussion[];
  diff: DiffStats;
  heldByHand: boolean;
  handedBack: number;
}

export interface GateLimits {
  maxDiffLines: number;
  sensitive: string[];
}

type Gate = (f: ApprovalFacts, limits: GateLimits) => string | null;

function yourOpenThreads(f: ApprovalFacts): number {
  return f.threads.filter((t) => !t.resolved && t.notes.some((n) => n.author === f.me)).length;
}

const GATES: Gate[] = [
  (f) => (f.mr.pipeline === 'SUCCESS' ? null : `the pipeline is ${(f.mr.pipeline ?? 'missing').toLowerCase()}`),
  (f) => (yourOpenThreads(f) === 0 ? null : `${yourOpenThreads(f)} of your threads are unresolved`),
  (f) => (f.blocking ? 'the pass found something blocking' : null),
  (f) => (f.mr.sha !== null && f.mr.sha === f.passSha ? null : 'the head is not the commit the pass reviewed'),
  (f) => (f.mr.draft ? 'it is a draft' : null),
  (f) => (f.diff.complete ? null : 'GitLab did not return the whole diff'),
  (f, l) => (f.diff.changedLines <= l.maxDiffLines ? null : `${f.diff.changedLines} changed lines, over ${l.maxDiffLines}`),
  (f, l) => {
    const hits = sensitiveHits(f.diff.paths, l.sensitive);
    return hits.length === 0 ? null : `it touches ${hits.slice(0, 2).join(', ')}`;
  },
  (f) => (f.heldByHand ? 'changes you requested by hand still stand' : null),
  (f) => (f.handedBack === 0 ? null : `${f.handedBack} item(s) from the pass are waiting for you`),
];

export function approvalBlockers(facts: ApprovalFacts, limits: GateLimits): string[] {
  return GATES.map((gate) => gate(facts, limits)).filter((why): why is string => why !== null);
}

/** An agent saying fixed is a claim; resolving needs the thread's own file to have changed since. */
export function fixedInCode(anchor: NotePosition | undefined, head: string | null, changed: string[]): boolean {
  if (!anchor?.head_sha || !head || anchor.head_sha === head) return false;
  const paths = [anchor.new_path, anchor.old_path].filter((p): p is string => Boolean(p));
  return paths.some((path) => changed.includes(path));
}
