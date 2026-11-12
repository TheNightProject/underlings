import { createHash } from 'node:crypto';
import { driverView } from './autoloop.mjs';
import { KINDS as EMAIL_WORDS, needsYou as emailNeedingYou } from './email.mjs';
import { engine, fetchError, fetchErrors, inbox, pollEveryMs, supports } from './engine.mjs';
import { timeText } from './locale.mjs';
import { toolTitles } from './mcptools.mjs';
import { cancelledByYou, failedRebases, mergeChoice, mergedByYou } from './ownmr.mjs';
import { keyOf, shortKey as named } from './refs.mjs';
import { KINDS as SLACK_WORDS, needsYou as slackNeedingYou, placeOf } from './slack.mjs';

const MINUTE = 60_000;
const FINDINGS_SETTLE_MS = 10 * MINUTE;
const PIPELINE_WAIT_MS = 30 * MINUTE;
const HOLDING_QUIET_MS = 15 * MINUTE;
const CHANGES_WAIT_MS = 45 * MINUTE;
const MERGED_SHOWN_MS = 24 * 60 * MINUTE;
const SILENT_POLLS = 3;
const PIPELINE_GOING = new Set(['CREATED', 'WAITING_FOR_RESOURCE', 'PREPARING', 'PENDING', 'RUNNING', 'SCHEDULED']);
const BIG = new Set(['CRITICAL', 'MAJOR']);
const SEVERITY_ORDER = ['CRITICAL', 'MAJOR', 'MINOR', 'NIT', 'QUESTION'];
const WAITING = new Set(['waiting', 'blocked']);
const HOUSEKEEPING = /newer pass|superseded|not in full auto any more|no longer open|its author is at|head moved/;
const TODO_ACTIONS = new Set(['mentioned', 'directly_addressed', 'approval_required']);
const GROUPS = ['system', 'others', 'mine', 'agents'];
const BOT = /(^|[-_.])(bot|bots|jenkins|ci|renovate|dependabot)([-_.]|$)/i;

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const listed = (names) => (names.length < 3 ? names.join(' and ') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);
const hashOf = (parts) => createHash('sha1').update([...parts].sort().join(',')).digest('hex').slice(0, 10);
const kindOf = (c) => c.kind ?? (c.replyTo ? 'reply' : 'finding');
const newest = (items, at) => items.reduce((latest, x) => (at(x) > latest ? at(x) : latest), '');
const oldest = (items, at) => items.reduce((first, x) => (!first || at(x) < first ? at(x) : first), '');

function item(fields) {
  return { tier: 'interrupt', settled: true, also: null, prints: null, settleAfterMs: 0, ...fields };
}

// Everything the rules read, gathered once so the rules themselves stay pure and testable.
export function gather(now = Date.now(), agents = null, panel = null) {
  if (!engine || !inbox) return null;
  const settings = engine.loadSettings();
  return {
    now,
    me: inbox.me,
    accounts: inbox.accounts ?? null,
    mrs: inbox.mrs,
    rows: engine.rowsFor(inbox),
    queue: engine.loadQueue(),
    memory: engine.loadAutoMemory(),
    runs: engine.loadRuns(),
    state: engine.loadState(),
    rules: supports('peopleRules') ? engine.peopleRules(String(settings.fullAuto ?? '')) : { people: engine.parsePeople(String(settings.fullAuto ?? '')), onRequest: null, optedOut: new Set() },
    threads: inbox.threads ?? new Map(),
    todos: inbox.todos ?? [],
    agents: agents ?? [],
    agentsRead: Array.isArray(agents),
    panel,
    email: emailNeedingYou(),
    slack: slackNeedingYou(),
    driver: driverView(),
    fetchError,
    fetchedAt: inbox.fetchedAt,
    forgeErrors: { ...inbox.errors, ...(fetchError ? fetchErrors : null) },
    answeredAt: inbox.answeredAt ?? null,
    pollMs: pollEveryMs(settings),
    waiting: supports('waitingToPost') ? new Set(engine.waitingToPost(engine.loadQueue(), inbox.mrs).map((c) => c.id)) : null,
    engine: {
      levelForMr: supports('levelForMr') ? engine.levelForMr : (mr, me, rules) => rules.people.find((p) => p.username === mr.author.toLowerCase())?.level ?? null,
      isRepeat: supports('isRepeat') ? engine.isRepeat : () => false,
      findingPrint: supports('findingPrint') ? engine.findingPrint : (c) => `${c.position?.new_path ?? ''}|${String(c.body ?? '').split('\n')[0].toLowerCase()}`,
      changeSince: supports('changeSince') ? engine.changeSince : null,
      heldByMe: supports('heldByMe') ? engine.heldByMe : (mr) => String(mr.mergeStatus ?? '').toUpperCase() === 'REQUESTED_CHANGES',
      changesRequestedBy: supports('changesRequestedBy') ? engine.changesRequestedBy : () => [],
    },
    mergeChoice,
    cancelled: cancelledByYou(),
    mergedHere: mergedByYou(),
    rebasesFailed: failedRebases(),
  };
}

// The rules: each returns the items one MR, one agent or the worker itself needs you for. Ids come from the content, so the same findings never get a new one.
export function collect(input, last = {}) {
  const mrs = new Map(input.mrs.map((mr) => [keyOf(mr), mr]));
  const pending = input.queue.filter((c) => c.status === 'pending' && mrs.has(keyOf(c)) && (!input.waiting || input.waiting.has(c.id)));
  const byKey = groupBy(pending, keyOf);
  const items = [];
  for (const [key, mr] of mrs) {
    const me = meOf(input, mr);
    const ctx = { ...input, me, key, mr, pending: byKey.get(key) ?? [], threads: input.threads.get(key)?.threads ?? [], summary: input.threads.get(key) ?? null, last: last[key] ?? {} };
    const rules = mr.author === me ? OWN_RULES : OTHER_RULES;
    for (const rule of rules) items.push(...[rule(ctx)].flat().filter(Boolean).map((i) => ({ key, group: mr.author === me ? 'mine' : 'others', ...i })));
  }
  items.push(...departedItems(input), ...agentItems(input), ...panelItems(input), ...terminalItems(input), ...emailItems(input), ...slackItems(input), ...systemItems(input));
  return { items, cards: cardsOf(items, mrs), facts: factsOf(input, last) };
}

// A GitHub login is never taken for you on GitLab, nor the other way round.
const meOf = (input, mr) => (mr.provider === 'github' ? input.accounts?.github : input.accounts?.gitlab ?? input.me);

function groupBy(list, by) {
  const map = new Map();
  for (const x of list) map.set(by(x), [...(map.get(by(x)) ?? []), x]);
  return map;
}

// What a flip is compared against on the next build: kept in the ledger, so it survives a restart.
function factsOf(input, last) {
  return Object.fromEntries(input.mrs.map((mr) => [keyOf(mr), {
    reviewState: mr.reviewStates?.[meOf(input, mr)] ?? null, autoMerge: Boolean(mr.autoMerge), sha: mr.sha, title: mr.title, pipeline: mr.pipeline ?? null, reds: redCount(mr, last[keyOf(mr)] ?? {}),
  }]));
}

// Each time the pipeline turns red counts, so a retry that fails again on the same head and pipeline is news.
function redCount(mr, last) {
  const reds = last.reds ?? 0;
  if (mr.pipeline !== 'FAILED') return reds;
  return last.pipeline === 'FAILED' ? Math.max(reds, 1) : reds + 1;
}

const reviewerOf = (ctx) => ctx.mr.reviewers.includes(ctx.me);
const approvedByMe = (ctx) => ctx.mr.approvedBy.includes(ctx.me);
const levelOf = (ctx) => ctx.engine.levelForMr(ctx.mr, ctx.me, ctx.rules);
const watchOf = (ctx) => ctx.state.watches?.[ctx.key];
const runOf = (ctx, key = ctx.key) => ctx.runs[key];
const passOf = (ctx) => ctx.memory[ctx.key]?.pass ?? null;
const reviewRunning = (ctx) => ['launching', 'working'].includes(runOf(ctx)?.status) || (passOf(ctx) && !passOf(ctx).settled && !passOf(ctx).doneAt);
const pipelineGoing = (ctx) => PIPELINE_GOING.has(ctx.mr.pipeline ?? '');

function asked(ctx) {
  if (!reviewerOf(ctx) || approvedByMe(ctx) || ctx.mr.draft || levelOf(ctx) || watchOf(ctx)?.reviewedAt || ctx.pending.length) return null;
  return item({ kind: 'asked', id: `${ctx.key}:asked:${ctx.mr.sha}`, since: ctx.mr.updatedAt, why: 'asks for your review', tab: 'overview', next: 'review' });
}

function severityWords(items) {
  const big = SEVERITY_ORDER.map((s) => [s, items.filter((c) => c.severity === s && BIG.has(s)).length]).filter(([, n]) => n);
  return big.map(([s, n]) => `${n} ${s}`).join(', ');
}

function replyWords(replies, findings) {
  const said = ['fixed', 'not-fixed', 'disagree'].map((o) => [o, replies.filter((c) => c.outcome === o).length]).filter(([, n]) => n);
  const parts = said.map(([o, n]) => `${n} ${o === 'not-fixed' ? 'not fixed' : o === 'disagree' ? 'disagreed' : 'fixed'}`);
  if (findings.length) parts.push(`${findings.length} new${findings.length === 1 && findings[0].severity ? ' ' + findings[0].severity : ''}`);
  return parts.join(', ');
}

function printsOf(ctx, items) {
  return items.filter((c) => !ctx.engine.isRepeat(c, ctx.queue, [], ctx.me)).map((c) => ctx.engine.findingPrint(c));
}

function findings(ctx) {
  const manual = ctx.pending.filter((c) => !c.auto && kindOf(c) !== 'verdict');
  if (!manual.length) return null;
  const replies = manual.filter((c) => kindOf(c) === 'reply' && c.outcome);
  const fresh = manual.filter((c) => !replies.includes(c));
  const lastAt = Date.parse(newest(manual, (c) => c.createdAt));
  const settled = runOf(ctx)?.status !== 'working' || ctx.now - lastAt >= FINDINGS_SETTLE_MS;
  const big = severityWords(fresh);
  const why = replies.length ? replyWords(replies, fresh) : `${manual.length} to post${big ? ', ' + big : ''}`;
  const prints = printsOf(ctx, manual);
  return item({ kind: 'findings', id: `${ctx.key}:findings:${hashOf(manual.map((c) => c.id))}`, since: oldest(manual, (c) => c.createdAt), settled, why, tab: 'findings', next: 'post-all', prints, tier: prints.length ? 'interrupt' : 'badge', count: manual.length });
}

function shadowResult(ctx) {
  const pass = passOf(ctx);
  const shadow = ctx.pending.filter((c) => c.auto?.level === 'shadow' && !c.auto.held && c.auto.pass === pass?.id);
  if (!pass || pass.settled !== 'finished' || !shadow.length) return null;
  const verdict = shadow.find((c) => kindOf(c) === 'verdict')?.verdict;
  const comments = shadow.filter((c) => kindOf(c) !== 'verdict');
  const would = verdict === 'approve' ? 'shadow review would approve' : verdict === 'changes' ? 'shadow review would request changes' : 'shadow review done';
  const why = comments.length ? `${would}, ${comments.length} to post` : would;
  const prints = [...printsOf(ctx, comments), ...(verdict ? [`verdict:${verdict}`] : [])];
  return item({ kind: 'shadow', id: `${ctx.key}:shadow:${pass.id}`, since: pass.doneAt ?? pass.launchedAt, why, tab: 'findings', next: 'decide', prints, tier: prints.length ? 'interrupt' : 'badge', count: comments.length });
}

function heldBack(ctx) {
  const held = ctx.pending.filter((c) => c.auto?.held && !HOUSEKEEPING.test(c.auto.held));
  if (!held.length) return null;
  const urgent = held.some((c) => kindOf(c) === 'verdict' || BIG.has(c.severity));
  const verdict = held.find((c) => kindOf(c) === 'verdict');
  const why = verdict ? `full auto would ${verdict.verdict === 'approve' ? 'approve' : 'request changes'}, but ${verdict.auto.held}` : `full auto held ${held.length} back: ${held[0].auto.held}`;
  return item({ kind: 'held', id: `${ctx.key}:held:${hashOf(held.map((c) => c.id))}`, since: oldest(held, (c) => c.createdAt), why, tab: 'findings', next: verdict ? 'decide' : 'post-all', tier: urgent ? 'interrupt' : 'badge', count: held.length });
}

const waitsOnMe = (t, me) => !t.resolved && t.lastAuthor !== me;

function handedBack(ctx) {
  const ids = ctx.memory[ctx.key]?.handedBack ?? [];
  const threads = ctx.threads.filter((t) => ids.includes(t.id) && waitsOnMe(t, ctx.me));
  if (!threads.length) return null;
  return item({ kind: 'handed', id: `${ctx.key}#${threads.map((t) => t.id).sort().join(',')}`, since: oldest(threads, (t) => t.lastAt), why: `full auto handed ${plural(threads.length, 'thread')} back to you`, tab: 'threads', next: 'reply', count: threads.length });
}

// Full auto answers authors at Comments or above itself, so their reply waits until a pass has settled without answering it.
function fullAutoAnswers(ctx, thread) {
  const level = levelOf(ctx);
  if (level !== 'comments' && level !== 'verdict') return false;
  const pass = passOf(ctx);
  const settledAfter = pass?.settled && (pass.doneAt ?? '') > thread.lastAt;
  const replied = ctx.queue.some((c) => kindOf(c) === 'reply' && c.replyTo === thread.id && c.createdAt > thread.lastAt);
  return !settledAfter || replied;
}

function replied(ctx) {
  const handed = ctx.memory[ctx.key]?.handedBack ?? [];
  const threads = ctx.threads.filter((t) => t.mine && t.resolvable && !t.resolved && t.fromPerson && !handed.includes(t.id) && !fullAutoAnswers(ctx, t));
  if (!threads.length) return null;
  const who = [...new Set(threads.map((t) => t.lastAuthor))];
  const shadow = levelOf(ctx) === 'shadow' && ctx.pending.some((c) => kindOf(c) === 'reply' && threads.some((t) => t.id === c.replyTo));
  const why = shadow ? 'draft reply ready' : `${listed(who)} replied on ${plural(threads.length, 'thread')}`;
  const settled = threads.every((t) => ctx.now - Date.parse(t.lastAt) >= ctx.pollMs);
  return item({ kind: 'replied', id: `${ctx.key}:replied:${threads.map((t) => `${t.id}@${t.lastNoteId}`).sort().join(',')}`, since: oldest(threads, (t) => t.lastAt), settled, why, tab: 'threads', next: 'reply', count: threads.length });
}

function todos(ctx) {
  const mine = ctx.todos.filter((t) => t.key === ctx.key && TODO_ACTIONS.has(t.action) && t.author !== ctx.me && !BOT.test(t.author));
  const wanted = mine.filter((t) => t.action !== 'approval_required' || !reviewerOf(ctx));
  return wanted.map((t) => item({
    kind: 'todo', id: `todo:${t.id}`, since: t.createdAt, why: t.action === 'approval_required' ? 'needs your approval' : `${t.author} mentioned you`,
    tab: t.action === 'approval_required' ? 'overview' : 'threads', next: t.action === 'approval_required' ? 'review' : 'reply',
  }));
}

function postedSince(ctx, at) {
  return ctx.queue.filter((c) => keyOf(c) === ctx.key && c.status === 'posted' && kindOf(c) !== 'verdict' && (c.postedAt ?? '') > at);
}

// Ready again when the head moved or your threads were resolved since your verdict or last post, and nothing is waiting on anyone else.
function verdictAgain(ctx) {
  if (!reviewerOf(ctx) || approvedByMe(ctx) || ctx.pending.length || reviewRunning(ctx) || levelOf(ctx) === 'verdict') return null;
  const verdict = ctx.state.verdicts?.[ctx.key];
  const posts = postedSince(ctx, '');
  if (!verdict && !posts.length) return null;
  const myOpen = ctx.threads.filter((t) => t.mine && t.resolvable && !t.resolved);
  if (myOpen.some((t) => t.lastAuthor === ctx.me)) return null;
  if (pipelineGoing(ctx) && ctx.now - Date.parse(ctx.mr.updatedAt) < PIPELINE_WAIT_MS) return null;
  const since = verdict?.at ?? newest(posts, (c) => c.postedAt);
  const moved = verdict?.sha ? verdict.sha !== ctx.mr.sha : Date.parse(ctx.mr.updatedAt) > Date.parse(since);
  const resolved = ctx.threads.filter((t) => t.mine && t.resolvable && t.resolved).length;
  if (!moved && !resolved) return null;
  const parts = ['ready for your verdict', moved ? 'new commits' : null, resolved ? `your ${plural(resolved, 'thread')} resolved` : null].filter(Boolean);
  return item({ kind: 'verdict', id: `${ctx.key}:verdict:${ctx.mr.sha}`, since, why: parts.join(', '), tab: 'findings', next: 'decide', later: laterMark(ctx) });
}

function commentsUp(ctx) {
  if (!reviewerOf(ctx) || approvedByMe(ctx) || ctx.pending.length) return null;
  const at = ctx.state.verdicts?.[ctx.key]?.at ?? '';
  const posts = postedSince(ctx, at).filter((c) => !c.auto?.sentAuto || levelOf(ctx) === 'comments');
  if (!posts.length) return null;
  const auto = posts.every((c) => c.auto?.sentAuto);
  const why = auto ? `full auto sent ${posts.length}, the verdict is yours` : `your ${plural(posts.length, 'comment')} are up`;
  return item({ kind: 'verdict', id: `${ctx.key}:up:${newest(posts, (c) => c.postedAt)}`, since: newest(posts, (c) => c.postedAt), why, tab: 'findings', next: 'decide', tier: 'badge', later: laterMark(ctx) });
}

const laterMark = (ctx) => `${ctx.mr.sha}|${ctx.state.verdicts?.[ctx.key]?.at ?? ''}|${newest(postedSince(ctx, ''), (c) => c.postedAt)}`;

function rerequested(ctx) {
  const now = ctx.mr.reviewStates?.[ctx.me];
  if (now !== 'UNREVIEWED' || !['REVIEWED', 'REQUESTED_CHANGES'].includes(ctx.last.reviewState)) return null;
  return item({ kind: 'rerequest', id: `${ctx.key}:rerequest:${ctx.mr.sha}`, since: ctx.mr.updatedAt, why: 'asks for your review again', tab: 'overview', next: 'decide' });
}

function approvalReset(ctx) {
  const verdict = ctx.state.verdicts?.[ctx.key];
  if (verdict?.verdict !== 'approved' || !verdict.sha || verdict.sha === ctx.mr.sha || approvedByMe(ctx)) return null;
  return item({ kind: 'reset', id: `${ctx.key}:reset:${ctx.mr.sha}`, since: ctx.mr.updatedAt, why: 'your approval was reset by a push', tab: 'overview', next: 'decide' });
}

function moved(ctx) {
  const watch = watchOf(ctx);
  if (!watch || watch.auto || !ctx.engine.changeSince) return null;
  const change = ctx.engine.changeSince(watch, ctx.mr);
  if (!change.headMoved && !change.resolved) return null;
  const parts = [change.headMoved ? 'new commits' : null, change.resolved ? `${change.resolved} resolved` : null].filter(Boolean);
  return item({ kind: 'moved', id: `${ctx.key}:moved:${ctx.mr.sha}:${ctx.mr.unresolvedThreads}`, since: ctx.mr.updatedAt, why: `moved since your review: ${parts.join(', ')}`, tab: 'overview', next: 'review' });
}

function relaunchFailed(ctx) {
  const failed = watchOf(ctx)?.relaunch;
  if (!failed || failed.sha !== ctx.mr.sha) return null;
  return item({ kind: 'relaunch', id: `${ctx.key}:relaunch:${ctx.mr.sha}`, since: ctx.mr.updatedAt, why: `the re-review could not start: ${failed.error}`, tab: 'agent', next: 'review', tier: failed.tries >= 3 ? 'interrupt' : 'badge' });
}

function reviewDied(ctx) {
  const run = runOf(ctx);
  const pass = passOf(ctx);
  if (run && ['stalled', 'launch failed'].includes(run.status)) return item({ kind: 'died', id: `${ctx.key}:died:${run.startedAt}`, since: run.endedAt ?? run.startedAt, why: run.status === 'stalled' ? 'the review ended with nothing queued' : 'the review could not start', tab: 'agent', next: 'review', tier: 'badge' });
  if (pass && ['failed', 'expired'].includes(pass.settled)) return item({ kind: 'died', id: `${ctx.key}:died:${pass.id}`, since: pass.launchedAt, why: `the full auto pass ${pass.settled}`, tab: 'agent', next: 'review', tier: 'badge' });
  return null;
}

function holding(ctx) {
  if (!ctx.state.reviewHolds?.[ctx.key] || !ctx.engine.heldByMe(ctx.mr, ctx.me) || ctx.pending.length) return null;
  const run = runOf(ctx);
  if (reviewRunning(ctx) || (run && ctx.now - Date.parse(run.endedAt ?? run.startedAt) < HOLDING_QUIET_MS)) return null;
  return item({ kind: 'holding', id: `${ctx.key}:holding:${ctx.mr.sha}`, since: ctx.state.reviewHolds[ctx.key].at, why: `you are holding ${named(ctx.key)}, nothing is queued`, tab: 'overview', next: 'release', tier: 'badge' });
}

function codeMoved(ctx) {
  if (!ctx.summary?.moved) return null;
  return item({ kind: 'code-moved', id: `${ctx.key}:code-moved:${ctx.mr.sha}`, since: ctx.mr.updatedAt, why: `code moved under ${plural(ctx.summary.moved, 'comment')} of yours`, tab: 'threads', next: 'open', tier: 'badge' });
}

function agentsOnMr(ctx) {
  const handles = [watchOf(ctx)?.terminal, runOf(ctx)?.terminal].filter(Boolean);
  return ctx.agents.filter((a) => a.handle && handles.includes(a.handle) && WAITING.has(a.state)).map((a) => item({
    kind: 'agent', id: `agent:${a.handle}:${a.since}`, since: a.since, why: `its review agent ${asks(a)}`, tab: 'agent', next: 'answer', handle: a.handle,
  }));
}

const asks = (a) => (a.state === 'blocked' && a.ask?.tool ? `asks to use ${a.ask.tool}` : 'asks you');

const OTHER_RULES = [asked, findings, shadowResult, heldBack, handedBack, replied, todos, verdictAgain, commentsUp, rerequested, approvalReset, moved, relaunchFailed, reviewDied, holding, codeMoved, agentsOnMr];

const fixRunOf = (ctx) => runOf(ctx, `fix:${ctx.key}`);
const fixAlive = (ctx) => {
  const run = fixRunOf(ctx);
  return Boolean(run?.terminal && run.status !== 'launch failed' && ctx.agents.some((a) => a.handle === run.terminal));
};

// Plain comments count once they are newer than anything you have said on the MR.
function newComments(ctx) {
  if (fixAlive(ctx)) return null;
  const mineAt = newest(ctx.threads.filter((t) => t.lastAuthor === ctx.me), (t) => t.lastAt);
  const threads = ctx.threads.filter((t) => t.fromPerson && (t.resolvable ? !t.resolved : t.lastAt > mineAt));
  const changes = ctx.engine.changesRequestedBy(ctx.mr).filter((name) => name !== ctx.me);
  if (!threads.length && !changes.length) return null;
  if (!threads.length) {
    return item({ kind: 'changes', id: `${ctx.key}:changes:${changes.join(',')}:${ctx.mr.sha}`, since: ctx.mr.updatedAt, why: `${listed(changes)} requested changes`, tab: 'threads', next: 'fix-threads', settleAfterMs: CHANGES_WAIT_MS });
  }
  const who = [...new Set(threads.map((t) => t.lastAuthor))];
  const why = `${listed(who)} left ${plural(threads.length, 'comment')}${changes.length ? ' and requested changes' : ''}`;
  const settled = threads.every((t) => ctx.now - Date.parse(t.lastAt) >= ctx.pollMs);
  return item({ kind: 'comments', id: `${ctx.key}:comments:${threads.map((t) => `${t.id}@${t.lastNoteId}`).sort().join(',')}`, since: oldest(threads, (t) => t.lastAt), settled, why, tab: 'threads', next: 'fix-threads', count: threads.length });
}

function pipelineFailed(ctx) {
  if (ctx.mr.pipeline !== 'FAILED') return null;
  return item({ kind: 'red', id: `${ctx.key}:red:${ctx.mr.sha}:${ctx.mr.pipelineId ?? ''}:${redCount(ctx.mr, ctx.last)}`, since: ctx.mr.updatedAt, why: 'the pipeline failed', tab: 'pipeline', next: 'fix-pipeline', tier: ctx.mr.draft ? 'badge' : 'interrupt' });
}

const conflicted = (mr) => mr.conflicts || String(mr.mergeStatus ?? '').toLowerCase() === 'conflict';

function branchState(ctx) {
  const mr = ctx.mr;
  const urgent = mr.autoMerge ? 'interrupt' : 'badge';
  if (conflicted(mr)) return item({ kind: 'conflict', id: `${ctx.key}:conflict:${mr.sha}`, since: mr.updatedAt, why: mr.autoMerge ? 'conflicts, so merge when green cannot merge it' : 'has conflicts', tab: 'overview', next: 'fix-conflicts', tier: urgent });
  if (String(mr.mergeStatus ?? '').toLowerCase() === 'need_rebase') return item({ kind: 'rebase', id: `${ctx.key}:rebase:${mr.sha}`, since: mr.updatedAt, why: 'needs a rebase', tab: 'overview', next: 'rebase', tier: urgent });
  return null;
}

function mergeable(ctx) {
  const mr = ctx.mr;
  if (mr.draft || mr.autoMerge || conflicted(mr)) return null;
  const choice = ctx.mergeChoice(mr);
  if (choice.can === 'now' && mr.pipeline === 'SUCCESS' && !ctx.engine.changesRequestedBy(mr).length) {
    return item({ kind: 'mergeable', id: `${ctx.key}:mergeable:${mr.sha}`, since: mr.updatedAt, why: 'ready to merge', tab: 'overview', next: 'merge' });
  }
  if (choice.can === 'green') return item({ kind: 'approvals', id: `${ctx.key}:green:${mr.approvedBy.length}`, since: mr.updatedAt, why: `waiting on ${choice.words}`, tab: 'overview', next: 'merge-green', tier: 'badge' });
  return null;
}

function mergeDropped(ctx) {
  if (!ctx.last.autoMerge || ctx.mr.autoMerge || ctx.mr.autoMerge === undefined || ctx.cancelled?.has(ctx.key)) return null;
  return item({ kind: 'mwg-dropped', id: `${ctx.key}:mwg-dropped:${ctx.mr.sha}`, since: ctx.mr.updatedAt, why: `GitLab dropped merge when green: ${ctx.mergeChoice(ctx.mr).words}`, tab: 'overview', next: 'merge-green' });
}

const PUSH_QUESTION = /push\b[^?]*\?/i;
const QUESTION = /\?\s*$/;

function fixAsks(ctx) {
  const run = fixRunOf(ctx);
  const agent = run?.terminal && ctx.agents.find((a) => a.handle === run.terminal);
  if (!agent) return null;
  const asking = WAITING.has(agent.state) || (agent.state === 'done' && PUSH_QUESTION.test(agent.said ?? ''));
  if (!asking) return null;
  return item({ kind: 'fix-asks', id: `fix:${ctx.key}:${run.startedAt}:${ctx.mr.sha}:${agent.since}`, since: agent.since ?? run.startedAt, why: 'the fix agent asks before it pushes', tab: 'agent', next: 'answer', handle: agent.handle });
}

// Ended means its terminal is gone or done, and the head moving is what says it pushed rather than stopped.
function fixDone(ctx) {
  const run = fixRunOf(ctx);
  if (!run?.terminal || run.status === 'launch failed' || !run.sha || run.sha === ctx.mr.sha || !ctx.agentsRead) return null;
  const agent = ctx.agents.find((a) => a.handle === run.terminal);
  if (agent && (agent.state !== 'done' || PUSH_QUESTION.test(agent.said ?? ''))) return null;
  const answered = ctx.threads.filter((t) => t.lastAuthor === ctx.me && t.lastAt > run.startedAt);
  const resolved = answered.filter((t) => t.resolved).length;
  const replies = answered.length === 1 ? '1 reply' : `${answered.length} replies`;
  const why = ['fix pushed', answered.length ? replies : null, resolved ? `${resolved} resolved` : null].filter(Boolean).join(', ');
  return item({ kind: 'fix-done', id: `fix-done:${ctx.key}:${run.startedAt}`, since: agent?.since ?? run.startedAt, why, tab: 'threads', next: 'open', later: `fix-done:${run.startedAt}` });
}

function rebaseFailed(ctx) {
  const failed = ctx.rebasesFailed?.find((r) => r.key === ctx.key);
  if (!failed) return null;
  return item({ kind: 'rebase-failed', id: `${ctx.key}:rebase-failed:${failed.since}`, since: new Date(failed.since).toISOString(), why: `the rebase failed: ${failed.error}`, tab: 'overview', next: 'fix-conflicts', later: `rebase-failed:${failed.since}` });
}

const OWN_RULES = [newComments, pipelineFailed, branchState, mergeable, mergeDropped, fixAsks, fixDone, rebaseFailed];

// An MR that merged when green has left the open list, so it is told from what the notifier kept of it.
function departedItems(input) {
  return (input.departed ?? []).filter((g) => g.facts?.autoMerge && g.end?.state === 'merged' && input.now - g.at < MERGED_SHOWN_MS && !input.mergedHere?.has(g.key)).map((g) => {
    const other = g.end.mergedBy && g.end.mergedBy !== input.me;
    return item({
      kind: 'merged', key: g.key, group: 'mine', id: `${g.key}:merged`, since: new Date(g.at).toISOString(), why: other ? `${g.end.mergedBy} merged it` : 'merge when green merged it',
      title: g.facts.title ?? g.key, tab: null, next: 'dismiss', tier: other ? 'badge' : 'interrupt', later: 'merged',
    });
  });
}

// Agents on no MR's review or fix run go under Agents waiting, after every MR; one that asks interrupts, as a fix agent's ask does.
function agentItems(input) {
  const onMr = new Set(input.mrs.flatMap((mr) => [input.state.watches?.[keyOf(mr)]?.terminal, input.runs[keyOf(mr)]?.terminal, input.runs[`fix:${keyOf(mr)}`]?.terminal]).filter(Boolean));
  const kickoffs = kickoffTerminals(input.runs);
  return input.agents.filter((a) => !(a.handle && onMr.has(a.handle))).map((a) => {
    const ticket = a.handle && kickoffs.get(a.handle);
    if (ticket) return kickoffAsks(a, ticket);
    if (!WAITING.has(a.state)) return null;
    return item({
      kind: 'agent', key: null, group: 'agents', id: `agent:${a.handle}:${a.since}`, since: a.since, why: `${a.name} ${asks(a)}`, title: a.title || a.name, tab: null, next: 'answer', handle: a.handle,
    });
  }).filter(Boolean);
}

// The panel shows what its chat asks, so it asks here only while no page has the panel open.
function panelItems(input) {
  const a = input.panel?.agent;
  if (!a || input.panel.open || !WAITING.has(a.state)) return [];
  return [item({ kind: 'claude', key: null, group: 'agents', id: `panel:${a.handle}:${a.since}`, since: a.since, why: claudeAsks(a.ask), title: 'Claude', tab: 'claude', next: 'answer', handle: a.handle })];
}

function terminalItems(input) {
  const ask = input.panel?.terminal;
  if (!ask) return [];
  const banner = { title: 'Claude needs you', body: ask.message };
  return [item({ kind: 'claude-code', key: null, group: 'agents', id: `claude-code:${ask.at}`, since: new Date(ask.at).toISOString(), why: ask.message, title: banner.title, tab: 'claude-code', next: 'open', banner })];
}

function claudeAsks(ask) {
  if (!ask || ask.questions) return 'asks you a question';
  const title = toolTitles()[ask.tool];
  return title ? `asks to ${title.charAt(0).toLowerCase()}${title.slice(1)}` : `asks to use ${ask.tool}`;
}

// A banner names the subject and a fixed reason, never the sender or what the message says.
function emailItems(input) {
  return (input.email ?? []).map((t) => item({
    kind: 'email', key: null, group: 'email', id: `email:${t.id}:${t.receivedAt}`, since: t.receivedAt, why: EMAIL_WORDS[t.kind], title: t.subject || '(no subject)',
    tab: 'email', next: 'open', thread: t.id, from: t.from.name || t.from.address, reason: t.reason, link: t.link, receivedAt: t.receivedAt, tier: t.quiet ? 'badge' : 'interrupt',
  }));
}

// A banner names the channel, the sender and a fixed reason, never what the message says.
function slackItems(input) {
  return (input.slack ?? []).map((m) => item({
    kind: 'slack', key: null, group: 'slack', id: `slack:${m.key}:${m.ts}`, since: m.at, why: SLACK_WORDS[m.kind], title: `${placeOf(m)} · ${m.from.name}`,
    tab: 'slack', next: 'open', conversation: m.key, from: m.from.name, reason: m.reason, link: m.link, ts: m.ts, tier: m.quiet ? 'badge' : 'interrupt',
  }));
}

function kickoffTerminals(runs) {
  return new Map(Object.values(runs).filter((r) => r.kickoff && r.key?.startsWith('ticket:') && r.terminal && r.status !== 'launch failed').map((r) => [r.terminal, r.key.slice('ticket:'.length)]));
}

// Like a fix agent, a kickoff agent asks you when it waits, or when it ended its turn on a question.
function kickoffAsks(a, ticket) {
  if (!WAITING.has(a.state) && !(a.state === 'done' && QUESTION.test(a.said ?? ''))) return null;
  return item({
    kind: 'kickoff-asks', key: null, group: 'agents', id: `kickoff:${ticket}:${a.handle}:${a.since}`, since: a.since, why: 'its kickoff agent asks you', title: ticket, ticket, tab: null, next: 'answer', handle: a.handle,
  });
}

function systemItems(input) {
  const out = [];
  const driver = input.driver;
  const anyoneAuto = input.rules.people.length > 0 || Boolean(input.rules.onRequest);
  if (anyoneAuto && driver && ['stopped', 'terminal'].includes(driver.state) && input.driverTurns >= 2) {
    out.push(item({ kind: 'driver', key: null, group: 'system', id: `driver:${driver.state}:${driver.why}`, since: null, why: `stopped, ${driver.why}`, title: 'Full auto', tab: 'full-auto', next: 'open' }));
  }
  out.push(...forgeSilent(input, 'gitlab', 'GitLab', input.fetchError ?? input.forgeErrors?.gitlab), ...forgeSilent(input, 'github', 'GitHub', input.forgeErrors?.github));
  return out;
}

// Each forge gets its own card, so GitHub failing for an hour says so while GitLab keeps answering, and the other way round.
function forgeSilent(input, kind, name, error) {
  const at = input.answeredAt?.[kind] ?? input.fetchedAt;
  const since = Date.parse(at);
  if (!error || input.now - since < SILENT_POLLS * input.pollMs) return [];
  return [item({ kind, key: null, group: 'system', id: `${kind}:${at}`, since: at, why: `${name} has not answered since ${timeText(since, true)}: ${error}`, title: name, tab: null, next: `retry-${kind}` })];
}

const rankItem = (i) => (i.tier === 'interrupt' ? 0 : 1);

function cardsOf(items, mrs) {
  const byKey = groupBy(items.filter((i) => i.key), (i) => i.key);
  const cards = [...byKey].map(([key, reasons]) => {
    const sorted = [...reasons].sort((a, b) => rankItem(a) - rankItem(b) || String(a.since ?? '').localeCompare(String(b.since ?? '')));
    const mr = mrs.get(key);
    return { key, group: sorted[0].group, title: mr?.title ?? sorted[0].title ?? key, iid: mr?.iid ?? null, repo: mr?.repoLabel ?? named(key), sha: mr?.sha ?? null, reasons: sorted, top: sorted[0], since: oldest(sorted, (i) => i.since ?? ''), interrupt: sorted.some((i) => i.tier === 'interrupt') };
  });
  return cards.sort((a, b) => GROUPS.indexOf(a.group) - GROUPS.indexOf(b.group) || Number(b.interrupt) - Number(a.interrupt) || String(a.since).localeCompare(String(b.since)));
}

export const GROUP_ORDER = GROUPS;
