import assert from 'node:assert/strict';
import { after, beforeEach, test } from 'node:test';
import { githubHarness } from './fixtures/github/harness.mjs';
import { BOARD_COLUMNS, githubWorld, issueList, roadmap } from './fixtures/github/world.mjs';

const h = githubHarness();
process.env['GITHUB_TOKEN'] = 'ghp_0123456789abcdefghijklmnopqrstuv';

const { changeSettings } = await import('./data/store.js');
const { resetGithubLimits, forgetGithubToken } = await import('./data/github.js');
const { forgetBoard, issueBody } = await import('./data/github-issues.js');
const engine = await import('./engine.js');
const { ticketSource } = await import('./ticketsource.js');
const { projectRefOf } = await import('./settings.js');
const { updateSettings } = await import('./settingsedit.js');

type Settings = { jiraSite?: string; github?: Record<string, unknown>; tickets?: Record<string, unknown>; jira?: Record<string, unknown> };
const use = ({ jiraSite = 'example.atlassian.net', github = {}, tickets = {}, jira = {} }: Settings = {}) => changeSettings((s) => ({
  ...s,
  jiraSite,
  github: { ...s.github, on: true, scope: 'involved', repos: '', host: '', ...github },
  tickets: { ...s.tickets, source: 'github', githubProject: 'acme-co/3', ...tickets },
  jira: { ...s.jira, doneStatuses: '', ...jira },
} as never));

after(() => h.done());
beforeEach(() => {
  Object.assign(h.world, githubWorld({ issues: issueList(), projects: [roadmap()] }));
  h.fake.requests.length = 0;
  resetGithubLimits();
  forgetGithubToken();
  forgetBoard();
  use();
});

const keys = (tickets: { key: string }[]) => tickets.map((t) => t.key).sort();
const itemStatus = (issue: string) => h.world.projects[0].items.find((it: { issue: string }) => it.issue === issue)?.status;
const issueOf = (key: string) => h.world.issues.find((i: { repo: string; number: number }) => `${i.repo}#${i.number}` === key);

test('Jira stays the source unless another is chosen, GitHub Issues only while GitHub is on, and Off is neither', () => {
  use({ tickets: { source: 'jira' } });
  assert.equal(ticketSource()?.id, 'jira');
  use({ tickets: { source: 'jira' }, jiraSite: '' });
  assert.equal(ticketSource(), null, 'Jira with no site is off, as before');
  use();
  assert.equal(ticketSource()?.id, 'github');
  use({ github: { on: false } });
  assert.equal(ticketSource(), null, 'GitHub switched off reads nothing, whatever is chosen');
  use({ tickets: { source: 'off' } });
  assert.equal(ticketSource(), null);
});

test('with tickets off, a read says why and asks GitHub nothing', async () => {
  use({ github: { on: false } });
  await assert.rejects(engine.fetchMyTickets(), /GitHub Issues, and GitHub is off: switch it on in Setup/);
  use({ tickets: { source: 'off' } });
  await assert.rejects(engine.viewTicket('acme-co/web#9'), /Tickets are off under Ticket settings/);
  assert.equal(h.fake.requests.length, 0);
});

test('your tickets are the open issues assigned to you or written by you, keyed owner/repo#12, less those the Project calls finished', async () => {
  const mine = await engine.fetchMyTickets();
  assert.deepEqual(keys(mine), ['acme-co/engine#4', 'acme-co/web#9', 'octo/api#30']);
  const search = h.fake.asked('MyIssues')[0]!.body.variables as Record<string, string>;
  assert.deepEqual(search, { assigned: 'is:issue is:open archived:false sort:updated-desc assignee:@me', authored: 'is:issue is:open archived:false sort:updated-desc author:@me' });
  const web9 = mine.find((t) => t.key === 'acme-co/web#9')!;
  assert.deepEqual([web9.summary, web9.status, web9.url, web9.labels, web9.prs], ['Token lookups are slow', 'In Progress', 'https://github.com/acme-co/web/issues/9', ['perf'], ['acme-co/web#12']]);
  assert.equal(mine.find((t) => t.key === 'acme-co/engine#4')?.status, 'No Status', 'on the Project with no Status set');
  assert.equal(mine.find((t) => t.key === 'octo/api#30')?.status, 'Open', 'not on the Project, so open or closed');
});

test('GitHub repos narrows your tickets as it narrows pull requests, and a named finished status leaves those out', async () => {
  use({ github: { repos: 'acme-co' } });
  assert.deepEqual(keys(await engine.fetchMyTickets()), ['acme-co/engine#4', 'acme-co/web#9']);
  forgetBoard();
  use({ jira: { doneStatuses: 'In Progress' } });
  assert.deepEqual(keys(await engine.fetchMyTickets()), ['acme-co/engine#4', 'octo/api#30', 'octo/web#8']);
});

test('with no Project named, every open issue of yours is Open, and no Project is asked for', async () => {
  use({ tickets: { githubProject: '' } });
  const mine = await engine.fetchMyTickets();
  assert.deepEqual(mine.map((t) => t.status), ['Open', 'Open', 'Open', 'Open']);
  assert.equal(h.fake.asked('ProjectBoard').length, 0);
  assert.deepEqual(await engine.ticketColumns(), ['Open', 'Closed']);
});

test('the board columns are the Project\'s Status options in order, read once for a few minutes', async () => {
  assert.deepEqual(await engine.ticketColumns(), BOARD_COLUMNS);
  await engine.fetchMyTickets();
  assert.equal(h.fake.asked('ProjectBoard').length, 1);
  assert.deepEqual(h.fake.asked('ProjectBoard')[0]!.body.variables, { owner: 'acme-co', number: 3 });
});

test('a Project owned by a user is found too, and one that is missing or has no single-select Status says so', async () => {
  h.world.projects = [roadmap({ owner: 'frank-gh', ownerType: 'user', number: 5 })];
  use({ tickets: { githubProject: 'https://github.com/users/frank-gh/projects/5/views/1' } });
  assert.deepEqual(await engine.ticketColumns(), BOARD_COLUMNS);
  forgetBoard();
  use({ tickets: { githubProject: 'acme-co/4' } });
  await assert.rejects(engine.ticketColumns(), /GitHub has no Project acme-co\/4 that this token can read/);
  forgetBoard();
  h.world.projects = [roadmap({ field: { type: 'ProjectV2Field', id: 'PVTF_text' } })];
  use();
  await assert.rejects(engine.ticketColumns(), /the Project Roadmap has no single-select field named Status/);
});

test('a ticket read in full has its parent issue, its description and the Project\'s columns as its moves', async () => {
  const view = await engine.viewTicket('acme-co/web#9');
  assert.deepEqual(view.parent, { key: 'acme-co/web#1', summary: 'Make the web app fast', epic: true });
  assert.equal(view.description, 'Every request reads the token again.');
  assert.deepEqual(view.transitions, BOARD_COLUMNS);
  const off = await engine.viewTicket('octo/api#30');
  assert.deepEqual([off.status, off.transitions, off.parent], ['Open', ['Open', 'Closed'], null]);
  await assert.rejects(engine.viewTicket('acme-co/web#404'), /GitHub has no issue acme-co\/web#404/);
  await assert.rejects(engine.viewTicket('ABC-12'), /ABC-12 is not a GitHub issue/);
});

test('a move on the Project sets the item\'s Status with one mutation, and a column the Project lacks is refused', async () => {
  await engine.transitionTicket('acme-co/web#9', 'In Review');
  const [move] = h.fake.asked('MoveItem');
  assert.deepEqual(move!.body.variables, { project: 'PVT_roadmap', item: 'PVTI_9', field: 'PVTSSF_status', option: 'opt_2' });
  assert.equal(itemStatus('acme-co/web#9'), 'In Review');
  await assert.rejects(engine.transitionTicket('acme-co/web#9', 'QA'), /the Project Roadmap has no QA column/);
  assert.equal(h.fake.asked('MoveItem').length, 1);
});

test('off the Project an issue moves only between Open and Closed, by closing or reopening it', async () => {
  await engine.transitionTicket('octo/api#30', 'Closed');
  const patch = h.fake.requests.find((r) => r.method === 'PATCH');
  assert.deepEqual([patch?.path, patch?.body], ['/repos/octo/api/issues/30', { state: 'closed' }]);
  assert.equal(issueOf('octo/api#30').state, 'CLOSED');
  await engine.transitionTicket('octo/api#30', 'Open');
  assert.equal(issueOf('octo/api#30').state, 'OPEN');
  await assert.rejects(engine.transitionTicket('octo/api#30', 'In Progress'), /octo\/api#30 is not on the Project Roadmap, so it only moves between Open and Closed/);
});

test('a new ticket is an issue in its parent\'s repo, assigned to you, under the parent and on the Project', async () => {
  const made = await engine.createTicket({ project: 'acme-co/web', summary: 'Expire cached tokens', description: 'Problem\nThey never expire.\n- one\n- two', parent: 'acme-co/web#9', assignee: '@me' });
  assert.deepEqual([made.key, made.url, made.status], ['acme-co/web#22', 'https://github.com/acme-co/web/issues/22', 'Open']);
  const post = h.fake.requests.find((r) => r.method === 'POST' && r.path === '/repos/acme-co/web/issues');
  assert.deepEqual(post?.body, { title: 'Expire cached tokens', body: 'Problem\nThey never expire.\n- one\n- two', assignees: ['frank-gh'] });
  assert.equal(issueOf('acme-co/web#22').parent, 'acme-co/web#9');
  assert.equal(h.world.projects[0].items.at(-1).issue, 'acme-co/web#22');
});

test('with no parent a ticket goes in the repo it names, and anything else is refused before GitHub is asked', async () => {
  const made = await engine.createTicket({ project: 'octo/api', summary: 'Pin the client', description: 'Pin it.', assignee: '@me' });
  assert.equal(made.key, 'octo/api#31');
  h.fake.requests.length = 0;
  await assert.rejects(engine.createTicket({ project: 'ABC', summary: 'x', description: 'y' }), /ABC is not a GitHub repo/);
  assert.equal(h.fake.requests.length, 0);
});

test('the template\'s headings become Markdown headings in the issue', () => {
  assert.equal(issueBody('Problem\nIt is slow.\n**Fix:**\nCache it.', ['Problem', 'Fix']), '### Problem\nIt is slow.\n### Fix\nCache it.');
});

test('tickets named by key are read in one query, and Jira keys among them are left alone', async () => {
  const found = await engine.fetchTickets(['acme-co/web#9', 'octo/api#30', 'ABC-12', 'acme-co/web#404']);
  assert.deepEqual([...found.keys()].sort(), ['acme-co/web#9', 'octo/api#30']);
  assert.equal(h.fake.asked('Issues').length, 1);
});

test('a ticket linking a thread is found by the note ids in its body', async () => {
  issueOf('octo/api#30').body = 'Raised from https://gitlab.example.com/acme/web/-/merge_requests/3#note_77';
  const found = await engine.ticketsMentioning(['note_76', 'note_77']);
  assert.deepEqual(keys(found), ['octo/api#30']);
  assert.equal((h.fake.asked('IssueSearch')[0]!.body.variables as { query: string }).query, 'is:issue in:body "note_76" OR "note_77"');
});

test('a parent\'s sub-issues are its children', async () => {
  assert.deepEqual(keys(await engine.ticketChildren('acme-co/web#1')), ['acme-co/web#9']);
});

test('standup hears of issues of yours closed that day, as Closed or a finished status, and of in progress from the Project', async () => {
  const { ticketsMovedTo, ticketsInProgress } = await import('./ticketsource.js');
  assert.deepEqual(keys(await ticketsMovedTo('Closed', '2026-11-09')), ['acme-co/web#20']);
  assert.deepEqual(keys(await ticketsMovedTo('Done', '2026-11-09')), ['acme-co/web#20']);
  h.fake.requests.length = 0;
  assert.deepEqual(await ticketsMovedTo('QA', '2026-11-09'), []);
  assert.equal(h.fake.requests.length, 0, 'GitHub has no history of other statuses to ask');
  assert.deepEqual(keys(await ticketsInProgress()), ['acme-co/web#9']);
  use({ tickets: { githubProject: '' } });
  await assert.rejects(ticketsInProgress(), /Tickets in progress come from the Status of a GitHub Project/);
});

test('a Project is named by its link or as owner/number, and anything else is refused', () => {
  assert.deepEqual(projectRefOf('https://github.com/orgs/acme-co/projects/3/views/2'), { owner: 'acme-co', number: 3 });
  assert.deepEqual(projectRefOf('acme-co/3'), { owner: 'acme-co', number: 3 });
  assert.equal(projectRefOf('acme-co'), null);
  assert.deepEqual(updateSettings({ 'tickets.githubProject': 'https://github.com/users/frank-gh/projects/5' }).settings.tickets.githubProject, 'frank-gh/5');
  assert.deepEqual(updateSettings({ 'tickets.githubProject': 'not a project' }).dropped, ['tickets.githubProject']);
  assert.deepEqual(updateSettings({ 'tickets.source': 'github' }).settings.tickets.source, 'github');
  assert.deepEqual(updateSettings({ 'tickets.source': 'linear' }).dropped, ['tickets.source']);
});
