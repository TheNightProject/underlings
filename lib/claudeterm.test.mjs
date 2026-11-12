import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmod, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { terminalWorld, until } from './fixtures/terminal-world.mjs';

const w = await terminalWorld();
const { HOOKED, launchSpec, onPath } = await import('./claudeterm.mjs');
const { permissionRules } = await import('./mcptools.mjs');
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SECRET = '/Users/frank/.claude/projects/ws/secret-transcript.jsonl';

after(() => w.close());

beforeEach(async () => {
  w.app.opened.length = 0;
  w.app.restarted.length = 0;
  w.app.pasted.length = 0;
  w.app.banners.length = 0;
  for (const fn of w.app.typed) fn();
  await until(async () => !(await w.state()).claudeCode.asking, 'the last test\'s card to clear');
});

const open = async () => {
  const res = await w.post('/api/claude/terminal/open', {});
  assert.equal(res.status, 200, await res.clone().text());
  return w.app.opened.at(-1);
};

async function runHook(input, endpoint = join(w.STATE, 'hook-endpoint.json')) {
  const child = spawn(process.execPath, [w.hookScript, endpoint], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.stdin.end(typeof input === 'string' ? input : JSON.stringify(input));
  const started = Date.now();
  const code = await new Promise((resolve) => child.on('exit', resolve));
  return { code, out, took: Date.now() - started };
}

const notification = (message, extra = {}) => ({ hook_event_name: 'Notification', session_id: 'aaaaaaaa-0000-4000-8000-000000000001', transcript_path: SECRET, cwd: '/ws-root', notification_type: 'permission_prompt', message, ...extra });
const terminalCard = async () => (await w.state()).attention.agents.find((i) => i.kind === 'claude-code');

async function primeNotifier() {
  await w.post('/api/matrix/refresh', {});
  await until(async () => (await stat(join(w.home, '.local/state/underlings/attention.json')).catch(() => null)), 'the first Needs you build');
}

test('the launch arguments: plain claude unless an account is set, through cswap when it is on the PATH, saying so when it is not, and a new session id or a resume', () => {
  const files = { mcp: '/state/mcp.json', settings: '/state/terminal-settings.json' };
  const id = '11111111-2222-4333-8444-555555555555';
  const tail = ['--mcp-config', '/state/mcp.json', '--settings', '/state/terminal-settings.json'];
  assert.deepEqual(launchSpec({ id, resumable: false, account: '', cswap: '/bin/cswap', claude: '/bin/claude', ...files }), { file: '/bin/claude', args: [...tail, '--session-id', id], notice: null });
  assert.deepEqual(launchSpec({ id, resumable: true, account: '', cswap: null, claude: '/bin/claude', ...files }), { file: '/bin/claude', args: [...tail, '--resume', id], notice: null });
  assert.deepEqual(launchSpec({ id, resumable: true, account: '2', cswap: '/bin/cswap', claude: '/bin/claude', ...files }), { file: '/bin/cswap', args: ['run', '2', '--', ...tail, '--resume', id], notice: null });
  assert.deepEqual(launchSpec({ id, resumable: false, account: '2', cswap: null, claude: '/bin/claude', ...files }), { file: '/bin/claude', args: [...tail, '--session-id', id], notice: 'cswap is not on your PATH, so this is plain claude rather than account 2.' });
});

test('the launch arguments carry the model and effort the session started on, before the session, through cswap too, and none for Claude Code\'s default', () => {
  const files = { mcp: '/state/mcp.json', settings: '/state/terminal-settings.json' };
  const id = '11111111-2222-4333-8444-555555555555';
  const tail = ['--mcp-config', '/state/mcp.json', '--settings', '/state/terminal-settings.json'];
  assert.deepEqual(launchSpec({ id, resumable: false, account: '', cswap: null, claude: '/bin/claude', model: 'sonnet', effort: 'high', ...files }).args, [...tail, '--model', 'sonnet', '--effort', 'high', '--session-id', id]);
  assert.deepEqual(launchSpec({ id, resumable: true, account: '2', cswap: '/bin/cswap', claude: '/bin/claude', model: 'claude-opus-5-5', ...files }).args, ['run', '2', '--', ...tail, '--model', 'claude-opus-5-5', '--resume', id]);
  assert.deepEqual(launchSpec({ id, resumable: true, account: '', cswap: null, claude: '/bin/claude', model: 'default', effort: 'default', ...files }).args, [...tail, '--resume', id]);
  assert.deepEqual(launchSpec({ id, resumable: true, account: '', cswap: null, claude: '/bin/claude', model: 'sonnet', plugin: '/app/plugin/underlings', ...files }).args, [...tail, '--model', 'sonnet', '--plugin-dir', '/app/plugin/underlings', '--resume', id], 'the skills load beside the model, ahead of the session');
});

test('a new session starts on the Claude panel\'s model and effort with its subagents on the builders\', and keeps them when it is opened again after Models changes', async () => {
  const before = w.world.settings;
  w.world.settings = { ...before, models: { panel: { model: 'sonnet', effort: 'high' }, builders: { model: 'haiku', effort: 'default', force: true } } };
  try {
    assert.equal((await w.post('/api/claude/terminal/new', {})).status, 200);
    const fresh = w.app.restarted.at(-1);
    const id = fresh.args.at(-1);
    assert.deepEqual(fresh.args.slice(-8), ['--model', 'sonnet', '--effort', 'high', '--plugin-dir', '/app/plugin/underlings', '--session-id', id]);
    assert.equal(fresh.env.CLAUDE_CODE_SUBAGENT_MODEL, 'haiku');
    assert.equal(fresh.env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE, '1');
    assert.deepEqual(await w.readJson('terminal.json'), { id, resumable: false, account: '', model: 'sonnet', effort: 'high', subagentModel: 'haiku', subagentForce: true });
    w.world.settings = { ...before, models: { panel: { model: 'opus', effort: 'low' } } };
    const again = await open();
    assert.deepEqual(again.args.slice(-8), ['--model', 'sonnet', '--effort', 'high', '--plugin-dir', '/app/plugin/underlings', '--session-id', id], 'the session it started keeps its model');
    assert.equal(again.env.CLAUDE_CODE_SUBAGENT_MODEL, 'haiku');
    assert.equal(again.env.CLAUDE_CODE_SUBAGENT_MODEL_FORCE, '1', 'its builders stay forced');
    w.world.settings = before;
    assert.equal((await w.post('/api/claude/terminal/new', {})).status, 200);
    const plain = w.app.restarted.at(-1);
    assert.ok(!plain.args.includes('--model') && !plain.args.includes('--effort'), 'Claude Code\'s default passes neither');
    assert.equal('CLAUDE_CODE_SUBAGENT_MODEL' in plain.env, false);
    assert.equal('CLAUDE_CODE_SUBAGENT_MODEL_FORCE' in plain.env, false);
  } finally {
    w.world.settings = before;
  }
});

test('the panel\'s subagents are forced only with the switch on and a builders model, and a session opened again keeps what it started with', async () => {
  const before = w.world.settings;
  const cases = [
    ['on', { model: 'haiku', effort: 'default', force: true }, { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku', CLAUDE_CODE_SUBAGENT_MODEL_FORCE: '1' }],
    ['off', { model: 'haiku', effort: 'default' }, { CLAUDE_CODE_SUBAGENT_MODEL: 'haiku' }],
    ['no builders model', { model: 'default', effort: 'default', force: true }, {}],
  ];
  const vars = (env) => Object.fromEntries(Object.entries(env).filter(([name]) => name.startsWith('CLAUDE_CODE_SUBAGENT_MODEL')));
  try {
    for (const [name, builders, expected] of cases) {
      w.world.settings = { ...before, models: { builders } };
      assert.equal((await w.post('/api/claude/terminal/new', {})).status, 200);
      assert.deepEqual(vars(w.app.restarted.at(-1).env), expected, `${name}: a new session`);
      w.world.settings = { ...before, models: { builders: { model: 'opus', effort: 'default', force: !builders.force } } };
      assert.deepEqual(vars((await open()).env), expected, `${name}: opened again after Models changed`);
    }
  } finally {
    w.world.settings = before;
  }
});

test('cswap is found on the PATH it will run with, and only as an executable', async () => {
  const fake = join(w.bin, 'cswap');
  await writeFile(fake, '#!/bin/sh\n');
  await chmod(fake, 0o644);
  assert.equal(await onPath('cswap', `/nowhere:${w.bin}`), null, 'not executable');
  await chmod(fake, 0o755);
  assert.equal(await onPath('cswap', `/nowhere:${w.bin}`), fake);
  assert.equal(await onPath('cswap', '/nowhere'), null);
});

test('the first open starts the agents\' claude in the workspace root with the tool server, the settings and a new session id, in the agents\' environment and a terminal of its own', async () => {
  const { agent, handleOf } = await import('./fixtures/panel-engine.mjs');
  w.world.agents = [agent(3)];
  assert.equal((await w.post('/api/claude/open', { handle: handleOf(3) })).status, 200);
  const spec = await open();
  const { id } = await w.readJson('terminal.json');
  assert.match(id, UUID);
  assert.notEqual(id, handleOf(3).slice('claude:'.length), 'a chat with nothing on disk to resume is not carried over');
  w.world.agents = [];
  assert.deepEqual([spec.file, spec.cwd, spec.notice], [process.env.UNDERLINGS_CLAUDE_BIN, '/ws-root', null]);
  assert.deepEqual(spec.args, ['--mcp-config', join(w.STATE, 'mcp.json'), '--settings', join(w.STATE, 'terminal-settings.json'), '--plugin-dir', '/app/plugin/underlings', '--session-id', id]);
  assert.equal(spec.env.CHILD_ENV_MARK, 'agents', 'the environment is the one the engine scrubs for its agents');
  assert.equal(spec.env.ORCA_TERMINAL_HANDLE, undefined);
  assert.equal(spec.env.TERM_PROGRAM, undefined, 'it is not in the terminal the app was started from');
  assert.deepEqual([spec.env.TERM, spec.env.COLORTERM], ['xterm-256color', 'truecolor']);
  const { mcpServers } = await w.readJson('mcp.json');
  assert.ok(mcpServers.underlings, 'the same tool server the panel uses');
});

test('the session is resumed only once a hook shows it has a turn in it, and New session starts a fresh one', async () => {
  const first = (await open()).args.at(-1);
  assert.equal((await open()).args.at(-2), '--session-id', 'nothing said in it yet, so there is nothing to resume');
  await runHook({ hook_event_name: 'UserPromptSubmit', session_id: '99999999-0000-4000-8000-000000000009', prompt: 'hi' });
  assert.equal((await open()).args.at(-2), '--session-id', 'another session\'s turn does not count');
  assert.equal((await runHook({ hook_event_name: 'UserPromptSubmit', session_id: first, prompt: 'hi' })).code, 0);
  assert.deepEqual((await open()).args.slice(-2), ['--resume', first]);
  const res = await w.post('/api/claude/terminal/new', {});
  assert.equal(res.status, 200, await res.clone().text());
  const fresh = w.app.restarted.at(-1).args;
  assert.equal(fresh.at(-2), '--session-id');
  assert.notEqual(fresh.at(-1), first);
  assert.deepEqual((await open()).args.slice(-2), ['--session-id', fresh.at(-1)], 'the next open carries on with the new one');
});

test('in the app a message for the panel, such as a draft from Email, goes into Claude Code\'s prompt to send, and never starts or wakes the headless runner', async () => {
  const { claude } = await import('./fixtures/panel-engine.mjs');
  const sent = await w.post('/api/claude/send', { text: 'Read this thread\nand draft a reply', expect: { handle: null, pending: null } });
  assert.equal(sent.status, 200, await sent.clone().text());
  assert.match((await sent.json()).text, /in Claude Code's prompt: read it and press Enter to send/);
  assert.deepEqual(w.app.pasted, ['Read this thread\nand draft a reply']);
  assert.equal(w.app.opened.length, 1, 'Claude Code is started or brought forward first');
  assert.deepEqual([claude.started, claude.replies], [[], []]);
  await open();
  await primeNotifier();
  await runHook(notification('Claude needs your permission to use Bash'));
  await until(terminalCard, 'the card');
  const refused = await w.post('/api/claude/send', { text: 'go on', expect: { handle: null, pending: null } });
  assert.equal(refused.status, 409, 'a draft never lands while Claude Code waits on an answer');
  assert.deepEqual(w.app.pasted, ['Read this thread\nand draft a reply']);
});

test('the settings file asks before every write and Gmail draft, never sends mail, and runs one hook script for Notification, Stop and UserPromptSubmit', async () => {
  await open();
  const settings = await w.readJson('terminal-settings.json');
  assert.deepEqual(settings.permissions, permissionRules());
  assert.ok(settings.permissions.ask.includes('mcp__underlings__merge_mr'));
  assert.ok(settings.permissions.ask.includes('mcp__claude_ai_Gmail__create_draft'));
  assert.deepEqual(settings.permissions.deny, ['mcp__claude_ai_Gmail__send_message', 'mcp__claude_ai_Gmail__reply', 'mcp__claude_ai_Gmail__forward']);
  assert.deepEqual(Object.keys(settings.hooks), ['Notification', 'Stop', 'UserPromptSubmit', 'PreToolUse']);
  const endpoint = join(w.STATE, 'hook-endpoint.json');
  for (const event of HOOKED) {
    assert.deepEqual(settings.hooks[event], [{ hooks: [{ type: 'command', command: `ELECTRON_RUN_AS_NODE=1 '${process.execPath}' '${w.hookScript}' '${endpoint}'`, timeout: 5 }] }], event);
  }
  const hooks = await w.readJson('hook-endpoint.json');
  const tools = await w.readJson('endpoint.json');
  assert.equal(hooks.url, w.origin);
  assert.ok(hooks.token && hooks.token !== w.token && hooks.token !== tools.token, 'the hook token is its own');
  for (const name of ['terminal-settings.json', 'hook-endpoint.json', 'terminal.json']) assert.equal((await stat(join(w.STATE, name))).mode & 0o777, 0o600, name);
  const panel = await w.readJson('settings.json');
  assert.deepEqual(Object.keys(panel.hooks), ['PreToolUse'], 'the panel\'s chat raises no banners of its own');
});

test('both sessions sign Slack posts through one PreToolUse hook while signing is on, with the words set, have none once it is off, and ask the same either way', async () => {
  const both = async () => {
    await open();
    return [await w.readJson('terminal-settings.json'), await w.readJson('settings.json')];
  };
  const signer = (words) => [{
    matcher: 'mcp__claude_ai_Slack__slack_send_message|mcp__claude_ai_Slack__slack_send_message_draft|mcp__claude_ai_Slack__slack_schedule_message',
    hooks: [{ type: 'command', command: `ELECTRON_RUN_AS_NODE=1 '${process.execPath}' '${w.signScript}' '${words}'`, timeout: 5 }],
  }];
  try {
    const on = await both();
    for (const s of on) assert.deepEqual(s.hooks.PreToolUse, signer('Sent with Underlings'));
    assert.equal((await w.post('/api/slack/settings', { sign: false })).status, 200);
    const [terminal, panel] = await both();
    assert.deepEqual(Object.keys(terminal.hooks), HOOKED, 'the terminal keeps its banner hooks');
    assert.deepEqual(panel.hooks, {});
    assert.equal((await w.post('/api/slack/settings', { sign: true, signature: 'From Frank\'s desk' })).status, 200);
    const words = await both();
    for (const s of words) assert.deepEqual(s.hooks.PreToolUse, signer('From Frank\'\\\'\'s desk'));
    for (const s of [...on, terminal, panel, ...words]) assert.deepEqual(s.permissions, permissionRules());
  } finally {
    await rm(join(w.home, '.config/underlings/slack.json'), { force: true });
  }
});

test('the hook token opens the hook route alone, from no page, and the page and tool tokens do not open it', async () => {
  await open();
  const { token: hooks } = await w.readJson('hook-endpoint.json');
  const { token: tools } = await w.readJson('endpoint.json');
  const body = { event: 'Stop', session: null };
  assert.equal((await w.post('/api/hook/claude', body, { 'x-cc-hook-token': hooks })).status, 200);
  assert.equal((await w.post('/api/hook/claude', body)).status, 403, 'the page token and origin');
  assert.equal((await w.post('/api/hook/claude', body, { 'x-cc-hook-token': hooks, origin: w.origin })).status, 403, 'a page sending the hook token');
  assert.equal((await w.post('/api/hook/claude', body, { 'x-cc-mcp-token': tools })).status, 403);
  assert.equal((await w.post('/api/hook/claude', body, { 'x-cc-hook-token': 'guess' })).status, 403);
  assert.equal((await fetch(`${w.origin}/api/hook/claude?t=${w.token}`)).status, 403);
  assert.equal((await w.post('/api/hook/claude', { event: 'PreToolUse' }, { 'x-cc-hook-token': hooks })).status, 400);
  assert.equal((await w.post('/api/claude/terminal/open', {}, { 'x-cc-token': hooks, origin: w.origin })).status, 403, 'the hook token is not the page\'s');
  assert.equal((await fetch(`${w.origin}/api/state?t=${hooks}`)).status, 403);
});

test('a Notification raises a banner and a Needs you card in Claude\'s own words and nothing else, and a click on either opens the terminal', async () => {
  await open();
  await primeNotifier();
  const message = 'Claude needs your permission to use Underlings - Merge an MR';
  const ran = await runHook(notification(message));
  assert.deepEqual([ran.code, ran.out], [0, ''], 'it says nothing, which UserPromptSubmit would add to the prompt');
  const card = await until(terminalCard, 'the card');
  assert.deepEqual([card.title, card.why, card.tab, card.tier], ['Claude needs you', message, 'claude-code', 'interrupt']);
  const [banner] = await until(() => w.app.banners.length && w.app.banners, 'the banner');
  assert.deepEqual([banner.title, banner.body], ['Claude needs you', message]);
  const everything = JSON.stringify(await w.state());
  for (const kept of [SECRET, 'permission_prompt', 'aaaaaaaa-0000-4000-8000-000000000001']) assert.equal(everything.includes(kept), false, `${kept} is not kept`);
  assert.equal((await w.state()).claudeCode.asking, true);
  const { token: tools } = await w.readJson('endpoint.json');
  const needs = await (await w.post('/api/mcp/call', { tool: 'needs_me', args: {} }, { 'x-cc-mcp-token': tools })).json();
  assert.deepEqual(JSON.parse(needs.text).agents, [], 'Claude Code is not told it is waiting on itself');
  await banner.open();
  assert.equal(w.app.opened.length, 2, 'the banner opens the terminal');
  const summoned = await w.post('/api/summon', { target: card.tab });
  assert.equal(summoned.status, 200, 'a toast or the card names a target the page and worker accept');
});

test('the card clears when Frank next types in the terminal, and on a Stop or UserPromptSubmit hook', async () => {
  await open();
  await primeNotifier();
  for (const clear of [() => [...w.app.typed].forEach((fn) => fn()), () => runHook({ hook_event_name: 'Stop', session_id: 'x' }), () => runHook({ hook_event_name: 'UserPromptSubmit', session_id: 'x', prompt: 'go on' })]) {
    await runHook(notification('Claude is waiting for your input'));
    await until(terminalCard, 'the card');
    await clear();
    await until(async () => !(await terminalCard()), 'the card to clear');
  }
  assert.equal(w.app.typed.size, 1, 'one listener, which a reload hands over');
});

test('the hook script exits 0, quickly and silently, when the worker is not there or its input is not JSON', async () => {
  const gone = join(w.home, 'gone-endpoint.json');
  await writeFile(gone, JSON.stringify({ url: 'http://127.0.0.1:9', token: 'x' }));
  for (const [input, endpoint] of [[notification('hello'), gone], ['not json', join(w.STATE, 'hook-endpoint.json')], [notification('hello'), join(w.home, 'missing.json')]]) {
    const ran = await runHook(input, endpoint);
    assert.deepEqual([ran.code, ran.out], [0, '']);
    assert.ok(ran.took < 3000, `took ${ran.took} ms`);
  }
});

test('the page reaches xterm.js through the worker by name only, with its token', async () => {
  const res = await fetch(`${w.origin}/vendor/xterm.js?t=${w.token}`);
  assert.deepEqual([res.status, res.headers.get('content-type')], [200, 'text/javascript; charset=utf-8']);
  assert.match(await res.text(), /globalThis\.Terminal/);
  assert.equal((await fetch(`${w.origin}/vendor/xterm.js`)).status, 403);
  assert.equal((await fetch(`${w.origin}/vendor/..%2Fconfig.json?t=${w.token}`)).status, 404);
  assert.equal((await fetch(`${w.origin}/vendor/addon-fit.js?t=${w.token}`)).status, 404, 'only what the app named');
});
