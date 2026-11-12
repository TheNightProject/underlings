import assert from 'node:assert/strict';
import { beforeEach, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { act } from './actions.mjs';
import { loadEngine, refreshInbox } from './engine.mjs';
import { ROUTES } from './pipeline.mjs';
import * as testkit from './testkit.mjs';

const { mr, reset, world } = testkit;
const KEY = 'acme/engine!1121';
const OTHER = 'acme/engine!1200';
const TESTKIT = new URL('./testkit.mjs', import.meta.url);
const gitlab = [];

// The shared stand-in engine plus the three calls this module adds, so an older engine can still be loaded without them.
const withPipeline = mock.module(TESTKIT.href, {
  namedExports: {
    ...testkit,
    async fetchJobTrace(projectId, jobId, lines) {
      gitlab.push(['fetchJobTrace', projectId, jobId, lines]);
      return { lines: [`log of ${jobId}`], total: 1 };
    },
    async retryJob(projectId, jobId) {
      gitlab.push(['retryJob', projectId, jobId]);
      return { id: jobId + 1000, status: 'pending' };
    },
    async retryPipeline(projectId, pipelineId) {
      gitlab.push(['retryPipeline', projectId, pipelineId]);
      return { id: pipelineId, status: 'running' };
    },
  },
});
await loadEngine({ matrixEngine: fileURLToPath(TESTKIT) }, () => {});

function job(id, name, status, extra = {}) {
  return { id, pipelineId: 900, name, status, stage: 'test', duration: 12.5, allowFailure: false, ...extra };
}

beforeEach(async () => {
  reset({
    mrs: [
      mr('acme/engine', 1121, { projectId: 7, sha: 'aaa111', pipeline: 'FAILED' }),
      mr('acme/engine', 1200, { projectId: 7, sha: 'bbb222', pipeline: 'SUCCESS' }),
    ],
  });
  world.jobs.aaa111 = [job(41, 'lint', 'failed'), job(42, 'unit', 'success'), job(43, 'deploy', 'canceled')];
  world.jobs.bbb222 = [job(51, 'lint', 'failed', { pipelineId: 950 })];
  gitlab.length = 0;
  await refreshInbox();
});

const read = (route, params) => ROUTES[`GET /api/matrix/${route}`]({ query: new URLSearchParams(params) });
const lint = (extra = {}) => ({ key: KEY, jobId: 41, expect: { sha: 'aaa111', status: 'failed' }, ...extra });
const retries = () => gitlab.filter(([call]) => call.startsWith('retry'));

test('a failed job is retried with the project and job GitLab gave the worker, not the ones the page sent', async () => {
  const done = await act('retry-job', lint({ projectId: 999, pipelineId: 1 }));
  assert.deepEqual(done, { ok: true, text: `Retrying lint on ${KEY}` });
  assert.deepEqual(retries(), [['retryJob', 7, 41]]);
  await act('retry-job', lint({ jobId: 43, expect: { sha: 'aaa111', status: 'canceled' } }));
  assert.deepEqual(retries().at(-1), ['retryJob', 7, 43]);
});

test('a retry is refused once the MR head has moved, even while the open list still shows the old one', async () => {
  world.mrs[0].sha = 'ccc333';
  world.jobs.ccc333 = world.jobs.aaa111;
  await assert.rejects(act('retry-job', lint()), { status: 409, message: `the head of ${KEY} changed since you looked` });
  await assert.rejects(act('retry-pipeline', { key: KEY, pipelineId: 900, expect: { sha: 'aaa111' } }), { status: 409 });
  assert.deepEqual(retries(), []);
});

test('a passing job is not retried, whether the page saw it pass or saw it fail before someone else retried it', async () => {
  await assert.rejects(act('retry-job', lint({ jobId: 42, expect: { sha: 'aaa111', status: 'success' } })), { status: 409, message: 'unit is success, so there is nothing to retry' });
  world.jobs.aaa111[0].status = 'running';
  await assert.rejects(act('retry-job', lint()), { status: 409, message: 'the status of lint changed since you looked' });
  assert.deepEqual(retries(), []);
});

test('a job from another pipeline is refused, even one that failed', async () => {
  await assert.rejects(act('retry-job', lint({ jobId: 51 })), { status: 409, message: `job 51 is not in the head pipeline of ${KEY} any more` });
  assert.deepEqual(retries(), []);
});

test('a retry needs what the page saw, a real job id and an MR still open', async () => {
  await assert.rejects(act('retry-job', { key: KEY, jobId: 41 }), { status: 400 });
  await assert.rejects(act('retry-job', lint({ jobId: '41' })), { status: 400 });
  await assert.rejects(act('retry-job', lint({ key: 'acme/engine!9' })), { status: 404 });
  world.mrs.push(mr('acme/engine', 1000, { projectId: 7, sha: 'aaa111' }));
  world.queue.push({ id: 'q-old', status: 'pending', kind: 'finding', projectPath: 'acme/engine', projectId: 7, iid: 1000 });
  assert.equal((await read('pipeline', { key: 'acme/engine!1000' })).jobs.length, 3);
  await assert.rejects(act('retry-job', lint({ key: 'acme/engine!1000' })), { status: 404, message: 'acme/engine!1000 is not in the open list any more' });
  assert.deepEqual(retries(), []);
});

test('the pipeline is retried only when it is still the head one and something in it failed', async () => {
  await assert.rejects(act('retry-pipeline', { key: KEY, pipelineId: 950, expect: { sha: 'aaa111' } }), { status: 409, message: `the head pipeline of ${KEY} changed since you looked` });
  world.jobs.bbb222[0].status = 'success';
  await assert.rejects(act('retry-pipeline', { key: OTHER, pipelineId: 950, expect: { sha: 'bbb222' } }), { status: 409, message: `no job in the head pipeline of ${OTHER} has failed or been cancelled` });
  assert.deepEqual(retries(), []);
  const done = await act('retry-pipeline', { key: KEY, pipelineId: 900, expect: { sha: 'aaa111' }, projectId: 999 });
  assert.deepEqual(done, { ok: true, text: `Retrying 2 jobs on ${KEY}` });
  assert.deepEqual(retries(), [['retryPipeline', 7, 900]]);
});

test('a job log is read only for a job in that MR\'s head pipeline', async () => {
  await assert.rejects(read('job-log', { key: KEY, job: '51' }), { status: 404, message: `job 51 is not in the head pipeline of ${KEY}` });
  await assert.rejects(read('job-log', { key: KEY, job: 'lint' }), { status: 400 });
  await assert.rejects(read('job-log', { key: 'acme/engine!9', job: '41' }), { status: 404 });
  assert.deepEqual(gitlab, []);
  const log = await read('job-log', { key: KEY, job: '41' });
  assert.deepEqual([log.name, log.status, log.lines, log.total], ['lint', 'failed', ['log of 41'], 1]);
  assert.deepEqual(gitlab, [['fetchJobTrace', 7, 41, 200]]);
});

test('the jobs are read afresh on every poll, and the open log polled with them reuses that read', async () => {
  const mrReads = () => world.calls.filter(([name]) => name === 'fetchOneMr').length;
  await read('pipeline', { key: OTHER });
  await read('pipeline', { key: OTHER });
  assert.equal(mrReads(), 2);
  await read('job-log', { key: OTHER, job: '51' });
  assert.equal(mrReads(), 2);
});

test('the pipeline tab gets each job with its id, run time and whether it may fail, and the pipeline it belongs to', async () => {
  world.jobs.bbb222[0].allowFailure = true;
  const pipeline = await read('pipeline', { key: OTHER });
  assert.deepEqual([pipeline.sha, pipeline.status, pipeline.pipelineId], ['bbb222', 'SUCCESS', 950]);
  assert.deepEqual(pipeline.jobs, [{ id: 51, name: 'lint', stage: 'test', status: 'failed', duration: 12.5, allowFailure: true }]);
});

test('failed jobs are counted only for MRs whose pipeline failed, once per head, and not when they were allowed to fail', async () => {
  const counts = () => read('failed-jobs', {});
  const jobReads = () => world.calls.filter(([name]) => name === 'fetchPipelineJobs').map(([, , sha]) => sha);
  assert.deepEqual(await counts(), { counts: { [KEY]: 1 } });
  await counts();
  assert.deepEqual(jobReads(), ['aaa111']);
  world.mrs[0].sha = 'ddd444';
  world.jobs.ddd444 = [job(61, 'lint', 'failed'), job(62, 'unit', 'failed'), job(63, 'audit', 'failed', { allowFailure: true })];
  await refreshInbox();
  assert.deepEqual(await counts(), { counts: { [KEY]: 2 } });
  assert.deepEqual(jobReads(), ['aaa111', 'ddd444']);
  await counts();
  assert.deepEqual(jobReads(), ['aaa111', 'ddd444']);
});

test('a failed pipeline run again on the same head is counted afresh once it fails again', async () => {
  const counts = async () => (await read('failed-jobs', {})).counts;
  assert.deepEqual(await counts(), { [KEY]: 1 });
  world.mrs[0].pipeline = 'RUNNING';
  await refreshInbox();
  assert.deepEqual(await counts(), {});
  world.mrs[0].pipeline = 'FAILED';
  world.jobs.aaa111 = [job(44, 'lint', 'failed'), job(45, 'unit', 'failed')];
  await refreshInbox();
  assert.deepEqual(await counts(), { [KEY]: 2 });
});

test('an engine built before job ids and retries answers 501 and touches nothing', async () => {
  withPipeline.restore();
  await loadEngine({ matrixEngine: fileURLToPath(TESTKIT) }, () => {});
  await assert.rejects(act('retry-job', lint()), { status: 501, message: /retryJob/ });
  await assert.rejects(act('retry-pipeline', { key: KEY, pipelineId: 900, expect: { sha: 'aaa111' } }), { status: 501, message: /retryChecks/ });
  await assert.rejects(read('job-log', { key: KEY, job: '41' }), { status: 501, message: /jobLog/ });
  await assert.rejects(read('pipeline', { key: KEY }), { status: 501, message: /jobLog/ });
  assert.deepEqual(world.calls.filter(([name]) => name === 'fetchOneMr'), []);
});
