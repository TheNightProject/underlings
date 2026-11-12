import { keyOf, shortKey } from '../refs.js';
import type { QueuedComment } from '../types.js';

export interface AutoLogRow {
  at: string;
  key: string;
  mr: string;
  what: string;
  text: string;
}

const OUTCOME: Record<string, string> = { fixed: 'fixed', 'not-fixed': 'not fixed', disagree: 'disagree' };

function describe(c: QueuedComment): string {
  if (c.kind === 'verdict') return c.verdict === 'approve' ? 'approved' : 'requested changes';
  if (c.kind === 'reply') return `reply, ${OUTCOME[c.outcome ?? ''] ?? '?'}${c.auto?.resolved ? ', resolved' : ''}`;
  return c.severity;
}

export function autoLogRows(queue: QueuedComment[]): AutoLogRow[] {
  return queue
    .filter((c) => c.status === 'posted' && c.auto?.sentAuto)
    .sort((a, b) => (b.postedAt ?? '').localeCompare(a.postedAt ?? ''))
    .map((c) => ({
      at: c.postedAt ?? '',
      key: keyOf(c),
      mr: shortKey(keyOf(c)),
      what: describe(c),
      text: c.body.split('\n')[0] ?? '',
    }));
}

export function autoCounts(queue: QueuedComment[]): { sent: number; waiting: number; shadow: number } {
  const pending = queue.filter((c) => c.status === 'pending' && c.auto);
  return {
    sent: queue.filter((c) => c.status === 'posted' && c.auto?.sentAuto).length,
    waiting: pending.filter((c) => c.auto?.held).length,
    shadow: pending.filter((c) => c.auto?.level === 'shadow' && !c.auto.held).length,
  };
}
