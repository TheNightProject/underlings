import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const home = await mkdtemp(join(tmpdir(), 'underlings-fresh-'));
const stateDir = join(home, 'engine-state');
process.env.HOME = home;
process.env.UNDERLINGS_STATE_DIR = stateDir;
process.env.GITLAB_TOKEN = 'not-a-real-token';
process.env.UNDERLINGS_CLAUDE_BIN = '/nonexistent/claude';
const matrixEngine = fileURLToPath(new URL('../engine/dist/engine.js', import.meta.url));

globalThis.fetch = async (input) => {
  if (String(input).endsWith('/api/v4/user')) return Response.json({ username: 'frank', name: 'Frank Foster' });
  return new Response('{"message":"not in this test"}', { status: 503, headers: { 'content-type': 'application/json' } });
};

const { freshInbox, loadEngine } = await import('./engine.mjs');
const { start: startProfile, loadProfile } = await import('./profile.mjs');
const { start: startLocale } = await import('./locale.mjs');
after(() => rm(home, { recursive: true }));

const config = join(home, '.config/underlings');

test('a first start on the real engine writes no setting, marker, profile or locale, so every default is the code\'s own and the first run asks for a name', async () => {
  await loadEngine({ matrixEngine }, () => {});
  await startProfile({}, {});
  await startLocale({}, {});
  await freshInbox(Infinity);
  const state = existsSync(join(stateDir, 'state.json')) ? JSON.parse(readFileSync(join(stateDir, 'state.json'), 'utf8')) : {};
  assert.deepEqual(Object.keys(state).filter((key) => key === 'settings' || key === 'migrations'), []);
  assert.equal(existsSync(join(config, 'profile.json')), false);
  assert.equal(existsSync(join(config, 'locale.json')), false);
  assert.deepEqual((await loadProfile()).user, { name: '', askedAt: null });
});
