import { initOf, serveWorker } from './bridge.mjs';
import { workerEnv } from '../lib/workspaces.mjs';

// A worker that ran a while and then died is started again, sooner the first time; one that dies over and over is left stopped.
const RESTART_MS = [2_000, 15_000, 60_000];
const SETTLED_MS = 5 * 60_000;
const STOP_WAIT_MS = 3000;

/**
 * One worker process per workspace, each started with its own environment and given the app's
 * desktop through the bridge. `fork` is Electron's utilityProcess.fork, or a stand-in under test.
 */
export function createSupervisor({ fork, entry, workerDir, desktopFor, logFor, env = process.env, now = Date.now, timers = { setTimeout, clearTimeout } }) {
  const running = new Map();
  let stopping = false;

  function start(workspace, { port } = {}) {
    const desktop = desktopFor(workspace);
    if (port) desktop.port = port;
    const log = logFor(workspace);
    const child = fork(entry, [], { env: workerEnv(workspace, env), serviceName: `Underlings: ${workspace.name}` });
    const wire = { post: (msg) => child.postMessage(msg), on: (fn) => child.on('message', fn) };
    const was = running.get(workspace.id);
    const worker = { workspace, child, desktop, state: 'starting', startedAt: null, crashes: was?.crashes ?? 0, restart: null, bridge: serveWorker({ port: wire, desktop, log }) };
    running.set(workspace.id, worker);
    // Settled once, by whichever comes first: the worker listening, its own report of why not, or the process ending.
    worker.ready = new Promise((resolve) => {
      child.on('message', (msg) => {
        if (msg.t === 'started') {
          Object.assign(worker, { state: 'running', startedAt: now() });
          resolve({ ok: true });
        }
        if (msg.t === 'failed') {
          worker.state = 'failed';
          log(`${workspace.name} could not start: ${msg.error.message}`);
          resolve({ ok: false, error: msg.error });
        }
      });
      child.on('exit', (code) => {
        resolve({ ok: false, error: { message: `its process ended with code ${code} before it started` } });
        exited(worker, code, log);
      });
    });
    child.postMessage({ t: 'start', workerDir, workspace, init: initOf(desktop) });
    return worker;
  }

  function exited(worker, code, log) {
    worker.bridge.end();
    worker.state = worker.state === 'failed' ? 'failed' : 'exited';
    if (stopping || running.get(worker.workspace.id) !== worker || worker.state === 'failed') return;
    if (worker.startedAt !== null && now() - worker.startedAt >= SETTLED_MS) worker.crashes = 0;
    if (worker.crashes >= RESTART_MS.length) return log(`${worker.workspace.name} stopped with code ${code} again, so it is left stopped until the app restarts`);
    const wait = RESTART_MS[worker.crashes];
    log(`${worker.workspace.name} stopped with code ${code}; starting it again in ${wait / 1000} s`);
    worker.crashes += 1;
    worker.restart = timers.setTimeout(() => {
      if (!stopping && running.get(worker.workspace.id) === worker) start(worker.workspace, { port: worker.desktop.port });
    }, wait);
  }

  // Out of the running list first, so its exit is not taken for a crash.
  async function retire(id) {
    const worker = running.get(id);
    if (!worker) return null;
    running.delete(id);
    await stopOne(worker);
    return worker;
  }

  async function restart(id) {
    const worker = await retire(id);
    return worker ? start(worker.workspace, { port: worker.desktop.port }) : null;
  }

  async function stop() {
    stopping = true;
    await Promise.all([...running.values()].map((worker) => stopOne(worker)));
  }

  function stopOne(worker) {
    timers.clearTimeout(worker.restart);
    if (worker.state === 'exited' || worker.state === 'failed') return Promise.resolve();
    return new Promise((resolve) => {
      const timer = timers.setTimeout(() => {
        worker.child.kill();
        resolve();
      }, STOP_WAIT_MS);
      worker.child.on('exit', () => {
        timers.clearTimeout(timer);
        resolve();
      });
      worker.child.postMessage({ t: 'stop' });
    });
  }

  return {
    start,
    stop,
    retire,
    restart,
    get: (id) => running.get(id) ?? null,
    all: () => [...running.values()],
    keep: (key, value) => running.forEach((worker) => worker.state !== 'exited' && worker.bridge.keep(key, value)),
  };
}
