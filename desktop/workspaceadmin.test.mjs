import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { createWorkspaceAdmin } from './workspaceadmin.mjs';
import { readWorkspaces } from '../lib/workspaces.mjs';

const root = mkdtempSync(join(tmpdir(), 'underlings-admin-'));
after(() => rmSync(root, { recursive: true, force: true }));
const config = (id) => join(root, 'config', id === 'default' ? '' : `workspaces/${id}`);
const engine = (id) => join(root, 'state', id === 'default' ? '' : `workspaces/${id}`, 'engine');

function harness({ running = 0, busy = [] } = {}) {
  const workspaces = [{ id: 'default', name: 'Work', port: 47321, account: '1', colour: 'blue' }];
  const calls = [];
  const file = join(root, 'config', 'workspaces.json');
  const admin = createWorkspaceAdmin({
    workspaces,
    file,
    supervisor: {
      start: (w) => calls.push(['start', w.id]),
      restart: async (id) => calls.push(['restart', id]),
      retire: async (id) => calls.push(['retire', id]),
    },
    folders: { config, engine },
    isFree: async (port) => !busy.includes(port),
    agentsRunning: async () => running,
    onChange: () => calls.push(['changed']),
  });
  return { admin, workspaces, calls, saved: () => readWorkspaces({ file }) };
}

test('a new workspace gets an id from its name, the next free port, a colour, and its worker started', async () => {
  const { admin, workspaces, calls, saved } = harness({ busy: [47322] });
  const answer = await admin.create({ name: '  Side   project ', account: '2' });
  assert.deepEqual(answer.workspace, { id: 'side-project', name: 'Side project', port: 47323, account: '2', colour: 'green' });
  assert.equal(answer.text, 'Made Side project. It is starting');
  assert.deepEqual(workspaces.map((w) => w.id), ['default', 'side-project']);
  assert.deepEqual(saved().map((w) => [w.id, w.port]), [['default', 47321], ['side-project', 47323]]);
  assert.deepEqual(calls, [['changed'], ['start', 'side-project']]);
});

test('a copy takes the other workspace\'s settings and how it shows things, never its tokens, its Setup or its history', async () => {
  mkdirSync(config('default'), { recursive: true });
  mkdirSync(engine('default'), { recursive: true });
  for (const name of ['features.json', 'standup.json', 'gitlab-token', 'github-token', 'setup.json']) writeFileSync(join(config('default'), name), name);
  writeFileSync(join(engine('default'), 'state.json'), JSON.stringify({ settings: { repoFilter: 'acme/*', pollSeconds: 60 }, watches: { 'acme/engine!7': {} }, verdicts: { x: 1 } }));
  const { admin } = harness();
  const { workspace } = await admin.create({ name: 'Copy', copyFrom: 'default' });
  const copied = (name) => existsSync(join(config(workspace.id), name));
  assert.deepEqual(['features.json', 'standup.json', 'gitlab-token', 'github-token', 'setup.json'].map(copied), [true, true, false, false, false]);
  assert.deepEqual(JSON.parse(readFileSync(join(engine(workspace.id), 'state.json'), 'utf8')), { settings: { repoFilter: 'acme/*', pollSeconds: 60 } });
});

test('a name, colour or account is changed in place, and a new account starts the worker again', async () => {
  const { admin, workspaces, calls } = harness();
  await admin.create({ name: 'Side' });
  calls.length = 0;
  assert.equal((await admin.update({ id: 'side', name: 'Weekend', colour: 'violet' })).text, 'Saved Weekend: renamed from Side, violet');
  assert.deepEqual(calls, [['changed']], 'nothing restarts for a name or a colour');
  assert.equal((await admin.update({ id: 'side', account: '3' })).text, 'Saved Weekend: cswap account 3, started again');
  assert.equal((await admin.update({ id: 'side', name: 'Weekend', account: '3' })).text, 'Nothing about Weekend changed');
  assert.deepEqual(calls.at(-1), ['restart', 'side']);
  assert.deepEqual(workspaces[1], { id: 'side', name: 'Weekend', port: 47322, account: '3', colour: 'violet' });
  await assert.rejects(admin.update({ id: 'side', colour: 'tartan' }), { status: 400 });
  await assert.rejects(admin.update({ id: 'side', account: 'me@example.com' }), { status: 400, message: '"me@example.com" is not a cswap account number' });
  await assert.rejects(admin.update({ id: 'nope', name: 'x' }), { status: 404 });
  await assert.rejects(admin.create({ name: '   ' }), { status: 400, message: 'a workspace needs a name' });
});

test('removing stops its worker and drops it from the list, keeping its folders, and is refused for Default or while its agents run', async () => {
  const busy = harness({ running: 2 });
  await busy.admin.create({ name: 'Side' });
  await assert.rejects(busy.admin.remove({ id: 'side' }), { status: 409, message: 'Side has 2 agents running. Stop them first' });
  await assert.rejects(busy.admin.remove({ id: 'default' }), { status: 409, message: 'Default cannot be removed' });

  const { admin, workspaces, calls, saved } = harness();
  await admin.create({ name: 'Side' });
  const answer = await admin.remove({ id: 'side' });
  assert.equal(answer.text, `Removed Side. Its settings stay in ${config('side')} and its history in ${join(root, 'state', 'workspaces/side')} until you delete them`);
  assert.deepEqual(calls.at(-2), ['retire', 'side']);
  assert.deepEqual([workspaces.map((w) => w.id), saved().map((w) => w.id)], [['default'], ['default']]);
});
