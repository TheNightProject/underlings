import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';

const ORCA = '/Applications/Orca.app/Contents/Resources/bin/orca';

mock.module('node:child_process', {
  namedExports: {
    execFile(cmd, args, options, done) {
      const out = cmd === ORCA ? JSON.stringify({ ok: true, result: { tabs: [], worktrees: [], terminals: [] } }) : '';
      setImmediate(() => done(cmd === ORCA ? null : Object.assign(new Error(`${cmd} is stubbed`), { code: 1 }), out, ''));
    },
  },
});

// The engine's build writes an entry that imports its chunks, so the stand-in engine here is the same shape.
const home = await mkdtemp(join(tmpdir(), 'control-centre-reload-'));
const dist = join(home, 'dist');
const entry = join(dist, 'engine.js');
const chunk = join(dist, 'chunk.js');
const testkit = new URL('./testkit.mjs', import.meta.url).href;
const ENTRY = `export * from '${testkit}';\nexport { built } from './chunk.js';\n`;
process.env.HOME = home;
process.env.GITLAB_TOKEN = 'stub';
await mkdir(dist, { recursive: true });
await writeFile(join(dist, 'package.json'), '{"type":"module"}');
await writeFile(entry, ENTRY);
await mkdir(join(home, '.config/underlings'), { recursive: true });
await writeFile(join(home, '.config/underlings/config.json'), JSON.stringify({ port: 0, orcaUserDataPath: '/orca-profile', matrixEngine: entry }));

const worker = await import('../worker.mjs');
const logged = [];
await worker.default({ log: (t) => logged.push(t), commands: { register() {} }, events: { on() {} }, host: { call: async () => {} } });
const pageUrl = new URL(logged.find((t) => t.startsWith('Underlings at ')).slice('Underlings at '.length));
const origin = pageUrl.origin;
const token = pageUrl.searchParams.get('t');

after(async () => {
  await worker.deactivate();
  await rm(home, { recursive: true });
});

const matrix = async () => (await (await fetch(`${origin}/api/state?t=${token}`)).json()).matrix;
const reload = () => fetch(`${origin}/api/reload`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-cc-token': token, origin }, body: '{}' });
const until = async (check) => {
  for (let i = 0; i < 50 && !(await check()); i += 1) await new Promise((r) => setTimeout(r, 20));
};

test('an engine that failed to load comes back on Reload once its missing file appears, though its entry is untouched', async () => {
  await until(async () => (await matrix()).error !== 'starting');
  assert.equal((await matrix()).available, false);
  await writeFile(chunk, 'export const built = true;\n');
  assert.equal((await reload()).status, 200);
  assert.equal((await matrix()).available, true);
});

test('a reload while the engine is mid-rebuild keeps the one that works, and a later one picks up the new build', async () => {
  await rm(dist, { recursive: true });
  const refused = await reload();
  assert.equal(refused.status, 500);
  assert.match(await refused.text(), /could not load the review engine .* so the running code stays/);
  assert.equal((await matrix()).available, true);
  await mkdir(dist);
  await writeFile(join(dist, 'package.json'), '{"type":"module"}');
  await writeFile(entry, ENTRY + 'export const ;\n');
  assert.equal((await reload()).status, 500);
  assert.equal((await matrix()).available, true);
  await writeFile(chunk, 'export const built = true;\n');
  await writeFile(entry, ENTRY);
  assert.equal((await reload()).status, 200);
  assert.equal((await matrix()).available, true);
});
