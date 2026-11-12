import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, beforeEach, test } from 'node:test';
import { install, startHelper } from './apphelper.mjs';

const dir = await mkdtemp(join(tmpdir(), 'underlings-apphelper-'));
const apps = join(dir, 'Applications');
const bundle = join(apps, 'Underlings.app');
const built = join(dir, 'dist/Underlings.app');
const result = join(dir, 'state/update-install.json');
const opened = join(dir, 'opened');
const relaunch = ['/usr/bin/touch', opened];
after(() => rm(dir, { recursive: true }));

const version = (app) => readFile(join(app, 'Contents/version'), 'utf8');
const said = async () => JSON.parse(await readFile(result, 'utf8'));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function app(path, text) {
  await mkdir(join(path, 'Contents'), { recursive: true });
  await writeFile(join(path, 'Contents/version'), text);
}

function child(ms) {
  const proc = spawn(process.execPath, ['-e', `setTimeout(() => {}, ${ms})`]);
  return { pid: proc.pid, gone: new Promise((resolve) => proc.on('exit', resolve)) };
}

beforeEach(async () => {
  await rm(apps, { recursive: true, force: true });
  await rm(opened, { force: true });
  await mkdir(join(dir, 'state'), { recursive: true });
  await rm(result, { force: true });
  await app(bundle, 'old');
  await app(built, 'new');
});

test('once the app has quit the new build takes its place whole, nothing is left beside it, and the app opens again', async () => {
  const running = child(400);
  const installing = install({ pid: running.pid, built, bundle, result, relaunch });
  await sleep(150);
  assert.equal((await said()).phase, 'waiting');
  assert.equal(await version(bundle), 'old', 'nothing moves while the app runs');
  await running.gone;
  assert.deepEqual(await installing, { ok: true });
  assert.equal(await version(bundle), 'new');
  assert.deepEqual(await readdir(apps), ['Underlings.app']);
  assert.deepEqual([(await said()).phase, (await said()).ok], ['done', true]);
  assert.ok(existsSync(opened));
});

test('an app that never quits keeps its bundle, says so, and is opened again regardless', async () => {
  const outcome = await install({ pid: process.pid, built, bundle, result, relaunch, quitWaitMs: 300 });
  assert.equal(outcome.ok, false);
  assert.match(outcome.error, /the app was still running after \d+ s, so nothing was installed/);
  assert.equal(await version(bundle), 'old');
  assert.equal((await said()).ok, false);
  assert.ok(existsSync(opened));
});

test('a move to a new name that fails opens the app where it was, not the place it was going to', async () => {
  const gone = child(0);
  await gone.gone;
  const there = join(dir, 'opened-old');
  const outcome = await install({ pid: gone.pid, built: join(dir, 'missing.app'), bundle: join(apps, 'New.app'), result, relaunch, fallback: ['/usr/bin/touch', there] });
  assert.equal(outcome.ok, false);
  assert.deepEqual([existsSync(there), existsSync(opened)], [true, false]);
  await install({ pid: gone.pid, built, bundle: join(apps, 'New.app'), result, relaunch, fallback: ['/usr/bin/touch', there + '-again'] });
  assert.deepEqual([existsSync(opened), existsSync(there + '-again')], [true, false], 'one that works opens the new place');
});

test('with no build to put in place the old app stays exactly as it was', async () => {
  const gone = child(0);
  await gone.gone;
  await rm(built, { recursive: true });
  const outcome = await install({ pid: gone.pid, built, bundle, result, relaunch });
  assert.match(outcome.error, /there is no built app at/);
  assert.equal(await version(bundle), 'old');
  assert.deepEqual(await readdir(apps), ['Underlings.app']);
});

test('the helper runs as a process of its own, says it has started, and finishes the swap after its parent call returns', async () => {
  const gone = child(0);
  await gone.gone;
  await startHelper({ pid: gone.pid, built, bundle, result, relaunch }, join(dir, 'state/update-install.log'));
  for (let i = 0; i < 100 && (await said()).phase !== 'done'; i += 1) await sleep(50);
  assert.equal((await said()).ok, true);
  assert.equal(await version(bundle), 'new');
  assert.match(await readFile(join(dir, 'state/update-install.log'), 'utf8'), /installed .* at .*Underlings\.app/);
});

test('the app is reopened without ELECTRON_RUN_AS_NODE, or macOS would start it as plain Node and it would quit at once', async () => {
  await mkdir(join(built, 'Contents'), { recursive: true });
  const seen = join(dir, 'reopen-env');
  const reopen = join(dir, 'reopen.sh');
  await writeFile(reopen, `#!/bin/sh\nenv > '${seen}'\n`, { mode: 0o755 });
  const gone = spawn(process.execPath, ['-e', '']);
  await new Promise((resolve) => gone.on('exit', resolve));
  process.env.ELECTRON_RUN_AS_NODE = '1';
  try {
    assert.equal((await install({ pid: gone.pid, built, bundle, result, relaunch: [reopen] })).ok, true);
  } finally {
    delete process.env.ELECTRON_RUN_AS_NODE;
  }
  const env = await readFile(seen, 'utf8');
  assert.doesNotMatch(env, /^ELECTRON_RUN_AS_NODE=/m);
  assert.match(env, /^PATH=/m, 'the rest of the environment is kept');
});
