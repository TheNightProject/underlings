import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { BAD_KEY, engine, failure, forgeFor, jiraSettings, meFor, MR_KEY, mrFor, requireEngine, still } from './engine.mjs';
import { numberText } from './locale.mjs';
import { anchorOf, invalidate } from './mrdetail.mjs';
import { draftTicket, findTools } from './ticketdraft.mjs';
import { exampleKey, keysInText, projectOf, TICKET_KEY as JIRA_KEY } from './ticketkeys.mjs';
import { APP_NAME } from './product.mjs';
import { keyParts } from './refs.mjs';
import { stateDir } from './home.mjs';
const MAX_SUMMARY = 255;
const MAX_DESCRIPTION = 20_000;
const STYLE_EXAMPLES = 8;
const WRITES = ['reply', 'resolve'];
const drafting = new Map();
const writing = new Set();
let saving = Promise.resolve();

export const ACTIONS = {
  'thread-ticket': oneAtATime({ verify: verifyCreate, run: createAndClose }),
  'thread-ticket-link': oneAtATime({ verify: verifyLink, run: linkAndClose }),
  'thread-ticket-finish': oneAtATime({ verify: verifyFinish, run: finish }),
};

export const ROUTES = {
  'GET /api/matrix/thread-ticket': ({ query }) => checkThread(query.get('key'), query.get('discussionId')),
  'POST /api/matrix/thread-ticket-draft': async ({ body }) => draftOnce(await body()),
  'GET /api/matrix/thread-tickets': ({ query }) => raisedOn(query.get('key')),
};

const storeFile = () => join(stateDir(), 'thread-tickets.json');
const recordId = (key, discussionId) => `${key}#${discussionId}`;

async function loadRecords() {
  try {
    return JSON.parse(await readFile(storeFile(), 'utf8'));
  } catch {
    return {};
  }
}

// One write at a time, so two threads finishing together cannot drop each other's record.
function saveRecord(key, discussionId, record) {
  saving = saving.catch(() => {}).then(async () => {
    const records = await loadRecords();
    if (record) records[recordId(key, discussionId)] = record;
    else delete records[recordId(key, discussionId)];
    const file = storeFile();
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file + '.tmp', JSON.stringify(records, null, 2) + '\n', { mode: 0o600 });
    await rename(file + '.tmp', file);
  });
  return saving;
}

async function recordFor(key, discussionId) {
  const id = recordId(key, discussionId);
  return settled(id, (await loadRecords())[id]);
}

async function raisedOn(key) {
  checkKey(key);
  const prefix = key + '#';
  const records = Object.entries(await loadRecords()).filter(([id]) => id.startsWith(prefix));
  return { records: Object.fromEntries(records.map(([id, record]) => [id.slice(prefix.length), settled(id, record)])) };
}

// A create that is not running here any more was cut short, so its ticket may or may not exist.
function settled(id, record) {
  if (!record?.making || writing.has(id)) return record ?? null;
  const { making, ...rest } = record;
  return { ...rest, error: `${APP_NAME} stopped before Jira answered` };
}

// Two windows, or a page reloaded while acli is still creating, would otherwise both pass verify and write twice.
function oneAtATime({ verify, run }) {
  const id = ({ key, discussionId }) => recordId(key, discussionId);
  return {
    async verify(payload) {
      if (writing.has(id(payload))) throw failure(409, 'a ticket for that thread is already under way');
      writing.add(id(payload));
      try {
        return await verify(payload);
      } catch (err) {
        writing.delete(id(payload));
        throw err;
      }
    },
    run: (payload, live) => run(payload, live).finally(() => writing.delete(id(payload))),
  };
}

function checkKey(key) {
  if (typeof key !== 'string' || !MR_KEY.test(key)) throw failure(400, BAD_KEY);
}

export async function useJira(...names) {
  requireEngine(...names);
  const { acli } = await findTools();
  if (!acli) throw failure(503, 'acli is not on the login shell\'s PATH, so Jira cannot be reached');
  process.env.UNDERLINGS_ACLI ??= acli;
}

// The ids sent to GitLab are the ones read here, never the page's, and the read replaces the drawer's cached copy.
async function readThread(key, discussionId, ...writes) {
  checkKey(key);
  const forge = forgeFor(keyParts(key), 'discussions', ...writes);
  if (typeof discussionId !== 'string' || !discussionId) throw failure(400, 'which thread?');
  const mr = mrFor(key);
  const discussions = await forge.discussions(mr);
  invalidate(key);
  const thread = discussions.find((d) => d.id === discussionId);
  if (!thread) throw failure(404, `that thread is not on ${key}`);
  const first = thread.notes.find((n) => !n.system && Number.isInteger(n.id));
  return { mr, thread, url: first ? `${mr.webUrl}#note_${first.id}` : mr.webUrl };
}

async function checkThread(key, discussionId) {
  await useJira('viewTicket', 'ticketsMentioning', 'fetchTickets');
  const { mr, thread } = await readThread(key, discussionId);
  const raised = await recordFor(key, discussionId);
  if (raised) return { raised, existing: [], searchError: null, epic: null, epicNote: null };
  const [found, epic] = await Promise.all([existingTickets(mr, thread), defaultEpic(mr)]);
  return { raised: null, ...found, ...epic };
}

// A key from another project is most likely a version or a standard, so only the MR's own project and the default one count.
function mentionedKeys(notes, ownTicket) {
  const projects = new Set([jiraSettings().defaultProject, ownTicket && projectOf(ownTicket)].filter(Boolean));
  const matches = notes.flatMap((n) => [...String(n.body ?? '').matchAll(keysInText())]);
  const keys = matches.map(([key]) => key).filter((key) => projects.has(projectOf(key)));
  return [...new Set(keys)].filter((key) => key !== ownTicket).slice(0, 10);
}

async function existingTickets(mr, thread) {
  const mentioned = mentionedKeys(thread.notes, mr.ticket);
  const phrases = thread.notes.filter((n) => Number.isInteger(n.id)).map((n) => `note_${n.id}`);
  const [linking, named] = await Promise.allSettled([engine.ticketsMentioning(phrases), engine.fetchTickets(mentioned)]);
  const offered = new Map();
  const offer = (why) => ({ key, summary, status, url }) => offered.has(key) || offered.set(key, { key, summary, status, url, why });
  (linking.value ?? []).forEach(offer('links to this thread'));
  [...(named.value?.values() ?? [])].forEach(offer('named in the thread'));
  return { existing: [...offered.values()], searchError: linking.reason?.message ?? null };
}

async function defaultEpic(mr) {
  if (!mr.ticket) return { epic: null, epicNote: 'The MR names no ticket, so give the epic yourself.' };
  try {
    const { parent } = await engine.viewTicket(mr.ticket);
    if (parent?.epic) return { epic: { key: parent.key, summary: parent.summary }, epicNote: null };
    return { epic: null, epicNote: `${mr.ticket} is not under an epic, so give one yourself.` };
  } catch (err) {
    return { epic: null, epicNote: `Could not read ${mr.ticket} from Jira (${err.message}), so give the epic yourself.` };
  }
}

// A second click while Claude is still writing waits for the same draft rather than starting another.
function draftOnce(payload) {
  const id = recordId(payload?.key, payload?.discussionId);
  if (!drafting.has(id)) drafting.set(id, draftFor(payload ?? {}).finally(() => drafting.delete(id)));
  return drafting.get(id);
}

async function draftFor({ key, discussionId, epic }) {
  const { mr, thread, url } = await readThread(key, discussionId);
  const examples = JIRA_KEY.test(epic ?? '') ? await styleExamples(epic) : [];
  return draftTicket({ mr, thread: { ...thread, ...anchorOf(thread) }, url, examples });
}

async function styleExamples(epic) {
  try {
    await useJira('ticketChildren');
    return await engine.ticketChildren(epic, STYLE_EXAMPLES);
  } catch {
    return [];
  }
}

export function ticketFields({ summary, description, epic }) {
  if (typeof summary !== 'string' || !summary.trim() || /\n/.test(summary.trim())) throw failure(400, 'the ticket needs a one-line summary');
  if (summary.trim().length > MAX_SUMMARY) throw failure(400, `a summary is at most ${MAX_SUMMARY} characters`);
  if (typeof description !== 'string' || !description.trim()) throw failure(400, 'the ticket needs a description');
  if (description.length > MAX_DESCRIPTION) throw failure(400, `a description is at most ${numberText(MAX_DESCRIPTION)} characters`);
  const parent = typeof epic === 'string' ? epic.trim().toUpperCase() : '';
  if (!JIRA_KEY.test(parent)) throw failure(400, `the ticket needs a parent epic, such as ${exampleKey(jiraSettings().defaultProject)}`);
  return { summary: summary.trim(), description: description.trim(), epic: parent };
}

export async function raiseUnderEpic(draft) {
  const fields = ticketFields(draft);
  await useJira('viewTicket', 'createTicket');
  const jira = requireEngine('viewTicket', 'createTicket');
  const parent = await jira.viewTicket(fields.epic).catch((err) => {
    throw failure(404, `could not read the epic ${fields.epic} from Jira: ${err.message}`);
  });
  if (!parent.epic) throw failure(400, `${fields.epic} is a ${parent.type}, not an epic`);
  const ticket = await jira.createTicket({ project: projectOf(fields.epic), type: jiraSettings().issueType, summary: fields.summary, description: fields.description, parent: fields.epic, assignee: '@me' }).catch((err) => {
    throw err.created ? failure(502, `a ticket was made under ${fields.epic}, but acli did not say its key, so find it there`) : err;
  });
  return { key: ticket.key, url: ticket.url, summary: fields.summary, epic: fields.epic };
}

async function openThread(key, discussionId, expect, ...needs) {
  await useJira('viewTicket', ...needs);
  refuseRaised(await recordFor(key, discussionId));
  const live = await readThread(key, discussionId, ...WRITES);
  if (!yours(live)) throw failure(403, `that thread is on someone else's MR and you have not written in it`);
  if (live.thread.resolved) throw failure(409, 'the thread was resolved since you looked');
  still(expect?.notes, live.thread.notes.map((n) => n.body), 'the thread');
  if (!live.thread.resolvable) throw failure(400, 'GitLab cannot resolve that comment, so it takes a reply instead');
  return live;
}

function refuseRaised(raised) {
  if (!raised) return;
  if (raised.ticket) throw failure(409, `${raised.ticket} was already raised for that thread`);
  throw failure(409, `a ticket for that thread may already be under ${raised.epic.key}`);
}

const yours = ({ mr, thread }) => Boolean(meFor(mr)) && (mr.author === meFor(mr) || thread.notes.some((n) => n.author === meFor(mr)));

async function readTicket(key, what) {
  try {
    return await engine.viewTicket(key);
  } catch (err) {
    throw failure(404, `could not read ${what} ${key} from Jira: ${err.message}`);
  }
}

async function verifyCreate({ key, discussionId, expect, ...draft }) {
  const fields = ticketFields(draft);
  const live = await openThread(key, discussionId, expect, 'createTicket');
  const parent = await readTicket(fields.epic, 'the epic');
  if (!parent.epic) throw failure(400, `${fields.epic} is a ${parent.type}, not an epic`);
  return { ...live, fields, epic: parent };
}

// The record is kept before acli runs, so a create the worker never hears back from still holds off a second one.
async function createAndClose({ key }, { mr, thread, fields, epic }) {
  const keyless = { ticket: null, epic: { key: epic.key, summary: epic.summary, url: epic.url }, summary: fields.summary, at: new Date().toISOString() };
  await saveRecord(key, thread.id, { ...keyless, making: true });
  const ticket = await engine.createTicket({
    project: projectOf(fields.epic), type: jiraSettings().issueType, summary: fields.summary, description: fields.description, parent: fields.epic, assignee: '@me',
  }).catch((err) => createFailed(key, thread.id, keyless, err));
  const record = { ticket: ticket.key, url: ticket.url, summary: fields.summary, reply: `Raised ${ticket.key} for this.`, replied: false, resolved: false, at: new Date().toISOString() };
  await saveRecord(key, thread.id, record);
  return closeThread(key, mr, thread.id, record);
}

async function createFailed(key, discussionId, keyless, err) {
  if (!err.created) {
    await saveRecord(key, discussionId, null);
    throw err;
  }
  await saveRecord(key, discussionId, { ...keyless, error: 'acli made it but did not say its key' });
  throw failure(502, `a ticket was made under ${keyless.epic.key}, but acli did not say its key, so find it there and reply by hand`);
}

async function verifyLink({ key, discussionId, ticket, expect }) {
  if (typeof ticket !== 'string' || !JIRA_KEY.test(ticket)) throw failure(400, 'which ticket?');
  const live = await openThread(key, discussionId, expect);
  return { ...live, found: await readTicket(ticket, 'the ticket') };
}

async function linkAndClose({ key }, { mr, thread, found }) {
  const record = { ticket: found.key, url: found.url, summary: found.summary, reply: `Covered by ${found.key}.`, linked: true, replied: false, resolved: false, at: new Date().toISOString() };
  await saveRecord(key, thread.id, record);
  return closeThread(key, mr, thread.id, record);
}

async function verifyFinish({ key, discussionId }) {
  checkKey(key);
  const record = await recordFor(key, discussionId);
  if (!record) throw failure(404, 'no ticket was raised for that thread from here');
  if (!record.ticket) throw failure(409, 'the ticket for that thread has no key here, so there is nothing to reply with');
  if (record.replied && record.resolved) throw failure(409, `${record.ticket} is already on the thread and it is resolved`);
  return { ...(await readThread(key, discussionId, ...WRITES)), record };
}

// A reply that reached GitLab before its answer was lost is found on the thread, so a retry never posts it twice.
async function finish({ key }, { mr, thread, record }) {
  const posted = thread.notes.some((n) => n.author === meFor(mr) && String(n.body).trim() === record.reply);
  return closeThread(key, mr, thread.id, { ...record, replied: record.replied || posted, resolved: record.resolved || Boolean(thread.resolved) });
}

// The ticket exists by now, so a failure here is kept on the record and only these two steps are offered again.
async function closeThread(key, mr, discussionId, record) {
  try {
    const forge = forgeFor(mr, ...WRITES);
    if (!record.replied) await forge.reply(mr, discussionId, record.reply);
    record.replied = true;
    if (!record.resolved) await forge.resolve(mr, discussionId, true);
    record.resolved = true;
  } catch (err) {
    await saveRecord(key, discussionId, { ...record, error: err.message });
    throw failure(502, `${record.ticket} is ${record.linked ? 'chosen' : 'raised'}, but ${record.replied ? 'the thread was not resolved' : 'the reply did not post'}: ${err.message}`);
  }
  delete record.error;
  await saveRecord(key, discussionId, record);
  return `${record.linked ? 'Replied with' : 'Raised'} ${record.ticket} and resolved the thread on ${key}`;
}
