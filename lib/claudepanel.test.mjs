import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, beforeEach, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ran = [];
const hostCalls = [];

// Only the process boundary is stubbed, so the real worker, its guard, the actions and the stdio server run; the stdio server is a real process.
mock.module('node:child_process', {
  namedExports: {
    spawn,
    execFile(cmd, args, options, done) {
      ran.push([cmd, ...args]);
      setImmediate(() => done(Object.assign(new Error(`${cmd} is stubbed`), { code: 1 }), '', ''));
    },
  },
});

const home = await mkdtemp(join(tmpdir(), 'control-centre-claude-panel-'));
process.env.HOME = home;
process.env.GITLAB_TOKEN = 'stub';
await mkdir(join(home, '.config/underlings'), { recursive: true });
const matrixEngine = fileURLToPath(new URL('./fixtures/panel-engine.mjs', import.meta.url));
await writeFile(join(home, '.config/underlings/config.json'), JSON.stringify({ port: 0, orcaUserDataPath: '/orca-profile', matrixEngine }));
const { agent, claude, handleOf, mr, world } = await import('./fixtures/panel-engine.mjs');
world.settings = { workspaceRoot: '/ws-root' };
world.mrs = [mr('acme/engine', 12, { author: 'frank', sha: 'abc1230000' }), mr('acme/web', 40, { author: 'ivan', title: 'Tidy the header' })];
world.rowFlags = { 'acme/engine!12': { mine: true } };

const worker = await import('../worker.mjs');
const logged = [];
await worker.default({ log: (t) => logged.push(t), commands: { register() {} }, host: { call: async (...args) => { hostCalls.push(args); return { delivered: true }; } } });
const pageUrl = new URL(logged.find((t) => t.startsWith('Underlings at ')).slice('Underlings at '.length));
const origin = pageUrl.origin;
const token = pageUrl.searchParams.get('t');
const STATE = join(home, '.local/state/underlings/claude');
const SERVER = fileURLToPath(new URL('./mcpserver.mjs', import.meta.url));
const { TOOLS, toolRule, toolTitles } = await import('./mcptools.mjs');
const { SLACK_READS, SLACK_TOOLS } = await import('./fixtures/slack.mjs');
const { ACTIONS } = await import('./actions.mjs');
const { HANDLED } = await import('./mcpcalls.mjs');
const servers = [];

after(async () => {
  for (const s of servers) s.close();
  await worker.deactivate();
  await rm(home, { recursive: true });
});

beforeEach(async () => {
  world.agents = [];
  world.queue = [];
  Object.assign(claude, { started: [], replies: [], removed: [] });
  hostCalls.length = 0;
  await post('/api/claude/new', {});
});

const post = (path, body, headers = { 'x-cc-token': token, origin }) => fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const state = async () => (await fetch(`${origin}/api/state?t=${token}`)).json();
const readJson = async (name) => JSON.parse(await readFile(join(STATE, name), 'utf8'));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function until(check, what) {
  for (let i = 0; i < 150; i += 1) {
    const value = await check();
    if (value) return value;
    await sleep(20);
  }
  assert.fail(`gave up waiting for ${what}`);
}

function mcpServer() {
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, UNDERLINGS_MCP_ENDPOINT: join(STATE, 'endpoint.json') }, stdio: ['pipe', 'pipe', 'inherit'] });
  const waiting = new Map();
  let id = 0;
  createInterface({ input: child.stdout }).on('line', (line) => {
    const message = JSON.parse(line);
    waiting.get(message.id)?.(message);
  });
  const ask = (method, params) => new Promise((resolve) => {
    id += 1;
    waiting.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
  });
  const server = { ask, call: async (name, args = {}) => (await ask('tools/call', { name, arguments: args })).result, close: () => child.kill() };
  servers.push(server);
  return server;
}

test('a message with no chat open starts the master agent in the workspace root, with the MCP config and the settings it reads again on every resume', async () => {
  const sent = await post('/api/claude/send', { text: 'What needs me today?\nBe brief.', expect: { handle: null, pending: null } });
  assert.equal(sent.status, 200, await sent.clone().text());
  const [spec] = claude.started;
  assert.deepEqual(
    [spec.kind, spec.cwd, spec.prompt, spec.title, spec.args],
    ['master', '/ws-root', 'What needs me today?\nBe brief.', 'What needs me today?', ['--mcp-config', join(STATE, 'mcp.json'), '--settings', join(STATE, 'settings.json')]],
  );
  assert.match(spec.name, /^underlings-\d{12}$/);
  const { claude: panel } = await state();
  assert.equal(panel.current.handle, (await sent.json()).handle);
  assert.deepEqual(await readJson('panel.json'), { current: panel.current.handle });
  assert.deepEqual((await state()).agents, [], 'the panel\'s chat is not one of the agents');
});

test('the settings make every write tool ask and let every read tool run, under the names Claude Code gives them, and every write is one of the page\'s actions', async () => {
  const { permissions } = await readJson('settings.json');
  const writes = TOOLS.filter((t) => t.action);
  assert.deepEqual(permissions.ask.filter((rule) => rule.startsWith('mcp__underlings__')), writes.map((t) => `mcp__underlings__${t.name}`));
  assert.deepEqual(permissions.allow, TOOLS.filter((t) => !t.action).map((t) => toolRule(t.name)));
  assert.equal(permissions.ask.some((rule) => permissions.allow.includes(rule)), false);
  for (const t of writes) assert.ok(ACTIONS[t.action], `${t.name} writes through ${t.action}`);
  assert.deepEqual([...HANDLED.writes].sort(), writes.map((t) => t.name).sort());
  assert.deepEqual([...HANDLED.reads].sort(), TOOLS.filter((t) => !t.action && !t.draft).map((t) => t.name).sort());
  assert.deepEqual(HANDLED.drafts, TOOLS.filter((t) => t.draft).map((t) => t.name));
  assert.deepEqual(HANDLED.drafts, ['propose_reply'], 'a draft kept here runs without asking');
  assert.deepEqual(writes.map((t) => t.name), ['start_review', 'start_fix', 'start_kickoff', 'reply_to_agent', 'queue_finding', 'post_finding', 'post_all_findings', 'discard_finding', 'merge_mr', 'move_ticket']);
});

const GMAIL_CHANGES = [
  'create_draft', 'update_draft', 'trash_message', 'trash_thread', 'untrash_message', 'untrash_thread', 'mark_message_spam', 'mark_thread_spam', 'unmark_message_spam', 'unmark_thread_spam',
  'label_message', 'label_thread', 'unlabel_message', 'unlabel_thread', 'update_message_labels', 'apply_sensitive_message_label', 'apply_sensitive_thread_label',
  'create_label', 'update_label', 'delete_label', 'delete_draft',
].map((name) => `mcp__claude_ai_Gmail__${name}`);
const CALENDAR_CHANGES = ['create_event', 'update_event', 'delete_event', 'respond_to_event'].map((name) => `mcp__claude_ai_Google_Calendar__${name}`);

test('the panel asks before it changes anything in Gmail, the bin, spam, labels and drafts included, whatever mode it runs in, and can never send, reply or forward', async () => {
  const { permissions } = await readJson('settings.json');
  assert.deepEqual(permissions.ask.filter((rule) => rule.startsWith('mcp__claude_ai_Gmail__')).sort(), [...GMAIL_CHANGES].sort());
  assert.deepEqual(permissions.deny, ['mcp__claude_ai_Gmail__send_message', 'mcp__claude_ai_Gmail__reply', 'mcp__claude_ai_Gmail__forward']);
  assert.equal(permissions.allow.some((rule) => rule.includes('Gmail')), false, 'nothing in Gmail runs without asking on the panel\'s say');
  assert.equal(toolTitles()['mcp__claude_ai_Gmail__create_draft'], 'Save a Gmail draft');
});

test('a tool an agent asked for under the server\'s old name is still titled, as its own name is', () => {
  for (const t of TOOLS) assert.deepEqual([toolTitles()[toolRule(t.name)], toolTitles()[`mcp__control-centre__${t.name}`]], [t.title, t.title], t.name);
  assert.equal(toolRule('merge_mr'), 'mcp__underlings__merge_mr');
});

test('the panel asks before it adds, changes, deletes or answers a calendar event, and reads the calendar without asking', async () => {
  const { permissions } = await readJson('settings.json');
  assert.deepEqual(permissions.ask.filter((rule) => rule.includes('Google_Calendar')), CALENDAR_CHANGES);
  assert.equal(permissions.allow.some((rule) => rule.includes('Google_Calendar')), false);
  assert.equal(toolTitles()['mcp__claude_ai_Google_Calendar__respond_to_event'], 'Answer a calendar invitation');
  assert.equal(toolTitles()['mcp__claude_ai_Gmail__trash_thread'], 'Bin a Gmail thread');
});

test('every Slack tool that posts or changes anything asks first, whatever mode the panel runs in, and no Slack tool runs on the panel\'s say alone', async () => {
  const { permissions } = await readJson('settings.json');
  const asks = permissions.ask.filter((rule) => rule.startsWith('mcp__claude_ai_Slack__'));
  assert.deepEqual(SLACK_TOOLS.filter((name) => !SLACK_READS.includes(name)).sort(), [...asks].sort(), 'every tool the connector has is a read or asks');
  for (const name of ['send_message', 'send_message_draft', 'schedule_message', 'add_reaction', 'create_canvas', 'update_canvas', 'create_list', 'add_list_record', 'complete_file_upload', 'create_conversation']) assert.ok(asks.includes(`mcp__claude_ai_Slack__slack_${name}`), name);
  assert.equal(permissions.allow.some((rule) => rule.includes('Slack')), false);
  assert.equal(permissions.deny.some((rule) => rule.includes('Slack')), false, 'you may still say yes to a post');
  assert.equal(toolTitles()['mcp__claude_ai_Slack__slack_send_message'], 'Send a Slack message');
});

test('the MCP config runs the stdio server with this node, and the endpoint it reads is only yours to read', async () => {
  const { mcpServers } = await readJson('mcp.json');
  assert.deepEqual(mcpServers.underlings, { type: 'stdio', command: process.execPath, args: [SERVER], env: { ELECTRON_RUN_AS_NODE: '1', UNDERLINGS_MCP_ENDPOINT: join(STATE, 'endpoint.json') } });
  const endpoint = await readJson('endpoint.json');
  assert.equal(endpoint.url, origin);
  assert.notEqual(endpoint.token, token, 'the tools have a token of their own');
  for (const name of ['endpoint.json', 'mcp.json', 'settings.json']) assert.equal((await stat(join(STATE, name))).mode & 0o777, 0o600, name);
});

test('a follow-up goes to the same chat, and one that would answer an ask the page had not shown is refused', async () => {
  world.agents = [agent(1, { state: 'blocked', alive: true, pending: { id: 'req-9', tool: 'mcp__underlings__merge_mr', summary: 'acme/engine!12', questions: null } })];
  await post('/api/claude/open', { handle: handleOf(1) });
  const stale = await post('/api/claude/send', { text: 'go on', expect: { handle: handleOf(1), pending: null } });
  assert.equal(stale.status, 409);
  assert.match(await stale.text(), /changed since you looked/);
  const ok = await post('/api/claude/send', { text: 'not that one', expect: { handle: handleOf(1), pending: 'req-9' } });
  assert.equal(ok.status, 200);
  assert.deepEqual(claude.replies, [[handleOf(1), { text: 'not that one' }]]);
  assert.equal((await post('/api/claude/send', { text: 'hi', expect: { handle: null, pending: null } })).status, 409, 'nor a chat the page did not know was open');
  assert.equal(claude.started.length, 0);
});

test('New chat keeps the old one in a history of eight to reopen, and forgets only finished chats beyond that', async () => {
  world.agents = Array.from({ length: 11 }, (_, i) => agent(i + 1, { alive: i === 0 }));
  await post('/api/claude/open', { handle: handleOf(11) });
  assert.equal((await state()).claude.current.handle, handleOf(11));
  await post('/api/claude/new', {});
  const { claude: panel } = await state();
  assert.equal(panel.current, null);
  assert.deepEqual(panel.history.map((h) => h.handle), [11, 10, 9, 8, 7, 6, 5, 4].map(handleOf));
  assert.deepEqual(claude.removed, [3, 2].map(handleOf), 'the oldest still running is kept');
  assert.equal((await post('/api/claude/open', { handle: handleOf(9) })).status, 200);
  assert.equal((await state()).claude.current.handle, handleOf(9));
  assert.equal((await post('/api/claude/open', { handle: handleOf(3) })).status, 404);
});

test('the tool token opens the tool route alone, from no page, and the page token does not open it', async () => {
  const { token: tools } = await readJson('endpoint.json');
  const call = { tool: 'needs_me', args: {} };
  assert.equal((await post('/api/mcp/call', call, { 'x-cc-mcp-token': tools })).status, 200);
  assert.equal((await post('/api/mcp/call', call)).status, 403, 'the page token and origin');
  assert.equal((await post('/api/mcp/call', call, { 'x-cc-mcp-token': tools, origin })).status, 403, 'a page sending the tool token');
  assert.equal((await post('/api/mcp/call', call, { 'x-cc-mcp-token': 'guess' })).status, 403);
  assert.equal((await fetch(`${origin}/api/mcp/call?t=${token}`)).status, 403);
  assert.equal((await post('/api/matrix/refresh', {}, { 'x-cc-token': tools, origin })).status, 403, 'the tool token is not the page\'s');
  assert.equal((await fetch(`${origin}/api/state?t=${tools}`)).status, 403);
});

test('the stdio server lists every tool, and a read tool answers through the worker', async () => {
  const server = mcpServer();
  const init = await server.ask('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'test', version: '1' } });
  assert.deepEqual([init.result.protocolVersion, init.result.serverInfo.name, init.result.capabilities], ['2025-06-18', 'underlings', { tools: {} }]);
  const { tools } = (await server.ask('tools/list', {})).result;
  assert.deepEqual(tools.map((t) => t.name), TOOLS.map((t) => t.name));
  assert.deepEqual(tools.filter((t) => t.annotations.readOnlyHint).map((t) => t.name), TOOLS.filter((t) => !t.action && !t.draft).map((t) => t.name));
  await post('/api/matrix/refresh', {});
  const listed = await server.call('list_mrs', { scope: 'mine' });
  assert.equal(listed.isError, undefined, listed.content[0].text);
  const { mrs } = JSON.parse(listed.content[0].text);
  assert.deepEqual(mrs.map((m) => [m.mr, m.sha]), [['acme/engine!12', 'abc1230000']]);
  const missing = await server.call('nonsense', {});
  assert.equal(missing.isError, true);
});

test('the stdio server describes its tools with the name in your profile, read on every list, and says "you" with none', async () => {
  const profileFile = join(home, '.config/underlings/profile.json');
  const server = mcpServer();
  const described = async () => Object.fromEntries((await server.ask('tools/list', {})).result.tools.map((t) => [t.name, t.description]));
  await writeFile(profileFile, JSON.stringify({ user: { name: 'Ada' } }));
  const named = await described();
  assert.match(named.needs_me, /^What needs Ada now, as Ada's Needs you page shows it/);
  assert.match(named.list_tickets, /^Ada's open Jira tickets/);
  assert.match(named.merge_mr, /one of Ada's own MRs/);
  await rm(profileFile);
  const blank = await described();
  assert.match(blank.needs_me, /^What needs you now, as your Needs you page shows it/);
  assert.match(blank.list_tickets, /^Your open Jira tickets/);
  for (const text of [...Object.values(named), ...Object.values(blank)]) assert.doesNotMatch(text, /Frank|Chambers/);
});

test('a write tool goes through the page\'s own action: a finding is queued for you to post, and one on an MR it cannot see is refused', async () => {
  const server = mcpServer();
  await post('/api/matrix/refresh', {});
  const queued = await server.call('queue_finding', { mr: 'acme/web!40', severity: 'MINOR', body: 'The header still flickers on load.' });
  assert.equal(queued.isError, undefined, queued.content[0].text);
  assert.match(queued.content[0].text, /Queued a MINOR finding on acme\/web!40/);
  assert.deepEqual(world.queue.map((q) => [q.projectPath, q.iid, q.severity, q.body, q.createdBy, q.status]), [['acme/web', 40, 'MINOR', 'The header still flickers on load.', 'claude-panel', 'pending']]);
  const refused = await server.call('queue_finding', { mr: 'acme/web!41', severity: 'MINOR', body: 'x' });
  assert.equal(refused.isError, true);
  assert.match(refused.content[0].text, /not in the open list/);
  const discarded = await server.call('discard_finding', { id: world.queue[0].id });
  assert.equal(discarded.isError, undefined, discarded.content[0].text);
  assert.equal(world.queue[0].status, 'discarded');
});

test('reply_to_agent answers another agent with the ask it read, and never the panel\'s own chat', async () => {
  const review = agent(2, { kind: 'review', name: 'review-web-40', state: 'blocked', alive: true, pending: { id: 'req-2', tool: 'Bash', summary: 'git push', questions: null } });
  world.agents = [review, agent(3, { state: 'blocked', alive: true, pending: { id: 'req-3', tool: 'Bash', summary: 'ls', questions: null } })];
  const server = mcpServer();
  const own = await server.call('reply_to_agent', { handle: handleOf(3), pending: 'req-3', allow: true });
  assert.equal(own.isError, true);
  assert.match(own.content[0].text, /not one of the agents list_agents gives/);
  const stale = await server.call('reply_to_agent', { handle: handleOf(2), pending: null, allow: true });
  assert.equal(stale.isError, true, 'it read no ask, so it cannot allow this one');
  const answered = await server.call('reply_to_agent', { handle: handleOf(2), pending: 'req-2', allow: false });
  assert.equal(answered.isError, undefined, answered.content[0].text);
  assert.deepEqual(claude.replies, [[handleOf(2), { allow: false }]]);
});

test('the chat asking while no page has the panel open is a Needs you card and a banner, and with the panel open it is neither', async () => {
  await post('/api/matrix/refresh', {});
  world.agents = [agent(4)];
  await post('/api/claude/open', { handle: handleOf(4) });
  await post('/api/attention/presence', { page: 'page-panel', focused: false, visible: true, panel: true, permission: 'default' });
  world.agents = [agent(4, { state: 'blocked', since: 5000, alive: true, pending: { id: 'req-4', tool: 'mcp__underlings__merge_mr', summary: 'acme/engine!12', questions: null } })];
  await post('/api/matrix/refresh', {});
  await sleep(200);
  assert.deepEqual((await state()).attention.agents.filter((i) => i.kind === 'claude'), [], 'the open panel shows it');
  assert.equal(hostCalls.filter(([m]) => m === 'notifications.show').length, 0);
  await post('/api/attention/presence', { page: 'page-panel', focused: false, visible: true, panel: false, permission: 'default' });
  const card = await until(async () => (await state()).attention.agents.find((i) => i.kind === 'claude'), 'the card');
  assert.deepEqual([card.why, card.tab, card.tier, card.handle], ['asks to merge an MR', 'claude', 'interrupt', handleOf(4)]);
  const [, banner] = await until(() => hostCalls.find(([m]) => m === 'notifications.show'), 'the banner');
  assert.equal(banner.title, 'Claude: asks to merge an MR');
  const { token: tools } = await readJson('endpoint.json');
  const needs = await (await post('/api/mcp/call', { tool: 'needs_me', args: {} }, { 'x-cc-mcp-token': tools })).json();
  assert.deepEqual(JSON.parse(needs.text).agents, [], 'the chat is not told it is waiting on itself');
});

test('the plugin has no window to pop Claude out into, and says so', async () => {
  const res = await post('/api/claude/popout', {});
  assert.equal(res.status, 501);
  assert.deepEqual([(await state()).claude.canPopOut, (await state()).claude.poppedOut], [false, false]);
});
