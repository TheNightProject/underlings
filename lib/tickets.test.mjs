import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { act } from './actions.mjs';
import { loadEngine, refreshInbox } from './engine.mjs';
import { featuresFile } from './features.mjs';
import { readTicket, readTickets, ROUTES, settled, stop } from './tickets.mjs';
import { mr, reset, world } from './testkit.mjs';

const testkit = new URL('./testkit.mjs', import.meta.url).href;
const built = new URL('../engine/dist/engine.js', import.meta.url).href;

// A stand-in engine with Jira and the kickoff launch, each recording what it was asked, and the built GitLab forge, which reads merged MRs.
const JIRA = `
import { world } from '${testkit}';
export * from '${testkit}';
export { forgeOf } from '${built}';
const url = (key) => 'https://example.atlassian.net/browse/' + key;
export async function fetchMyTickets() {
  world.calls.push(['fetchMyTickets']);
  await world.jiraHold;
  if (world.jiraDown) throw new Error(world.jiraDown);
  return world.tickets.map((t) => ({ labels: [], url: url(t.key), ...t }));
}
export async function viewTicket(key, options = {}) {
  world.calls.push(['viewTicket', key, options.priority ?? 'now']);
  if (world.jiraDown) throw new Error(world.jiraDown);
  const t = world.tickets.find((x) => x.key === key) ?? world.others[key];
  if (!t) throw new Error('Issue does not exist');
  return { labels: [], url: url(key), type: 'Task', epic: false, description: '', parent: null, transitions: world.transitions?.[key] ?? null, ...t };
}
export async function transitionTicket(key, status) {
  world.calls.push(['transitionTicket', key, status]);
  if (world.refuse) throw new Error(world.refuse);
}
const named = () => String(world.settings.jira?.statuses ?? '').split(',').map((s) => s.trim()).filter(Boolean);
export const moveTargets = (current, seen = [], transitions = null, names = named()) => [...new Set(transitions ?? [...names, ...seen])].filter((s) => s !== current);
export async function kickoffRunAlive(key) { world.calls.push(['kickoffRunAlive', key]); return Boolean(world.kickoffAlive); }
export async function launchKickoff(key, url) { world.calls.push(['launchKickoff', key, url]); return { how: 'worktree', handle: 'term_kick', name: 'kickoff-' + key }; }
`;
process.env.GITLAB_TOKEN = 'stub-token';
globalThis.fetch = async (url, init = {}) => {
  const asked = new URL(url);
  world.calls.push(['gitlab', init.method ?? 'GET', asked.pathname, asked.searchParams.get('search')]);
  world.origins = [...(world.origins ?? []), asked.origin];
  const key = asked.searchParams.get('search');
  return { ok: true, json: async () => (world.merged?.[key] ?? []).map(([path, iid]) => ({ iid, title: `(${key}) Merged`, references: { full: `${path}!${iid}` } })) };
};
const dir = await mkdtemp(join(tmpdir(), 'control-centre-tickets-'));
process.env.HOME = dir;
process.env.UNDERLINGS_STATE_DIR = join(dir, 'engine-state');
const enginePath = join(dir, 'engine.mjs');
await writeFile(enginePath, JIRA);
await loadEngine({ matrixEngine: enginePath }, () => {});
after(() => rm(dir, { recursive: true }));

const EPIC = { key: 'ABC-100', summary: 'Native access control', epic: true };
const WRITES = new Set(['transitionTicket', 'launchKickoff']);
const writes = () => world.calls.filter(([name]) => WRITES.has(name));
const jiraCalls = () => world.calls.filter(([name]) => ['fetchMyTickets', 'viewTicket', 'transitionTicket'].includes(name));
const listReads = () => world.calls.filter(([name]) => name === 'fetchMyTickets').length;
const retryNow = ROUTES['POST /api/matrix/tickets/refresh'];
const START = Date.parse('2026-11-10T09:00:00Z');
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const SLOW = 'Jira did not answer acli within 90 s';

// ABC tickets only, a workflow, and its finished statuses.
const TEAM_JIRA = { projects: 'ABC', defaultProject: 'ABC', statuses: 'To Do, In Progress, Peer Review, QA, Done', doneStatuses: 'Done, Not Required' };

async function listed() {
  await readTickets();
  await settled();
  return readTickets();
}

beforeEach(async () => {
  stop();
  reset({
    mrs: [mr('acme/engine', 7, { ticket: 'ABC-12', author: 'frank' }), mr('acme/portal', 9, { ticket: 'ABC-99' })],
    tickets: [
      { key: 'ABC-12', summary: 'Write the edge', status: 'In Progress', parent: EPIC },
      { key: 'ABC-13', summary: 'Loose end', status: 'To Do' },
      { key: 'OPS-1', summary: 'Another project', status: 'To Do' },
    ],
    others: { 'ABC-99': { key: 'ABC-99', summary: 'Someone else', status: 'QA' } },
    jiraDown: null,
    jiraHold: null,
    refuse: null,
    kickoffAlive: false,
    settings: { jiraSite: 'example.atlassian.net', jira: TEAM_JIRA, tickets: { noQaPaths: 'acme/tooling' } },
    transitions: {},
  });
  await rm(featuresFile(), { force: true });
  await refreshInbox();
  world.calls.length = 0;
});

test('with no Jira site set, Tickets says it is off and asks nothing of Jira, not even once', async () => {
  world.settings = { jiraSite: '  ' };
  const off = await readTickets();
  await settled();
  assert.deepEqual([off.off, off.read, off.loading, off.error, off.tickets], [true, true, false, null, []]);
  assert.deepEqual(jiraCalls(), []);
  world.settings = { jiraSite: 'example.atlassian.net' };
  assert.equal((await readTickets()).off, undefined);
  await settled();
  assert.equal(listReads(), 1, 'setting the site turns it on at the next read');
});

test('the list is your open tickets in your projects, with their epic, status and the open MRs that carry them', async () => {
  const first = await readTickets();
  assert.deepEqual([first.read, first.loading], [false, true], 'the first read is under way, not an empty list');
  const list = await listed();
  assert.deepEqual([list.read, list.loading, list.error], [true, false, null]);
  assert.deepEqual(list.tickets.map((t) => [t.key, t.status, t.epicRead, t.epic?.key ?? null]), [['ABC-12', 'In Progress', true, 'ABC-100'], ['ABC-13', 'To Do', true, null]]);
  assert.deepEqual(list.tickets[0].mrs.map((m) => [m.key, m.iid, m.repo]), [['acme/engine!7', 7, 'engine']]);
  assert.deepEqual(list.tickets[0].epic, { key: 'ABC-100', summary: 'Native access control' });
});

test('each ticket is viewed once for its epic, behind any read you are waiting on, and the list is not read again while it is fresh', async () => {
  await listed();
  await listed();
  assert.deepEqual(jiraCalls(), [['fetchMyTickets'], ['viewTicket', 'ABC-12', 'background'], ['viewTicket', 'ABC-13', 'background']]);
  await readTicket('ABC-12');
  assert.deepEqual(jiraCalls().at(-1), ['viewTicket', 'ABC-12', 'now'], 'a ticket you opened is not');
});

test('a read that failed with no list to show is tried again after 20 s rather than 2 minutes', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: START });
  world.jiraDown = SLOW;
  await listed();
  t.mock.timers.setTime(START + 19 * SECOND);
  await listed();
  assert.equal(listReads(), 1, 'not straight away');
  world.jiraDown = null;
  t.mock.timers.setTime(START + 21 * SECOND);
  const list = await listed();
  assert.deepEqual([listReads(), list.read, list.error, list.tickets.length], [2, true, null, 2]);
});

test('a read that failed with an older list to show keeps that list and waits the full 2 minutes to try again', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: START });
  await listed();
  world.jiraDown = SLOW;
  const failedAt = START + 2 * MINUTE + SECOND;
  t.mock.timers.setTime(failedAt);
  const stale = await listed();
  assert.deepEqual([listReads(), stale.read, stale.error, stale.tickets.length], [2, true, SLOW, 2]);
  t.mock.timers.setTime(failedAt + 21 * SECOND);
  await listed();
  assert.equal(listReads(), 2, 'not after 20 s');
  t.mock.timers.setTime(failedAt + 2 * MINUTE + SECOND);
  await listed();
  assert.equal(listReads(), 3);
});

test('Retry now reads Jira at once however fresh the list is, but never alongside a read already under way', async () => {
  await listed();
  let release;
  world.jiraHold = new Promise((resolve) => { release = resolve; });
  assert.equal((await retryNow()).loading, true);
  assert.equal((await retryNow()).loading, true);
  assert.equal(listReads(), 2, 'the second press joins the read the first started');
  release();
  await settled();
  assert.equal((await retryNow()).loading, true, 'and once that read ends it reads again');
  await settled();
  assert.equal(listReads(), 3);
});

test('many asks at once, as the intro polling each second and the Tickets view make, read Jira once', async () => {
  let release;
  world.jiraHold = new Promise((resolve) => { release = resolve; });
  const answers = await Promise.all(Array.from({ length: 10 }, () => readTickets()));
  assert.ok(answers.every((a) => a.loading && !a.read && a.error === null), 'each is told a read is under way');
  assert.equal(listReads(), 1);
  release();
  await settled();
  assert.equal((await readTickets()).read, true);
  assert.equal(listReads(), 1);
});

test('a Jira that cannot be read says so with what acli said, on the list and on a ticket', async () => {
  world.jiraDown = SLOW;
  const list = await listed();
  assert.deepEqual([list.read, list.error, list.tickets], [false, SLOW, []]);
  await assert.rejects(readTicket('ABC-12'), { status: 502, message: `Jira cannot be read right now: ${SLOW}` });
});

test('a ticket reads with its description, epic and MRs, and offers moves only on one of your own', async () => {
  world.tickets[0].description = 'Problem\n- It breaks.';
  await listed();
  const mine = await readTicket('ABC-12');
  assert.deepEqual([mine.description, mine.epic.key, mine.mine, mine.mrs.length], ['Problem\n- It breaks.', 'ABC-100', true, 1]);
  assert.deepEqual(mine.targets, ['To Do', 'Peer Review', 'QA', 'Done']);
  const theirs = await readTicket('ABC-99');
  assert.deepEqual([theirs.mine, theirs.targets, theirs.mrs.map((m) => m.key)], [false, [], ['acme/portal!9']]);
  await assert.rejects(readTicket('ops-1; rm'), { status: 400 });
});

test('a move sends the status Jira offers once the status is still the one the page saw', async () => {
  await listed();
  const answer = await act('ticket-status', { key: 'ABC-12', status: 'QA', expect: { status: 'In Progress' } });
  assert.equal(answer.text, 'Moved ABC-12 to QA');
  assert.deepEqual(writes(), [['transitionTicket', 'ABC-12', 'QA']]);
  assert.equal((await readTickets()).tickets[0].status, 'QA', 'the list shows the move at once');
});

test('a move is refused with 409 when the status changed since the page looked, and nothing is sent', async () => {
  await listed();
  world.tickets[0].status = 'Peer Review';
  await assert.rejects(act('ticket-status', { key: 'ABC-12', status: 'QA', expect: { status: 'In Progress' } }), { status: 409, message: 'the status of ABC-12 changed since you looked' });
  assert.deepEqual(writes(), []);
});

test('two moves sent at once on one ticket send one, and the other is refused with 409 until the first is done', async () => {
  await listed();
  const saw = { status: 'In Progress' };
  const [first, second] = await Promise.allSettled([
    act('ticket-status', { key: 'ABC-12', status: 'QA', expect: saw }),
    act('ticket-status', { key: 'ABC-12', status: 'To Do', expect: saw }),
  ]);
  assert.equal(first.value?.text, 'Moved ABC-12 to QA');
  assert.deepEqual([second.reason?.status, second.reason?.message], [409, 'ABC-12 is already being moved']);
  assert.deepEqual(writes(), [['transitionTicket', 'ABC-12', 'QA']]);
  world.tickets[0].status = 'QA';
  await act('ticket-status', { key: 'ABC-12', status: 'To Do', expect: { status: 'QA' } });
  assert.equal(writes().length, 2, 'the key is free again once the move is done');
});

test('a move goes only to a status Jira offers, only for your own listed ticket, and only with what the page saw', async () => {
  await listed();
  const refused = [
    [{ key: 'ABC-12', status: 'In Progress', expect: { status: 'In Progress' } }, 400, /Jira offers no move from In Progress to In Progress/],
    [{ key: 'ABC-12', status: 'Shipped', expect: { status: 'In Progress' } }, 400, /no move from In Progress to Shipped/],
    [{ key: 'ABC-12', status: 'QA' }, 400, /did not send what it saw/],
    [{ key: 'ABC-99', status: 'QA', expect: { status: 'QA' } }, 404, /not one of your open tickets/],
    [{ key: 'OPS-1', status: 'QA', expect: { status: 'To Do' } }, 400, /must be a Jira ticket/],
    [{ key: 'ABC-12 --yes', status: 'QA', expect: { status: 'In Progress' } }, 400, /must be a Jira ticket/],
  ];
  for (const [payload, status, message] of refused) await assert.rejects(act('ticket-status', payload), { status, message }, JSON.stringify(payload));
  assert.deepEqual(writes(), []);
});

test("Jira's own refusal of a move comes back in its words", async () => {
  await listed();
  world.refuse = 'Transition not valid for ABC-12';
  await assert.rejects(act('ticket-status', { key: 'ABC-12', status: 'QA', expect: { status: 'In Progress' } }), { status: 502, message: 'Transition not valid for ABC-12' });
});

test('each listed ticket carries the moves Jira offers it and the one its MRs suggest', async () => {
  world.mrs.push(mr('acme/engine', 8, { ticket: 'ABC-13', draft: true }));
  world.tickets.push({ key: 'ABC-14', summary: 'Shipped', status: 'Peer Review' }, { key: 'ABC-15', summary: 'Tooling', status: 'Peer Review' });
  world.merged = { 'ABC-14': [['acme/engine', 3]], 'ABC-15': [['acme/tooling/atlas', 4]] };
  await refreshInbox();
  const list = await listed();
  const by = Object.fromEntries(list.tickets.map((t) => [t.key, t]));
  assert.deepEqual(by['ABC-12'].targets, ['To Do', 'Peer Review', 'QA', 'Done']);
  assert.deepEqual(by['ABC-12'].suggest, { status: 'Peer Review', why: '!7 is in review' });
  assert.deepEqual(by['ABC-13'].suggest, { status: 'In Progress', why: '!8 is a draft' });
  assert.deepEqual(by['ABC-14'].suggest, { status: 'QA', why: '!3 merged' });
  assert.deepEqual(by['ABC-15'].suggest, { status: 'Done', why: '!4 merged in tooling' });
  assert.deepEqual(world.calls.filter(([name]) => name === 'gitlab'), [['gitlab', 'GET', '/api/v4/groups/acme/merge_requests', 'ABC-14'], ['gitlab', 'GET', '/api/v4/groups/acme/merge_requests', 'ABC-15']],
    'only the tickets with no open MR are looked up, in the group the open MRs come from');
  assert.equal(list.mergedError, null);
});

test('the ticket drawer offers the same suggestion from the live status, and none on a ticket not yours', async () => {
  world.tickets[1].status = 'Peer Review';
  world.merged = { 'ABC-13': [['acme/engine', 3]] };
  await listed();
  assert.deepEqual((await readTicket('ABC-13')).suggest, { status: 'QA', why: '!3 merged' });
  world.tickets[1].status = 'QA';
  assert.equal((await readTicket('ABC-13')).suggest, null, 'a ticket already in QA has nothing to move to');
  assert.equal((await readTicket('ABC-99')).suggest, null);
});

test('a ticket moved to Done leaves the list at once, since Jira will not list it again', async () => {
  await listed();
  await act('ticket-status', { key: 'ABC-12', status: 'Done', expect: { status: 'In Progress' } });
  assert.deepEqual((await readTickets()).tickets.map((t) => t.key), ['ABC-13']);
});

test('a start launches the kickoff agent on your ticket, with its Jira link for the run', async () => {
  await listed();
  const answer = await act('ticket-start', { key: 'ABC-12' });
  assert.deepEqual(writes(), [['launchKickoff', 'ABC-12', 'https://example.atlassian.net/browse/ABC-12']]);
  assert.equal(answer.text, 'An agent is starting ABC-12 in kickoff-ABC-12. It asks you before it pushes, raises an MR or touches Jira.');
});

test('a second start is refused with 409 while the last kickoff agent is still open, and a ticket not yours is refused', async () => {
  await listed();
  world.kickoffAlive = true;
  await assert.rejects(act('ticket-start', { key: 'ABC-12' }), { status: 409, message: /an agent is still open on ABC-12/ });
  await assert.rejects(act('ticket-start', { key: 'ABC-99' }), { status: 404 });
  assert.deepEqual(writes(), []);
});

test('nothing is moved or started before your tickets have been read', async () => {
  await assert.rejects(act('ticket-start', { key: 'ABC-12' }), { status: 503 });
  await assert.rejects(act('ticket-status', { key: 'ABC-12', status: 'QA', expect: { status: 'In Progress' } }), { status: 503 });
  assert.deepEqual(writes(), []);
});

test('with no projects named, every open ticket of yours is listed whatever its project, and moves to the statuses seen on them', async () => {
  world.settings = { jiraSite: 'example.atlassian.net' };
  const list = await listed();
  assert.deepEqual(list.tickets.map((t) => t.key), ['ABC-12', 'ABC-13', 'OPS-1']);
  const ops = list.tickets.find((t) => t.key === 'OPS-1');
  assert.deepEqual(ops.targets, ['In Progress']);
  assert.equal((await act('ticket-status', { key: 'OPS-1', status: 'In Progress', expect: { status: 'To Do' } })).text, 'Moved OPS-1 to In Progress');
  assert.deepEqual(writes(), [['transitionTicket', 'OPS-1', 'In Progress']]);
});

test('a fresh install on another project lists its tickets and moves them through the transitions Jira gives each one', async () => {
  world.settings = { jiraSite: 'example.atlassian.net', jira: { projects: 'OPS' } };
  world.tickets = [{ key: 'OPS-7', summary: 'Rotate the keys', status: 'Open' }, { key: 'OPS-8', summary: 'Patch the hosts', status: 'Open' }];
  world.transitions = { 'OPS-7': ['Doing', 'Won\'t do'] };
  const list = await listed();
  assert.deepEqual(list.tickets.map((t) => [t.key, t.targets]), [['OPS-7', ['Doing', 'Won\'t do']], ['OPS-8', []]]);
  assert.deepEqual((await readTicket('OPS-7')).targets, ['Doing', 'Won\'t do']);
  await assert.rejects(act('ticket-status', { key: 'OPS-7', status: 'Shipped', expect: { status: 'Open' } }), { status: 400, message: /no move from Open to Shipped/ });
  assert.equal((await act('ticket-status', { key: 'OPS-7', status: 'Doing', expect: { status: 'Open' } })).text, 'Moved OPS-7 to Doing');
  await assert.rejects(act('ticket-status', { key: 'ABC-12', status: 'QA', expect: { status: 'In Progress' } }), { status: 400, message: /must be a Jira ticket such as OPS-1234/ });
});

test('a ticket moved to a finished status of your own leaves the list, and with none named Done still does', async () => {
  world.settings = { ...world.settings, jira: { ...TEAM_JIRA, doneStatuses: 'Closed' } };
  await listed();
  await act('ticket-status', { key: 'ABC-12', status: 'Closed', expect: { status: 'In Progress' } }).catch(() => null);
  world.settings = { ...world.settings, jira: { ...TEAM_JIRA, statuses: 'Closed', doneStatuses: 'Closed' } };
  await act('ticket-status', { key: 'ABC-12', status: 'Closed', expect: { status: 'In Progress' } });
  assert.deepEqual((await readTickets()).tickets.map((t) => t.key), ['ABC-13']);
});

test('with Tickets switched off nothing is asked of Jira and the page is told it is off', async () => {
  await mkdir(dirname(featuresFile()), { recursive: true });
  await writeFile(featuresFile(), JSON.stringify({ tickets: false }));
  const off = await readTickets();
  await settled();
  assert.deepEqual([off.feature, off.tickets], [false, []]);
  assert.deepEqual(jiraCalls(), []);
});

test('the merged MRs behind a suggestion are looked up on a self-hosted GitLab at its own host', async () => {
  const engine = await import(built);
  engine.saveSettings({ ...engine.loadSettings(), gitlab: { host: 'https://git.acme.test/gitlab' } });
  world.merged = { 'ABC-13': [['acme/engine', 3]] };
  world.origins = [];
  await listed();
  assert.deepEqual([...new Set(world.origins)], ['https://git.acme.test']);
  assert.deepEqual(world.calls.filter(([name]) => name === 'gitlab').map(([, , path]) => path), ['/gitlab/api/v4/groups/acme/merge_requests']);
});
