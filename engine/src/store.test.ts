import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import type { QueuedComment } from './types.js';

const run = promisify(execFile);
const CLI = join(process.cwd(), 'dist', 'cli.js');

function finding(n: number): string {
  return JSON.stringify([
    {
      projectPath: 'acme/engine',
      projectId: 1001,
      iid: 621,
      webUrl: 'https://gitlab.example/acme/engine/-/merge_requests/621',
      severity: 'MINOR',
      body: `finding ${n}`,
    },
  ]);
}

function queueAdd(dir: string, payload: string): Promise<unknown> {
  return run('/bin/sh', ['-c', `printf '%s' '${payload}' | node ${CLI} queue add --json`], {
    env: { ...process.env, UNDERLINGS_STATE_DIR: dir },
  });
}

test('findings queued at the same moment all survive', async () => {
  // Each review agent is its own process appending to one file, so the writers really are
  // concurrent. Without a lock around the read and the write, the last one to read wins
  // and every finding queued in between it is lost.
  const dir = mkdtempSync(join(tmpdir(), 'thematrix-'));
  try {
    await Promise.all(Array.from({ length: 12 }, (_, n) => queueAdd(dir, finding(n))));
    const queue = JSON.parse(readFileSync(join(dir, 'queue.json'), 'utf8')) as QueuedComment[];
    assert.equal(queue.length, 12, `only ${queue.length} of 12 concurrent findings survived`);
    assert.equal(new Set(queue.map((c) => c.body)).size, 12, 'and each must be its own finding');
    assert.equal(new Set(queue.map((c) => c.id)).size, 12, 'ids must stay unique');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

/** Runs `addToQueue` in its own process against a dead writer's lock, and at the step after it reads that lock another waiter clears it and takes it afresh. */
function addAcrossTheRace(dir: string, third: boolean, signal: AbortSignal): Promise<unknown> {
  const lock = join(dir, 'queue.json.lock');
  const script = join(dir, 'add.mts');
  writeFileSync(script, `
    import fs from 'node:fs';
    import module from 'node:module';
    import * as store from '${join(process.cwd(), 'src', 'data', 'store.js')}';
    const lock = ${JSON.stringify(lock)};
    const real = { ...fs };
    let phase = 'judging';
    let attempts = ${third ? 5 : 0};
    const tryThird = () => {
      if (phase !== 'raced' || attempts === 0) return;
      attempts -= 1;
      try {
        real.closeSync(real.openSync(lock, 'wx'));
        real.writeFileSync(lock, '${process.pid} the third writer');
      } catch {}
    };
    const watch = (name) => (path, ...rest) => {
      if (String(path).startsWith(lock)) {
        if (phase === 'looked') {
          phase = 'raced';
          real.rmSync(lock);
          real.writeFileSync(lock, '${process.pid} the other waiter');
        } else tryThird();
        if (phase === 'judging' && name === 'openSync' && path === lock && rest[0] === 'r') phase = 'looked';
      }
      return real[name](path, ...rest);
    };
    for (const name of ['openSync', 'renameSync', 'rmSync', 'unlinkSync', 'linkSync']) fs[name] = watch(name);
    module.syncBuiltinESMExports();
    store.addToQueue([${finding(0).slice(1, -1)}]);`);
  return run(join(process.cwd(), 'node_modules', '.bin', 'tsx'), [script], { env: { ...process.env, UNDERLINGS_STATE_DIR: dir }, signal });
}

async function raceOverADeadLock(third: boolean): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), 'thematrix-'));
  const stop = new AbortController();
  let adding: Promise<unknown> = Promise.resolve();
  try {
    const lock = join(dir, 'queue.json.lock');
    writeFileSync(lock, '999999 a writer that died');
    adding = addAcrossTheRace(dir, third, stop.signal);
    await new Promise((resolve) => setTimeout(resolve, 1200));
    assert.equal(readFileSync(lock, 'utf8'), `${process.pid} the other waiter`, 'the new holder still has its lock');
    assert.equal(existsSync(join(dir, 'queue.json')), false, 'and the waiter is still waiting');
    rmSync(lock);
    await adding;
    const queue = JSON.parse(readFileSync(join(dir, 'queue.json'), 'utf8')) as QueuedComment[];
    assert.deepEqual(queue.map((c) => c.body), ['finding 0']);
  } finally {
    stop.abort();
    await adding.catch(() => undefined);
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a dead writer\'s lock taken afresh by another waiter just before this one clears it stays with its new holder', () =>
  raceOverADeadLock(false));

test('a third writer arriving while a waiter clears a dead writer\'s lock never shares it with the new holder', () =>
  raceOverADeadLock(true));
