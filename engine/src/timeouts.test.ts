import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { promisify } from 'node:util';

const dir = mkdtempSync(join(tmpdir(), 'thematrix-timeouts-'));
process.env['UNDERLINGS_STATE_DIR'] = dir;
process.env['GITLAB_TOKEN'] = 'not-a-real-token';

const realExecFile = promisify(childProcess.execFile);
const timeouts: { args: string[]; timeout: number | undefined }[] = [];
let hang = false;
// Orca at its boundary: nothing it is asked runs, except a sleep standing in for a call that never answers.
Object.assign(childProcess, {
  execFile: Object.assign(() => undefined, {
    [promisify.custom]: async (_bin: string, args: string[], options: { timeout?: number }) => {
      timeouts.push({ args, timeout: options.timeout });
      if (hang) return realExecFile('/bin/sleep', ['5'], { ...options, timeout: 50 });
      return { stdout: JSON.stringify({ id: 'x', ok: true, result: { worktrees: [], terminals: [], terminal: { tail: [] } } }) };
    },
  }),
});
syncBuiltinESMExports();

const orca = await import('./data/orca.js');
const gitlab = await import('./data/gitlab.js');

const realFetch = globalThis.fetch;
const realTimeout = AbortSignal.timeout.bind(AbortSignal);
const signalled: number[] = [];
after(() => {
  globalThis.fetch = realFetch;
  AbortSignal.timeout = realTimeout;
  rmSync(dir, { recursive: true, force: true });
});

test('every Orca call has a timeout, longer for the slow ones', async () => {
  await orca.listWorktrees();
  await orca.listAgentTerminals();
  await orca.readTerminal('t1');
  await orca.createWorktree({ repo: 'id:r', name: 'n', agent: 'claude', prompt: 'p' });
  await orca.sendToTerminal({ terminal: 't1', text: 'hi', waitSubmitSeconds: 20 });
  await orca.sendToTerminal({ terminal: 't1', text: 'hi' });
  assert.deepEqual(
    timeouts.map((t) => [t.args.slice(0, 2).join(' '), t.timeout]),
    [
      ['worktree list', 60_000],
      ['terminal list', 60_000],
      ['worktree ps', 60_000],
      ['terminal read', 60_000],
      ['worktree create', 120_000],
      ['terminal send', 45_000],
      ['terminal send', 60_000],
    ],
  );
});

test('an Orca call that never answers is killed and rejects, saying so', async () => {
  hang = true;
  try {
    await assert.rejects(orca.listAgentTerminals(), (err: unknown) => {
      assert.ok(err instanceof orca.OrcaError);
      assert.equal(err.message, 'orca terminal list gave no answer in 60 s');
      return true;
    });
  } finally {
    hang = false;
  }
});

test('every GitLab request carries a 30 s timeout, and one that runs out rejects', async () => {
  // The real timer is unref'd, so a stand-in that keeps the test alive until it fires.
  AbortSignal.timeout = (ms: number) => {
    signalled.push(ms);
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('The operation timed out.', 'TimeoutError')), 20);
    return controller.signal;
  };
  const signals: (AbortSignal | null | undefined)[] = [];
  globalThis.fetch = ((_input: string | URL | Request, init?: RequestInit) => {
    signals.push(init?.signal);
    if (!init?.signal) return Promise.reject(new Error('sent with nothing to stop it'));
    return new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
    });
  }) as typeof fetch;
  const calls: [string, () => Promise<unknown>][] = [
    ['graphql', () => gitlab.fetchOneMr('acme/engine', 621)],
    ['rest', () => gitlab.fetchDiscussions(1001, 621)],
    ['job log', () => gitlab.fetchJobTrace(1001, 5)],
    ['file', () => gitlab.fetchFile(1001, 'src/app.ts', 'head-1')],
  ];
  for (const [name, call] of calls) {
    const before = signals.length;
    const outcome = await call().then(() => 'resolved', (e: unknown) => (e as Error).name);
    assert.ok(signals.length > before && signals.slice(before).every((s) => s instanceof AbortSignal), `${name} sends a signal`);
    if (name !== 'file') assert.equal(outcome, 'TimeoutError', `${name} rejects once it runs out`);
  }
  assert.ok(signalled.length >= calls.length);
  assert.ok(signalled.every((ms) => ms === gitlab.GITLAB_TIMEOUT_MS && ms === 30_000));
});
