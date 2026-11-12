import { listAgents } from './claudeagents.mjs';
import { failure, forgeFor, inbox, meFor, MR_KEY, mrFor, requireEngine } from './engine.mjs';
import { readMatrix } from './matrix.mjs';
import { TOOLS } from './mcptools.mjs';
import { proposeReply } from './messageagent.mjs';
import { readMrDetail } from './mrdetail.mjs';
import { keyOf, keyPath } from './refs.mjs';
import * as notifier from './notifier.mjs';
import { fixThreadCounts, mergeChoice } from './ownmr.mjs';
import * as qa from './qa.mjs';
import * as standup from './standup.mjs';
import { readTickets, settled as ticketsSettled } from './tickets.mjs';

const MAX_OUT = 60_000;
const NOTE_CHARS = 1500;
const BODY_CHARS = 2000;
const SAID_CHARS = 600;
const DESCRIPTION_CHARS = 4000;
const AGENT_ENTRIES = 40;
const MRS_SHOWN = 50;
const SCOPES = { all: () => true, asking: (r) => r.flags.waitingOnYou, mine: (r) => r.flags.mine, watched: (r) => Boolean(r.watch) };

const clip = (text, n) => {
  const s = String(text ?? '');
  return s.length > n ? `${s.slice(0, n)}…` : s;
};

function mrKey(mr) {
  if (typeof mr !== 'string' || !MR_KEY.test(mr)) throw failure(400, 'mr looks like group/repo!123 or owner/repo#123, as list_mrs gives it');
  return mr;
}

function text(value, name) {
  if (typeof value !== 'string' || !value) throw failure(400, `${name} is missing`);
  return value;
}

async function matrix() {
  const m = await readMatrix();
  if (!m.available) throw failure(503, m.error);
  return m;
}

function needsMe() {
  const v = notifier.view();
  return {
    count: v.count,
    mrs: v.cards.map((c) => ({ mr: c.key, title: c.title, group: c.group, why: c.reasons.map((r) => r.why), interrupts: c.interrupt, since: c.since, muted: Boolean(c.muted) })),
    agents: v.agents.filter((i) => i.kind !== 'claude' && i.kind !== 'claude-code').map((i) => ({ handle: i.handle ?? null, title: i.title, why: i.why, since: i.since })),
    problems: v.system.map((i) => ({ title: i.title, why: i.why })),
  };
}

const lower = (s) => String(s ?? '').toLowerCase();

// A repo names itself or the group it sits in, on either forge.
const inRepo = (path, repo) => path === repo || path?.startsWith(`${repo}/`);

function rowMatches(r, { repo, author, search }) {
  if (repo && lower(r.repo) !== lower(repo) && !inRepo(keyPath(r.key), repo)) return false;
  if (author && lower(r.author) !== lower(author)) return false;
  return !search || [r.title, r.key, r.ticket].some((v) => lower(v).includes(lower(search)));
}

function shapeRow(r) {
  return {
    mr: r.key, title: r.title, repo: r.repo, author: r.author, draft: r.draft, pipeline: r.pipeline, mergeStatus: r.mergeStatus, sha: r.sha, ticket: r.ticket,
    unresolved: r.unresolved, reviewers: r.reviewers, approvedBy: r.approvedBy, mood: r.mood, verdict: r.verdict, agent: r.agent,
    asking: Boolean(r.flags.waitingOnYou), mine: Boolean(r.flags.mine), watched: Boolean(r.watch), updatedAt: r.updatedAt,
  };
}

async function listMrs({ scope = 'all', limit = MRS_SHOWN, ...filters }) {
  if (!Object.hasOwn(SCOPES, scope)) throw failure(400, 'scope is all, asking, mine or watched');
  const m = await matrix();
  const rows = m.inbox.rows.filter(SCOPES[scope]).filter((r) => rowMatches(r, filters));
  const shown = Math.max(1, Math.min(200, Number(limit) || MRS_SHOWN));
  return { fetchedAt: m.inbox.fetchedAt, error: m.inbox.error, total: rows.length, mrs: rows.slice(0, shown).map(shapeRow) };
}

function shapeThread(t) {
  const notes = t.notes.filter((n) => !n.system);
  return { id: t.id, resolved: t.resolved, path: t.path, line: t.line, awaitsYou: t.awaitsYou, bot: t.bot, notes: notes.map((n) => ({ author: n.author, at: n.createdAt, body: clip(n.body, NOTE_CHARS) })) };
}

function shapeItem(q) {
  return { id: q.id, mr: q.key, kind: q.kind, severity: q.severity, path: q.path, line: q.line, body: clip(q.body, BODY_CHARS), createdBy: q.createdBy, createdAt: q.createdAt, stale: q.stale, sending: Boolean(q.sending), auto: Boolean(q.auto) };
}

const pendingItems = (m, key) => m.queue.filter((q) => q.status === 'pending' && (!key || q.key === key));

function canMerge(key) {
  const listed = inbox?.mrs.find((mr) => keyOf(mr) === key);
  return listed && meFor(listed) && listed.author === meFor(listed) ? mergeChoice(listed).can : null;
}

async function getMr({ mr }) {
  const key = mrKey(mr);
  const [d, m] = await Promise.all([readMrDetail(key), matrix()]);
  return {
    ...d.mr, mr: key, merge: d.merge, canMerge: canMerge(key), target: d.detail?.targetBranch ?? null, description: clip(d.detail?.description, DESCRIPTION_CHARS),
    jobs: d.jobs.filter((j) => !['success', 'skipped', 'manual'].includes(lower(j.status))), files: d.files?.list.map((f) => `${f.change} ${f.path} +${f.added} -${f.removed}`) ?? null,
    threads: d.discussions.filter((t) => t.notes.some((n) => !n.system)).map(shapeThread), queued: pendingItems(m, key).map(shapeItem), since: d.since,
  };
}

async function reviewQueue({ mr }) {
  const key = mr === undefined ? null : mrKey(mr);
  return { items: pendingItems(await matrix(), key).map(shapeItem) };
}

function agents() {
  const list = listAgents();
  if (!list) throw failure(501, 'The review engine needs rebuilding: this build has no claudeAgents');
  return list;
}

function shapeAgent(a) {
  return { handle: a.handle, name: a.name, title: a.title, kind: a.kind, mr: a.mr, ticket: a.ticket, state: a.state, since: a.since, alive: a.alive, said: clip(a.said, SAID_CHARS), ask: a.ask };
}

// Only the agents list_agents shows, so the panel's own chat is never read or answered as one of them.
function otherAgent(handle) {
  const agent = agents().find((a) => a.handle === handle);
  if (!agent) throw failure(404, `${handle} is not one of the agents list_agents gives`);
  return agent;
}

function getAgent({ handle }) {
  otherAgent(handle);
  const chat = requireEngine('agentConversation').agentConversation(handle);
  return { ...shapeAgent(chat), entries: chat.entries.slice(-AGENT_ENTRIES).map((e) => ('text' in e ? { ...e, text: clip(e.text, NOTE_CHARS) } : e)) };
}

async function tickets() {
  readTickets();
  await ticketsSettled();
  return readTickets();
}

async function listTickets() {
  const t = await tickets();
  return { error: t.error, tickets: t.tickets.map((x) => ({ key: x.key, summary: x.summary, status: x.status, epic: x.epic?.key ?? null, mrs: x.mrs.map((r) => r.key), moves: x.targets, suggest: x.suggest })) };
}

const READS = {
  needs_me: needsMe,
  list_mrs: listMrs,
  get_mr: getMr,
  review_queue: reviewQueue,
  list_agents: ({ state }) => ({ agents: agents().filter((a) => !state || a.state === state).map(shapeAgent) }),
  get_agent: getAgent,
  list_tickets: listTickets,
  standup: ({ day }) => standup.read(day),
  qa_board: () => qa.ROUTES['GET /api/qa'](),
};

const DRAFTS = { propose_reply: proposeReply };

async function targetOf(key) {
  const mr = mrFor(key);
  return (await forgeFor(mr, 'branchFacts').branchFacts(mr)).targetBranch;
}

function replyOf(agent, { text: words, answer, allow }) {
  if (words !== undefined) return { text: words };
  if (answer !== undefined) {
    const [only, ...more] = agent.ask?.questions ?? [];
    if (!only || more.length) throw failure(400, 'answer takes one option of a single question; say anything else as text');
    return { answer: { question: only.question, label: answer } };
  }
  if (typeof allow === 'boolean') return { allow };
  throw failure(400, 'give text, answer or allow');
}

// Each builds what the page would send; a sha or a status here is what the session read, and the action checks it is still so.
const PAYLOADS = {
  start_review: ({ mr }) => ({ key: mrKey(mr) }),
  start_fix: async ({ mr, sha, thread, conflicts }) => {
    const key = mrKey(mr);
    const threads = conflicts ? {} : await fixThreadCounts(key, thread);
    return { key, ...(thread === undefined ? {} : { discussionId: thread }), ...(conflicts ? { conflicts: true } : {}), expect: { sha: text(sha, 'sha'), threads } };
  },
  start_kickoff: async ({ ticket }) => {
    await tickets();
    return { key: ticket };
  },
  reply_to_agent: ({ handle, pending, ...reply }) => {
    const agent = otherAgent(handle);
    return { handle, ...replyOf(agent, reply), expect: { state: agent.state, since: agent.since, pending: pending ?? null } };
  },
  queue_finding: ({ mr, severity, body }) => ({ key: mrKey(mr), severity, body }),
  post_finding: ({ id }) => ({ id: text(id, 'id') }),
  post_all_findings: ({ mr }) => ({ key: mrKey(mr) }),
  discard_finding: ({ id }) => ({ id: text(id, 'id') }),
  merge_mr: async ({ mr, sha, when }) => {
    const key = mrKey(mr);
    return { key, expect: { sha: text(sha, 'sha'), can: when, target: await targetOf(key) } };
  },
  move_ticket: async ({ ticket, from, to }) => {
    await tickets();
    return { key: ticket, status: to, expect: { status: from } };
  },
};

function said(value) {
  const out = typeof value === 'string' ? value : JSON.stringify(value);
  return out.length > MAX_OUT ? `${out.slice(0, MAX_OUT)}… (cut at ${MAX_OUT} characters; narrow what you asked for)` : out;
}

export async function callTool({ tool, args } = {}, { act }) {
  const def = TOOLS.find((t) => t.name === tool);
  if (!def) throw failure(404, `there is no tool called ${tool}`);
  requireEngine();
  const given = args && typeof args === 'object' && !Array.isArray(args) ? args : {};
  if (!def.action) return { ok: true, text: said(await (READS[tool] ?? DRAFTS[tool])(given)) };
  const done = await act(def.action, await PAYLOADS[tool](given));
  return { ok: true, text: said(done.text ?? 'Done') };
}

export const HANDLED = { reads: Object.keys(READS), drafts: Object.keys(DRAFTS), writes: Object.keys(PAYLOADS) };
