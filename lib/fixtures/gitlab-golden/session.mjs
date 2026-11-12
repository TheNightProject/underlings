import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { mock } from 'node:test';
import { pageText } from './pagetext.mjs';

export const START = Date.parse('2026-11-10T10:00:00Z');
const STEP_MS = 5_000;
const CALM_CHECKS = 4;
const CALM_MS = 20;
const WAIT_MS = 15_000;
const ENGINE_FILES = ['state.json', 'queue.json', 'runs.json', 'repos.json', 'auto.json'];
const WORKER_FILES = ['attention.json', 'standup.json', 'qa.json'];
// Settings are other work's to change, and say nothing of what GitLab was asked.
const UNPINNED_STATE = ['settings'];
// Started as the app starts them, less what reaches past GitLab and Jira: self update, Orca, Slack, email, the calendar and Claude Code.
const WORKFLOW = 'To Do, Triaged, Ready for Dev, In Design, In Progress, Blocked, Peer Review, Design QA, QA, Release Ready, Ready to Ship - Staging, Ready to Ship - Live, Done, Not Required';
const STARTED = ['features', 'locale', 'profile', 'autoloop', 'notifier', 'qa', 'stats', 'tidy', 'standup', 'game'];
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/g;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
// A background read still between requests is usually waiting on a file or on the fake acli's answer.
const filesBusy = () => process.getActiveResourcesInfo().some((kind) => kind.startsWith('FSReq') || kind === 'Immediate');

export function seed(root, home, settings = {}) {
  const config = join(home, '.config/underlings');
  const engineState = process.env.UNDERLINGS_STATE_DIR;
  const ws = join(root, 'ws');
  const write = (dir, name, value) => {
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, name), typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  };
  for (const [dir, origin] of [['engine', 'acme/engine'], ['web', 'acme/web']]) write(join(ws, dir, '.git'), 'config', `[remote "origin"]\n\turl = git@gitlab.com:${origin}.git\n`);
  write(config, 'config.json', { port: 0 });
  write(config, 'locale.json', { locale: { timeZone: 'Europe/London', region: 'en-GB', clock: '24' } });
  write(config, 'features.json', { qa: true });
  write(config, 'qa.json', { jql: 'project = ABC AND status = QA' });
  write(config, 'game.json', { on: false });
  write(engineState, 'state.json', {
    watches: {}, seen: {}, verdicts: {},
    settings: { workspaceRoot: ws, jiraSite: 'acme.atlassian.net', pollSeconds: 600, agentPermissions: 'auto', maxAgents: 0, reReviewOnChange: true, jira: { projects: 'ABC', defaultProject: 'ABC', statuses: WORKFLOW, doneStatuses: 'Done', issueType: 'Task' }, ...settings },
  });
  write(engineState, 'queue.json', queued());
  return { config: { port: 0, workspaceRoot: ws } };
}

function queued() {
  const shas = { base_sha: 'base7000', start_sha: 'base7000', head_sha: 'e7a1e7a1' };
  const on7 = { projectPath: 'acme/engine', projectId: 1001, iid: 7, webUrl: 'https://gitlab.com/acme/engine/-/merge_requests/7', createdAt: '2026-11-10T09:00:00.000Z', createdBy: 'review', status: 'pending' };
  const on30 = { ...on7, projectPath: 'acme/web', projectId: 1002, iid: 30, webUrl: 'https://gitlab.com/acme/web/-/merge_requests/30' };
  const hunk = '@@ -10,4 +10,8 @@ export function lookup(id) {\n export function lookup(id) {\n   const key = keyOf(id);';
  return [
    { ...on7, id: 'golden-anchored', severity: 'MAJOR', body: 'The cache never expires, so a revoked token keeps working.', diffHunk: hunk, position: { ...shas, new_path: 'src/token.ts', new_line: 14 } },
    { ...on7, id: 'golden-reanchored', severity: 'MINOR', body: 'keyOf runs twice on every lookup.', diffHunk: hunk, position: { ...shas, new_path: 'src/token.ts', new_line: 11 } },
    { ...on7, id: 'golden-unanchored', severity: 'NIT', body: 'Name this lookupToken.', position: { ...shas, new_path: 'src/token.ts', new_line: 40 } },
    { ...on7, id: 'golden-reply', severity: 'MINOR', kind: 'reply', replyTo: 'd701', outcome: 'fixed', body: 'Thanks, the prefix case is covered now.' },
    { ...on7, id: 'golden-verdict', severity: 'MINOR', kind: 'verdict', verdict: 'approve', body: 'Approve' },
    {
      ...on30, id: 'golden-left', severity: 'MINOR', body: 'Pin the linter to an exact version.',
      diffHunk: '@@ -12,3 +12,3 @@\n   "devDependencies": {\n-    "eslint": "^9.38.0",\n+    "eslint": "^9.39.1",',
      position: { base_sha: 'base3000', start_sha: 'base3000', head_sha: 'w30aw30a', new_path: 'package.json', new_line: 13 },
    },
  ];
}

export async function runSession({ fake, root, config }) {
  const s = await sessionOn(fake, config);
  await startUp(s);
  await drawerReads(s);
  await reviewQueue(s);
  await ownMrs(s);
  await activity(s);
  const page = await pageReads(s);
  await s.stop();
  return { requests: requestRecord(s.steps, fake.requests), state: stateFiles(root), page };
}

async function sessionOn(fake, config) {
  const app = await import('../../app.mjs');
  const worker = await import('../../engine.mjs');
  const { MODULES: mods } = await import('../../actions.mjs');
  const steps = [];
  const route = (method, path, { query = {}, body = {} } = {}) => app.route({ method, path, query: new URLSearchParams(query), body: async () => body, config });

  async function quiet() {
    let seen = fake.count();
    const end = performance.now() + WAIT_MS;
    for (let calm = 0; calm < CALM_CHECKS;) {
      if (performance.now() > end) throw new Error('the session never went quiet');
      await sleep(CALM_MS);
      await Promise.all([mods.standup.settled(), mods.tickets.settled(), mods.game.settled(), mods.qa.settled()].map((p) => Promise.resolve(p).catch(() => {})));
      const now = fake.count();
      calm = now === seen && !worker.loading() && !filesBusy() ? calm + 1 : 0;
      seen = now;
    }
  }

  async function step(name, run) {
    mock.timers.setTime(START + steps.length * STEP_MS);
    fake.mark(name);
    let said;
    try {
      said = outcomeOf(await run());
    } catch (err) {
      said = `refused${err.status ? ` ${err.status}` : ''}: ${err.message}`;
    }
    await quiet();
    steps.push({ step: name, said });
  }

  async function stop() {
    for (const name of STARTED) await mods[name].stop?.();
    mods.ownmr.stop();
    worker.retire();
  }

  return {
    fake, config, worker, mods, steps, step, stop, route, quiet,
    shell: { notify: () => {}, log: () => {}, alert: async () => {}, sign: (text) => `signed-${text.length}` },
    get: (path, query) => route('GET', path, { query }),
    act: (name, body) => route('POST', `/api/matrix/${name}`, { body }),
    sha: (key) => worker.inbox.mrs.find((m) => `${m.projectPath}!${m.iid}` === key)?.sha,
    now: () => START + steps.length * STEP_MS,
  };
}

// GitLab answers nothing until every module is listening, as a real first read is slower than the start.
async function startUp(s) {
  await s.step('start: discover the repos and read the MR list', async () => {
    s.fake.hold();
    await s.worker.loadEngine(s.config, () => {});
    for (const name of STARTED) await s.mods[name].start?.(s.config, s.shell);
    s.fake.release();
    await until(() => s.worker.inbox && !s.worker.loading());
    return `${s.worker.inbox.mrs.length} open MRs in ${s.worker.inbox.repoCount} repos`;
  });
}

async function drawerReads({ step, get }) {
  await step('drawer: read acme/engine!7', () => get('/api/matrix/mr', { key: 'acme/engine!7' }));
  await step('drawer: read src/token.ts on acme/engine!7', () => get('/api/matrix/file', { key: 'acme/engine!7', path: 'src/token.ts' }));
  await step('drawer: read the commented lines of acme/engine!7', () => get('/api/matrix/file', { key: 'acme/engine!7' }));
  await step('drawer: read acme/engine!12', () => get('/api/matrix/mr', { key: 'acme/engine!12' }));
  await step('pipeline: read the jobs of acme/engine!12', () => get('/api/matrix/pipeline', { key: 'acme/engine!12' }));
  await step('pipeline: read the test log of acme/engine!12', () => get('/api/matrix/job-log', { key: 'acme/engine!12', job: '120012' }));
  await step('pipeline: count the failed jobs', () => get('/api/matrix/failed-jobs'));
}

async function reviewQueue({ step, get, act, sha, worker, fake }) {
  const queuedHere = (key) => worker.engine.loadQueue().find((c) => c.status === 'pending' && c.createdBy === 'claude-panel' && `${c.projectPath}!${c.iid}` === key);
  await step('queue: queue a finding on acme/web!30', () => act('queue-finding', { key: 'acme/web!30', severity: 'QUESTION', body: 'Does the new linter run on the generated files?' }));
  await step('queue: post the anchored finding on acme/engine!7', () => act('post', { id: 'golden-anchored' }));
  await step('queue: post the verdict on acme/engine!7', () => act('post', { id: 'golden-verdict' }));
  await step('queue: post all on acme/engine!7', () => act('post-all', { key: 'acme/engine!7' }));
  await step('queue: request changes on acme/engine!7 from its verdict card', () => act('decide', { key: 'acme/engine!7', verdict: 'changes', expect: { sha: sha('acme/engine!7') } }));
  await step('queue: post the finding queued on acme/web!30', () => act('post', { id: queuedHere('acme/web!30')?.id }));
  await step('threads: reply on acme/engine!7', () => act('reply', { key: 'acme/engine!7', discussionId: 'd702', body: 'Agreed, the expiry can come later.', expect: { notes: 2 } }));
  await step('threads: resolve on acme/engine!7', () => act('resolve', { key: 'acme/engine!7', discussionId: 'd702', resolved: true }));
  await step('review: start a review of acme/web!30', () => act('review', { key: 'acme/web!30' }));
  await step('review: hold acme/web!30', () => act('hold', { key: 'acme/web!30', held: true }));
  await step('review: approve acme/web!30, which lifts the hold', () => act('approve', { key: 'acme/web!30', approving: true }));
  await step('push: rupert pushes to acme/web!30, and the list is read again', () => {
    changeMr(fake, 'acme/web', 30, { sha: 'w30bw30b', updatedAt: new Date().toISOString(), pipeline: { id: 2031, status: 'RUNNING' } });
    return act('refresh');
  });
  await step('drawer: read acme/web!30 since your review', () => get('/api/matrix/mr', { key: 'acme/web!30' }));
}

async function ownMrs({ step, get, act, sha, mods, fake }) {
  const head = (key) => ({ sha: sha(key) });
  await step('own: read your MRs', () => get('/api/matrix/own-mrs'));
  await step('own: mark acme/engine!12 ready', () => act('ready', { key: 'acme/engine!12', expect: head('acme/engine!12') }));
  await step('own: retry the test job on acme/engine!12', () => act('retry-job', { key: 'acme/engine!12', jobId: 120012, expect: { ...head('acme/engine!12'), status: 'failed' } }));
  await step('own: retry the pipeline of acme/engine!12', () => act('retry-pipeline', { key: 'acme/engine!12', pipelineId: 7012, expect: head('acme/engine!12') }));
  await step('own: fix the threads on acme/engine!12', () => act('fix', { key: 'acme/engine!12', expect: { ...head('acme/engine!12'), threads: { d1201: 1 } } }));
  await step('own: fix the conflicts on acme/web!22', () => act('fix', { key: 'acme/web!22', conflicts: true, expect: head('acme/web!22') }));
  await step('own: merge acme/web!21 now', () => act('merge', { key: 'acme/web!21', expect: { ...head('acme/web!21'), can: 'now', target: 'main' } }));
  await step('own: rebase acme/tools/cli!3', async () => {
    const said = await act('rebase', { key: 'acme/tools/cli!3', expect: head('acme/tools/cli!3') });
    await until(() => fake.requests.some((r) => r.search.includes('include_rebase_in_progress')) && !mods.ownmr.failedRebases().length && sha('acme/tools/cli!3') !== 'c3a0c3a0');
    return said;
  });
  await step('own: set the reviewers of acme/tools/cli!3', () => act('reviewers', { key: 'acme/tools/cli!3', reviewers: ['ivan', 'trent'], expect: { ...head('acme/tools/cli!3'), reviewers: ['ivan', 'rupert'] } }));
  await step('own: ask ivan again on acme/tools/cli!3', () => act('rerequest', { key: 'acme/tools/cli!3', reviewers: ['ivan'], expect: head('acme/tools/cli!3') }));
  await step('own: merge acme/tools/cli!3 when green', () => act('merge', { key: 'acme/tools/cli!3', expect: { ...head('acme/tools/cli!3'), can: 'green', target: 'main' } }));
  await step('own: cancel the merge of acme/tools/cli!3', () => act('cancel-merge', { key: 'acme/tools/cli!3', expect: head('acme/tools/cli!3') }));
  await step('own: merge acme/tools/cli!3 when green again', () => act('merge', { key: 'acme/tools/cli!3', expect: { ...head('acme/tools/cli!3'), can: 'green', target: 'main' } }));
  await step('end: GitLab merges acme/tools/cli!3, and the list is read again', () => {
    changeMr(fake, 'acme/tools/cli', 3, { state: 'merged', mergedBy: 'frank', mergedAt: new Date().toISOString(), pipeline: { id: 3004, status: 'SUCCESS' } });
    return act('refresh');
  });
}

async function activity({ step, get, route, mods, quiet }) {
  await step('activity: standup', async () => {
    await get('/api/standup');
    await mods.standup.settled();
    return get('/api/standup');
  });
  await step('activity: turn the game on, which reads your work', async () => {
    const said = await route('POST', '/api/game/settings', { body: { on: true } });
    await mods.game.settled();
    return said;
  });
  await step('stats: read', async () => {
    await get('/api/stats');
    await quiet();
    return get('/api/stats');
  });
  await step('QA board: read', async () => {
    await mods.qa.settled();
    return get('/api/qa');
  });
  await step('tickets: read', async () => {
    await get('/api/matrix/tickets');
    await mods.tickets.settled();
    return get('/api/matrix/tickets');
  });
  await step('team board: build', async () => {
    await route('POST', '/api/matrix/board', { body: {} });
    await until(async () => !(await get('/api/matrix/board')).startedAt);
    const { board, error } = await get('/api/matrix/board');
    return error ? `the board failed: ${error}` : `the board scores ${board.scores.length} people over ${board.repos} repos`;
  });
}

async function pageReads(s) {
  let page = null;
  await s.step('page: what the views read', async () => {
    page = await pageText(await s.get('/api/state'), (path, query) => s.get(path, query).catch(() => null), s.now());
  });
  return page;
}

function changeMr(fake, path, iid, change) {
  Object.assign(fake.world.mrs.find((m) => m.path === path && m.iid === iid), change);
}

async function until(check, ms = WAIT_MS) {
  for (const end = performance.now() + ms; performance.now() < end; await sleep(25)) if (await check()) return;
  throw new Error('the session gave up waiting');
}

function outcomeOf(result) {
  if (typeof result === 'string') return result;
  return result?.text ?? 'read';
}

// Each GraphQL text is written out once and named by its operation and a hash of it, so a step reads as a list of calls and a changed query still shows.
function requestRecord(steps, all) {
  const graphql = {};
  const named = (r) => {
    if (typeof r.body?.query !== 'string') return r;
    const name = `${/^\w+ \w+/.exec(r.body.query)?.[0] ?? 'graphql'} #${createHash('sha256').update(r.body.query).digest('hex').slice(0, 8)}`;
    graphql[name] = r.body.query;
    return { ...r, body: { ...r.body, query: name } };
  };
  const shaped = ({ method, path, search, headers, body, unanswered }) => named({ call: `${method} ${path}${search}`, headers, body, ...(unanswered ? { unanswered } : {}) });
  const sorted = (list) => list.map((r) => [JSON.stringify(r), r]).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([, r]) => r);
  const record = steps.map(({ step, said }) => ({ step, said, requests: sorted(all.filter((r) => r.step === step).map(shaped)) }));
  return { steps: record, graphql: Object.fromEntries(Object.entries(graphql).sort(([a], [b]) => a.localeCompare(b))) };
}

function stateFiles(root) {
  const engineDir = process.env.UNDERLINGS_STATE_DIR;
  const workerDir = join(process.env.HOME, '.local/state/underlings');
  const read = (dir, name) => (existsSync(join(dir, name)) ? JSON.parse(readFileSync(join(dir, name), 'utf8')) : null);
  const files = Object.fromEntries([...ENGINE_FILES.map((name) => [`engine/${name}`, read(engineDir, name)]), ...WORKER_FILES.map((name) => [name, read(workerDir, name)])]);
  for (const key of UNPINNED_STATE) delete files['engine/state.json']?.[key];
  return normalised(files, root);
}

// One request to a line, so a baseline diff names the request that changed.
export function asText(value) {
  const lines = [];
  const placed = JSON.stringify(value, (key, v) => {
    if (key !== 'requests' || !Array.isArray(v)) return v;
    return v.map((r) => `@@line-${lines.push(JSON.stringify(r)) - 1}@@`);
  }, 2);
  return `${placed.replace(/"@@line-(\d+)@@"/g, (_, n) => lines[Number(n)])}\n`;
}

export function normalised(value, root) {
  let text = JSON.stringify(value);
  for (const r of new Set([root, realpathSync(root)])) text = text.split(r).join('<root>');
  const ids = new Map();
  text = text.replace(UUID, (id) => {
    if (!ids.has(id)) ids.set(id, `<uuid-${ids.size + 1}>`);
    return ids.get(id);
  });
  return JSON.parse(text);
}
