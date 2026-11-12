import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { test } from 'node:test';
import { promisify } from 'node:util';

const SEND = ['terminal', 'send', '--terminal', 'term_1', '--text', 'hello', '--enter'];
const BLOCKED = JSON.stringify({
  id: 'local',
  ok: false,
  error: { code: 'agent_prompt_blocked', message: 'agent_prompt_blocked The agent is showing a permission or trust prompt.' },
});

function exitedOne(stdout: string): Error {
  return Object.assign(new Error(`Command failed: orca ${SEND.join(' ')} --json\n`), { code: 1, stdout, stderr: '' });
}

let replies: (() => Promise<{ stdout: string }>)[] = [];
const fakeExecFile = Object.assign(() => undefined, {
  [promisify.custom]: () => (replies.shift() ?? (() => Promise.reject(new Error('no reply queued'))))(),
});
Object.assign(childProcess, { execFile: fakeExecFile });
syncBuiltinESMExports();
const { OrcaError, orcaReply, refusalOutput, sendToTerminal } = await import('./data/orca.js');

test('a refused send keeps Orca\'s reason and code rather than the exit status', async () => {
  replies = [() => Promise.reject(exitedOne(BLOCKED))];
  await assert.rejects(sendToTerminal({ terminal: 'term_1', text: 'hello' }), (err: unknown) => {
    assert.ok(err instanceof OrcaError);
    assert.equal(err.code, 'agent_prompt_blocked');
    assert.match(err.message, /The agent is showing a permission or trust prompt/);
    return true;
  });
});

test('a failure that is not an Orca refusal is passed on as it was', async () => {
  const crashed = exitedOne('Unable to determine Orca.app path');
  replies = [() => Promise.reject(crashed)];
  await assert.rejects(sendToTerminal({ terminal: 'term_1', text: 'hello' }), (err) => err === crashed);
  const spawnFailed = Object.assign(new Error('spawn orca ENOENT'), { code: 'ENOENT' });
  assert.throws(() => refusalOutput(spawnFailed), (err) => err === spawnFailed);
  const succeededButExited = exitedOne(JSON.stringify({ ok: true, result: { send: { accepted: false } } }));
  assert.throws(() => refusalOutput(succeededButExited), (err) => err === succeededButExited);
});

test('a refusal given as a bare string still reads, with no code', () => {
  assert.throws(() => orcaReply(['worktree', 'rm'], JSON.stringify({ ok: false, error: 'not allowed' })), (err: unknown) => {
    assert.ok(err instanceof OrcaError);
    assert.equal(err.code, undefined);
    assert.equal(err.message, 'orca worktree rm failed: not allowed');
    return true;
  });
});

test('a successful reply is its result', async () => {
  replies = [() => Promise.resolve({ stdout: JSON.stringify({ ok: true, result: { send: { accepted: true } } }) })];
  assert.deepEqual(await sendToTerminal({ terminal: 'term_1', text: 'hello' }), { send: { accepted: true } });
});
