import { BAD_KEY, failure, forgeFor, MR_KEY, mrFor, still } from './engine.mjs';
import { keyParts } from './refs.mjs';
import { numberText } from './locale.mjs';
import { invalidate } from './mrdetail.mjs';

const MAX_REPLY = 20_000;

export const ACTIONS = {
  reply: { verify: verifyReply, run: sendReply },
  resolve: { verify: verifyResolve, run: setResolved },
};

export const ROUTES = {};

async function verifyReply({ key, discussionId, body, expect }) {
  if (typeof body !== 'string' || !body.trim()) throw failure(400, 'the reply needs some text');
  if (body.length > MAX_REPLY) throw failure(400, `a reply is at most ${numberText(MAX_REPLY)} characters`);
  const live = await liveThread(key, discussionId, 'reply');
  still(expect?.notes, live.notes, 'the thread');
  return live;
}

async function sendReply({ key, body }, { mr, discussionId }) {
  await forgeFor(mr, 'reply').reply(mr, discussionId, body);
  return `Replied on ${key}`;
}

async function verifyResolve({ key, discussionId, resolved }) {
  if (typeof resolved !== 'boolean') throw failure(400, 'resolved must be true or false');
  const live = await liveThread(key, discussionId, 'resolve');
  if (live.resolved === resolved) throw failure(409, `the thread was ${resolved ? 'resolved' : 'reopened'} since you looked`);
  return live;
}

async function setResolved({ key, resolved }, { mr, discussionId }) {
  await forgeFor(mr, 'resolve').resolve(mr, discussionId, resolved);
  return `${resolved ? 'Resolved' : 'Reopened'} the thread on ${key}`;
}

// The ids sent to GitLab are the ones read here, never the page's, and the read replaces the drawer's cached copy.
async function liveThread(key, discussionId, write) {
  if (typeof key !== 'string' || !MR_KEY.test(key)) throw failure(400, BAD_KEY);
  const forge = forgeFor(keyParts(key), 'discussions', write);
  if (typeof discussionId !== 'string' || !discussionId) throw failure(400, 'which thread?');
  const mr = mrFor(key);
  const discussions = await forge.discussions(mr);
  invalidate(key);
  const thread = discussions.find((d) => d.id === discussionId);
  if (!thread) throw failure(404, `that thread is not on ${key}`);
  return { mr, discussionId: thread.id, notes: thread.notes.length, resolved: Boolean(thread.resolved) };
}
