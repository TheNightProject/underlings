// Run on its own once the app has quit, so it imports nothing beside it: the bundle it was loaded from is about to move.
import * as child from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, open, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const HELPER = fileURLToPath(import.meta.url);
const POLL_MS = 250;
const QUIT_WAIT_MS = 120_000;
const START_WAIT_MS = 5000;
const exec = (cmd, args, options) => promisify(child.execFile)(cmd, args, options);
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// The app's own binary runs as plain Node with ELECTRON_RUN_AS_NODE, so the helper needs no node on the PATH.
export async function startHelper(job, logFile) {
  await mkdir(dirname(logFile), { recursive: true });
  const out = await open(logFile, 'w');
  try {
    const env = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    child.spawn(process.execPath, [HELPER, JSON.stringify(job)], { detached: true, stdio: ['ignore', out.fd, out.fd], env }).unref();
  } finally {
    await out.close();
  }
  await waitForStart(job.result);
}

async function waitForStart(result) {
  const until = Date.now() + START_WAIT_MS;
  while (Date.now() < until) {
    const said = JSON.parse(await readFile(result, 'utf8').catch(() => 'null'));
    if (said?.phase) return;
    await sleep(100);
  }
  throw new Error('the install helper did not start, so this version keeps running');
}

// A move to a new place that fails opens the app where it was, from fallback, rather than a place with nothing in it.
export async function install({ pid, built, bundle, result, relaunch, fallback = relaunch, quitWaitMs = QUIT_WAIT_MS }) {
  await record(result, { phase: 'waiting', pid: process.pid });
  let outcome;
  try {
    await quitOf(pid, quitWaitMs);
    await swap(built, bundle);
    outcome = { ok: true };
  } catch (err) {
    outcome = { ok: false, error: err.message };
  }
  await record(result, { phase: 'done', ...outcome, at: new Date().toISOString() });
  console.log(outcome.ok ? `installed ${built} at ${bundle}` : `kept ${bundle}: ${outcome.error}`);
  const opener = outcome.ok ? relaunch : fallback;
  await exec(opener[0], opener.slice(1), { env: appEnv(process.env) }).catch((err) => console.error(`could not open ${opener[1]} again: ${err.message}`));
  return outcome;
}

// macOS hands open's environment to the app it starts, which would then run as plain Node too and quit at once.
export function appEnv(env) {
  const { ELECTRON_RUN_AS_NODE, ...rest } = env;
  return rest;
}

async function quitOf(pid, waitMs) {
  const until = Date.now() + waitMs;
  while (alive(pid)) {
    if (Date.now() > until) throw new Error(`the app was still running after ${Math.round(waitMs / 1000)} s, so nothing was installed`);
    await sleep(POLL_MS);
  }
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

// Copied beside the old app first, so a copy that fails part way leaves the old app whole.
async function swap(built, bundle) {
  if (!existsSync(join(built, 'Contents'))) throw new Error(`there is no built app at ${built}`);
  const next = join(dirname(bundle), `.${basename(bundle)}.new`);
  const old = join(dirname(bundle), `.${basename(bundle)}.old`);
  await rm(next, { recursive: true, force: true });
  await exec('/usr/bin/ditto', [built, next]);
  await rm(old, { recursive: true, force: true });
  if (existsSync(bundle)) await rename(bundle, old);
  try {
    await rename(next, bundle);
  } catch (err) {
    if (existsSync(old)) await rename(old, bundle);
    throw err;
  }
  await rm(old, { recursive: true, force: true });
}

async function record(path, value) {
  await writeFile(path + '.tmp', JSON.stringify(value) + '\n', { mode: 0o600 });
  await rename(path + '.tmp', path);
}

if (process.argv[1] === HELPER) install(JSON.parse(process.argv[2])).then((outcome) => process.exit(outcome.ok ? 0 : 1));
