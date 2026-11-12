import { SEVERITY_ORDER, type QueuedComment, type ReplyOutcome, type Severity } from './types.js';

export type QueueInput = Omit<QueuedComment, 'id' | 'createdAt' | 'status'>;

const OUTCOMES: ReplyOutcome[] = ['fixed', 'not-fixed', 'disagree'];

function severityOf(raw: unknown, kind: string, index: number): Severity {
  if (kind === 'reply' && (raw === undefined || raw === '')) return 'MINOR';
  const severity = String(raw ?? '').toUpperCase() as Severity;
  if (!SEVERITY_ORDER.includes(severity)) throw new Error(`queue item ${index}: unknown severity ${String(raw)}`);
  return severity;
}

function replyFields(c: Record<string, unknown>, index: number): Pick<QueueInput, 'replyTo' | 'outcome'> {
  const outcome = c['outcome'] as ReplyOutcome;
  if (!c['replyTo']) throw new Error(`queue item ${index}: a reply needs replyTo`);
  if (!OUTCOMES.includes(outcome)) throw new Error(`queue item ${index}: outcome must be ${OUTCOMES.join(', ')}`);
  return { replyTo: String(c['replyTo']), outcome };
}

/** Rebuilt field by field: an agent reads the author's text, so nothing it sends may mark, send or decide. */
export function queueInput(item: unknown, index: number): QueueInput {
  const c = (item ?? {}) as Record<string, unknown>;
  const kind = String(c['kind'] ?? 'finding');
  if (kind !== 'finding' && kind !== 'reply') {
    throw new Error(`queue item ${index}: an agent cannot queue a ${kind}`);
  }
  const required = ['projectPath', 'projectId', 'iid', 'body', ...(kind === 'finding' ? ['severity'] : [])];
  const missing = required.filter((k) => c[k] === undefined || c[k] === null || c[k] === '');
  if (missing.length) throw new Error(`queue item ${index}: missing ${missing.join(', ')}`);
  return {
    projectPath: String(c['projectPath']),
    projectId: Number(c['projectId']),
    iid: Number(c['iid']),
    webUrl: String(c['webUrl'] ?? ''),
    severity: severityOf(c['severity'], kind, index),
    body: String(c['body']),
    diffHunk: c['diffHunk'] as string | undefined,
    position: c['position'] as QueueInput['position'],
    createdBy: String(c['createdBy'] ?? 'review'),
    ...(kind === 'reply' ? { kind: 'reply' as const, ...replyFields(c, index) } : {}),
  };
}
