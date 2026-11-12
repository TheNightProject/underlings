import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const SERVE = fileURLToPath(new URL('./serve.mjs', import.meta.url));
const START_MS = 60_000;
let server;
let root;
let origin;
let token;

before(async () => {
  root = mkdtempSync(join(tmpdir(), 'underlings-demo-test-'));
  server = spawn(process.execPath, ['--experimental-test-module-mocks', SERVE], { env: { ...process.env, DEMO_ROOT: root }, stdio: ['ignore', 'pipe', 'pipe'] });
  const url = await new Promise((resolve, reject) => {
    let out = '';
    let err = '';
    const timer = setTimeout(() => reject(new Error(`the demo did not start in time: ${err}`)), START_MS);
    server.stderr.on('data', (chunk) => { err += chunk; });
    server.stdout.on('data', (chunk) => {
      out += chunk;
      const found = /DEMO_URL (\S+)/.exec(out)?.[1];
      if (found) {
        clearTimeout(timer);
        resolve(new URL(found));
      }
    });
    server.once('exit', (code) => reject(new Error(`the demo stopped with code ${code}: ${err}`)));
  });
  origin = url.origin;
  token = url.searchParams.get('t');
});

after(() => {
  server?.kill('SIGTERM');
  rmSync(root, { recursive: true, force: true });
});

const get = async (path) => (await fetch(`${origin}${path}${path.includes('?') ? '&' : '?'}t=${token}`)).json();

test('the demo serves the real page', async () => {
  const res = await fetch(`${origin}/?t=${token}`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /<title>Underlings<\/title>/);
});

test('the demo office has twelve or more agents, in every state and phase', async () => {
  const { agents } = await get('/api/state');
  assert.ok(agents.length >= 12, `${agents.length} agents`);
  assert.deepEqual([...new Set(agents.map((a) => a.state))].sort(), ['blocked', 'done', 'waiting', 'working']);
  for (const phase of ['exploring', 'planning', 'building', 'testing', 'mr', 'builders', 'waiting', 'done']) assert.ok(agents.some((a) => a.phase === phase), `no agent is ${phase}`);
  assert.ok(agents.filter((a) => a.state === 'done').length >= 4, 'too few idle agents to play table tennis');
});

test('the demo has merge requests, queued findings, tickets, messages and a calendar to show', async () => {
  const state = await get('/api/state');
  assert.ok(state.matrix.inbox.rows.length >= 10);
  assert.ok(state.matrix.queue.some((q) => q.status === 'pending'));
  assert.ok(state.attention.cards.length > 0);
  assert.ok(state.calendar.next);
  assert.ok(state.game.level >= 10);
  assert.ok((await get('/api/slack')).items.length >= 4);
  assert.ok((await get('/api/email')).threads.length >= 3);
});
