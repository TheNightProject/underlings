import type { Mr, PipelineStatus } from './types.js';

export interface RowFlags {
  mine: boolean;
  waitingOnYou: boolean;
  youApproved: boolean;
  red: boolean;
  held: boolean;
  /** Nobody assigned, nobody approved, and not a draft: waiting for a first look. */
  unreviewed: boolean;
  conflict: boolean;
  draft: boolean;
  changed: boolean;
  watched: boolean;
  queued: number;
}

export function deriveFlags(
  mr: Mr,
  opts: { me?: string; changed?: boolean; watched?: boolean; queued?: number; held?: boolean },
): RowFlags {
  const me = opts.me;
  const isReviewer = me ? mr.reviewers.includes(me) : false;
  const approved = me ? mr.approvedBy.includes(me) : false;
  return {
    mine: me ? mr.author === me : false,
    waitingOnYou: isReviewer && !approved,
    youApproved: approved,
    red: mr.pipeline === 'FAILED',
    held: Boolean(opts.held),
    unreviewed: !mr.draft && mr.reviewers.length === 0 && mr.approvedBy.length === 0,
    conflict: mr.conflicts,
    draft: mr.draft,
    changed: Boolean(opts.changed),
    watched: Boolean(opts.watched),
    queued: opts.queued ?? 0,
  };
}

export interface FlagSpec {
  glyph: string;
  colour: string;
  label: string;
  bold?: boolean;
}

const BLANK: FlagSpec = { glyph: ' ', colour: 'gray', label: '' };

/**
 * One table drives the row glyphs and the key, so the key cannot describe a colour the
 * rows do not actually use. Slots are mutually exclusive, which is why a colour may
 * repeat across slots but never within one.
 */
export const FLAG_SLOTS: { name: string; specs: FlagSpec[] }[] = [
  {
    name: 'you',
    specs: [
      { glyph: 'W', colour: 'yellow', label: 'waiting on you', bold: true },
      { glyph: 'A', colour: 'cyan', label: 'yours' },
      { glyph: '✓', colour: 'green', label: 'approved' },
    ],
  },
  {
    name: 'blocked',
    specs: [
      { glyph: 'H', colour: 'magenta', label: 'held', bold: true },
      { glyph: '×', colour: 'red', label: 'red' },
      { glyph: '!', colour: 'red', label: 'conflict', bold: true },
      { glyph: '~', colour: 'gray', label: 'draft' },
    ],
  },
  {
    name: 'attention',
    specs: [
      { glyph: '◆', colour: 'magenta', label: 'changed', bold: true },
      { glyph: '•', colour: 'blue', label: 'watched' },
    ],
  },
  {
    name: 'queue',
    specs: [{ glyph: 'Q', colour: 'yellow', label: 'queued', bold: true }],
  },
];

export const PIPELINE_LEGEND: FlagSpec[] = [
  { glyph: '●', colour: 'green', label: 'passed' },
  { glyph: '✗', colour: 'red', label: 'failed' },
  { glyph: '◐', colour: 'yellow', label: 'running' },
  { glyph: '○', colour: 'gray', label: 'skipped' },
];

function pick(specs: FlagSpec[], index: number | null): FlagSpec {
  return index === null ? BLANK : specs[index] ?? BLANK;
}

/** Fixed width so the columns to the right never shift between rows. */
export function flagCells(f: RowFlags): FlagSpec[] {
  return [
    pick(FLAG_SLOTS[0]!.specs, f.waitingOnYou ? 0 : f.mine ? 1 : f.youApproved ? 2 : null),
    pick(FLAG_SLOTS[1]!.specs, f.held ? 0 : f.red ? 1 : f.conflict ? 2 : f.draft ? 3 : null),
    pick(FLAG_SLOTS[2]!.specs, f.changed ? 0 : f.watched ? 1 : null),
    pick(FLAG_SLOTS[3]!.specs, f.queued > 0 ? 0 : null),
  ];
}

export function flagString(f: RowFlags): string {
  return flagCells(f)
    .map((c) => c.glyph)
    .join('');
}

/** Shape carries the status as well as colour, so a red is still a red in grayscale. */
export function pipelineGlyph(status: PipelineStatus): string {
  switch (status) {
    case 'SUCCESS':
      return '●';
    case 'FAILED':
      return '✗';
    case 'RUNNING':
    case 'PENDING':
    case 'PREPARING':
      return '◐';
    case null:
    case undefined:
      return '·';
    default:
      return '○';
  }
}

/** U+FE0F takes a cell in Ink's layout but none on screen, so a clipped line loses its last letter. */
export function withoutEmojiSelector(text: string): string {
  return text.replace(/\u{FE0F}/gu, '');
}

/** Real emoji, plus the `:sparkles:` shortcodes some authors commit literally. */
const LEADING_EMOJI =
  /^(?:(?:[\p{Extended_Pictographic}\p{Emoji_Presentation}\u{FE0F}\u{200D}\u{20E3}]+|:[a-z0-9_+-]{2,30}:)\s*)+/u;

/**
 * Titles arrive as "🐛 (ABC-3568) Scope the ...". The emoji is noise next to a pipeline
 * glyph and the ticket already has its own column, so both come off. Stripping a generic
 * run of non-word characters would eat the opening bracket and leave "ABC-3568)".
 */
export function cleanTitle(title: string, ticket: string | null): string {
  const draft = /^draft:\s*/i.exec(title);
  let out = draft ? title.slice(draft[0].length) : title;
  out = out.replace(LEADING_EMOJI, '');
  if (ticket) {
    out = out.replace(new RegExp(`^\\(?${ticket}\\)?\\s*[:\\-]?\\s*`), '');
    out = out.replace(LEADING_EMOJI, '');
  }
  out = out.trim();
  if (!out) return title;
  return draft ? `Draft: ${out}` : out;
}

/** Coarse but never wrong: seconds up to a minute, then m, h, d, y. */
export function shortDuration(ms: number): string {
  const secs = Math.max(Math.floor(ms / 1000), 0);
  if (secs < 60) return `${secs}s`;
  const mins = Math.floor(secs / 60);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  if (days < 365) return `${days}d`;
  return `${Math.floor(days / 365)}y`;
}

export function age(iso: string, now = Date.now()): string {
  return shortDuration(now - new Date(iso).getTime());
}

export interface Freshness {
  label: string;
  colour: string;
  stale: boolean;
}

/**
 * A failed poll leaves the data looking exactly like a quiet morning, so the age of the
 * last successful fetch is coloured: past one interval it is overdue, past three the
 * refresh is most likely broken.
 */
export function freshness(lastUpdated: number | null, now: number, pollMs: number): Freshness {
  if (lastUpdated === null) return { label: 'not loaded', colour: 'yellow', stale: true };
  const ms = Math.max(now - lastUpdated, 0);
  const label = `updated ${shortDuration(ms)} ago`;
  if (ms > pollMs * 3) return { label, colour: 'red', stale: true };
  if (ms > pollMs * 1.5) return { label, colour: 'yellow', stale: true };
  return { label, colour: 'gray', stale: false };
}

export function pad(s: string, width: number): string {
  const text = s.length > width ? `${s.slice(0, Math.max(width - 1, 0))}…` : s;
  return text.padEnd(width, ' ');
}

export function padStart(s: string, width: number): string {
  const text = s.length > width ? s.slice(0, width) : s;
  return text.padStart(width, ' ');
}

/** Sorts the rows the way a reviewer reads them: your queue first, then what is blocked. */
export function sortForReview(mrs: Mr[], flagsFor: (mr: Mr) => RowFlags): Mr[] {
  const rank = (mr: Mr): number => {
    const f = flagsFor(mr);
    if (f.queued > 0) return 0;
    if (f.waitingOnYou) return 1;
    if (f.changed) return 2;
    if (f.red) return 3;
    if (f.mine) return 4;
    return 5;
  };
  return [...mrs].sort((a, b) => {
    const d = rank(a) - rank(b);
    if (d !== 0) return d;
    return new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime();
  });
}
