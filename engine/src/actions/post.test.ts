import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'thematrix-post-'));
process.env['UNDERLINGS_STATE_DIR'] = dir;
process.env['GITLAB_TOKEN'] = 'not-a-real-token';

const { postOne } = await import('./post.js');
const store = await import('../data/store.js');
const { resetState } = await import('../auto/testkit.js');

const calls: string[] = [];
const bodies: string[] = [];
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  calls.push(`${init?.method ?? 'GET'} ${String(input).replace(/^.*\/api\/v4/, '')}`);
  if (init?.body) bodies.push((JSON.parse(String(init.body)) as { body: string }).body);
  return Response.json({ id: 'n-1' });
}) as typeof fetch;

after(() => {
  globalThis.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  resetState();
  calls.length = 0;
  bodies.length = 0;
});

function reply(outcome: 'fixed' | 'not-fixed' | 'disagree') {
  const [item] = store.addToQueue([
    { projectPath: 'acme/engine', projectId: 1001, iid: 621, webUrl: '', severity: 'MINOR', body: 'The null check is in.', createdBy: 'rereview:head-2', kind: 'reply', replyTo: 'd-7', outcome },
  ]);
  return item!;
}

test('posting a reply marked fixed resolves its thread', async () => {
  assert.equal((await postOne(reply('fixed'))).ok, true);
  assert.deepEqual(calls, ['POST /projects/1001/merge_requests/621/discussions/d-7/notes', 'PUT /projects/1001/merge_requests/621/discussions/d-7?resolved=true']);
});

test('a reply marked not fixed, or disagreeing, leaves its thread open', async () => {
  for (const outcome of ['not-fixed', 'disagree'] as const) {
    calls.length = 0;
    assert.equal((await postOne(reply(outcome))).ok, true);
    assert.deepEqual(calls, ['POST /projects/1001/merge_requests/621/discussions/d-7/notes'], outcome);
  }
});

test('a post ends with the footer saved in Settings', async () => {
  store.changeSettings((s) => ({ ...s, postedFooter: '_Read by me first._' }));
  assert.equal((await postOne(reply('not-fixed'))).ok, true);
  assert.deepEqual(bodies, ['The null check is in.\n\n_Read by me first._']);
});
