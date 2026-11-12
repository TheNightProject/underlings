import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, afterEach, beforeEach, test } from 'node:test';
import { setTimeout as sleep } from 'node:timers/promises';
import { runAcli } from './data/acli.js';

const root = mkdtempSync(join(tmpdir(), 'acli-queue-test-'));
const fake = join(root, 'acli');
let dir = '';

// Called as `acli <label> <seconds|hold|fail>`: it logs its label and how many fakes are running, then sleeps, fails, or holds until released or 30 s pass.
writeFileSync(fake, `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const [label, how] = process.argv.slice(2);
const dir = process.env.FAKE_ACLI_DIR;
const mine = path.join(dir, 'running', String(process.pid));
fs.writeFileSync(mine, '');
fs.appendFileSync(path.join(dir, 'started'), label + ' ' + fs.readdirSync(path.join(dir, 'running')).length + '\\n');
const timers = [];
const end = () => { timers.forEach(clearTimeout); fs.rmSync(mine, { force: true }); process.stdout.write('[]'); };
process.on('SIGTERM', () => { fs.rmSync(mine, { force: true }); process.exit(143); });
if (how === 'fail') { fs.rmSync(mine, { force: true }); process.stderr.write('✗ Error: refused'); process.exit(1); }
else if (how === 'hold') timers.push(setInterval(() => fs.existsSync(path.join(dir, 'release')) && end(), 10), setTimeout(end, 30_000));
else timers.push(setTimeout(end, Number(how) * 1000));
`);
chmodSync(fake, 0o755);
process.env['UNDERLINGS_ACLI'] = fake;
after(() => rmSync(root, { recursive: true, force: true }));

beforeEach(() => {
  dir = mkdtempSync(join(root, 'run-'));
  mkdirSync(join(dir, 'running'));
  process.env['FAKE_ACLI_DIR'] = dir;
});
afterEach(() => release());

const started = (): [string, number][] => {
  const log = join(dir, 'started');
  if (!existsSync(log)) return [];
  return readFileSync(log, 'utf8').trim().split('\n').map((line) => line.split(' ')).map(([label, n]) => [label as string, Number(n)]);
};
const release = () => writeFileSync(join(dir, 'release'), '');

async function startedCount(n: number): Promise<void> {
  for (let waited = 0; started().length < n; waited += 10) {
    if (waited > 10_000) assert.fail(`only ${started().length} of ${n} fakes started`);
    await sleep(10);
  }
}

test('no more than three acli processes run at once, and the rest start as each one ends', async () => {
  const calls = ['a', 'b', 'c', 'd', 'e', 'f'].map((label) => runAcli([label, 'hold']));
  await startedCount(3);
  await sleep(300);
  assert.equal(started().length, 3, 'the fourth waits while three are running');
  release();
  await Promise.all(calls);
  assert.deepEqual(started().map(([label]) => label).sort(), ['a', 'b', 'c', 'd', 'e', 'f']);
  assert.equal(Math.max(...started().map(([, running]) => running)), 3);
});

test('a call someone is waiting on starts before background calls that were queued first', async () => {
  const held = [runAcli(['held-1', 'hold'], { priority: 'background' }), runAcli(['held-2', 'hold'], { priority: 'background' })];
  const first = runAcli(['first', '0.5']);
  await startedCount(3);
  const later = [runAcli(['qa-1', '0'], { priority: 'background' }), runAcli(['qa-2', '0'], { priority: 'background' })];
  const now = [runAcli(['tickets', '0']), runAcli(['move', '0'], { priority: 'now' })];
  await first;
  await Promise.all(now);
  release();
  await Promise.all([...held, ...later]);
  const order = started().slice(3).map(([label]) => label);
  assert.deepEqual(order.slice(0, 2), ['tickets', 'move'], 'both calls someone waits on start before either background search');
  assert.deepEqual(order.slice(2).sort(), ['qa-1', 'qa-2'], 'the two searches start together once the held ones end, in either order');
});

test('background calls never take the last slot, so a call someone is waiting on starts at once', async () => {
  const held = ['qa-1', 'qa-2', 'qa-3'].map((label) => runAcli([label, 'hold'], { priority: 'background' }));
  await startedCount(2);
  await sleep(300);
  assert.equal(started().length, 2, 'the third background search waits with a slot still free');
  assert.equal((await runAcli(['tickets', '0'])).stdout, '[]', 'the tickets read runs in the free slot while both searches hold');
  release();
  await Promise.all(held);
  assert.equal(Math.max(...started().map(([, running]) => running)), 3);
});

test('a timeout counts from when the process starts, not from when the call joined the queue', async () => {
  const held = [runAcli(['held-1', 'hold']), runAcli(['held-2', 'hold']), runAcli(['held-3', 'hold'])];
  const waited = runAcli(['waited', '0.3'], { timeout: 1000 });
  await startedCount(3);
  await sleep(1200);
  release();
  await Promise.all(held);
  assert.equal((await waited).stdout, '[]', 'it queued for longer than its timeout and still finished');
  await assert.rejects(runAcli(['slow', '3'], { timeout: 500 }), { killed: true }, 'a process that runs past its timeout is stopped');
});

test('a call that fails, or never starts a process, gives its turn back', { timeout: 10_000 }, async () => {
  const failed = await Promise.allSettled([
    ...[1, 2, 3].map((n) => runAcli([`fail-${n}`, 'fail'])),
    ...[1, 2, 3].map(() => runAcli(['not\0an argument'])),
  ]);
  assert.deepEqual(failed.map((r) => r.status), Array(6).fill('rejected'));
  assert.equal((await runAcli(['after', '0'])).stdout, '[]');
});
