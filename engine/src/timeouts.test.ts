import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'thematrix-timeouts-'));
process.env['UNDERLINGS_STATE_DIR'] = dir;
process.env['GITLAB_TOKEN'] = 'not-a-real-token';

const gitlab = await import('./data/gitlab.js');

const realFetch = globalThis.fetch;
const realTimeout = AbortSignal.timeout.bind(AbortSignal);
const signalled: number[] = [];
after(() => {
  globalThis.fetch = realFetch;
  AbortSignal.timeout = realTimeout;
  rmSync(dir, { recursive: true, force: true });
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
