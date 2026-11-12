import assert from 'node:assert/strict';
import * as child from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, mock, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { oldHome } from './fixtures/oldhome.mjs';

// Only the process boundary is stubbed: every command run fails as a missing one would, and GitLab answers nothing.
mock.module('node:child_process', {
  namedExports: {
    ...child,
    execFile(cmd, args, options, done) {
      setImmediate(() => (typeof options === 'function' ? options : done)(Object.assign(new Error(`${cmd} is stubbed`), { code: 127 }), '', ''));
    },
  },
});
const realFetch = globalThis.fetch;
globalThis.fetch = (url, init) => (String(url).startsWith('http://127.0.0.1:') ? realFetch(url, init) : Promise.resolve(new Response('{"message":"not in this test"}', { status: 503, headers: { 'content-type': 'application/json' } })));

const home = await mkdtemp(join(tmpdir(), 'underlings-moved-'));
const matrixEngine = fileURLToPath(new URL('../engine/dist/engine.js', import.meta.url));
const old = oldHome(home, { port: 0, desktop: false, extra: { matrixEngine } });
process.env.HOME = home;
process.env.UNDERLINGS_STATE_DIR = join(home, '.local/state/underlings/engine');
process.env.GITLAB_TOKEN = 'not-a-real-token';
process.env.UNDERLINGS_CLAUDE_BIN = '/nonexistent/claude';

const worker = await import('../worker.mjs');
const logged = [];
await worker.default({ log: (t) => logged.push(t), commands: { register() {} }, host: { call: async () => ({ delivered: true }) } });
const pageUrl = new URL(logged.find((t) => t.startsWith('Underlings at ')).slice('Underlings at '.length));
const get = async (path) => (await fetch(pageUrl.origin + path, { headers: { 'x-cc-token': pageUrl.searchParams.get('t') } })).json();

async function until(check, what) {
  for (const end = Date.now() + 10_000; Date.now() < end; await new Promise((r) => setTimeout(r, 50))) {
    const value = await check();
    if (value) return value;
  }
  throw new Error(`timed out waiting for ${what}`);
}

after(async () => {
  await worker.deactivate();
  await rm(home, { recursive: true, force: true, maxRetries: 5 });
});

test('the first start of the new version moves the old folders and says so, before it reads a thing', () => {
  assert.ok(logged.some((t) => t === `moved ${old.config} to ${join(home, '.config/underlings')}`), logged.join('\n'));
  assert.ok(logged.some((t) => t === `moved ${old.state} and ${old.engine} to ${join(home, '.local/state/underlings')}`), logged.join('\n'));
});

test('the page keeps its old token, so an open tab still works, and the new url is written to the new folder', () => {
  assert.equal(pageUrl.searchParams.get('t'), 'kept-page-token');
  assert.equal(readFileSync(join(home, '.local/state/underlings/url'), 'utf8').trim(), pageUrl.href);
  assert.equal(readFileSync(join(old.state, 'url'), 'utf8').trim(), 'http://127.0.0.1:47321/?t=kept-page-token', 'the old folder is left as it was');
});

test('every reader finds what the old install kept: settings, Setup done, the update channel, the queue, the name and the panel files', async () => {
  await until(async () => (await get('/api/setup')).done, 'Setup to read that it is done');
  const state = await until(async () => {
    const s = await get('/api/state');
    return s.matrix?.queue?.length ? s : null;
  }, 'the engine to read the queue');
  assert.deepEqual(state.matrix.queue.map((q) => q.body), ['A finding to keep']);
  assert.equal(state.release.updates.channel, 'releases');
  assert.deepEqual([(await get('/api/profile')).name, (await get('/api/profile')).ask], ['Ivan', false]);
  assert.ok(existsSync(join(home, '.local/state/underlings/claude/mcp.json')), 'the panel rewrites its files in the new folder');
  assert.match(readFileSync(join(home, '.local/state/underlings/claude/mcp.json'), 'utf8'), /"underlings"/);
});
