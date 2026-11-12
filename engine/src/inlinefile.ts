import { forgeOf, TOO_BIG, type Discussion, type MrFile } from './data/forge.js';
import { loadQueue } from './data/store.js';
import { buildDoc, threadStarts, type DocRow } from './filedoc.js';
import { allThreads, contextFor } from './inline.js';
import { mrKey, type DiffPosition, type Mr, type QueuedComment } from './types.js';

/** Past either a file is shown as its diff: a browser gains nothing from a million rows. */
const MAX_FILE_SIZE = 1_000_000;
const MAX_FILE_LINES = 20_000;
const CACHE_LIMIT = 200;
const NEIGHBOURS = 3;

export type MrHead = Pick<Mr, 'projectId' | 'projectPath' | 'iid' | 'sha'>;

export interface InlineFileView {
  key: string;
  path: string;
  /** The commit the text was read at. */
  sha: string | null;
  /** 'diff' when the file could not be read or is too big to show, so the rows are the diff on its own. */
  source: 'file' | 'diff';
  fileTooBig: boolean;
  inDiff: boolean;
  /** GitLab collapsed this file's diff, so nothing in it is marked as changed. */
  tooLarge: boolean;
  diffComplete: boolean;
  rows: DocRow[];
  starts: number[];
  threads: number;
  placed: number;
  /** Threads on this path that found no line to sit under. */
  unplaced: number;
  pending: number;
  commentedPaths: string[];
}

export interface FileViewInput {
  path: string;
  text: string | null;
  /** The read stopped early because the file is too big to show. */
  tooBig?: boolean;
  file: MrFile | undefined;
  diffComplete: boolean;
  discussions: Discussion[];
  /** Already narrowed to this MR's pending items. */
  queue: QueuedComment[];
  me?: string;
  folded?: boolean;
}

/** One file of an MR with its threads and queued findings, as plain JSON. */
export function fileView(input: FileViewInput): Omit<InlineFileView, 'key' | 'sha'> {
  const all = allThreads(input.discussions, input.queue, input.me ?? 'you');
  const threads = all.filter((t) => t.path === input.path);
  const whole = input.text === null ? null : withoutFinalNewline(input.text);
  const fileTooBig = Boolean(input.tooBig) || (whole !== null && !fits(whole));
  const text = fileTooBig ? null : whole;
  const rows = buildDoc(
    [{ path: input.path, text, diff: input.file?.diff ?? '', threads }],
    input.folded ? new Set([input.path]) : new Set<string>(),
    Number.MAX_SAFE_INTEGER,
  );
  const starts = threadStarts(rows);
  return {
    path: input.path,
    source: text === null ? 'diff' : 'file',
    fileTooBig,
    inDiff: input.file !== undefined,
    tooLarge: input.file?.tooLarge ?? false,
    diffComplete: input.diffComplete,
    rows,
    starts,
    threads: threads.length,
    placed: starts.length,
    unplaced: threads.length - starts.length,
    pending: new Set(rows.filter((r) => r.pending).map((r) => r.thread)).size,
    commentedPaths: [...new Set(all.map((t) => t.path))],
  };
}

/** A final newline would otherwise draw an empty line past the end of the file. */
function withoutFinalNewline(text: string): string {
  return text.endsWith('\n') ? text.slice(0, -1) : text;
}

function fits(text: string): boolean {
  return text.length <= MAX_FILE_SIZE && text.split('\n', MAX_FILE_LINES + 1).length <= MAX_FILE_LINES;
}

/** Null for a path the MR neither changes nor comments on, so it never reads an arbitrary file. */
export async function inlineFile(
  mr: MrHead,
  path: string,
  options: { me?: string; folded?: boolean } = {},
): Promise<InlineFileView | null> {
  const [discussions, diff] = await Promise.all([
    forgeOf(mr).discussions(mr),
    diffAt(mr).catch(() => ({ files: [] as MrFile[], complete: false })),
  ]);
  const queue = pendingFor(mr);
  const commented = [...new Set(allThreads(discussions, queue).map((t) => t.path))];
  const target = path || commented[0];
  if (!target) return null;
  const file = fileIn(diff.files, target);
  if (!file && !commented.includes(target)) return null;

  const read = await textAt(mr, target);
  const text = read === TOO_BIG ? null : read;
  return {
    key: mrKey(mr),
    sha: mr.sha,
    ...fileView({ path: target, text, tooBig: read === TOO_BIG, file, diffComplete: diff.complete, discussions, queue, ...options }),
  };
}

function pendingFor(mr: MrHead): QueuedComment[] {
  return loadQueue().filter(
    (c) => c.status === 'pending' && c.projectPath === mr.projectPath && c.iid === mr.iid,
  );
}

function fileIn(files: MrFile[], path: string): MrFile | undefined {
  return files.find((f) => f.newPath === path || f.oldPath === path);
}

/** Which line of each finding's quoted hunk its comment is on, numbered from the diff at the head. */
export async function hunkAnchors(
  mr: MrHead,
  items: QueuedComment[],
): Promise<Record<string, number | null>> {
  const { files } = await diffAt(mr);
  return Object.fromEntries(items.map((c) => [c.id, anchorIn(c, files)]));
}

function anchorIn(c: QueuedComment, files: MrFile[]): number | null {
  const path = c.position?.new_path ?? c.position?.old_path;
  const file = path ? fileIn(files, path) : undefined;
  if (!c.diffHunk || !c.position || !file) return null;
  return hunkAnchor(c.diffHunk, file.diff, c.position);
}

/** Matched by text, not count: agents quote from the diff but may drop markers or put prose between quotes. */
export function hunkAnchor(
  hunk: string,
  diff: string,
  position: Pick<DiffPosition, 'new_line' | 'old_line'>,
): number | null {
  const line = position.new_line ?? position.old_line;
  if (!line) return null;
  const around = contextFor(diff, line, position.new_line ? 'new' : 'old', NEIGHBOURS);
  const at = around.findIndex((c) => c.anchor);
  if (at < 0) return null;
  const diffLines = around.map((c) => (c.kind + c.text).trimEnd());
  const quoted = hunk.split('\n').map((l) => l.trimEnd());

  let best: number | null = null;
  let bestScore = 0;
  for (let i = 0; i < quoted.length; i += 1) {
    const score = likeness(quoted, i, diffLines, at);
    if (score > bestScore) {
      best = i;
      bestScore = score;
    }
  }
  return best;
}

function likeness(quoted: string[], i: number, diffLines: string[], at: number): number {
  const centre = sameLine(quoted[i], diffLines[at]);
  if (centre === 0) return 0;
  let score = centre * 2;
  for (let k = 1; k <= NEIGHBOURS; k += 1) {
    if (sameLine(quoted[i - k], diffLines[at - k])) score += 1;
    if (sameLine(quoted[i + k], diffLines[at + k])) score += 1;
  }
  return score;
}

/** 2 for the line as the diff has it, 1 for the same code quoted without its marker. */
function sameLine(quoted: string | undefined, diffLine: string | undefined): number {
  if (quoted === undefined || diffLine === undefined) return 0;
  if (quoted === diffLine) return 2;
  return quoted === diffLine.slice(1) ? 1 : 0;
}

/** What a head commit holds never changes, so it is read once per head and failures are not kept. */
const atHead = new Map<string, unknown>();

async function once<T>(key: string | null, load: () => Promise<T>, keep: (value: T) => boolean): Promise<T> {
  if (key !== null && atHead.has(key)) return atHead.get(key) as T;
  const value = await load();
  if (key === null || !keep(value)) return value;
  atHead.set(key, value);
  if (atHead.size > CACHE_LIMIT) atHead.delete(atHead.keys().next().value as string);
  return value;
}

function diffAt(mr: MrHead): Promise<{ files: MrFile[]; complete: boolean }> {
  const key = mr.sha ? `diff ${mrKey(mr)}@${mr.sha}` : null;
  return once(key, () => forgeOf(mr).files(mr), () => true);
}

/** Only text that will be shown is kept, so the cache never holds a file it drops for size. */
function textAt(mr: MrHead, path: string): Promise<string | null | typeof TOO_BIG> {
  const sha = mr.sha;
  if (!sha) return Promise.resolve(null);
  const load = async () => {
    const text = await forgeOf(mr).file(mr, path, sha, MAX_FILE_SIZE);
    return typeof text === 'string' && !fits(withoutFinalNewline(text)) ? TOO_BIG : text;
  };
  return once(`file ${mrKey(mr)}@${sha} ${path}`, load, (t) => t !== null);
}
