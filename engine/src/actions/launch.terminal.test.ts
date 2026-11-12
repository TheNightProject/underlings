import assert from 'node:assert/strict';
import childProcess from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { promisify } from 'node:util';
import { pluginDir } from '../plugin.js';

const root = mkdtempSync(join(tmpdir(), 'thematrix-launch-'));
process.env['UNDERLINGS_STATE_DIR'] = join(root, 'state');
process.env['ORCA_WORKSPACE_ROOT'] = root;
process.env['UNDERLINGS_ORCA_REPO_ID'] = 'repo-1';
after(() => rmSync(root, { recursive: true, force: true }));

// The shapes Orca's own CLI answers with: terminal create nests the new terminal under `terminal`.
const ORCA: Record<string, unknown> = {
  'worktree create': { worktree: { id: 'repo-1::/work::workspace:abc', path: root } },
  'terminal create': { terminal: { handle: 'term_new', title: 'review !7', surface: 'background' } },
  'terminal send': { send: { accepted: true } },
};
// The word Orca's terminal is typed, quoted only where a shell would read it differently.
const typed = (word: string): string => (/^[\w.:/@-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`);
const PLUGIN = `--plugin-dir ${typed(pluginDir())}`;
let calls: string[][] = [];
let replies: Record<string, unknown> = ORCA;

const fakeExecFile = Object.assign(() => undefined, {
  [promisify.custom]: (_file: string, args: string[]) => {
    calls.push(args);
    const verb = args.slice(0, 2).join(' ');
    return Promise.resolve({ stdout: JSON.stringify({ id: 'local', ok: true, result: replies[verb] ?? {} }) });
  },
});
Object.assign(childProcess, { execFile: fakeExecFile });
syncBuiltinESMExports();
const { launchReview, launchTicket } = await import('./launch.js');
const { createTerminal } = await import('../data/orca.js');
// These are the Orca host's launches: the fallback a state file that names agentHost orca keeps.
(await import('../data/store.js')).changeSettings((s) => ({ ...s, agentHost: 'orca' }));

beforeEach(() => {
  calls = [];
  replies = ORCA;
});

const sentTo = (): string | undefined => {
  const send = calls.find((args) => args[0] === 'terminal' && args[1] === 'send');
  return send?.[send.indexOf('--terminal') + 1];
};

const mr = {
  projectPath: 'acme/engine', projectId: 1, repoLabel: 'Engine', iid: 7, title: 'x', webUrl: 'https://gitlab.com/acme/engine/-/merge_requests/7',
  draft: false, conflicts: false, notes: 0, author: 'ivan', reviewers: [], approvedBy: [], pipeline: 'SUCCESS' as const, mergeStatus: null,
  createdAt: '', updatedAt: '', sha: null, sourceBranch: 'feat/7', ticket: null, unresolvedThreads: 0,
};

test('a review in a folder repo sends its prompt to the terminal Orca created for it', async () => {
  const outcome = await launchReview(mr, 'review it');
  assert.equal(sentTo(), 'term_new');
  assert.deepEqual([outcome.how, outcome.handle], ['terminal', 'term_new']);
});

test('a ticket starts its agent in a workspace of the folder repo, never a terminal by the checkout path Orca does not know', async () => {
  mkdirSync(join(root, 'engine'), { recursive: true });
  mkdirSync(join(root, 'eng-abc-12'), { recursive: true });
  replies = { ...ORCA, 'worktree create': { worktree: { id: 'repo-1::/work::workspace:t1', path: root }, launch: { outcome: { handle: 'term_agent' } } } };
  const ticket = { key: 'ABC-12', summary: 'Fix it', status: 'To Do', labels: [], url: '' };
  const outcome = await launchTicket(ticket, { path: 'acme/engine', label: 'Engine', dir: 'engine', prefix: 'eng' });
  const create = calls.find((args) => args[0] === 'worktree' && args[1] === 'create') ?? [];
  assert.equal(create[create.indexOf('--repo') + 1], 'id:repo-1');
  assert.equal(create[create.indexOf('--name') + 1], 'eng-abc-12');
  assert.match(create[create.indexOf('--prompt') + 1] ?? '', new RegExp(`Work in ${join(root, 'eng-abc-12')}, the checkout made for it`));
  assert.ok(!calls.some((args) => args.includes(`path:${join(root, 'eng-abc-12')}`)));
  assert.deepEqual([outcome.handle, outcome.path], ['term_agent', join(root, 'eng-abc-12')]);
});

test('a terminal create that names no terminal fails there, rather than sending to nothing', async () => {
  replies = { ...ORCA, 'terminal create': { browserPageId: 'page-1' } };
  await assert.rejects(createTerminal({ worktree: `path:${root}` }), /returned no terminal handle/);
  await assert.rejects(launchReview(mr, 'review it'), /returned no terminal handle/);
  assert.equal(sentTo(), undefined);
});

test('an agent in Orca starts on its task\'s model and effort, in its worktree and in a terminal Orca had to open for it, and Claude Code\'s default passes neither', async () => {
  const store = await import('../data/store.js');
  const before = store.loadSettings().models;
  store.changeSettings((s) => ({ ...s, models: { ...s.models, review: { model: 'claude-sonnet-5-5[1m]', effort: 'low' } } }));
  try {
    await launchReview(mr, 'review it');
    const create = calls.find((args) => args[0] === 'worktree' && args[1] === 'create') ?? [];
    assert.deepEqual([create[create.indexOf('--model') + 1], create[create.indexOf('--effort') + 1]], ['claude-sonnet-5-5[1m]', 'low']);
    const terminal = calls.find((args) => args[0] === 'terminal' && args[1] === 'create') ?? [];
    assert.equal(terminal[terminal.indexOf('--command') + 1], `claude --model 'claude-sonnet-5-5[1m]' --effort low ${PLUGIN}`);
  } finally {
    store.changeSettings((s) => ({ ...s, models: before }));
  }
  calls = [];
  await launchReview(mr, 'review it');
  const plain = calls.find((args) => args[0] === 'worktree' && args[1] === 'create') ?? [];
  assert.ok(!plain.includes('--model') && !plain.includes('--effort'));
  const terminal = calls.find((args) => args[0] === 'terminal' && args[1] === 'create') ?? [];
  assert.equal(terminal[terminal.indexOf('--command') + 1], `claude ${PLUGIN}`);
});

test('an agent in Orca whose task follows the effort for every task is started on that effort', async () => {
  const store = await import('../data/store.js');
  const before = store.loadSettings();
  store.changeSettings((s) => ({ ...s, everyEffort: 'max', models: { ...s.models, review: { model: 'default', effort: 'same' } } }));
  try {
    await launchReview(mr, 'review it');
    const create = calls.find((args) => args[0] === 'worktree' && args[1] === 'create') ?? [];
    assert.equal(create[create.indexOf('--effort') + 1], 'max');
    assert.ok(!create.includes('--model'));
    const terminal = calls.find((args) => args[0] === 'terminal' && args[1] === 'create') ?? [];
    assert.equal(terminal[terminal.indexOf('--command') + 1], `claude --effort max ${PLUGIN}`);
  } finally {
    store.changeSettings(() => before);
  }
});
