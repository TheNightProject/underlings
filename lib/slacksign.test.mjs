import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { checkSignature, DEFAULT_SIGNATURE, signingHooks, signingOf } from './slacksign.mjs';

const SCRIPT = fileURLToPath(new URL('./slacksignhook.mjs', import.meta.url));
const LINE = '_Sent with Underlings_';
const SEND = 'mcp__claude_ai_Slack__slack_send_message';

const called = (toolInput) => ({
  session_id: 'aaaaaaaa-0000-4000-8000-000000000001', transcript_path: '/secret.jsonl', cwd: '/ws-root', permission_mode: 'default',
  hook_event_name: 'PreToolUse', tool_name: SEND, tool_input: toolInput, tool_use_id: 'toolu_01',
});

async function runHook(stdin, argv = [process.execPath, SCRIPT, DEFAULT_SIGNATURE]) {
  const child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'] });
  let out = '';
  let err = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { err += d; });
  child.stdin.on('error', () => {});
  if (stdin !== undefined) child.stdin.end(typeof stdin === 'string' ? stdin : JSON.stringify(stdin));
  const started = Date.now();
  const hung = setTimeout(() => child.kill(), 6000);
  const code = await new Promise((resolve) => child.on('exit', resolve));
  clearTimeout(hung);
  return { code, out, err, took: Date.now() - started, said: out ? JSON.parse(out).hookSpecificOutput : null };
}

async function untouched(stdin, argv) {
  const ran = await runHook(stdin, argv);
  assert.deepEqual([ran.code, ran.out, ran.err], [0, '', ''], JSON.stringify(stdin)?.slice(0, 80));
}

test('the message gets the line in italics after a blank line, every other field is kept, and the permission decision is left to the ask rules', async () => {
  const ran = await runHook(called({ channel_id: 'C0PLATFORM1', message: 'The deploy is done.\n', thread_ts: '1794301200.000100' }));
  assert.equal(ran.code, 0);
  assert.deepEqual(ran.said, { hookEventName: 'PreToolUse', updatedInput: { channel_id: 'C0PLATFORM1', message: `The deploy is done.\n\n${LINE}`, thread_ts: '1794301200.000100' } });
});

test('a message that already ends with the line is left alone, so a retry never signs twice', async () => {
  const first = await runHook(called({ channel_id: 'C0PLATFORM1', message: 'Done.' }));
  await untouched(called(first.said.updatedInput));
  await untouched(called({ channel_id: 'C0PLATFORM1', message: `Done.\n\n${LINE}\n  ` }));
});

test('an empty, blank or missing message, or one that is not text, is left alone', async () => {
  for (const input of [{ channel_id: 'C1', message: '' }, { channel_id: 'C1', message: ' \n\t' }, { channel_id: 'C1' }, { channel_id: 'C1', message: 42 }, null]) await untouched(called(input));
  await untouched({ hook_event_name: 'PreToolUse', tool_name: SEND });
});

test('the line never takes a message past 5000 characters: one it fits is signed to exactly 5000, one longer is left unsigned', async () => {
  const room = 5000 - LINE.length - 2;
  const fits = await runHook(called({ channel_id: 'C1', message: 'x'.repeat(room) }));
  assert.equal(fits.said.updatedInput.message.length, 5000);
  await untouched(called({ channel_id: 'C1', message: 'x'.repeat(room + 1) }));
  await untouched(called({ channel_id: 'C1', message: 'x'.repeat(6000) }));
});

test('bad JSON, no input, or too much of it changes nothing and exits 0', async () => {
  for (const input of ['not json', '', 'null', '{"tool_input":', JSON.stringify(called({ channel_id: 'C1', message: 'Morning', pad: 'x'.repeat(300 * 1024) }))]) await untouched(input);
});

test('with no signature to add, as when signing is off, it changes nothing', async () => {
  await untouched(called({ channel_id: 'C1', message: 'Morning' }), [process.execPath, SCRIPT]);
  await untouched(called({ channel_id: 'C1', message: 'Morning' }), [process.execPath, SCRIPT, '']);
});

test('the command in the settings signs with the words set, quoted safely through the shell Claude Code runs it in', async () => {
  const signature = 'Sent from Frank\'s desk $HOME `id` "here"';
  const [{ hooks: [{ command }] }] = signingHooks({ sign: true, signature }).PreToolUse;
  const ran = await runHook(called({ channel_id: 'C1', message: 'Morning' }), ['/bin/sh', '-c', command]);
  assert.equal(ran.code, 0, ran.err);
  assert.equal(ran.said.updatedInput.message, `Morning\n\n_${signature}_`);
});

test('input that never ends cannot hold Claude Code up: it exits 0 within about two seconds and changes nothing', async () => {
  const ran = await runHook(undefined);
  assert.deepEqual([ran.code, ran.out], [0, '']);
  assert.ok(ran.took < 3500, `took ${ran.took} ms`);
});

test('the hook matches exactly the three tools that post text, runs this node as node, and is not there at all when signing is off', () => {
  assert.deepEqual(signingHooks({ sign: false, signature: DEFAULT_SIGNATURE }), {});
  assert.deepEqual(signingHooks({ sign: true, signature: DEFAULT_SIGNATURE }, '/Apps/Underlings'), {
    PreToolUse: [{
      matcher: 'mcp__claude_ai_Slack__slack_send_message|mcp__claude_ai_Slack__slack_send_message_draft|mcp__claude_ai_Slack__slack_schedule_message',
      hooks: [{ type: 'command', command: `ELECTRON_RUN_AS_NODE=1 '/Apps/Underlings' '${SCRIPT}' 'Sent with Underlings'`, timeout: 5 }],
    }],
  });
});

test('signing is on with the default words until saved otherwise, and words that would break the italics are refused or never used', () => {
  assert.deepEqual(signingOf({}), { sign: true, signature: DEFAULT_SIGNATURE });
  assert.deepEqual(signingOf(null), { sign: true, signature: DEFAULT_SIGNATURE });
  assert.deepEqual(signingOf({ sign: false, signature: 'From Frank' }), { sign: false, signature: 'From Frank' });
  for (const saved of ['under_score', 'two\nlines', ' padded ', 'x'.repeat(81), 7]) assert.equal(signingOf({ signature: saved }).signature, DEFAULT_SIGNATURE, String(saved));
  assert.equal(checkSignature('  Sent   from\nmy desk '), 'Sent from my desk');
  assert.equal(checkSignature(''), DEFAULT_SIGNATURE);
  assert.equal(checkSignature('x'.repeat(80)), 'x'.repeat(80));
  for (const bad of ['under_score', 'bell\u0007', 'x'.repeat(81)]) assert.throws(() => checkSignature(bad), { status: 400 }, bad);
});
