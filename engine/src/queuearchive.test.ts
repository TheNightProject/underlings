import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { promisify } from 'node:util';
import type { QueuedComment } from './types.js';

const run = promisify(execFile);
const TSX = join(process.cwd(), 'node_modules', '.bin', 'tsx');
const STORE = join(process.cwd(), 'src', 'data', 'store.js');

function scratch(): string {
  return mkdtempSync(join(tmpdir(), 'thematrix-archive-'));
}

function script(dir: string, name: string, body: string): string {
  const path = join(dir, `${name}.mts`);
  writeFileSync(path, `import * as store from '${STORE}';\n${body}\n`);
  return path;
}

function inState(dir: string, path: string, extra: Record<string, string> = {}): Promise<{ stdout: string }> {
  return run(TSX, [path], { env: { ...process.env, UNDERLINGS_STATE_DIR: dir, ...extra }, maxBuffer: 1 << 22 });
}

const queueIn = (dir: string): QueuedComment[] => JSON.parse(readFileSync(join(dir, 'queue.json'), 'utf8'));

function archiveIn(dir: string): (QueuedComment & { why: string })[] {
  const file = join(dir, 'queue-archive.jsonl');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

const pauseLine = 'Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1);';

// Each waits until both have started, since tsx can take longer to start than any fixed delay allows.
function together(dir: string, name: string): string {
  return `import { existsSync as seen, writeFileSync as mark } from 'node:fs';
    mark('${dir}/ready-${name}', '');
    while (!seen('${dir}/ready-writer') || !seen('${dir}/ready-cleaner')) ${pauseLine}`;
}

test('an agent queueing from its own process while another expires and archives loses nothing, and no pending item is archived', async () => {
  const dir = scratch();
  const done = join(dir, 'writer.done');
  try {
    const writer = script(dir, 'writer', `${together(dir, 'writer')}
      const ids = [];
      for (let n = 0; n < 200; n++) {
        const [c] = store.addToQueue([{ projectPath: 'acme/engine', projectId: 1, iid: n % 2 ? 2 : 1, webUrl: '', severity: 'MINOR', body: 'w' + n, createdBy: 'agent' }]);
        ids.push(c.id);
        if (n % 5 === 0) store.updateQueueItem(c.id, { status: 'discarded' });
        ${pauseLine}
      }
      mark('${done}', '');
      console.log(JSON.stringify(ids));`);
    const cleaner = script(dir, 'cleaner', `${together(dir, 'cleaner')}
      const reasons = new Map([['acme/engine!2', 'MR merged']]);
      const archive = () => store.archiveQueue((c) => c.iid === 2 || c.status === 'discarded', 'MR merged').length;
      let rounds = 0, archived = 0;
      while (!seen('${done}')) {
        store.expireClosed(reasons);
        if (++rounds % 4 === 0) archived += archive();
        ${pauseLine}
      }
      store.expireClosed(reasons);
      archive();
      console.log(JSON.stringify({ rounds, archived }));`);
    const [written, cleaned] = await Promise.all([inState(dir, writer), inState(dir, cleaner)]);
    const ids: string[] = JSON.parse(written.stdout);
    const { archived } = JSON.parse(cleaned.stdout) as { archived: number };
    const queue = queueIn(dir);
    const archive = archiveIn(dir);
    const kept = new Set(queue.map((c) => c.id));
    const gone = new Set(archive.map((c) => c.id));
    assert.ok(archived > 0, 'the two really did overlap');
    assert.deepEqual(ids.filter((id) => !kept.has(id) && !gone.has(id)), [], 'every item queued is in the queue or the archive');
    assert.deepEqual([...kept].filter((id) => gone.has(id)), [], 'and in only one of them');
    assert.equal(archive.length, gone.size, 'each archived once');
    assert.deepEqual(archive.filter((c) => c.status === 'pending'), [], 'nothing pending reached the archive');
    assert.deepEqual(queue.filter((c) => c.iid === 2), [], 'everything on the merged MR expired and went');
    assert.ok(archive.filter((c) => c.iid === 2).every((c) => c.status === 'expired' || c.status === 'discarded'));
    assert.deepEqual(queue.map((c) => c.status), Array(queue.length).fill('pending'), 'the open MR keeps what is pending on it');
    assert.equal(queue.length, 80);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a crash after the archive is flushed and before the queue is rewritten loses no item, and the next run tidies the duplicate away', async () => {
  const dir = scratch();
  try {
    const item = (id: string, status: QueuedComment['status']): QueuedComment => ({
      id, projectPath: 'acme/engine', projectId: 1, iid: 9, webUrl: '', severity: 'MINOR', body: id, createdAt: '2026-11-06T09:00:00Z', createdBy: 'agent', status,
    });
    const seeded = [item('p1', 'pending'), item('s1', 'posted'), item('s2', 'discarded'), item('s3', 'expired'), item('p2', 'pending')];
    writeFileSync(join(dir, 'queue.json'), JSON.stringify(seeded));
    const crash = script(dir, 'crash', `
      import fs from 'node:fs';
      import module from 'node:module';
      const fsync = fs.fsyncSync;
      const rename = fs.renameSync;
      const die = () => process.kill(process.pid, 'SIGKILL');
      fs.fsyncSync = (fd) => { fsync(fd); die(); };
      fs.renameSync = (from, to) => { rename(from, to); if (String(to).endsWith('queue.json')) die(); };
      module.syncBuiltinESMExports();
      store.archiveQueue((c) => true, 'MR merged');
      console.log('finished');`);
    await assert.rejects(inState(dir, crash), (err: { signal?: string; code?: number }) => err.signal === 'SIGKILL' || err.code === 137, 'it died part way');
    const queue = queueIn(dir).map((c) => c.id);
    const archive = archiveIn(dir).map((c) => c.id);
    assert.deepEqual(seeded.map((c) => c.id).filter((id) => !queue.includes(id) && !archive.includes(id)), [], 'every item is somewhere');
    assert.deepEqual(archive.sort(), ['s1', 's2', 's3'], 'the archive was written first');
    assert.deepEqual(queue, seeded.map((c) => c.id), 'and the queue not yet touched');

    assert.equal(existsSync(join(dir, 'queue.json.lock')), true, 'the dead writer left its lock behind');
    const again = script(dir, 'again', `
      store.archiveQueue((c) => true, 'MR merged');
      console.log(JSON.stringify(store.loadArchive().items.map((c) => c.id)));`);
    const listed: string[] = JSON.parse((await inState(dir, again)).stdout);
    assert.deepEqual(listed.sort(), ['s1', 's2', 's3'], 'listed once each though written twice');
    assert.deepEqual(queueIn(dir).map((c) => c.id), ['p1', 'p2']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const seed = (dir: string, items: Partial<QueuedComment>[]): void => writeFileSync(join(dir, 'queue.json'), JSON.stringify(items.map((c, n) => ({
  id: `i${n}`, projectPath: 'acme/engine', projectId: 1, iid: 2, webUrl: '', severity: 'MINOR', body: `i${n}`, createdAt: '', createdBy: 'agent', status: 'pending', ...c,
}))));

test('while another process holds the queue lock, expiry and archiving wait for it rather than writing over it', async () => {
  const dir = scratch();
  try {
    seed(dir, [{ status: 'pending' }, { status: 'posted' }]);
    const lock = join(dir, 'queue.json.lock');
    writeFileSync(lock, '');
    const before = statSync(join(dir, 'queue.json')).mtimeMs;
    const expire = script(dir, 'expire', `store.expireClosed(new Map([['acme/engine!2', 'MR merged']]));`);
    const archive = script(dir, 'archive', `store.archiveQueue((c) => c.status === 'posted', 'MR merged');`);
    const running = Promise.all([inState(dir, expire), inState(dir, archive)]);
    await wait(1500);
    assert.equal(statSync(join(dir, 'queue.json')).mtimeMs, before, 'nothing written while the lock is held');
    assert.equal(existsSync(join(dir, 'queue-archive.jsonl')), false);
    rmSync(lock);
    await running;
    assert.deepEqual(queueIn(dir).map((c) => [c.id, c.status]), [['i0', 'expired']], 'both ran once it was free');
    assert.deepEqual(archiveIn(dir).map((c) => c.id), ['i1']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

const crashInsideLock = (dir: string): string => script(dir, 'crash', `
  import fs from 'node:fs';
  import module from 'node:module';
  const fsync = fs.fsyncSync;
  fs.fsyncSync = (fd) => { fsync(fd); process.kill(process.pid, 'SIGKILL'); };
  module.syncBuiltinESMExports();
  store.archiveQueue(() => true, 'MR merged');`);

function bigQueue(dir: string, n: number): void {
  const filler = 'x'.repeat(1200);
  seed(dir, Array.from({ length: n }, (_, i) => ({ status: i % 2 ? 'posted' : 'pending', body: `${i} ${filler}` })));
}

test('a writer killed holding the queue lock leaves it behind, and the writers that arrive next still lose nothing', async () => {
  const dir = scratch();
  try {
    bigQueue(dir, 1000);
    await assert.rejects(inState(dir, crashInsideLock(dir)), (err: { signal?: string; code?: number }) => err.signal === 'SIGKILL' || err.code === 137);
    assert.equal(existsSync(join(dir, 'queue.json.lock')), true, 'the lock outlived its writer');
    const writer = (name: string): string => script(dir, name, `
      import { existsSync as seen, writeFileSync as mark } from 'node:fs';
      mark('${dir}/ready-${name}', '');
      while (!seen('${dir}/ready-one') || !seen('${dir}/ready-two')) ${pauseLine}
      const ids = [];
      for (let n = 0; n < 40; n++) ids.push(store.addToQueue([{ projectPath: 'acme/engine', projectId: 1, iid: 3, webUrl: '', severity: 'MINOR', body: '${name} ' + n, createdBy: 'agent' }])[0].id);
      console.log(JSON.stringify(ids));`);
    const outs = await Promise.all([inState(dir, writer('one')), inState(dir, writer('two'))]);
    const acked: string[] = outs.flatMap((o) => JSON.parse(o.stdout));
    const whole = (line: string): { id?: string }[] => { try { return [JSON.parse(line)]; } catch { return []; } };
    const archived = readFileSync(join(dir, 'queue-archive.jsonl'), 'utf8').split('\n').flatMap(whole);
    const kept = new Set([...queueIn(dir), ...archived].map((c) => c.id));
    assert.equal(acked.length, 80);
    assert.deepEqual(acked.filter((id) => !kept.has(id)), [], 'every add that returned is on disk');
    assert.deepEqual(readdirSync(dir).filter((f) => f.includes('.lock')), [], 'and no lock, or lock moved aside, is left');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('a waiter never takes a live writer\'s lock just because it has waited a while', async () => {
  const dir = scratch();
  try {
    seed(dir, [{ status: 'pending' }]);
    const lock = join(dir, 'queue.json.lock');
    const held = `${process.pid} held-by-the-test`;
    writeFileSync(lock, held);
    const adding = inState(dir, script(dir, 'add', `store.addToQueue([{ projectPath: 'acme/engine', projectId: 1, iid: 2, webUrl: '', severity: 'MINOR', body: 'late', createdBy: 'agent' }]);`));
    await wait(6500);
    assert.equal(readFileSync(lock, 'utf8'), held, 'still the live writer\'s');
    assert.deepEqual(queueIn(dir).map((c) => c.body), ['i0'], 'and nothing written meanwhile');
    rmSync(lock);
    await adding;
    assert.deepEqual(queueIn(dir).map((c) => c.body), ['i0', 'late']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('an archive append cut short by a full disk stops before the queue is rewritten, so nothing is lost', async () => {
  const dir = scratch();
  try {
    seed(dir, Array.from({ length: 200 }, (_, i) => ({ status: 'posted', body: `${i} ${'y'.repeat(500)}` })));
    writeFileSync(join(dir, 'queue-archive.jsonl'), `${JSON.stringify({ id: 'older', body: 'z'.repeat(40_000) })}\n`);
    const archive = script(dir, 'archive', `
      try { store.archiveQueue(() => true, 'MR merged'); } catch (e) { console.log(e.code); }`);
    const { stdout } = await run('/bin/bash', ['-c', `ulimit -f 100 && exec ${TSX} ${archive}`], { env: { ...process.env, UNDERLINGS_STATE_DIR: dir } });
    const whole = (line: string): { id?: string }[] => { try { return [JSON.parse(line)]; } catch { return []; } };
    const archived = readFileSync(join(dir, 'queue-archive.jsonl'), 'utf8').split('\n').flatMap(whole);
    const kept = new Set([...queueIn(dir), ...archived].map((c) => c.id));
    assert.deepEqual(Array.from({ length: 200 }, (_, i) => `i${i}`).filter((id) => !kept.has(id)), [], 'every item is in the queue or the archive');
    assert.equal(queueIn(dir).length, 200, 'and the queue was left as it was');
    assert.equal(stdout.trim(), 'EFBIG', 'because the short write was reported, not taken as done');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
