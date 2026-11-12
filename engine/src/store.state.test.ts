import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs, { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fingerprintDiffers } from './types.js';

const shared = mkdtempSync(join(tmpdir(), 'thematrix-statelock-'));
process.env['UNDERLINGS_STATE_DIR'] = shared;
after(() => rmSync(shared, { recursive: true, force: true }));

const STATE = join(shared, 'state.json');
const events: string[] = [];
let reads = 0;
const real = {
  openSync: fs.openSync,
  readFileSync: fs.readFileSync,
  renameSync: fs.renameSync,
  writeFileSync: fs.writeFileSync,
};
Object.assign(fs, {
  openSync: (path: fs.PathLike, ...rest: unknown[]) => {
    const fd = (real.openSync as (...a: unknown[]) => number)(path, ...rest);
    if (path === `${STATE}.lock` && rest[0] === 'wx') events.push('lock');
    return fd;
  },
  readFileSync: (path: fs.PathOrFileDescriptor, ...rest: unknown[]) => {
    const text = (real.readFileSync as (...a: unknown[]) => unknown)(path, ...rest);
    if (path !== STATE) return text;
    const n = reads++;
    events.push(`read:${n}`);
    const state = JSON.parse(String(text)) as { settings?: Record<string, unknown> };
    // Stamped on the settings, so each write can be traced back to the read it was built from.
    return JSON.stringify({ ...state, settings: { ...state.settings, readNo: n } });
  },
  renameSync: (from: fs.PathLike, to: fs.PathLike) => {
    real.renameSync(from, to);
    if (from === `${STATE}.lock`) events.push('unlock');
    if (to !== STATE) return;
    const written = JSON.parse(real.readFileSync(STATE, 'utf8')) as { settings?: { readNo?: number } };
    events.push(`write:${written.settings?.readNo}`);
  },
});
syncBuiltinESMExports();

/** Run a snippet against a throwaway state dir, so the real one is never touched. */
function inTempState(body: string): Record<string, unknown> {
  const dir = mkdtempSync(join(tmpdir(), 'thematrix-state-'));
  const script = join(dir, 'run.mts');
  const src = join(process.cwd(), 'src', 'data', 'store.js');
  writeFileSync(script, `import * as store from '${src}';\n${body}\n`);
  try {
    execFileSync('npx', ['tsx', script], {
      env: { ...process.env, UNDERLINGS_STATE_DIR: dir },
      stdio: 'pipe',
    });
    return JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as Record<string, unknown>;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('saving one part of the state does not drop the rest', () => {
  // Every caller reads the whole state and writes it back, so a field loadState forgets
  // is a field the next unrelated save deletes.
  const state = inTempState(`
    store.saveSettings({ ...store.loadSettings(), jiraSite: 'acme.atlassian.net' });
    store.recordVerdict('a!1', 'approved', 'abc');
    store.saveState({ ...store.loadState(), watches: { 'a!1': { key: 'a!1' } } });
  `);
  const settings = state['settings'] as Record<string, unknown>;
  assert.equal(settings?.['jiraSite'], 'acme.atlassian.net', 'settings survived later saves');
  assert.equal((state['verdicts'] as Record<string, { verdict: string }>)?.['a!1']?.verdict, 'approved');
  assert.ok(state['watches'], 'and the watches are there too');
});

test('an author resolving a thread counts as the merge request moving', () => {
  // Resolving changes nothing else: no commit, no comment, no approval. Without it in
  // the fingerprint, an author clearing everything you raised looks like silence.
  const before = { sha: 'a', pipeline: 'SUCCESS' as const, notes: 7, approvals: 0, unresolved: 3 };
  const after = { ...before, unresolved: 0 };
  assert.equal(fingerprintDiffers(before, after), true);
  assert.equal(fingerprintDiffers(before, { ...before }), false, 'and nothing moving is not a change');
});

test('fingerprints written before resolution was tracked do not all read as changed', () => {
  // Every watch would light up at once on the upgrade, which is noise, not news.
  const old = { sha: 'a', pipeline: 'SUCCESS' as const, notes: 7, approvals: 0 };
  const now = { ...old, unresolved: 2 };
  assert.equal(fingerprintDiffers(old, now), false);
  assert.equal(fingerprintDiffers(now, old), false, 'and neither way round');
});

/** Every write of state.json must be built from a read of it made inside the same hold of its lock. */
function assertLocked(name: string): void {
  let hold = 0;
  let locked = false;
  const readInHold = new Map<string, number | null>();
  assert.ok(events.some((e) => e.startsWith('write:')), `${name} writes state.json`);
  for (const event of events) {
    const [kind, n = ''] = event.split(':');
    if (kind === 'lock') [hold, locked] = [hold + 1, true];
    if (kind === 'unlock') locked = false;
    if (kind === 'read') readInHold.set(n, locked ? hold : null);
    if (kind === 'write') {
      assert.ok(locked && readInHold.get(n) === hold, `${name} wrote state.json from a read taken outside its lock`);
    }
  }
}

test('every state.json writer builds what it writes from a read taken inside its lock', async () => {
  const store = await import('./data/store.js');
  const watch = await import('./actions/watch.js');
  const { setPersonLevel, toggleFullAutoPause } = await import('./commands.js');
  const { takeChange } = await import('./auto/rereview.js');
  const { updateSettings } = await import('./settingsedit.js');
  const { mr } = await import('./auto/testkit.js');
  const key = 'acme/engine!621';
  const writers: [string, () => unknown][] = [
    ['changeSettings', () => store.changeSettings((s) => ({ ...s, rowTint: false }))],
    ['toggleWatch', () => watch.toggleWatch(mr())],
    ['watchForReview', () => watch.watchForReview(mr())],
    ['recordReviewTerminal', () => watch.recordReviewTerminal(key, 't1')],
    ['setAuto', () => watch.setAuto(key, true)],
    ['markSeen', () => watch.markSeen([mr()])],
    ['scheduleReReview', () => watch.scheduleReReview(mr())],
    ['unscheduleReReview', () => watch.unscheduleReReview(key)],
    ['moveAutomation', () => { store.mutateState((st) => { st.watches[key]!.automation = 're-review Engine!621'; }); return watch.moveAutomation(key); }],
    ['recordVerdict', () => store.recordVerdict(key, 'approved')],
    ['noteOwnActivity', () => store.noteOwnActivity(1001, 621, { notes: 1 })],
    ['thematrix changed', () => takeChange(mr({ sha: 'moved' }), { autoOnly: false })],
    ['setPersonLevel', () => setPersonLevel('alice', 'shadow')],
    ['toggleFullAutoPause', () => toggleFullAutoPause()],
    ['updateSettings', () => updateSettings({ pollSeconds: 120 })],
    ['stopWatching', () => watch.stopWatching(key)],
  ];
  real.writeFileSync(STATE, JSON.stringify({ watches: {}, seen: {} }));
  for (const [name, write] of writers) {
    events.length = 0;
    await write();
    assertLocked(name);
  }
});

interface Raced {
  watches: Record<string, unknown>;
  settings?: { autoPaused?: boolean };
}

/** Two processes on one state folder, each running its writer the given number of times from the same moment. */
async function race(a: { what: string; count: number }, b: { what: string; count: number }): Promise<Raced> {
  const { TestProc } = await import('./auto/testproc.js');
  const dir = mkdtempSync(join(tmpdir(), 'thematrix-statelock-race-'));
  const go = join(dir, 'go');
  const procs = [new TestProc(dir), new TestProc(dir)] as const;
  try {
    const runs = [procs[0].send({ op: 'hammer', ...a, go }), procs[1].send({ op: 'hammer', ...b, go })];
    writeFileSync(go, '');
    await Promise.all(runs);
    return JSON.parse(real.readFileSync(join(dir, 'state.json'), 'utf8') as string) as Raced;
  } finally {
    await Promise.all(procs.map((p) => p.close()));
    rmSync(dir, { recursive: true, force: true });
  }
}

test('a pause saved while another process is writing watches survives every one of its saves', async () => {
  const state = await race({ what: 'watches', count: 300 }, { what: 'pause', count: 301 });
  assert.equal(Object.keys(state.watches).length, 300, 'no watch was lost to a pause');
  assert.equal(state.settings?.autoPaused, true, 'and no pause was lost to a watch');
});

test('a pause saved while another process edits settings survives every one of its edits', async () => {
  const state = await race({ what: 'settings', count: 400 }, { what: 'pause', count: 301 });
  assert.equal(state.settings?.autoPaused, true);
});
