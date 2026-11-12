import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const CLAUDE = '/fake/bin/claude';
const ACLI = '/fake/bin/acli';
const processes = [];
let claudeAnswer;

mock.module('node:child_process', {
  namedExports: {
    execFile(cmd, args, options, done) {
      const call = { cmd, args, options, input: undefined };
      processes.push(call);
      const answer = (err, out = '') => setImmediate(() => done(err, out, ''));
      if (cmd === '/bin/zsh') answer(null, `Last login: today\n__CONTROL_CENTRE_BIN__\nclaude=${CLAUDE}\nacli=${ACLI}\n`);
      else if (cmd === CLAUDE) setImmediate(() => claudeAnswer(call).then((out) => done(null, out, ''), (err) => done(err, err.stdout ?? '', '')));
      else answer(Object.assign(new Error(`${cmd} is stubbed`), { code: 1 }));
      return { stdin: { on() { return this; }, end: (text) => { call.input = text; } } };
    },
  },
});

const home = await mkdtemp(join(tmpdir(), 'control-centre-ticket-'));
process.env.HOME = home;
const testkit = new URL('./testkit.mjs', import.meta.url).href;
const writer = join(home, 'engine.mjs');
await writeFile(writer, `import { world } from '${testkit}';
export * from '${testkit}';
const note = (name, ...args) => world.calls.push([name, ...args]);
const fails = (name) => { const why = world.jira.fail[name]; if (why) { world.jira.fail[name] = null; throw new Error(why); } };
export async function replyToDiscussion(...args) { note('replyToDiscussion', ...args); fails('reply'); }
export async function setDiscussionResolved(...args) { note('setDiscussionResolved', ...args); fails('resolve'); }
export async function viewTicket(key) { note('viewTicket', key); const t = world.jira.tickets[key]; if (!t) throw new Error('no such work item'); return t; }
export async function fetchTickets(keys) { note('fetchTickets', keys); return new Map(keys.filter((k) => world.jira.tickets[k]).map((k) => [k, world.jira.tickets[k]])); }
export async function ticketsMentioning(phrases) { note('ticketsMentioning', phrases); fails('search'); return world.jira.mentioning; }
export async function ticketChildren(key, limit) { note('ticketChildren', key, limit); return world.jira.children; }
export async function createTicket(ticket) {
  note('createTicket', ticket);
  await world.jira.hold;
  fails('create');
  if (world.jira.keyless) throw Object.assign(new Error('acli created a work item but did not say its key'), { created: true });
  return { key: 'ABC-4400', summary: ticket.summary, status: 'Unknown', labels: [], url: 'https://example.atlassian.net/browse/ABC-4400' }; }
`);

const { act } = await import('./actions.mjs');
const { route } = await import('./app.mjs');
const { loadEngine, refreshInbox } = await import('./engine.mjs');
const { invalidate } = await import('./mrdetail.mjs');
const { mr, reset, world } = await import('./testkit.mjs');
await loadEngine({ matrixEngine: writer }, () => {});

after(() => rm(home, { recursive: true }));

const KEY = 'acme/engine!1121';
const URL_OF = 'https://gitlab.com/acme/engine/-/merge_requests/1121';
const SEEN = { notes: ['NIT: rename this, see ABC-1200 and UTF-8.', 'Agreed, later. ABC-77 has the rest.'] };
const DRAFT = {
  summary: 'engine: rename the cache helper',
  description: 'Problem\nThe helper is named after what it was.\n\nFix\nRename it.\n\nAcceptance criteria\n- It reads as what it does.',
};

function note(id, author, body) {
  return { id, author, body, createdAt: '2026-11-05T10:00:00Z', system: false };
}

const ticket = (key, extra = {}) => ({ key, summary: `Summary of ${key}`, status: 'To Do', labels: [], url: `https://example.atlassian.net/browse/${key}`, type: 'Task', epic: false, parent: null, ...extra });
const EPIC = ticket('ABC-3789', { summary: 'Native access control', type: 'Epic', epic: true });

// The Jira settings a team has saved.
const TEAM_JIRA = { defaultProject: 'ABC', issueType: 'Task', ticketTemplate: '# Problem\n# Fix\n# Acceptance criteria\nProblem and Fix are a short paragraph each.' };

beforeEach(async () => {
  reset({ mrs: [mr('acme/engine', 1121, { ticket: 'ABC-1200' }), mr('acme/other', 900, { author: 'bob', ticket: null })], settings: { jira: TEAM_JIRA } });
  world.discussions[1121] = [
    { id: 'd-nit', resolved: false, resolvable: true, position: { new_path: 'src/cache.py', new_line: 12 }, notes: [note(501, 'frank', 'NIT: rename this, see ABC-1200 and UTF-8.'), note(502, 'ivan', 'Agreed, later. ABC-77 has the rest.')] },
    { id: 'd-done', resolved: true, resolvable: true, notes: [note(503, 'frank', 'Typo')] },
    { id: 'd-plain', resolved: true, resolvable: false, notes: [note(504, 'frank', 'Nice.')] },
  ];
  world.discussions[900] = [{ id: 'd-theirs', resolved: false, resolvable: true, notes: [note(601, 'bob', 'Rename?'), note(602, 'carol', 'Later.')] }];
  world.jira = {
    tickets: { 'ABC-1200': ticket('ABC-1200', { parent: { key: 'ABC-3789', summary: 'Native access control', epic: true } }), 'ABC-77': ticket('ABC-77'), 'ABC-3789': EPIC },
    mentioning: [], children: [ticket('ABC-4368', { summary: 'order-book: the audit router is open' })], fail: {},
  };
  claudeAnswer = async () => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: '', structured_output: DRAFT });
  await rm(join(home, '.local'), { recursive: true, force: true });
  invalidate();
  await refreshInbox();
  world.calls.length = 0;
});

const get = (path, params) => route({ method: 'GET', path, query: new URLSearchParams(params), body: async () => ({}) });
const post = (path, body) => route({ method: 'POST', path, query: new URLSearchParams(), body: async () => body });
const check = (discussionId = 'd-nit', key = KEY) => get('/api/matrix/thread-ticket', { key, discussionId });
const draft = (extra = {}) => post('/api/matrix/thread-ticket-draft', { key: KEY, discussionId: 'd-nit', epic: 'ABC-3789', ...extra });
const CREATE = { key: KEY, discussionId: 'd-nit', expect: SEEN, ...DRAFT, epic: 'ABC-3789' };
const create = (extra = {}) => act('thread-ticket', { ...CREATE, ...extra });
const link = (extra = {}) => act('thread-ticket-link', { key: KEY, discussionId: 'd-nit', ticket: 'ABC-77', expect: SEEN, ...extra });
const finishing = () => act('thread-ticket-finish', { key: KEY, discussionId: 'd-nit' });
const records = async () => (await get('/api/matrix/thread-tickets', { key: KEY })).records;
const called = (name) => world.calls.filter(([n]) => n === name);
const writes = () => world.calls.filter(([n]) => ['createTicket', 'replyToDiscussion', 'setDiscussionResolved'].includes(n));

test('a check finds the tickets named in the thread and the ones whose text links any of its notes', async () => {
  world.jira.mentioning = [ticket('ABC-4300', { summary: 'engine: cache rename' })];
  const result = await check();
  assert.deepEqual(called('ticketsMentioning'), [['ticketsMentioning', ['note_501', 'note_502']]]);
  assert.deepEqual(called('fetchTickets'), [['fetchTickets', ['ABC-77']]], 'the MR\'s own ticket and keys like UTF-8 are not candidates');
  assert.deepEqual(result.existing.map((t) => [t.key, t.why]), [['ABC-4300', 'links to this thread'], ['ABC-77', 'named in the thread']]);
  assert.equal(result.raised, null);
});

test('a ticket found both ways is offered once', async () => {
  world.jira.mentioning = [ticket('ABC-77')];
  assert.deepEqual((await check()).existing.map((t) => [t.key, t.why]), [['ABC-77', 'links to this thread']]);
});

test('the epic defaults to the parent of the MR\'s own ticket, read live from Jira', async () => {
  assert.deepEqual((await check()).epic, { key: 'ABC-3789', summary: 'Native access control' });
  assert.deepEqual(called('viewTicket'), [['viewTicket', 'ABC-1200']]);
  world.jira.tickets['ABC-1200'].parent = { key: 'ABC-1100', summary: 'A story', epic: false };
  const notUnder = await check();
  assert.deepEqual([notUnder.epic, notUnder.epicNote], [null, 'ABC-1200 is not under an epic, so give one yourself.']);
  delete world.jira.tickets['ABC-1200'];
  assert.match((await check()).epicNote, /^Could not read ABC-1200 from Jira \(no such work item\)/);
});

test('a Jira search that fails still offers what the thread names, and says the search failed', async () => {
  world.jira.fail.search = 'acli is not logged in';
  const result = await check();
  assert.deepEqual(result.existing.map((t) => t.key), ['ABC-77']);
  assert.equal(result.searchError, 'acli is not logged in');
});

test('a draft is asked of Claude Code by its absolute path, with no tools, and checked before it reaches the page', async () => {
  const result = await draft();
  assert.deepEqual(result, { summary: DRAFT.summary, description: `${DRAFT.description}\n\nRaised in review: ${URL_OF}#note_501` });
  const [claude] = processes.filter((p) => p.cmd === CLAUDE).slice(-1);
  assert.equal(claude.args[claude.args.indexOf('--tools') + 1], '');
  assert.ok(claude.args.includes('-p') && claude.args.includes('--safe-mode'));
  assert.equal(claude.options.env.GITLAB_TOKEN, undefined, 'the GitLab token stays in the worker');
  assert.match(claude.input, /<note author="frank">\nNIT: rename this/);
  assert.match(claude.input, /ABC-4368: order-book: the audit router is open/, 'the epic\'s other tickets set the style');
  assert.match(claude.input, new RegExp(`url: ${URL_OF}#note_501`));
  assert.match(claude.input, /\nfile: src\/cache\.py\nline: 12\n/, 'the line the thread is on, from its GitLab position');
  await draft();
  assert.equal(processes.filter((p) => p.cmd === '/bin/zsh').length, 1, 'the login shell is asked where claude is once');
});

test('two drafts asked for at once run Claude once', async () => {
  const before = processes.filter((p) => p.cmd === CLAUDE).length;
  const [a, b] = await Promise.all([draft(), draft()]);
  assert.deepEqual(a, b);
  assert.equal(processes.filter((p) => p.cmd === CLAUDE).length, before + 1);
});

test('a draft that is not usable is a plain error the page can offer to try again', async () => {
  claudeAnswer = async () => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Sure! Here is a ticket.' });
  await assert.rejects(draft(), { status: 502, message: "Claude's draft was not usable: the draft is not JSON" });
  claudeAnswer = async () => JSON.stringify({ type: 'result', subtype: 'success', is_error: false, structured_output: { summary: 'x', description: 'Problem\nonly this, and nothing about a fix at all.' } });
  await assert.rejects(draft(), { status: 502, message: /no Fix or Acceptance criteria section/ });
  claudeAnswer = async () => Promise.reject(Object.assign(new Error('exit 1'), { stdout: JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: 'Not logged in. Run /login' }) }));
  await assert.rejects(draft(), { status: 502, message: /Claude Code stopped: Not logged in/ });
});

test('creating takes the page\'s view of the thread, and refuses with 409 when it was resolved or a note arrived since', async () => {
  await assert.rejects(create({ expect: undefined }), { status: 400 });
  world.discussions[1121][0].notes.push(note(505, 'ivan', 'Actually, let me do it now.'));
  await assert.rejects(create(), { status: 409, message: 'the thread changed since you looked' });
  world.discussions[1121][0].notes.pop();
  world.discussions[1121][0].resolved = true;
  await assert.rejects(create(), { status: 409, message: 'the thread was resolved since you looked' });
  assert.deepEqual(writes(), []);
});

test('creating needs a summary, a description and a parent that is an epic', async () => {
  for (const bad of [{ summary: '' }, { summary: 'two\nlines' }, { summary: 'x'.repeat(256) }, { description: '  ' }, { epic: '' }, { epic: 'not a key' }]) {
    await assert.rejects(create(bad), { status: 400 }, JSON.stringify(bad));
  }
  await assert.rejects(create({ epic: 'ABC-77' }), { status: 400, message: 'ABC-77 is a Task, not an epic' });
  await assert.rejects(create({ epic: 'ABC-9999' }), { status: 404 });
  assert.deepEqual(writes(), []);
});

test('a thread on someone else\'s MR that you never wrote in is refused', async () => {
  await assert.rejects(act('thread-ticket', { key: 'acme/other!900', discussionId: 'd-theirs', expect: { notes: ['Rename?', 'Later.'] }, ...DRAFT, epic: 'ABC-3789' }), { status: 403 });
  assert.deepEqual(writes(), []);
});

test('a created ticket is under the epic, assigned to you, and the thread is answered and resolved', async () => {
  const { text } = await create({ epic: 'abc-3789 ' });
  assert.equal(text, `Raised ABC-4400 and resolved the thread on ${KEY}`);
  assert.deepEqual(writes(), [
    ['createTicket', { project: 'ABC', type: 'Task', summary: DRAFT.summary, description: DRAFT.description, parent: 'ABC-3789', assignee: '@me' }],
    ['replyToDiscussion', 7, 1121, 'd-nit', 'Raised ABC-4400 for this.'],
    ['setDiscussionResolved', 7, 1121, 'd-nit', true],
  ]);
  const { 'd-nit': raised } = await records();
  assert.deepEqual([raised.ticket, raised.url, raised.replied, raised.resolved, raised.error], ['ABC-4400', 'https://example.atlassian.net/browse/ABC-4400', true, true, undefined]);
  assert.equal((await check()).raised.ticket, 'ABC-4400', 'a check of that thread now names it');
  await assert.rejects(create(), { status: 409, message: 'ABC-4400 was already raised for that thread' });
});

test('a reply that fails once the ticket exists keeps the ticket, and the retry only replies and resolves', async () => {
  world.jira.fail.reply = 'GitLab 500';
  await assert.rejects(create(), { status: 502, message: 'ABC-4400 is raised, but the reply did not post: GitLab 500' });
  const kept = (await records())['d-nit'];
  assert.deepEqual([kept.ticket, kept.replied, kept.resolved, kept.error], ['ABC-4400', false, false, 'GitLab 500']);
  await assert.rejects(create(), { status: 409 }, 'a second create is refused, so there is never a second ticket');
  world.calls.length = 0;
  const { text } = await act('thread-ticket-finish', { key: KEY, discussionId: 'd-nit' });
  assert.equal(text, `Raised ABC-4400 and resolved the thread on ${KEY}`);
  assert.deepEqual(writes().map(([n]) => n), ['replyToDiscussion', 'setDiscussionResolved']);
  const done = (await records())['d-nit'];
  assert.deepEqual([done.replied, done.resolved, 'error' in done], [true, true, false]);
  await assert.rejects(act('thread-ticket-finish', { key: KEY, discussionId: 'd-nit' }), { status: 409 });
});

test('a resolve that fails is retried alone, and a reply that reached GitLab is never posted twice', async () => {
  world.jira.fail.resolve = 'GitLab 503';
  await assert.rejects(create(), { message: 'ABC-4400 is raised, but the thread was not resolved: GitLab 503' });
  world.calls.length = 0;
  await act('thread-ticket-finish', { key: KEY, discussionId: 'd-nit' });
  assert.deepEqual(writes().map(([n]) => n), ['setDiscussionResolved']);

  await rm(join(home, '.local'), { recursive: true, force: true });
  world.jira.fail.reply = 'socket hang up';
  await assert.rejects(create());
  world.discussions[1121][0].notes.push(note(506, 'frank', 'Raised ABC-4400 for this.'));
  world.calls.length = 0;
  await act('thread-ticket-finish', { key: KEY, discussionId: 'd-nit' });
  assert.deepEqual(writes().map(([n]) => n), ['setDiscussionResolved'], 'the reply found on the thread is not sent again');
});

test('an existing ticket is replied with and the thread resolved, with no ticket created', async () => {
  const { text } = await link();
  assert.equal(text, `Replied with ABC-77 and resolved the thread on ${KEY}`);
  assert.deepEqual(writes(), [['replyToDiscussion', 7, 1121, 'd-nit', 'Covered by ABC-77.'], ['setDiscussionResolved', 7, 1121, 'd-nit', true]]);
  assert.equal((await records())['d-nit'].ticket, 'ABC-77');
  await assert.rejects(act('thread-ticket-link', { key: KEY, discussionId: 'd-done', ticket: 'ABC-9999', expect: { notes: ['Typo'] } }), { status: 409 });
});

test('the record of raised tickets is a file of its own in the state folder', async () => {
  await create();
  const saved = JSON.parse(await readFile(join(home, '.local/state/underlings/thread-tickets.json'), 'utf8'));
  assert.deepEqual(Object.keys(saved), [`${KEY}#d-nit`]);
  assert.deepEqual(await get('/api/matrix/thread-tickets', { key: 'acme/other!900' }), { records: {} });
});

test('an engine built before tickets could be made answers 501, so the page can offer a rebuild', async () => {
  await loadEngine({ matrixEngine: fileURLToPath(testkit) }, () => {});
  try {
    await assert.rejects(check(), { status: 501, message: /viewTicket/ });
    await assert.rejects(create(), { status: 501, message: /createTicket/ });
  } finally {
    await loadEngine({ matrixEngine: writer }, () => {});
  }
});

test('a note edited, or swapped for another, since the page looked is refused like a new one', async () => {
  const [, second] = world.discussions[1121][0].notes;
  second.body = 'Changed my mind: this is a real bug, please fix it in this MR before merging.';
  await assert.rejects(create(), { status: 409, message: 'the thread changed since you looked' });
  await assert.rejects(link(), { status: 409, message: 'the thread changed since you looked' });
  world.discussions[1121][0].notes[1] = note(599, 'ivan', 'Blocker: fix before merge.');
  await assert.rejects(create(), { status: 409, message: 'the thread changed since you looked' });
  assert.deepEqual(writes(), []);
});

const held = () => {
  let release;
  world.jira.hold = new Promise((resolve) => { release = resolve; });
  return () => release();
};

async function until(done) {
  for (let i = 0; i < 1000 && !done(); i++) await new Promise((resolve) => setImmediate(resolve));
  assert.ok(done(), 'it never got there');
}

test('two creates for one thread at once make one ticket, and the second is refused', async () => {
  const release = held();
  const both = Promise.allSettled([create(), create()]);
  await until(() => called('createTicket').length);
  release();
  const results = await both;
  assert.deepEqual(results.map((r) => r.status).sort(), ['fulfilled', 'rejected']);
  assert.equal(results.find((r) => r.status === 'rejected').reason.status, 409);
  assert.deepEqual(writes().map(([n]) => n), ['createTicket', 'replyToDiscussion', 'setDiscussionResolved']);
});

test('a create, a link and a retry on one thread never run together', async () => {
  const release = held();
  const first = create();
  await until(() => called('createTicket').length);
  await assert.rejects(link(), { status: 409 });
  await assert.rejects(finishing(), { status: 409 });
  release();
  await first;
  assert.deepEqual(writes().map(([n]) => n), ['createTicket', 'replyToDiscussion', 'setDiscussionResolved']);

  await rm(join(home, '.local'), { recursive: true, force: true });
  world.jira.fail.reply = 'GitLab 500';
  await assert.rejects(create());
  world.calls.length = 0;
  await Promise.allSettled([finishing(), finishing()]);
  assert.equal(called('replyToDiscussion').length, 1, 'two retries at once post the reply once');
});

test('a create still waiting on acli holds off a create from a reloaded worker, and the page sees it being made', async () => {
  const release = held();
  const first = create();
  await until(() => called('createTicket').length);
  const reloaded = await import('./threadticket.mjs?reloaded');
  await assert.rejects(reloaded.ACTIONS['thread-ticket'].verify(CREATE), { status: 409, message: 'a ticket for that thread may already be under ABC-3789' });
  const making = (await records())['d-nit'];
  assert.deepEqual([making.ticket, making.making, making.epic.key, making.epic.url], [null, true, 'ABC-3789', 'https://example.atlassian.net/browse/ABC-3789']);
  const cut = (await reloaded.ROUTES['GET /api/matrix/thread-tickets']({ query: new URLSearchParams({ key: KEY }) })).records['d-nit'];
  assert.deepEqual([cut.making, cut.error], [undefined, 'Underlings stopped before Jira answered'], 'a worker not running the create says it was cut short');
  release();
  await first;
  assert.equal((await records())['d-nit'].ticket, 'ABC-4400');
});

test('a create acli refused leaves no record, so it can be tried again', async () => {
  world.jira.fail.create = 'parent ABC-3789 is closed';
  await assert.rejects(create(), { message: 'parent ABC-3789 is closed' });
  assert.deepEqual(await records(), {});
  const { text } = await create();
  assert.equal(text, `Raised ABC-4400 and resolved the thread on ${KEY}`);
});

test('a ticket acli made without saying its key is kept, so no second one is made and nothing replies with it', async () => {
  world.jira.keyless = true;
  await assert.rejects(create(), { status: 502, message: 'a ticket was made under ABC-3789, but acli did not say its key, so find it there and reply by hand' });
  const kept = (await records())['d-nit'];
  assert.deepEqual([kept.ticket, kept.error, kept.epic.key, kept.making], [null, 'acli made it but did not say its key', 'ABC-3789', undefined]);
  world.jira.keyless = false;
  await assert.rejects(create(), { status: 409, message: 'a ticket for that thread may already be under ABC-3789' });
  await assert.rejects(finishing(), { status: 409 });
  assert.equal((await check()).raised.error, 'acli made it but did not say its key');
  assert.deepEqual(writes().map(([n]) => n), ['createTicket']);
});

test('keys from the default project and the MR\'s own count in a thread, so a version or standard never does', async () => {
  world.settings = { jira: { ...TEAM_JIRA, defaultProject: 'OPS' } };
  world.discussions[1121][0].notes[1].body = 'Later. OPS-5, ABC-77, XYZ-9 and SHA-256 cover it.';
  world.jira.tickets['OPS-5'] = ticket('OPS-5');
  await check();
  assert.deepEqual(called('fetchTickets'), [['fetchTickets', ['OPS-5', 'ABC-77']]]);
  world.settings = { jira: { ...TEAM_JIRA, defaultProject: '' } };
  world.calls.length = 0;
  await check();
  assert.deepEqual(called('fetchTickets'), [['fetchTickets', ['ABC-77']]], 'with none set, the MR\'s own project alone');
});

test('a ticket is raised as the issue type in the settings', async () => {
  world.settings = { jira: { ...TEAM_JIRA, issueType: 'Story' } };
  await create();
  assert.equal(called('createTicket')[0][1].type, 'Story');
});
