import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { beforeEach, test } from 'node:test';
import { promisify } from 'node:util';

process.env['UNDERLINGS_STATE_DIR'] = mkdtempSync(join(tmpdir(), 'jira-test-'));
process.env['UNDERLINGS_JIRA_SITE'] = 'example.atlassian.net';

interface Call {
  cmd: string;
  args: string[];
  options: Record<string, unknown>;
}

const calls: Call[] = [];
let reply: () => Promise<{ stdout: string }> = () => Promise.resolve({ stdout: '[]' });
const fakeExecFile = Object.assign(() => undefined, {
  [promisify.custom]: (cmd: string, args: string[], options: Record<string, unknown> = {}) => {
    calls.push({ cmd, args, options });
    return reply();
  },
});
Object.assign(childProcess, { execFile: fakeExecFile });
syncBuiltinESMExports();
const { adfText, createArgs, createdKey, createTicket, descriptionDoc, doneClause, fetchMyTickets, fetchTicketKeys, ticketChildren, ticketsMentioning, transitionTicket, viewTicket } = await import('./data/jira.js');
const { changeSettings } = await import('./data/store.js');
const { DEFAULT_JIRA } = await import('./settings.js');
const { TEAM_JIRA } = await import('./jira.testkit.js');
const useJira = (jira: Partial<typeof DEFAULT_JIRA>) => changeSettings((s) => ({ ...s, jira: { ...DEFAULT_JIRA, ...jira } }));

beforeEach(() => {
  calls.length = 0;
  useJira({});
  delete process.env['UNDERLINGS_ACLI'];
  reply = () => Promise.resolve({ stdout: '[]' });
});

const answer = (value: unknown) => () => Promise.resolve({ stdout: JSON.stringify(value) });
const flag = (args: string[], name: string) => args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);

const NASTY = '$(touch /tmp/pwned); `id` && rm -rf ~ "quoted" \'single\' --parent=ABC-1';
const TICKET = {
  project: 'ABC',
  type: 'Task',
  summary: NASTY,
  description: 'Problem\nIt breaks.\n\nFix\nMend it.\n\nAcceptance criteria\n- It works.',
  parent: 'ABC-3789',
  assignee: '@me',
};

test('a ticket is created with every value as one argument of its own, never through a shell', async () => {
  reply = answer({ key: 'ABC-4400', id: '1', self: 'https://example.atlassian.net/rest/api/3/issue/1' });
  const created = await createTicket(TICKET);
  assert.deepEqual(created, { key: 'ABC-4400', summary: NASTY, status: 'Unknown', labels: [], url: 'https://example.atlassian.net/browse/ABC-4400' });
  assert.equal(calls.length, 1);
  const { cmd, args, options } = calls[0] as Call;
  assert.equal(cmd, 'acli');
  assert.equal(options['shell'], undefined);
  assert.deepEqual(args.slice(0, 6), ['jira', 'workitem', 'create', '--project=ABC', '--type=Task', `--summary=${NASTY}`]);
  assert.deepEqual(args.slice(-3), ['--parent=ABC-3789', '--assignee=@me', '--json']);
  assert.equal(args.filter((a) => a.startsWith('--parent')).length, 1, 'a flag inside the summary stays inside the summary');
});

test('acli is run by the absolute path a front end names, when it names one', async () => {
  process.env['UNDERLINGS_ACLI'] = '/opt/homebrew/bin/acli';
  reply = answer({ key: 'ABC-4401' });
  await createTicket(TICKET);
  await ticketChildren('ABC-3789');
  assert.deepEqual(calls.map((c) => c.cmd), ['/opt/homebrew/bin/acli', '/opt/homebrew/bin/acli']);
});

test('a project or parent that is not a Jira key is refused before acli runs', async () => {
  await assert.rejects(createTicket({ ...TICKET, project: 'ABC; rm' }), /not a Jira project key/);
  await assert.rejects(createTicket({ ...TICKET, parent: 'ABC-1 OR 1=1' }), /not a Jira key/);
  await assert.rejects(ticketChildren('parent = x'), /not a Jira key/);
  assert.equal(calls.length, 0);
});

test('a refused create says what acli said, not the command it ran', async () => {
  reply = () => Promise.reject(Object.assign(new Error('Command failed: acli jira workitem create ...'), { stdout: '', stderr: '✗ Error: parent ABC-9 is not an epic\nusage...' }));
  await assert.rejects(createTicket(TICKET), { message: '✗ Error: parent ABC-9 is not an epic' });
});

test('a work item acli made without saying its key is told apart from one it refused', async () => {
  reply = answer({ id: '9', self: 'https://example.atlassian.net/rest/api/3/issue/9' });
  await assert.rejects(createTicket(TICKET), { created: true, message: /did not say its key/ });
  reply = () => Promise.reject(Object.assign(new Error('Command failed'), { stdout: '', stderr: '✗ Error: parent ABC-9 is not an epic' }));
  await assert.rejects(createTicket(TICKET), (err: Error & { created?: boolean }) => err.created === undefined);
});

test('the new key is read from acli\'s JSON, or from its text when it prints none', () => {
  assert.equal(createdKey('{"key":"ABC-12","id":"9"}'), 'ABC-12');
  assert.equal(createdKey('✓ Work item ABC-13 created\n'), 'ABC-13');
  assert.equal(createdKey('{"id":"9"} and then ABC-14'), 'ABC-14');
  assert.equal(createdKey('created, somehow'), null);
});

test('the description goes to Jira as a document with the template\'s headings in bold, a list, code and links', () => {
  useJira({ ticketTemplate: TEAM_JIRA.ticketTemplate });
  const doc = descriptionDoc([
    'Problem',
    'The `audit` router is open.',
    'Second line.',
    '',
    '**Fix:**',
    'Gate it.',
    '',
    'Acceptance criteria',
    '- A bearer is refused.',
    '* The engine still reads it.',
    '',
    'Raised in review: https://gitlab.com/acme/engine/-/merge_requests/7#note_42.',
  ].join('\n'));
  const strong = (text: string) => ({ type: 'paragraph', content: [{ type: 'text', text, marks: [{ type: 'strong' }] }] });
  const item = (text: string) => ({ type: 'listItem', content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] });
  const url = 'https://gitlab.com/acme/engine/-/merge_requests/7#note_42';
  assert.deepEqual(doc, {
    type: 'doc',
    version: 1,
    content: [
      strong('Problem'),
      { type: 'paragraph', content: [{ type: 'text', text: 'The ' }, { type: 'text', text: 'audit', marks: [{ type: 'code' }] }, { type: 'text', text: ' router is open.' }, { type: 'hardBreak' }, { type: 'text', text: 'Second line.' }] },
      strong('Fix'),
      { type: 'paragraph', content: [{ type: 'text', text: 'Gate it.' }] },
      strong('Acceptance criteria'),
      { type: 'bulletList', content: [item('A bearer is refused.'), item('The engine still reads it.')] },
      { type: 'paragraph', content: [{ type: 'text', text: 'Raised in review: ' }, { type: 'text', text: url, marks: [{ type: 'link', attrs: { href: url } }] }, { type: 'text', text: '.' }] },
    ],
  });
  assert.equal(flag(createArgs(TICKET), 'description'), JSON.stringify(descriptionDoc(TICKET.description)));
});

test('with a free-text template no line is a heading, and a template of your own makes its own lines bold', () => {
  const plain = descriptionDoc('Problem\nIt breaks.');
  assert.deepEqual(plain.content, [{ type: 'paragraph', content: [{ type: 'text', text: 'Problem' }, { type: 'hardBreak' }, { type: 'text', text: 'It breaks.' }] }]);
  const own = descriptionDoc('Context\nIt breaks.\n\nProblem\nStill text.', ['Context']);
  assert.deepEqual(own.content?.[0], { type: 'paragraph', content: [{ type: 'text', text: 'Context', marks: [{ type: 'strong' }] }] });
  assert.equal(JSON.stringify(own).includes('"text":"Problem","marks"'), false);
});

test('a ticket made with no type of its own takes the one in the settings', () => {
  assert.equal(flag(createArgs({ ...TICKET, type: undefined }), 'type'), 'Task');
  useJira({ issueType: 'Story' });
  assert.equal(flag(createArgs({ ...TICKET, type: undefined }), 'type'), 'Story');
  assert.equal(flag(createArgs(TICKET), 'type'), 'Task', 'a type the caller names wins');
});

test('a view says the ticket\'s transitions when acli fills them in, and null while it leaves them out as it does today', async () => {
  reply = answer({ key: 'ABC-7', transitions: null, fields: { summary: 'S', status: { name: 'Open' } } });
  assert.equal((await viewTicket('ABC-7')).transitions, null);
  reply = answer({ key: 'ABC-7', transitions: [{ to: { name: 'Doing' } }, { to: { name: 'Shipped' } }, { name: 'no target' }], fields: { summary: 'S', status: { name: 'Open' } } });
  assert.deepEqual((await viewTicket('ABC-7')).transitions, ['Doing', 'Shipped']);
});

test('a search for the tickets that link a thread asks for each exact phrase, with quotes taken out', async () => {
  reply = answer([{ key: 'ABC-4368', fields: { summary: 'order-book: audit', status: { name: 'To Do' } } }]);
  const found = await ticketsMentioning(['note_4160779800', 'note_"1" OR x\\']);
  assert.deepEqual(found.map((t) => [t.key, t.status, t.url]), [['ABC-4368', 'To Do', 'https://example.atlassian.net/browse/ABC-4368']]);
  const args = calls[0]?.args ?? [];
  assert.equal(args[args.indexOf('--jql') + 1], '(text ~ "\\"note_4160779800\\"" OR text ~ "\\"note_1 OR x\\"") ORDER BY created DESC');
  calls.length = 0;
  assert.deepEqual(await ticketsMentioning(['', '"']), []);
  assert.equal(calls.length, 0, 'nothing to look for asks Jira nothing');
});

test('viewing a ticket says whether it and its parent are epics', async () => {
  reply = answer({
    key: 'ABC-4368',
    fields: {
      summary: 'order-book: audit',
      status: { name: 'In Progress' },
      issuetype: { name: 'Task', hierarchyLevel: 0 },
      parent: { key: 'ABC-3789', fields: { summary: 'Native access control', issuetype: { name: 'Epic', hierarchyLevel: 1 } } },
    },
  });
  const viewed = await viewTicket('ABC-4368');
  assert.deepEqual([viewed.type, viewed.epic, viewed.parent], ['Task', false, { key: 'ABC-3789', summary: 'Native access control', epic: true }]);
  assert.deepEqual(calls[0]?.args.slice(0, 4), ['jira', 'workitem', 'view', 'ABC-4368']);
  reply = answer({ key: 'ABC-3789', fields: { summary: 'Native access control', issuetype: { name: 'Epic', hierarchyLevel: 1 } } });
  const epic = await viewTicket('ABC-3789');
  assert.deepEqual([epic.epic, epic.parent], [true, null]);
});

test('the description comes back as text, a line per paragraph and a dash per list item', async () => {
  reply = answer({
    key: 'ABC-4368',
    fields: {
      summary: 'x', status: { name: 'QA' },
      description: descriptionDoc('Problem\nIt breaks <b>here</b>.\n\nFix\n- Mend `it`.\n- See https://example.com/a'),
    },
  });
  assert.equal((await viewTicket('ABC-4368')).description, 'Problem\nIt breaks <b>here</b>.\nFix\n- Mend it.\n- See https://example.com/a');
  assert.ok(calls[0]?.args.join(' ').includes('description'), 'the view asks for the description');
  assert.equal(adfText(null), '');
});

test('with no finished statuses named, your open tickets are those outside Jira\'s Done category, and enough are asked for not to cut the list short', async () => {
  await fetchMyTickets();
  const args = calls[0]?.args ?? [];
  assert.equal(args[args.indexOf('--jql') + 1], 'assignee = currentUser() AND statusCategory != Done ORDER BY updated DESC');
  assert.equal(args[args.indexOf('--limit') + 1], '200');
});

test('finished statuses named in the settings are left out by name', async () => {
  useJira({ doneStatuses: TEAM_JIRA.doneStatuses });
  await fetchMyTickets();
  const args = calls[0]?.args ?? [];
  assert.equal(args[args.indexOf('--jql') + 1], 'assignee = currentUser() AND status NOT IN (Done, "Not Required") ORDER BY updated DESC');
  assert.equal(doneClause('Closed, Won\'t "Do", Done'), 'status NOT IN (Closed, "Won\'t \\"Do\\"", Done)');
});

test('a Jira that does not answer is given up on, a search after 90 s and a view after 30, and says so plainly', async () => {
  reply = () => Promise.reject(Object.assign(new Error('Command failed: acli jira workitem'), { killed: true, stdout: '', stderr: '' }));
  await assert.rejects(fetchMyTickets(), { message: 'Jira did not answer acli within 90 s' });
  await assert.rejects(viewTicket('ABC-12'), { message: 'Jira did not answer acli within 30 s' });
  reply = () => Promise.resolve({ stdout: '' });
  await transitionTicket('ABC-12', 'QA');
  assert.deepEqual(calls.map((c) => [c.args[2], c.options['timeout']]), [['search', 90_000], ['view', 30_000], ['transition', 60_000]]);
});

test('a read asked for in the background waits behind one someone is waiting on, whichever came first', async () => {
  useJira({ doneStatuses: TEAM_JIRA.doneStatuses });
  const held: (() => void)[] = [];
  reply = () => new Promise((resolve) => held.push(() => resolve({ stdout: '[]' })));
  const running = [fetchMyTickets(), fetchMyTickets(), fetchMyTickets()];
  const background = [viewTicket('ABC-12', { priority: 'background' }), fetchTicketKeys('project = ABC', { priority: 'background' })];
  const waitedOn = fetchMyTickets();
  assert.equal(calls.length, 3, 'three run and the rest wait');
  while (held.length) {
    held.shift()?.();
    await new Promise(setImmediate);
  }
  await Promise.all([...running, ...background, waitedOn]);
  assert.deepEqual(calls.slice(3).map((c) => (c.args[2] === 'view' ? c.args[3] : c.args[c.args.indexOf('--jql') + 1])), [
    'assignee = currentUser() AND status NOT IN (Done, "Not Required") ORDER BY updated DESC',
    'ABC-12',
    'project = ABC',
  ]);
});

test('a move names the key and status as arguments of their own, and refuses a key that is not one before acli runs', async () => {
  reply = () => Promise.resolve({ stdout: '' });
  await transitionTicket('ABC-12', 'QA');
  assert.deepEqual(calls[0]?.args, ['jira', 'workitem', 'transition', '--key', 'ABC-12', '--status', 'QA', '--yes']);
  calls.length = 0;
  await assert.rejects(transitionTicket('ABC-12,ABC-13', 'QA'), /is not a Jira key/);
  assert.equal(calls.length, 0);
});
