import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { after, beforeEach, test } from 'node:test';

process.env['GITLAB_TOKEN'] = 'not-a-real-token';

const { fetchJobTrace, fetchPipelineJobs, plainTrace, retryJob, retryPipeline } = await import('./data/gitlab.js');

const CAPTURED = readFileSync(new URL('./fixtures/job-trace.txt', import.meta.url), 'utf8');
const POD = 'runner-xyzabcdef-project-4242-concurrent-1-a1b2c3d4';

interface Call {
  url: string;
  method: string;
}

const calls: Call[] = [];
let reply: (url: string) => Response = () => new Response('[]');
const realFetch = globalThis.fetch;

globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  calls.push({ url, method: init?.method ?? 'GET' });
  return reply(url);
}) as typeof fetch;

after(() => {
  globalThis.fetch = realFetch;
});
beforeEach(() => {
  calls.length = 0;
});

const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

test('a captured job log reads as GitLab shows it, without colours, section markers or the lines that held only markers', () => {
  assert.deepEqual(plainTrace(CAPTURED), [
    'Running with gitlab-runner 17.11.1 (1a2b3c4d)',
    '  on shared-runner-7d9c6b5f4-x2k4q xYzAbCdEf, system ID: r_Fixture00001',
    'Resolving secrets',
    'Preparing the "kubernetes" executor',
    '"NodeSelector" "cloud.google.com/gke-nodepool" overwritten with "docker-build"',
    '"NodeTolerations" "workload=docker-build" overwritten with "NoSchedule"',
    '"CPULimit" overwritten with "4"',
    'Using Kubernetes namespace: gitlab-runner',
    'Using Kubernetes executor with image registry.gitlab.com/acme/platform/service-template/ci-python-runner:3.12 ...',
    'Using attach strategy to execute scripts...',
    'Preparing environment',
    'Using FF_USE_POD_ACTIVE_DEADLINE_SECONDS, the Pod activeDeadlineSeconds will be set to the job timeout: 1h0m0s...',
    `Waiting for pod gitlab-runner/${POD} to be running, status is Pending`,
    `Waiting for pod gitlab-runner/${POD} to be running, status is Pending`,
    '\tContainersNotReady: "containers with unready status: [build helper]"',
    '\tContainersNotReady: "containers with unready status: [build helper]"',
    `Running on ${POD} via gitlab-runner-7d9c6b5f4-x2k4q...`,
    '',
    'Getting source from Git repository',
    'Fetching changes with git depth set to 20...',
    'Initialized empty Git repository in /builds/acme/platform/relay/.git/',
    'Created fresh repository.',
    'Checking out 8f9ad645 as detached HEAD (ref is refs/merge-requests/1135/head)...',
    '',
    'Skipping Git submodules setup',
    '',
    'Executing "step_script" stage of the job script',
    '$ command -v style-gate >/dev/null || pip install --quiet --extra-index-url "https://gitlab-ci-token:${CI_JOB_TOKEN}@gitlab.com/api/v4/projects/12345679/packages/pypi/simple" style-gate',
    '$ style-gate --profile attribution',
    "1642 finding(s) in 251 file(s), profile 'attribution' [style-gate 0.9.0.post245]",
    "These rules guard what ships and cannot be turned off. To accept one finding, add it under 'allow' in .style-gate.yaml with a reason.",
    'style-gate: 29 path(s) excluded by the ignore list in .style-gate.yaml: /docs/, /adr/, CHANGELOG, /.gitlab/, .gitlab-ci*, .pre-commit*, helmfile*, skaffold*, Makefile, .copier-answers*, renovate.json, cliff.toml, htmlcov/, coverage.xml, .coverage, /deploy/, /.run/, /scripts/, /.archive/, *.min.js, *.min.css, *.js.map, /testing/, migrations/, alembic/, *_pb2.py, *_pb2.pyi, *.generated.*, *.d.ts',
    '',
    'Cleaning up project directory and file based variables',
    '',
    'ERROR: Job failed: command terminated with exit code 1',
  ]);
});

test('a section a job script opens and closes itself shows its header and body, and its closing marker leaves no blank line', () => {
  const raw = '\x1b[0Ksection_start:1793910700:deps[collapsed=true]\r\x1b[0KInstalling dependencies\nresolved 312 packages\n\x1b[0Ksection_end:1793910710:deps\r\x1b[0K\n\nnext step\n';
  assert.deepEqual(plainTrace(raw), ['Installing dependencies', 'resolved 312 packages', '', 'next step']);
});

test('a progress line rewritten after a carriage return keeps only its last version, and Windows line ends are plain ends', () => {
  assert.deepEqual(plainTrace('Downloading  10%\rDownloading 100%\nbuilt\r\n'), ['Downloading 100%', 'built']);
});

test('only the end of a long log is kept, without the line it was cut through, and a whole log says how long it is', async () => {
  reply = () => new Response(`${'x'.repeat(300 * 1024)}\nline 2\nline 3\n`);
  assert.deepEqual(await fetchJobTrace(7, 41, 200), { lines: ['line 2', 'line 3'], total: null });
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url}`), ['GET https://gitlab.com/api/v4/projects/7/jobs/41/trace']);

  reply = () => new Response('one\ntwo\nthree\n');
  assert.deepEqual(await fetchJobTrace(7, 41, 2), { lines: ['two', 'three'], total: 3 });
});

test('a job log GitLab refuses is an error carrying what GitLab said, not an empty log', async () => {
  reply = () => new Response('{"message":"403 Forbidden"}', { status: 403, statusText: 'Forbidden' });
  await assert.rejects(fetchJobTrace(7, 41), { message: 'GitLab 403 Forbidden on /projects/7/jobs/41/trace: {"message":"403 Forbidden"}' });
});

test('pipeline jobs still carry the name, status and stage the TUI reads, now with their ids, run time and whether they may fail', async () => {
  reply = (url) => (url.includes('/pipelines?') ? json([{ id: 900 }]) : json([
    { id: 41, name: 'lint', status: 'failed', stage: 'test', duration: 12.5, allow_failure: true, web_url: 'https://x' },
    { id: 42, name: 'build', status: 'created', stage: 'build', duration: null, allow_failure: false },
  ]));
  const jobs = await fetchPipelineJobs(7, 'abc123');
  assert.deepEqual(jobs.map(({ name, status, stage }) => ({ name, status, stage })), [
    { name: 'lint', status: 'failed', stage: 'test' },
    { name: 'build', status: 'created', stage: 'build' },
  ]);
  assert.deepEqual(jobs.map(({ id, pipelineId, duration, allowFailure }) => [id, pipelineId, duration, allowFailure]), [[41, 900, 12.5, true], [42, 900, null, false]]);
  assert.deepEqual(calls.map((c) => c.url.replace('https://gitlab.com/api/v4', '')), ['/projects/7/pipelines?sha=abc123&per_page=1', '/projects/7/pipelines/900/jobs?per_page=100']);
});

test('a retry is a POST to that one job, or to the pipeline to retry everything that failed in it', async () => {
  reply = () => json({ id: 50, status: 'pending' });
  await retryJob(7, 41);
  await retryPipeline(7, 900);
  assert.deepEqual(calls.map((c) => `${c.method} ${c.url.replace('https://gitlab.com/api/v4', '')}`), [
    'POST /projects/7/jobs/41/retry',
    'POST /projects/7/pipelines/900/retry',
  ]);
});
