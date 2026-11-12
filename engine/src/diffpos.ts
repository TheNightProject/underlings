import type { DiffPosition } from './types.js';

export interface Sides {
  /** Line numbers that exist on the right of the diff: additions and context. */
  newLines: Set<number>;
  /** Line numbers that exist on the left: removals and context. */
  oldLines: Set<number>;
  /** New line to its old counterpart, for the context lines that appear on both. */
  paired: Map<number, number>;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** Which line numbers a unified diff actually covers, and on which side. */
export function parseHunks(diff: string): Sides {
  const newLines = new Set<number>();
  const oldLines = new Set<number>();
  const paired = new Map<number, number>();
  let oldAt = 0;
  let newAt = 0;

  for (const line of diff.split('\n')) {
    const header = HUNK.exec(line);
    if (header) {
      oldAt = Number(header[1]);
      newAt = Number(header[2]);
      continue;
    }
    if (oldAt === 0 && newAt === 0) continue;
    // A "\ No newline at end of file" marker advances neither side.
    if (line.startsWith('\\')) continue;
    if (line.startsWith('+')) {
      newLines.add(newAt);
      newAt += 1;
    } else if (line.startsWith('-')) {
      oldLines.add(oldAt);
      oldAt += 1;
    } else {
      newLines.add(newAt);
      oldLines.add(oldAt);
      paired.set(newAt, oldAt);
      newAt += 1;
      oldAt += 1;
    }
  }
  return { newLines, oldLines, paired };
}

/** Fills in what GitLab's line code needs from both sides of the diff; null means the line is in neither, so the comment posts unanchored. */
export function anchor(position: DiffPosition, diff: string): DiffPosition | null {
  const path = position.new_path ?? position.old_path;
  const line = position.new_line ?? position.old_line;
  if (!path || !line) return null;
  // Naming the old side and no other is a deliberate choice, not a number to re-read.
  const meantOld = position.old_line !== undefined && position.new_line === undefined;

  const { newLines, oldLines, paired } = parseHunks(diff);
  const shas = {
    base_sha: position.base_sha,
    start_sha: position.start_sha,
    head_sha: position.head_sha,
  };

  if (meantOld && oldLines.has(line)) {
    return { ...shas, new_path: path, old_path: path, old_line: line };
  }
  if (newLines.has(line)) {
    const old = paired.get(line);
    // A context line sits on both sides and GitLab wants both; an addition has no old.
    return old === undefined
      ? { ...shas, new_path: path, old_path: path, new_line: line }
      : { ...shas, new_path: path, old_path: path, new_line: line, old_line: old };
  }
  if (oldLines.has(line)) {
    return { ...shas, new_path: path, old_path: path, old_line: line };
  }
  return null;
}
