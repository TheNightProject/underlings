import { BAD_KEY, failure, forgeCan, forgeFor, forgeHas, inbox, meFor, MR_KEY, mrFor, refreshInbox, requireEngine, still } from './engine.mjs';
import { invalidate, mergeState } from './mrdetail.mjs';
import { keyOf, keyParts } from './refs.mjs';

const REBASE_POLL_MS = 2_000;
const REBASE_GIVE_UP_MS = 5 * 60_000;
const FAILED_REBASE_SHOWN_MS = 10 * 60_000;
const MAX_REVIEWERS = 20;
const MAX_FIX_THREADS = 40;
const MERGE_WAYS = new Set(['now', 'green']);
const WHEN_GREEN = new Set(['ci_still_running', 'ci_must_pass', 'not_approved', 'discussions_not_resolved', 'approvals_syncing']);
const PIPELINE_GOING = new Set(['CREATED', 'WAITING_FOR_RESOURCE', 'PREPARING', 'PENDING', 'RUNNING', 'SCHEDULED']);
const rebases = new Map();
const branches = new Map();
const changing = new Map();

// A rebase, a merge and a fix agent each change the branch, so only one of them is under way per MR.
function oneAtATime(doing, verify, run) {
  return {
    verify: async (payload) => {
      const busy = changing.get(payload.key);
      if (busy) throw failure(409, `${payload.key} is busy ${busy}`);
      changing.set(payload.key, doing);
      try {
        return await verify(payload);
      } catch (err) {
        changing.delete(payload.key);
        throw err;
      }
    },
    run: (payload, live) => run(payload, live).finally(() => changing.delete(payload.key)),
  };
}

export const ACTIONS = {
  rebase: oneAtATime('starting a rebase', verifyRebase, startRebase),
  ready: { verify: verifyReady, run: markReady },
  merge: oneAtATime('merging', verifyMerge, merge),
  reviewers: { verify: verifyReviewers, run: setReviewers },
  rerequest: { verify: verifyRerequest, run: rerequest },
  fix: oneAtATime('starting a fix agent', verifyFix, launchFix),
  'cancel-merge': { verify: verifyCancelMerge, run: cancelMerge },
};

export const ROUTES = {
  'GET /api/matrix/own-mrs': () => readOwnMrs(),
};

export function stop() {
  for (const entry of rebases.values()) clearTimeout(entry.timer);
  rebases.clear();
  branches.clear();
  changing.clear();
}

// GitLab's auto-merge waits for every check, not only the pipeline, so it is offered whenever GitLab would wait.
export function mergeChoice(mr) {
  const state = mergeState(mr.mergeStatus, mr.provider) ?? { status: null, words: 'not checked yet', tone: 'waiting' };
  const ciOnly = state.status === 'ci_still_running' || state.status === 'ci_must_pass';
  const green = WHEN_GREEN.has(state.status) && !mr.draft && !mr.conflicts && (!ciOnly || PIPELINE_GOING.has(mr.pipeline));
  return { ...state, can: state.status === 'mergeable' ? 'now' : green ? 'green' : null, autoMerge: Boolean(mr.autoMerge) };
}

async function readOwnMrs() {
  requireEngine();
  const mine = (inbox?.mrs ?? []).filter((mr) => meFor(mr) && mr.author === meFor(mr));
  for (const key of branches.keys()) if (!mine.some((mr) => keyOf(mr) === key)) branches.delete(key);
  const entries = await Promise.all(mine.map(async (mr) => {
    const branch = forgeHas(mr, 'branchFacts') ? await branchFacts(mr) : null;
    return [keyOf(mr), { merge: mergeChoice(mr), target: branch?.targetBranch ?? null, behind: branch?.behind ?? null, rebase: rebaseShown(keyOf(mr)) }];
  }));
  return { mrs: Object.fromEntries(entries) };
}

// Read again with every list fetch: a retarget leaves the head alone, and new commits on the target leave the MR alone.
function branchFacts(mr) {
  const seen = branches.get(keyOf(mr));
  if (seen?.list === inbox) return seen.read;
  const read = forgeFor(mr).branchFacts(mr).catch(() => null);
  branches.set(keyOf(mr), { list: inbox, read });
  return read;
}

function rebaseShown(key) {
  const entry = rebases.get(key);
  if (entry?.state === 'failed' && Date.now() - entry.at > FAILED_REBASE_SHOWN_MS) rebases.delete(key);
  return rebases.has(key) ? { state: entry.state, since: entry.since, error: entry.error } : null;
}

function ownForge(key, ...methods) {
  if (typeof key !== 'string' || !MR_KEY.test(key)) throw failure(400, BAD_KEY);
  return forgeFor(keyParts(key), 'one', ...methods);
}

async function ownLive(forge, key, expect) {
  const listed = mrFor(key);
  const live = await forge.one(listed);
  if (!live) throw failure(404, `${forge.name} has no ${key}`);
  if (!meFor(live) || live.author !== meFor(live)) throw failure(403, `${key} is ${live.author}'s MR, not yours`);
  if (live.sha !== listed.sha) await refreshInbox();
  still(expect?.sha, live.sha, `the head of ${key}`);
  return live;
}

async function noFixAgent(engine, key) {
  if (await engine.fixRunAlive(key)) throw failure(409, `a fix agent is still open on ${key}, so answer it in its Agent tab, or remove it under Agents`);
}

function notRebasing(key) {
  if (rebases.get(key)?.state === 'running') throw failure(409, `GitLab is still rebasing ${key}`);
}

async function verifyRebase({ key, expect }) {
  const forge = ownForge(key, 'rebase', 'rebaseState');
  const engine = requireEngine('fixRunAlive');
  forgeCan(forge, 'rebase', 'rebase a branch');
  const live = await ownLive(forge, key, expect);
  notRebasing(key);
  if (live.conflicts) throw failure(409, `GitLab cannot rebase ${key} over its conflicts, so fix them with an agent`);
  await noFixAgent(engine, key);
  return live;
}

async function startRebase({ key }, mr) {
  await forgeFor(mr, 'rebase').rebase(mr);
  watchRebase(key, mr);
  return `GitLab is rebasing ${key}`;
}

function watchRebase(key, mr) {
  const entry = { state: 'running', since: Date.now(), error: null, timer: null };
  rebases.set(key, entry);
  const poll = async () => {
    const outcome = await rebaseOutcome(mr).catch((err) => ({ error: err.message }));
    if (rebases.get(key) !== entry) return;
    if (outcome || Date.now() - entry.since >= REBASE_GIVE_UP_MS) return settleRebase(key, entry, outcome ?? { error: 'GitLab had not finished the rebase after five minutes' });
    entry.timer = setTimeout(poll, REBASE_POLL_MS);
  };
  entry.timer = setTimeout(poll, REBASE_POLL_MS);
}

// GitLab keeps the last merge error, so a head that moved is what says the rebase worked.
async function rebaseOutcome(mr) {
  const forge = forgeFor(mr, 'rebaseState', 'one');
  const { inProgress, error } = await forge.rebaseState(mr);
  if (inProgress) return null;
  const now = await forge.one(mr);
  return { error: now && now.sha !== mr.sha ? null : error };
}

function settleRebase(key, entry, { error }) {
  if (error) Object.assign(entry, { state: 'failed', error, at: Date.now() });
  else rebases.delete(key);
  invalidate(key);
  refreshInbox();
}

async function verifyReady({ key, expect }) {
  const live = await ownLive(ownForge(key, 'ready'), key, expect);
  if (!live.draft) throw failure(409, `${key} is not a draft any more`);
  return live;
}

async function markReady({ key }, mr) {
  await forgeFor(mr, 'ready').ready(mr);
  return `Marked ${key} ready`;
}

async function verifyMerge({ key, expect }) {
  const forge = ownForge(key, 'merge', 'branchFacts');
  const engine = requireEngine('fixRunAlive');
  if (!MERGE_WAYS.has(expect?.can)) throw failure(400, 'merge now, or when the pipeline passes?');
  if (expect.can === 'green') forgeCan(forge, 'autoMerge', 'merge once the pipeline passes');
  const live = await ownLive(forge, key, expect);
  const choice = mergeChoice(live);
  if (choice.can !== expect.can) throw failure(409, `the merge status of ${key} changed since you looked: ${choice.words}`);
  notRebasing(key);
  await noFixAgent(engine, key);
  still(expect.target, (await forge.branchFacts(live)).targetBranch, `the target branch of ${key}`);
  return live;
}

const cancelled = new Set();
const mergedHere = new Set();

export function cancelledByYou() {
  return cancelled;
}

export function mergedByYou() {
  return mergedHere;
}

export function failedRebases() {
  return [...rebases].filter(([, entry]) => entry.state === 'failed').map(([key, { since, error }]) => ({ key, since, error }));
}

async function verifyCancelMerge({ key, expect }) {
  const live = await ownLive(ownForge(key, 'cancelAutoMerge'), key, expect);
  if (!live.autoMerge) throw failure(409, `${key} is not set to merge when green any more`);
  return live;
}

async function cancelMerge({ key }, mr) {
  await forgeFor(mr, 'cancelAutoMerge').cancelAutoMerge(mr);
  cancelled.add(key);
  return `${key} no longer merges when green`;
}

async function merge({ key, expect }, mr) {
  const { merged, autoMerge } = await forgeFor(mr, 'merge').merge(mr, { sha: expect.sha, whenGreen: expect.can === 'green' });
  cancelled.delete(key);
  if (merged) mergedHere.add(key);
  if (merged) return `Merged ${key}`;
  return autoMerge ? `${key} merges once its pipeline passes` : `GitLab took the merge of ${key}, and it is still open`;
}

function usernames(engine, list) {
  if (!Array.isArray(list) || list.length > MAX_REVIEWERS) throw failure(400, `reviewers is a list of at most ${MAX_REVIEWERS} GitLab usernames`);
  const names = list.map((name) => (typeof name === 'string' ? engine.typedUsername(name) : null));
  if (names.some((name) => !name)) throw failure(400, 'that is not a GitLab username');
  return [...new Set(names)];
}

const lowered = (names) => (Array.isArray(names) ? names.map((n) => String(n).toLowerCase()).sort() : undefined);

async function verifyReviewers({ key, reviewers, expect }) {
  const forge = ownForge(key, 'setReviewers');
  const names = usernames(requireEngine('typedUsername'), reviewers);
  const live = await ownLive(forge, key, expect);
  still(lowered(expect.reviewers), lowered(live.reviewers), `the reviewers of ${key}`);
  if (JSON.stringify(lowered(names)) === JSON.stringify(lowered(live.reviewers))) throw failure(400, `those are the reviewers of ${key} already`);
  return { mr: live, names };
}

async function setReviewers({ key }, { mr, names }) {
  const now = await forgeFor(mr, 'setReviewers').setReviewers(mr, names);
  return now.length ? `Reviewers on ${key}: ${now.join(', ')}` : `${key} has no reviewers now`;
}

async function verifyRerequest({ key, reviewers, expect }) {
  const forge = ownForge(key, 'rerequest');
  const names = usernames(requireEngine('typedUsername'), reviewers);
  if (!names.length) throw failure(400, 'whose review should be asked for again?');
  const live = await ownLive(forge, key, expect);
  const current = new Map(live.reviewers.map((name) => [name.toLowerCase(), name]));
  const gone = names.find((name) => !current.has(name));
  if (gone) throw failure(409, `${gone} is not a reviewer of ${key} any more`);
  return { mr: live, names: names.map((name) => current.get(name)) };
}

async function rerequest({ key }, { mr, names }) {
  for (const name of names) await forgeFor(mr, 'rerequest').rerequest(mr, name);
  return `Asked ${names.join(', ')} to review ${key} again`;
}

const byId = ([a], [b]) => a.localeCompare(b);
const noteCounts = (threads) => Object.fromEntries(threads.map((t) => [t.id, t.notes.length]).sort(byId));
const sortedById = (seen) => (seen && typeof seen === 'object' && !Array.isArray(seen) ? Object.fromEntries(Object.entries(seen).sort(byId)) : undefined);

// The page's counts must still be GitLab's, or the agent would be handed threads you never saw.
async function verifyFix({ key, discussionId, conflicts, expect }) {
  const forge = ownForge(key, 'discussions', 'branchFacts');
  const engine = requireEngine('launchFix', 'fixRunAlive', 'fixableThreads');
  if (discussionId !== undefined && (typeof discussionId !== 'string' || !discussionId)) throw failure(400, 'which thread?');
  if (conflicts !== undefined && (conflicts !== true || discussionId !== undefined)) throw failure(400, 'fix the conflicts, or the threads?');
  const live = await ownLive(forge, key, expect);
  if (conflicts && !live.conflicts) throw failure(409, `GitLab reports no conflicts on ${key} any more`);
  notRebasing(key);
  await noFixAgent(engine, key);
  const threads = conflicts ? [] : await threadsToFix(engine, forge, live, key, discussionId, expect);
  const { targetBranch } = await forge.branchFacts(live);
  return { mr: live, threads, targetBranch, conflicts: Boolean(conflicts) };
}

async function fixable(engine, forge, mr, discussionId) {
  const discussions = await forge.discussions(mr);
  return discussionId ? discussions.filter((d) => d.id === discussionId && !d.resolved) : engine.fixableThreads(discussions, meFor(mr));
}

// What a fix would be handed now, for a caller that has no page to have seen it on.
export async function fixThreadCounts(key, discussionId) {
  const engine = requireEngine('fixableThreads');
  const mr = mrFor(key);
  return noteCounts(await fixable(engine, forgeFor(mr, 'discussions'), mr, discussionId));
}

async function threadsToFix(engine, forge, live, key, discussionId, expect) {
  const threads = await fixable(engine, forge, live, discussionId);
  invalidate(key);
  still(sortedById(expect.threads), noteCounts(threads), `the threads on ${key}`);
  if (!threads.length) throw failure(409, `nothing on ${key} is left to fix`);
  if (threads.length > MAX_FIX_THREADS) throw failure(400, `${threads.length} threads is more than one agent takes, so fix them one at a time`);
  return threads;
}

async function launchFix({ key, expect }, { mr, threads, targetBranch, conflicts }) {
  const { name } = await requireEngine('launchFix').launchFix(mr, threads, { me: meFor(mr), head: expect.sha, targetBranch, conflicts });
  const where = name ? ` in ${name}` : '';
  if (conflicts) return `An agent is fixing the conflicts on ${key}${where}. It asks you before it pushes.`;
  const what = threads.length === 1 ? '1 comment' : `${threads.length} comments`;
  return `An agent is fixing ${what} on ${key}${where}. It asks you before it pushes or replies.`;
}
