import { BAD_KEY, failure, forgeCan, forgeFor, inbox, MR_KEY, mrFor, mrOrQueued, requireEngine, still } from './engine.mjs';
import { keyOf, keyParts } from './refs.mjs';

const LOG_LINES = 200;
const READ_MS = 4_000;
const COUNT_PARALLEL = 4;
const RETRYABLE = new Set(['failed', 'canceled']);
const READS = ['one', 'checks', 'jobLog'];
const reads = new Map();
const failedCounts = new Map();
let counting = null;

export const ROUTES = {
  'GET /api/matrix/pipeline': ({ query }) => readPipeline(query.get('key')),
  'GET /api/matrix/job-log': ({ query }) => readJobLog(query.get('key'), query.get('job')),
  'GET /api/matrix/failed-jobs': () => readFailedCounts(),
};

export const ACTIONS = {
  'retry-job': { verify: verifyJobRetry, run: retryJob },
  'retry-pipeline': { verify: verifyPipelineRetry, run: retryPipeline },
};

export async function readPipeline(key) {
  const { mr, jobs } = await headFor(key, { fresh: true });
  return {
    key,
    sha: mr.sha ?? null,
    status: mr.pipeline ?? null,
    pipelineId: jobs[0]?.pipelineId ?? null,
    fetchedAt: new Date().toISOString(),
    jobs: jobs.map(({ id, name, stage, status, duration, allowFailure, logs, webUrl }) => ({ id, name, stage, status, duration: duration ?? null, allowFailure: Boolean(allowFailure), ...(logs === false ? { logs, webUrl: webUrl ?? null } : {}) })),
  };
}

export async function readJobLog(key, jobParam) {
  const forge = pipelineForge(key, ...READS);
  forgeCan(forge, 'jobLogs', 'show a job log');
  const jobId = Number(jobParam);
  if (!Number.isSafeInteger(jobId) || jobId <= 0) throw failure(400, 'job must be a job id');
  const { mr, jobs } = await headFor(key);
  const job = jobs.find((j) => j.id === jobId);
  if (!job) throw failure(404, `job ${jobId} is not in the head pipeline of ${key}`);
  if (job.logs === false) throw failure(400, `${job.name} is not a GitHub Actions job, so its log is only on the page it links to`);
  const trace = await forge.jobLog(mr, job.id, LOG_LINES);
  return { key, jobId: job.id, name: job.name, status: job.status, lines: trace.lines, total: trace.total, fetchedAt: new Date().toISOString() };
}

// The drawer polls the jobs and then each open log, so a log reuses the jobs read a moment before.
function headFor(key, { fresh = false } = {}) {
  const forge = pipelineForge(key, ...READS);
  const known = mrOrQueued(key);
  const hit = reads.get(key);
  if (!fresh && hit && Date.now() - hit.at < READ_MS) return hit.read;
  for (const [seen, { at }] of reads) if (Date.now() - at >= READ_MS) reads.delete(seen);
  const read = liveHead(forge, key, known);
  reads.set(key, { at: Date.now(), read });
  read.catch(() => reads.get(key)?.read === read && reads.delete(key));
  return read;
}

function pipelineForge(key, ...methods) {
  if (typeof key !== 'string' || !MR_KEY.test(key)) throw failure(400, BAD_KEY);
  return forgeFor(keyParts(key), ...methods);
}

async function liveHead(forge, key, known) {
  const mr = await forge.one(known);
  if (!mr) throw failure(404, `${forge.name} has no ${key}`);
  const jobs = mr.sha ? await forge.checks(mr, mr.sha) : [];
  return { mr, jobs };
}

async function writableHead(key, expect, retry) {
  const forge = pipelineForge(key, 'one', 'checks', retry);
  forgeCan(forge, 'retry', 'retry a job');
  const head = await liveHead(forge, key, mrFor(key));
  still(expect?.sha, head.mr.sha, `the head of ${key}`);
  return head;
}

async function verifyJobRetry({ key, jobId, expect }) {
  if (!Number.isSafeInteger(jobId)) throw failure(400, 'jobId must be a job id');
  const { mr, jobs } = await writableHead(key, expect, 'retryJob');
  const job = jobs.find((j) => j.id === jobId);
  if (!job) throw failure(409, `job ${jobId} is not in the head pipeline of ${key} any more`);
  still(expect.status, job.status, `the status of ${job.name}`);
  if (!RETRYABLE.has(job.status)) throw failure(409, `${job.name} is ${job.status}, so there is nothing to retry`);
  return { mr, job };
}

async function retryJob({ key }, { mr, job }) {
  await forgeFor(mr, 'retryJob').retryJob(mr, job.id);
  forget(key);
  return `Retrying ${job.name} on ${key}`;
}

async function verifyPipelineRetry({ key, pipelineId, expect }) {
  if (!Number.isSafeInteger(pipelineId)) throw failure(400, 'pipelineId must be a pipeline id');
  const { mr, jobs } = await writableHead(key, expect, 'retryChecks');
  const head = jobs[0]?.pipelineId ?? null;
  if (head !== pipelineId) throw failure(409, `the head pipeline of ${key} changed since you looked`);
  const stopped = jobs.filter((j) => RETRYABLE.has(j.status));
  if (!stopped.length) throw failure(409, `no job in the head pipeline of ${key} has failed or been cancelled`);
  return { mr, pipelineId: head, count: stopped.length };
}

async function retryPipeline({ key }, { mr, pipelineId, count }) {
  await forgeFor(mr, 'retryChecks').retryChecks(mr, pipelineId);
  forget(key);
  return `Retrying ${count === 1 ? '1 job' : `${count} jobs`} on ${key}`;
}

function forget(key) {
  reads.delete(key);
  failedCounts.delete(key);
}

// A failed head is counted once, and again only after the list has seen its pipeline run again, so a refresh reads only what changed.
async function readFailedCounts() {
  requireEngine('forgeOf');
  if (!inbox) return { counts: {} };
  counting ??= countFailures(inbox.mrs).finally(() => { counting = null; });
  return { counts: await counting };
}

async function countFailures(mrs) {
  const failing = mrs.filter((mr) => mr.pipeline === 'FAILED' && mr.sha);
  const keys = new Set(failing.map(keyOf));
  for (const key of failedCounts.keys()) if (!keys.has(key)) failedCounts.delete(key);
  const due = failing.filter((mr) => failedCounts.get(keyOf(mr))?.sha !== mr.sha);
  await eachAtMost(COUNT_PARALLEL, due, async (mr) => {
    const jobs = await forgeFor(mr, 'checks').checks(mr, mr.sha);
    failedCounts.set(keyOf(mr), { sha: mr.sha, failed: jobs.filter((j) => j.status === 'failed' && !j.allowFailure).length });
  });
  return Object.fromEntries([...failedCounts].map(([key, seen]) => [key, seen.failed]));
}

async function eachAtMost(limit, items, fn) {
  const waiting = [...items];
  const worker = async () => {
    while (waiting.length) await fn(waiting.shift()).catch(() => {});
  };
  await Promise.all(Array.from({ length: Math.min(limit, waiting.length) }, worker));
}
