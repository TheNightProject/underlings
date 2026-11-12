// The defaults for what reviews post as you, in a module of their own so the settings can name them without importing config.ts and its prompts.

/** A hold with no note is a bare "requested changes" the author cannot act on, so the reason goes up with it. */
export const HOLD_NOTE =
  "I'm reviewing this now, so I've put a hold on merging until I've finished. " +
  'It comes off as soon as my comments are up.';

/** Appended to every posted comment, matching the review command's trailer. */
export const ATTRIBUTION =
  "_Found with Claude's assistance, read and verified by me before posting._";

export const AUTO_FOOTER = '_Sent by my review agent without my reading it first._';
