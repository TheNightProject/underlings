import { failure, inbox, jiraSettings, requireEngine, still, ticketSettings } from './engine.mjs';
import { isOn } from './features.mjs';
import { keyOf } from './refs.mjs';
import { eachAtMost, forget, mergedError, mergedFor, readMerged, suggestMove } from './suggest.mjs';
import { exampleKey, inProjects, projectList, TICKET_KEY } from './ticketkeys.mjs';

const FRESH_MS = 2 * 60_000;
const RETRY_MS = 20_000;
const VIEWS_AT_ONCE = 4;
const MAX_STATUS = 100;
const FINISHED = ['Done'];

let cache = freshCache();
const moving = new Set();

function freshCache() {
  return { tickets: null, parents: new Map(), transitions: new Map(), at: 0, error: null, reading: null };
}

export const ROUTES = {
  'GET /api/matrix/tickets': () => readTickets(),
  'POST /api/matrix/tickets/refresh': () => read(true),
  'GET /api/matrix/ticket': ({ query }) => readTicket(query.get('key')),
};

export const ACTIONS = {
  'ticket-status': { verify: verifyMoveAlone, run: moveAlone },
  'ticket-start': { verify: verifyStart, run: start },
};

export function stop() {
  cache = freshCache();
  moving.clear();
  forget();
}

export function readTickets(now = Date.now()) {
  return read(due(now));
}

// acli takes seconds a call, so the page gets what is cached at once and the read runs behind it.
async function read(wanted) {
  const engine = requireEngine('fetchMyTickets', 'viewTicket', 'moveTargets');
  if (!(await isOn('tickets'))) return { ...listed(engine), feature: false, read: true, tickets: [] };
  if (jiraOff(engine)) return { ...listed(engine), off: true, read: true, tickets: [] };
  if (wanted && !cache.reading) cache.reading = refresh(engine).finally(() => { cache.reading = null; });
  return listed(engine);
}

const jiraOff = (engine) => !String(engine.loadSettings?.().jiraSite ?? '').trim();

function due(now) {
  const wait = cache.error && !cache.tickets ? RETRY_MS : FRESH_MS;
  return now - cache.at > wait;
}

export function settled() {
  return cache.reading ?? Promise.resolve();
}

async function refresh(engine) {
  try {
    const projects = projectList(jiraSettings().projects);
    cache.tickets = (await engine.fetchMyTickets()).filter((t) => inProjects(t.key, projects));
    cache.error = null;
  } catch (err) {
    cache.error = err.message;
  }
  cache.at = Date.now();
  if (!cache.tickets) return;
  await learnParents(engine, cache.tickets.filter((t) => !cache.parents.has(t.key)).map((t) => t.key));
  await readMerged(cache.tickets.map((t) => ({ key: t.key, open: mrsFor(t.key) })), groups());
}

// acli's search will not return a parent, so each ticket is viewed once and its epic kept.
function learnParents(engine, keys) {
  return eachAtMost(keys, VIEWS_AT_ONCE, async (key) => {
    const view = await engine.viewTicket(key, { priority: 'background' }).catch(() => null);
    if (view) remember(view);
  });
}

function groups() {
  return [...new Set((inbox?.mrs ?? []).filter((mr) => !mr.provider).map((mr) => mr.projectPath.split('/')[0]))];
}

function remember(view) {
  cache.parents.set(view.key, view.parent ? { key: view.parent.key, summary: view.parent.summary } : null);
  cache.transitions.set(view.key, { status: view.status, to: Array.isArray(view.transitions) ? view.transitions : null });
  const listedTicket = cache.tickets?.find((t) => t.key === view.key);
  if (listedTicket) Object.assign(listedTicket, { status: view.status, summary: view.summary });
}

function listed(engine) {
  const offer = offerFor(engine);
  return {
    read: cache.tickets !== null,
    loading: Boolean(cache.reading),
    error: cache.error,
    mergedError: mergedError(),
    fetchedAt: cache.at ? new Date(cache.at).toISOString() : null,
    tickets: (cache.tickets ?? []).map((t) => listedTicket(engine, t, offer)),
  };
}

function listedTicket(engine, t, offer) {
  const mrs = mrsFor(t.key);
  const known = cache.transitions.get(t.key);
  return {
    key: t.key, summary: t.summary, status: t.status,
    epicRead: cache.parents.has(t.key), epic: cache.parents.get(t.key) ?? null,
    mrs, run: runFor(engine, t.key), ...movesFor(engine, { key: t.key, status: t.status, mrs, transitions: known?.status === t.status ? known.to : null }, offer),
  };
}

// A status seen on another of your tickets is one your workflow has, so it is offered while Jira cannot say the transitions.
function seenStatuses(engine) {
  return engine.statusChoices?.(cache.tickets ?? [], '') ?? [...new Set((cache.tickets ?? []).map((t) => t.status))];
}

const listOf = (text) => String(text ?? '').split(',').map((item) => item.trim()).filter(Boolean);

// Read once a list, as each read of the settings parses the engine's whole state file.
function offerFor(engine) {
  return { seen: seenStatuses(engine), named: listOf(jiraSettings().statuses), noQaPaths: ticketSettings().noQaPaths };
}

function movesFor(engine, { key, status, mrs, transitions }, offer = offerFor(engine)) {
  const targets = engine.moveTargets(status, offer.seen, transitions ?? null, offer.named);
  return { targets, suggest: suggestMove({ status, targets, open: mrs, merged: mergedFor(key), noQaPaths: offer.noQaPaths }) };
}

function mrsFor(key) {
  return (inbox?.mrs ?? []).filter((mr) => mr.ticket === key).map((mr) => ({
    key: keyOf(mr), iid: mr.iid, repo: mr.repoLabel, title: mr.title, draft: mr.draft, author: mr.author,
  }));
}

function runFor(engine, key) {
  const run = engine.loadRuns?.()[`ticket:${key}`];
  return run ? { status: run.status ?? 'launching', terminal: run.terminal ?? null, startedAt: run.startedAt, tail: (run.tail ?? []).slice(-30) } : null;
}

const isMine = (key) => Boolean(cache.tickets?.some((t) => t.key === key));

function checkKey(key, mineOnly = true) {
  const jira = jiraSettings();
  const fits = mineOnly ? inProjects(key, projectList(jira.projects)) : typeof key === 'string' && TICKET_KEY.test(key);
  if (!fits) throw failure(400, `key must be a Jira ticket such as ${exampleKey(jira.defaultProject || projectList(jira.projects)[0])}`);
}

async function view(engine, key) {
  try {
    return await engine.viewTicket(key);
  } catch (err) {
    throw failure(502, `Jira cannot be read right now: ${err.message}`);
  }
}

export async function readTicket(key) {
  const engine = requireEngine('viewTicket', 'moveTargets');
  checkKey(key, false);
  const live = await view(engine, key);
  remember(live);
  const mine = isMine(key);
  const mrs = mrsFor(key);
  return {
    key, summary: live.summary, status: live.status, type: live.type, epic: live.parent, description: live.description ?? '', url: live.url,
    mine, mrs, run: runFor(engine, key), ...(mine ? movesFor(engine, { key, status: live.status, mrs, transitions: live.transitions }) : { targets: [], suggest: null }),
  };
}

// Only your own open tickets are moved or started from here, so a key the list has not shown is refused.
function ownTicket(key) {
  checkKey(key);
  if (!cache.tickets) throw failure(503, 'your tickets have not been read from Jira yet');
  if (!isMine(key)) throw failure(404, `${key} is not one of your open tickets`);
}

async function verifyMove({ key, status, expect }) {
  const engine = requireEngine('viewTicket', 'transitionTicket', 'moveTargets');
  ownTicket(key);
  if (typeof status !== 'string' || !status || status.length > MAX_STATUS) throw failure(400, 'which status?');
  const live = await view(engine, key);
  still(expect?.status, live.status, `the status of ${key}`);
  const { seen, named } = offerFor(engine);
  if (!engine.moveTargets(live.status, seen, live.transitions ?? null, named).includes(status)) throw failure(400, `Jira offers no move from ${live.status} to ${status}`);
  return live;
}

// verifyMove waits on Jira, so a second move sent meanwhile would pass the same status check.
async function verifyMoveAlone(payload) {
  if (moving.has(payload.key)) throw failure(409, `${payload.key} is already being moved`);
  moving.add(payload.key);
  try {
    return await verifyMove(payload);
  } catch (err) {
    moving.delete(payload.key);
    throw err;
  }
}

function moveAlone(payload) {
  return move(payload).finally(() => moving.delete(payload.key));
}

async function move({ key, status }) {
  try {
    await requireEngine('transitionTicket').transitionTicket(key, status);
  } catch (err) {
    throw failure(502, err.message);
  }
  const listedTicket = cache.tickets?.find((t) => t.key === key);
  if (finished().includes(status)) cache.tickets = cache.tickets?.filter((t) => t !== listedTicket) ?? null;
  else if (listedTicket) listedTicket.status = status;
  return `Moved ${key} to ${status}`;
}

function finished() {
  const named = listOf(jiraSettings().doneStatuses);
  return named.length ? named : FINISHED;
}

async function verifyStart({ key }) {
  const engine = requireEngine('launchKickoff', 'kickoffRunAlive');
  ownTicket(key);
  if (await engine.kickoffRunAlive(key)) throw failure(409, `an agent is still open on ${key}, so answer it in its Agent tab, or remove it under Agents`);
  return cache.tickets.find((t) => t.key === key);
}

async function start({ key }, ticket) {
  const { name } = await requireEngine('launchKickoff').launchKickoff(key, ticket.url ?? '');
  return `An agent is starting ${key} in ${name}. It asks you before it pushes, raises an MR or touches Jira.`;
}
