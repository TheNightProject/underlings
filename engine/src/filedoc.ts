import type { InlineThread } from './inline.js';

export type RowKind = 'file' | 'code' | 'gap' | 'note' | 'author';

export interface DocRow {
  kind: RowKind;
  text: string;
  /** Line number in the file, for code rows. */
  line?: number;
  /** '+' added, '-' removed, ' ' untouched. */
  change?: '+' | '-' | ' ';
  /** Index of the thread this row belongs to, for jumping between them. */
  thread?: number;
  /** True for a finding that has not been posted yet. */
  pending?: boolean;
  /** The queue id behind a pending finding, so a key can post, edit or drop it. */
  queueId?: string;
  /** The GitLab thread behind a posted comment, so a reply or resolve knows where it goes. */
  discussionId?: string;
  resolved?: boolean;
  /** The file's body is folded away, leaving only its row. */
  condensed?: boolean;
}

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** The indent a comment body is drawn at, which is width it does not get. */
export const NOTE_INDENT = 8;

export function noteWidth(width: number): number {
  return Math.max(width - NOTE_INDENT, 20);
}

/**
 * Comments are wrapped into rows here rather than by the terminal, because the view
 * draws a fixed number of rows: a body the terminal wrapped would count as one row and
 * take three, pushing that much off the bottom of every screen.
 */
export function wrapText(text: string, width: number): string[] {
  if (text.length <= width) return [text];
  const out: string[] = [];
  let line = '';
  for (const word of text.split(' ')) {
    if (line === '') line = word;
    else if (line.length + 1 + word.length <= width) line += ` ${word}`;
    else {
      out.push(line);
      line = word;
    }
    // A path or a URL can be wider than the column on its own, so it is cut to fit.
    while (line.length > width) {
      out.push(line.slice(0, width));
      line = line.slice(width);
    }
  }
  if (line !== '') out.push(line);
  return out;
}

export interface Removed {
  text: string;
  /** Its number on the left, which is the only side it ever had one on. */
  oldLine: number;
}

/** Which new-side lines the diff adds, and which old-side lines it takes away. */
export function changedLines(diff: string): {
  added: Set<number>;
  removedAfter: Map<number, Removed[]>;
} {
  const added = new Set<number>();
  const removedAfter = new Map<number, Removed[]>();
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
    if (raw.startsWith('+')) {
      added.add(newAt);
      newAt += 1;
    } else if (raw.startsWith('-')) {
      // Removed lines have no home on the right, so they hang under the line before.
      // Each keeps its own left-hand number; a run of them is not all one line.
      const anchor = newAt - 1;
      removedAfter.set(anchor, [
        ...(removedAfter.get(anchor) ?? []),
        { text: raw.slice(1), oldLine: oldAt },
      ]);
      oldAt += 1;
    } else {
      newAt += 1;
      oldAt += 1;
    }
  }
  return { added, removedAfter };
}

export interface FileInput {
  path: string;
  /** The file at the merge request's head, or null when it could not be read. */
  text: string | null;
  diff: string;
  threads: InlineThread[];
}

/**
 * One scrollable document: each commented file in full, with its changes marked and the
 * comments sitting under the lines they are about. Reading a review against three lines
 * of context means never seeing what the code around it does.
 */
export function buildDoc(
  files: FileInput[],
  condensed = new Set<string>(),
  width = 120,
): DocRow[] {
  const rows: DocRow[] = [];
  let threadIndex = 0;

  for (const file of files) {
    // Condensing drops the uncommented code and nothing else, so a thread keeps the
    // number it had: folding a file must not move the cursor onto a different comment.
    const fold = condensed.has(file.path);
    if (rows.length > 0) rows.push({ kind: 'gap', text: '' });
    rows.push({ kind: 'file', text: file.path, ...(fold ? { condensed: true } : {}) });

    const { added, removedAfter } = changedLines(file.diff);
    const onNew = threadsByLine(file.threads, 'new');
    const onOld = threadsByLine(file.threads, 'old');

    const lines = file.text === null ? null : file.text.split('\n');
    const emitNotes = (byLine: Map<number, InlineThread[]>, line: number): void => {
      for (const thread of byLine.get(line) ?? []) {
        const index = threadIndex;
        threadIndex += 1;
        const mark = thread.pending
          ? ` · ${thread.pending}, not posted yet`
          : thread.resolved
            ? ' · resolved'
            : '';
        const owner = thread.pending
          ? { pending: true, queueId: thread.id }
          : { discussionId: thread.id, resolved: thread.resolved };
        for (const note of thread.notes) {
          rows.push({ kind: 'author', text: `${note.author}${mark}`, thread: index, ...owner });
          for (const body of note.body.split('\n')) {
            for (const line of wrapText(body, noteWidth(width))) {
              rows.push({ kind: 'note', text: line, thread: index, ...owner });
            }
          }
        }
      }
    };

    if (lines === null) {
      // No file to show, so the diff itself is the next best thing.
      let oldAt = 0;
      let newAt = 0;
      for (const raw of file.diff.split('\n')) {
        const header = HUNK.exec(raw);
        if (header) {
          oldAt = Number(header[1]);
          newAt = Number(header[2]);
          rows.push({ kind: 'gap', text: raw });
          continue;
        }
        if ((oldAt === 0 && newAt === 0) || raw.startsWith('\\')) continue;
        const change: DocRow['change'] = raw.startsWith('+') ? '+' : raw.startsWith('-') ? '-' : ' ';
        const removed = change === '-';
        const line = removed ? oldAt : newAt;
        const byLine = removed ? onOld : onNew;
        // Folded, what was cut just above a commented line stays, as the code it replaced.
        if (!fold || byLine.has(line) || (removed && onNew.has(newAt))) {
          rows.push({ kind: 'code', text: raw.slice(1), line, change });
        }
        emitNotes(byLine, line);
        if (change !== '+') oldAt += 1;
        if (change !== '-') newAt += 1;
      }
      continue;
    }

    const emitRemovals = (after: number): void => {
      for (const gone of removedAfter.get(after) ?? []) {
        if (fold && !onOld.has(gone.oldLine)) continue;
        rows.push({ kind: 'code', text: gone.text, line: gone.oldLine, change: '-' });
        emitNotes(onOld, gone.oldLine);
      }
    };

    // Anything cut from the very top has no surviving line to follow.
    emitRemovals(0);
    for (const [i, text] of lines.entries()) {
      const line = i + 1;
      if (!fold || onNew.has(line)) {
        rows.push({ kind: 'code', text, line, change: added.has(line) ? '+' : ' ' });
      }
      // The comment belongs to the line it names, so it comes before what was cut after it.
      emitNotes(onNew, line);
      emitRemovals(line);
    }
  }
  return rows;
}

/** A removed line is numbered on the old side, so its threads are kept apart from the new side's. */
function threadsByLine(threads: InlineThread[], side: InlineThread['side']): Map<number, InlineThread[]> {
  const byLine = new Map<number, InlineThread[]>();
  for (const t of threads) {
    if (t.side === side) byLine.set(t.line, [...(byLine.get(t.line) ?? []), t]);
  }
  return byLine;
}

/** Where each thread starts in the document, so a key can jump between them. */
export function threadStarts(rows: DocRow[]): number[] {
  const seen = new Map<number, number>();
  rows.forEach((row, i) => {
    if (row.thread !== undefined && !seen.has(row.thread)) seen.set(row.thread, i);
  });
  return [...seen.entries()].sort((a, b) => a[0] - b[0]).map(([, i]) => i);
}
