import { dayIn, timeZone } from './locale.js';

/** Eight levels, lowest to highest. A blank would read as a gap in the data. */
const LEVELS = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'] as const;

/**
 * A run of daily counts as one line of blocks, scaled to its own peak. Zero is drawn as
 * the lowest block rather than a space, so a quiet day and a missing day look different.
 */
export function sparkline(values: number[], peak?: number): string {
  if (values.length === 0) return '';
  const top = peak ?? Math.max(...values);
  if (top <= 0) return LEVELS[0]!.repeat(values.length);
  return values
    .map((v) => {
      const clamped = Math.max(Math.min(v, top), 0);
      const step = Math.round((clamped / top) * (LEVELS.length - 1));
      return LEVELS[step] ?? LEVELS[0];
    })
    .join('');
}

/**
 * Counts per day over the last `days`, oldest first. Dates outside the window are
 * dropped rather than folded into the ends, which would spike the first bar.
 */
export function dailyCounts(dates: string[], days: number, now = Date.now(), zone = timeZone()): number[] {
  const out = new Array<number>(days).fill(0);
  const today = Date.parse(dayIn(now, zone));

  for (const iso of dates) {
    const when = Date.parse(iso);
    if (Number.isNaN(when)) continue;
    const daysAgo = Math.round((today - Date.parse(dayIn(when, zone))) / 86_400_000);
    if (daysAgo < 0 || daysAgo >= days) continue;
    const index = days - 1 - daysAgo;
    out[index] = (out[index] ?? 0) + 1;
  }
  return out;
}
