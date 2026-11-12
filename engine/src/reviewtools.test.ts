import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { after, beforeEach, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import type { Mr } from './types.js';

const root = realpathSync(mkdtempSync(join(tmpdir(), 'review-tools-')));
const reviewer = fileURLToPath(new URL('./fixtures/claude/fake-reviewer.mjs', import.meta.url));
chmodSync(reviewer, 0o755);
process.env['UNDERLINGS_STATE_DIR'] = join(root, 'state');
process.env['ORCA_WORKSPACE_ROOT'] = root;
process.env['UNDERLINGS_CLAUDE_BIN'] = reviewer;
delete process.env['GITLAB_TOKEN'];
const { answerLine, callReviewTool, REVIEW_TOOLS } = await import('./reviewtools.js');
const { claudeAgents, claudeHost } = await import('./agents/claude.js');
const { launchReview } = await import('./actions/launch.js');
const { loadQueue, saveQueue, updateAutoMemory, loadAutoMemory } = await import('./data/store.js');
const { builtInReview } = await import('./agentprompts.js');

after(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => saveQueue([]));

const MR_URL = 'https://gitlab.com/acme/engine/-/merge_requests/88';
const FINDING = {
  projectPath: 'acme/engine', projectId: 7, iid: 88, webUrl: MR_URL, severity: 'MAJOR', body: 'MAJOR: this retries forever on a 401. Stop on the first one.',
  diffHunk: '+  retry()', position: { base_sha: 'b', start_sha: 's', head_sha: 'h', new_path: 'src/a.ts', new_line: 12 },
};
const text = (said: { content: { text: string }[] }) => said.content[0]?.text ?? '';
const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
async function until<T>(check: () => T, what: string, ms = 15_000): Promise<NonNullable<T>> {
  for (const end = Date.now() + ms; Date.now() < end; await sleep(50)) {
    const value = check();
    if (value) return value as NonNullable<T>;
  }
  assert.fail(`gave up waiting for ${what}`);
}

test('the review server offers two tools, to queue findings and to finish a pass, and nothing that writes to GitLab', () => {
  assert.deepEqual(REVIEW_TOOLS.map((t) => t.name), ['queue_findings', 'finish_review']);
  const listed = answerLine(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })) as { result: { tools: { name: string }[] } };
  assert.deepEqual(listed.result.tools.map((t) => t.name), ['queue_findings', 'finish_review']);
  assert.equal(answerLine(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })), null, 'a notification gets no answer');
  assert.match(text(callReviewTool('post_finding', { id: 'x' })), /There is no tool called post_finding/);
});

test('a queued finding waits in the queue, on its line, marked as the review agent\'s, and is never sent', () => {
  const said = callReviewTool('queue_findings', { findings: [FINDING, { ...FINDING, kind: 'reply', replyTo: 'd1', outcome: 'fixed', severity: undefined, body: 'Fixed in abc.' }] });
  assert.match(text(said), /^Queued 2 for the user to read\. Nothing was posted/);
  const [finding, reply] = loadQueue();
  assert.deepEqual([finding?.status, finding?.severity, finding?.createdBy, finding?.position?.new_line, finding?.diffHunk], ['pending', 'MAJOR', 'review-agent', 12, '+  retry()']);
  assert.deepEqual([reply?.kind, reply?.replyTo, reply?.outcome, reply?.status], ['reply', 'd1', 'fixed', 'pending']);
  assert.ok(!finding?.postedAt && !finding?.discussionId && !finding?.sending, 'nothing was posted or claimed for sending');
});

test('a finding queued for a full-auto pass keeps its tag, and anything that is not a finding or a reply is refused whole', () => {
  callReviewTool('queue_findings', { findings: [{ ...FINDING, createdBy: 'auto:p-1' }] });
  assert.equal(loadQueue()[0]?.createdBy, 'auto:p-1');
  const refused = callReviewTool('queue_findings', { findings: [FINDING, { ...FINDING, kind: 'verdict' }] });
  assert.equal(refused.isError, true);
  assert.match(text(refused), /an agent cannot queue a verdict/);
  assert.equal(loadQueue().length, 1, 'the good one in the same call was not queued either');
  assert.equal(callReviewTool('queue_findings', { findings: [] }).isError, true);
});

test('finishing a pass marks it done, and a pass that does not exist says so', () => {
  updateAutoMemory('acme/engine!88', (m) => ({ ...m, pass: { id: 'p-1', sha: 'h', startedAt: new Date().toISOString() } as never }));
  assert.match(text(callReviewTool('finish_review', { pass: 'p-1' })), /Pass p-1 marked finished/);
  assert.ok(loadAutoMemory()['acme/engine!88']?.pass?.doneAt);
  assert.equal(callReviewTool('finish_review', { pass: 'p-9' }).isError, true);
});

test('the built server answers over stdio and writes the queue the state folder names', async () => {
  const built = fileURLToPath(new URL('../dist/reviewserver.js', import.meta.url));
  const child = spawn(process.execPath, [built], { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = createInterface({ input: child.stdout })[Symbol.asyncIterator]();
  const ask = async (id: number, method: string, params: unknown) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    return JSON.parse((await lines.next()).value as string) as { result: Record<string, unknown> };
  };
  assert.deepEqual((await ask(1, 'initialize', { protocolVersion: '2025-06-18' })).result['serverInfo'], { name: 'underlings', version: '1.0.0' });
  await ask(2, 'tools/call', { name: 'queue_findings', arguments: { findings: [FINDING] } });
  child.stdin.end();
  assert.equal(loadQueue()[0]?.body, FINDING.body);
});

const mr = (): Mr => ({
  projectPath: 'acme/engine', projectId: 7, repoLabel: 'Engine', iid: 88, title: 'Faster engine', webUrl: MR_URL,
  draft: false, conflicts: false, notes: 0, author: 'ivan', reviewers: ['me'], approvedBy: [], pipeline: 'SUCCESS', mergeStatus: null,
  createdAt: '', updatedAt: '', sha: 'h', sourceBranch: 'feat/88', ticket: null, unresolvedThreads: 0,
});

test('a review agent on the built-in prompt queues what it finds through its own tools, and nothing reaches GitLab', async () => {
  const log = join(root, 'reviewer.log');
  process.env['FAKE_CLAUDE_LOG'] = log;
  process.env['FAKE_REVIEW_FINDING'] = JSON.stringify(FINDING);
  const posted: unknown[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (...call: unknown[]) => {
    posted.push(call);
    throw new Error('no network in this test');
  }) as typeof fetch;
  try {
    const { handle = '' } = await launchReview(mr());
    const seen = await until(() => (existsSync(log) ? JSON.parse(readFileSync(log, 'utf8').split('\n')[0] ?? '{}') : null), 'the agent to queue');
    assert.equal(seen.prompt, builtInReview(MR_URL));
    assert.deepEqual([seen.server, seen.tools], ['underlings', ['queue_findings', 'finish_review']]);
    await until(() => claudeAgents().find((a) => a.handle === handle)?.state === 'done', 'the agent to finish its turn');
    const queued = loadQueue();
    assert.deepEqual(queued.map((q) => [q.status, q.severity, q.body, q.createdBy]), [['pending', 'MAJOR', FINDING.body, 'review-agent']]);
    assert.ok(!queued[0]?.postedAt && !queued[0]?.discussionId);
    assert.deepEqual(posted, [], 'nothing was asked of GitLab');
    await claudeHost.removeWorkspace(handle);
  } finally {
    globalThis.fetch = realFetch;
    writeFileSync(log, '');
  }
});
