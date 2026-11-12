import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';

const dir = mkdtempSync(join(tmpdir(), 'thematrix-post-'));
process.env['UNDERLINGS_STATE_DIR'] = dir;
process.env['GITLAB_TOKEN'] = 'not-a-real-token';

const { postAllFor, postOne } = await import('../actions/post.js');
const { addToQueue, loadQueue } = await import('../data/store.js');
const { ATTRIBUTION, AUTO_FOOTER } = await import('../config.js');
const { autoLogRows } = await import('./log.js');
const { resetState } = await import('./testkit.js');

interface Sent {
  url: string;
  method: string;
  body: Record<string, unknown>;
}

const sent: Sent[] = [];
const realFetch = globalThis.fetch;

// GitLab at its boundary: every request is recorded and answered here, none leaves.
globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  sent.push({ url, method: init?.method ?? 'GET', body: init?.body ? JSON.parse(String(init.body)) : {} });
  const payload = url.includes('/diffs') ? [] : url.includes('graphql') ? { data: { h: { errors: [], mergeRequest: null } } } : { id: 'd-new' };
  return new Response(JSON.stringify(payload), { status: 200, headers: { 'content-type': 'application/json' } });
}) as typeof fetch;

after(() => {
  globalThis.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => {
  resetState();
  sent.length = 0;
});

const base = { projectPath: 'acme/engine', projectId: 1001, iid: 621, webUrl: '', createdBy: 'auto:p1' };
const mark = { pass: 'p1', level: 'comments' as const, sendAt: '2026-11-03T10:00:00Z' };

function posted(path: string): Sent | undefined {
  return sent.find((s) => s.method === 'POST' && s.url.includes(path));
}

test('an automatic send does not claim you read it, and carries no footer by default', async () => {
  const [item] = addToQueue([{ ...base, severity: 'MAJOR', body: 'off by one', auto: mark }]);
  await postOne(item!, { automatic: true, footer: false });
  const body = String(posted('/discussions')?.body['body']);
  assert.equal(body, '**MAJOR** off by one');
  assert.ok(!body.includes(ATTRIBUTION), 'the read-it-first trailer would be false');
  assert.equal(loadQueue()[0]?.auto?.sentAuto, true, 'and it is marked as sent without you');
});

test('with the footer on, an automatic send says so', async () => {
  const [item] = addToQueue([{ ...base, severity: 'MAJOR', body: 'off by one', auto: mark }]);
  await postOne(item!, { automatic: true, footer: true });
  assert.ok(String(posted('/discussions')?.body['body']).endsWith(`\n\n${AUTO_FOOTER}`));
});

test('the same item posted by you keeps the usual trailer', async () => {
  const [item] = addToQueue([{ ...base, severity: 'MAJOR', body: 'off by one', auto: mark }]);
  await postOne(item!);
  assert.ok(String(posted('/discussions')?.body['body']).endsWith(ATTRIBUTION));
  assert.equal(loadQueue()[0]?.auto?.sentAuto, undefined, 'and is not in the auto log');
});

test('a reply goes on its own thread, not as a new one', async () => {
  const [item] = addToQueue([{ ...base, severity: 'MINOR', kind: 'reply', replyTo: 'd1', outcome: 'fixed', body: 'Fixed, thanks.', auto: mark }]);
  const outcome = await postOne(item!, { automatic: true });
  assert.equal(outcome.ok, true);
  assert.ok(posted('/discussions/d1/notes'), 'answered on d1');
  assert.equal(posted('/discussions/d1/notes')?.body['body'], 'Fixed, thanks.');
  assert.equal(loadQueue()[0]?.status, 'posted');
});

test('an approval verdict approves, and is listed in the auto log', async () => {
  const [item] = addToQueue([{ ...base, severity: 'MINOR', kind: 'verdict', verdict: 'approve', body: 'Approve', auto: mark }]);
  await postOne(item!, { automatic: true });
  assert.ok(posted('/merge_requests/621/approve'));
  assert.deepEqual(autoLogRows(loadQueue()).map((r) => [r.what, r.key, r.mr]), [['approved', 'acme/engine!621', 'engine!621']]);
});

test('posting everything never sends a verdict along with it', async () => {
  addToQueue([
    { ...base, severity: 'MINOR', body: 'a finding' },
    { ...base, severity: 'MINOR', kind: 'verdict', verdict: 'approve', body: 'Approve', auto: mark },
  ]);
  const results = await postAllFor('acme/engine', 621);
  assert.equal(results.length, 1);
  assert.ok(!posted('/approve'));
  assert.equal(loadQueue().find((c) => c.kind === 'verdict')?.status, 'pending');
});
