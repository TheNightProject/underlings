import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';

const run = promisify(execFile);
const TSX = join(process.cwd(), 'node_modules', '.bin', 'tsx');
const CLI = join(process.cwd(), 'dist', 'cli.js');
const STORE = join(process.cwd(), 'src', 'data', 'store.js');
const KIT = join(process.cwd(), 'src', 'auto', 'testkit.js');
const FINDING = { projectPath: 'acme/engine', projectId: 1001, iid: 621, webUrl: 'https://gitlab.example/acme/engine/-/merge_requests/621', severity: 'MINOR', body: 'finding 0' };

// A test that forgot its state dir, with HOME moved so that if the guard fails the write lands here and not in yours.
function forgetful(home: string, underTest: boolean): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, NODE_TEST_CONTEXT: 'child-v8' };
  delete env['UNDERLINGS_STATE_DIR'];
  if (!underTest) delete env['NODE_TEST_CONTEXT'];
  return env;
}

const defaultQueue = (home: string): string => join(home, '.local', 'state', 'underlings', 'engine', 'queue.json');

async function attempt(home: string, underTest: boolean, name = 'attempt.mts'): Promise<string> {
  const path = join(home, name);
  writeFileSync(path, `
    import * as store from '${STORE}';
    import * as kit from '${KIT}';
    const tried = [];
    for (const write of [() => kit.resetState(), () => store.addToQueue([${JSON.stringify(FINDING)}]), () => store.saveState({ watches: {}, seen: {} })]) {
      try { write(); tried.push('wrote'); } catch (e) { tried.push(e.message); }
    }
    console.log(JSON.stringify(tried));`);
  return (await run(TSX, [path], { env: forgetful(home, underTest) })).stdout;
}

test('under the test runner, a store with no state dir set refuses every write rather than reaching the real one', async () => {
  const home = mkdtempSync(join(tmpdir(), 'thematrix-home-'));
  try {
    const tried: string[] = JSON.parse(await attempt(home, true));
    assert.equal(tried.length, 3);
    for (const said of tried) assert.match(said, /refusing to (write|clear) .*: set UNDERLINGS_STATE_DIR/);
    assert.equal(existsSync(join(home, '.local', 'state', 'underlings')), false, 'nothing was written, not even the directory');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('outside the test runner the default state dir is written as it always was, but the test kit never clears it', async () => {
  const home = mkdtempSync(join(tmpdir(), 'thematrix-home-'));
  try {
    const [reset, ...writes] = JSON.parse(await attempt(home, false)) as string[];
    assert.match(reset ?? '', /refusing to clear .*: set UNDERLINGS_STATE_DIR/);
    assert.deepEqual(writes, ['wrote', 'wrote']);
    assert.equal(existsSync(join(home, '.local', 'state', 'underlings', 'engine', 'state.json')), true);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a test file run on its own, outside the runner, is refused as well', async () => {
  const home = mkdtempSync(join(tmpdir(), 'thematrix-home-'));
  try {
    const tried: string[] = JSON.parse(await attempt(home, false, 'forgot.test.mts'));
    assert.equal(tried.length, 3);
    for (const said of tried) assert.match(said, /refusing to (write|clear) .*: set UNDERLINGS_STATE_DIR/);
    assert.equal(existsSync(join(home, '.local', 'state', 'underlings')), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('the way the fixtures leaked, a test driving the built CLI without a state dir it reads, is refused too', async () => {
  const home = mkdtempSync(join(tmpdir(), 'thematrix-home-'));
  try {
    const add = run('/bin/sh', ['-c', `printf '%s' '${JSON.stringify([FINDING])}' | node ${CLI} queue add --json`], { env: forgetful(home, true) });
    await assert.rejects(add, (err: { stderr?: string }) => /refusing to write/.test(err.stderr ?? ''));
    assert.equal(existsSync(defaultQueue(home)), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

const queueIn = (dir: string): { body: string }[] => JSON.parse(readFileSync(join(dir, 'queue.json'), 'utf8')) as { body: string }[];

async function queueAdd(bin: string, home: string): Promise<string> {
  return (await run('/bin/sh', ['-c', `printf '%s' '${JSON.stringify([FINDING])}' | ${bin} queue add --json`], { env: forgetful(home, false) })).stdout;
}

test('the command line writes the new state folder, and the old one only while the move from it has not happened', async () => {
  const home = mkdtempSync(join(tmpdir(), 'underlings-cli-'));
  try {
    await queueAdd(`node ${CLI}`, home);
    assert.deepEqual(queueIn(join(home, '.local', 'state', 'underlings', 'engine')).map((c) => c.body), ['finding 0']);
    rmSync(join(home, '.local'), { recursive: true });
    const old = join(home, '.local', 'state', 'thematrix');
    mkdirSync(old, { recursive: true });
    writeFileSync(join(old, 'queue.json'), '[]');
    await queueAdd(`node ${CLI}`, home);
    assert.deepEqual(queueIn(old).map((c) => c.body), ['finding 0'], 'the move carries it across later');
    assert.equal(existsSync(join(home, '.local', 'state', 'underlings')), false, 'and nothing made a new folder the move would then refuse');
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('a link made under the old name, thematrix, still adds to the queue, in the new state folder', async () => {
  const home = mkdtempSync(join(tmpdir(), 'underlings-link-'));
  try {
    mkdirSync(join(home, '.local', 'bin'), { recursive: true });
    mkdirSync(join(home, '.local', 'state', 'underlings', 'engine'), { recursive: true });
    const link = join(home, '.local', 'bin', 'thematrix');
    symlinkSync(CLI, link);
    const said = await queueAdd(link, home);
    assert.equal((JSON.parse(said) as { added: number }).added, 1);
    assert.deepEqual(queueIn(join(home, '.local', 'state', 'underlings', 'engine')).map((c) => c.body), ['finding 0']);
    assert.equal(existsSync(join(home, '.local', 'state', 'thematrix')), false);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test('UNDERLINGS_STATE_DIR names the state folder, and the names it had before are no longer read', async () => {
  const home = mkdtempSync(join(tmpdir(), 'underlings-env-'));
  try {
    const set = join(home, 'chosen');
    const add = (env: NodeJS.ProcessEnv) => run('/bin/sh', ['-c', `printf '%s' '${JSON.stringify([FINDING])}' | node ${CLI} queue add --json`], { env: { ...forgetful(home, false), ...env } });
    await add({ UNDERLINGS_STATE_DIR: set });
    assert.deepEqual(queueIn(set).map((c) => c.body), ['finding 0']);
    const before = Object.fromEntries(['MATRIX', 'GODMODE', 'MRPOD', 'WS_POD'].map((prefix) => [`${prefix}_STATE_DIR`, join(home, prefix)]));
    await add(before);
    for (const dir of Object.values(before)) assert.equal(existsSync(dir), false, dir);
    assert.deepEqual(queueIn(join(home, '.local', 'state', 'underlings', 'engine')).map((c) => c.body), ['finding 0']);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
