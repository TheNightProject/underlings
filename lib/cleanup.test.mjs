import assert from 'node:assert/strict';
import { mkdir, mkdtemp, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';
import { pathToFileURL } from 'node:url';

const HOUR = 36e5;
const GIT = '/usr/bin/git';
const root = await realpath(await mkdtemp(join(tmpdir(), 'control-centre-cleanup-')));
const config = { workspaceRoot: root };
let world = freshWorld();
const commands = [];

function freshWorld() {
  return {
    worktrees: [],
    agents: [],
    git: {},
    refusals: {},
    removedAgents: [],
    removedWorktrees: [],
    repos: [{ label: 'Engine', path: 'acme/platform/relay' }, { label: 'Engine API', path: 'acme/platform/gateway' }],
    inbox: { mrs: [] },
    queue: [],
    runs: {},
  };
}

// Only the process boundary is stubbed, so the real git wrapper and review engine bridge run.
mock.module('node:child_process', {
  namedExports: {
    execFile(cmd, args, options, done) {
      commands.push([cmd, ...args]);
      const { out = '', code = 0, message } = cmd === GIT ? gitReply(args) : { code: 127 };
      const err = code ? Object.assign(new Error(message ?? `Command failed: ${cmd} ${args.join(' ')}\n`), { code }) : null;
      setImmediate(() => done(err, out, ''));
    },
  },
});

function gitReply([, path, ...rest]) {
  const said = rest.join(' ');
  if (said === 'worktree list --porcelain') return { out: porcelain(path) };
  if (said === 'rev-parse --path-format=absolute --git-common-dir') return { out: `${join(world.worktrees.find((w) => w.path === path)?.repo ?? path, '.git')}\n` };
  if (rest[0] === 'worktree' && rest[1] === 'remove') return removal(path, rest);
  const repo = world.git[path];
  if (!repo) return { code: 128 };
  if (rest[0] === 'status') return { out: lines([...repo.changes, ...repo.ignored.map((p) => `!! ${p}`)]) };
  if (rest[0] === 'ls-files') return { out: lines(['H app.ts', ...repo.flagged]) };
  return { out: `${repo.unpushed}\n` };
}

function removal(repo, rest) {
  const refused = world.refusals[rest.at(-1)];
  if (refused) return { code: 128, message: `fatal: ${refused}` };
  world.removedWorktrees.push({ repo, args: rest });
  return {};
}

function porcelain(repo) {
  const mine = world.worktrees.filter((w) => w.repo === repo);
  return [`worktree ${repo}\nHEAD aaa\nbranch refs/heads/main\n`, ...mine.map((w) => `worktree ${w.path}\nHEAD bbb\nbranch refs/heads/${w.branch}\n${w.locked ? 'locked\n' : ''}${w.prunable ? 'prunable gitdir file points to non-existent location\n' : ''}`)].join('\n');
}

function lines(list) {
  return list.map((l) => `${l}\n`).join('');
}

// The same review rules as the engine's gc, so the bridge is held to the contract it relies on.
const engine = {
  fetchInbox: async () => world.inbox,
  currentRepos: async () => world.repos,
  loadQueue: () => world.queue,
  loadRuns: () => world.runs,
  claudeAgents: () => world.agents,
  async removeWorktree(handle) {
    world.removedAgents.push(handle);
    world.agents = world.agents.filter((a) => a.handle !== handle);
  },
  parseReviewName(name) {
    const m = /^review-(.+)-(\d+)$/.exec(name);
    return m && { repoLabel: m[1].replace(/-/g, ' '), iid: Number(m[2]) };
  },
  reapable(workspaces, mrs, rules) {
    return reviewsIn(workspaces, rules.knownRepoLabels, true).flatMap(({ workspace, repoLabel, iid }) => {
      if (rules.agentAlive(repoLabel, iid) || rules.pending(repoLabel, iid) > 0) return [];
      const open = mrs.some((mr) => mr.repoLabel.toLowerCase() === repoLabel.toLowerCase() && mr.iid === iid);
      return [{ workspace, reason: open ? 'review finished' : 'mr closed' }];
    });
  },
  outOfScope: (workspaces, knownRepoLabels) => reviewsIn(workspaces, knownRepoLabels, false).map((r) => r.workspace),
};

function reviewsIn(workspaces, knownRepoLabels, watched) {
  const known = new Set(knownRepoLabels.map((l) => l.toLowerCase()));
  return workspaces.flatMap((workspace) => {
    const named = workspace.isMainWorktree || workspace.branch ? null : engine.parseReviewName(workspace.displayName);
    return named && known.has(named.repoLabel.toLowerCase()) === watched ? [{ workspace, ...named }] : [];
  });
}

const engineDir = await mkdtemp(join(tmpdir(), 'control-centre-'));
const engineFile = join(engineDir, 'engine.mjs');
await writeFile(engineFile, '');
mock.module(pathToFileURL(engineFile).href, { namedExports: engine });
after(async () => {
  await rm(engineDir, { recursive: true });
  await rm(root, { recursive: true, force: true });
});

const { ACTIONS, applyCleanup, planCleanup, planRunWorkspaces } = await import('./cleanup.mjs');
const { perform } = await import('./actions.mjs');
const { loadEngine, refreshInbox } = await import('./engine.mjs');
await loadEngine({ matrixEngine: engineFile }, () => {});
await refreshInbox();

beforeEach(async () => {
  world = freshWorld();
  commands.length = 0;
  await rm(join(root, 'engine'), { recursive: true, force: true });
  await mkdir(join(root, 'engine', '.git'), { recursive: true });
});

const REPO = () => join(root, 'engine');

// A real folder with a .git file pointing at its gitdir, whose index carries the last time git touched it.
async function worktree(name, { quietHours = 1, branch = `fix/${name}`, ...git } = {}, extra = {}) {
  const path = join(root, name);
  const gitdir = join(REPO(), '.git', 'worktrees', name);
  await mkdir(path, { recursive: true });
  await mkdir(gitdir, { recursive: true });
  await writeFile(join(path, '.git'), `gitdir: ${gitdir}\n`);
  await writeFile(join(gitdir, 'index'), '');
  const at = (Date.now() - quietHours * HOUR) / 1000;
  await utimes(join(gitdir, 'index'), at, at);
  world.git[path] = { changes: [], ignored: [], flagged: [], unpushed: 0, ...git };
  world.worktrees.push({ path, repo: REPO(), branch, ...extra });
  return path;
}

let agents = 0;
function agent(name, state, hoursAgo, extra = {}) {
  const since = Date.now() - hoursAgo * HOUR;
  agents += 1;
  return {
    handle: `claude:${String(agents).padStart(8, '0')}-0000-4000-8000-000000000000`, sessionId: '', name, title: name, cwd: root, createdAt: new Date(since).toISOString(),
    kind: 'fix', mr: null, ticket: null, worktree: null, state, since, lastAt: since, alive: false, said: '', outcome: state === 'done' ? 'success' : null, pending: null, ...extra,
  };
}

function add(...agents) {
  world.agents.push(...agents);
  return agents;
}

async function plan() {
  await refreshInbox();
  return planCleanup(config);
}

const byName = async (name) => (await plan()).candidates.find((c) => c.name === name);
const orcaAsked = () => commands.some(([cmd]) => /orca$/.test(cmd));

test('a worktree beside the repos whose agents all finished goes: git removes it from its repo, without --force, then the host forgets its agents', async () => {
  const path = await worktree('fix-engine-1');
  const [fix] = add(agent('fix-engine-1', 'done', 2, { worktree: path }));
  const c = await byName('fix-engine-1');
  assert.deepEqual([c.action, c.suggested, c.worktree, c.branch, c.reasons], ['remove', true, true, 'fix/fix-engine-1', ['every agent finished']]);
  const done = await applyCleanup(config, { remove: [path] });
  assert.equal(done.text, 'Removed 1 workspace.');
  assert.deepEqual(world.removedWorktrees, [{ repo: REPO(), args: ['worktree', 'remove', path] }]);
  assert.deepEqual(world.removedAgents, [fix.handle]);
  assert.ok(!commands.flat().includes('--force'));
  assert.equal(orcaAsked(), false);
});

test('the main checkouts are never listed, nor a worktree git calls prunable, and a locked one stays', async () => {
  await worktree('gone', { quietHours: 48 }, { prunable: true });
  await worktree('held', { quietHours: 48 }, { locked: true });
  const { candidates } = await plan();
  assert.deepEqual(candidates.map((c) => [c.name, c.action, c.blocker]), [['held', 'keep', 'git has it locked']]);
});

test('uncommitted changes keep a worktree, and its finished agent is still ticked to close through the host', async () => {
  const path = await worktree('fix-engine-2', { changes: [' M app.ts', '?? new.ts'] });
  const [fix] = add(agent('fix-engine-2', 'done', 2, { worktree: path }));
  const c = await byName('fix-engine-2');
  assert.deepEqual([c.action, c.suggested, c.blocker], ['close-agents', true, '2 uncommitted changes']);
  assert.deepEqual(c.agents, [{ handle: fix.handle, title: 'fix-engine-2' }]);
  await applyCleanup(config, { close: [fix.handle] });
  assert.deepEqual([world.removedAgents, world.removedWorktrees], [[fix.handle], []]);
});

test('commits on no remote keep a worktree; clean and pushed lets it go', async () => {
  const path = await worktree('fix-engine-3', { unpushed: 2 });
  add(agent('fix-engine-3', 'done', 2, { worktree: path }));
  assert.equal((await byName('fix-engine-3')).blocker, '2 commits not pushed');
  world.git[path].unpushed = 0;
  assert.equal((await byName('fix-engine-3')).action, 'remove');
});

test('ignored files that are not build output keep a worktree, since git deletes them without asking', async () => {
  const path = await worktree('fix-engine-4', { ignored: ['node_modules/', 'dist/', '.env'] });
  add(agent('fix-engine-4', 'done', 2, { worktree: path }));
  assert.equal((await byName('fix-engine-4')).blocker, '1 ignored path git would delete: .env');
});

test('a file git status is told to overlook keeps a worktree, and one git cannot read is kept rather than taken as clean', async () => {
  const flagged = await worktree('fix-engine-5', { flagged: ['S secrets.json'] });
  add(agent('fix-engine-5', 'done', 2, { worktree: flagged }));
  assert.equal((await byName('fix-engine-5')).blocker, '1 file marked skip-worktree or assume-unchanged: secrets.json');
  const unreadable = await worktree('fix-engine-6');
  delete world.git[unreadable];
  add(agent('fix-engine-6', 'done', 2, { worktree: unreadable }));
  assert.match((await byName('fix-engine-6')).blocker, /^git could not check it: Command failed/);
});

test('a day without activity is stale: a worktree no agent works in goes once clean and pushed, and one with an agent waiting on you is never ticked', async () => {
  await worktree('by-hand', { quietHours: 30 });
  const asking = await worktree('fix-engine-7', { quietHours: 30 });
  add(agent('fix-engine-7', 'waiting', 30, { worktree: asking }));
  const { candidates } = await plan();
  const [plain, waiting] = ['by-hand', 'fix-engine-7'].map((n) => candidates.find((c) => c.name === n));
  assert.deepEqual([plain.action, plain.suggested, plain.reasons], ['remove', true, ['no activity for 30 h']]);
  assert.deepEqual([waiting.action, waiting.suggested, waiting.reasons], ['remove', false, ['no activity for 30 h', 'an agent is still waiting on you']]);
});

test('a working agent keeps its worktree off the list, and a worktree used within the day is not listed', async () => {
  const path = await worktree('fix-engine-8', { quietHours: 30 });
  add(agent('fix-engine-8', 'working', 30, { worktree: path, alive: true }));
  await worktree('fresh', { quietHours: 1 });
  assert.deepEqual((await plan()).candidates, []);
});

test('an agent stopped part way or ended by an error is not finished, so it is neither removed nor closed', async () => {
  const path = await worktree('fix-engine-9');
  add(agent('fix-engine-9', 'done', 2, { worktree: path, outcome: 'stopped' }), agent('review-Engine-12', 'done', 2, { kind: 'review', outcome: 'error' }));
  assert.deepEqual((await plan()).candidates, []);
});

test('a review agent works in no worktree, so it is a workspace of its own the review engine judges, and goes through the host', async () => {
  world.inbox = { mrs: [{ projectPath: 'acme/platform/relay', iid: 621, repoLabel: 'Engine' }] };
  const [held, gone] = add(agent('review-Engine-621', 'done', 2, { kind: 'review' }), agent('review-Engine-622', 'done', 2, { kind: 'review' }));
  world.queue = [{ status: 'pending', projectPath: 'acme/platform/relay', iid: 621 }];
  const { candidates } = await plan();
  const [kept, closed] = ['review-Engine-621', 'review-Engine-622'].map((n) => candidates.find((c) => c.name === n));
  assert.deepEqual([kept.action, kept.blocker], ['keep', '1 finding still waiting to post']);
  assert.deepEqual([closed.action, closed.worktree, closed.reasons], ['remove', false, ['its MR is closed']]);
  await applyCleanup(config, { remove: [gone.handle, held.handle] });
  assert.deepEqual([world.removedAgents, world.removedWorktrees], [[gone.handle], []]);
});

test('apply removes only what was ticked, and checks each again rather than trusting the preview', async () => {
  const [a, b] = [await worktree('fix-engine-10'), await worktree('fix-engine-11')];
  add(agent('fix-engine-10', 'done', 2, { worktree: a }), agent('fix-engine-11', 'done', 2, { worktree: b }));
  await plan();
  world.git[a].changes = [' M app.ts'];
  const done = await applyCleanup(config, { remove: [a], close: [] });
  assert.equal(done.text, 'Nothing was removed or closed. 1 had changed since the preview and was left alone.');
  assert.deepEqual(world.removedWorktrees, []);
});

test('git refusing a removal reports its own reason and which item it was, the agents stay, and the rest still go', async () => {
  const [a, b] = [await worktree('fix-engine-12'), await worktree('fix-engine-13')];
  add(agent('fix-engine-12', 'done', 2, { worktree: a }), agent('fix-engine-13', 'done', 2, { worktree: b }));
  world.refusals[a] = `'${a}' contains modified or untracked files, use --force to delete it`;
  const done = await applyCleanup(config, { remove: [a, b] });
  assert.equal(done.removed, 1);
  assert.match(done.text, /^Removed 1 workspace\. Could not remove fix-engine-12: fatal: '.*' contains modified or untracked files, use --force to delete it\.$/);
  assert.deepEqual(world.removedAgents.length, 1, 'only the agent whose worktree went is forgotten');
});

test('nothing ticked is refused', async () => {
  await assert.rejects(applyCleanup(config, {}), /nothing was ticked/);
});

test('a fix run is offered its worktree to remove and a review run its agent, each judged as clean-up judges it', async () => {
  const path = await worktree('fix-Engine-88');
  const [fix, review] = add(agent('fix-Engine-88', 'done', 2, { worktree: path }), agent('review-Engine-90', 'done', 2, { kind: 'review' }));
  world.runs = {
    'fix:acme/platform/relay!88': { key: 'fix:acme/platform/relay!88', terminal: fix.handle, worktreePath: path },
    'acme/platform/relay!90': { key: 'acme/platform/relay!90', terminal: review.handle, worktreePath: root },
  };
  await refreshInbox();
  const places = await planRunWorkspaces(config);
  assert.deepEqual(places['fix:acme/platform/relay!88'], { id: path, name: 'fix-Engine-88', removable: true, blocker: null });
  assert.deepEqual(places['acme/platform/relay!90'], { id: review.handle, name: 'review-Engine-90', removable: true, blocker: null });
});

test('a run whose worktree cannot go yet carries the reason in place of a Remove', async () => {
  const path = await worktree('fix-Engine-89', { unpushed: 1 });
  const [fix] = add(agent('fix-Engine-89', 'done', 2, { worktree: path }));
  world.runs = { 'fix:acme/platform/relay!89': { key: 'fix:acme/platform/relay!89', terminal: fix.handle, worktreePath: path } };
  await refreshInbox();
  assert.deepEqual((await planRunWorkspaces(config))['fix:acme/platform/relay!89'], { id: path, name: 'fix-Engine-89', removable: false, blocker: '1 commit not pushed' });
});

const removeAgent = (payload) => perform(ACTIONS['agent-remove'], payload);
const refused = async (promise, status, pattern) => {
  const err = await promise.then(() => assert.fail('it went through'), (e) => e);
  assert.equal(err.status, status, err.message);
  assert.match(err.message, pattern);
};

test('Remove on one agent is refused while it runs, or while its worktree holds work git would lose, and otherwise takes the worktree then the agent', async () => {
  const path = await worktree('fix-engine-14', { unpushed: 1 });
  const [fix] = add(agent('fix-engine-14', 'done', 2, { worktree: path, alive: true }));
  const expect = { state: 'done', since: fix.since };
  await refused(removeAgent({ handle: fix.handle, expect }), 409, /still running, so stop it first/);
  fix.alive = false;
  await refused(removeAgent({ handle: fix.handle, expect: { ...expect, state: 'waiting' } }), 409, /changed since you looked/);
  await refused(removeAgent({ handle: fix.handle, expect }), 409, /^fix-engine-14 stays: 1 commit not pushed$/);
  assert.deepEqual([world.removedWorktrees, world.removedAgents], [[], []]);
  world.git[path].unpushed = 0;
  const { text } = await removeAgent({ handle: fix.handle, expect });
  assert.equal(text, 'Removed fix-engine-14 and its worktree');
  assert.deepEqual(world.removedWorktrees.map((r) => r.args), [['worktree', 'remove', path]]);
  assert.deepEqual(world.removedAgents, [fix.handle]);
  assert.equal(orcaAsked(), false);
});

test('Remove on an agent with no worktree only forgets it, and a handle that is not an agent is refused', async () => {
  const [review] = add(agent('review-Engine-7', 'done', 2, { kind: 'review' }));
  assert.equal((await removeAgent({ handle: review.handle, expect: { state: 'done', since: review.since } })).text, 'Removed review-Engine-7');
  assert.deepEqual([world.removedAgents, world.removedWorktrees], [[review.handle], []]);
  await refused(removeAgent({ handle: 'term_1', expect: {} }), 400, /must name a Claude Code agent/);
});
