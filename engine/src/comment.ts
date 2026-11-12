import { ATTRIBUTION, AUTO_FOOTER } from './config.js';
import { DEFAULT_FOOTERS, type Footers } from './settings.js';
import type { QueuedComment } from './types.js';

export interface SendHow {
  automatic?: boolean;
  footer?: boolean;
  /** The claim the caller already took, so the post does not take a second one. */
  claimedBy?: string;
  footers?: Footers;
}

/** The usual trailer says you read it first, which is false of anything sent automatically. */
export function trailer(how: SendHow = {}): string {
  const footers = how.footers ?? DEFAULT_FOOTERS;
  if (!how.automatic) return footers.posted;
  return how.footer ? footers.auto : '';
}

/**
 * The finding on its own. The review command writes the severity into the body and
 * sometimes the trailer too, so both are taken off here and added back only on the way
 * out, leaving one definition of what a comment actually says.
 */
export function plainBody(comment: QueuedComment, footers: Footers = DEFAULT_FOOTERS): string {
  const body = [footers.posted, footers.auto].reduce(withoutEnding, comment.body).replace(ATTRIBUTION, '').replace(AUTO_FOOTER, '').trimEnd();
  const tag = new RegExp(`^\\*{0,2}${comment.severity}\\*{0,2}\\s*:?\\s*`, 'i');
  return body.replace(tag, '');
}

// A footer of your own can be any words, so it comes off only where a footer goes, never from the middle of a finding.
function withoutEnding(text: string, ending: string): string {
  const trimmed = text.trimEnd();
  return ending && trimmed.endsWith(ending) ? trimmed.slice(0, -ending.length) : text;
}

/** The body as it will appear on GitLab, severity and trailer each said once. */
export function renderCommentBody(comment: QueuedComment, how: SendHow = {}): string {
  const text =
    comment.kind === 'reply'
      ? plainBody(comment, how.footers)
      : `**${comment.severity}** ${plainBody(comment, how.footers)}`.trim();
  const end = trailer(how);
  return end ? `${text}\n\n${end}` : text;
}
