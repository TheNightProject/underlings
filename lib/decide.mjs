import { agentReading, BAD_KEY, failure, forgeFor, inbox, meFor, MR_KEY, mrFor, refreshInbox, requireEngine, still } from './engine.mjs';
import { keyOf } from './refs.mjs';

const VERDICTS = new Set(['approve', 'changes']);

export const ACTIONS = {
  decide: { verify: verifyDecision, run: decide },
  'review-own': { verify: verifyOwnReview, run: reviewOwn },
};

export const ROUTES = {
  'GET /api/matrix/decide': () => {
    const engine = requireEngine('loadSettings', 'loadState', 'loadQueue');
    return { tidies: Boolean(engine.loadSettings().closeWorkspaceWhenDone), mrs: postedSinceVerdicts(engine) };
  },
};

// Counted from the whole queue, which the page's snapshot trims to the newest settled items across every MR.
export function postedSinceVerdicts(engine) {
  const verdicts = engine.loadState().verdicts ?? {};
  const mrs = new Map((inbox?.mrs ?? []).map((mr) => [keyOf(mr), mr]));
  const atComments = commentsLevel(engine, mrs);
  const tallies = {};
  for (const item of engine.loadQueue()) {
    const key = keyOf(item);
    if (mrs.has(key) && settledSince(item, verdicts[key]?.at, atComments(key))) tally(tallies[key] ??= { posted: 0, dropped: 0, kinds: {}, lastPost: '' }, item);
  }
  return Object.fromEntries(Object.entries(tallies).filter(([, t]) => t.posted));
}

// Full auto's own sends ask for your verdict only where the author is at Comments, since at Comments + verdict it gives one itself.
function commentsLevel(engine, mrs) {
  const settings = engine.loadSettings();
  const rules = typeof engine.peopleRules === 'function' ? engine.peopleRules(String(settings.fullAuto ?? '')) : { people: engine.parsePeople(String(settings.fullAuto ?? '')) };
  const levelOf = typeof engine.levelForMr === 'function' ? (mr) => engine.levelForMr(mr, inbox?.me, rules) : (mr) => rules.people.find((p) => p.username === mr.author.toLowerCase())?.level ?? null;
  return (key) => levelOf(mrs.get(key)) === 'comments';
}

const settledAt = (item) => item.postedAt || item.createdAt || '';

// Anything you posted yourself counts, whatever full auto had marked it; what full auto sent counts only at Comments.
function settledSince(item, verdictAt = '', atComments = false) {
  if (item.kind === 'verdict' || item.status === 'pending' || settledAt(item) <= verdictAt) return false;
  return !item.auto?.sentAuto || atComments;
}

function tally(counts, item) {
  if (item.status === 'discarded') counts.dropped += 1;
  if (item.status !== 'posted') return;
  const kind = (item.kind ?? (item.replyTo ? 'reply' : 'finding')) === 'reply' ? 'reply' : item.severity;
  counts.posted += 1;
  if (kind) counts.kinds[kind] = (counts.kinds[kind] ?? 0) + 1;
  if (settledAt(item) > counts.lastPost) counts.lastPost = settledAt(item);
}

async function verifyDecision({ key, verdict, expect }) {
  const engine = requireEngine('decide', 'forgeOf', 'loadQueue');
  if (!VERDICTS.has(verdict)) throw failure(400, 'a verdict is approve or changes');
  const { listed, live } = await readLive(key);
  if (live.author === meFor(live)) throw failure(403, `${key} is your own MR, so it takes no verdict from you`);
  // A stale row would send its old head again, so every retry would be refused until the next poll.
  if (live.sha !== listed.sha) await refreshInbox();
  still(expect, { sha: live.sha }, `the head of ${key}`);
  const pending = engine.loadQueue().filter((c) => c.status === 'pending' && keyOf(c) === key).length;
  if (pending) throw failure(409, `${pending} more ${pending === 1 ? 'item was' : 'items were'} queued for ${key} since you looked`);
  // GitLab names the project, but the review workspace was named after the listed row's label.
  return { ...live, repoLabel: listed.repoLabel };
}

async function decide({ key, verdict }, mr) {
  const outcome = await requireEngine('decide').decide(mr, verdict, { me: meFor(mr) });
  return decisionText(key, verdict, outcome);
}

function decisionText(key, verdict, { liftedHold, warning, workspace }) {
  const done = [verdict === 'approve' ? `Approved ${key}` : `Changes requested on ${key}`, liftedHold && 'hold lifted', workspace.closed && 'review workspace closed'];
  const kept = workspace.kept ? `. The review workspace stays open: ${workspace.kept}` : '';
  return done.filter(Boolean).join(', ') + kept + (warning ? `. GitLab said: ${warning}` : '');
}

// startReview took its hold option in the same build as decide, so an older engine would hold your own MR.
async function verifyOwnReview({ key }) {
  requireEngine('decide', 'startReview', 'forgeOf');
  const { listed, live } = await readLive(key);
  if (!meFor(live) || live.author !== meFor(live)) throw failure(403, `${key} is not your MR, so it takes a review rather than a self-review`);
  if (agentReading(key)) throw failure(409, `an agent is already reading ${key}`);
  return listed;
}

async function reviewOwn({ key }, mr) {
  const { alreadyWatched } = await requireEngine('startReview').startReview(mr, undefined, { hold: false });
  return `Reviewing your ${key}, with no hold${alreadyWatched ? '' : ', and now watching it for changes'}`;
}

async function readLive(key) {
  if (typeof key !== 'string' || !MR_KEY.test(key)) throw failure(400, BAD_KEY);
  const listed = mrFor(key);
  const forge = forgeFor(listed, 'one');
  const live = await forge.one(listed);
  if (!live) throw failure(404, `${forge.name} has no ${key}`);
  return { listed, live };
}
