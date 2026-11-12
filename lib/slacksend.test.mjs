import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { finalMessage, sendSettings } from './slacksend.mjs';

const SEND = 'mcp__claude_ai_Slack__slack_send_message';
const dir = await mkdtemp(join(tmpdir(), 'control-centre-slacksend-'));
after(() => rm(dir, { recursive: true }));
let made = 0;

async function approvedFile(value = { channel_id: 'C0INFRA0001', thread_ts: '1794310740.000000', message: 'Yes, take it.\n\n_Sent with Underlings_' }) {
  made += 1;
  const path = join(dir, `approved-${made}.json`);
  await writeFile(path, typeof value === 'string' ? value : JSON.stringify(value));
  return path;
}

const called = (name, toolInput) => ({ session_id: 's', hook_event_name: 'PreToolUse', tool_name: name, tool_input: toolInput, tool_use_id: 'toolu_01' });

// The command is run through the shell exactly as the settings give it to Claude Code.
async function runHook(path, stdin) {
  const [{ hooks: [{ command }] }] = sendSettings(path).hooks.PreToolUse;
  const child = spawn('/bin/sh', ['-c', command], { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  child.stdin.on('error', () => {});
  if (stdin !== undefined) child.stdin.end(typeof stdin === 'string' ? stdin : JSON.stringify(stdin));
  const started = Date.now();
  const hung = setTimeout(() => child.kill(), 8000);
  const code = await new Promise((resolve) => child.on('exit', resolve));
  clearTimeout(hung);
  return { code, err, took: Date.now() - started, said: out ? JSON.parse(out).hookSpecificOutput : null };
}

test('a send gets exactly the approved channel, thread and message, whatever the model passed, and nothing else it asked for', async () => {
  const path = await approvedFile();
  const ran = await runHook(path, called(SEND, { channel_id: 'C0GENERAL01', message: 'Model words', thread_ts: '1700000000.000100', reply_broadcast: true, draft_id: 'Dr01', unfurl_app_links: true }));
  assert.equal(ran.code, 0, ran.err);
  assert.deepEqual(ran.said, {
    hookEventName: 'PreToolUse', permissionDecision: 'allow',
    updatedInput: { channel_id: 'C0INFRA0001', message: 'Yes, take it.\n\n_Sent with Underlings_', thread_ts: '1794310740.000000', reply_broadcast: false },
  });
  assert.equal((await stat(`${path}.used`)).mode & 0o777, 0o600);
});

test('a reply that is not in a thread is sent with no thread, even when the model names one', async () => {
  const path = await approvedFile({ channel_id: 'D0VICTOR001', message: 'Five minutes?' });
  const ran = await runHook(path, called(SEND, { channel_id: 'D0VICTOR001', message: 'x', thread_ts: '1794310740.000000' }));
  assert.deepEqual(ran.said.updatedInput, { channel_id: 'D0VICTOR001', message: 'Five minutes?', reply_broadcast: false });
});

test('every other tool is blocked with exit 2, Slack\'s reads and Bash included', async () => {
  const path = await approvedFile();
  for (const name of ['mcp__claude_ai_Slack__slack_send_message_draft', 'mcp__claude_ai_Slack__slack_add_reaction', 'mcp__claude_ai_Slack__slack_read_channel', 'mcp__claude_ai_Gmail__send_message', 'Bash']) {
    const ran = await runHook(path, called(name, { channel_id: 'C0INFRA0001', message: 'x' }));
    assert.deepEqual([ran.code, ran.said], [2, null], name);
    assert.match(ran.err, /Only the one approved message may be sent/);
  }
  await assert.rejects(stat(`${path}.used`), { code: 'ENOENT' }, 'a refusal uses nothing up');
});

test('only the first send in a run goes through', async () => {
  const path = await approvedFile();
  assert.equal((await runHook(path, called(SEND, { channel_id: 'C0INFRA0001', message: 'x' }))).code, 0);
  const again = await runHook(path, called(SEND, { channel_id: 'C0INFRA0001', message: 'x' }));
  assert.deepEqual([again.code, again.said], [2, null]);
});

test('an approved file that is missing or broken, bad input, or input that never ends blocks the send rather than let the model\'s through', async () => {
  for (const path of [join(dir, 'missing.json'), await approvedFile('{"channel_id":')]) assert.equal((await runHook(path, called(SEND, { channel_id: 'C1', message: 'x' }))).code, 2);
  for (const input of ['not json', '', JSON.stringify(called(SEND, { message: 'x'.repeat(300 * 1024) }))]) assert.equal((await runHook(await approvedFile(), input)).code, 2);
  const hung = await runHook(await approvedFile(), undefined);
  assert.equal(hung.code, 2);
  assert.ok(hung.took < 6000, `took ${hung.took} ms`);
});

test('the hook runs before every tool, under this node run as node, well inside its own timeout', () => {
  const settings = sendSettings('/tmp/cc slack/approved.json', '/Apps/Underlings');
  const [group] = settings.hooks.PreToolUse;
  assert.equal(group.matcher, '*');
  assert.match(group.hooks[0].command, /^ELECTRON_RUN_AS_NODE=1 '\/Apps\/Underlings' '[^']+slacksendhook\.mjs' '\/tmp\/cc slack\/approved\.json'$/);
  assert.ok(group.hooks[0].timeout >= 10);
});

test('the message sent is the text trimmed and signed as the signing hook signs, or refused when it would not fit', () => {
  const on = { sign: true, signature: 'Sent with Underlings' };
  assert.equal(finalMessage('  Yes.\n', on), 'Yes.\n\n_Sent with Underlings_');
  assert.equal(finalMessage('Yes.\n\n_Sent with Underlings_', on), 'Yes.\n\n_Sent with Underlings_', 'never signed twice');
  assert.equal(finalMessage(' Yes. ', { sign: false, signature: 'x' }), 'Yes.');
  const signed = '\n\n_Sent with Underlings_'.length;
  assert.equal(finalMessage('x'.repeat(5000 - signed), on).length, 5000);
  assert.throws(() => finalMessage('x'.repeat(5000 - signed + 1), on), { status: 400 });
  assert.throws(() => finalMessage('x'.repeat(5001), { sign: false }), { status: 400 });
  for (const empty of ['', '  \n', null, 42]) assert.throws(() => finalMessage(empty, on), { status: 400, message: 'write the reply first' });
});
