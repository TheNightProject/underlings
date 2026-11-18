import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { newId, readWorkspaces, saveWorkspaces, workerEnv } from './workspaces.mjs';

const dir = mkdtempSync(join(tmpdir(), 'underlings-workspaces-'));
after(() => rmSync(dir, { recursive: true, force: true }));
const file = join(dir, 'workspaces.json');
const listed = (workspaces) => writeFileSync(file, JSON.stringify({ workspaces }));
const read = (options = {}) => {
  const logged = [];
  return { workspaces: readWorkspaces({ file, log: (text) => logged.push(text), ...options }), logged };
};

test('with no list there is Default alone, on the port the app always used', () => {
  rmSync(file, { force: true });
  assert.deepEqual(read().workspaces, [{ id: 'default', name: 'Default', port: 47321, account: '', colour: 'blue' }]);
  assert.deepEqual(read({ defaultPort: 48000 }).workspaces[0].port, 48000, 'a port set in config.json');
});

test('each listed workspace runs beside Default with its own port and account, and Default can be named and given an account', () => {
  listed([
    { id: 'default', name: 'Work', account: '1', port: 1 },
    { id: 'side-project', name: 'Side project', port: 47322, account: '2', colour: 'rose' },
    { id: 'oss', port: 47323, colour: 'tartan' },
  ]);
  assert.deepEqual(read().workspaces, [
    { id: 'default', name: 'Work', port: 47321, account: '1', colour: 'blue' },
    { id: 'side-project', name: 'Side project', port: 47322, account: '2', colour: 'rose' },
    { id: 'oss', name: 'oss', port: 47323, account: '', colour: 'amber' },
  ]);
});

test('a workspace that cannot run as listed is left out and says why, and the rest still run', () => {
  listed([
    { id: 'Side Project', port: 47322 },
    { id: 'side', port: 47321 },
    { id: 'oss', port: 80 },
    { id: 'tools', port: 47324, account: 'me@example.com' },
    { id: 'web', port: 47325 },
    { id: 'web', port: 47326 },
    'not a workspace',
  ]);
  const { workspaces, logged } = read();
  assert.deepEqual(workspaces.map((w) => w.id), ['default', 'web']);
  assert.deepEqual(logged.map((line) => line.replace(`left out a workspace in ${file}: `, '')), [
    '"Side Project" is not a workspace id: lower case letters, digits and dashes',
    'side wants port 47321, which Default has',
    'oss has no port between 1024 and 65535',
    'tools names "me@example.com", which is not a cswap account number',
    'web is listed twice',
    'an entry that is not an object',
  ]);
});

test('a list that is not one leaves Default running alone, and says so', () => {
  writeFileSync(file, '{ not json');
  const { workspaces, logged } = read();
  assert.deepEqual(workspaces.map((w) => w.id), ['default']);
  assert.match(logged[0], /is not a list of workspaces, so only Default runs/);
});

test('a workspace\'s worker gets the app\'s environment less the tokens, folders and Claude login that are its own to set', () => {
  const env = { PATH: '/usr/bin', HOME: '/home/dev', GITLAB_TOKEN: 'a', GITHUB_TOKEN: 'b', GH_TOKEN: 'c', UNDERLINGS_STATE_DIR: '/s', UNDERLINGS_CODE_FOLDER: '/code', CLAUDE_CONFIG_DIR: '/c' };
  assert.deepEqual(workerEnv({ id: 'side-project' }, env), { PATH: '/usr/bin', HOME: '/home/dev', UNDERLINGS_WORKSPACE: 'side-project' });
  assert.deepEqual(workerEnv({ id: 'default' }, env), env, 'Default runs as the app always has');
});

test('a saved list reads back as it was, with Default keeping its port in config.json', () => {
  const workspaces = [
    { id: 'default', name: 'Work', port: 47321, account: '1', colour: 'blue' },
    { id: 'side-project', name: 'Side project', port: 47322, account: '', colour: 'teal' },
  ];
  saveWorkspaces(workspaces, file);
  assert.deepEqual(read({ defaultPort: 47321 }).workspaces, workspaces);
  assert.equal(JSON.parse(readFileSync(file, 'utf8')).workspaces[0].port, undefined);
});

test('a new workspace\'s id comes from its name, and is never Default\'s or one already taken', () => {
  assert.equal(newId('Side Project!', ['default']), 'side-project');
  assert.equal(newId('Side project', ['default', 'side-project']), 'side-project-2');
  assert.equal(newId('Default', ['default']), 'default-2');
  assert.equal(newId('???', ['default']), 'workspace');
});
