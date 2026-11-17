import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const home = await mkdtemp(join(tmpdir(), 'underlings-workspace-'));
process.env.HOME = home;
process.env.GITLAB_TOKEN = 'stub';
process.env.UNDERLINGS_WORKSPACE = 'side-project';
const config = join(home, '.config/underlings');
const state = join(home, '.local/state/underlings');
const own = (dir) => join(dir, 'workspaces/side-project');
await mkdir(config, { recursive: true });
const matrixEngine = fileURLToPath(new URL('./testkit.mjs', import.meta.url));
await writeFile(join(config, 'config.json'), JSON.stringify({ port: 0, matrixEngine }));

const worker = await import('../worker.mjs');
const logged = [];
await worker.default({ log: (t) => logged.push(t), commands: { register() {} } });
const pageUrl = new URL(logged.find((t) => t.startsWith('Underlings at ')).slice('Underlings at '.length));
const { origin } = pageUrl;
const token = pageUrl.searchParams.get('t');

after(async () => {
  await worker.deactivate();
  await rm(home, { recursive: true });
});

async function post(path, body) {
  const res = await fetch(origin + path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-cc-token': token, origin }, body: JSON.stringify(body) });
  assert.equal(res.status, 200, `${path}: ${await res.clone().text()}`);
  return res.json();
}

const json = async (path) => JSON.parse(await readFile(path, 'utf8'));

test('a workspace worker reads the app\'s config.json, and keeps its own address and token in its own folder', async () => {
  assert.equal(new URL((await readFile(join(own(state), 'url'), 'utf8')).trim()).origin, origin);
  assert.ok(existsSync(join(own(state), 'token')));
  assert.ok(!existsSync(join(state, 'url')), 'nothing of the workspace lands in Default');
});

test('what is about you is saved for every workspace, and what the workspace shows is saved for it alone', async () => {
  await post('/api/profile', { name: 'Frank Foster' });
  await post('/api/locale', { clock: '24' });
  await post('/api/game/settings', { toasts: false });
  await post('/api/features', { feature: 'qa', on: true });

  assert.equal((await json(join(config, 'profile.json'))).user.name, 'Frank Foster');
  assert.equal((await json(join(config, 'locale.json'))).locale.clock, '24');
  assert.equal((await json(join(config, 'game.json'))).toasts, false);
  assert.equal((await json(join(own(config), 'features.json'))).qa, true);
  for (const name of ['profile.json', 'locale.json', 'game.json']) assert.ok(!existsSync(join(own(config), name)), name);
  assert.ok(!existsSync(join(config, 'features.json')), 'features.json');
});
