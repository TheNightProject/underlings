import { createHash } from 'node:crypto';
import { afterFetch, BAD_KEY, engine, failure, inbox, MR_KEY, notify, requireEngine, still, supports } from './engine.mjs';
import { keyOf, keyParts, shortKey as named } from './refs.mjs';

const ARCHIVE_PAGE = 25;
const MAX_BODY = 20_000;
let unhook = null;
let log = () => {};
let lastProblem = null;

export const ACTIONS = {
  'archive-mr': { verify: verifyArchiveMr, run: archiveMr },
  'archive-closed': { verify: verifyArchiveClosed, run: archiveClosed },
};

export const ROUTES = {
  'GET /api/matrix/queue-archive': ({ query }) => readArchive(query.get('page')),
};

export function start(config, shell) {
  log = shell?.log ?? (() => {});
  unhook = afterFetch(tidyAfterFetch);
}

export function stop() {
  unhook?.();
  unhook = null;
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const markOf = (ids) => createHash('sha1').update([...ids].sort().join(',')).digest('hex').slice(0, 12);

export async function tidyAfterFetch(data) {
  if (!supports('tidyQueue')) return say('the review engine needs rebuilding before findings on merged MRs can expire');
  try {
    const report = await engine.tidyQueue(data.mrs);
    if (report.failed.length) say(`could not ask GitLab whether every queued MR is still open: ${report.failed[0].replace(/^\S+: /, '')}`);
    else lastProblem = null;
    if (report.revived?.length) log(`Back in the queue, its MR reopened: ${perMr(report.revived, () => null)}`);
    if (report.expired.length) log(`Expired ${plural(report.expired.length, 'queued item')} never posted: ${perMr(report.expired, (c) => c.expiredReason)}`);
    if (report.revived?.length || report.expired.length) notify('matrix');
  } catch (err) {
    say(`could not tidy the review queue: ${err.message}`);
  }
}

function say(problem) {
  if (problem === lastProblem) return;
  lastProblem = problem;
  log(problem);
}

function perMr(items, whyOf) {
  const byMr = new Map();
  for (const c of items) {
    const key = keyOf(c);
    byMr.set(key, { n: (byMr.get(key)?.n ?? 0) + 1, why: whyOf(c) });
  }
  return [...byMr].map(([key, { n, why }]) => `${n} on ${named(key)}${why ? ` (${why})` : ''}`).join(', ');
}

function groups() {
  return engine.archivable(engine.loadQueue(), inbox.mrs);
}

// A closed MR can be reopened, and its posted history is what caps full auto's replies, so only its own Archive moves it.
const FOR_GOOD = new Set(['MR merged', 'test data']);

function closedPlan(all) {
  const known = all.filter((g) => FOR_GOOD.has(g.why));
  const count = (list) => list.reduce((n, g) => n + g.ids.length, 0);
  const test = known.filter((g) => g.why === 'test data');
  const closed = known.filter((g) => g.why !== 'test data');
  return { groups: known, items: count(closed), mrs: closed.length, test: count(test), mark: markOf(known.flatMap((g) => g.ids)) };
}

// Counted over the whole queue, since the page holds only the newest settled items.
export function queueCleanup() {
  if (!inbox || !supports('archivable')) return null;
  const all = groups();
  const { items, mrs, test, mark } = closedPlan(all);
  return {
    groups: all.map((g) => ({ key: g.key, items: g.ids.length, why: g.why, mark: markOf(g.ids) })),
    closed: { items, mrs, test, mark },
  };
}

function needInbox() {
  requireEngine('archivable', 'archiveQueue', 'loadQueue');
  if (!inbox) throw failure(503, 'the MR list has not loaded, so which MRs have closed is not known');
}

function verifyArchiveClosed({ expect }) {
  needInbox();
  const plan = closedPlan(groups());
  still(expect, { items: plan.items, mrs: plan.mrs, test: plan.test, mark: plan.mark }, 'the findings on merged MRs');
  if (!plan.groups.length) throw failure(404, 'nothing on a merged MR is left to archive');
  return plan;
}

function archiveClosed(payload, plan) {
  const byWhy = new Map();
  for (const g of plan.groups) byWhy.set(g.why, [...(byWhy.get(g.why) ?? []), ...g.ids]);
  let archived = 0;
  for (const [why, ids] of byWhy) archived += engine.archiveQueue(ids, why).length;
  const said = [plan.mrs && `${plural(plan.items, 'item')} on ${plural(plan.mrs, 'merged MR')}`, plan.test && `${plural(plan.test, 'test item')}`].filter(Boolean).join(' and ');
  return archived === plan.items + plan.test ? `Archived ${said}` : `Archived ${archived} of ${plan.items + plan.test}: the rest changed as it ran`;
}

async function verifyArchiveMr({ key, expect }) {
  needInbox();
  requireEngine('checkStates');
  if (typeof key !== 'string' || !MR_KEY.test(key)) throw failure(400, BAD_KEY);
  if (inbox.mrs.some((mr) => keyOf(mr) === key)) throw failure(409, `${named(key)} is open, so its findings stay`);
  const seen = groups().find((g) => g.key === key);
  if (!seen) throw failure(404, `nothing settled is left on ${named(key)}`);
  still(expect, { items: seen.ids.length, mark: markOf(seen.ids) }, `the findings on ${named(key)}`);
  if (seen.why) return seen;
  const { projectPath, iid } = keyParts(key);
  const { failed } = await engine.checkStates([{ projectPath, iid }], { limit: 1 });
  if (failed.length) throw failure(502, `GitLab could not say whether ${named(key)} is closed: ${failed[0].replace(/^\S+: /, '')}`);
  const why = groups().find((g) => g.key === key)?.why;
  if (!why) throw failure(409, `GitLab has not said ${named(key)} is merged or closed, so its findings stay`);
  return { ...seen, why };
}

function archiveMr({ key }, group) {
  const archived = engine.archiveQueue(group.ids, group.why).length;
  return `Archived ${plural(archived, 'item')} on ${named(key)}`;
}

export function readArchive(pageParam) {
  const { loadArchive } = requireEngine('loadArchive');
  const page = Math.max(0, Number.parseInt(pageParam ?? '0', 10) || 0);
  const { total, items } = loadArchive({ offset: page * ARCHIVE_PAGE, limit: ARCHIVE_PAGE });
  return { page, pageSize: ARCHIVE_PAGE, total, items: items.map(archivedView) };
}

function archivedView(i) {
  const position = i.position ?? {};
  return {
    id: i.id,
    key: keyOf(i),
    webUrl: i.webUrl,
    severity: i.severity,
    kind: i.kind ?? (i.replyTo ? 'reply' : 'finding'),
    verdict: i.verdict ?? null,
    outcome: i.outcome ?? null,
    body: String(i.body ?? '').slice(0, MAX_BODY),
    path: position.new_path ?? position.old_path ?? null,
    line: position.new_line ?? position.old_line ?? null,
    status: i.status,
    createdBy: i.createdBy,
    createdAt: i.createdAt,
    postedAt: i.postedAt ?? null,
    expiredReason: i.expiredReason ?? null,
    archivedAt: i.archivedAt,
    why: i.why,
  };
}
