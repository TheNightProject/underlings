import { renderCommentBody, type SendHow } from '../comment.js';
import { RELEASE_NOTE_BARE } from '../config.js';
import { anchor } from '../diffpos.js';
import { keyOf, type MrRef } from '../refs.js';
import type { OwnActivity, QueuedComment } from '../types.js';
import { CHANGES_NOTE } from '../wording.js';
import { graphql, mutate, rest, viewerLogin } from './github.js';
import { fetchPrDiscussions, fetchPrFiles, prVars, RATE } from './github-prs.js';
import { noteOwnActivityOn } from './store.js';

const REVIEW_PAGES = 5;

const pulls = (r: MrRef): string => `/repos/${r.projectPath}/pulls/${r.iid}`;
const issue = (r: MrRef): string => `/repos/${r.projectPath}/issues/${r.iid}`;
const post = (body: unknown): RequestInit => ({ method: 'POST', body: JSON.stringify(body) });
const keyIn = (r: MrRef): string => keyOf({ ...r, provider: 'github' });

/** A review's own words and a conversation comment are listed beside the threads, but GitHub threads neither. */
const isPlain = (id: string): boolean => /^(?:comment|review)-\d+$/.test(id);

function own(r: MrRef, delta: Partial<OwnActivity>): void {
  try {
    noteOwnActivityOn(keyIn(r), delta);
  } catch {
    // The write has reached GitHub, and failing it now would get it sent again.
  }
}

const NODE_QUERY = `query PrNode($owner: String!, $name: String!, $number: Int!) { ${RATE} repository(owner: $owner, name: $name) { pullRequest(number: $number) { id headRefOid } } }`;

export async function prNode(r: MrRef): Promise<{ id: string; headRefOid: string }> {
  const data = await graphql<{ repository: { pullRequest: { id: string; headRefOid: string } | null } | null }>(NODE_QUERY, prVars(r));
  const pr = data.repository?.pullRequest;
  if (!pr) throw new Error(`GitHub has no ${keyIn(r)}`);
  return pr;
}

interface Placed {
  head: string;
  path: string;
  line: number;
  side: 'LEFT' | 'RIGHT';
}

/** On the line in the pull request's diff as it is now, or null when the line is in no hunk of it. */
async function placeOnDiff(item: QueuedComment): Promise<Placed | null> {
  const requested = item.position!;
  const path = requested.new_path ?? requested.old_path ?? '';
  const [{ files }, node] = await Promise.all([fetchPrFiles(item), prNode(item)]);
  const file = files.find((f) => f.newPath === path || f.oldPath === path);
  const fixed = file?.diff ? anchor(requested, file.diff) : null;
  if (!file || !fixed) return null;
  const right = fixed.new_line !== undefined;
  return { head: node.headRefOid, path: file.newPath, line: (right ? fixed.new_line : fixed.old_line)!, side: right ? 'RIGHT' : 'LEFT' };
}

/** The thread a line comment opened, by its first comment, so a posted finding is matched to its thread as GitLab's are. */
async function threadOf(r: MrRef, commentId: number): Promise<string | null> {
  const threads = await fetchPrDiscussions(r).catch(() => []);
  return threads.find((d) => d.resolvable && d.notes[0]?.id === commentId)?.id ?? null;
}

export async function postPrComment(r: MrRef, body: string): Promise<{ id: number }> {
  const made = await rest<{ id: number }>(`${issue(r)}/comments`, post({ body }));
  own(r, { notes: 1 });
  return { id: made.id };
}

/** A finding on a line opens a thread there; one with no line, or a line the diff no longer has, is a comment on the conversation. */
export async function postPrFinding(item: QueuedComment, how: SendHow = {}): Promise<{ id: string }> {
  const placed = item.position ? await placeOnDiff(item) : null;
  const line = item.position?.new_line ?? item.position?.old_line;
  const where = item.position && !placed ? `\`${item.position.new_path ?? item.position.old_path ?? ''}${line ? `:${line}` : ''}\`\n\n` : '';
  const body = where + renderCommentBody(item, how);
  if (!placed) return { id: `comment-${(await postPrComment(item, body)).id}` };
  const made = await rest<{ id: number }>(`${pulls(item)}/comments`, post({ body, commit_id: placed.head, path: placed.path, line: placed.line, side: placed.side }));
  // GitHub files a lone line comment under a review of its own, so it counts twice.
  own(item, { notes: 2, unresolved: 1 });
  return { id: (await threadOf(item, made.id)) ?? String(made.id) };
}

/** A plain comment has no thread to answer in, so the answer is a comment of its own. */
export async function replyOnPr(r: MrRef, threadId: string, body: string): Promise<void> {
  if (isPlain(threadId)) {
    await postPrComment(r, body);
    return;
  }
  await mutate(
    'mutation PrReply($thread: ID!, $body: String!) { addPullRequestReviewThreadReply(input: { pullRequestReviewThreadId: $thread, body: $body }) { comment { id } } }',
    { thread: threadId, body },
  );
  own(r, { notes: 2 });
}

export async function resolveOnPr(r: MrRef, threadId: string, resolved: boolean): Promise<void> {
  if (isPlain(threadId)) throw new Error('GitHub resolves only a thread on a line, not a plain comment');
  const [name, field] = resolved ? ['PrResolve', 'resolveReviewThread'] : ['PrUnresolve', 'unresolveReviewThread'];
  await mutate(`mutation ${name}($thread: ID!) { ${field}(input: { threadId: $thread }) { thread { isResolved } } }`, { thread: threadId });
  own(r, { unresolved: resolved ? -1 : 1 });
}

interface GhRestReview {
  id: number;
  state: string;
  user: { login: string } | null;
}

const VERDICTS = new Set(['APPROVED', 'CHANGES_REQUESTED', 'DISMISSED']);

/** Your last approval, change request or dismissed one, which is the one that stands. */
async function myVerdict(r: MrRef): Promise<GhRestReview | null> {
  const me = await viewerLogin();
  let last: GhRestReview | null = null;
  for (let page = 1; page <= REVIEW_PAGES; page += 1) {
    const reviews = await rest<GhRestReview[]>(`${pulls(r)}/reviews?per_page=100&page=${page}`);
    for (const review of reviews) if (review.user?.login === me && VERDICTS.has(review.state)) last = review;
    if (reviews.length < 100) break;
  }
  return last;
}

const dismiss = (r: MrRef, id: number, message: string): Promise<unknown> =>
  rest(`${pulls(r)}/reviews/${id}/dismissals`, { method: 'PUT', body: JSON.stringify({ message, event: 'DISMISS' }) });

const review = (r: MrRef, event: 'APPROVE' | 'REQUEST_CHANGES', body?: string): Promise<unknown> => rest(`${pulls(r)}/reviews`, post({ event, ...(body ? { body } : {}) }));

/** GitHub takes an approval back by dismissing the review, which it shows on the pull request with the reason. */
export async function setPrApproval(r: MrRef, approved: boolean): Promise<void> {
  if (approved) {
    await review(r, 'APPROVE');
    own(r, { notes: 1, approvals: 1 });
    return;
  }
  const mine = await myVerdict(r);
  if (mine?.state !== 'APPROVED') throw new Error(`you have no approval on ${keyIn(r)} to take back`);
  await dismiss(r, mine.id, 'Approval withdrawn.');
  own(r, { approvals: -1 });
}

/**
 * A hold is a review that requests changes, which blocks the merge wherever the branch rules ask for reviews.
 * GitHub wants the reason in the review itself, so the note goes with it rather than after it.
 * Lifting it dismisses that review; one you have since approved over is already lifted.
 */
export async function setPrHold(r: MrRef, held: boolean, note?: string): Promise<{ status: string | null; said: true }> {
  if (held) {
    await review(r, 'REQUEST_CHANGES', note || CHANGES_NOTE);
    own(r, { notes: 1 });
    return { status: 'REQUESTED_CHANGES', said: true };
  }
  const mine = await myVerdict(r);
  if (mine?.state === 'CHANGES_REQUESTED') await dismiss(r, mine.id, note || RELEASE_NOTE_BARE);
  return { status: null, said: true };
}
