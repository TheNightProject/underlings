// One workspace's worker, in a process of its own: the app sends it what it needs to start, and asks it to stop when it quits.
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { workerCtx } from './bridge.mjs';

const parent = process.parentPort;
const port = { post: (msg) => parent.postMessage(msg), on: (fn) => parent.on('message', (e) => fn(e.data)) };
let worker = null;

parent.once('message', ({ data }) => {
  if (data.t === 'start') start(data).catch((err) => fail(err));
});
parent.on('message', ({ data }) => {
  if (data.t === 'stop') stop();
});

async function start({ workerDir, workspace, init }) {
  const ctx = workerCtx({ port, init });
  // Before the worker's first import, as the engine reads where Claude Code keeps its config only once.
  if (workspace.account) {
    const dir = await configDirOf(workspace.account, workerDir, ctx);
    if (dir) process.env.CLAUDE_CONFIG_DIR = dir;
    else delete process.env.CLAUDE_CONFIG_DIR;
  }
  worker = await import(pathToFileURL(join(workerDir, 'worker.mjs')).href);
  await worker.default(ctx);
  port.post({ t: 'started' });
}

async function configDirOf(account, workerDir, ctx) {
  const lib = (name) => import(pathToFileURL(join(workerDir, 'lib', name)).href);
  const [{ adoptShellPath }, { accountConfigDir }, { stateDir }] = await Promise.all([lib('shell-env.mjs'), lib('claudesession.mjs'), lib('home.mjs')]);
  await adoptShellPath().catch((err) => ctx.log(`could not read the shell's PATH: ${err.message}`));
  const dir = await accountConfigDir(account, { shimDir: join(stateDir(), 'where') });
  ctx.log(`runs as cswap account ${account}${dir ? `, from ${dir}` : ', which is the default login'}`);
  return dir;
}

function fail(err) {
  port.post({ t: 'failed', error: { message: err.message, code: err.code, port: err.port, stack: err.stack } });
  setTimeout(() => process.exit(1), 100);
}

async function stop() {
  await worker?.deactivate?.().catch(() => {});
  port.post({ t: 'stopped' });
  process.exit(0);
}
